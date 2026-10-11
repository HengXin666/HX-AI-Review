import { DIFF_MAX_BYTES, REPORT_FINDING_TOOL, REPORT_VERDICT_TOOL } from "../constants.ts";
import type { Suppression } from "../init/client.ts";
import type { ContextScope } from "../scope/index.ts";
import type { Candidate } from "./tools.ts";

export const FINDER_SYSTEM = `You review AI context files for a code change.
Context files are AGENTS.md, README.md, SKILL.md and markdown under docs/. Agents rely on them as truth.
Find statements in the listed context files that the diff made false, stale or misleading:
renamed or removed paths, commands, flags, APIs, config keys, module boundaries, workflows.
You only have read-only tools (read, grep, find, ls). Inspect the repository before reporting.
Report each problem with ${REPORT_FINDING_TOOL}; include a minimal git unified diff patch when the fix is clear.
Do not report style, wording preferences, or problems unrelated to this diff. Do not report suppressed items.
When nothing is wrong, report nothing and answer "no findings".`;

export const VERIFIER_SYSTEM = `You are a skeptical verifier in a fresh session. Your job is to refute a reported finding.
Use read-only tools to check the claim against the current repository.
Reject when the context file is still accurate, the claim is speculative, it is a style preference,
or the evidence does not hold. Confirm only when the mismatch is real and would mislead an agent.
Call ${REPORT_VERDICT_TOOL} exactly once.`;

/** Truncate on a UTF-8 byte budget; a split multi-byte character at the cut is dropped. */
export function truncate(text: string, limit: number): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= limit) {
        return text;
    }
    const head = bytes
        .subarray(0, limit)
        .toString("utf8")
        .replace(/\uFFFD+$/, "");
    return head + `\n... diff truncated (${bytes.length} bytes total)\n`;
}

export function finderPrompt(scope: ContextScope, diff: string, suppressions: Suppression[]): string {
    const contexts = scope.contexts.map((item) => `- ${item.path} (${item.reasons.slice(0, 3).join("; ")})`);
    const suppressed = suppressions.length
        ? suppressions.map((item) => `- ${item.fingerprint}: ${item.reason}`).join("\n")
        : "- none";
    return [
        `Review range ${scope.base || "(empty tree)"}..${scope.head}.`,
        "",
        "Changed paths:",
        ...scope.changed.map((path) => "- " + path),
        "",
        "Context files in scope (only these may be reported):",
        ...contexts,
        "",
        "Previously rejected findings with the reviewer's reason (do not repeat them):",
        suppressed,
        "",
        "Diff:",
        "```diff",
        truncate(diff, DIFF_MAX_BYTES),
        "```",
    ].join("\n");
}

export function verifierPrompt(candidate: Candidate, diff: string): string {
    return [
        "Candidate finding to refute:",
        `- file: ${candidate.path}:${candidate.line}`,
        `- title: ${candidate.title}`,
        `- message: ${candidate.message}`,
        `- evidence: ${candidate.evidence}`,
        candidate.patch ? "- proposed patch:\n```diff\n" + candidate.patch + "\n```" : "- no patch proposed",
        "",
        "Diff under review:",
        "```diff",
        truncate(diff, DIFF_MAX_BYTES / 2),
        "```",
    ].join("\n");
}
