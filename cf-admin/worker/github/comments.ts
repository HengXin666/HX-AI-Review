// Leave review results on GitHub as the App (bot identity), instead of with the workflow's GITHUB_TOKEN.
import { createCommitComment, upsertIssueComment } from "./client.ts";
import type { GitHubDeps } from "./deps.ts";
import { installationFor, repoScopedToken } from "./tokens.ts";

/** push events: one commit comment on the reviewed sha. */
export async function commentOnCommit(gh: GitHubDeps, repo: string, sha: string, body: string) {
    // Scoped to this repository: a comment never needs to reach the rest of the installation.
    const token = await repoScopedToken(gh, await installationFor(gh, repo), repo);
    return createCommitComment(gh.fetch, token, repo, sha, body);
}

/** pull_request events: update the comment carrying marker (one per kind) or create it. */
export async function commentOnPullRequest(gh: GitHubDeps, repo: string, pr: number, marker: string, body: string) {
    const token = await repoScopedToken(gh, await installationFor(gh, repo), repo);
    return upsertIssueComment(gh.fetch, token, repo, pr, marker, body);
}
