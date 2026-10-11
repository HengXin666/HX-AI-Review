import { RULE, WARNING } from "../constants.ts";
import { addUsage, EMPTY_USAGE, fingerprint, makeFinding } from "../contract/finding.ts";
import type { Finding, Patch, Usage } from "../contract/finding.ts";
import type { InitConfig } from "../init/client.ts";
import type { ContextScope } from "../scope/index.ts";
import type { AgentRunner } from "./agent.ts";
import { FINDER_SYSTEM, VERIFIER_SYSTEM, finderPrompt, verifierPrompt } from "./prompts.ts";
import { reportFindingTool, reportVerdictTool } from "./tools.ts";
import type { Candidate, Verdict } from "./tools.ts";

export type ReviewDeps = {
    run: AgentRunner;
    diff: string;
    /** Deterministic `git apply --check` so an unusable patch never reaches write-back. */
    patchApplies(patch: string): boolean;
};

export type ReviewResult = {
    findings: Finding[];
    patches: Patch[];
    usage: Usage;
    transcripts: { role: string; index: number; messages: unknown[] }[];
    rejected: number;
};

function toFinding(candidate: Candidate, reason: string): Finding {
    const message = candidate.title + ": " + candidate.message;
    const evidence = reason ? candidate.evidence + "\nVerifier: " + reason : candidate.evidence;
    const finding = makeFinding(RULE.ai, WARNING, candidate.path, candidate.line, message, evidence);
    // Anchor on path + title so the same stale statement keeps its fingerprint across runs and feedback.
    return { ...finding, fingerprint: fingerprint(RULE.ai, candidate.path, candidate.title, "") };
}

/**
 * finder -> verifier. AI output is Warning only; Error stays with L0. Each candidate is checked
 * in a new verifier session that tries to refute it, and only confirmed candidates are kept.
 */
export async function runReview(config: InitConfig, scope: ContextScope, deps: ReviewDeps): Promise<ReviewResult> {
    const inScope = new Set(scope.contexts.map((item) => item.path));
    const suppressed = new Set(config.suppressions.map((item) => item.fingerprint));
    const candidates: Candidate[] = [];
    const result: ReviewResult = { findings: [], patches: [], usage: EMPTY_USAGE, transcripts: [], rejected: 0 };

    const finder = await deps.run({
        role: "finder",
        model: config.models.finder,
        system: FINDER_SYSTEM,
        prompt: finderPrompt(scope, deps.diff, config.suppressions),
        tools: [reportFindingTool(candidates, config.limits.maxCandidates)],
    });
    result.usage = addUsage(result.usage, finder.usage);
    result.transcripts.push({ role: "finder", index: 0, messages: finder.transcript });

    for (const [index, candidate] of candidates.entries()) {
        const draft = toFinding(candidate, "");
        if (!inScope.has(candidate.path) || suppressed.has(draft.fingerprint)) {
            result.rejected++;
            continue;
        }
        const verdicts: Verdict[] = [];
        const verifier = await deps.run({
            role: "verifier",
            model: config.models.verifier,
            system: VERIFIER_SYSTEM,
            prompt: verifierPrompt(candidate, deps.diff),
            tools: [reportVerdictTool(verdicts)],
        });
        result.usage = addUsage(result.usage, verifier.usage);
        result.transcripts.push({ role: "verifier", index: index + 1, messages: verifier.transcript });
        const verdict = verdicts[verdicts.length - 1];
        if (verdict?.verdict !== "confirmed") {
            result.rejected++;
            continue;
        }
        const finding = toFinding(candidate, verdict.reason);
        result.findings.push(finding);
        if (candidate.patch) {
            const diff = candidate.patch.endsWith("\n") ? candidate.patch : candidate.patch + "\n";
            result.patches.push({ fingerprint: finding.fingerprint, diff, applies: deps.patchApplies(diff) });
        }
    }
    return result;
}
