import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { AGENTS_FILE, DOCS_ROOT, MARKDOWN_EXT, README_FILE, SKILL_FILE, UTF8 } from "../constants.ts";
import { trackedFiles } from "../git.ts";

/** Read-only view of the repository at the reviewed head; tests supply an in-memory one. */
export type Snapshot = {
    files: string[];
    read(path: string): string | undefined;
    exists(path: string): boolean;
};

function build(files: string[], read: (path: string) => string | undefined): Snapshot {
    const set = new Set(files);
    const dirs = new Set<string>();
    for (const file of files) {
        let dir = posix.dirname(file);
        while (dir !== "." && !dirs.has(dir)) {
            dirs.add(dir);
            dir = posix.dirname(dir);
        }
    }
    return {
        files: [...files].sort(),
        read: (path) => (set.has(path) ? read(path) : undefined),
        exists: (path) => path === "." || path === "" || set.has(path) || dirs.has(path.replace(/\/$/, "")),
    };
}

export function worktreeSnapshot(root: string): Snapshot {
    return build(trackedFiles(root), (path) => readFileSync(join(root, path), UTF8));
}

export function memorySnapshot(content: Record<string, string>): Snapshot {
    return build(Object.keys(content), (path) => content[path]);
}

export function baseName(path: string): string {
    return posix.basename(path);
}

/** Directories from the repository root down to the file's own directory, root first. */
export function ancestorDirs(path: string): string[] {
    const dirs: string[] = [];
    let dir = posix.dirname(path);
    while (dir !== ".") {
        dirs.unshift(dir);
        dir = posix.dirname(dir);
    }
    return ["", ...dirs];
}

export function inDir(dir: string, name: string): string {
    return dir ? dir + "/" + name : name;
}

/** Files an agent reads as context: AGENTS/README/SKILL anywhere, plus markdown under docs. */
export function isContextFile(path: string): boolean {
    const name = baseName(path);
    if (name === AGENTS_FILE || name === README_FILE || name === SKILL_FILE) {
        return true;
    }
    return path.startsWith(DOCS_ROOT + "/") && path.endsWith(MARKDOWN_EXT);
}

export function lineOf(text: string, index: number): number {
    return text.slice(0, index).split("\n").length;
}
