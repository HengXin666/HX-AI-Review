import { posix } from "node:path";
import { ERROR, WARNING } from "../constants.ts";
import { isExcluded } from "../config.ts";
import { lineOf } from "../l0/snapshot.ts";
import { HEADER_COMMENT_LIMIT } from "./constants.ts";
import { sourceFiles } from "./imports.ts";
import type { Rule, RuleContext, RuleIssue } from "./types.ts";

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const NON_ASCII_PUNCT = /[\u2010-\u2015\u2018-\u201F\u2026\u3000-\u303F\uFF00-\uFFEF]/;
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

type CommentLine = { line: number; text: string };

function commentLines(path: string, text: string): CommentLine[] {
    const python = posix.extname(path) === ".py";
    const result: CommentLine[] = [];
    let inBlock = false;
    text.split(/\r?\n/).forEach((line, index) => {
        if (python) {
            const match = /^\s*#(.*)$/.exec(line);
            if (match) {
                result.push({ line: index + 1, text: match[1] });
            }
            return;
        }
        if (inBlock) {
            const end = line.indexOf("*/");
            result.push({ line: index + 1, text: end < 0 ? line : line.slice(0, end) });
            inBlock = end < 0;
            return;
        }
        const start = /^\s*\/\*/.exec(line);
        if (start) {
            const rest = line.slice(start[0].length);
            const end = rest.indexOf("*/");
            result.push({ line: index + 1, text: end < 0 ? rest : rest.slice(0, end) });
            inBlock = end < 0;
            return;
        }
        const single = /^\s*\/\/(.*)$/.exec(line);
        if (single) {
            result.push({ line: index + 1, text: single[1] });
        }
    });
    return result;
}

function leadingCommentLines(path: string, text: string): number {
    const python = posix.extname(path) === ".py";
    let count = 0;
    let started = false;
    let inBlock = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (index === 0 && line.startsWith("#!")) {
            continue;
        }
        const trimmed = line.trim();
        if (!started && trimmed === "") {
            continue;
        }
        if (inBlock) {
            count++;
            inBlock = !trimmed.includes("*/");
            continue;
        }
        const lineComment = python ? /^#/.test(trimmed) : /^\/\//.test(trimmed);
        if (lineComment) {
            started = true;
            count++;
            continue;
        }
        if (!python && /^\/\*/.test(trimmed)) {
            started = true;
            count++;
            inBlock = !trimmed.includes("*/");
            continue;
        }
        break;
    }
    return count;
}

/** STYLE-003: comments stay short, describe semantics and use ASCII punctuation only. */
function checkComments(ctx: RuleContext): RuleIssue[] {
    const issues: RuleIssue[] = [];
    for (const file of sourceFiles(ctx.snapshot, (path) => isExcluded(ctx.config, path))) {
        const text = ctx.snapshot.read(file) ?? "";
        const header = leadingCommentLines(file, text);
        if (header > HEADER_COMMENT_LIMIT) {
            issues.push({
                path: file,
                line: 1,
                message: `File header comment has ${header} lines, limit ${HEADER_COMMENT_LIMIT}`,
                anchor: "header-length",
            });
        }
        for (const comment of commentLines(file, text)) {
            if (EMOJI.test(comment.text)) {
                issues.push({
                    path: file,
                    line: comment.line,
                    message: "Comment uses an emoji",
                    anchor: "comment-emoji-" + comment.line,
                });
            }
            if (NON_ASCII_PUNCT.test(comment.text)) {
                issues.push({
                    path: file,
                    line: comment.line,
                    message: "Comment uses non-ASCII punctuation, use ASCII",
                    evidence: comment.text.trim().slice(0, 80),
                    anchor: "comment-punct-" + comment.line,
                });
            }
        }
    }
    return issues;
}

function packageDependencies(text: string): string[] {
    try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        const names: string[] = [];
        for (const section of DEP_SECTIONS) {
            const value = raw[section];
            if (typeof value === "object" && value !== null) {
                names.push(...Object.keys(value));
            }
        }
        return names;
    } catch {
        return [];
    }
}

function pythonDependencies(text: string): string[] {
    const names: string[] = [];
    let inDeps = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) {
            inDeps = /dependencies/.test(line);
            continue;
        }
        if (!inDeps) {
            continue;
        }
        const match = /^\s*["']([A-Za-z0-9_.-]+)/.exec(line);
        if (match) {
            names.push(match[1]);
        }
    }
    return names;
}

function requirementDependencies(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("-"))
        .map((line) => /^([A-Za-z0-9_.-]+)/.exec(line)?.[1] ?? "")
        .filter((name) => name !== "");
}

function isManifest(path: string): boolean {
    const name = posix.basename(path);
    return name === "package.json" || name === "pyproject.toml" || /^requirements.*\.txt$/.test(name);
}

function dependenciesOf(path: string, text: string): string[] {
    if (posix.basename(path) === "package.json") {
        return packageDependencies(text);
    }
    if (posix.basename(path) === "pyproject.toml") {
        return pythonDependencies(text);
    }
    return requirementDependencies(text);
}

/** STYLE-004: a dependency absent from the base revision needs a human decision. */
function checkDependencies(ctx: RuleContext): RuleIssue[] {
    if (ctx.base === "") {
        return [];
    }
    const issues: RuleIssue[] = [];
    for (const file of ctx.snapshot.files) {
        if (!isManifest(file) || isExcluded(ctx.config, file)) {
            continue;
        }
        if (file.split("/").some((segment) => segment.startsWith("."))) {
            continue;
        }
        const text = ctx.snapshot.read(file) ?? "";
        const base = ctx.readAtBase(file);
        if (base === undefined) {
            issues.push({
                path: file,
                line: 1,
                message: "Dependency manifest is new, every dependency needs a human decision",
                evidence: "manifest absent at base",
                anchor: "manifest-new",
            });
            continue;
        }
        const before = new Set(dependenciesOf(file, base));
        for (const name of dependenciesOf(file, text)) {
            if (before.has(name)) {
                continue;
            }
            issues.push({
                path: file,
                line: lineOf(text, text.indexOf(name)),
                message: `New third-party dependency ${name} needs a human decision`,
                evidence: name,
                anchor: name,
            });
        }
    }
    return issues;
}

export const STYLE_RULES: Rule[] = [
    {
        id: "STYLE-003",
        severity: ERROR,
        description: "Comments describe semantics only",
        criteria: "header comment at most 10 lines, comments use ASCII punctuation and no emoji",
        check: checkComments,
    },
    {
        id: "STYLE-004",
        severity: WARNING,
        description: "New third-party dependency needs a human decision",
        criteria: "dependency absent from the base revision",
        check: checkDependencies,
    },
];
