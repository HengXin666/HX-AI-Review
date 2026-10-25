import { posix } from "node:path";
import { AGENTS_FILE } from "../constants.ts";
import { isExcluded } from "../config.ts";
import type { RepoConfig } from "../config.ts";
import type { Change } from "../git.ts";
import { candidates, contextRefs } from "../l0/refs.ts";
import { ancestorDirs, baseName, inDir, isContextFile } from "../l0/snapshot.ts";
import type { Snapshot } from "../l0/snapshot.ts";

export type ScopeEntry = { path: string; reasons: string[] };
/** `kind` is the discriminant that tells a context scope from a code scope. */
export type ContextScope = {
    kind: "context";
    base: string;
    head: string;
    changed: string[];
    contexts: ScopeEntry[];
};

/** Reverse reference index: referenced path (file or directory) -> context files pointing at it. */
export type RefIndex = Record<string, string[]>;

/** Prototype-free so path names like `constructor` or `__proto__` never hit inherited members. */
function emptyIndex(): RefIndex {
    return Object.create(null) as RefIndex;
}

export function buildRefIndex(snapshot: Snapshot, config: RepoConfig): RefIndex {
    const index = emptyIndex();
    for (const ref of contextRefs(snapshot, config)) {
        for (const target of candidates(ref, config.skillRoots)) {
            (index[target] ??= []).push(ref.from);
        }
    }
    for (const key of Object.keys(index)) {
        index[key] = [...new Set(index[key])].sort();
    }
    return index;
}

function ignored(config: RepoConfig, path: string): boolean {
    return isExcluded(config, path) || config.scopeIgnore.some((item) => path === item || baseName(path) === item);
}

/**
 * diff -> ancestor AGENTS chain + reverse references -> affected context files.
 * An empty result means the run ends with zero model calls.
 */
export function computeScope(
    snapshot: Snapshot,
    config: RepoConfig,
    changes: Change[],
    base: string,
    head: string,
    hint: RefIndex = emptyIndex(),
): ContextScope {
    const index = buildRefIndex(snapshot, config);
    for (const [target, froms] of Object.entries(hint)) {
        if (!Array.isArray(froms)) {
            continue;
        }
        index[target] = [...new Set([...(index[target] ?? []), ...froms.filter((file) => snapshot.exists(file))])];
    }
    const entries = new Map<string, Set<string>>();
    const add = (path: string, reason: string): void => {
        if (snapshot.exists(path) && !isExcluded(config, path)) {
            (entries.get(path) ?? entries.set(path, new Set()).get(path)!).add(reason);
        }
    };
    const changed = changes.flatMap((item) => (item.oldPath ? [item.path, item.oldPath] : [item.path]));
    for (const path of new Set(changed)) {
        if (ignored(config, path)) {
            continue;
        }
        if (isContextFile(path)) {
            add(path, "changed");
        }
        for (const dir of ancestorDirs(path)) {
            add(inDir(dir, AGENTS_FILE), "ancestor of " + path);
            for (const from of index[dir] ?? []) {
                add(from, "references " + dir + "/");
            }
        }
        for (const from of index[path] ?? []) {
            add(from, "references " + path);
        }
        if (baseName(path) === AGENTS_FILE) {
            const dir = posix.dirname(path) === "." ? "" : posix.dirname(path) + "/";
            for (const file of snapshot.files) {
                if (file !== path && file.startsWith(dir) && baseName(file) === AGENTS_FILE) {
                    add(file, "descendant of " + path);
                }
            }
        }
    }
    const contexts = [...entries.entries()]
        .map(([path, reasons]) => ({ path, reasons: [...reasons].sort() }))
        .sort((a, b) => a.path.localeCompare(b.path));
    return { kind: "context", base, head, changed: [...new Set(changed)].sort(), contexts };
}
