import { posix } from "node:path";
import { isExcluded } from "../config.ts";
import { lineOf } from "../l0/snapshot.ts";
import { WORKFLOW_DIR } from "./constants.ts";
import type { Rule, RuleContext, RuleIssue } from "./types.ts";

const LOCAL_USES = /uses:\s*\.\/(\.github\/workflows\/[\w./-]+\.ya?ml)/g;
const NODE_RUN = /\bnode\s+(?:--?[^\s]+\s+)*([\w@./-]+\.(?:ts|js|mjs|cjs))/g;
const PNPM_FILTER = /--filter\s+([^\s"']+)/g;
const WORKING_DIR = /^\s*working-directory:\s*["']?([^\s"']+)["']?\s*$/;

type ScriptRef = { script: string; dir: string; line: number };

function workflowFiles(ctx: RuleContext): string[] {
    return ctx.snapshot.files
        .filter((file) => posix.dirname(file) === WORKFLOW_DIR && /\.ya?ml$/.test(file))
        .filter((file) => !isExcluded(ctx.config, file))
        .sort();
}

function packageNames(ctx: RuleContext): Set<string> {
    const names = new Set<string>();
    for (const file of ctx.snapshot.files) {
        if (posix.basename(file) !== "package.json" || isExcluded(ctx.config, file)) {
            continue;
        }
        try {
            const raw = JSON.parse(ctx.snapshot.read(file) ?? "{}") as { name?: unknown };
            if (typeof raw.name === "string") {
                names.add(raw.name);
            }
        } catch {
            continue;
        }
    }
    return names;
}

function normalizeDir(raw: string): string {
    return raw.replace(/^\.\//, "").replace(/\/$/, "");
}

function scriptRefs(text: string): ScriptRef[] {
    const refs: ScriptRef[] = [];
    const lines = text.split(/\r?\n/);
    let stepsIndent: number | undefined;
    let stepIndent: number | undefined;
    let block: { line: string; index: number }[] | undefined;
    const flush = (): void => {
        if (!block) {
            return;
        }
        let dir = "";
        for (const item of block) {
            const working = WORKING_DIR.exec(item.line);
            if (working) {
                dir = normalizeDir(working[1]);
            }
        }
        for (const item of block) {
            for (const match of item.line.matchAll(NODE_RUN)) {
                refs.push({ script: match[1].replace(/^\.\//, ""), dir, line: item.index + 1 });
            }
        }
        block = undefined;
    };
    for (const [index, line] of lines.entries()) {
        if (line.trim() === "" || line.trimStart().startsWith("#")) {
            continue;
        }
        const indent = line.length - line.trimStart().length;
        const steps = /^(\s*)steps:\s*$/.exec(line);
        if (steps) {
            flush();
            stepsIndent = steps[1].length;
            stepIndent = undefined;
            continue;
        }
        const step = /^(\s*)-\s+/.exec(line);
        if (step && stepsIndent !== undefined) {
            if (stepIndent === undefined) {
                stepIndent = step[1].length;
            }
            if (step[1].length === stepIndent) {
                flush();
                block = [];
            }
        } else if (block && stepsIndent !== undefined && indent <= stepsIndent) {
            flush();
            stepsIndent = undefined;
            stepIndent = undefined;
        }
        if (block) {
            block.push({ line, index });
        }
    }
    flush();
    return refs;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function directoryPattern(ctx: RuleContext, pattern: string): boolean {
    const prefix = normalizeDir(pattern.split("*")[0]);
    if (prefix === "" || prefix === ".") {
        return true;
    }
    return ctx.snapshot.exists(prefix) || ctx.snapshot.files.some((file) => file.startsWith(prefix));
}

function directoryFilter(ctx: RuleContext, value: string): boolean {
    return value
        .replace(/^\{/, "")
        .replace(/\}$/, "")
        .split(",")
        .every((item) => {
            const dir = normalizeDir(item.trim());
            if (dir === "" || dir === ".") {
                return true;
            }
            return dir.includes("*") ? directoryPattern(ctx, dir) : ctx.snapshot.exists(dir);
        });
}

function matchesFilter(ctx: RuleContext, packages: Set<string>, raw: string): boolean {
    let value = raw
        .replace(/^!/, "")
        .replace(/^\.\.\./, "")
        .replace(/\.\.\.$/, "")
        .replace(/^\^/, "");
    if (value === "" || value.includes("$")) {
        return true;
    }
    if (/\[[^\]]+\]/.test(value)) {
        return true;
    }
    if (/^[./{[]/.test(value)) {
        return directoryFilter(ctx, value);
    }
    if (value.includes("*")) {
        const pattern = new RegExp("^" + value.split("*").map(escapeRegExp).join(".*") + "$");
        return [...packages].some((name) => pattern.test(name));
    }
    return packages.has(value);
}

/** CI-001: workflows exist, keep their trigger and jobs, and call scripts and packages that exist. */
function checkWorkflows(ctx: RuleContext): RuleIssue[] {
    const files = workflowFiles(ctx);
    if (files.length === 0) {
        return [{ path: WORKFLOW_DIR, line: 1, message: "No GitHub workflow exists", anchor: "workflows" }];
    }
    const issues: RuleIssue[] = [];
    const packages = packageNames(ctx);
    for (const file of files) {
        const text = ctx.snapshot.read(file) ?? "";
        for (const key of ["on", "jobs"]) {
            if (!new RegExp("^" + key + ":", "m").test(text)) {
                issues.push({ path: file, line: 1, message: `Workflow has no top-level ${key}: key`, anchor: key });
            }
        }
        for (const match of text.matchAll(LOCAL_USES)) {
            if (!ctx.snapshot.exists(match[1])) {
                issues.push({
                    path: file,
                    line: lineOf(text, match.index),
                    message: `Workflow calls missing ${match[1]}`,
                    evidence: match[1],
                    anchor: match[1],
                });
            }
        }
        for (const ref of scriptRefs(text)) {
            const path = ref.dir ? ref.dir + "/" + ref.script : ref.script;
            if (!ctx.snapshot.exists(path)) {
                issues.push({
                    path: file,
                    line: ref.line,
                    message: `Workflow runs missing script ${ref.script}`,
                    evidence: path,
                    anchor: ref.script,
                });
            }
        }
        for (const match of text.matchAll(PNPM_FILTER)) {
            const name = match[1];
            if (matchesFilter(ctx, packages, name)) {
                continue;
            }
            issues.push({
                path: file,
                line: lineOf(text, match.index),
                message: `Workflow filters unknown package ${name}`,
                evidence: name,
                anchor: name,
            });
        }
    }
    return issues;
}

export const CI_RULES: Rule[] = [
    {
        id: "CI-001",
        severity: "error",
        description: "Workflows exist and are invoked",
        criteria: "each workflow has on: and jobs:, and every local script, package and workflow it calls exists",
        check: checkWorkflows,
    },
];
