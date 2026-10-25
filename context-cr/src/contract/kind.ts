// The CR kind: what this run reviews. Design and rationale: docs/decisions/2026-10-25-dual-cr-kind.md.
// Both kinds share one pipeline (init -> L0 -> scope -> finder -> verifier -> publish); only the scope,
// the prompts, the rule namespace and the product differ.

/** What a run reviews. "context" checks AI context files against the code; "code" reviews the diff itself. */
export type CrKind = "context" | "code";

export const CONTEXT_KIND: CrKind = "context";
export const CODE_KIND: CrKind = "code";
export const CR_KINDS: readonly CrKind[] = [CONTEXT_KIND, CODE_KIND];

/**
 * Parse a kind that came from the network or the environment. An absent value is the caller's fallback
 * (the contract default is "context"); an unknown value is refused rather than silently defaulted, because
 * running the wrong kind reviews the wrong thing and still reports a status the overview trusts.
 */
export function parseKind(value: unknown, fallback: CrKind = CONTEXT_KIND): CrKind {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const found = CR_KINDS.find((item) => item === value);
    if (!found) {
        throw new Error(`kind must be one of ${CR_KINDS.join(", ")}: ${String(value)}`);
    }
    return found;
}
