import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, DOCS_ROOT, UTF8 } from "./constants.ts";
import { showFile } from "./git.ts";

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
    /**
     * File extensions no review reads. Binary and generated data cost tokens without anything to judge:
     * a changed lockfile-sized JSON or an edited image is never a defect a model can see.
     */
    ignoreExtensions: string[];
    /** Glob patterns no review reads, for paths an extension cannot express: `*.min.js`, `fixtures/**`. */
    ignoreGlobs: string[];
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

/**
 * Paths no L0 rule should judge. .agents/notes is written by the agent-notes tooling, so its layout is
 * that tool's decision: demanding a paired README.md beside a generated AGENTS.md reports a problem the
 * repository cannot fix by hand.
 *
 * .agents/skills is deliberately NOT excluded: HC-BUDGET and CX-SKILL exist to bound what a skill injects,
 * and skipping the tree would silently disable those rules instead of fixing a false positive.
 */
export const DEFAULT_EXCLUDES = [".agents/notes/"];

/**
 * Extensions no review reads. Everything here is either binary (an image, a font, an archive) or data a
 * model cannot judge (a lockfile, a source map, a certificate). The list is deliberately conservative:
 * source, config and documentation stay in scope, because a wrong call there is a real defect.
 */
export const DEFAULT_IGNORE_EXTENSIONS = [
    // Images and fonts.
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".bmp",
    ".ico",
    ".tif",
    ".tiff",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    // Media.
    ".mp3",
    ".mp4",
    ".wav",
    ".flac",
    ".ogg",
    ".webm",
    ".mov",
    ".avi",
    ".mkv",
    // Archives and binaries.
    ".zip",
    ".tar",
    ".gz",
    ".bz2",
    ".xz",
    ".7z",
    ".rar",
    ".pdf",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".wasm",
    ".node",
    ".class",
    ".jar",
    ".pyc",
    // Generated data a model cannot judge line by line.
    ".map",
    ".min.js",
    ".min.css",
    ".pem",
    ".crt",
    ".key",
    ".p12",
    ".pfx",
    ".lock",
    ".lockb",
    ".snap",
];

export const DEFAULT_CONFIG: RepoConfig = {
    skillRoots: [".agents/skills"],
    concurrentSkills: 1,
    orphanRoots: [DOCS_ROOT],
    exclude: DEFAULT_EXCLUDES,
    ignoreExtensions: DEFAULT_IGNORE_EXTENSIONS,
    ignoreGlobs: [],
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

/** Parse the config file text; absent keys and junk values keep their defaults. */
export function parseConfig(text: string): RepoConfig {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const concurrent = raw.concurrentSkills;
    return {
        skillRoots: stringList(raw.skillRoots, DEFAULT_CONFIG.skillRoots).map(trimSlash),
        concurrentSkills:
            typeof concurrent === "number" && Number.isInteger(concurrent) && concurrent >= 0
                ? concurrent
                : DEFAULT_CONFIG.concurrentSkills,
        orphanRoots: stringList(raw.orphanRoots, DEFAULT_CONFIG.orphanRoots),
        exclude: stringList(raw.exclude, DEFAULT_CONFIG.exclude),
        ignoreExtensions: stringList(raw.ignoreExtensions, DEFAULT_CONFIG.ignoreExtensions).map((item) =>
            item.toLowerCase(),
        ),
        ignoreGlobs: stringList(raw.ignoreGlobs, DEFAULT_CONFIG.ignoreGlobs),
        scopeIgnore: stringList(raw.scopeIgnore, DEFAULT_CONFIG.scopeIgnore),
        virtualPaths: stringList(raw.virtualPaths, DEFAULT_CONFIG.virtualPaths),
        baseline: typeof raw.baseline === "string" ? raw.baseline : undefined,
        evidencePrs: evidenceLimit(raw.evidencePrs, DEFAULT_CONFIG.evidencePrs),
        evidenceIssues: evidenceLimit(raw.evidenceIssues, DEFAULT_CONFIG.evidenceIssues),
    };
}

/** Config from the worktree. Local commands use it; CI steps use loadTrustedConfig. */
export function loadConfig(root: string): RepoConfig {
    const file = join(root, CONFIG_FILE);
    if (!existsSync(file)) {
        return DEFAULT_CONFIG;
    }
    return parseConfig(readFileSync(file, UTF8));
}

/**
 * Config from the trusted base commit. The reviewed change must not be able to widen `exclude` or move
 * `baseline` and so switch off the checks that judge it: what the base says applies to this run, and an
 * edit to the file takes effect only once it is merged. A missing or unparsable file at the base falls
 * back to the defaults. With no base (an empty-tree first run) the worktree is all there is.
 */
export function loadTrustedConfig(root: string, base: string): RepoConfig {
    if (!base) {
        return loadConfig(root);
    }
    const text = showFile(root, base, CONFIG_FILE);
    if (text === undefined) {
        return DEFAULT_CONFIG;
    }
    try {
        return parseConfig(text);
    } catch {
        return DEFAULT_CONFIG;
    }
}

export function isExcluded(config: RepoConfig, path: string): boolean {
    return config.exclude.some((prefix) => path === prefix || path.startsWith(prefix.replace(/\/?$/, "/")));
}

/**
 * The one predicate every scope uses to decide a path is out of review. It replaces two copies of a
 * weaker check that only knew path prefixes: a changed image or a regenerated lockfile was still sent to
 * the model, spending tokens on content nothing can judge.
 *
 * `deleted` is passed because a deletion is itself reviewable: removing a config file can be the defect,
 * so the ignore list applies to files that still exist, not to the change that removed them.
 */
export function isIgnoredPath(config: RepoConfig, path: string, deleted = false): boolean {
    if (isExcluded(config, path)) {
        return true;
    }
    if (config.scopeIgnore.some((item) => path === item || path.endsWith("/" + item) || baseNameOf(path) === item)) {
        return true;
    }
    if (deleted) {
        return false;
    }
    const lower = path.toLowerCase();
    if (config.ignoreExtensions.some((ext) => lower.endsWith(ext))) {
        return true;
    }
    return config.ignoreGlobs.some((glob) => globMatch(glob, path));
}

/** Last path segment; a local copy keeps config.ts free of a snapshot.ts import just for this. */
function baseNameOf(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * Minimal glob: `*` matches within one segment, `**` matches across segments, `?` one character. Anything
 * else is literal. A full glob engine is not worth a dependency for the two patterns a repo config uses.
 */
export function globMatch(glob: string, path: string): boolean {
    let pattern = "";
    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === "*" && glob[index + 1] === "*") {
            pattern += ".*";
            index += 1;
            // `**/` also matches zero segments, so a/b matches **/b.
            if (glob[index + 1] === "/") {
                pattern = pattern.slice(0, -2) + "(?:.*/)?";
                index += 1;
            }
        } else if (char === "*") {
            pattern += "[^/]*";
        } else if (char === "?") {
            pattern += "[^/]";
        } else {
            pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
    }
    return new RegExp("^" + pattern + "$").test(path);
}
