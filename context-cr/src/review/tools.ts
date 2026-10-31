import { Type } from "typebox";
import { GIT_TOOL_TIMEOUT_MS, REPORT_CALL_LIMIT, REPORT_FINDING_TOOL, REPORT_VERDICT_TOOL } from "../constants.ts";
import { CODE_CATEGORIES, CODE_GRADES } from "../contract/finding.ts";
import type { CodeCategory, CodeGrade } from "../contract/finding.ts";
import { describeGitError, gitAsync, isMissingPath, isNoMatch } from "../git.ts";
import type { ToolSpec } from "./agent.ts";

export type Candidate = {
    path: string;
    line: number;
    title: string;
    message: string;
    evidence: string;
    patch?: string;
    /** Code CR: left reports an old-side deleted line. Right is the default. */
    side?: "left" | "right";
    category?: CodeCategory;
    grade?: CodeGrade;
    confidence?: number;
    repro?: string;
    /** Set when the model sent a grade, category, or confidence the gate cannot accept. */
    structureError?: string;
};

export type PatchVerdict = "correct" | "incorrect" | "none";
export type Verdict = { verdict: "confirmed" | "rejected"; reason: string; patch: PatchVerdict };

/** Deterministic gate result: undefined accepts the candidate, a string is the reason to refuse it. */
export type AcceptCandidate = (candidate: Candidate) => string | undefined;

function asGrade(value: unknown): CodeGrade | undefined {
    return CODE_GRADES.find((item) => item === value);
}

function asCategory(value: unknown): CodeCategory | undefined {
    return CODE_CATEGORIES.find((item) => item === value);
}

/**
 * Fill the structured code fields. A missing grade becomes a nit so an unstructured report
 * does not spend a comment slot ahead of a real defect. An illegal value is refused by the gate.
 */
function applyCodeFields(candidate: Candidate, params: Record<string, unknown>): void {
    candidate.side = params.side === "left" ? "left" : "right";
    const errors: string[] = [];
    if (params.grade === undefined || params.grade === "") {
        candidate.grade = "nit";
    } else {
        const grade = asGrade(params.grade);
        if (!grade) {
            errors.push("grade must be critical, major, minor or nit");
        }
        candidate.grade = grade ?? "nit";
    }
    if (params.category === undefined || params.category === "") {
        candidate.category = "other";
    } else {
        const category = asCategory(params.category);
        if (!category) {
            errors.push("category must be intent, breaking, stability, security or other");
        }
        candidate.category = category ?? "other";
    }
    if (params.confidence === undefined || params.confidence === "") {
        candidate.confidence = 0.5;
    } else {
        const confidence = typeof params.confidence === "number" ? params.confidence : Number(params.confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            errors.push("confidence must be a number from 0 to 1");
            candidate.confidence = 0.5;
        } else {
            candidate.confidence = confidence;
        }
    }
    const repro = typeof params.repro === "string" ? params.repro.trim() : "";
    candidate.repro = repro || candidate.message;
    if (errors.length) {
        candidate.structureError = errors[0];
    }
}

/** The report tool's parameters. Code CR has no patch field: nothing is pushed for a code finding. */
function parametersFor(code: boolean) {
    const shared = {
        path: Type.String({
            description: code
                ? "Repository-relative path of the file the diff changed"
                : "Repository-relative path of the stale context file",
        }),
        line: Type.Integer({
            minimum: 1,
            description: code ? "New-side line number shown in the hunk listing" : "Line in that file",
        }),
        title: Type.String({ description: "Short summary, under 80 characters" }),
        message: Type.String({
            description: code
                ? "The defect and the input, state or timing that triggers it, plus the suggested fix"
                : "What is wrong and why it misleads an agent",
        }),
        evidence: Type.String({
            description: code
                ? "Backtick quotes copied from the added, removed, or exposed line and the code that proves it wrong. Do not ask the reader to check."
                : "Code or diff lines proving the mismatch, with paths",
        }),
    };
    return code
        ? Type.Object({
              ...shared,
              side: Type.Optional(
                  Type.Union([Type.Literal("left"), Type.Literal("right")], {
                      description:
                          "right (default) for a new-side added or exposed line; left for a removed line numbered L<old>",
                  }),
              ),
              category: Type.Optional(
                  Type.Union(
                      CODE_CATEGORIES.map((item) => Type.Literal(item)),
                      {
                          description: "intent, breaking, stability, security, or other",
                      },
                  ),
              ),
              grade: Type.Optional(
                  Type.Union(
                      CODE_GRADES.map((item) => Type.Literal(item)),
                      {
                          description: "critical, major, minor, or nit. This does not change Warning vs Error.",
                      },
                  ),
              ),
              confidence: Type.Optional(
                  Type.Number({ minimum: 0, maximum: 1, description: "0 to 1, how sure you are" }),
              ),
              repro: Type.Optional(
                  Type.String({
                      description: "The input, state, timing, or reasoning that makes the defect happen",
                  }),
              ),
          })
        : Type.Object({
              ...shared,
              patch: Type.Optional(Type.String({ description: "git unified diff that fixes the context file" })),
          });
}

/**
 * The finder's only write channel: it cannot edit files, it reports candidates. Candidates are gated
 * before they count, so suppressed, duplicate or out-of-batch reports cannot consume the cap and hide
 * real findings. `callLimit` separately bounds total calls, so a finder cannot loop on rejections.
 *
 * Code CR reports through the same tool without the patch field: a code CR never pushes a branch, so a
 * patch from it could only be dropped. Refusing it keeps the model from spending turns writing one.
 */
function findingTool(
    sink: Candidate[],
    limit: number,
    accept: AcceptCandidate | undefined,
    callLimit: number,
    code: boolean,
): ToolSpec {
    let calls = 0;
    return {
        name: REPORT_FINDING_TOOL,
        label: "Report finding",
        description: code
            ? "Report one defect in a line this diff added, removed, or left exposed by a deletion. " +
              "Set side to left for a removed line (the L number), and set category, grade, confidence, and repro. " +
              "evidence must backtick-quote code copied from the hunk or a file you read. " +
              "Do not ask anyone to confirm or to check the context. " +
              "Describe the fix in the message; a code review never pushes a patch branch."
            : "Report one place where an AI context file (AGENTS.md, README.md, SKILL.md, docs) no longer " +
              "matches the code after this diff. Optionally include a unified diff patch fixing the context file.",
        parameters: parametersFor(code),
        execute(params) {
            calls++;
            if (calls > callLimit) {
                return `Report call limit of ${callLimit} reached; stop and summarize.`;
            }
            if (sink.length >= limit) {
                return `Limit of ${limit} findings reached; stop and summarize.`;
            }
            const candidate: Candidate = {
                path: String(params.path).replace(/^\.\//, ""),
                line: Math.max(1, Math.trunc(Number(params.line)) || 1),
                title: String(params.title),
                message: String(params.message),
                evidence: String(params.evidence),
                patch: !code && typeof params.patch === "string" && params.patch.trim() ? params.patch : undefined,
            };
            if (code) {
                applyCodeFields(candidate, params);
            }
            const reason = accept?.(candidate);
            if (reason !== undefined) {
                // Refused candidates do not count against the cap: keep reviewing the rest of the batch.
                return `Rejected: ${reason}. This did not count against the ${limit}-finding limit; continue.`;
            }
            sink.push(candidate);
            return `Recorded finding ${sink.length}.`;
        },
    };
}

export function reportFindingTool(
    sink: Candidate[],
    limit: number,
    accept?: AcceptCandidate,
    callLimit = REPORT_CALL_LIMIT,
): ToolSpec {
    return findingTool(sink, limit, accept, callLimit, false);
}

/** Code CR variant: same gate and cap, no patch field, because nothing is ever pushed for a code finding. */
export function reportCodeFindingTool(
    sink: Candidate[],
    limit: number,
    accept?: AcceptCandidate,
    callLimit = REPORT_CALL_LIMIT,
): ToolSpec {
    return findingTool(sink, limit, accept, callLimit, true);
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
    // A failure is returned as a discriminated result, never as text: callers that parse file lists would
    // otherwise read "git error: ..." as a filename and answer "No files." instead of reporting the failure.
    // execFile reports the exit code as `code` (`status` only exists on execFileSync errors), so the
    // previous `status === 1` check never matched and "no matches" was reported as a git failure.
    const run = async (
        args: string[],
        signal?: AbortSignal,
    ): Promise<{ ok: true; out: string } | { ok: false; error: string }> => {
        try {
            return { ok: true, out: await gitAsync(root, args, GIT_TOOL_TIMEOUT_MS, signal) };
        } catch (error) {
            // git exits 1 when a search found nothing; that is an empty result, not a failure.
            return isNoMatch(error) ? { ok: true, out: "" } : { ok: false, error: describeGitError(error) };
        }
    };
    /** Shared by the tools that only render git output; the reason is shown, never parsed as data. */
    const fail = (error: string) => "git error: " + error;
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
            async execute(params, signal) {
                const path = safePath(params.path);
                if (!path) {
                    return REFUSED;
                }
                let text: string;
                try {
                    text = await gitAsync(root, ["show", "HEAD:" + path], GIT_TOOL_TIMEOUT_MS, signal);
                } catch (error) {
                    // Only a path confirmed absent from the revision means "not found"; a timeout, a
                    // cancellation, an unusable revision or any other git failure is reported as such
                    // instead of hiding a real git error behind "No tracked file".
                    return (await isMissingPath(root, "HEAD", path, error, GIT_TOOL_TIMEOUT_MS, signal))
                        ? `No tracked file ${path} at the reviewed commit.`
                        : "git error: " + describeGitError(error);
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
            async execute(params, signal) {
                const path = params.path === undefined ? "" : safePath(params.path);
                if (path === undefined) {
                    return REFUSED;
                }
                const args = ["grep", "-n", "-I", "-E", "-e", String(params.pattern), "HEAD", "--"];
                const found = await run(path ? [...args, path] : args, signal);
                if (!found.ok) {
                    return fail(found.error);
                }
                // git grep prefixes each line with "HEAD:"; only that revision prefix is stripped, so a
                // result line that itself contains "HEAD:" (e.g. a refspec) keeps its own text intact.
                return (
                    clip(
                        found.out
                            .split("\n")
                            .map((line) => line.replace(/^HEAD:/, ""))
                            .join("\n"),
                    ) || "No matches."
                );
            },
        },
        {
            name: "find",
            label: "Find files",
            description: "List tracked files matching a glob such as 'docs/**/*.md' or '**/AGENTS.md'.",
            parameters: Type.Object({ pattern: Type.String() }),
            async execute(params, signal) {
                const pattern = safePath(params.pattern);
                if (!pattern) {
                    return REFUSED;
                }
                const match = globRegex(pattern);
                const listed = await run(["ls-tree", "-r", "--name-only", "-z", "HEAD"], signal);
                if (!listed.ok) {
                    return fail(listed.error);
                }
                const files = listed.out.split("\0");
                return clip(files.filter((file) => file && match.test(file)).join("\n")) || "No files.";
            },
        },
        {
            name: "ls",
            label: "List directory",
            description: "List a directory of the reviewed commit; directories end with '/'.",
            parameters: Type.Object({ path: Type.Optional(Type.String()) }),
            async execute(params, signal) {
                const path = params.path === undefined ? "" : safePath(params.path);
                if (path === undefined) {
                    return REFUSED;
                }
                const listed = await run(["ls-tree", "HEAD", "--", path ? path + "/" : "."], signal);
                if (!listed.ok) {
                    return fail(listed.error);
                }
                const names = listed.out
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
