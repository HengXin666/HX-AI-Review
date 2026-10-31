import { COMMENT_MARKER, ENV, PATCH_BRANCH_PREFIX } from "../constants.ts";
import type { Patch } from "../contract/finding.ts";
import { git } from "../git.ts";

export type GithubTarget = { apiUrl: string; repo: string; token: string };

export function githubTarget(): GithubTarget | undefined {
    const token = process.env[ENV.githubToken];
    const repo = process.env[ENV.githubRepository];
    if (!token || !repo) {
        return undefined;
    }
    return { apiUrl: process.env[ENV.githubApiUrl] ?? "https://api.github.com", repo, token };
}

async function call(target: GithubTarget, method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(target.apiUrl + "/repos/" + target.repo + path, {
        method,
        headers: {
            authorization: "Bearer " + target.token,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`GitHub ${method} ${path} failed with ${response.status}`);
    }
    return response.status === 204 ? undefined : response.json();
}

/** Push confirmed, applicable patches as one commit on hx-ctx/patch-<sha>; never touches the reviewed branch. */
/**
 * The reviewed checkout keeps no credentials (persist-credentials: false), so .git/config never holds the
 * token the model tools could read. The push passes it through the environment for this one command.
 */
function pushAuth(target: GithubTarget | undefined): Record<string, string> | undefined {
    if (!target) {
        return undefined;
    }
    const server = (process.env[ENV.githubServerUrl] ?? "https://github.com").replace(/\/+$/, "");
    const basic = Buffer.from("x-access-token:" + target.token).toString("base64");
    return {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
        GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + basic,
    };
}

export function pushPatchBranch(
    root: string,
    head: string,
    patches: Patch[],
    target?: GithubTarget,
): string | undefined {
    const usable = patches.filter((item) => item.applies);
    if (!usable.length) {
        return undefined;
    }
    const branch = PATCH_BRANCH_PREFIX + head.slice(0, 12);
    git(root, ["switch", "--force-create", branch, head]);
    try {
        let applied = 0;
        for (const patch of usable) {
            // Each patch was checked against head alone; overlapping ones may conflict here and are skipped.
            try {
                git(root, ["apply", "--index", "-"], patch.diff);
                applied++;
            } catch {
                process.stderr.write(`patch ${patch.fingerprint} conflicts with an earlier patch; skipped\n`);
            }
        }
        if (applied === 0) {
            return undefined;
        }
        const author = [
            "-c",
            "user.name=hx-context-review",
            "-c",
            "user.email=hx-context-review@users.noreply.github.com",
        ];
        git(root, [
            ...author,
            "commit",
            "--no-verify",
            "-m",
            `docs(context): apply hx-context-review patch for ${head.slice(0, 12)}`,
        ]);
        git(root, ["push", "--force", "origin", "HEAD:refs/heads/" + branch], undefined, pushAuth(target));
    } finally {
        git(root, ["switch", "--detach", head]);
    }
    return branch;
}

/** Compare page for opening a PR from the patch branch: into the PR head branch, else the default branch. */
export function compareUrl(target: GithubTarget, branch: string): string {
    const server = process.env[ENV.githubServerUrl] ?? "https://github.com";
    const into = process.env[ENV.githubHeadRef];
    const range = into ? `${encodeURIComponent(into)}...${encodeURIComponent(branch)}` : encodeURIComponent(branch);
    return `${server}/${target.repo}/compare/${range}?expand=1`;
}

/** PR: update our marked comment in place; push: one commit comment per reviewed head. */
export async function writeBack(target: GithubTarget, sha: string, body: string, prNumber?: number): Promise<void> {
    if (prNumber === undefined) {
        await call(target, "POST", `/commits/${sha}/comments`, { body });
        return;
    }
    const comments = (await call(target, "GET", `/issues/${prNumber}/comments?per_page=100`)) as {
        id: number;
        body?: string;
    }[];
    const mine = comments.find((item) => item.body?.startsWith(COMMENT_MARKER));
    if (mine) {
        await call(target, "PATCH", `/issues/comments/${mine.id}`, { body });
    } else {
        await call(target, "POST", `/issues/${prNumber}/comments`, { body });
    }
}

export type LineNote = { path: string; line: number; body: string };

const REVIEW_BODY_MAX = 60000;

/**
 * One pull-request review as the token's account (github-actions[bot], or a GitHub App when the workflow
 * passes an installation token). Comments land on the RIGHT side of the diff, which is the new file.
 * An empty comment list posts a body-only review, so the assembled diff is visible even with no findings.
 */
export async function postPullReview(
    target: GithubTarget,
    prNumber: number,
    sha: string,
    body: string,
    comments: LineNote[],
): Promise<void> {
    const text = body.length > REVIEW_BODY_MAX ? body.slice(0, REVIEW_BODY_MAX) + "\n\n…截断" : body;
    const payload: Record<string, unknown> = { commit_id: sha, event: "COMMENT", body: text };
    if (comments.length) {
        payload.comments = comments.map((item) => ({
            path: item.path,
            line: item.line,
            side: "RIGHT",
            body: item.body,
        }));
    }
    await call(target, "POST", `/pulls/${prNumber}/reviews`, payload);
}
