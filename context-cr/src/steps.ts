import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { AI_FILE, ENV, INIT_FILE, L0_FILE, SCOPE_FILE, SESSION_FILE, UTF8 } from "./constants.ts";
import { EMPTY_USAGE } from "./contract/finding.ts";
import type { Finding, Patch, Usage } from "./contract/finding.ts";
import { CONTEXT_KIND, parseKind } from "./contract/kind.ts";
import type { CrKind } from "./contract/kind.ts";
import { buildReport, isBlocking, renderMarkdown, writeReport } from "./contract/report.ts";
import type { ReviewReport } from "./contract/report.ts";
import { changedFiles, diffText, headSha, patchFiles, showFile, tryGit } from "./git.ts";
import { fetchInit, splitSecret } from "./init/client.ts";
import type { InitConfig } from "./init/client.ts";
import { runL0 } from "./l0/index.ts";
import type { Approved } from "./l0/index.ts";
import { worktreeSnapshot } from "./l0/snapshot.ts";
import { renderComment } from "./publish/comment.ts";
import { compareUrl, githubTarget, pushPatchBranch, writeBack } from "./publish/github.ts";
import type { GithubTarget } from "./publish/github.ts";
import { postRun, postSpend, sessionsToJsonl, statusOf } from "./publish/ingest.ts";
import { runReview } from "./review/index.ts";
import { buildEvidencePack } from "./review/evidence.ts";
import type { Rejection } from "./review/index.ts";
import { createPiRunner } from "./review/pi.ts";
import { resolveBase } from "./scope/base.ts";
import type { EventInfo } from "./scope/base.ts";
import { computeCodeScope } from "./scope/code.ts";
import type { CodeScope } from "./scope/code.ts";
import { computeScope } from "./scope/index.ts";
import type { ContextScope } from "./scope/index.ts";
import { dropKey, load, required, resetState, save, setOutput, stateFile, storeKey, takeKey } from "./state.ts";

type InitState = { nonce: string; config: InitConfig; startedAt: number; head: string; event: EventInfo };
type L0State = { findings: Finding[] };
type AiState = {
    nonce: string;
    findings: Finding[];
    patches: Patch[];
    usage: Usage;
    rejected: number;
    complete: boolean;
    errors: string[];
    notReviewed: string[];
    rejections: Rejection[];
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

export async function stepInit(root: string): Promise<InitState> {
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

function initState(root: string): InitState {
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

function baseline(root: string, base: string): Approved[] {
    const path = loadConfig(root).baseline;
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
    if (state.config.kind === "code") {
        save(root, L0_FILE, { findings: [] } satisfies L0State);
        return [];
    }
    const findings = runL0(worktreeSnapshot(root), loadConfig(root), baseline(root, state.event.base));
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
    const { base } = state.event;
    const changes = changedFiles(root, base, state.head);
    const config = loadConfig(root);
    const scope =
        state.config.kind === "code"
            ? computeCodeScope((path) => diffOf(root, base, state.head, path), config, changes, base, state.head)
            : computeScope(worktreeSnapshot(root), config, changes, base, state.head);
    save(root, SCOPE_FILE, scope);
    setOutput("empty", scopeEmpty(scope) ? "true" : "false");
    return scope;
}

/** True when the scope holds nothing to review: no context file, or no added line in the diff. */
export function scopeEmpty(scope: RunScope): boolean {
    return scope.kind === "code" ? scope.hunks.length === 0 : scope.contexts.length === 0;
}

function reviewExpected(state: InitState, scope: RunScope | undefined): boolean {
    return !state.config.l0Only && (scope === undefined || !scopeEmpty(scope));
}

export async function stepReview(root: string): Promise<AiState | undefined> {
    const state = initState(root);
    const scope = load<RunScope>(root, SCOPE_FILE) ?? stepScope(root);
    const apiKey = takeKey(root);
    if (!reviewExpected(state, scope)) {
        return undefined;
    }
    if (!apiKey) {
        throw new Error("no api key from init; run the init step first");
    }
    const run = await createPiRunner(root, state.config, apiKey);
    // The diff is a context-CR input: a code CR is scoped to its hunks and reads the rest with its tools.
    const diff = scope.kind === "code" ? "" : diffText(root, scope.base, scope.head);
    const endpoint = process.env[ENV.endpoint];
    const token = process.env[ENV.token];
    const claim = state.config.budgetClaim;
    // A capped run must be able to mark its claim as spending before the first session. Without the marker
    // the Worker settles a taken-over claim as 0 and hands the same remainder out again, so a missing
    // claim or a missing endpoint/token is a configuration error rather than an unmarked spending run.
    if (state.config.limits.maxRunUsd !== null && !(claim && endpoint && token)) {
        throw new Error(
            "a budgeted run needs limits.maxRunUsd, budgetClaim, HX_CTX_ENDPOINT and HX_CTX_TOKEN " +
                "to mark the claim as spending before the first model session",
        );
    }
    // A failed evidence lookup must not fail the review: the finder still has the diff and the context files.
    const repoConfig = loadConfig(root);
    let evidence = "";
    try {
        evidence = await buildEvidencePack({
            root,
            changed: scope.changed,
            readFile: (path) => readTracked(root, path),
            github: githubTarget(),
            prs: repoConfig.evidencePrs,
            issues: repoConfig.evidenceIssues,
        });
    } catch (error) {
        process.stderr.write(`evidence pack skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    const result = await runReview(state.config, scope, {
        run,
        diff,
        evidence,
        patchFiles: (patch) => patchFiles(root, patch),
        readFile: (path) => readTracked(root, path),
        // The Worker settles a taken-over claim only if it was marked as spending, so a run cancelled
        // before its first session is charged nothing. Only meaningful for a budgeted repo with a claim.
        onSpend: endpoint && token && claim ? (signal) => postSpend(endpoint, token, claim, signal) : undefined,
    });
    writeFileSync(stateFile(root, SESSION_FILE), sessionsToJsonl(result.transcripts), UTF8);
    const { findings, patches, usage, rejected, complete, errors, notReviewed, rejections } = result;
    const ai: AiState = {
        nonce: state.nonce,
        findings,
        patches,
        usage,
        rejected,
        complete,
        errors,
        notReviewed,
        rejections,
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
    if (!ai.complete) {
        parts.push("incomplete: " + ai.errors.join("; "));
    }
    return parts.join(", ");
}

const UNREVIEWED_CAUSES = new Set(["budget", "config"]);

/** Context files come from the reviewed commit via git, never the filesystem: no .git, no symlink targets. */
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
        process.stderr.write(`patch branch skipped: ${error instanceof Error ? error.message : String(error)}\n`);
        return undefined;
    }
}

/** Aggregate, write MD/JSON, push the patch branch, ingest to CF, comment. Returns blocking count. */
export async function stepPublish(root: string): Promise<number> {
    dropKey(root);
    const state = initState(root);
    const l0 = load<L0State>(root, L0_FILE) ?? { findings: stepL0(root) };
    const scope = load<RunScope>(root, SCOPE_FILE);
    const stored = load<AiState>(root, AI_FILE);
    // Only AI output produced by this run's review step counts; anything else is ignored.
    const ai = stored?.nonce === state.nonce ? stored : undefined;
    // Budget or provider problems mean the range was never reviewed: report incomplete so last_sha stays put.
    const skippedReview = state.config.l0Only && UNREVIEWED_CAUSES.has(state.config.l0Cause ?? "");
    const complete = scope !== undefined && !skippedReview && (!reviewExpected(state, scope) || ai?.complete === true);
    const code = state.config.kind === "code";
    const report = buildReport({
        repo: state.config.repo,
        kind: state.config.kind,
        base: state.event.base,
        head: state.head,
        findings: [...l0.findings, ...(ai?.findings ?? [])],
        patches: ai?.patches ?? [],
        rejections: ai?.rejections ?? [],
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
            status: statusOf(report.counts, scope === undefined || scopeEmpty(scope), complete),
            complete,
            l0Only: state.config.l0Only,
            durationMs: report.durationMs,
            usage: report.usage,
            counts: report.counts,
            findings: report.findings,
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
        await writeBack(
            target,
            state.head,
            renderComment(report, { patchUrl, overviewUrl }, resolvedNote),
            state.event.prNumber,
        );
    }
    return report.findings.filter(isBlocking).length;
}
