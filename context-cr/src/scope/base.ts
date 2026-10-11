import { existsSync, readFileSync } from "node:fs";
import { ENV, UTF8 } from "../constants.ts";
import { isAncestor, mergeBase } from "../git.ts";

export type EventInfo = { name: string; prNumber?: number; base: string; reason: string };

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
    if (event.pull_request) {
        const base = mergeBase(root, event.pull_request.base.sha, head);
        if (base) {
            return { name, prNumber, base, reason: "pull request merge-base" };
        }
    }
    if (isAncestor(root, lastSha, head) && lastSha !== head) {
        return { name, prNumber, base: lastSha, reason: "last reviewed sha" };
    }
    if (isAncestor(root, event.before, head)) {
        return { name, prNumber, base: event.before, reason: "push before" };
    }
    const branch = event.repository?.default_branch;
    const fallback = branch ? mergeBase(root, "origin/" + branch, head) : undefined;
    if (fallback && fallback !== head) {
        return { name, prNumber, base: fallback, reason: "default branch merge-base" };
    }
    return { name, prNumber, base: "", reason: "empty tree" };
}
