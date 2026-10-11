import { execFileSync } from "node:child_process";
import { GIT_MAX_BUFFER, UTF8, ZERO_SHA } from "./constants.ts";

export type Change = { status: string; path: string; oldPath?: string };

export function git(root: string, args: string[], input?: string, env?: Record<string, string>): string {
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
    const options = { cwd: root, encoding: UTF8 as BufferEncoding, maxBuffer: GIT_MAX_BUFFER, input, stdio };
    return execFileSync("git", args, env ? { ...options, env: { ...process.env, ...env } } : options);
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

const STRUCTURAL =
    /^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index|GIT binary patch|Binary files )/;

/**
 * True for a text edit of exactly one existing file. `git apply --numstat` reports only paths, so creates,
 * deletes, mode changes (including turning a file into a symlink), renames and binary patches are refused here.
 */
export function isPlainEdit(patch: string): boolean {
    const lines = patch.split("\n");
    if (lines.some((line) => STRUCTURAL.test(line))) {
        return false;
    }
    const headers = lines.filter((line, index) => line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ "));
    return headers.length === 1 && lines.filter((line) => line.startsWith("diff --git ")).length <= 1;
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
            // Only the first two tabs separate the counts; a path may itself contain tabs.
            const fields = tokens[index].split("\t");
            if (fields.length < 3) {
                continue;
            }
            const path = fields.slice(2).join("\t");
            if (path) {
                files.push(path);
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
