// AI review orchestration: batched finders, deterministic gates, one fresh verifier per candidate.
// Design and rationale: docs/architecture/agent-review.md.
import { CONTEXT_BATCH_BYTES, RULE, RUN_DEADLINE_MS, SESSION_TIMEOUT_MS, WARNING } from "../constants.ts";
import { isPlainEdit } from "../git.ts";
import { addUsage, EMPTY_USAGE, fingerprint, makeFinding } from "../contract/finding.ts";
import type { Finding, Patch, Usage } from "../contract/finding.ts";
import type { InitConfig } from "../init/client.ts";
import type { ContextScope } from "../scope/index.ts";
import { SessionError } from "./agent.ts";
import type { AgentRequest, AgentResult, AgentRunner } from "./agent.ts";
import { batchDocs, loadDocs } from "./context.ts";
import type { ContextDoc } from "./context.ts";
import { FINDER_SYSTEM, VERIFIER_SYSTEM, finderPrompt, verifierPrompt } from "./prompts.ts";
import { reportFindingTool, reportVerdictTool } from "./tools.ts";
import type { Candidate, Verdict } from "./tools.ts";

export type ReviewDeps = {
    run: AgentRunner;
    diff: string;
    /** Deterministic `git apply --check`: files the patch touches, or undefined when it does not apply. */
    patchFiles(patch: string): string[] | undefined;
    /** Content of a context file at the reviewed commit, or undefined when it cannot be read safely. */
    readFile(path: string): string | undefined;
    /** Clock for the run deadline; tests inject one. */
    now?: () => number;
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
};

function toFinding(candidate: Candidate, reason: string): Finding {
    const message = candidate.title + ": " + candidate.message;
    const evidence = reason ? candidate.evidence + "\nVerifier: " + reason : candidate.evidence;
    const finding = makeFinding(RULE.ai, WARNING, candidate.path, candidate.line, message, evidence);
    // Anchor on path + title so the same stale statement keeps its fingerprint across runs and feedback.
    return { ...finding, fingerprint: fingerprint(RULE.ai, candidate.path, candidate.title, "") };
}

type Queued = { candidate: Candidate; doc: ContextDoc; fingerprint: string };

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
    private readonly config: InitConfig;
    private readonly deps: ReviewDeps;
    private readonly now: () => number;
    private readonly deadline: number;

    constructor(config: InitConfig, deps: ReviewDeps) {
        this.config = config;
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.deadline = this.now() + RUN_DEADLINE_MS;
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
function gate(review: Review, candidate: Candidate, batch: ContextDoc[], seen: Set<string>, suppressed: Set<string>) {
    const doc = batch.find((item) => item.path === candidate.path);
    const id = toFinding(candidate, "").fingerprint;
    if (!doc) {
        review.reject(candidate, "not a context file of this batch");
    } else if (candidate.line > doc.lines.length) {
        review.reject(candidate, `line ${candidate.line} is past the end of the file (${doc.lines.length} lines)`);
    } else if (suppressed.has(id)) {
        review.reject(candidate, "suppressed by earlier feedback");
    } else if (seen.has(id)) {
        review.reject(candidate, "duplicate of another candidate");
    } else {
        seen.add(id);
        return { candidate, doc, fingerprint: id };
    }
    return undefined;
}

async function verify(review: Review, config: InitConfig, deps: ReviewDeps, item: Queued): Promise<void> {
    const { candidate, doc } = item;
    const verdicts: Verdict[] = [];
    const ran = await review.session({
        role: "verifier",
        model: config.models.verifier,
        system: VERIFIER_SYSTEM,
        prompt: verifierPrompt(candidate, doc, deps.diff),
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

/**
 * finder -> gate -> verifier. AI output is Warning only; Error stays with L0. Context files are split into
 * byte-bounded batches, one finder session each; every surviving candidate gets its own fresh verifier
 * session that tries to refute it, and only confirmed candidates are kept.
 */
export async function runReview(config: InitConfig, scope: ContextScope, deps: ReviewDeps): Promise<ReviewResult> {
    const review = new Review(config, deps);
    const suppressed = new Set(config.suppressions.map((item) => item.fingerprint));
    const seen = new Set<string>();
    const queue: Queued[] = [];
    const { docs, unreadable } = loadDocs(scope.contexts, deps.readFile);
    review.result.notReviewed.push(...unreadable.map((path) => path + " (unreadable or a symlink)"));
    for (const batch of batchDocs(docs, CONTEXT_BATCH_BYTES)) {
        // Only candidates that pass the gate use the cap, so re-reported suppressed items cannot exhaust it.
        const left = config.limits.maxCandidates - queue.length;
        if (left <= 0) {
            // Re-running would hit the same cap, so this is reported, not treated as an incomplete run.
            review.result.notReviewed.push(...batch.map((doc) => doc.path + " (candidate limit)"));
            continue;
        }
        const sink: Candidate[] = [];
        const ran = await review.session({
            role: "finder",
            model: config.models.finder,
            system: FINDER_SYSTEM,
            prompt: finderPrompt(scope, batch, deps.diff, config.suppressions, CONTEXT_BATCH_BYTES),
            tools: [reportFindingTool(sink, left)],
        });
        if (!ran) {
            continue;
        }
        for (const candidate of sink) {
            const item = gate(review, candidate, batch, seen, suppressed);
            if (item) {
                queue.push(item);
            }
        }
    }
    for (const item of queue) {
        await verify(review, config, deps, item);
    }
    return review.result;
}
