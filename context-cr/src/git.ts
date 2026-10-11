import { execFileSync } from "node:child_process";
import { GIT_MAX_BUFFER, UTF8, ZERO_SHA } from "./constants.ts";

export type Change = { status: string; path: string; oldPath?: string };

export function git(root: string, args: string[], input?: string): string {
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
    return execFileSync("git", args, { cwd: root, encoding: UTF8, maxBuffer: GIT_MAX_BUFFER, input, stdio });
}

export function tryGit(root: string, args: string[]): string | undefined {
    try {
        return git(root, args);
    } catch {
        return undefined;
    }
}

/** Write (idempotently) and return the empty tree, so it exists in this object database and hash format. */
export function emptyTree(root: string): string {
    return git(root, ["hash-object", "-t", "tree", "-w", "--stdin"], "").trim();
}

export function headSha(root: string): string {
    return git(root, ["rev-parse", "HEAD"]).trim();
}

/** True when sha exists in this clone and is an ancestor of head. */
export function isAncestor(root: string, sha: string | undefined, head: string): sha is string {
    if (!sha || ZERO_SHA.test(sha)) {
        return false;
    }
    return tryGit(root, ["merge-base", "--is-ancestor", sha, head]) !== undefined;
}

export function mergeBase(root: string, a: string, b: string): string | undefined {
    return tryGit(root, ["merge-base", a, b])?.trim() || undefined;
}

export function trackedFiles(root: string): string[] {
    return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

/** NUL-safe name-status parse; renames keep both names so reverse references still resolve. */
export function changedFiles(root: string, base: string, head: string): Change[] {
    const from = base || emptyTree(root);
    const raw = git(root, ["diff", "--name-status", "-z", "-M", from, head]).split("\0");
    const changes: Change[] = [];
    for (let i = 0; i < raw.length - 1;) {
        const status = raw[i++];
        if (/^[RC]/.test(status)) {
            const oldPath = raw[i++];
            changes.push({ status, path: raw[i++], oldPath });
        } else {
            changes.push({ status, path: raw[i++] });
        }
    }
    return changes;
}

export function diffText(root: string, base: string, head: string, paths: string[] = []): string {
    return git(root, ["diff", "--no-color", "-M", base || emptyTree(root), head, "--", ...paths]);
}

export function showFile(root: string, rev: string, path: string): string | undefined {
    return tryGit(root, ["show", rev + ":" + path]);
}

/**
 * Files a patch touches when it applies cleanly to the worktree, else undefined.
 * `--numstat` with `--check` validates without modifying anything.
 */
export function patchFiles(root: string, patch: string): string[] | undefined {
    try {
        // -z keeps non-ASCII paths raw instead of C-quoting them.
        const tokens = git(root, ["apply", "--check", "--numstat", "-z", "-"], patch).split("\0");
        const files: string[] = [];
        for (let index = 0; index < tokens.length; index++) {
            const fields = tokens[index].split("\t");
            if (fields.length < 3) {
                continue;
            }
            if (fields[2]) {
                files.push(fields[2]);
            } else {
                // Rename or copy: "added\tdeleted\t" then old and new paths as separate tokens.
                files.push(tokens[index + 1], tokens[index + 2]);
                index += 2;
            }
        }
        return files;
    } catch {
        return undefined;
    }
}
