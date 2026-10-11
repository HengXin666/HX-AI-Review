import { execFile, execFileSync } from "node:child_process";
import { GIT_MAX_BUFFER, GIT_TOOL_TIMEOUT_MS, UTF8, ZERO_SHA } from "./constants.ts";

export type Change = { status: string; path: string; oldPath?: string };

export function git(root: string, args: string[], input?: string, env?: Record<string, string>): string {
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
    const options = { cwd: root, encoding: UTF8 as BufferEncoding, maxBuffer: GIT_MAX_BUFFER, input, stdio };
    return execFileSync("git", args, env ? { ...options, env: { ...process.env, ...env } } : options);
}

/**
 * Async git with a kill timer. The model tools run through this: execFileSync would block the event loop,
 * so the session timer could not fire until a hung git returned and a slow tool could outlive its deadline.
 */
export function gitAsync(root: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            "git",
            args,
            { cwd: root, encoding: UTF8 as BufferEncoding, maxBuffer: GIT_MAX_BUFFER, timeout: timeoutMs, signal },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
    });
}

/** git exits 1 when a search simply found nothing; that is an empty result, not a failure. */
export function isNoMatch(error: unknown): boolean {
    return (error as { code?: unknown }).code === 1;
}

/**
 * A path absent from the revision makes git exit 128, without a kill or an abort. Classifying on those
 * signals rather than on git's message keeps this correct under any locale; a timeout or cancellation
 * is never mistaken for a missing file.
 */
export function isMissingPath(error: unknown): boolean {
    return (error as { code?: unknown }).code === 128 && !wasKilled(error);
}

/** True when the subprocess was killed by its own timeout or by the caller's abort signal. */
export function wasKilled(error: unknown): boolean {
    return Boolean((error as { killed?: unknown }).killed) || (error as { code?: unknown }).code === "ABORT_ERR";
}

/** One-line reason for a failed git call, saying whether it timed out or was cancelled. */
export function describeGitError(error: unknown): string {
    if ((error as { code?: unknown }).code === "ABORT_ERR") {
        return "git call cancelled";
    }
    if ((error as { killed?: unknown }).killed) {
        return `git call timed out after ${GIT_TOOL_TIMEOUT_MS / 1000}s`;
    }
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    const first = stderr.split("\n")[0] || (error instanceof Error ? error.message.split("\n")[0] : String(error));
    return first;
}

/** Async `tryGit`: undefined when git fails (missing path, no matches), so callers can tell it from "". */
export async function tryGitAsync(root: string, args: string[], timeoutMs: number): Promise<string | undefined> {
    try {
        return await gitAsync(root, args, timeoutMs);
    } catch {
        return undefined;
    }
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
    const headers: [string, string][] = [];
    for (let index = 0; index < lines.length - 1; index++) {
        if (lines[index].startsWith("--- ") && lines[index + 1].startsWith("+++ ")) {
            headers.push([lines[index], lines[index + 1]]);
        }
    }
    if (headers.length !== 1 || lines.filter((line) => line.startsWith("diff --git ")).length > 1) {
        return false;
    }
    // "/dev/null" on either side means the patch creates or deletes the file, which is never pushed.
    return headers[0].every((header) => header.slice(4).split("\t")[0].trim() !== "/dev/null");
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
