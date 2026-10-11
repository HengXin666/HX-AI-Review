import { RULE, ERROR } from "../constants.ts";
import { makeFinding } from "../contract/finding.ts";
import type { Finding } from "../contract/finding.ts";
import type { RepoConfig } from "../config.ts";
import { checkBudget, checkContext } from "./context.ts";
import { checkDocNames, checkSkills } from "./naming.ts";
import { checkDeadRefs, checkOrphans, contextRefs } from "./refs.ts";
import type { Snapshot } from "./snapshot.ts";

export type Approved = { ruleId: string; path: string; fingerprint: string };

type Check = { id: string; run: () => Finding[] };

/**
 * Run every deterministic rule without short-circuiting; a crashing rule becomes a tool-error
 * Error instead of an empty pass. Findings listed in the trusted baseline become historical.
 */
export function runL0(snapshot: Snapshot, config: RepoConfig, baseline: Approved[] = []): Finding[] {
    const refs = contextRefs(snapshot, config);
    const checks: Check[] = [
        { id: RULE.context, run: () => checkContext(snapshot, config) },
        { id: RULE.budget, run: () => checkBudget(snapshot, config) },
        { id: RULE.docname, run: () => checkDocNames(snapshot, config) },
        { id: RULE.deadref, run: () => checkDeadRefs(snapshot, config, refs) },
        { id: RULE.skill, run: () => checkSkills(snapshot, config) },
        { id: RULE.orphan, run: () => checkOrphans(snapshot, config, refs) },
    ];
    const findings: Finding[] = [];
    for (const check of checks) {
        try {
            findings.push(...check.run());
        } catch (error) {
            const message = `${check.id} crashed: ${error instanceof Error ? error.message : String(error)}`;
            findings.push(makeFinding(RULE.tool, ERROR, ".", 1, message, check.id));
        }
    }
    const approved = new Set(baseline.map((item) => item.ruleId + "\0" + item.path + "\0" + item.fingerprint));
    return findings.map((item) =>
        approved.has(item.ruleId + "\0" + item.path + "\0" + item.fingerprint)
            ? { ...item, origin: "historical" }
            : item,
    );
}
