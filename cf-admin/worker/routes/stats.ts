// Token usage statistics for the console. The system only runs free models, so tokens, not dollars, are the
// headline: costUsd is still returned but is expected to stay 0. Aggregation is done by the store in SQL
// (D1Store.usage: SELECT ... GROUP BY); this module only validates the window and shapes the response.
import { requireAdmin } from "../auth.ts";
import { HttpError, json } from "../http.ts";
import type { Deps } from "../http.ts";
import type { UsageCounts, UsageGroup, UsageRange } from "../store/port.ts";

export const USAGE_GROUPS: readonly UsageGroup[] = ["day", "repo", "provider", "kind", "status"];
/** Window used when the caller gives no from: the last 30 days, today included. */
export const DEFAULT_DAYS = 30;
const TREND_DAYS = 7;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD of a UTC instant. */
function dayOf(at: Date): string {
    return at.toISOString().slice(0, 10);
}

/** The UTC date `days` after `day` (negative goes back). */
function shift(day: string, days: number): string {
    return dayOf(new Date(Date.parse(day + "T00:00:00.000Z") + days * DAY_MS));
}

function startOf(day: string): string {
    return day + "T00:00:00.000Z";
}

/** A present date must be a real calendar day; 2026-02-30 is a 400, never rolled over. */
function dateParam(params: URLSearchParams, name: string): string | undefined {
    const value = params.get(name);
    if (value === null || value === "") {
        return undefined;
    }
    if (!DATE.test(value) || dayOf(new Date(Date.parse(value + "T00:00:00.000Z") || 0)) !== value) {
        throw new HttpError(400, `${name} must be a date in YYYY-MM-DD form`);
    }
    return value;
}

function groupParam(params: URLSearchParams): UsageGroup {
    const value = params.get("group");
    if (value === null || value === "") {
        return "day";
    }
    const match = USAGE_GROUPS.find((group) => group === value);
    if (!match) {
        throw new HttpError(400, `group must be one of ${USAGE_GROUPS.join(", ")}`);
    }
    return match;
}

/** Inclusive dates from..to become the half-open instant window the store filters created_at with. */
function rangeOf(from: string, to: string): UsageRange {
    return { from: startOf(from), to: startOf(shift(to, 1)) };
}

/**
 * GET /api/stats/usage?from&to&group: totals over the window and one bucket per group value.
 * Dates are UTC days and both ends are inclusive. cachedTokens is reported for contract stability but the
 * runs table does not store cache tokens, so it is always 0 until a migration adds that column.
 */
async function usage(request: Request, deps: Deps): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const group = groupParam(params);
    const to = dateParam(params, "to") ?? dayOf(deps.now());
    const from = dateParam(params, "from") ?? shift(to, 1 - DEFAULT_DAYS);
    if (from > to) {
        throw new HttpError(400, "from must not be after to");
    }
    const { totals, buckets } = await deps.store.usage(rangeOf(from, to), group);
    return json({
        from,
        to,
        group,
        totals: { ...totals, cachedTokens: 0 },
        buckets,
    });
}

const ZERO: UsageCounts = {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    failedRuns: 0,
    incompleteRuns: 0,
    zeroTokenRuns: 0,
};

type Snapshot = UsageCounts & { totalTokens: number };

/** Plain counters plus their token sum; the repos count of a totals row is dropped here. */
function snapshot(counts: UsageCounts & { repos?: number }): Snapshot {
    return {
        runs: counts.runs,
        inputTokens: counts.inputTokens,
        outputTokens: counts.outputTokens,
        totalTokens: counts.inputTokens + counts.outputTokens,
        costUsd: counts.costUsd,
        failedRuns: counts.failedRuns,
        incompleteRuns: counts.incompleteRuns,
        zeroTokenRuns: counts.zeroTokenRuns,
    };
}

/** First day of the month `offset` months from the month of `at` (UTC). */
function monthStart(at: Date, offset: number): string {
    return dayOf(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1)));
}

/** Percentage change, one decimal; null when there is nothing to compare against. */
function change(current: number, previous: number): number | null {
    if (previous === 0) {
        return null;
    }
    return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * GET /api/stats/summary: everything the overview strip needs in one request. This month against the
 * previous one, failed and incomplete runs of this month, active repos, and the last seven UTC days.
 */
async function summary(deps: Deps): Promise<Response> {
    const now = deps.now();
    const current = monthStart(now, 0);
    const previous = monthStart(now, -1);
    const next = monthStart(now, 1);
    const today = dayOf(now);
    const first = shift(today, 1 - TREND_DAYS);
    const [thisMonth, lastMonth, week] = await Promise.all([
        deps.store.usage({ from: startOf(current), to: startOf(next) }, "kind"),
        deps.store.usage({ from: startOf(previous), to: startOf(current) }, "kind"),
        deps.store.usage(rangeOf(first, today), "day"),
    ]);
    const byDay = new Map(week.buckets.map((bucket) => [bucket.key, bucket]));
    const last7Days = Array.from({ length: TREND_DAYS }, (_, index) => {
        const day = shift(first, index);
        return { day, ...snapshot(byDay.get(day) ?? ZERO) };
    });
    const currentTotals = snapshot(thisMonth.totals);
    const previousTotals = snapshot(lastMonth.totals);
    return json({
        month: current.slice(0, 7),
        previousMonth: previous.slice(0, 7),
        current: currentTotals,
        previous: previousTotals,
        tokenChangePct: change(currentTotals.totalTokens, previousTotals.totalTokens),
        activeRepos: thisMonth.totals.repos,
        last7Days,
    });
}

/** /api/stats/{usage,summary}. Admin only, read only. Path segments after /api/stats/. */
export async function handleStats(request: Request, deps: Deps, parts: string[]): Promise<Response> {
    await requireAdmin(request, deps);
    if (parts.length === 1 && (parts[0] === "usage" || parts[0] === "summary")) {
        if (request.method !== "GET") {
            throw new HttpError(405, "method not allowed");
        }
        return parts[0] === "usage" ? usage(request, deps) : summary(deps);
    }
    throw new HttpError(404, "no such stats route");
}
