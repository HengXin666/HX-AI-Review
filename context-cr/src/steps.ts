import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { AI_FILE, ENV, INIT_FILE, L0_FILE, SCOPE_FILE, SESSION_FILE, STATE_DIR, UTF8 } from "./constants.ts";
import { EMPTY_USAGE } from "./contract/finding.ts";
import type { Finding, Patch, Usage } from "./contract/finding.ts";
import { buildReport, isBlocking, renderMarkdown, writeReport } from "./contract/report.ts";
import { applyCheck, changedFiles, diffText, headSha, showFile } from "./git.ts";
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

type InitState = { config: InitConfig; startedAt: number; head: string; event: EventInfo };
type L0State = { findings: Finding[] };
type AiState = { findings: Finding[]; patches: Patch[]; usage: Usage; rejected: number };

function stateFile(root: string, name: string): string {
    mkdirSync(join(root, STATE_DIR), { recursive: true });
    return join(root, STATE_DIR, name);
}

function save(root: string, name: string, value: unknown): void {
    writeFileSync(stateFile(root, name), JSON.stringify(value, null, 4) + "\n", UTF8);
}

function load<T>(root: string, name: string): T | undefined {
    const file = join(root, STATE_DIR, name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, UTF8)) as T) : undefined;
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`environment variable ${name} is required`);
    }
    return value;
}

/** GitHub Actions key=value outputs; a no-op outside Actions. */
export function setOutput(name: string, value: string): void {
    const file = process.env[ENV.githubOutput];
    if (file) {
        appendFileSync(file, `${name}=${value}\n`);
    }
}

export async function stepInit(root: string): Promise<InitState> {
    const repo = required(ENV.githubRepository);
    const response = await fetchInit(required(ENV.endpoint), required(ENV.token), repo);
    const { config, apiKey } = splitSecret(response);
    if (apiKey) {
        // Mask before anything else can print it, then hand it to later steps only via the env file.
        process.stdout.write(`::add-mask::${apiKey}\n`);
        const envFile = process.env[ENV.githubEnv];
        if (envFile) {
            appendFileSync(envFile, `${ENV.apiKey}<<HX_CTX_EOF\n${apiKey}\nHX_CTX_EOF\n`);
        }
        process.env[ENV.apiKey] = apiKey;
    }
    const head = headSha(root);
    const state: InitState = { config, startedAt: Date.now(), head, event: resolveBase(root, head, config.lastSha) };
    save(root, INIT_FILE, state);
    setOutput("l0_only", String(config.l0Only));
    return state;
}

function initState(root: string): InitState {
    const existing = load<InitState>(root, INIT_FILE);
    if (existing) {
        return existing;
    }
    const head = headSha(root);
    const config: InitConfig = {
        repo: process.env[ENV.githubRepository] ?? "local",
        enabled: true,
        l0Only: true,
        api: "openai-completions",
        models: { finder: "", verifier: "" },
        limits: { contextWindow: 0, maxTokens: 0, maxCandidates: 0 },
        suppressions: [],
    };
    return { config, startedAt: Date.now(), head, event: resolveBase(root, head) };
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
    const scope = computeScope(
        worktreeSnapshot(root),
        loadConfig(root),
        changes,
        base,
        state.head,
        state.config.refIndex,
    );
    save(root, SCOPE_FILE, scope);
    setOutput("empty", String(scope.contexts.length === 0));
    return scope;
}

export async function stepReview(root: string): Promise<AiState> {
    const state = initState(root);
    const scope = load<ContextScope>(root, SCOPE_FILE) ?? stepScope(root);
    if (state.config.l0Only || scope.contexts.length === 0) {
        const skipped: AiState = { findings: [], patches: [], usage: EMPTY_USAGE, rejected: 0 };
        save(root, AI_FILE, skipped);
        return skipped;
    }
    const run = await createPiRunner(root, state.config, required(ENV.apiKey));
    const diff = diffText(root, scope.base, scope.head);
    const result = await runReview(state.config, scope, {
        run,
        diff,
        patchApplies: (patch) => applyCheck(root, patch),
    });
    writeFileSync(stateFile(root, SESSION_FILE), sessionsToJsonl(result.transcripts), UTF8);
    const ai: AiState = {
        findings: result.findings,
        patches: result.patches,
        usage: result.usage,
        rejected: result.rejected,
    };
    save(root, AI_FILE, ai);
    return ai;
}

/** Aggregate, write MD/JSON, ingest to CF, push the patch branch, comment. Returns blocking count. */
export async function stepPublish(root: string): Promise<number> {
    const state = initState(root);
    const l0 = load<L0State>(root, L0_FILE) ?? { findings: stepL0(root) };
    const scope = load<ContextScope>(root, SCOPE_FILE);
    const ai = load<AiState>(root, AI_FILE) ?? { findings: [], patches: [], usage: EMPTY_USAGE, rejected: 0 };
    const report = buildReport({
        repo: state.config.repo,
        base: state.event.base,
        head: state.head,
        findings: [...l0.findings, ...ai.findings],
        patches: ai.patches,
        usage: ai.usage,
        durationMs: Date.now() - state.startedAt,
        stages: {
            base: state.event.reason,
            scope: scope ? `${scope.contexts.length} context file(s)` : "not run",
            ai: state.config.l0Only ? "L0 only: " + (state.config.reason ?? "disabled") : `${ai.rejected} rejected`,
        },
    });
    writeReport(root, report);
    const target = githubTarget();
    const patchBranch = target ? pushPatchBranch(root, state.head, report.patches) : undefined;
    const endpoint = process.env[ENV.endpoint];
    const token = process.env[ENV.token];
    let overviewUrl: string | undefined;
    if (endpoint && token) {
        const sessionsPath = join(root, STATE_DIR, SESSION_FILE);
        const ingest = await postRun(endpoint, token, {
            repo: state.config.repo,
            sha: state.head,
            baseSha: state.event.base,
            event: state.event.name,
            prNumber: state.event.prNumber,
            status: statusOf(report.counts, !scope?.contexts.length),
            l0Only: state.config.l0Only,
            durationMs: report.durationMs,
            usage: report.usage,
            counts: report.counts,
            findings: report.findings,
            patches: report.patches,
            patchBranch,
            reportMarkdown: renderMarkdown(report),
            reportJson: JSON.stringify(report),
            sessionsJsonl: existsSync(sessionsPath) ? readFileSync(sessionsPath, UTF8) : "",
        });
        overviewUrl = ingest.overviewUrl;
    }
    if (target && (report.findings.length || state.event.prNumber !== undefined)) {
        const patchUrl = patchBranch ? compareUrl(target, patchBranch) : undefined;
        const body = renderComment(report, { patchUrl, overviewUrl });
        await writeBack(target, state.head, body, state.event.prNumber);
    }
    return report.findings.filter(isBlocking).length;
}
