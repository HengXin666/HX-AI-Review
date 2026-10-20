import type { Severity } from "../contract/finding.ts";
import type { RepoConfig } from "../config.ts";
import type { Snapshot } from "../l0/snapshot.ts";

/** One repository exemption entry: a rule, a path, a reason and whether a change revives the rule. */
export type Exemption = {
    ruleId: string;
    path: string;
    reason: string;
    expiresOnChange: boolean;
};

/** A rule violation before it becomes a Finding; severity overrides the rule default when set. */
export type RuleIssue = {
    path: string;
    line: number;
    message: string;
    evidence?: string;
    anchor?: string;
    severity?: Severity;
    criteria?: string;
};

/** Read-only inputs a rule may inspect: tracked files, repo config, base revision and exemptions. */
export type RuleContext = {
    root: string;
    snapshot: Snapshot;
    config: RepoConfig;
    base: string;
    changed: string[];
    exemptions: Exemption[];
    readAtBase: (path: string) => string | undefined;
};

/** One registered rule: stable id, declared severity, description, criteria summary and check. */
export type Rule = {
    id: string;
    severity: Severity;
    description: string;
    criteria: string;
    check: (ctx: RuleContext) => RuleIssue[];
};
