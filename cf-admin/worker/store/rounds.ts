// Which earlier findings on the same pull request a new run may mark resolved.
import type { FindingRow, RoundInput } from "./port.ts";

export const AI_RULE = "CX-AI";

/**
 * A finding stays open when this run did not re-check it: same fingerprint still reported, a different
 * pull request, or an AI finding on a run whose model stage did not finish. L0 is always re-checked.
 */
export function isStale(finding: FindingRow, prNumber: number | null, input: RoundInput): boolean {
    if (finding.status !== "open" || finding.repoId !== input.repoId) {
        return false;
    }
    if (finding.runId === input.runId || prNumber !== input.prNumber) {
        return false;
    }
    if (input.seen.includes(finding.fingerprint)) {
        return false;
    }
    return input.aiRechecked || finding.ruleId !== AI_RULE;
}
