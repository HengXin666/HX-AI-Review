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
const STATUSES = new Set(["passed", "warned", "failed", "skipped", "incomplete"]);

type InFinding = Omit<FindingRow, "id" | "runId" | "repoId" | "patchKey" | "status"> & { origin: string };
type InPatch = { fingerprint: string; diff: string };

// Omitted fields take their default; a present field of the wrong type or range is a 400, never coerced.
function num(value: unknown, what: string): number {
    if (value === undefined) {
        return 0;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new HttpError(400, `${what} must be a non-negative number`);
    }
    return value;
}

// Only undefined is "omitted"; an explicit null is a present-but-invalid value and gets a 400.
function int(value: unknown, what: string, min: number): number | null {
    if (value === undefined) {
        return null;
    }
    if (!Number.isSafeInteger(value) || (value as number) < min) {
        throw new HttpError(400, `${what} must be an integer >= ${min}`);
    }
    return value as number;
}

function text(value: unknown, what: string): string | null {
    if (value === undefined) {
        return null;
    }
    if (typeof value !== "string") {
        throw new HttpError(400, `${what} must be a string`);
    }
    return value;
}

/** Token counts and durations are integers in D1 and in the contract, so fractions are a 400. */
function count(value: unknown, what: string): number {
    const parsed = num(value, what);
    if (!Number.isSafeInteger(parsed)) {
        throw new HttpError(400, `${what} must be an integer`);
    }
    return parsed;
}

function flag(value: unknown, what: string, fallback: boolean): boolean {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "boolean") {
        throw new HttpError(400, `${what} must be a boolean`);
    }
    return value;
}

function object(value: unknown, what: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(400, `${what} must be an object`);
    }
    return value as Record<string, unknown>;
}

/** Finding lines are required and 1-based; a missing or null line is a 400, never a default. */
function line(value: unknown): number {
    if (value === undefined || value === null) {
        throw new HttpError(400, "finding line is required");
    }
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new HttpError(400, "finding line must be an integer >= 1");
    }
    return value as number;
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
            // A missing line must fail: defaulting to 1 would file the finding against the wrong code.
            line: line(item.line),
            message: field(item, "message"),
            evidence: text(item.evidence, "finding evidence") ?? "",
            fingerprint: field(item, "fingerprint"),
            origin: originOf(item.origin),
        };
    });
}

function originOf(value: unknown): string {
    if (value === undefined || value === "new" || value === "historical") {
        return (value as string | undefined) ?? "new";
    }
    throw new HttpError(400, "finding origin must be new or historical");
}

function patches(value: unknown): InPatch[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new HttpError(400, "patches must be an array");
    }
    return value
        .map((raw) => {
            const item = object(raw, "each patch");
            const fingerprint = field(item, "fingerprint");
            const diff = field(item, "diff");
            if (typeof item.applies !== "boolean") {
                throw new HttpError(400, "patch applies must be a boolean");
            }
            // A patch that does not apply is dropped on purpose; an invalid one is never accepted.
            return { fingerprint, diff, applies: item.applies };
        })
        .filter((item) => item.applies)
        .map((item) => ({ fingerprint: item.fingerprint, diff: item.diff }));
}

/**
 * Status derives from facts: blocking Errors are failed, an unfinished run (complete false, or the runner
 * saying incomplete) is incomplete, otherwise warned or passed by the findings. The only label the runner
 * adds is skipped (nothing in scope), and only when there are no findings.
 */
function derive(body: Record<string, unknown>, list: InFinding[]) {
    const errors = list.filter((item) => item.severity === "error");
    const blocking = errors.filter((item) => item.origin === "new").length;
    const counts = { error: errors.length, warning: list.length - errors.length };
    if (body.status !== undefined && (typeof body.status !== "string" || !STATUSES.has(body.status))) {
        throw new HttpError(400, `status must be one of ${[...STATUSES].join(", ")}`);
    }
    const incomplete = !flag(body.complete, "complete", true) || body.status === "incomplete";
    const status = blocking
        ? "failed"
        : incomplete
          ? "incomplete"
          : list.length
            ? "warned"
            : body.status === "skipped"
              ? "skipped"
              : "passed";
    return { counts, status, incomplete };
}

/** Charge from token counts with the provider's prices, never less than what the runner reported. */
function costOf(usage: Record<string, unknown>, provider: ProviderRow | null): number {
    const reported = num(usage.cost, "usage.cost");
    if (!provider) {
        return reported;
    }
    const tokens =
        num(usage.input, "usage.input") * provider.priceInput +
        num(usage.output, "usage.output") * provider.priceOutput +
        num(usage.cacheRead, "usage.cacheRead") * provider.priceCacheRead +
        num(usage.cacheWrite, "usage.cacheWrite") * provider.priceCacheWrite;
    const computed = tokens / MILLION;
    return Math.max(reported, computed);
}

/**
 * POST /runs: findings, patches, duration and usage from one runner pass. The whole body is validated
 * before anything is written; then R2 blobs, D1 rows, spend, and (complete push runs only) last_sha.
 */
/**
 * POST /spend: the runner reports that it is about to open its first model session. The claim is marked
 * as having started, so if this run is then cancelled before POST /runs its allowance is settled rather
 * than treated as free. Without this a run cancelled during install or scope would look like it had spent
 * nothing, and every rapid push on one branch would be handed the whole remaining budget again.
 */
export async function handleSpend(request: Request, deps: Deps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const body = await readJson(request);
    const claim = text(body.budgetClaim, "budgetClaim");
    if (!claim) {
        throw new HttpError(400, "budgetClaim is required");
    }
    // Refusing a superseded claim is what makes this marker load-bearing: the run that took the claim
    // over will settle it, and letting the older run spend on top would charge the month twice.
    if (!(await deps.store.startSpend(repo.id, claim))) {
        throw new HttpError(409, "budget claim is no longer held by this run");
    }
    return json({ ok: true });
}

export async function handleRuns(request: Request, deps: Deps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const body = await readJson(request);
    if (field(body, "repo").toLowerCase() !== repo.name.toLowerCase()) {
        throw new HttpError(403, "token belongs to a different repository");
    }
    const sha = field(body, "sha");
    const list = findings(body.findings);
    // Validated before any write: a malformed claim must not fail after the run row already exists.
    const budgetClaim = text(body.budgetClaim, "budgetClaim") ?? "";
    const fixes = patches(body.patches);
    const usage = body.usage === undefined ? {} : object(body.usage, "usage");
    const { counts, status, incomplete } = derive(body, list);
    const prNumber = int(body.prNumber, "prNumber", 1);
    // Token counts are integers; usage.cost stays fractional because prices are per-million tokens.
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
        count(usage[key], "usage." + key);
    }
    num(usage.cost, "usage.cost");
    const costUsd = costOf(usage, await deps.store.provider(repo.provider));
    const blobs = {
        reportMarkdown: text(body.reportMarkdown, "reportMarkdown") ?? "",
        reportJson: text(body.reportJson, "reportJson") ?? "{}",
        sessionsJsonl: text(body.sessionsJsonl, "sessionsJsonl") ?? "",
    };

    const runId = deps.id();
    const prefix = `runs/${repo.name}/${runId}/`;
    const patchKeys = new Map<string, string>();
    const written: string[] = [];
    const put = async (key: string, text: string, type: string) => {
        written.push(key);
        await deps.blobs.put(key, text, type);
    };
    const now = deps.now();
    const run: RunRow = {
        id: runId,
        repoId: repo.id,
        sha,
        baseSha: text(body.baseSha, "baseSha") ?? "",
        event: text(body.event, "event") ?? "unknown",
        prNumber,
        status,
        l0Only: flag(body.l0Only, "l0Only", false),
        errors: counts.error,
        warnings: counts.warning,
        inputTokens: num(usage.input, "usage.input"),
        outputTokens: num(usage.output, "usage.output"),
        costUsd,
        durationMs: count(body.durationMs, "durationMs"),
        patchBranch: text(body.patchBranch, "patchBranch"),
        createdAt: now.toISOString(),
    };
    // Baseline-approved (historical) findings stay in the R2 report but never re-enter the pending queue.
    const rows = (): FindingRow[] =>
        list
            .filter((item) => item.origin === "new")
            .map(({ origin: _origin, ...item }, index) => ({
                ...item,
                id: `${runId}-${index}`,
                runId,
                repoId: repo.id,
                patchKey: patchKeys.get(item.fingerprint) ?? null,
                status: "open",
            }));
    let resolved = 0;
    try {
        for (const patch of fixes) {
            const key = `${prefix}patches/${patch.fingerprint}.diff`;
            await put(key, patch.diff, DIFF);
            patchKeys.set(patch.fingerprint, key);
        }
        await put(prefix + "report.md", blobs.reportMarkdown, MD);
        await put(prefix + "report.json", blobs.reportJson, JSON_TYPE);
        if (blobs.sessionsJsonl) {
            await put(prefix + "sessions.jsonl", blobs.sessionsJsonl, NDJSON);
        }
        await deps.store.insertRun(run, rows());
        resolved =
            prNumber === null
                ? 0
                : await deps.store.resolveRound({
                      repoId: repo.id,
                      prNumber,
                      runId,
                      seen: rows().map((item) => item.fingerprint),
                      aiRechecked: !run.l0Only && !incomplete,
                  });
    } catch (error) {
        // Compensate: a failed write must not leave R2 objects that no D1 run points to.
        await deps.blobs.delete(written).catch(() => undefined);
        throw error;
    }
    // The claim id from /init: charge records spend always, but frees only this run's own claim, so a
    // run that was refused the budget and published L0 results cannot release the holder's claim.
    await deps.store.charge(repo.id, costUsd, month(now), budgetClaim);
    // last_sha tracks the pushed history only, and only once the AI stage really finished for this range.
    if (run.event === "push" && prNumber === null && !incomplete) {
        await deps.store.setLastSha(repo.id, sha);
    }
    const overviewUrl = deps.overviewUrl ? `${deps.overviewUrl.replace(/\/$/, "")}/#/runs/${runId}` : undefined;
    return json({ runId, overviewUrl, resolved }, 201);
}
