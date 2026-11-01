// Admin handlers for the GitHub App, plus handleGitHub, which router.ts mounts for /api/github/*. Every handler here
// requires an admin; the one-click handlers in connect.ts are routed here too (app/callback is the one public route).
import { repoFromToken, requireAdmin } from "../auth.ts";
import { HttpError, json, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import { getApp, listInstallationRepos, listInstallations, toHttpError } from "./client.ts";
import { handleAppCallback, handleAppManifest, handleDisable, handleEnable, handleListRepos } from "./connect.ts";
import { requireKek } from "./crypto.ts";
import type { GitHubDeps } from "./deps.ts";
import { importAppKey } from "./jwt.ts";
import type { AppInput, AppView } from "./store.ts";
import { installationFor, installationToken, jwtFor, mintScoped } from "./tokens.ts";

const WORKFLOW_FILE = /^[\w.-]+\.ya?ml$/;

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
    const value = body[name];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new HttpError(400, `${name} must be a string`);
    }
    return value;
}

function requiredString(body: Record<string, unknown>, name: string): string {
    const value = optionalString(body, name);
    if (!value) {
        throw new HttpError(400, `${name} must be a nonempty string`);
    }
    return value;
}

function appBody(app: AppView | null, request: Request) {
    return {
        configured: Boolean(app && app.hasPrivateKey && app.hasWebhookSecret),
        app,
        webhookUrl: new URL("/api/webhook/github", request.url).toString(),
    };
}

async function rethrowGitHub<T>(work: Promise<T>): Promise<T> {
    try {
        return await work;
    } catch (error) {
        throw toHttpError(error);
    }
}

/** GET /api/github/app: public fields plus has* flags; never a private key, client secret or webhook secret. */
export async function handleGetApp(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    return json(appBody(await gh.store.app(), request));
}

/** POST /api/github/app: create or update. Secrets omitted on update keep their stored value. */
export async function handlePostApp(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    const kek = requireKek(gh.secret);
    const body = await readJson(request);
    const rawAppId = body.appId;
    const appId = typeof rawAppId === "number" ? String(rawAppId) : rawAppId;
    if (typeof appId !== "string" || !/^\d+$/.test(appId)) {
        throw new HttpError(400, "appId must be the numeric GitHub App id");
    }
    const input: AppInput = {
        appId,
        slug: requiredString(body, "slug"),
        clientId: optionalString(body, "clientId"),
        clientSecret: optionalString(body, "clientSecret"),
        privateKey: optionalString(body, "privateKey"),
        webhookSecret: optionalString(body, "webhookSecret"),
        workflowFile: optionalString(body, "workflowFile"),
    };
    if (input.privateKey !== undefined) {
        // Reject a key WebCrypto cannot use now, instead of failing on the first webhook.
        await importAppKey(input.privateKey);
    }
    if (input.webhookSecret !== undefined && input.webhookSecret.length < 16) {
        throw new HttpError(400, "webhookSecret must be at least 16 characters");
    }
    if (input.workflowFile !== undefined && !WORKFLOW_FILE.test(input.workflowFile)) {
        throw new HttpError(400, "workflowFile must be a file name like hx-context-review.yml");
    }
    const app = await gh.store.saveApp(input, kek, gh.now().toISOString());
    return json(appBody(app, request));
}

/** POST /api/github/app/verify: sign a JWT with the stored key and call GET /app and GET /app/installations. */
export async function handleVerifyApp(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    const app = await gh.store.app();
    if (!app) {
        throw new HttpError(400, "GitHub App is not configured; POST /api/github/app first");
    }
    const now = gh.now().toISOString();
    const jwt = await jwtFor(gh);
    try {
        const info = await getApp(gh.fetch, jwt);
        if (String(info.id) !== app.appId) {
            throw new HttpError(422, `private key belongs to app ${info.id}, not ${app.appId}`);
        }
        const installations = await listInstallations(gh.fetch, jwt);
        await gh.store.setAppStatus("verified", now);
        if (installations.length > 0) {
            await gh.store.markInstalled(now);
        }
        return json({
            ok: true,
            app: { id: info.id, slug: info.slug, name: info.name, owner: info.owner?.login ?? null },
            installations: installations.length,
        });
    } catch (error) {
        const mapped = toHttpError(error);
        if (mapped instanceof HttpError && (mapped.status === 422 || mapped.status === 403)) {
            await gh.store.setAppStatus("invalid", now);
        }
        throw mapped;
    }
}

/** GET /api/github/installations: every installation with the repositories it reaches, refreshed from GitHub. */
export async function handleListInstallations(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    const now = gh.now().toISOString();
    const installations = await rethrowGitHub(jwtFor(gh).then((jwt) => listInstallations(gh.fetch, jwt)));
    const out = [];
    for (const item of installations) {
        const suspended = Boolean(item.suspended_at);
        const repos = suspended
            ? []
            : await rethrowGitHub(
                  installationToken(gh, item.id)
                      .then((token) => listInstallationRepos(gh.fetch, token, 1, 100))
                      .then((result) => result.repos),
              );
        await gh.store.upsertInstallation(
            {
                installationId: item.id,
                account: item.account?.login ?? "",
                accountType: item.account?.type ?? "",
                repositorySelection: item.repository_selection,
                status: suspended ? "suspended" : "active",
                repos: suspended ? undefined : repos.map((repo) => repo.full_name),
            },
            now,
        );
        const listed = [];
        for (const repo of repos) {
            const registered = await gh.store.registeredRepo(repo.full_name);
            listed.push({
                fullName: repo.full_name,
                defaultBranch: repo.default_branch,
                private: repo.private,
                registered: Boolean(registered),
                kind: registered?.kind ?? null,
            });
        }
        out.push({
            installationId: item.id,
            account: item.account?.login ?? "",
            accountType: item.account?.type ?? "",
            repositorySelection: item.repository_selection,
            suspended,
            repos: listed,
        });
    }
    if (out.length > 0) {
        await gh.store.markInstalled(now);
    }
    return json({ installations: out });
}

/**
 * GET /github/token: the runner's HX_CTX_TOKEN mints an installation token for its own repository only, so a
 * review comment appears as the App instead of github-actions[bot]. Any admin route could not serve this: the
 * caller is the runner, which has no admin session, and the repo comes from the token it already holds.
 */
export async function handleRunnerToken(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const app = await gh.store.app();
    if (!app || !app.hasPrivateKey) {
        throw new HttpError(404, "GitHub App is not configured");
    }
    const installationId = await installationFor(gh, repo.name);
    // Scoped to the runner's own repository and uncached: a shared cache is how one repo would act as another.
    const minted = await mintScoped(gh, installationId, repo.name);
    return json({ token: minted.token, expiresAt: minted.expiresAt, bot: app.slug + "[bot]", installationId });
}

/** GET /api/github/queue?repo=o/r&limit=50: webhook-triggered reviews, newest first. */
export async function handleListQueue(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    const url = new URL(request.url);
    const limitText = url.searchParams.get("limit");
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new HttpError(400, "limit must be an integer from 1 to 200");
    }
    return json({ items: await gh.store.listQueue(url.searchParams.get("repo") || undefined, limit) });
}

/** Convenience router for /api/github/*; segments are the path after /api/github. */
export function handleGitHub(request: Request, deps: Deps, gh: GitHubDeps, segments: string[]): Promise<Response> {
    const key = request.method + " " + segments.join("/");
    switch (key) {
        case "GET app":
            return handleGetApp(request, deps, gh);
        case "POST app":
            return handlePostApp(request, deps, gh);
        case "POST app/verify":
            return handleVerifyApp(request, deps, gh);
        case "GET installations":
            return handleListInstallations(request, deps, gh);
        case "GET queue":
            return handleListQueue(request, deps, gh);
        // One-click connection (connect.ts). app/callback is the only route here without requireAdmin: GitHub
        // redirects the browser to it, and the one-time state from app/manifest proves an admin started the flow.
        case "GET app/manifest":
            return handleAppManifest(request, deps, gh);
        case "GET app/callback":
            return handleAppCallback(request, deps, gh);
        case "GET repos":
            return handleListRepos(request, deps, gh);
        case "POST enable":
            return handleEnable(request, deps, gh);
        case "POST disable":
            return handleDisable(request, deps, gh);
        default:
            throw new HttpError(404, "not found");
    }
}
