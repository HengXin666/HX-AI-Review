import { Type } from "typebox";
import { REPORT_FINDING_TOOL, REPORT_VERDICT_TOOL } from "../constants.ts";
import type { ToolSpec } from "./agent.ts";

export type Candidate = {
    path: string;
    line: number;
    title: string;
    message: string;
    evidence: string;
    patch?: string;
};

export type Verdict = { verdict: "confirmed" | "rejected"; reason: string };

/** The finder's only write channel: it cannot edit files, it reports candidates. */
export function reportFindingTool(sink: Candidate[], limit: number): ToolSpec {
    return {
        name: REPORT_FINDING_TOOL,
        label: "Report finding",
        description:
            "Report one place where an AI context file (AGENTS.md, README.md, SKILL.md, docs) no longer " +
            "matches the code after this diff. Optionally include a unified diff patch fixing the context file.",
        parameters: Type.Object({
            path: Type.String({ description: "Repository-relative path of the stale context file" }),
            line: Type.Integer({ minimum: 1, description: "Line in that file" }),
            title: Type.String({ description: "Short summary, under 80 characters" }),
            message: Type.String({ description: "What is wrong and why it misleads an agent" }),
            evidence: Type.String({ description: "Code or diff lines proving the mismatch, with paths" }),
            patch: Type.Optional(Type.String({ description: "git unified diff that fixes the context file" })),
        }),
        execute(params) {
            if (sink.length >= limit) {
                return `Limit of ${limit} findings reached; stop and summarize.`;
            }
            sink.push({
                path: String(params.path),
                line: Math.max(1, Number(params.line) || 1),
                title: String(params.title),
                message: String(params.message),
                evidence: String(params.evidence),
                patch: typeof params.patch === "string" && params.patch.trim() ? params.patch : undefined,
            });
            return `Recorded finding ${sink.length}.`;
        },
    };
}

/** The verifier must commit to one verdict; absence of a verdict counts as rejected. */
export function reportVerdictTool(sink: Verdict[]): ToolSpec {
    return {
        name: REPORT_VERDICT_TOOL,
        label: "Report verdict",
        description: "Report whether the candidate finding survives your attempt to refute it.",
        parameters: Type.Object({
            verdict: Type.Union([Type.Literal("confirmed"), Type.Literal("rejected")]),
            reason: Type.String({ description: "Evidence for the verdict, with file paths" }),
        }),
        execute(params) {
            const verdict = params.verdict === "confirmed" ? "confirmed" : "rejected";
            sink.push({ verdict, reason: String(params.reason) });
            return "Verdict recorded. Stop now.";
        },
    };
}
