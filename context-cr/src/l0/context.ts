import { posix } from "node:path";
import {
    AGENTS_FILE,
    AGENTS_MAX_BYTES,
    AGENTS_MAX_LINES,
    BUDGET_MAX_BYTES,
    ERROR,
    README_FILE,
    RULE,
    SKILL_FILE,
} from "../constants.ts";
import { makeFinding } from "../contract/finding.ts";
import type { Finding } from "../contract/finding.ts";
import { isExcluded } from "../config.ts";
import type { RepoConfig } from "../config.ts";
import { ancestorDirs, baseName, inDir } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

function bytes(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/** HC-CONTEXT: README.md and AGENTS.md pair in both directions; AGENTS stays small. */
export function checkContext(snapshot: Snapshot, config: RepoConfig): Finding[] {
    const findings: Finding[] = [];
    for (const file of snapshot.files) {
        const name = baseName(file);
        if ((name !== AGENTS_FILE && name !== README_FILE) || isExcluded(config, file)) {
            continue;
        }
        const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
        const pair = inDir(dir, name === AGENTS_FILE ? README_FILE : AGENTS_FILE);
        if (!snapshot.exists(pair)) {
            const message = `${file} has no paired ${baseName(pair)}`;
            findings.push(makeFinding(RULE.context, ERROR, file, 1, message, pair));
        }
        if (name !== AGENTS_FILE) {
            continue;
        }
        const text = snapshot.read(file) ?? "";
        const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
        if (lines >= AGENTS_MAX_LINES || bytes(text) >= AGENTS_MAX_BYTES) {
            const message = `AGENTS.md must stay under ${AGENTS_MAX_LINES} lines and ${AGENTS_MAX_BYTES} bytes`;
            const evidence = `${lines} lines, ${bytes(text)} bytes`;
            findings.push(makeFinding(RULE.context, ERROR, file, AGENTS_MAX_LINES, message, evidence, "size"));
        }
    }
    return findings;
}

function frontMatter(text: string): string {
    const match = /^---\n[\s\S]*?\n---\n?/.exec(text);
    return match ? match[0] : "";
}

/**
 * Skill injection upper bound: every skill's front matter is resident (L1), plus the largest
 * concurrentSkills full SKILL.md bodies that can be loaded together (L2).
 */
export function skillInjection(snapshot: Snapshot, config: RepoConfig): number {
    const skills = snapshot.files.filter(
        (file) =>
            baseName(file) === SKILL_FILE &&
            config.skillRoots.some((root) => file.startsWith(root.replace(/\/+$/, "") + "/")),
    );
    const resident = skills.reduce((sum, file) => sum + bytes(frontMatter(snapshot.read(file) ?? "")), 0);
    const bodies = skills
        .map((file) => {
            const text = snapshot.read(file) ?? "";
            return bytes(text) - bytes(frontMatter(text));
        })
        .sort((a, b) => b - a)
        .slice(0, config.concurrentSkills);
    return resident + bodies.reduce((sum, size) => sum + size, 0);
}

/** HC-BUDGET: ancestor AGENTS chain plus skill injection for every tracked file's directory. */
export function checkBudget(snapshot: Snapshot, config: RepoConfig): Finding[] {
    const skills = skillInjection(snapshot, config);
    const seen = new Map<string, number>();
    const findings: Finding[] = [];
    for (const file of snapshot.files) {
        if (isExcluded(config, file)) {
            continue;
        }
        const dirs = ancestorDirs(file);
        const key = dirs[dirs.length - 1];
        if (seen.has(key)) {
            continue;
        }
        let total = skills;
        for (const dir of dirs) {
            total += bytes(snapshot.read(inDir(dir, AGENTS_FILE)) ?? "");
        }
        seen.set(key, total);
        if (total > BUDGET_MAX_BYTES) {
            const target = inDir(key, AGENTS_FILE);
            const where = snapshot.exists(target) ? target : file;
            const message = `Injected context for ${key || "."} is ${total} bytes, limit ${BUDGET_MAX_BYTES}`;
            findings.push(makeFinding(RULE.budget, ERROR, where, 1, message, `skills ${skills} bytes`, key));
        }
    }
    return findings;
}
