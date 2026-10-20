import { posix } from "node:path";
import { isExcluded } from "../config.ts";
import { lineOf } from "../l0/snapshot.ts";
import { WORKFLOW_DIR } from "./constants.ts";
import type { Rule, RuleContext, RuleIssue } from "./types.ts";

const LOCAL_USES = /uses:\s*\.\/(\.github\/workflows\/[\w./-]+\.ya?ml)/g;
const NODE_RUN = /\bnode\s+(?:[^\n;&|]*?\s+)?([\w@./-]+\.(?:ts|js|mjs|cjs))/g;
const PNPM_FILTER = /--filter\s+([^\s"']+)/g;
const WORKING_DIR = /working-directory:\s*([^\s"']+)/g;

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
        const dirs = [...text.matchAll(WORKING_DIR)].map((match) => match[1].replace(/^\.\//, "").replace(/\/$/, ""));
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
        for (const match of text.matchAll(NODE_RUN)) {
            const script = match[1].replace(/^\.\//, "");
            const working = [...text.matchAll(WORKING_DIR)].filter((item) => (item.index ?? 0) < (match.index ?? 0)).at(-1)?.[1];
            const candidates = [script, ...(working ? [working.replace(/^\.\//, "").replace(/\/$/, "") + "/" + script] : [])];
            if (!candidates.some((path) => ctx.snapshot.exists(path))) {
                issues.push({
                    path: file,
                    line: lineOf(text, match.index),
                    message: `Workflow runs missing script ${script}`,
                    evidence: script,
                    anchor: script,
                });
            }
        }
        for (const match of text.matchAll(PNPM_FILTER)) {
            let name = match[1];
            name = name.replace(/^!/, "").replace(/^\.\.\./, "").replace(/^\^/, "");
            if (name.includes("$") || name.startsWith(".") || name.startsWith("/") || name.startsWith("{") || name.includes("[")) {
                continue;
            }
            if (name.includes("*")) {
                const pattern = new RegExp("^" + name.split("*").map((part) => part.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")).join(".*") + "$");
                if ([...packages].some((pkg) => pattern.test(pkg))) continue;
            } else if (packages.has(name)) {
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
