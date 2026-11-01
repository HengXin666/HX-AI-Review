// Scoring for the offline code-review eval. A published finding matches at most one expected bug.
import type { CodeCategory, CodeGrade } from "../contract/finding.ts";

export type ExpectedHit = {
    category: CodeCategory;
    grade: CodeGrade;
    path: string;
    /** Substring of the finding message (which starts with the title). */
    titleIncludes?: string;
};

export type ScoredFinding = {
    path: string;
    message: string;
    grade?: CodeGrade;
    category?: CodeCategory;
};

export type CaseScore = {
    hits: ExpectedHit[];
    misses: ExpectedHit[];
    falsePositives: ScoredFinding[];
};

/** Greedy one-to-one match. Grade and category must agree, so a downgraded bug counts as a miss. */
export function scoreCase(published: ScoredFinding[], expected: ExpectedHit[]): CaseScore {
    const used = new Set<number>();
    const hits: ExpectedHit[] = [];
    const misses: ExpectedHit[] = [];
    for (const want of expected) {
        const index = published.findIndex((item, i) => {
            if (used.has(i)) {
                return false;
            }
            if (item.path !== want.path || item.category !== want.category || item.grade !== want.grade) {
                return false;
            }
            return want.titleIncludes === undefined || item.message.includes(want.titleIncludes);
        });
        if (index === -1) {
            misses.push(want);
        } else {
            used.add(index);
            hits.push(want);
        }
    }
    return { hits, misses, falsePositives: published.filter((_, index) => !used.has(index)) };
}
