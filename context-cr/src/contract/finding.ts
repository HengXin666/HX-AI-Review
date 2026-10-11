// Report contract shared with hx-agent-code: same Finding fields, same Error/Warning semantics.
import { createHash } from "node:crypto";

export type Severity = "error" | "warning";
export type Origin = "new" | "historical";

export type Finding = {
    ruleId: string;
    severity: Severity;
    path: string;
    line: number;
    message: string;
    evidence: string;
    fingerprint: string;
    origin: Origin;
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
