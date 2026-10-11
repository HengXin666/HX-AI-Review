import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { AI_FILE, ENV, INIT_FILE, L0_FILE, SCOPE_FILE, SESSION_FILE, UTF8 } from "./constants.ts";
import { EMPTY_USAGE } from "./contract/finding.ts";
import type { Finding, Patch, Usage } from "./contract/finding.ts";
import { buildReport, isBlocking, renderMarkdown, writeReport } from "./contract/report.ts";
import type { ReviewReport } from "./contract/report.ts";
import { changedFiles, diffText, headSha, patchFiles, showFile } from "./git.ts";
import { fetchInit, splitSecret } from "./init/client.ts";
import type { InitConfig } from "./init/client.ts";
import { runL0 } from "./l0/index.ts";
import type { Approved } from "./l0/index.ts";
import { worktreeSnapshot } from "./l0/snapshot.ts";
import { renderComment } from "./publish/comment.ts";
import { compareUrl, githubTarget, pushPatchBranch, writeBack } from "./publish/github.ts";
import { postRun, sessionsToJsonl, statusOf } from "./publish/ingest.ts";
import { runReview } from "./review/index.ts";
import { createPiRunner } from "./review/pi.ts";
import { resolveBase } from "./scope/base.ts";
import type { EventInfo } from "./scope/base.ts";
import { computeScope } from "./scope/index.ts";
import type { ContextScope } from "./scope/index.ts";
import { dropKey, load, required, resetState, save, setOutput, stateFile, storeKey, takeKey } from "./state.ts";

type InitState = { nonce: string; config: InitConfig; startedAt: number; head: string; event: EventInfo };
type L0State = { findings: Finding[] };
type AiState = { nonce: string; findings: Finding[]; patches: Patch[]; usage: Usage; rejected: number };

const LOCAL_CONFIG: InitConfig = {
    repo: "local",
    enabled: true,
    l0Only: true,
    api: "openai-completions",
    models: { finder: "", verifier: "" },
    limits: { contextWindow: 0, maxTokens: 0, maxCandidates: 0 },
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    suppressions: [],
};

export async function stepInit(root: string): Promise<InitState> {
    const repo = required(ENV.githubRepository);
    const response = await fetchInit(required(ENV.endpoint), required(ENV.token), repo);
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
    const config = { ...LOCAL_CONFIG, repo: process.env[ENV.githubRepository] ?? "local" };
    return { nonce: "local", config, startedAt: Date.now(), head, event: resolveBase(root, head) };
}

function baseline(root: string, base: string): Approved[] {
    const path = loadConfig(root).baseline;
    const text = path && base ? showFile(root, base, path) : undefined;
    return text ? (JSON.parse(text) as Approved[]) : [];
}

export function stepL0(root: string): Finding[] {
    const state = initState(root);
    const findings = runL0(worktreeSnapshot(root), loadConfig(root), baseline(root, state.event.base));
    save(root, L0_FILE, { findings } satisfies L0State);
    return findings;
}

export function stepScope(root: string): ContextScope {
    const state = initState(root);
    const { base } = state.event;
    const changes = changedFiles(root, base, state.head);
    const snapshot = worktreeSnapshot(root);
    const scope = computeScope(snapshot, loadConfig(root), changes, base, state.head, state.config.refIndex);
    save(root, SCOPE_FILE, scope);
    setOutput("empty", scope.contexts.length === 0 ? "true" : "false");
    return scope;
}

function reviewExpected(state: InitState, scope: ContextScope | undefined): boolean {
    return !state.config.l0Only && (scope === undefined || scope.contexts.length > 0);
}

export async function stepReview(root: string): Promise<AiState | undefined> {
    const state = initState(root);
    const scope = load<ContextScope>(root, SCOPE_FILE) ?? stepScope(root);
    const apiKey = takeKey(root);
    if (!reviewExpected(state, scope)) {
        return undefined;
    }
    if (!apiKey) {
        throw new Error("no api key from init; run the init step first");
    }
    const run = await createPiRunner(root, state.config, apiKey);
    const diff = diffText(root, scope.base, scope.head);
    const result = await runReview(state.config, scope, { run, diff, patchFiles: (patch) => patchFiles(root, patch) });
    writeFileSync(stateFile(root, SESSION_FILE), sessionsToJsonl(result.transcripts), UTF8);
    const { findings, patches, usage, rejected } = result;
    const ai: AiState = { nonce: state.nonce, findings, patches, usage, rejected };
    save(root, AI_FILE, ai);
    return ai;
}

function safePatchBranch(root: string, head: string, report: ReviewReport): string | undefined {
    try {
        return pushPatchBranch(root, head, report.patches);
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
    const scope = load<ContextScope>(root, SCOPE_FILE);
    const stored = load<AiState>(root, AI_FILE);
    // Only AI output produced by this run's review step counts; anything else is ignored.
    const ai = stored?.nonce === state.nonce ? stored : undefined;
    const complete = scope !== undefined && (!reviewExpected(state, scope) || ai !== undefined);
    const report = buildReport({
        repo: state.config.repo,
        base: state.event.base,
        head: state.head,
        findings: [...l0.findings, ...(ai?.findings ?? [])],
        patches: ai?.patches ?? [],
        usage: ai?.usage ?? EMPTY_USAGE,
        durationMs: Date.now() - state.startedAt,
        stages: {
            base: state.event.reason,
            scope: scope ? `${scope.contexts.length} context file(s)` : "not run",
            ai: state.config.l0Only
                ? "L0 only: " + (state.config.reason ?? "disabled")
                : ai
                  ? `${ai.rejected} rejected`
                  : complete
                    ? "nothing in scope"
                    : "incomplete: review did not finish",
        },
    });
    writeReport(root, report);
    const target = githubTarget();
    const patchBranch = target ? safePatchBranch(root, state.head, report) : undefined;
    const endpoint = process.env[ENV.endpoint];
    const token = process.env[ENV.token];
    let overviewUrl: string | undefined;
    if (endpoint && token) {
        const sessionsPath = stateFile(root, SESSION_FILE);
        const ingest = await postRun(endpoint, token, {
            repo: state.config.repo,
            sha: state.head,
            baseSha: state.event.base,
            event: state.event.name,
            prNumber: state.event.prNumber,
            status: statusOf(report.counts, !scope?.contexts.length, complete),
            complete,
            l0Only: state.config.l0Only,
            durationMs: report.durationMs,
            usage: report.usage,
            counts: report.counts,
            findings: report.findings,
            patches: report.patches,
            patchBranch,
            reportMarkdown: renderMarkdown(report),
            reportJson: JSON.stringify(report),
            sessionsJsonl: ai && existsSync(sessionsPath) ? readFileSync(sessionsPath, UTF8) : "",
        });
        overviewUrl = ingest.overviewUrl;
    }
    if (target && (report.findings.length || state.event.prNumber !== undefined)) {
        const patchUrl = patchBranch ? compareUrl(target, patchBranch) : undefined;
        await writeBack(target, state.head, renderComment(report, { patchUrl, overviewUrl }), state.event.prNumber);
    }
    return report.findings.filter(isBlocking).length;
}
