import { Type } from "typebox";
import { REPORT_FINDING_TOOL, REPORT_VERDICT_TOOL } from "../constants.ts";
import { git, tryGit } from "../git.ts";
import type { ToolSpec } from "./agent.ts";

export type Candidate = {
    path: string;
    line: number;
    title: string;
    message: string;
    evidence: string;
    patch?: string;
};

export type PatchVerdict = "correct" | "incorrect" | "none";
export type Verdict = { verdict: "confirmed" | "rejected"; reason: string; patch: PatchVerdict };

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
                path: String(params.path).replace(/^\.\//, ""),
                line: Math.max(1, Math.trunc(Number(params.line)) || 1),
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
            patch: Type.Union([Type.Literal("correct"), Type.Literal("incorrect"), Type.Literal("none")], {
                description: "Whether the proposed patch is a correct fix; none when no patch was proposed",
            }),
        }),
        execute(params) {
            // Anything but an explicit "confirmed" / "correct" counts against the candidate.
            const verdict = params.verdict === "confirmed" ? "confirmed" : "rejected";
            const patch = params.patch === "correct" ? "correct" : params.patch === "none" ? "none" : "incorrect";
            sink.push({ verdict, reason: String(params.reason), patch });
            return "Verdict recorded. Stop now.";
        },
    };
}

const TOOL_OUTPUT_MAX = 30000;
const READ_DEFAULT_LINES = 400;

function clip(text: string): string {
    return text.length > TOOL_OUTPUT_MAX ? text.slice(0, TOOL_OUTPUT_MAX) + "\n... output truncated" : text;
}

/** Repository-relative, no traversal, nothing under .git: the tools can only name tracked content. */
function safePath(value: unknown): string | undefined {
    const path = String(value ?? "")
        .trim()
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".git")) {
        return undefined;
    }
    return path;
}

/** `**` spans directories, `*` and `?` stay within one path segment. */
function globRegex(glob: string): RegExp {
    const body = glob
        .split("**/")
        .map((part) =>
            part
                .split("**")
                .map((piece) =>
                    piece
                        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                        .replaceAll("*", "[^/]*")
                        .replaceAll("?", "[^/]"),
                )
                .join(".*"),
        )
        .join("(?:.*/)?");
    return new RegExp("^" + body + "$");
}

const REFUSED = "Refused: use a repository-relative path without '..' or '.git'.";

/**
 * Read-only tools over the reviewed commit, backed by git instead of the filesystem: only tracked files
 * at HEAD are visible, so .git/config, untracked files, /proc and symlink targets outside the repo are not.
 * A tracked symlink reads as its target path, never as the target's content.
 */
export function repoTools(root: string): ToolSpec[] {
    const run = (args: string[]): string => {
        try {
            return git(root, args);
        } catch (error) {
            const status = (error as { status?: number }).status;
            return status === 1 ? "" : "git error: " + String((error as Error).message).split("\n")[0];
        }
    };
    return [
        {
            name: "read",
            label: "Read file",
            description: "Read a tracked file at the reviewed commit, with line numbers.",
            parameters: Type.Object({
                path: Type.String(),
                offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line, default 1" })),
                limit: Type.Optional(Type.Integer({ minimum: 1, description: `Lines, default ${READ_DEFAULT_LINES}` })),
            }),
            execute(params) {
                const path = safePath(params.path);
                if (!path) {
                    return REFUSED;
                }
                const text = tryGit(root, ["show", "HEAD:" + path]);
                if (text === undefined) {
                    return `No tracked file ${path} at the reviewed commit.`;
                }
                const lines = text.split("\n");
                const from = Math.max(1, Number(params.offset) || 1);
                const to = Math.min(lines.length, from - 1 + (Number(params.limit) || READ_DEFAULT_LINES));
                const body = lines.slice(from - 1, to).map((line, index) => `${from + index}| ${line}`);
                return clip(body.join("\n") + (to < lines.length ? `\n... ${lines.length - to} more lines` : ""));
            },
        },
        {
            name: "grep",
            label: "Search",
            description: "Search tracked files at the reviewed commit (git grep, extended regex, line numbers).",
            parameters: Type.Object({
                pattern: Type.String(),
                path: Type.Optional(Type.String({ description: "Limit to this file or directory" })),
            }),
            execute(params) {
                const path = params.path === undefined ? "" : safePath(params.path);
                if (path === undefined) {
                    return REFUSED;
                }
                const args = ["grep", "-n", "-I", "-E", "-e", String(params.pattern), "HEAD", "--"];
                const out = run(path ? [...args, path] : args);
                return clip(out.replaceAll("HEAD:", "")) || "No matches.";
            },
        },
        {
            name: "find",
            label: "Find files",
            description: "List tracked files matching a glob such as 'docs/**/*.md' or '**/AGENTS.md'.",
            parameters: Type.Object({ pattern: Type.String() }),
            execute(params) {
                const pattern = safePath(params.pattern);
                if (!pattern) {
                    return REFUSED;
                }
                const match = globRegex(pattern);
                const files = run(["ls-tree", "-r", "--name-only", "-z", "HEAD"]).split("\0");
                return clip(files.filter((file) => file && match.test(file)).join("\n")) || "No files.";
            },
        },
        {
            name: "ls",
            label: "List directory",
            description: "List a directory of the reviewed commit; directories end with '/'.",
            parameters: Type.Object({ path: Type.Optional(Type.String()) }),
            execute(params) {
                const path = params.path === undefined ? "" : safePath(params.path);
                if (path === undefined) {
                    return REFUSED;
                }
                const out = run(["ls-tree", "HEAD", "--", path ? path + "/" : "."]);
                const names = out
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => {
                        const [meta, name] = line.split("\t");
                        return meta.includes(" tree ") ? name + "/" : name;
                    });
                return clip(names.join("\n")) || "Empty or not a directory.";
            },
        },
    ];
}
