import { posix } from "node:path";
import { isExcluded } from "../config.ts";
import { lineOf } from "../l0/snapshot.ts";
import { withoutCode } from "./markdown.ts";
import type { Rule, RuleContext, RuleIssue } from "./types.ts";

const LINK = /!?\[[^\]]*\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function isDoc(path: string): boolean {
    const name = posix.basename(path);
    if (!name.endsWith(".md") && !name.endsWith(".mdx")) {
        return false;
    }
    if (path.startsWith("docs/archive/")) {
        return false;
    }
    return !path.split("/").some((segment) => segment.startsWith("."));
}

function decodeTarget(target: string): string {
    try {
        return decodeURI(target);
    } catch {
        return target;
    }
}

function resolveTarget(file: string, raw: string): string | undefined {
    const target = decodeTarget(raw.split("#")[0].split("?")[0]);
    if (target === "") {
        return undefined;
    }
    const resolved = target.startsWith("/")
        ? posix.normalize(target.slice(1))
        : posix.normalize(posix.join(posix.dirname(file), target));
    const clean = resolved.replace(/^\.\//, "").replace(/\/+$/, "");
    return clean === "" ? "." : clean;
}

/** DOC-001: every relative markdown link resolves to a tracked file or directory. */
function checkDocLinks(ctx: RuleContext): RuleIssue[] {
    const issues: RuleIssue[] = [];
    for (const file of ctx.snapshot.files) {
        if (!isDoc(file) || isExcluded(ctx.config, file)) {
            continue;
        }
        const text = withoutCode(ctx.snapshot.read(file) ?? "");
        for (const match of text.matchAll(LINK)) {
            const raw = match[1].replace(/^<|>$/g, "");
            const line = lineOf(text, match.index);
            if (raw === "") {
                issues.push({ path: file, line, message: "Markdown link has an empty target", anchor: "empty-link" });
                continue;
            }
            if (EXTERNAL.test(raw)) {
                continue;
            }
            const target = resolveTarget(file, raw);
            if (target === undefined || target === ".") {
                continue;
            }
            if (target.startsWith("..")) {
                issues.push({
                    path: file,
                    line,
                    message: `Link ${raw} escapes the repository`,
                    evidence: raw,
                    anchor: raw,
                });
                continue;
            }
            if (!ctx.snapshot.exists(target)) {
                issues.push({
                    path: file,
                    line,
                    message: `Link target ${raw} does not resolve`,
                    evidence: target,
                    anchor: raw,
                });
            }
        }
    }
    return issues;
}

export const DOC_RULES: Rule[] = [
    {
        id: "DOC-001",
        severity: "error",
        description: "Documentation links resolve",
        criteria: "every relative markdown link points at a tracked file or directory",
        check: checkDocLinks,
    },
];
