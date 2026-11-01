import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadTrustedConfig } from "./config.ts";
import type { RepoConfig } from "./config.ts";
import {
    AI_FILE,
    CONFIG_FILE,
    ENV,
    INGEST_FINDING_LIMIT,
    INIT_FILE,
    L0_FILE,
    REPORT_DIR,
    RULE,
    SCOPE_FILE,
    SESSION_FILE,
    UTF8,
    WARNING,
} from "./constants.ts";
import { EMPTY_USAGE, makeFinding } from "./contract/finding.ts";
import type { Finding, Patch, Usage } from "./contract/finding.ts";
import { CONTEXT_KIND, parseKind } from "./contract/kind.ts";
import type { CrKind } from "./contract/kind.ts";
import type { CodeTrace } from "./contract/trace.ts";
import { buildReport, isBlocking, renderMarkdown, writeReport } from "./contract/report.ts";
import type { ReviewReport } from "./contract/report.ts";
import { changedFiles, diffText, headSha, patchFiles, showFile, tryGit } from "./git.ts";
import { fetchInit, splitSecret } from "./init/client.ts";
import type { InitConfig } from "./init/client.ts";
import { runL0 } from "./l0/index.ts";
import { createLive } from "./live.ts";
import type { LiveReport } from "./live.ts";
import type { Approved } from "./l0/index.ts";
import { worktreeSnapshot } from "./l0/snapshot.ts";
import {
    diffLineComment,
    renderChunkReview,
    renderComment,
    renderEvidenceReview,
    renderProgress,
} from "./publish/comment.ts";
import { compareUrl, githubTarget, postPullReview, pushPatchBranch, writeBack } from "./publish/github.ts";
import { adoptGithubActor } from "./publish/app-token.ts";
import type { GithubTarget } from "./publish/github.ts";
import { postRun, postSpend, sessionsToJsonl, statusOf } from "./publish/ingest.ts";
import { loadIntent, renderIntent } from "./review/intent.ts";
import { runReview } from "./review/index.ts";
import { buildEvidencePack } from "./review/evidence.ts";
import type { Rejection } from "./review/index.ts";
import type { AgentRunner } from "./review/agent.ts";
import { createPiRunner } from "./review/pi.ts";
import { RULES_REPORT_NAME } from "./rules/constants.ts";
import { runRulesStep } from "./rules/run.ts";
import type { RulesReport } from "./rules/report.ts";
import type { RulesRun } from "./rules/run.ts";
import { resolveBase } from "./scope/base.ts";
import type { EventInfo } from "./scope/base.ts";
import { computeCodeScope } from "./scope/code.ts";
import type { CodeScope } from "./scope/code.ts";
import { computeScope } from "./scope/index.ts";
import type { ContextScope } from "./scope/index.ts";
import { dropKey, load, required, resetState, save, setOutput, stateFile, storeKey, takeKey } from "./state.ts";

/**
 * POST /runs accepts at most INGEST_FINDING_LIMIT findings. A repository with a large pre-existing
 * backlog can exceed that, and letting the request fail loses the run, its report and its cost: the
 * Worker never sees it and the overview shows nothing. Keep the most severe findings instead; the full
 * list already lives in the report, which is stored in R2 by the same request.
 *
 * Errors come first because they are what can block a merge, and within a severity the order is the one
 * sortFindings produced, so the truncation is deterministic rather than arbitrary.
 */
export function capFindings(findings: Finding[]): Finding[] {
    if (findings.length <= INGEST_FINDING_LIMIT) {
        return findings;
    }
    const errors = findings.filter((item) => item.severity === "error");
    const warnings = findings.filter((item) => item.severity !== "error");
    return [...errors, ...warnings].slice(0, INGEST_FINDING_LIMIT);
}

/**
 * The rules step's findings for this head, merged into the published report so the overview's rule
 * dimension sees ARCH/STYLE/DOC/CTX/CI hits. Rules are report-only in CI ("Error only from L0"), so every
 * rules finding enters as a warning: it is counted and ingested, but it can never change the job's
 * conclusion or the run status from passed/warned to failed. A code CR has no rules stage; a missing,
 * unreadable or stale rules.json (another head) counts as no findings.
 */
export function rulesFindings(root: string, kind: CrKind, head: string): Finding[] {
    if (kind === "code") {
        return [];
    }
    const path = join(root, REPORT_DIR, RULES_REPORT_NAME + ".json");
    if (!existsSync(path)) {
        return [];
    }
    let rules: RulesReport;
    try {
        rules = JSON.parse(readFileSync(path, UTF8)) as RulesReport;
    } catch (error) {
        process.stderr.write(`rules report unreadable, not merged: ${errorText(error)}\n`);
        return [];
    }
    if (!Array.isArray(rules.findings) || (rules.head && head && rules.head !== head)) {
        return [];
    }
    return rules.findings.map((item) => (item.severity === WARNING ? item : { ...item, severity: WARNING }));
}

type InitState = { nonce: string; config: InitConfig; startedAt: number; head: string; event: EventInfo };
type L0State = { findings: Finding[] };
type AiState = {
    nonce: string;
    findings: Finding[];
    patches: Patch[];
    usage: Usage;
    rejected: number;
    complete: boolean;
    /** True when the candidate cap cut the review short: part of the scope was never reviewed. */
    truncated: boolean;
    errors: string[];
    notReviewed: string[];
    rejections: Rejection[];
    trace?: CodeTrace;
};

const LOCAL_CONFIG: InitConfig = {
    repo: "local",
    kind: CONTEXT_KIND,
    enabled: true,
    l0Only: true,
    api: "openai-completions",
    models: { finder: "", verifier: "" },
    limits: { contextWindow: 0, maxTokens: 0, maxCandidates: 0, maxRunUsd: null },
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    suppressions: [],
};

/**
 * The workflow's kind input. An unknown value is refused before any network call: guessing would run the
 * wrong review and still report a status the overview trusts.
 */
function requestedKind(): CrKind | undefined {
    const raw = process.env[ENV.kind];
    return raw === undefined || raw === "" ? undefined : parseKind(raw);
}

/** Live reporter for a step that has run state: repo and kind from /init, the nonce as runId fallback. */
function liveFor(state: InitState): LiveReport {
    return createLive({ repo: state.config.repo, kind: state.config.kind, nonce: state.nonce });
}

function since(started: number): number {
    return Date.now() - started;
}

export async function stepInit(root: string): Promise<InitState> {
    const started = Date.now();
    try {
        const state = await initRun(root);
        const live = liveFor(state);
        live.stage("init", "done", since(started));
        await live.flush();
        return state;
    } catch (error) {
        // No config yet: speak for the workflow's repository and requested kind, if they are usable at all.
        let kind: CrKind = CONTEXT_KIND;
        try {
            kind = requestedKind() ?? CONTEXT_KIND;
        } catch {
            // The kind input itself was the failure; the event still goes out under the default kind.
        }
        const live = createLive({ repo: process.env[ENV.githubRepository] ?? "", kind, nonce: randomUUID() });
        live.log("init", "error", errorText(error));
        live.stage("init", "failed", since(started));
        await live.flush();
        throw error;
    }
}

async function initRun(root: string): Promise<InitState> {
    const repo = required(ENV.githubRepository);
    const response = await fetchInit(
        required(ENV.endpoint),
        required(ENV.token),
        repo,
        process.env[ENV.group],
        requestedKind(),
    );
    const nonce = resetState(root);
    const { config, apiKey } = splitSecret(response);
    if (apiKey) {
        storeKey(root, apiKey);
    }
    const head = headSha(root);
    const event = resolveBase(root, head, config.lastSha);
    const state: InitState = { nonce, config, startedAt: Date.now(), head, event };
    save(root, INIT_FILE, state);
    setOutput("l0_only", config.l0Only ? "true" : "false");
    return state;
}

export function initState(root: string): InitState {
    const existing = load<InitState>(root, INIT_FILE);
    if (existing) {
        return existing;
    }
    const head = headSha(root);
    // A local run has no /init, so HX_CTX_KIND (the --kind flag) is the only way to pick a kind.
    const config = {
        ...LOCAL_CONFIG,
        kind: requestedKind() ?? LOCAL_CONFIG.kind,
        repo: process.env[ENV.githubRepository] ?? "local",
    };
    return { nonce: "local", config, startedAt: Date.now(), head, event: resolveBase(root, head) };
}

/**
 * Config for a CI step. A run that went through /init reads it from the trusted base, so the reviewed change
 * cannot exclude itself from the checks; a local run (no /init) keeps the worktree copy it is editing.
 */
function stepConfig(root: string, state: InitState): RepoConfig {
    return state.nonce === "local" ? loadConfig(root) : loadTrustedConfig(root, state.event.base);
}

/** One Warning when the reviewed range edits the config file: the edit is not applied until it is merged. */
function configChanged(root: string, state: InitState): Finding[] {
    if (state.nonce === "local" || !state.event.base) {
        return [];
    }
    const changed = changedFiles(root, state.event.base, state.head).some((item) => item.path === CONFIG_FILE);
    if (!changed) {
        return [];
    }
    return [
        makeFinding(
            RULE.config,
            WARNING,
            CONFIG_FILE,
            1,
            "Repository config changed in this range; this run used the copy at the trusted base",
            "config differs from base " + state.event.base.slice(0, 12),
            "config-changed",
        ),
    ];
}

function baseline(root: string, base: string, config: RepoConfig): Approved[] {
    const path = config.baseline;
    const text = path && base ? showFile(root, base, path) : undefined;
    return text ? (JSON.parse(text) as Approved[]) : [];
}

/**
 * L0 rules (HC-*, CX-*) judge whether context files match the code, so they belong to a context CR only.
 * A code CR has no L0 stage: running them there would label context findings as kind=code and let a stale
 * AGENTS.md fail a job whose subject is the diff, which are two different concerns. The empty list is
 * still written, so publish and the CLI read a scope of the same shape for both kinds.
 */
export function stepL0(root: string): Finding[] {
    const state = initState(root);
    const live = liveFor(state);
    const started = Date.now();
    live.stage("l0", "running");
    try {
        const findings = l0Run(root, state);
        const errors = findings.filter((item) => item.severity === "error");
        if (errors.length) {
            live.log("l0", "error", `${errors.length} Error finding(s), ${errors.filter(isBlocking).length} blocking`);
        }
        live.stage("l0", "done", since(started), state.config.kind === "code" ? "skipped for code CR" : undefined);
        return findings;
    } catch (error) {
        live.log("l0", "error", errorText(error));
        live.stage("l0", "failed", since(started));
        throw error;
    }
}

function l0Run(root: string, state: InitState): Finding[] {
    const notice = configChanged(root, state);
    if (state.config.kind === "code") {
        save(root, L0_FILE, { findings: notice } satisfies L0State);
        return notice;
    }
    const config = stepConfig(root, state);
    const findings = [...runL0(worktreeSnapshot(root), config, baseline(root, state.event.base, config)), ...notice];
    save(root, L0_FILE, { findings } satisfies L0State);
    return findings;
}

/** What one run reviews, as stored in scope.json: context files for one kind, diff hunks for the other. */
export type RunScope = ContextScope | CodeScope;

/**
 * A code CR reads one file's diff at a time: the change list is already NUL-safe, so a path is never parsed
 * out of a possibly C-quoted diff header.
 */
function diffOf(root: string, base: string, head: string, path: string): string {
    return diffText(root, base, head, [path]);
}

export function stepScope(root: string): RunScope {
    const state = initState(root);
    const live = liveFor(state);
    const started = Date.now();
    live.stage("scope", "running");
    try {
        const scope = scopeRun(root, state);
        live.log(
            "scope",
            "info",
            scope.kind === "code" ? `${scope.hunks.length} 个 hunk` : `${scope.contexts.length} 个上下文文件`,
        );
        live.stage("scope", "done", since(started));
        return scope;
    } catch (error) {
        live.log("scope", "error", errorText(error));
        live.stage("scope", "failed", since(started));
        throw error;
    }
}

function scopeRun(root: string, state: InitState): RunScope {
    const { base } = state.event;
    const changes = changedFiles(root, base, state.head);
    const config = stepConfig(root, state);
    const scope =
        state.config.kind === "code"
            ? computeCodeScope((path) => diffOf(root, base, state.head, path), config, changes, base, state.head)
            : computeScope(worktreeSnapshot(root), config, changes, base, state.head);
    save(root, SCOPE_FILE, scope);
    setOutput("empty", scopeEmpty(scope) ? "true" : "false");
    return scope;
}

/** True when the scope holds nothing to review: no context file, or no added or removed line. */
export function scopeEmpty(scope: RunScope): boolean {
    return scope.kind === "code" ? scope.hunks.length === 0 : scope.contexts.length === 0;
}

function reviewExpected(state: InitState, scope: RunScope | undefined): boolean {
    return !state.config.l0Only && (scope === undefined || !scopeEmpty(scope));
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The review could not start. The AI stage never fails the job, so instead of throwing it records an
 * unfinished result bound to this run's nonce: publish then reports the run incomplete with the reason,
 * and last_sha stays where it was so the range is reviewed again.
 */
function unfinished(root: string, state: InitState, reason: string): AiState {
    const ai: AiState = {
        nonce: state.nonce,
        findings: [],
        patches: [],
        usage: EMPTY_USAGE,
        rejected: 0,
        complete: false,
        truncated: false,
        errors: [reason],
        notReviewed: [],
        rejections: [],
    };
    process.stderr.write(`review: ${reason}\n`);
    save(root, AI_FILE, ai);
    return ai;
}

export async function stepReview(root: string): Promise<AiState | undefined> {
    const state = initState(root);
    const live = liveFor(state);
    const started = Date.now();
    live.stage("review", "running");
    try {
        const ai = await reviewRun(root, state, live);
        if (!ai) {
            live.stage("review", "done", since(started), "skipped: nothing to review or L0 only");
        } else {
            for (const error of ai.errors) {
                live.log("review", "error", error);
            }
            live.stage("review", ai.complete ? "done" : "failed", since(started), aiStage(ai));
        }
        return ai;
    } catch (error) {
        live.log("review", "error", errorText(error));
        live.stage("review", "failed", since(started));
        throw error;
    } finally {
        await live.flush();
    }
}

/**
 * Wraps the model runner so every finished session reports progress. Finder sessions run one per batch,
 * then one verifier per candidate that passed the gate; the batch total is not known outside runReview.
 */
function liveRunner(run: AgentRunner, live: LiveReport): { run: AgentRunner; verified: () => number } {
    let batch = 0;
    let verifierDone = 0;
    const wrapped: AgentRunner = async (request) => {
        try {
            return await run(request);
        } finally {
            if (request.role === "finder") {
                live.progress("review", { batch: ++batch });
            } else {
                live.progress("review", { verifierDone: ++verifierDone });
            }
        }
    };
    return { run: wrapped, verified: () => verifierDone };
}

async function reviewRun(root: string, state: InitState, live: LiveReport): Promise<AiState | undefined> {
    const scope = load<RunScope>(root, SCOPE_FILE) ?? stepScope(root);
    const apiKey = takeKey(root);
    if (!reviewExpected(state, scope)) {
        return undefined;
    }
    if (!apiKey) {
        return unfinished(root, state, "no api key from init; run the init step first");
    }
    // Progress comments and the later line reviews must be the product app when one is installed.
    await adoptGithubActor();
    // The diff is a context-CR input: a code CR is scoped to its hunks and reads the rest with its tools.
    const diff = scope.kind === "code" ? "" : diffText(root, scope.base, scope.head);
    const endpoint = process.env[ENV.endpoint];
    const token = process.env[ENV.token];
    const claim = state.config.budgetClaim;
    // A capped run must be able to mark its claim as spending before the first session. Without the marker
    // the Worker settles a taken-over claim as 0 and hands the same remainder out again, so a missing
    // claim or a missing endpoint/token is a configuration error rather than an unmarked spending run.
    if (state.config.limits.maxRunUsd !== null && !(claim && endpoint && token)) {
        return unfinished(
            root,
            state,
            "a budgeted run needs limits.maxRunUsd, budgetClaim, HX_CTX_ENDPOINT and HX_CTX_TOKEN " +
                "to mark the claim as spending before the first model session",
        );
    }
    let run: Awaited<ReturnType<typeof createPiRunner>>;
    try {
        run = await createPiRunner(root, state.config, apiKey);
    } catch (error) {
        return unfinished(root, state, `model runtime failed to start: ${errorText(error)}`);
    }
    // A failed evidence lookup must not fail the review: the finder still has the diff and the context files.
    const repoConfig = stepConfig(root, state);
    let evidence = "";
    // Intentional degradation: in CI the review step only gets HX_CTX_TOKEN, never GITHUB_TOKEN (the model
    // tools must not see a write token), so related PRs and issues are always empty there. Without a token
    // the limits are pinned to 0 so logs and the pack agree; only a local run with GITHUB_TOKEN fills them.
    const github = githubTarget();
    if (!github) {
        process.stderr.write("evidence pack: no GITHUB_TOKEN, related PRs and issues off (prs=0, issues=0)\n");
    }
    try {
        evidence = await buildEvidencePack({
            root,
            changed: scope.changed,
            readFile: (path) => readTracked(root, path),
            github,
            prs: github ? repoConfig.evidencePrs : 0,
            issues: github ? repoConfig.evidenceIssues : 0,
        });
    } catch (error) {
        process.stderr.write(`evidence pack skipped: ${errorText(error)}\n`);
    }
    let intent = "";
    if (scope.kind === "code") {
        try {
            // The card is untrusted text. A missing event file or a failed issue lookup still leaves
            // the commits, and a total failure leaves the review with no card rather than no review.
            intent = renderIntent(await loadIntent(root, scope.base, scope.head, issueLookup));
        } catch (error) {
            process.stderr.write(`intent card skipped: ${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
    const tracked = liveRunner(run, live);
    const result = await runReview(state.config, scope, {
        run: tracked.run,
        diff,
        evidence,
        intent,
        patchFiles: (patch) => patchFiles(root, patch),
        readFile: (path) => readTracked(root, path),
        // The Worker settles a taken-over claim only if it was marked as spending, so a run cancelled
        // before its first session is charged nothing. Only meaningful for a budgeted repo with a claim.
        onSpend: endpoint && token && claim ? (signal) => postSpend(endpoint, token, claim, signal) : undefined,
        // Code CR rewrites the sticky PR comment as groups are assembled, reviewed and checked.
        // adoptGithubActor already swapped in the app installation token when the repo has the app.
        onProgress:
            state.config.kind === "code"
                ? async (note) => {
                      const target = githubTarget();
                      if (!target || state.event.prNumber === undefined) {
                          return;
                      }
                      await writeBack(target, state.head, renderProgress(note), state.event.prNumber);
                  }
                : undefined,
    });
    writeFileSync(stateFile(root, SESSION_FILE), sessionsToJsonl(result.transcripts), UTF8);
    const { findings, patches, usage, rejected, complete, truncated, errors, notReviewed, rejections, trace } = result;
    // Every candidate the finders reported ends confirmed or rejected (by the gate or a verifier).
    live.progress("review", { candidates: findings.length + rejected, verifierDone: tracked.verified() });
    for (const item of findings) {
        live.finding(item.ruleId, item.path, item.line, item.severity, item.message);
    }
    const ai: AiState = {
        nonce: state.nonce,
        findings,
        patches,
        usage,
        rejected,
        complete,
        truncated,
        errors,
        notReviewed,
        rejections,
        trace,
    };
    for (const error of errors) {
        process.stderr.write(`review: ${error}\n`);
    }
    save(root, AI_FILE, ai);
    return ai;
}

/** One line per scope kind, so the report says what was actually in scope. */
function scopeStage(scope: RunScope): string {
    return scope.kind === "code" ? `${scope.hunks.length} diff hunk(s)` : `${scope.contexts.length} context file(s)`;
}

function aiStage(ai: AiState): string {
    const parts = [`${ai.findings.length} confirmed`, `${ai.rejected} rejected`];
    if (ai.notReviewed.length) {
        // Each entry states its own cause (unreadable, symlink, candidate limit); do not mislabel them all.
        parts.push(`not reviewed: ${ai.notReviewed.join(", ")}`);
    }
    if (ai.truncated) {
        parts.push("truncated: candidate limit reached, range will be reviewed again");
    }
    if (!ai.complete) {
        parts.push("incomplete: " + ai.errors.join("; "));
    }
    return parts.join(", ");
}

const UNREVIEWED_CAUSES = new Set(["budget", "config"]);

/** Context files come from the reviewed commit via git, never the filesystem: no .git, no symlink targets. */
/** Issue title and body for the intent card. No token, or a failed request, leaves the number unfilled. */
async function issueLookup(number: number): Promise<{ title: string; body: string } | undefined> {
    const target = githubTarget();
    if (!target) {
        return undefined;
    }
    const response = await fetch(target.apiUrl + "/repos/" + target.repo + "/issues/" + number, {
        headers: { authorization: "Bearer " + target.token, accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
        return undefined;
    }
    const body = (await response.json()) as { title?: string; body?: string | null };
    return { title: body.title ?? "", body: body.body ?? "" };
}

function readTracked(root: string, path: string): string | undefined {
    if (path.split("/").includes(".git")) {
        return undefined;
    }
    const entry = tryGit(root, ["ls-tree", "HEAD", "--", path]) ?? "";
    // Mode 120000 is a symlink: its blob is a target path that may point outside the repository.
    if (!entry.startsWith("100644 blob ") && !entry.startsWith("100755 blob ")) {
        return undefined;
    }
    return showFile(root, "HEAD", path);
}

function safePatchBranch(root: string, head: string, report: ReviewReport, target: GithubTarget): string | undefined {
    try {
        return pushPatchBranch(root, head, report.patches, target);
    } catch (error) {
        // The patch branch is optional; ingest and comments must still happen.
        process.stderr.write(`patch branch skipped: ${errorText(error)}\n`);
        return undefined;
    }
}

/**
 * Two reviews on the pull request, both from the token's app account. The first shows the assembled
 * diff. The second is the evidence check, and only confirmed findings become line comments. A review
 * that GitHub refuses (a line no longer in the diff, a missing permission) must not drop the report.
 */
async function postCodeReviews(target: GithubTarget, prNumber: number, sha: string, trace: CodeTrace): Promise<void> {
    const notes = trace.checks
        .filter((check) => check.verdict === "confirmed" && check.quote)
        .map((check) => ({
            path: check.path,
            line: check.line,
            side: check.side,
            body: diffLineComment(check),
        }));
    try {
        await postPullReview(target, prNumber, sha, renderChunkReview(trace), []);
    } catch (error) {
        process.stderr.write(`chunk review skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    try {
        await postPullReview(target, prNumber, sha, renderEvidenceReview(trace), notes);
    } catch (error) {
        process.stderr.write(`line review skipped: ${error instanceof Error ? error.message : String(error)}\n`);
        try {
            await postPullReview(target, prNumber, sha, renderEvidenceReview(trace), []);
        } catch (again) {
            process.stderr.write(
                `evidence review skipped: ${again instanceof Error ? again.message : String(again)}\n`,
            );
        }
    }
}

/** Aggregate, write MD/JSON, push the patch branch, ingest to CF, comment. Returns blocking count. */
export async function stepPublish(root: string): Promise<number> {
    dropKey(root);
    await adoptGithubActor();
    const state = initState(root);
    const live = liveFor(state);
    const started = Date.now();
    live.stage("publish", "running");
    const outcome: PublishOutcome = {};
    try {
        const blocking = await publishRun(root, state, outcome);
        live.stage("publish", "done", since(started));
        return blocking;
    } catch (error) {
        live.log("publish", "error", errorText(error));
        live.stage("publish", "failed", since(started));
        throw error;
    } finally {
        // The run's last event, with the report's real counts; a publish that died first reports incomplete.
        const report = outcome.report;
        live.done({
            complete: outcome.complete === true,
            status: outcome.status ?? "incomplete",
            durationMs: report?.durationMs ?? Date.now() - state.startedAt,
            findings: report?.findings.length ?? 0,
            errors: report?.counts.error ?? 0,
            warnings: report?.counts.warning ?? 0,
        });
        await live.flush();
    }
}

/** What publish got as far as computing, so the final live event can carry it even after a failure. */
type PublishOutcome = { report?: ReviewReport; complete?: boolean; status?: ReturnType<typeof statusOf> };

async function publishRun(root: string, state: InitState, outcome: PublishOutcome): Promise<number> {
    const l0 = load<L0State>(root, L0_FILE) ?? { findings: stepL0(root) };
    const scope = load<RunScope>(root, SCOPE_FILE);
    const stored = load<AiState>(root, AI_FILE);
    // Only AI output produced by this run's review step counts; anything else is ignored.
    const ai = stored?.nonce === state.nonce ? stored : undefined;
    // Budget or provider problems mean the range was never reviewed: report incomplete so last_sha stays put.
    const skippedReview = state.config.l0Only && UNREVIEWED_CAUSES.has(state.config.l0Cause ?? "");
    // A truncated review left part of the scope unread, so it counts as unfinished for last_sha too.
    const reviewed = ai?.complete === true && ai.truncated !== true;
    const complete = scope !== undefined && !skippedReview && (!reviewExpected(state, scope) || reviewed);
    const code = state.config.kind === "code";
    // rules findings ride along report-only (warnings): visible in counts and /runs, never blocking.
    const rules = rulesFindings(root, state.config.kind, state.head);
    const report = buildReport({
        repo: state.config.repo,
        kind: state.config.kind,
        base: state.event.base,
        head: state.head,
        findings: [...l0.findings, ...(ai?.findings ?? []), ...rules],
        patches: ai?.patches ?? [],
        rejections: ai?.rejections ?? [],
        trace: ai?.trace,
        usage: ai?.usage ?? EMPTY_USAGE,
        durationMs: Date.now() - state.startedAt,
        stages: {
            base: state.event.reason,
            scope: scope ? scopeStage(scope) : "not run",
            ai: state.config.l0Only
                ? "L0 only: " + (state.config.reason ?? "disabled")
                : ai
                  ? aiStage(ai)
                  : complete
                    ? "nothing in scope"
                    : "incomplete: review did not finish",
        },
    });
    writeReport(root, report);
    const status = statusOf(report.counts, scope === undefined || scopeEmpty(scope), complete);
    Object.assign(outcome, { report, complete, status });
    const target = githubTarget();
    // A code CR reviews the change instead of writing one: it never pushes a patch branch, even if a
    // candidate somehow carried a patch.
    const patchBranch = target && !code ? safePatchBranch(root, state.head, report, target) : undefined;
    const endpoint = process.env[ENV.endpoint];
    const token = process.env[ENV.token];
    let overviewUrl: string | undefined;
    let resolvedNote: string | undefined;
    if (endpoint && token) {
        const sessionsPath = stateFile(root, SESSION_FILE);
        const ingest = await postRun(endpoint, token, {
            repo: state.config.repo,
            kind: state.config.kind,
            sha: state.head,
            baseSha: state.event.base,
            event: state.event.name,
            prNumber: state.event.prNumber,
            ref: process.env[ENV.githubRef],
            defaultBranch: state.event.defaultBranch,
            status,
            complete,
            l0Only: state.config.l0Only,
            durationMs: report.durationMs,
            usage: report.usage,
            counts: report.counts,
            findings: capFindings(report.findings),
            patches: report.patches,
            patchBranch,
            budgetClaim: state.config.budgetClaim,
            reportMarkdown: renderMarkdown(report),
            reportJson: JSON.stringify(report),
            sessionsJsonl: ai && existsSync(sessionsPath) ? readFileSync(sessionsPath, UTF8) : "",
        });
        overviewUrl = ingest.overviewUrl;
        if ((ingest.resolved ?? 0) > 0) {
            resolvedNote = `Marked ${ingest.resolved} earlier finding(s) on this pull request resolved.`;
        }
    }
    if (target && (report.findings.length || state.event.prNumber !== undefined)) {
        const patchUrl = patchBranch ? compareUrl(target, patchBranch) : undefined;
        if (code && state.event.prNumber !== undefined && ai?.trace) {
            await postCodeReviews(target, state.event.prNumber, state.head, ai.trace);
        }
        // The run is already ingested; a failed comment must not turn the job red, like the patch branch.
        try {
            await writeBack(
                target,
                state.head,
                renderComment(report, { patchUrl, overviewUrl }, resolvedNote),
                state.event.prNumber,
                state.config.kind,
            );
        } catch (error) {
            process.stderr.write(`comment skipped: ${errorText(error)}\n`);
        }
    }
    return report.findings.filter(isBlocking).length;
}

/**
 * The rules subcommand with live stage events. The registry itself is unchanged: runRulesStep still decides
 * the findings and the exit code; this only reports that the stage ran and how it ended.
 */
export function stepRules(root: string, baseRef?: string): RulesRun {
    const live = liveFor(initState(root));
    const started = Date.now();
    live.stage("rules", "running");
    try {
        const run = runRulesStep(root, baseRef);
        const { counts } = run.report;
        const summary = `${counts.error} error(s), ${counts.warning} warning(s), ${counts.blocking} blocking`;
        live.stage("rules", "done", since(started), summary);
        return run;
    } catch (error) {
        live.log("rules", "error", errorText(error));
        live.stage("rules", "failed", since(started));
        throw error;
    }
}
