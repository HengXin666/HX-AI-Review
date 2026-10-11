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
export function pushPatchBranch(root: string, head: string, patches: Patch[]): string | undefined {
    const usable = patches.filter((item) => item.applies);
    if (!usable.length) {
        return undefined;
    }
    const branch = PATCH_BRANCH_PREFIX + head.slice(0, 12);
    git(root, ["switch", "--force-create", branch, head]);
    try {
        for (const patch of usable) {
            git(root, ["apply", "--index", "-"], patch.diff);
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
        git(root, ["push", "--force", "origin", "HEAD:refs/heads/" + branch]);
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
