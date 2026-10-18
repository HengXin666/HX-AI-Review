import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, DOCS_ROOT, UTF8 } from "./constants.ts";

/** Optional per-repo settings read from the checked-out caller repository. */
export type RepoConfig = {
    /** Directories holding skills; every SKILL.md counts toward HC-BUDGET. */
    skillRoots: string[];
    /** Skills that may be loaded at the same time beyond their resident front matter. */
    concurrentSkills: number;
    /** Roots whose markdown must be referenced from somewhere (CX-ORPHAN). */
    orphanRoots: string[];
    /** Path prefixes excluded from every L0 rule (vendored or generated content). */
    exclude: string[];
    /** Changed paths that never pull context into scope (lockfiles and similar). */
    scopeIgnore: string[];
    /** Generated or external path prefixes that references may name without them being tracked. */
    virtualPaths: string[];
    /** Repository-relative baseline of approved fingerprints, read from the trusted base. */
    baseline?: string;
    /** Recent pull requests attached to the finder evidence pack. 0 disables the search. */
    evidencePrs: number;
    /** Recent issues attached to the finder evidence pack. 0 disables the search. */
    evidenceIssues: number;
};

export const DEFAULT_CONFIG: RepoConfig = {
    skillRoots: [".agents/skills"],
    concurrentSkills: 1,
    orphanRoots: [DOCS_ROOT],
    exclude: [],
    scopeIgnore: ["pnpm-lock.yaml", "package-lock.json", "uv.lock", "yarn.lock"],
    virtualPaths: ["scripts/.hx_code_quality/"],
    evidencePrs: 5,
    evidenceIssues: 5,
};

export function trimSlash(path: string): string {
    return path.replace(/\/+$/, "");
}

function stringList(value: unknown, fallback: string[]): string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

/** Evidence limits are optional; a missing or junk value keeps the default, and the range is 0..20. */
function evidenceLimit(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        return fallback;
    }
    return Math.min(20, Math.max(0, value));
}

export function loadConfig(root: string): RepoConfig {
    const file = join(root, CONFIG_FILE);
    if (!existsSync(file)) {
        return DEFAULT_CONFIG;
    }
    const raw = JSON.parse(readFileSync(file, UTF8)) as Record<string, unknown>;
    const concurrent = raw.concurrentSkills;
    return {
        skillRoots: stringList(raw.skillRoots, DEFAULT_CONFIG.skillRoots).map(trimSlash),
        concurrentSkills:
            typeof concurrent === "number" && Number.isInteger(concurrent) && concurrent >= 0
                ? concurrent
                : DEFAULT_CONFIG.concurrentSkills,
        orphanRoots: stringList(raw.orphanRoots, DEFAULT_CONFIG.orphanRoots),
        exclude: stringList(raw.exclude, DEFAULT_CONFIG.exclude),
        scopeIgnore: stringList(raw.scopeIgnore, DEFAULT_CONFIG.scopeIgnore),
        virtualPaths: stringList(raw.virtualPaths, DEFAULT_CONFIG.virtualPaths),
        baseline: typeof raw.baseline === "string" ? raw.baseline : undefined,
        evidencePrs: evidenceLimit(raw.evidencePrs, DEFAULT_CONFIG.evidencePrs),
        evidenceIssues: evidenceLimit(raw.evidenceIssues, DEFAULT_CONFIG.evidenceIssues),
    };
}

export function isExcluded(config: RepoConfig, path: string): boolean {
    return config.exclude.some((prefix) => path === prefix || path.startsWith(prefix.replace(/\/?$/, "/")));
}
