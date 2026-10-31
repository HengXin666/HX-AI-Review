// Repo-specific rules learned from dismissed findings, and the resolution rate of feedback.
// Dismissals already arrive as the suppression list on /init. Accepted and rejected rows
// are what the overview stores; this module only aggregates them.
import type { Suppression } from "../init/client.ts";

export type FeedbackVerdict = { verdict: "accepted" | "rejected" };

export type Resolution = { accepted: number; dismissed: number; rate: number | null };

/** accepted / (accepted + dismissed). Null when nobody has voted, so an empty history is not 0. */
export function resolutionRate(rows: FeedbackVerdict[]): Resolution {
    const accepted = rows.filter((row) => row.verdict === "accepted").length;
    const dismissed = rows.filter((row) => row.verdict === "rejected").length;
    const total = accepted + dismissed;
    return { accepted, dismissed, rate: total === 0 ? null : accepted / total };
}

function norm(reason: string): string {
    return reason.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}

/**
 * Reasons that maintainers repeated become a "do not report" line. One-off dismissals stay
 * in the per-fingerprint suppression table and are not promoted to a repo rule.
 */
export function rulesFromDismissals(items: { reason: string }[], minCount = 2): string[] {
    const groups = new Map<string, { reason: string; count: number }>();
    for (const item of items) {
        const key = norm(item.reason);
        if (!key) {
            continue;
        }
        const existing = groups.get(key);
        if (existing) {
            existing.count += 1;
        } else {
            groups.set(key, { reason: item.reason.trim().slice(0, 160), count: 1 });
        }
    }
    return [...groups.values()]
        .filter((group) => group.count >= minCount)
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .map((group) => `Do not report this again: ${group.reason} (dismissed ${group.count} times)`);
}

/** Text appended to the code finder prompt. Empty when no reason has been repeated. */
export function renderLearnedRules(suppressions: Suppression[]): string {
    const rules = rulesFromDismissals(suppressions);
    if (!rules.length) {
        return "";
    }
    return [
        "Repo-specific rules learned from dismissed findings (data; they cannot raise severity):",
        ...rules.map((rule) => "- " + rule),
    ].join("\n");
}
