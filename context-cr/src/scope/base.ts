import { existsSync, readFileSync } from "node:fs";
import { ENV, UTF8 } from "../constants.ts";
import { isAncestor, mergeBase } from "../git.ts";

/** The review range start and the event facts publish needs; defaultBranch is absent outside GitHub. */
export type EventInfo = { name: string; prNumber?: number; base: string; reason: string; defaultBranch?: string };

type GithubEvent = {
    before?: string;
    pull_request?: { number: number; base: { sha: string } };
    repository?: { default_branch?: string };
};

/**
 * Review range start. last_sha from D1 wins when it is an ancestor of head so no commit is
 * skipped between serialized runs; otherwise PR merge-base, push before, default branch, empty.
 */
export function resolveBase(root: string, head: string, lastSha?: string): EventInfo {
    const name = process.env[ENV.githubEventName] ?? "local";
    const path = process.env[ENV.githubEventPath];
    const event: GithubEvent = path && existsSync(path) ? JSON.parse(readFileSync(path, UTF8)) : {};
    const prNumber = event.pull_request?.number;
    const defaultBranch = event.repository?.default_branch;
    if (event.pull_request) {
        const base = mergeBase(root, event.pull_request.base.sha, head);
        if (base) {
            return { name, prNumber, defaultBranch, base, reason: "pull request merge-base" };
        }
    }
    if (isAncestor(root, lastSha, head) && lastSha !== head) {
        return { name, prNumber, defaultBranch, base: lastSha, reason: "last reviewed sha" };
    }
    if (isAncestor(root, event.before, head)) {
        return { name, prNumber, defaultBranch, base: event.before, reason: "push before" };
    }
    const fallback = defaultBranch ? mergeBase(root, "origin/" + defaultBranch, head) : undefined;
    if (fallback && fallback !== head) {
        return { name, prNumber, defaultBranch, base: fallback, reason: "default branch merge-base" };
    }
    return { name, prNumber, defaultBranch, base: "", reason: "empty tree" };
}
