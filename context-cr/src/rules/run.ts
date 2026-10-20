import { ERROR, RULE, WARNING } from "../constants.ts";
import { loadConfig } from "../config.ts";
import { makeFinding } from "../contract/finding.ts";
import type { Finding } from "../contract/finding.ts";
import { changedFiles, headSha, showFile, tryGit } from "../git.ts";
import { worktreeSnapshot } from "../l0/snapshot.ts";
import { EXEMPTION_FILE } from "./constants.ts";
import { loadExemptions, parseExemptions } from "./exemptions.ts";
import { rules } from "./index.ts";
import { runRules } from "./registry.ts";
import { buildRulesReport, writeRulesReport } from "./report.ts";
import type { RulesPaths, RulesReport } from "./report.ts";
import type { Exemption, RuleContext } from "./types.ts";

export type RulesRun = { report: RulesReport; paths: RulesPaths };

type BaseRevision = { sha: string; known: boolean };

function baseRevision(root: string, baseRef?: string): BaseRevision {
    if (baseRef) {
        const sha = tryGit(root, ["rev-parse", baseRef]);
        if (!sha) {
            throw new Error(`base ref ${baseRef} does not resolve`);
        }
        return { sha: sha.trim(), known: true };
    }
    const found = tryGit(root, ["merge-base", "HEAD", "origin/main"]) ?? tryGit(root, ["rev-parse", "HEAD~1"]);
    const sha = (found ?? "").trim();
    return { sha, known: sha !== "" };
}

function baseExemptions(text: string | undefined): Exemption[] {
    return text === undefined ? [] : parseExemptions(text);
}

/** Findings outside the rule set: unknown base and an exemption file edited by the reviewed change. */
function runFindings(base: BaseRevision, baseText: string | undefined, localText: string | undefined): Finding[] {
    const findings: Finding[] = [];
    if (!base.known) {
        findings.push(
            makeFinding(
                RULE.tool,
                ERROR,
                ".",
                1,
                "Base revision cannot be resolved, so changes and exemption expiry are unknown",
                "no merge-base or parent commit",
                "base-unknown",
            ),
        );
    }
    if (base.known && localText !== undefined && localText !== baseText) {
        findings.push(
            makeFinding(
                RULE.exemption,
                WARNING,
                EXEMPTION_FILE,
                1,
                "Exemption file changed in this commit, every entry change needs a human decision",
                "exemption file differs from base",
                "exemptions-changed",
            ),
        );
    }
    return findings;
}

/** Run the rule set on the worktree, diff dependency manifests against the base and write artifacts. */
export function runRulesStep(root: string, baseRef?: string): RulesRun {
    const started = Date.now();
    const head = headSha(root);
    const base = baseRevision(root, baseRef);
    const snapshot = worktreeSnapshot(root);
    const baseText = base.sha ? showFile(root, base.sha, EXEMPTION_FILE) : undefined;
    const ctx: RuleContext = {
        root,
        snapshot,
        config: loadConfig(root),
        base: base.sha,
        changed: changedFiles(root, base.sha, head).map((item) => item.path),
        exemptions: loadExemptions(root),
        readAtBase: (path) => (base.sha ? showFile(root, base.sha, path) : undefined),
        baseKnown: base.known,
        exemptionsAtBase: baseExemptions(baseText),
    };
    const findings = [...runRules(ctx, rules()), ...runFindings(base, baseText, snapshot.read(EXEMPTION_FILE))];
    const report = buildRulesReport({
        base: base.sha,
        head,
        rules: rules(),
        findings,
        durationMs: Date.now() - started,
    });
    return { report, paths: writeRulesReport(root, report) };
}
