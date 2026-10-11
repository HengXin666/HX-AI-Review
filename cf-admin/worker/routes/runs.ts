import { repoFromToken } from "../auth.ts";
import { HttpError, field, json, month, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import type { FindingRow, RunRow } from "../store/port.ts";

const MD = "text/markdown; charset=utf-8";
const JSON_TYPE = "application/json";
const NDJSON = "application/x-ndjson";
const DIFF = "text/x-diff";
const MAX_FINDINGS = 500;

type InFinding = {
    ruleId: string;
    severity: string;
    path: string;
    line: number;
    message: string;
    evidence: string;
    fingerprint: string;
};
type InPatch = { fingerprint: string; diff: string; applies: boolean };

function num(value: unknown): number {
    const result = Number(value ?? 0);
    return Number.isFinite(result) && result >= 0 ? result : 0;
}

function findings(value: unknown): InFinding[] {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
        throw new HttpError(400, `findings must be an array of at most ${MAX_FINDINGS}`);
    }
    return value.map((raw) => {
        const item = raw as Record<string, unknown>;
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
        };
    });
}

/**
 * POST /runs: findings, patches, duration and usage from one runner pass. Rows go to D1, the
 * MD/JSON report, pi session JSONL and patch files go to R2; last_sha and spend advance last.
 */
export async function handleRuns(request: Request, deps: Deps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const body = await readJson(request);
    if (field(body, "repo").toLowerCase() !== repo.name.toLowerCase()) {
        throw new HttpError(403, "token belongs to a different repository");
    }
    const sha = field(body, "sha");
    const runId = deps.id();
    const prefix = `runs/${repo.name}/${runId}/`;
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const counts = (body.counts ?? {}) as Record<string, unknown>;
    const patches = (Array.isArray(body.patches) ? body.patches : []) as InPatch[];
    const patchKeys = new Map<string, string>();
    for (const patch of patches) {
        if (patch.applies && typeof patch.diff === "string" && typeof patch.fingerprint === "string") {
            const key = `${prefix}patches/${patch.fingerprint}.diff`;
            await deps.blobs.put(key, patch.diff, DIFF);
            patchKeys.set(patch.fingerprint, key);
        }
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
        prNumber: typeof body.prNumber === "number" ? body.prNumber : null,
        status: String(body.status ?? "passed"),
        l0Only: body.l0Only === true,
        errors: num(counts.error),
        warnings: num(counts.warning),
        inputTokens: num(usage.input),
        outputTokens: num(usage.output),
        costUsd: num(usage.cost),
        durationMs: num(body.durationMs),
        patchBranch: typeof body.patchBranch === "string" ? body.patchBranch : null,
        createdAt: now.toISOString(),
    };
    const rows: FindingRow[] = findings(body.findings).map((item, index) => ({
        ...item,
        id: `${runId}-${index}`,
        runId,
        repoId: repo.id,
        patchKey: patchKeys.get(item.fingerprint) ?? null,
        status: "open",
    }));
    await deps.store.insertRun(run, rows);
    // A pull request run never advances last_sha: that cursor tracks the pushed branch history.
    if (run.prNumber === null) {
        await deps.store.advance(repo.id, sha, run.costUsd, month(now));
    }
    const overviewUrl = deps.overviewUrl ? `${deps.overviewUrl.replace(/\/$/, "")}/#/runs/${runId}` : undefined;
    return json({ runId, overviewUrl }, 201);
}
