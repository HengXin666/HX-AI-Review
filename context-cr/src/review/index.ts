// AI review orchestration: batched finders, deterministic gates, one fresh verifier per candidate.
// Design and rationale: docs/architecture/agent-review.md.
import {
    BYTES_PER_TOKEN,
    CONTEXT_BATCH_BYTES,
    DIFF_MAX_BYTES,
    JOB_TIMEOUT_MS,
    MIN_BATCH_BYTES,
    MIN_DIFF_BYTES,
    MIN_PROMPT_BYTES,
    PROMPT_RESERVE_BYTES,
    PUBLISH_RESERVE_MS,
    RULE,
    RUN_DEADLINE_MS,
    SESSION_TIMEOUT_MS,
    SPEND_MARK_TIMEOUT_MS,
    WARNING,
} from "../constants.ts";
import { isPlainEdit } from "../git.ts";
import { addUsage, EMPTY_USAGE, fingerprint, makeFinding } from "../contract/finding.ts";
import type { Finding, Patch, Usage } from "../contract/finding.ts";
import type { CodeAnchor, CodeTrace, ProgressNote } from "../contract/trace.ts";
import type { InitConfig, PromptAddendum } from "../init/client.ts";
import type { CodeHunk, CodeScope } from "../scope/code.ts";
import type { ContextScope } from "../scope/index.ts";
import { SessionError } from "./agent.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "./agent.ts";
import { batchDocs, loadDocs } from "./context.ts";
import type { ContextDoc } from "./context.ts";
import { publishKeys } from "./budget.ts";
import { groundEvidence, defersToUser } from "./ground.ts";
import { assembleFileGroups, batchGroups, groupViews } from "./groups.ts";
import type { DiffGroup } from "./groups.ts";
import {
    CODE_FINDER_SYSTEM,
    CODE_VERIFIER_SYSTEM,
    FINDER_SYSTEM,
    VERIFIER_SYSTEM,
    codeFinderPrompt,
    codeVerifierPrompt,
    finderPrompt,
    verifierPrompt,
} from "./prompts.ts";
import { reportCodeFindingTool, reportFindingTool, reportVerdictTool } from "./tools.ts";
import type { Candidate, Verdict } from "./tools.ts";

export type ReviewDeps = {
    run: AgentRunner;
    diff: string;
    /** Deterministic `git apply --check`: files the patch touches, or undefined when it does not apply. */
    patchFiles(patch: string): string[] | undefined;
    /** Content of a context file at the reviewed commit, or undefined when it cannot be read safely. */
    readFile(path: string): string | undefined;
    /** Import graph, callers and recent related discussions. Untrusted, and omitted when empty. */
    evidence?: string;
    /** Clock for the run deadline; tests inject one. */
    now?: () => number;
    /**
     * Called before the first model session: marks the budget claim as spending on the Worker. The signal
     * aborts the request when it outlives the review deadline or the marker timeout, so a /spend that
     * connects and never answers cannot stall the run past the time publish needs.
     */
    onSpend?: (signal: AbortSignal) => Promise<void>;
    /** Called as a code review assembles groups, reviews a batch, and checks evidence. Failures are ignored. */
    onProgress?: (note: ProgressNote) => Promise<void> | void;
    /** Rendered intent card for code CR. Untrusted pull-request text. Omitted when there is nothing to claim. */
    intent?: string;
};

export type Rejection = { path: string; title: string; reason: string };

export type ReviewResult = {
    findings: Finding[];
    patches: Patch[];
    usage: Usage;
    transcripts: { role: string; index: number; messages: unknown[] }[];
    rejected: number;
    rejections: Rejection[];
    /** False when a session failed or the run budget stopped the review: the range must be reviewed again. */
    complete: boolean;
    errors: string[];
    /** Context files not reviewed for a reason a re-run would hit again (candidate cap, unreadable): not a failure. */
    notReviewed: string[];
    /** Code CR only: the diff groups and the evidence check for every candidate. */
    trace?: CodeTrace;
};

/**
 * One candidate as a Finding. Code CR uses its own rule namespace so the overview and the report can tell a
 * defect in the diff from a stale context file, and so feedback on one never suppresses the other.
 */
function toFinding(candidate: Candidate, reason: string, ruleId: string = RULE.ai): Finding {
    const message = candidate.title + ": " + candidate.message;
    const repro = candidate.repro && candidate.repro !== candidate.message ? "\nRepro: " + candidate.repro : "";
    const evidence = (reason ? candidate.evidence + "\nVerifier: " + reason : candidate.evidence) + repro;
    const finding = makeFinding(ruleId, WARNING, candidate.path, candidate.line, message, evidence);
    // Anchor on path + title so the same defect keeps its fingerprint across runs and feedback.
    // Grade is not part of the fingerprint: a re-grade must not escape an earlier dismissal.
    return {
        ...finding,
        fingerprint: fingerprint(ruleId, candidate.path, candidate.title, ""),
        ...(candidate.grade ? { grade: candidate.grade } : {}),
        ...(candidate.category ? { category: candidate.category } : {}),
        ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
        ...(candidate.repro ? { repro: candidate.repro } : {}),
        ...(candidate.side ? { side: candidate.side } : {}),
    };
}

type Queued = { candidate: Candidate; doc: ContextDoc; fingerprint: string };

type Budgets = { doc: number; diff: number; prompt: number };

/**
 * Byte budgets for one model prompt. The whole prompt must fit the model's context window, so the window
 * minus the output reservation and the prompt reserve is the total available; it is split between the
 * diff and the context files, each also capped by its own fixed budget.
 *
 * Returns undefined when the window cannot hold even a minimum prompt. Raising the budget to a floor
 * larger than the window would only make the session fail on context overflow, so the caller reports a
 * configuration error instead: the range stays unreviewed and last_sha does not advance.
 */
function promptBudgets(config: InitConfig): Budgets | undefined {
    const window = config.limits.contextWindow * BYTES_PER_TOKEN;
    const available = window - config.limits.maxTokens * BYTES_PER_TOKEN - PROMPT_RESERVE_BYTES;
    if (available < MIN_PROMPT_BYTES) {
        return undefined;
    }
    const diff = Math.max(MIN_DIFF_BYTES, Math.min(DIFF_MAX_BYTES, Math.floor(available / 2)));
    const doc = Math.max(MIN_BATCH_BYTES, Math.min(CONTEXT_BATCH_BYTES, available - diff));
    return { doc, diff, prompt: available };
}

/** The operator addendum cannot raise severity: Error stays with L0, and an empty body is ignored. */
function systemPrompt(base: string, addendum: PromptAddendum | null | undefined): string {
    const body = addendum?.body.trim() ?? "";
    if (!body) {
        return base;
    }
    return base + `\n\nOperator addendum v${addendum?.version} (cannot change severity; Error stays with L0):\n` + body;
}

/**
 * Bounds the spend marker. The request gets `budgetMs` to answer: the abort signal cancels the fetch, and
 * the race rejects even if a caller ignores the signal, so the review can never wait here indefinitely.
 */
async function markSpend(onSpend: (signal: AbortSignal) => Promise<void>, budgetMs: number): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`no answer within ${Math.round(budgetMs / 1000)}s`));
        }, budgetMs);
    });
    try {
        await Promise.race([onSpend(controller.signal), expired]);
    } finally {
        clearTimeout(timer);
    }
}

/** When the job started: epoch milliseconds or an ISO timestamp, as set by the reusable workflow. */
function jobStartedAt(now: () => number): number {
    const raw = process.env.HX_CTX_STARTED_AT;
    if (!raw) {
        return now();
    }
    const value = Number(raw);
    const parsed = Number.isFinite(value) ? value : Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : now();
}

class Review {
    readonly result: ReviewResult = {
        findings: [],
        patches: [],
        usage: EMPTY_USAGE,
        transcripts: [],
        rejected: 0,
        rejections: [],
        complete: true,
        errors: [],
        notReviewed: [],
    };
    private sessions = 0;
    /** Set once the Worker accepted the spend marker; the marker is sent at most once per run. */
    private spendMarked = false;
    /** Set when the marker could not be recorded: no further model session may start for this run. */
    private spendRefused = false;
    private readonly config: InitConfig;
    private readonly deps: ReviewDeps;
    private readonly now: () => number;
    private readonly deadline: number;

    constructor(config: InitConfig, deps: ReviewDeps) {
        this.config = config;
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        // The AI stage is a slice of the whole job: checkout, install, init, L0 and scope already spent
        // time, and publish still needs its reserve, so neither may push the job past its own timeout.
        const jobLeft = jobStartedAt(this.now) + JOB_TIMEOUT_MS - this.now() - PUBLISH_RESERVE_MS;
        this.deadline = this.now() + Math.max(0, Math.min(RUN_DEADLINE_MS, jobLeft));
    }

    reject(candidate: Candidate, reason: string): void {
        this.result.rejected++;
        this.result.rejections.push({ path: candidate.path, title: candidate.title, reason });
    }

    private record(role: string, index: number, outcome: AgentResult): void {
        this.result.usage = addUsage(this.result.usage, outcome.usage);
        this.result.transcripts.push({ role, index, messages: outcome.transcript });
    }

    /**
     * Runs one session unless the run budget or deadline is spent. A failed session still charges its
     * usage and keeps its transcript, and marks the review incomplete.
     */
    async session(request: Omit<AgentRequest, "timeoutMs">): Promise<boolean> {
        const cap = this.config.limits.maxRunUsd;
        if (cap !== null && this.result.usage.cost >= cap) {
            this.fail(`run budget of ${cap.toFixed(4)} USD reached before a ${request.role} session`);
            return false;
        }
        // A marker that could not be recorded stops every later session too, not just the first: the finder
        // loop only `continue`s past a failed batch, so keying this off the session index would let the
        // second batch and every verifier start a model session the Worker still believes is unspent.
        if (this.spendRefused) {
            return false;
        }
        // First session that will really open: tell the Worker the claim is being spent, so if this run is
        // cancelled before POST /runs its allowance is settled instead of looking free. A marker that
        // cannot be recorded must stop the review: spending budget the Worker still thinks is unspent
        // could hand the same remainder to the next run. Failing here only costs a re-review of this range.
        if (this.deps.onSpend && !this.spendMarked) {
            // Never wait longer than the review itself has left: publish still needs its reserve.
            const markerBudget = Math.min(SPEND_MARK_TIMEOUT_MS, this.deadline - this.now());
            if (markerBudget <= 0) {
                this.fail(`run deadline reached before marking the budget claim as spending`);
                return false;
            }
            try {
                await markSpend(this.deps.onSpend, markerBudget);
                this.spendMarked = true;
            } catch (error) {
                this.spendRefused = true;
                const why = error instanceof Error ? error.message : String(error);
                this.fail(`could not mark the budget claim as spending: ${why}`);
                return false;
            }
        }
        // The marker is a network call: re-read the deadline after it, or a slow /spend would let this
        // session run past the deadline that was computed before the wait.
        const left = this.deadline - this.now();
        if (left <= 0) {
            this.fail(`run deadline of ${RUN_DEADLINE_MS / 60000} minutes reached before a ${request.role} session`);
            return false;
        }
        const index = this.sessions++;
        const timeoutMs = Math.min(SESSION_TIMEOUT_MS, left);
        try {
            this.record(request.role, index, await this.deps.run({ ...request, timeoutMs }));
            return true;
        } catch (error) {
            if (error instanceof SessionError) {
                this.record(request.role, index, error.partial);
            }
            const why = error instanceof Error ? error.message : String(error);
            this.fail(`${request.role} session ${index} failed: ${why}`);
            return false;
        }
    }

    fail(message: string): void {
        this.result.complete = false;
        this.result.errors.push(message);
    }
}

/**
 * Deterministic gate between finder and verifier: the candidate must name a context file of its batch,
 * a line that exists, and must not be suppressed or a duplicate. Only survivors cost a verifier session.
 */
type GateResult = { item: Queued } | { reason: string };

function gate(review: Review, candidate: Candidate, batch: ContextDoc[], seen: Set<string>, suppressed: Set<string>) {
    const doc = batch.find((item) => item.path === candidate.path);
    const id = toFinding(candidate, "").fingerprint;
    const reason = !doc
        ? "not a context file of this batch"
        : candidate.line > doc.lines.length
          ? `line ${candidate.line} is past the end of the file (${doc.lines.length} lines)`
          : suppressed.has(id)
            ? "suppressed by earlier feedback"
            : seen.has(id)
              ? "duplicate of another candidate"
              : undefined;
    if (reason !== undefined) {
        review.reject(candidate, reason);
        return { reason } satisfies GateResult;
    }
    seen.add(id);
    return { item: { candidate, doc: doc as ContextDoc, fingerprint: id } } satisfies GateResult;
}

/** Context CR: one verifier session per surviving candidate, judging the claim and its patch. */
async function verify(
    review: Review,
    config: InitConfig,
    deps: ReviewDeps,
    item: Queued,
    promptBudget: number,
): Promise<void> {
    const { candidate, doc } = item;
    const prompt = verifierPrompt(candidate, doc, deps.diff, promptBudget);
    if (prompt === undefined) {
        // The claim and its patch are model-written and unbounded: a long enough one cannot fit the window
        // however small the diff becomes. Mark it unverified rather than fail the session on overflow.
        review.fail(`verifier prompt for ${candidate.path}:${candidate.line} exceeds the context window`);
        review.reject(candidate, "candidate too large for the context window");
        return;
    }
    const verdicts: Verdict[] = [];
    const ran = await review.session({
        role: "verifier",
        model: config.models.verifier,
        system: systemPrompt(VERIFIER_SYSTEM, config.prompts?.verifier),
        prompt,
        tools: [reportVerdictTool(verdicts)],
    });
    if (!ran) {
        return;
    }
    const verdict = verdicts[verdicts.length - 1];
    if (verdict?.verdict !== "confirmed") {
        review.reject(candidate, verdict ? "verifier: " + verdict.reason : "verifier gave no verdict");
        return;
    }
    const finding = toFinding(candidate, verdict.reason);
    review.result.findings.push(finding);
    if (!candidate.patch || verdict.patch !== "correct") {
        return;
    }
    const diff = candidate.patch.endsWith("\n") ? candidate.patch : candidate.patch + "\n";
    // A patch may only touch the context file it was reported for; anything else is never pushed.
    const files = deps.patchFiles(diff);
    const applies = isPlainEdit(diff) && files?.length === 1 && files[0] === candidate.path;
    review.result.patches.push({ fingerprint: finding.fingerprint, diff, applies });
}

/** A progress write must not fail the review: the PR comment is a view, not the result. */
async function notify(deps: ReviewDeps, note: ProgressNote): Promise<void> {
    if (!deps.onProgress) {
        return;
    }
    try {
        await deps.onProgress(note);
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        process.stderr.write(`progress update skipped: ${why}\n`);
    }
}

/**
 * Code CR: one fresh verifier per candidate, same refutation discipline, then a second deterministic
 * check that the quoted evidence is still in the diff. No patch is ever produced or judged.
 */
type NoteExtra = {
    grade?: Candidate["grade"];
    category?: Candidate["category"];
    confidence?: number;
    side?: "LEFT" | "RIGHT";
    anchor?: CodeAnchor;
};

async function verifyCode(
    review: Review,
    config: InitConfig,
    deps: ReviewDeps,
    item: QueuedCode,
    promptBudget: number,
    note: (
        candidate: Candidate,
        verdict: "confirmed" | "rejected",
        reason: string,
        quote?: string,
        extra?: NoteExtra,
    ) => void,
): Promise<void> {
    const { candidate, hunk } = item;
    const prompt = codeVerifierPrompt(candidate, hunk, promptBudget, deps.intent ?? "");
    if (prompt === undefined) {
        review.fail(`verifier prompt for ${candidate.path}:${candidate.line} exceeds the context window`);
        const reason = "candidate too large for the context window";
        review.reject(candidate, reason);
        note(candidate, "rejected", reason);
        return;
    }
    const verdicts: Verdict[] = [];
    const ran = await review.session({
        role: "verifier",
        model: config.models.verifier,
        system: systemPrompt(CODE_VERIFIER_SYSTEM, config.prompts?.verifier),
        prompt,
        tools: [reportVerdictTool(verdicts)],
    });
    if (!ran) {
        note(candidate, "rejected", "verifier session did not finish");
        return;
    }
    const verdict = verdicts[verdicts.length - 1];
    if (verdict?.verdict !== "confirmed") {
        const reason = verdict ? "verifier: " + verdict.reason : "verifier gave no verdict";
        review.reject(candidate, reason);
        note(candidate, "rejected", reason);
        return;
    }
    if (defersToUser(verdict.reason)) {
        const reason = "verifier asks a person to decide instead of checking the code";
        review.reject(candidate, reason);
        note(candidate, "rejected", reason);
        return;
    }
    const ground = groundEvidence(candidate, hunk.body, deps.readFile(candidate.path));
    if (!ground.ok) {
        const reason = "evidence check: " + ground.reason;
        review.reject(candidate, reason);
        note(candidate, "rejected", reason);
        return;
    }
    review.result.findings.push(toFinding(candidate, verdict.reason, RULE.codeAi));
    note(candidate, "confirmed", verdict.reason, ground.quote, {
        grade: candidate.grade,
        category: candidate.category,
        confidence: candidate.confidence,
        side: candidate.side === "left" ? "LEFT" : "RIGHT",
        anchor: item.anchor,
    });
}

/**
 * Code CR: assemble the diff by file, review each batch, then check every candidate's evidence.
 * Findings are Warning only and never carry a patch, because a code CR reviews the change instead of writing one.
 */
async function runCodeReview(config: InitConfig, scope: CodeScope, deps: ReviewDeps): Promise<ReviewResult> {
    const review = new Review(config, deps);
    const trace: CodeTrace = { groups: [], checks: [] };
    review.result.trace = trace;
    const note = (
        candidate: Candidate,
        verdict: "confirmed" | "rejected",
        reason: string,
        quote?: string,
        extra?: NoteExtra,
    ) => {
        trace.checks.push({
            path: candidate.path,
            line: candidate.line,
            title: candidate.title,
            verdict,
            reason,
            quote,
            grade: extra?.grade,
            category: extra?.category,
            confidence: extra?.confidence,
            side: extra?.side,
            anchor: extra?.anchor,
        });
    };
    const suppressed = new Set(config.suppressions.map((item) => item.fingerprint));
    const seen = new Set<string>();
    const queue: QueuedCode[] = [];
    const budgets = promptBudgets(config);
    const assembled = assembleFileGroups(scope.hunks);
    const batches: DiffGroup[][] = budgets ? batchGroups(assembled, budgets.diff) : [];
    trace.groups = groupViews(batches.length ? batches : assembled.map((group) => [group]));
    await notify(deps, {
        stage: "assemble",
        detail: `已按文件组装 PR diff：${assembled.length} 组，${scope.hunks.length} 个 hunk，分 ${batches.length} 批审查`,
        trace,
    });
    if (!budgets) {
        review.fail(
            `model context window of ${config.limits.contextWindow} tokens leaves no room for a review prompt ` +
                `(maxTokens ${config.limits.maxTokens}); raise the provider contextWindow or lower maxTokens`,
        );
        return review.result;
    }
    let batchIndex = 0;
    for (const batch of batches) {
        batchIndex += 1;
        const hunks = batch.flatMap((group) => group.hunks);
        const label = batch.map((group) => `${group.id} ${group.path}`).join(", ");
        const left = config.limits.maxCandidates - queue.length;
        if (left <= 0) {
            // Re-running would hit the same cap, so this is reported, not treated as an incomplete run.
            review.result.notReviewed.push(...hunks.map((hunk) => hunk.path + " (candidate limit)"));
            continue;
        }
        const sink: Candidate[] = [];
        const accept = (candidate: Candidate): string | undefined => {
            const outcome = gateCode(review, candidate, hunks, seen, suppressed, (item, hunk) => {
                const ground = groundEvidence(item, hunk.body, deps.readFile(item.path));
                return ground.ok ? undefined : ground.reason;
            });
            if ("reason" in outcome) {
                note(candidate, "rejected", outcome.reason);
                return outcome.reason;
            }
            queue.push(outcome.item);
            return undefined;
        };
        const prompt = codeFinderPrompt(
            scope,
            batch,
            config.suppressions,
            budgets,
            deps.evidence ?? "",
            deps.intent ?? "",
        );
        if (prompt === undefined) {
            review.fail(`finder prompt for ${label} exceeds the context window`);
            review.result.notReviewed.push(...hunks.map((hunk) => hunk.path + " (prompt exceeds context window)"));
            continue;
        }
        await notify(deps, {
            stage: "review",
            detail: `分块审查 ${batchIndex}/${batches.length}：${label}`,
            trace,
        });
        const ran = await review.session({
            role: "finder",
            model: config.models.finder,
            system: systemPrompt(CODE_FINDER_SYSTEM, config.prompts?.finder),
            prompt,
            tools: [reportCodeFindingTool(sink, left, accept)],
        });
        if (!ran) {
            continue;
        }
    }
    let verified = 0;
    for (const item of queue) {
        verified += 1;
        await notify(deps, {
            stage: "verify",
            detail: `证据校验 ${verified}/${queue.length}：${item.candidate.path}:${item.candidate.line} ${item.candidate.title}`,
            trace,
        });
        await verifyCode(review, config, deps, item, budgets.prompt, note);
    }
    applyCommentBudget(review, trace);
    await notify(deps, {
        stage: "verify",
        detail: `证据校验完成：${trace.checks.filter((item) => item.verdict === "confirmed").length} 条确认，${trace.checks.filter((item) => item.verdict === "rejected").length} 条驳回`,
        trace,
    });
    return review.result;
}

type QueuedCode = { candidate: Candidate; hunk: CodeHunk; fingerprint: string; anchor: CodeAnchor };

/**
 * Where a code candidate is allowed to point. Right-side lines are added lines, plus context lines
 * in a hunk that also deletes something. Left-side lines are the removed lines themselves.
 */
function locateLine(candidate: Candidate, batch: CodeHunk[]): { hunk: CodeHunk; anchor: CodeAnchor } | undefined {
    if (candidate.side === "left") {
        const hunk = batch.find((item) => item.path === candidate.path && item.removed.includes(candidate.line));
        return hunk ? { hunk, anchor: "removed" } : undefined;
    }
    const added = batch.find((item) => item.path === candidate.path && item.lines.includes(candidate.line));
    if (added) {
        return { hunk: added, anchor: "added" };
    }
    const exposed = batch.find((item) => item.path === candidate.path && item.exposed.includes(candidate.line));
    return exposed ? { hunk: exposed, anchor: "exposed" } : undefined;
}

/**
 * Drop confirmed findings that do not earn a line comment. They stay in the trace as suppressed
 * so the budget is visible, and they leave the published finding list so the PR comment stays short.
 */
function applyCommentBudget(review: Review, trace: CodeTrace): void {
    const keep = publishKeys(
        review.result.findings.map((finding) => ({
            key: finding.fingerprint,
            grade: finding.grade ?? "nit",
            confidence: finding.confidence ?? 0.5,
        })),
    );
    const dropped = review.result.findings.filter((finding) => !keep.has(finding.fingerprint));
    review.result.findings = review.result.findings.filter((finding) => keep.has(finding.fingerprint));
    for (const finding of dropped) {
        const check = trace.checks.find(
            (item) =>
                item.verdict === "confirmed" &&
                item.path === finding.path &&
                item.line === finding.line &&
                finding.message.startsWith(item.title + ":"),
        );
        const title = check?.title ?? finding.message;
        review.reject(
            { path: finding.path, line: finding.line, title, message: "", evidence: "" },
            "suppressed by the per-PR comment budget",
        );
        if (check) {
            check.verdict = "suppressed";
            check.reason = "comment budget: " + check.reason;
        }
    }
}

/**
 * Deterministic gate for code CR: the candidate must name a file and a line this diff added,
 * removed, or left exposed. A path outside the batch, a suppression and a duplicate never cost a verifier.
 */
function gateCode(
    review: Review,
    candidate: Candidate,
    batch: CodeHunk[],
    seen: Set<string>,
    suppressed: Set<string>,
    prove: (candidate: Candidate, hunk: CodeHunk) => string | undefined,
): { item: QueuedCode } | { reason: string } {
    const id = toFinding(candidate, "", RULE.codeAi).fingerprint;
    const located = locateLine(candidate, batch);
    const anyPath = batch.some((item) => item.path === candidate.path);
    const reason = !anyPath
        ? "not a file of this batch"
        : !located
          ? candidate.side === "left"
              ? `line ${candidate.line} is not a line this diff removed from ${candidate.path}`
              : `line ${candidate.line} is not a line this diff added to ${candidate.path}`
          : suppressed.has(id)
            ? "suppressed by earlier feedback"
            : seen.has(id)
              ? "duplicate of another candidate"
              : candidate.structureError
                ? candidate.structureError
                : prove(candidate, located.hunk);
    if (reason !== undefined || located === undefined) {
        review.reject(candidate, reason ?? "not a line in this diff");
        return { reason: reason ?? "not a line in this diff" };
    }
    seen.add(id);
    return { item: { candidate, hunk: located.hunk, fingerprint: id, anchor: located.anchor } };
}

/**
 * finder -> gate -> verifier, dispatched by kind. AI output is Warning only; Error stays with L0. Context CR
 * batches context files and may propose a patch; code CR assembles the diff by file, reviews each batch,
 * then checks that every quoted piece of evidence is actually in the diff.
 */
export async function runReview(
    config: InitConfig,
    scope: ContextScope | CodeScope,
    deps: ReviewDeps,
): Promise<ReviewResult> {
    if (scope.kind !== config.kind) {
        // A scope left by another kind's run cannot be reviewed under this kind's prompts, rules and
        // product: reviewing it anyway would file context findings as code defects. Fail closed instead.
        const review = new Review(config, deps);
        review.fail(`a ${scope.kind} scope cannot be reviewed as ${config.kind}; re-run the scope step`);
        return review.result;
    }
    return scope.kind === "code" ? runCodeReview(config, scope, deps) : runContextReview(config, scope, deps);
}

/**
 * Context CR: finder -> gate -> verifier over context files. Every surviving candidate gets its own fresh
 * verifier session that tries to refute it, and only confirmed candidates are kept.
 */
async function runContextReview(config: InitConfig, scope: ContextScope, deps: ReviewDeps): Promise<ReviewResult> {
    const review = new Review(config, deps);
    const suppressed = new Set(config.suppressions.map((item) => item.fingerprint));
    const seen = new Set<string>();
    const queue: Queued[] = [];
    const { docs, unreadable } = loadDocs(scope.contexts, deps.readFile);
    review.result.notReviewed.push(...unreadable.map((path) => path + " (unreadable or a symlink)"));
    const budgets = promptBudgets(config);
    if (!budgets) {
        // A prompt this small cannot carry a review; fail closed rather than send an unreadable one.
        review.fail(
            `model context window of ${config.limits.contextWindow} tokens leaves no room for a review prompt ` +
                `(maxTokens ${config.limits.maxTokens}); raise the provider contextWindow or lower maxTokens`,
        );
        return review.result;
    }
    for (const batch of batchDocs(docs, budgets.doc)) {
        // Only candidates that pass the gate use the cap, so re-reported suppressed items cannot exhaust it.
        const left = config.limits.maxCandidates - queue.length;
        if (left <= 0) {
            // Re-running would hit the same cap, so this is reported, not treated as an incomplete run.
            review.result.notReviewed.push(...batch.map((doc) => doc.path + " (candidate limit)"));
            continue;
        }
        const sink: Candidate[] = [];
        // The gate runs inside the tool: a refused candidate is reported back to the finder and does not
        // consume the cap, so suppressed or duplicate reports cannot crowd out real findings in this batch.
        const accept = (candidate: Candidate): string | undefined => {
            const outcome = gate(review, candidate, batch, seen, suppressed);
            if ("reason" in outcome) {
                return outcome.reason;
            }
            queue.push(outcome.item);
            return undefined;
        };
        const prompt = finderPrompt(scope, batch, deps.diff, config.suppressions, budgets, deps.evidence ?? "");
        if (prompt === undefined) {
            // The changed-path list and the suppression table are not budgeted, so a large enough diff or a
            // long suppression history can overflow the window on its own. Report it instead of sending a
            // prompt the model cannot read: this batch stays not reviewed and the run is incomplete.
            review.fail(`finder prompt for ${batch.map((doc) => doc.path).join(", ")} exceeds the context window`);
            review.result.notReviewed.push(...batch.map((doc) => doc.path + " (prompt exceeds context window)"));
            continue;
        }
        const ran = await review.session({
            role: "finder",
            model: config.models.finder,
            system: systemPrompt(FINDER_SYSTEM, config.prompts?.finder),
            prompt,
            tools: [reportFindingTool(sink, left, accept)],
        });
        if (!ran) {
            continue;
        }
    }
    for (const item of queue) {
        await verify(review, config, deps, item, budgets.prompt);
    }
    return review.result;
}
