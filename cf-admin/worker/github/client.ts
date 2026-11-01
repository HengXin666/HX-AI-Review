// Thin GitHub REST client. Every call takes the fetch to use, so tests stub GitHub without touching globals.
import { HttpError } from "../http.ts";

export const GITHUB_API = "https://api.github.com";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export type GitHubAppInfo = { id: number; slug: string; name: string; owner?: { login: string } };
export type GitHubInstallation = {
    id: number;
    account: { login: string; type: string } | null;
    repository_selection: string;
    suspended_at: string | null;
};
export type GitHubRepo = { full_name: string; default_branch: string; private: boolean };
export type InstallationToken = { token: string; expires_at: string };

function repoPath(repo: string): string {
    const [owner, name] = repo.split("/");
    if (!owner || !name) {
        throw new HttpError(400, `repository must be owner/name, got ${repo}`);
    }
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** auth "" sends no Authorization header (the manifest conversion authenticates with its one-time code). */
export async function githubRequest<T>(
    fetchFn: Fetch,
    method: string,
    path: string,
    auth: string,
    body?: unknown,
): Promise<T> {
    const response = await fetchFn(GITHUB_API + path, {
        method,
        headers: {
            accept: "application/vnd.github+json",
            ...(auth ? { authorization: "Bearer " + auth } : {}),
            "x-github-api-version": "2022-11-28",
            "user-agent": "hx-context-review",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        const text = await response.text();
        let message = text;
        try {
            message = (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {
            // keep the raw text
        }
        throw new GitHubApiError(
            response.status,
            `GitHub ${method} ${path}: ${response.status} ${message}`.slice(0, 500),
        );
    }
    // 204, and 201 with an empty body (PUT actions/secrets on create), carry no JSON.
    const text = response.status === 204 ? "" : await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
}

/** Map a GitHub failure to a readable 4xx for the admin API; GitHub outages become 502. */
export function toHttpError(error: unknown): unknown {
    if (!(error instanceof GitHubApiError)) {
        return error;
    }
    if (error.status === 401) {
        return new HttpError(
            422,
            "GitHub rejected the app credentials (check app id and private key): " + error.message,
        );
    }
    if (error.status === 403) {
        return new HttpError(403, "GitHub denied the request (missing app permission?): " + error.message);
    }
    if (error.status >= 400 && error.status < 500) {
        return new HttpError(error.status, error.message);
    }
    return new HttpError(502, "GitHub is unavailable: " + error.message);
}

export function getApp(fetchFn: Fetch, jwt: string): Promise<GitHubAppInfo> {
    return githubRequest(fetchFn, "GET", "/app", jwt);
}

export function listInstallations(fetchFn: Fetch, jwt: string): Promise<GitHubInstallation[]> {
    return githubRequest(fetchFn, "GET", "/app/installations?per_page=100", jwt);
}

/** The same permission set main asked for: what posting a review and writing a caller workflow need. */
const INSTALLATION_PERMISSIONS = {
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
} as const;

/**
 * `repo` narrows the token to one repository; an empty string asks for an installation-wide token. Narrowing
 * matters: the runner only ever acts on its own repository, so its token should not reach the others.
 */
export function createInstallationToken(
    fetchFn: Fetch,
    jwt: string,
    installationId: number,
    repo: string,
): Promise<InstallationToken> {
    const name = repo.split("/")[1];
    const scope = name
        ? { repositories: [name], permissions: INSTALLATION_PERMISSIONS }
        : { permissions: INSTALLATION_PERMISSIONS };
    return githubRequest(fetchFn, "POST", `/app/installations/${installationId}/access_tokens`, jwt, scope);
}

export async function listInstallationRepos(
    fetchFn: Fetch,
    token: string,
    page = 1,
    perPage = 32,
): Promise<{ repos: GitHubRepo[]; totalCount: number }> {
    const body = await githubRequest<{ repositories: GitHubRepo[]; total_count?: number }>(
        fetchFn,
        "GET",
        `/installation/repositories?per_page=${perPage}&page=${page}`,
        token,
    );
    return { repos: body.repositories ?? [], totalCount: body.total_count ?? 0 };
}

export function dispatchWorkflow(
    fetchFn: Fetch,
    token: string,
    repo: string,
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
): Promise<void> {
    const path = `${repoPath(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
    return githubRequest(fetchFn, "POST", path, token, { ref, inputs });
}

export function createCommitComment(fetchFn: Fetch, token: string, repo: string, sha: string, body: string) {
    return githubRequest<{ id: number; html_url: string }>(
        fetchFn,
        "POST",
        `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/comments`,
        token,
        { body },
    );
}

/** Update the PR comment that starts with marker, or create one. One marker per kind keeps reviews apart. */
export async function upsertIssueComment(
    fetchFn: Fetch,
    token: string,
    repo: string,
    issue: number,
    marker: string,
    body: string,
) {
    const base = repoPath(repo);
    const comments = await githubRequest<{ id: number; body?: string }[]>(
        fetchFn,
        "GET",
        `${base}/issues/${issue}/comments?per_page=100`,
        token,
    );
    const text = body.startsWith(marker) ? body : marker + "\n" + body;
    const existing = comments.find((item) => item.body?.startsWith(marker));
    if (existing) {
        return githubRequest<{ id: number; html_url: string }>(
            fetchFn,
            "PATCH",
            `${base}/issues/comments/${existing.id}`,
            token,
            {
                body: text,
            },
        );
    }
    return githubRequest<{ id: number; html_url: string }>(fetchFn, "POST", `${base}/issues/${issue}/comments`, token, {
        body: text,
    });
}

// ---- App Manifest flow and one-click enable ----------------------------------------------------------------------

/** What POST /app-manifests/{code}/conversions hands back once: the new App with its secrets. */
export type ManifestConversion = {
    id: number;
    slug: string;
    name?: string;
    pem: string;
    webhook_secret: string | null;
    client_id: string;
    client_secret: string;
    owner?: { login: string };
};

/** Exchange the manifest code for the App credentials. Public endpoint: the code itself is the credential. */
export function convertManifest(fetchFn: Fetch, code: string): Promise<ManifestConversion> {
    return githubRequest(fetchFn, "POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, "");
}

function contentPath(repo: string, path: string): string {
    return `${repoPath(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** null on 404, so callers can tell "absent" from a real failure. */
async function orNull<T>(work: Promise<T>): Promise<T | null> {
    try {
        return await work;
    } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

export function getRepository(fetchFn: Fetch, token: string, repo: string): Promise<GitHubRepo> {
    return githubRequest(fetchFn, "GET", repoPath(repo), token);
}

/** The file's blob sha, or null when the file does not exist. */
export async function getFileSha(fetchFn: Fetch, token: string, repo: string, path: string): Promise<string | null> {
    const file = await orNull(githubRequest<{ sha: string }>(fetchFn, "GET", contentPath(repo, path), token));
    return file?.sha ?? null;
}

/** Create (sha omitted) or update (sha of the current blob) a file on the default branch. */
export function putFile(
    fetchFn: Fetch,
    token: string,
    repo: string,
    path: string,
    body: { message: string; content: string; sha?: string },
): Promise<{ content: { sha: string } | null; commit: { sha: string } }> {
    return githubRequest(fetchFn, "PUT", contentPath(repo, path), token, body);
}

export function getRepoPublicKey(
    fetchFn: Fetch,
    token: string,
    repo: string,
): Promise<{ key_id: string; key: string }> {
    return githubRequest(fetchFn, "GET", `${repoPath(repo)}/actions/secrets/public-key`, token);
}

/** Secret metadata (name and dates; GitHub never returns the value), or null when it is not set. */
export function getRepoSecret(
    fetchFn: Fetch,
    token: string,
    repo: string,
    name: string,
): Promise<{ name: string } | null> {
    return orNull(
        githubRequest(fetchFn, "GET", `${repoPath(repo)}/actions/secrets/${encodeURIComponent(name)}`, token),
    );
}

/** encryptedValue is a base64 libsodium sealed box made with the key from getRepoPublicKey. */
export function putRepoSecret(
    fetchFn: Fetch,
    token: string,
    repo: string,
    name: string,
    encryptedValue: string,
    keyId: string,
): Promise<void> {
    return githubRequest(fetchFn, "PUT", `${repoPath(repo)}/actions/secrets/${encodeURIComponent(name)}`, token, {
        encrypted_value: encryptedValue,
        key_id: keyId,
    });
}
