// Per-PR comment budget for code CR. Severity here is the grade (critical..nit),
// not Finding.severity, which stays Warning so a code finding never fails the job.
// Design: docs/architecture/agent-review.md.
import { CODE_COMMENT_BUDGET } from "../constants.ts";
import type { CodeGrade } from "../contract/finding.ts";

/** A lone nit is published only at or above this confidence. Lower nits are noise. */
export const NIT_KEEP_CONFIDENCE = 0.8;

const RANK: Record<CodeGrade, number> = { critical: 4, major: 3, minor: 2, nit: 1 };

export type Ranked = { key: string; grade: CodeGrade; confidence: number };

/**
 * Which confirmed findings earn a line comment. Higher grades fill the budget first.
 * Nits are not published when any higher finding is kept. When nothing higher exists,
 * the single most confident nit is kept if it clears NIT_KEEP_CONFIDENCE.
 * The sort is total, so the same inputs always keep the same keys.
 */
export function publishKeys(items: Ranked[], budget = CODE_COMMENT_BUDGET): Set<string> {
    const sorted = [...items].sort(
        (a, b) => RANK[b.grade] - RANK[a.grade] || b.confidence - a.confidence || a.key.localeCompare(b.key),
    );
    const higher = sorted.filter((item) => item.grade !== "nit");
    const nits = sorted.filter((item) => item.grade === "nit");
    const keep: string[] = [];
    for (const item of higher) {
        if (keep.length >= budget) {
            break;
        }
        keep.push(item.key);
    }
    if (keep.length === 0 && budget > 0 && nits[0] && nits[0].confidence >= NIT_KEEP_CONFIDENCE) {
        keep.push(nits[0].key);
    }
    return new Set(keep);
}
