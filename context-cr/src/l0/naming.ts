import { posix } from "node:path";
import { DOCS_ROOT, ERROR, RULE, SKILL_FILE } from "../constants.ts";
import { makeFinding } from "../contract/finding.ts";
import type { Finding } from "../contract/finding.ts";
import { isExcluded } from "../config.ts";
import type { RepoConfig } from "../config.ts";
import { baseName, lineOf } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATED = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
const BANNED = /(^|-)(v[0-9]+|final|copy|bak|tmp|draft)(-|$)/;
const DOC_EXT = [".md", ".mdx", ".yaml"];
const ALLOWED = new Set([
    "README.md",
    "AGENTS.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "LICENSE.md",
    "SECURITY.md",
]);

function segmentProblem(segment: string, dir: string): string | undefined {
    if (BANNED.test(segment)) {
        return `segment "${segment}" carries a version or temporary word`;
    }
    if (DATED.test(segment)) {
        return dir.split("/").includes("decisions") ? undefined : `dated name "${segment}" outside decisions`;
    }
    return KEBAB.test(segment) ? undefined : `segment "${segment}" is not lowercase kebab-case`;
}

/** HC-DOCNAME: names under docs/ are lowercase kebab, docs extensions only, no v2/final copies. */
export function checkDocNames(snapshot: Snapshot, config: RepoConfig): Finding[] {
    const findings: Finding[] = [];
    for (const file of snapshot.files) {
        if (!file.startsWith(DOCS_ROOT + "/") || isExcluded(config, file) || file.includes("/archive/")) {
            continue;
        }
        const name = baseName(file);
        const allowed = ALLOWED.has(name);
        const ext = posix.extname(name);
        const stem = name.slice(0, name.length - ext.length);
        const dirs = posix.dirname(file).split("/").slice(1);
        const problems: string[] = [];
        if (!allowed && !DOC_EXT.includes(ext)) {
            problems.push(`extension "${ext || "none"}" is not md, mdx or yaml`);
        }
        // Allowed names (README.md, AGENTS.md, ...) exempt only the file name; directories are still checked.
        for (const [index, segment] of (allowed ? dirs : [...dirs, stem]).entries()) {
            const problem = segmentProblem(segment, dirs.slice(0, index + 1).join("/"));
            if (problem) {
                problems.push(problem);
            }
        }
        for (const problem of problems) {
            findings.push(makeFinding(RULE.docname, ERROR, file, 1, "Doc name rule: " + problem, file, problem));
        }
    }
    return findings;
}

/** CX-SKILL: every SKILL.md opens with front matter whose name matches its directory. */
export function checkSkills(snapshot: Snapshot, config: RepoConfig): Finding[] {
    const findings: Finding[] = [];
    for (const file of snapshot.files) {
        if (baseName(file) !== SKILL_FILE || isExcluded(config, file)) {
            continue;
        }
        const text = (snapshot.read(file) ?? "").replace(/\r\n/g, "\n");
        const head = /^---\n([\s\S]*?)\n---/.exec(text);
        const dir = baseName(posix.dirname(file));
        const problems: string[] = [];
        if (!head) {
            problems.push("missing YAML front matter");
        } else {
            const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(head[1])?.[1].trim();
            const description = /^description:\s*(.+)$/m
                .exec(head[1])?.[1]
                .replace(/^["']|["']$/g, "")
                .trim();
            if (name !== dir) {
                problems.push(`front matter name "${name ?? ""}" differs from directory "${dir}"`);
            }
            if (!description) {
                problems.push("front matter description is empty");
            }
        }
        for (const problem of problems) {
            const line = head ? lineOf(text, head.index) : 1;
            findings.push(makeFinding(RULE.skill, ERROR, file, line, "Skill entry: " + problem, dir, problem));
        }
    }
    return findings;
}
