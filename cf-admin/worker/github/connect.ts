// One-click GitHub connection: App Manifest registration, repository sync, enable / disable.
// Exported handlers only; handleGitHub in routes.ts mounts them (see .review/gh-connect-backend.md).
import { newToken, requireAdmin, sha256Hex } from "../auth.ts";
import { HttpError, json, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import {
    convertManifest,
    getFileSha,
    getRepoPublicKey,
    getRepoSecret,
    getRepository,
    listInstallationRepos,
    putFile,
    putRepoSecret,
    toHttpError,
} from "./client.ts";
import { b64, b64url, requireKek } from "./crypto.ts";
import type { GitHubDeps } from "./deps.ts";
import { importAppKey } from "./jwt.ts";
import { sealedBox } from "./sealbox.ts";
import { installationToken } from "./tokens.ts";
import { DEFAULT_WORKFLOW_TEMPLATE, renderWorkflow } from "./workflow-template.ts";
import type { RepoKindChoice } from "./workflow-template.ts";

export const MANIFEST_ACTION = "https://github.com/settings/apps/new";
export const STATE_TTL_MS = 10 * 60_000;
const STATE_SWEEP_MS = 24 * 3600_000;
export const APP_NAME_PREFIX = "hx-context-review-";
export const SECRET_NAME = "HX_CTX_TOKEN";
export const WORKFLOW_PATH = ".github/workflows/hx-context-review.yml";
export const ENABLE_COMMIT_MESSAGE = "chore: enable hx-context-review";
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorText(error: unknown): string {
    const mapped = toHttpError(error);
    return (mapped instanceof Error ? mapped.message : String(mapped)).slice(0, 300);
}

function origin(request: Request): string {
    return new URL(request.url).origin;
}

function redirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

// ---- GET /api/github/app/manifest ------------------------------------------------------------------------------

/** The GitHub App Manifest for this Worker (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). */
export function buildManifest(base: string, suffix: string) {
    return {
        name: APP_NAME_PREFIX + suffix,
        url: base,
        hook_attributes: { url: base + "/api/webhook/github", active: true },
        redirect_url: base + "/api/github/app/callback",
        public: false,
        default_permissions: {
            actions: "write",
            contents: "write",
            pull_requests: "write",
            issues: "write",
            metadata: "read",
            secrets: "write",
            workflows: "write",
        },
        // Only subscribable events belong here. installation and installation_repositories are App lifecycle
        // events GitHub delivers to every App; listing them makes GitHub reject the whole manifest with
        // "Default events unsupported" (and a second complaint that no permission backs them).
        default_events: ["push", "pull_request"],
    };
}

/** GET /api/github/app/manifest: a fresh one-time state (10 minutes) and the manifest to POST to GitHub. */
export async function handleAppManifest(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    const now = gh.now();
    const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
    await gh.store.createAppState(state, now.toISOString(), new Date(now.getTime() - STATE_SWEEP_MS).toISOString());
    const suffix = hex(crypto.getRandomValues(new Uint8Array(3)));
    return json({
        action: MANIFEST_ACTION,
        state,
        expiresAt: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
        manifest: buildManifest(origin(request), suffix),
    });
}

// ---- GET /api/github/app/callback ------------------------------------------------------------------------------

/**
 * GitHub sends the browser here after the App is created. No admin login: the one-time state proves the flow was
 * started by an admin. Bad state is 400 and touches nothing; every later failure redirects with ?error=<reason>.
 */
export async function handleAppCallback(request: Request, _deps: Deps, gh: GitHubDeps): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!state || !code) {
        throw new HttpError(400, "code and state are required");
    }
    const now = gh.now();
    const fresh = await gh.store.consumeAppState(
        state,
        new Date(now.getTime() - STATE_TTL_MS).toISOString(),
        now.toISOString(),
    );
    if (!fresh) {
        throw new HttpError(400, "unknown, expired or already used state");
    }
    const back = (query: string) => redirect(`${origin(request)}/#/github?${query}`);
    // Check the KEK before spending the one-time code: without it the App's secrets could never be stored.
    let kek: string;
    try {
        kek = requireKek(gh.secret);
    } catch {
        return back("error=kek_missing");
    }
    let conversion;
    try {
        conversion = await convertManifest(gh.fetch, code);
    } catch {
        return back("error=conversion_failed");
    }
    if (!conversion.pem || !conversion.webhook_secret) {
        return back("error=incomplete_credentials");
    }
    try {
        await importAppKey(conversion.pem);
        await gh.store.saveApp(
            {
                appId: String(conversion.id),
                slug: conversion.slug,
                clientId: conversion.client_id ?? "",
                clientSecret: conversion.client_secret ?? "",
                privateKey: conversion.pem,
                webhookSecret: conversion.webhook_secret,
            },
            kek,
            now.toISOString(),
        );
    } catch {
        return back("error=save_failed");
    }
    return back(`connected=1&slug=${encodeURIComponent(conversion.slug)}`);
}

// ---- GET /api/github/repos ---------------------------------------------------------------------------------------

function installationIdOf(value: unknown): number {
    const id = typeof value === "string" && value !== "" ? Number(value) : value;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
        throw new HttpError(400, "installationId must be a positive integer");
    }
    return id;
}

async function rethrowGitHub<T>(work: Promise<T>): Promise<T> {
    try {
        return await work;
    } catch (error) {
        throw toHttpError(error);
    }
}

/** ?page=n of GET /api/github/repos: 1-based, default 1, at most 1000. Anything else is a 400, never page 1. */
function pageOf(value: string | null): number {
    if (value === null) {
        return 1;
    }
    const page = /^[0-9]+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(page) || page < 1 || page > 1000) {
        throw new HttpError(400, "page must be an integer between 1 and 1000");
    }
    return page;
}

/** A probe that cannot answer (permission, outage) reads as "not installed" rather than failing the whole list. */
async function probe(work: Promise<unknown>): Promise<boolean> {
    try {
        return Boolean(await work);
    } catch {
        return false;
    }
}

/** GET /api/github/repos?installationId=n: the installation's repositories joined with the repos table. */
export async function handleListRepos(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    const installationId = installationIdOf(new URL(request.url).searchParams.get("installationId"));
    const page = pageOf(new URL(request.url).searchParams.get("page"));
    const token = await rethrowGitHub(installationToken(gh, installationId));
    const { repos, totalCount } = await rethrowGitHub(listInstallationRepos(gh.fetch, token, page));
    const workflowPath = (await gh.store.app())?.workflowFile;
    const path = workflowPath ? `.github/workflows/${workflowPath}` : WORKFLOW_PATH;
    const out = await Promise.all(
        repos.map(async (repo) => {
            const [registered, workflowInstalled, secretInstalled] = await Promise.all([
                gh.store.registeredRepo(repo.full_name),
                probe(getFileSha(gh.fetch, token, repo.full_name, path)),
                probe(getRepoSecret(gh.fetch, token, repo.full_name, SECRET_NAME)),
            ]);
            return {
                fullName: repo.full_name,
                defaultBranch: repo.default_branch,
                private: repo.private,
                registered: Boolean(registered),
                kind: registered?.kind ?? null,
                enabled: registered?.enabled ?? false,
                workflowInstalled,
                secretInstalled,
            };
        }),
    );
    // Keep the installation's repository list current so webhooks and comments find this installation.
    // changeInstallationRepos merges (adds, never drops what it is not given); only page 1 syncs, per the paging task.
    if (page === 1) {
        await gh.store.changeInstallationRepos(
            installationId,
            repos.map((repo) => repo.full_name),
            [],
            gh.now().toISOString(),
        );
    }
    return json({ installationId, page, totalCount, repos: out });
}

// ---- POST /api/github/enable -------------------------------------------------------------------------------------

export type EnableStep = { name: "workflow" | "secret" | "register"; ok: boolean; message: string };

function fullNameOf(body: Record<string, unknown>): string {
    const value = body.fullName;
    if (typeof value !== "string" || !REPO_NAME.test(value)) {
        throw new HttpError(400, "fullName must be owner/name");
    }
    return value;
}

function kindOf(value: unknown): RepoKindChoice {
    if (value !== "context" && value !== "code" && value !== "both") {
        throw new HttpError(400, 'kind must be "context", "code" or "both"');
    }
    return value;
}

async function step(name: EnableStep["name"], work: () => Promise<string>): Promise<EnableStep> {
    try {
        return { name, ok: true, message: await work() };
    } catch (error) {
        return { name, ok: false, message: errorText(error) };
    }
}

/**
 * POST /api/github/enable {fullName, kind, installationId}: write the caller workflow, write the HX_CTX_TOKEN
 * secret, register the repository. Each step runs even when an earlier one failed and reports on its own.
 */
export async function handleEnable(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    const body = await readJson(request);
    const fullName = fullNameOf(body);
    const kind = kindOf(body.kind);
    const installationId = installationIdOf(body.installationId);

    // One token exchange shared by steps 1 and 2; a failure here fails both GitHub steps, not the registration.
    const token: Promise<string> = installationToken(gh, installationId);
    token.catch(() => undefined);
    const runnerToken = newToken();
    const steps: EnableStep[] = [];

    steps.push(
        await step("workflow", async () => {
            const auth = await token;
            const repository = await getRepository(gh.fetch, auth, fullName);
            const fetched = gh.template ? await gh.template().catch(() => null) : null;
            const content = renderWorkflow(fetched ?? DEFAULT_WORKFLOW_TEMPLATE, repository.default_branch, kind);
            const sha = await getFileSha(gh.fetch, auth, fullName, WORKFLOW_PATH);
            await putFile(gh.fetch, auth, fullName, WORKFLOW_PATH, {
                message: ENABLE_COMMIT_MESSAGE,
                content: b64(encoder.encode(content)),
                ...(sha ? { sha } : {}),
            });
            const source = fetched ? "templates/hx-context-review.workflow.yml" : "built-in template";
            return `${sha ? "updated" : "created"} ${WORKFLOW_PATH} on ${repository.default_branch} (${source})`;
        }),
    );

    const secret = await step("secret", async () => {
        const auth = await token;
        const key = await getRepoPublicKey(gh.fetch, auth, fullName);
        const sealed = sealedBox(
            encoder.encode(runnerToken),
            Uint8Array.from(atob(key.key), (c) => c.charCodeAt(0)),
        );
        await putRepoSecret(gh.fetch, auth, fullName, SECRET_NAME, b64(sealed), key.key_id);
        return `wrote actions secret ${SECRET_NAME}`;
    });
    steps.push(secret);

    let manualSecret: { name: string; value: string } | undefined;
    steps.push(
        await step("register", async () => {
            const hash = await sha256Hex(runnerToken);
            const existing = await deps.store.repoByName(fullName);
            if (!existing) {
                await deps.store.createRepo(fullName, hash, { kind, enabled: true });
                if (!secret.ok) {
                    // The token exists only here; hand it over once so the admin can set the secret by hand.
                    manualSecret = { name: SECRET_NAME, value: runnerToken };
                    return `registered ${fullName} (kind ${kind}); secret not written, set ${SECRET_NAME} manually`;
                }
                return `registered ${fullName} (kind ${kind})`;
            }
            await deps.store.updateRepo(existing.name, { kind, enabled: true });
            if (secret.ok) {
                await deps.store.setTokenHash(existing.name, hash);
                return `updated ${existing.name} (kind ${kind}, enabled) and rotated its token`;
            }
            // Rotating now would orphan the secret the repository already holds.
            return `updated ${existing.name} (kind ${kind}, enabled); token kept because the secret was not written`;
        }),
    );

    return json({ ok: steps.every((item) => item.ok), steps, ...(manualSecret ? { manualSecret } : {}) });
}

// ---- POST /api/github/disable ------------------------------------------------------------------------------------

/** POST /api/github/disable {fullName}: repos.enabled = false. The workflow file and secret stay in place. */
export async function handleDisable(request: Request, deps: Deps, gh: GitHubDeps): Promise<Response> {
    await requireAdmin(request, deps);
    void gh;
    const fullName = fullNameOf(await readJson(request));
    const updated = await deps.store.updateRepo(fullName, { enabled: false });
    if (!updated) {
        throw new HttpError(404, `${fullName} is not registered`);
    }
    return json({ ok: true });
}
