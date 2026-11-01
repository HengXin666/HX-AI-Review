import { RULE, WARNING, INIT_FILE } from "../constants.ts";
import { loadConfig, loadTrustedConfig } from "../config.ts";
import { makeFinding } from "../contract/finding.ts";
import type { Finding } from "../contract/finding.ts";
import { changedFiles, headSha, showFile, tryGit } from "../git.ts";
import { worktreeSnapshot } from "../l0/snapshot.ts";
import { resolveBase } from "../scope/base.ts";
import type { EventInfo } from "../scope/base.ts";
import { load } from "../state.ts";
import { EXEMPTION_FILE, RULES_BASELINE_FILE } from "./constants.ts";
import { loadExemptions, parseExemptions } from "./exemptions.ts";
import { rules } from "./index.ts";
import { runRules } from "./registry.ts";
import { buildRulesReport, writeRulesReport } from "./report.ts";
import type { RulesPaths, RulesReport } from "./report.ts";
import type { Exemption, RuleContext } from "./types.ts";

export type RulesRun = { report: RulesReport; paths: RulesPaths };

/** Where the base came from: an explicit --base, the range init resolved, or a fresh resolveBase. */
type BaseRevision = { sha: string; known: boolean; reason: string; trusted: boolean };

/** One accepted pre-existing finding, keyed like the L0 baseline. */
export type RulesApproved = { ruleId: string; path: string; fingerprint: string };

/**
 * The range start. An explicit ref wins (local and quality runs); otherwise the base init already resolved
 * for this CI run, so rules judge the same range as L0 and scope; without init state, resolveBase with the
 * same precedence (PR merge-base, push before, default branch merge-base, empty tree). No branch name is
 * hard-coded: a repository whose default branch is master or develop gets its real range.
 */
function baseRevision(root: string, head: string, baseRef?: string): BaseRevision {
    if (baseRef) {
        const sha = tryGit(root, ["rev-parse", baseRef]);
        if (!sha) {
            throw new Error(`base ref ${baseRef} does not resolve`);
        }
        return { sha: sha.trim(), known: true, reason: "--base " + baseRef, trusted: false };
    }
    const init = load<{ nonce?: string; event?: EventInfo }>(root, INIT_FILE);
    const event = init?.event ?? resolveBase(root, head);
    // Only a run that went through /init has a base it did not choose itself.
    const trusted = init?.event !== undefined && init.nonce !== "local";
    return { sha: event.base, known: event.base !== "", reason: event.reason, trusted };
}

function baseExemptions(text: string | undefined): Exemption[] {
    return text === undefined ? [] : parseExemptions(text);
}

/** Approved findings from the rules baseline at the base revision; the reviewed change cannot add to it. */
function baselineAt(root: string, base: BaseRevision): Set<string> {
    const text = base.sha ? showFile(root, base.sha, RULES_BASELINE_FILE) : undefined;
    if (text === undefined) {
        return new Set();
    }
    const list = JSON.parse(text) as RulesApproved[];
    return new Set(list.map((item) => item.ruleId + "\0" + item.path + "\0" + item.fingerprint));
}

/**
 * Only the change under review can block. A finding on a file this range did not touch, or one the trusted
 * baseline already accepts, is pre-existing debt: it stays in the report with origin historical and never
 * counts as blocking, so a repository is not failed for code nobody changed. Findings on the repository as
 * a whole (path ".", such as a crashed rule) stay new.
 */
export function markHistorical(findings: Finding[], changed: string[], approved: Set<string>): Finding[] {
    const touched = new Set(changed);
    return findings.map((item) => {
        const accepted = approved.has(item.ruleId + "\0" + item.path + "\0" + item.fingerprint);
        const stock = item.path !== "." && !touched.has(item.path);
        return accepted || stock ? { ...item, origin: "historical" } : item;
    });
}

/** Findings outside the rule set: an empty-tree base and an exemption file edited by the reviewed change. */
function runFindings(base: BaseRevision, baseText: string | undefined, localText: string | undefined): Finding[] {
    const findings: Finding[] = [];
    if (!base.known) {
        findings.push(
            makeFinding(
                RULE.tool,
                WARNING,
                ".",
                1,
                "Base is the empty tree, so every file counts as changed and no exemption can expire",
                base.reason,
                "base-empty",
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
    const base = baseRevision(root, head, baseRef);
    const snapshot = worktreeSnapshot(root);
    const baseText = base.sha ? showFile(root, base.sha, EXEMPTION_FILE) : undefined;
    const changed = changedFiles(root, base.sha, head).map((item) => item.path);
    const ctx: RuleContext = {
        root,
        snapshot,
        config: base.trusted ? loadTrustedConfig(root, base.sha) : loadConfig(root),
        base: base.sha,
        changed,
        exemptions: loadExemptions(root),
        readAtBase: (path) => (base.sha ? showFile(root, base.sha, path) : undefined),
        baseKnown: base.known,
        exemptionsAtBase: baseExemptions(baseText),
    };
    const found = [...runRules(ctx, rules()), ...runFindings(base, baseText, snapshot.read(EXEMPTION_FILE))];
    const findings = markHistorical(found, changed, baselineAt(root, base));
    const report = buildRulesReport({
        base: base.sha,
        head,
        rules: rules(),
        findings,
        durationMs: Date.now() - started,
    });
    return { report, paths: writeRulesReport(root, report) };
}
