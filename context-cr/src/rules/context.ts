import { posix } from "node:path";
import { AGENTS_FILE, AGENTS_MAX_BYTES, AGENTS_MAX_LINES, ERROR, README_FILE, SKILL_FILE } from "../constants.ts";
import { isExcluded } from "../config.ts";
import { lineOf } from "../l0/snapshot.ts";
import { headings } from "./markdown.ts";
import type { Rule, RuleContext, RuleIssue } from "./types.ts";

function byteLength(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

function checkAgents(ctx: RuleContext, file: string): RuleIssue[] {
    const text = (ctx.snapshot.read(file) ?? "").replace(/\r\n/g, "\n");
    const issues: RuleIssue[] = [];
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (lines >= AGENTS_MAX_LINES || byteLength(text) >= AGENTS_MAX_BYTES) {
        issues.push({
            path: file,
            line: AGENTS_MAX_LINES,
            message: `AGENTS.md must stay under ${AGENTS_MAX_LINES} lines and ${AGENTS_MAX_BYTES} bytes`,
            evidence: `${lines} lines, ${byteLength(text)} bytes`,
            anchor: "size",
        });
    }
    const heads = headings(text);
    const top = heads.filter((item) => item.level === 1);
    if (heads.length === 0 || heads[0].level !== 1) {
        issues.push({ path: file, line: 1, message: "AGENTS.md must open with a level 1 heading", anchor: "h1" });
    }
    if (top.length !== 1) {
        issues.push({
            path: file,
            line: 1,
            message: `AGENTS.md must hold exactly one level 1 heading, found ${top.length}`,
            anchor: "h1-count",
        });
    }
    let previous = 0;
    for (const head of heads) {
        if (head.level > previous + 1) {
            issues.push({
                path: file,
                line: head.line,
                message: `Heading level jumps from ${previous} to ${head.level}`,
                anchor: "heading-" + head.line,
            });
        }
        previous = head.level;
    }
    const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
    const pair = dir ? dir + "/" + README_FILE : README_FILE;
    if (!ctx.snapshot.exists(pair)) {
        issues.push({
            path: file,
            line: 1,
            message: `${file} has no paired ${README_FILE}`,
            evidence: pair,
            anchor: "pair",
        });
    }
    return issues;
}

function checkSkill(ctx: RuleContext, file: string): RuleIssue[] {
    const text = (ctx.snapshot.read(file) ?? "").replace(/\r\n/g, "\n");
    const head = /^---\n([\s\S]*?)\n---/.exec(text);
    const dir = posix.basename(posix.dirname(file));
    if (!head) {
        return [{ path: file, line: 1, message: "SKILL.md must open with YAML front matter", anchor: "front-matter" }];
    }
    const issues: RuleIssue[] = [];
    const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(head[1])?.[1].trim();
    if (name !== dir) {
        issues.push({
            path: file,
            line: 1,
            message: `Front matter name "${name ?? ""}" differs from directory "${dir}"`,
            anchor: "name",
        });
    }
    const description = /^description:\s*(.+)$/m
        .exec(head[1])?.[1]
        .replace(/^["']|["']$/g, "")
        .trim();
    if (!description) {
        issues.push({ path: file, line: 1, message: "Front matter description is empty", anchor: "description" });
    }
    const body = text.slice(head[0].length);
    if (headings(body).length === 0) {
        issues.push({
            path: file,
            line: lineOf(text, head[0].length),
            message: "SKILL.md body has no heading",
            anchor: "body",
        });
    }
    return issues;
}

/** CTX-001: AGENTS.md stays small, keeps one top heading and pairs with README.md. */
function checkAgentsFiles(ctx: RuleContext): RuleIssue[] {
    const issues: RuleIssue[] = [];
    for (const file of ctx.snapshot.files) {
        if (posix.basename(file) === AGENTS_FILE && !isExcluded(ctx.config, file)) {
            issues.push(...checkAgents(ctx, file));
        }
    }
    return issues;
}

/** CTX-002: SKILL.md carries front matter whose name matches its directory and a non-empty body. */
function checkSkillFiles(ctx: RuleContext): RuleIssue[] {
    const issues: RuleIssue[] = [];
    for (const file of ctx.snapshot.files) {
        if (posix.basename(file) === SKILL_FILE && !isExcluded(ctx.config, file)) {
            issues.push(...checkSkill(ctx, file));
        }
    }
    return issues;
}

export const CONTEXT_RULES: Rule[] = [
    {
        id: "CTX-001",
        severity: ERROR,
        description: "AGENTS.md structure",
        criteria: "under 150 lines and 16 KB, one level 1 heading, no heading jump, paired README.md",
        check: checkAgentsFiles,
    },
    {
        id: "CTX-002",
        severity: ERROR,
        description: "SKILL.md structure",
        criteria: "front matter with a matching name and description, plus a body with a heading",
        check: checkSkillFiles,
    },
];
