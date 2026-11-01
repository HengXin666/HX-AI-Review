// Leave review results on GitHub as the App (bot identity), instead of with the workflow's GITHUB_TOKEN.
import { createCommitComment, upsertIssueComment } from "./client.ts";
import type { GitHubDeps } from "./deps.ts";
import { installationFor, installationToken } from "./tokens.ts";

/** push events: one commit comment on the reviewed sha. */
export async function commentOnCommit(gh: GitHubDeps, repo: string, sha: string, body: string) {
    const token = await installationToken(gh, await installationFor(gh, repo));
    return createCommitComment(gh.fetch, token, repo, sha, body);
}

/** pull_request events: update the comment carrying marker (one per kind) or create it. */
export async function commentOnPullRequest(gh: GitHubDeps, repo: string, pr: number, marker: string, body: string) {
    const token = await installationToken(gh, await installationFor(gh, repo));
    return upsertIssueComment(gh.fetch, token, repo, pr, marker, body);
}
