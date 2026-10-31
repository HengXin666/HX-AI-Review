// One product-wide GitHub App. The overview saves it; customer repos install it; the runner
// asks here for a short-lived installation token and posts reviews as that app, not as the
// person who opened the pull request and not as github-actions[bot].
import { repoFromToken } from "../auth.ts";
import { appJwt, signaturesMatch, webhookSignature } from "../github/crypto.ts";
import { HttpError, field, json, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import type { GithubAppRow, GithubInstallation } from "../store/port.ts";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const ORG = /^[\w.-]{1,100}$/;
const APP_PERMISSIONS = {
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
} as const;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function githubFetch(deps: Deps): FetchLike {
    return deps.githubFetch ?? ((url, init) => fetch(url, init));
}

function baseUrl(deps: Deps): string {
    const url = deps.overviewUrl?.replace(/\/+$/, "");
    if (!url) {
        throw new HttpError(400, "OVERVIEW_URL is not set; the manifest needs a public callback");
    }
    return url;
}

export function botLogin(slug: string): string {
    return slug + "[bot]";
}

/** True when this installation may speak for the repository. */
export function installationCovers(item: GithubInstallation, repo: string): boolean {
    if (item.suspended) {
        return false;
    }
    const name = repo.toLowerCase();
    if (item.repos.some((entry) => entry.toLowerCase() === name)) {
        return true;
    }
    if (!item.allRepos) {
        return false;
    }
    return item.accountLogin.toLowerCase() === name.split("/")[0];
}

function publicView(deps: Deps, app: GithubAppRow | null, installations: GithubInstallation[]) {
    const origin = deps.overviewUrl?.replace(/\/+$/, "") ?? "";
    const listed = installations.map((item) => ({
        installationId: item.installationId,
        accountLogin: item.accountLogin,
        accountType: item.accountType,
        repos: item.repos,
        allRepos: item.allRepos,
        suspended: item.suspended,
    }));
    if (!app) {
        return { configured: false, webhookUrl: origin ? origin + "/github/webhook" : "", installations: listed };
    }
    return {
        configured: true,
        appId: app.appId,
        slug: app.slug,
        name: app.name,
        ownerLogin: app.ownerLogin,
        htmlUrl: app.htmlUrl,
        bot: botLogin(app.slug),
        installUrl: `https://github.com/apps/${app.slug}/installations/new`,
        webhookUrl: origin ? origin + "/github/webhook" : "",
        installations: listed,
    };
}

function pemOf(value: string): string {
    const pem = value.trim();
    if (!pem.includes("PRIVATE KEY") || pem.length > 20000) {
        throw new HttpError(400, "privateKey must be the app PEM");
    }
    return pem;
}

/** PUT /api/github/app — paste an app that was created by hand. The PEM is stored, never echoed. */
export async function handleGithubPut(request: Request, deps: Deps): Promise<Response> {
    const body = await readJson(request);
    const appId = body.appId;
    if (!Number.isSafeInteger(appId) || (appId as number) < 1) {
        throw new HttpError(400, "appId must be a positive integer");
    }
    const slug = field(body, "slug");
    if (!SLUG.test(slug)) {
        throw new HttpError(400, "slug must be the app's url slug, lowercase letters, digits and hyphens");
    }
    const name = body.name === undefined ? slug : field(body, "name");
    if (name.length > 34) {
        throw new HttpError(400, "name must be at most 34 characters");
    }
    const secret = field(body, "webhookSecret");
    if (secret.length < 8 || secret.length > 200) {
        throw new HttpError(400, "webhookSecret must be 8 to 200 characters");
    }
    await deps.store.saveGithubApp({
        appId: appId as number,
        slug,
        name,
        ownerLogin: typeof body.ownerLogin === "string" ? body.ownerLogin : "",
        htmlUrl: typeof body.htmlUrl === "string" ? body.htmlUrl : `https://github.com/apps/${slug}`,
        privateKey: pemOf(field(body, "privateKey")),
        webhookSecret: secret,
    });
    return json({ ok: true });
}

export async function handleGithubGet(deps: Deps): Promise<Response> {
    const [app, installations] = await Promise.all([deps.store.githubApp(), deps.store.listInstallations()]);
    return json(publicView(deps, app, installations));
}

/**
 * POST /api/github/manifest — start GitHub's manifest flow. The browser must POST the returned
 * manifest to `action`; GitHub then redirects to /api/github/setup with a one-time code.
 */
export async function handleGithubManifest(request: Request, deps: Deps): Promise<Response> {
    const origin = baseUrl(deps);
    const org = new URL(request.url).searchParams.get("org");
    if (org !== null && !ORG.test(org)) {
        throw new HttpError(400, "org must be a GitHub organization login");
    }
    const state = crypto.randomUUID().replace(/-/g, "");
    const expires = new Date(deps.now().getTime() + 60 * 60 * 1000).toISOString();
    await deps.store.putSetupState(state, expires);
    const action = org
        ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}`
        : `https://github.com/settings/apps/new?state=${state}`;
    const manifest = {
        name: "HX AI Review",
        url: origin,
        hook_attributes: { url: origin + "/github/webhook", active: true },
        redirect_url: origin + "/api/github/setup",
        public: true,
        default_permissions: APP_PERMISSIONS,
        default_events: ["installation", "installation_repositories", "pull_request"],
        description: "Reviews pull request diffs as the HX AI Review app, on the changed lines.",
    };
    return json({ action, state, manifest });
}

/** GET /api/github/setup — GitHub redirects the browser here. State, not the session, authorizes it. */
export async function handleGithubSetup(request: Request, deps: Deps): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) {
        throw new HttpError(400, "missing code or state");
    }
    const fresh = await deps.store.takeSetupState(state, deps.now().toISOString());
    if (!fresh) {
        throw new HttpError(400, "setup state is unknown or expired");
    }
    const response = await githubFetch(deps)(
        "https://api.github.com/app-manifests/" + encodeURIComponent(code) + "/conversions",
        {
            method: "POST",
            headers: { accept: "application/vnd.github+json", "content-type": "application/json" },
        },
    );
    if (!response.ok) {
        throw new HttpError(502, "github refused the manifest code");
    }
    const created = (await response.json()) as {
        id?: number;
        slug?: string;
        name?: string;
        pem?: string;
        webhook_secret?: string;
        html_url?: string;
        owner?: { login?: string };
    };
    if (!created.id || !created.slug || !created.pem || !created.webhook_secret) {
        throw new HttpError(502, "github manifest response is missing the app credentials");
    }
    await deps.store.saveGithubApp({
        appId: created.id,
        slug: created.slug,
        name: created.name || created.slug,
        ownerLogin: created.owner?.login ?? "",
        htmlUrl: created.html_url ?? `https://github.com/apps/${created.slug}`,
        privateKey: created.pem,
        webhookSecret: created.webhook_secret,
    });
    const html =
        "<!doctype html><meta charset=utf-8><title>GitHub App 已保存</title>" +
        "<p>HX AI Review 已登记到后端。正在回到总览。</p>" +
        '<script>location.replace("/#/github")</script>';
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

type InstallationPayload = {
    action?: string;
    installation?: {
        id?: number;
        account?: { login?: string; type?: string };
        repository_selection?: string;
    };
    repositories?: { full_name?: string }[];
    repositories_added?: { full_name?: string }[];
    repositories_removed?: { full_name?: string }[];
};

function names(list: { full_name?: string }[] | undefined): string[] {
    if (!list) {
        return [];
    }
    return list.flatMap((item) => (typeof item.full_name === "string" ? [item.full_name] : []));
}

async function applyInstallation(deps: Deps, event: string, payload: InstallationPayload): Promise<void> {
    const installation = payload.installation;
    const id = installation?.id;
    if (!id) {
        return;
    }
    if (event === "installation" && payload.action === "deleted") {
        await deps.store.deleteInstallation(id);
        return;
    }
    const existing = (await deps.store.listInstallations()).find((item) => item.installationId === id);
    const account = installation?.account?.login || existing?.accountLogin || "";
    const accountType = installation?.account?.type || existing?.accountType || "Organization";
    let repos = existing?.repos ?? [];
    let allRepos = installation?.repository_selection
        ? installation.repository_selection === "all"
        : (existing?.allRepos ?? false);
    let suspended = existing?.suspended ?? false;
    if (event === "installation") {
        if (payload.repositories) {
            repos = names(payload.repositories);
        }
        if (payload.action === "suspend") {
            suspended = true;
        }
        if (payload.action === "unsuspend") {
            suspended = false;
        }
    }
    if (event === "installation_repositories") {
        const drop = new Set(names(payload.repositories_removed).map((name) => name.toLowerCase()));
        repos = repos.filter((name) => !drop.has(name.toLowerCase()));
        for (const name of names(payload.repositories_added)) {
            if (!repos.some((item) => item.toLowerCase() === name.toLowerCase())) {
                repos.push(name);
            }
        }
        allRepos = false;
    }
    if (!account) {
        return;
    }
    await deps.store.saveInstallation({
        installationId: id,
        accountLogin: account,
        accountType,
        repos,
        allRepos,
        suspended,
    });
}

/** POST /github/webhook — GitHub tells us where the app was installed. Signature is the credential. */
export async function handleGithubWebhook(request: Request, deps: Deps): Promise<Response> {
    const app = await deps.store.githubApp();
    if (!app) {
        throw new HttpError(404, "github app is not configured");
    }
    const body = await request.text();
    const given = request.headers.get("x-hub-signature-256") ?? "";
    const expected = await webhookSignature(app.webhookSecret, body);
    if (!signaturesMatch(expected, given)) {
        throw new HttpError(401, "bad webhook signature");
    }
    const event = request.headers.get("x-github-event") ?? "";
    if (event === "installation" || event === "installation_repositories") {
        await applyInstallation(deps, event, JSON.parse(body) as InstallationPayload);
    }
    return json({ ok: true });
}

/**
 * GET /github/token — the runner's HX_CTX_TOKEN may mint an installation token only for its own
 * repository. The token is what makes the review comment appear as the app.
 */
export async function handleGithubToken(request: Request, deps: Deps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const app = await deps.store.githubApp();
    if (!app) {
        throw new HttpError(404, "github app is not configured");
    }
    const installation = (await deps.store.listInstallations()).find((item) => installationCovers(item, repo.name));
    if (!installation) {
        throw new HttpError(404, "github app is not installed on this repository");
    }
    const jwt = await appJwt(app.appId, app.privateKey, deps.now());
    const name = repo.name.split("/")[1];
    const response = await githubFetch(deps)(
        `https://api.github.com/app/installations/${installation.installationId}/access_tokens`,
        {
            method: "POST",
            headers: {
                authorization: "Bearer " + jwt,
                accept: "application/vnd.github+json",
                "content-type": "application/json",
            },
            body: JSON.stringify({ repositories: [name], permissions: APP_PERMISSIONS }),
        },
    );
    if (!response.ok) {
        throw new HttpError(502, "github refused the installation token");
    }
    const minted = (await response.json()) as { token?: string; expires_at?: string };
    if (!minted.token) {
        throw new HttpError(502, "github installation token was empty");
    }
    return json({
        token: minted.token,
        expiresAt: minted.expires_at ?? "",
        bot: botLogin(app.slug),
        installationId: installation.installationId,
    });
}
