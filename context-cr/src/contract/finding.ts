// Report contract shared with hx-agent-code: same Finding fields, same Error/Warning semantics.
import { createHash } from "node:crypto";

export type Severity = "error" | "warning";
export type Origin = "new" | "historical";
export type ExemptionState = "exempt" | "expired";

/**
 * Code-review rank. This is not Finding.severity: severity stays `warning` so a code finding
 * never blocks the job. The rank is what the comment budget sorts on.
 */
export const CODE_GRADES = ["critical", "major", "minor", "nit"] as const;
export type CodeGrade = (typeof CODE_GRADES)[number];

/** What a code finding is about. `other` is the fallback when the model does not name a category. */
export const CODE_CATEGORIES = ["intent", "breaking", "stability", "security", "other"] as const;
export type CodeCategory = (typeof CODE_CATEGORIES)[number];

/** Repository exemption that matched a finding, with the state it had for this run. */
export type ExemptionRef = {
    path: string;
    reason: string;
    expiresOnChange: boolean;
    state: ExemptionState;
};

export type FindingMeta = { criteria?: string; exemption?: ExemptionRef | null };

export type Finding = {
    ruleId: string;
    severity: Severity;
    path: string;
    line: number;
    message: string;
    evidence: string;
    fingerprint: string;
    origin: Origin;
    /** One-line criteria summary of the rule that produced this finding. */
    criteria?: string;
    /** Matching exemption entry, null when no exemption applies. */
    exemption?: ExemptionRef | null;
    /**
     * Code CR only. Rank inside Warning. Absent on L0 and context findings.
     * A missing grade is treated as a nit by the comment budget.
     */
    grade?: CodeGrade;
    /** Code CR only: intent, breaking, stability, security, or other. */
    category?: CodeCategory;
    /** Code CR only: 0 to 1, how sure the finder was. */
    confidence?: number;
    /** Code CR only: the input, state, or reasoning that makes the defect happen. */
    repro?: string;
    /** Code CR only: left is an old-side deleted line, right is a new-side line. */
    side?: "left" | "right";
};

/** A unified diff proposed by the AI stage, bound to the finding it fixes. */
export type Patch = { fingerprint: string; diff: string; applies: boolean };

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
    return {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        cost: a.cost + b.cost,
    };
}

/** Stable identity: rule + path + anchor + content, never the line number alone. */
export function fingerprint(ruleId: string, path: string, anchor: string, content: string): string {
    return createHash("sha256").update([ruleId, path, anchor, content].join("\0")).digest("hex").slice(0, 24);
}

export function makeFinding(
    ruleId: string,
    severity: Severity,
    path: string,
    line: number,
    message: string,
    evidence: string,
    anchor = message,
    meta: FindingMeta = {},
): Finding {
    return {
        ruleId,
        severity,
        path,
        line: Math.max(1, line),
        message,
        evidence,
        fingerprint: fingerprint(ruleId, path, anchor, evidence),
        origin: "new",
        criteria: meta.criteria ?? "",
        exemption: meta.exemption ?? null,
    };
}

export function sortFindings(findings: Finding[]): Finding[] {
    return [...findings].sort(
        (a, b) =>
            a.path.localeCompare(b.path) ||
            a.line - b.line ||
            a.ruleId.localeCompare(b.ruleId) ||
            a.fingerprint.localeCompare(b.fingerprint),
    );
}
