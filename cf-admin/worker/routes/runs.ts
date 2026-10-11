import { repoFromToken } from "../auth.ts";
import { HttpError, field, json, month, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import type { FindingRow, ProviderRow, RunRow } from "../store/port.ts";

const MD = "text/markdown; charset=utf-8";
const JSON_TYPE = "application/json";
const NDJSON = "application/x-ndjson";
const DIFF = "text/x-diff";
const MAX_FINDINGS = 500;
const MILLION = 1_000_000;
const STATUSES = new Set(["passed", "warned", "failed", "skipped"]);

type InFinding = Omit<FindingRow, "id" | "runId" | "repoId" | "patchKey" | "status"> & { origin: string };
type InPatch = { fingerprint: string; diff: string };

function num(value: unknown): number {
    const result = typeof value === "number" ? value : 0;
    return Number.isFinite(result) && result >= 0 ? result : 0;
}

function object(value: unknown, what: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(400, `${what} must be an object`);
    }
    return value as Record<string, unknown>;
}

function findings(value: unknown): InFinding[] {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
        throw new HttpError(400, `findings must be an array of at most ${MAX_FINDINGS}`);
    }
    return value.map((raw) => {
        const item = object(raw, "each finding");
        if (item.severity !== "error" && item.severity !== "warning") {
            throw new HttpError(400, "finding severity must be error or warning");
        }
        return {
            ruleId: field(item, "ruleId"),
            severity: item.severity,
            path: field(item, "path"),
            line: Math.max(1, Math.trunc(num(item.line))),
            message: field(item, "message"),
            evidence: String(item.evidence ?? ""),
            fingerprint: field(item, "fingerprint"),
            origin: item.origin === "historical" ? "historical" : "new",
        };
    });
}

function patches(value: unknown): InPatch[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new HttpError(400, "patches must be an array");
    }
    return value
        .map((raw) => object(raw, "each patch"))
        .filter((item) => item.applies === true && typeof item.diff === "string")
        .map((item) => ({ fingerprint: field(item, "fingerprint"), diff: String(item.diff) }));
}

/** Status and counts derive from the findings when the runner omits them (API contract allows it). */
function derive(body: Record<string, unknown>, list: InFinding[]) {
    const errors = list.filter((item) => item.severity === "error");
    const blocking = errors.filter((item) => item.origin === "new").length;
    const counts = { error: errors.length, warning: list.length - errors.length };
    const fallback = blocking ? "failed" : list.length ? "warned" : "passed";
    const status = typeof body.status === "string" && STATUSES.has(body.status) ? body.status : fallback;
    return { counts, status };
}

/** Charge from token counts with the provider's prices, never less than what the runner reported. */
function costOf(usage: Record<string, unknown>, provider: ProviderRow | null): number {
    const reported = num(usage.cost);
    if (!provider) {
        return reported;
    }
    const computed = (num(usage.input) * provider.priceInput + num(usage.output) * provider.priceOutput) / MILLION;
    return Math.max(reported, computed);
}

/**
 * POST /runs: findings, patches, duration and usage from one runner pass. The whole body is validated
 * before anything is written; then R2 blobs, D1 rows, spend, and (complete push runs only) last_sha.
 */
export async function handleRuns(request: Request, deps: Deps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const body = await readJson(request);
    if (field(body, "repo").toLowerCase() !== repo.name.toLowerCase()) {
        throw new HttpError(403, "token belongs to a different repository");
    }
    const sha = field(body, "sha");
    const list = findings(body.findings);
    const fixes = patches(body.patches);
    const usage = body.usage === undefined ? {} : object(body.usage, "usage");
    const { counts, status } = derive(body, list);
    const prNumber = typeof body.prNumber === "number" ? body.prNumber : null;
    const costUsd = costOf(usage, await deps.store.provider(repo.provider));

    const runId = deps.id();
    const prefix = `runs/${repo.name}/${runId}/`;
    const patchKeys = new Map<string, string>();
    for (const patch of fixes) {
        const key = `${prefix}patches/${patch.fingerprint}.diff`;
        await deps.blobs.put(key, patch.diff, DIFF);
        patchKeys.set(patch.fingerprint, key);
    }
    await deps.blobs.put(prefix + "report.md", String(body.reportMarkdown ?? ""), MD);
    await deps.blobs.put(prefix + "report.json", String(body.reportJson ?? "{}"), JSON_TYPE);
    if (typeof body.sessionsJsonl === "string" && body.sessionsJsonl) {
        await deps.blobs.put(prefix + "sessions.jsonl", body.sessionsJsonl, NDJSON);
    }
    const now = deps.now();
    const run: RunRow = {
        id: runId,
        repoId: repo.id,
        sha,
        baseSha: String(body.baseSha ?? ""),
        event: String(body.event ?? "unknown"),
        prNumber,
        status,
        l0Only: body.l0Only === true,
        errors: counts.error,
        warnings: counts.warning,
        inputTokens: num(usage.input),
        outputTokens: num(usage.output),
        costUsd,
        durationMs: num(body.durationMs),
        patchBranch: typeof body.patchBranch === "string" ? body.patchBranch : null,
        createdAt: now.toISOString(),
    };
    // Baseline-approved (historical) findings stay in the R2 report but never re-enter the pending queue.
    const rows: FindingRow[] = list
        .filter((item) => item.origin === "new")
        .map(({ origin: _origin, ...item }, index) => ({
            ...item,
            id: `${runId}-${index}`,
            runId,
            repoId: repo.id,
            patchKey: patchKeys.get(item.fingerprint) ?? null,
            status: "open",
        }));
    await deps.store.insertRun(run, rows);
    await deps.store.charge(repo.id, costUsd, month(now));
    // last_sha tracks the pushed history only, and only once the AI stage really finished for this range.
    if (prNumber === null && body.complete !== false) {
        await deps.store.setLastSha(repo.id, sha);
    }
    const overviewUrl = deps.overviewUrl ? `${deps.overviewUrl.replace(/\/$/, "")}/#/runs/${runId}` : undefined;
    return json({ runId, overviewUrl }, 201);
}
