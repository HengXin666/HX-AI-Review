import { loadConfig } from "../config.ts";
import { ERROR, RULE } from "../constants.ts";
import { makeFinding } from "../contract/finding.ts";
import { changedFiles, headSha, showFile, tryGit } from "../git.ts";
import { worktreeSnapshot } from "../l0/snapshot.ts";
import { loadExemptionsText } from "./exemptions.ts";
import { rules } from "./index.ts";
import { runRules } from "./registry.ts";
import { buildRulesReport, writeRulesReport } from "./report.ts";
import type { RulesPaths, RulesReport } from "./report.ts";
import type { RuleContext } from "./types.ts";

export type RulesRun = { report: RulesReport; paths: RulesPaths };

function baseRevision(root: string, baseRef?: string): string {
    if (baseRef) {
        const sha = tryGit(root, ["rev-parse", baseRef]);
        if (!sha) {
            throw new Error(`base ref ${baseRef} does not resolve`);
        }
        return sha.trim();
    }
    const found = tryGit(root, ["merge-base", "HEAD", "origin/main"]) ?? tryGit(root, ["rev-parse", "HEAD~1"]);
    return (found ?? "").trim();
}

/** Run the rule set on the worktree, diff dependency manifests against the base and write artifacts. */
export function runRulesStep(root: string, baseRef?: string): RulesRun {
    const started = Date.now();
    const head = headSha(root);
    const base = baseRevision(root, baseRef);
    const snapshot = worktreeSnapshot(root);
    const changed = base ? changedFiles(root, base, head).map((item) => item.path) : [];
    const ctx: RuleContext = {
        root,
        snapshot,
        config: loadConfig(root),
        base,
        baseKnown: base !== "",
        changed,
        exemptions: base ? loadExemptionsText(showFile(root, base, ".hx-rules-exemptions.json") ?? '{"exemptions":[]}') : [],
        readAtBase: (path) => (base ? showFile(root, base, path) : undefined),
    };
    const findings = runRules(ctx, rules());
    if (!base) {
        findings.push(
            makeFinding(
                RULE.tool,
                ERROR,
                ".",
                1,
                "Unable to determine the base revision; exemptions and dependency changes cannot be verified",
                "base revision",
                "base-revision-unknown",
            ),
        );
    }
    const report = buildRulesReport({ base, head, rules: rules(), findings, durationMs: Date.now() - started });
    return { report, paths: writeRulesReport(root, report) };
}
