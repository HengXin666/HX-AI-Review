import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UTF8 } from "../constants.ts";
import { emptyTree, git, tryGit } from "../git.ts";

export type LocalChange = { status: string; path: string; oldPath?: string };
export type LocalBase = { base: string; label: string };

const DEFAULT_BASE_REFS = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

function resolveCommit(root: string, ref: string): string | undefined {
    return tryGit(root, ["rev-parse", "--verify", ref + "^{commit}"])?.trim() || undefined;
}

/** Resolve the revision the worktree is compared with; a requested ref must share history with HEAD. */
export function resolveLocalBase(root: string, requested?: string): LocalBase {
    const head = resolveCommit(root, "HEAD");
    if (!head) {
        return { base: "", label: "empty tree (no commits)" };
    }
    const ref = requested || DEFAULT_BASE_REFS.find((item) => resolveCommit(root, item));
    if (!ref) {
        return { base: head, label: "HEAD (worktree only)" };
    }
    const sha = resolveCommit(root, ref);
    if (!sha) {
        throw new Error("base ref not found: " + ref);
    }
    const merged = tryGit(root, ["merge-base", sha, head])?.trim();
    if (!merged) {
        throw new Error("no merge-base between " + ref + " and HEAD; fetch the full history first");
    }
    return { base: merged, label: ref + " merge-base" };
}

/** Changed paths between base and the worktree, including staged edits and untracked files. */
export function localChanges(root: string, base: string): LocalChange[] {
    const from = base || emptyTree(root);
    const raw = git(root, ["diff", "--name-status", "-z", "-M", from]).split("\0");
    const changes: LocalChange[] = [];
    for (let index = 0; index < raw.length - 1;) {
        const status = raw[index++];
        if (/^[RC]/.test(status)) {
            const oldPath = raw[index++];
            changes.push({ status, oldPath, path: raw[index++] });
        } else {
            changes.push({ status, path: raw[index++] });
        }
    }
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const path of untracked) {
        changes.push({ status: "A", path });
    }
    return changes;
}

/** Both sides of every change, so a rename is checked under its old and new name. */
export function changedPaths(changes: LocalChange[]): string[] {
    const paths = new Set<string>();
    for (const change of changes) {
        paths.add(change.path);
        if (change.oldPath) {
            paths.add(change.oldPath);
        }
    }
    return [...paths].sort();
}

/** Worktree content of a regular file; a directory or symlink reads as absent. */
export function readWorktree(root: string, path: string): string | undefined {
    const full = join(root, path);
    try {
        const stat = lstatSync(full);
        return stat.isFile() ? readFileSync(full, UTF8) : undefined;
    } catch {
        return undefined;
    }
}

/** Content of a path at a revision, or absent when that revision does not hold it. */
export function readAt(root: string, rev: string, path: string): string | undefined {
    return rev ? tryGit(root, ["show", rev + ":" + path]) : undefined;
}

/** Files present in the worktree, tracked or untracked, used for the repository-wide view of each change. */
export function trackedInWorktree(root: string): string[] {
    return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
}

/** True when the path exists in the worktree, whether tracked, untracked or a directory. */
export function existsInWorktree(root: string, path: string): boolean {
    return existsSync(join(root, path));
}
