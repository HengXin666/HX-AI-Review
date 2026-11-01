// App JWT and installation tokens. Installation tokens are cached (sealed) in D1 and reused until 5 minutes
// before GitHub's expiry, so a burst of comments or dispatches costs one token exchange.
import { HttpError } from "../http.ts";
import { createInstallationToken } from "./client.ts";
import { requireKek } from "./crypto.ts";
import type { GitHubDeps } from "./deps.ts";
import { appJwt } from "./jwt.ts";

export const TOKEN_EARLY_EXPIRY_MS = 5 * 60_000;

/** The only path that decrypts the private key: it is unsealed, signed into a JWT and dropped. */
export async function jwtFor(gh: GitHubDeps): Promise<string> {
    const app = await gh.store.app();
    if (!app) {
        throw new HttpError(400, "GitHub App is not configured; POST /api/github/app first");
    }
    const pem = await gh.store.privateKey(requireKek(gh.secret));
    if (!pem) {
        throw new HttpError(400, "GitHub App private key is missing; POST /api/github/app with privateKey");
    }
    return appJwt(pem, app.appId, gh.now());
}

/**
 * A token for one repository, narrowed to it, and never cached: a per-repository token in a shared cache is how
 * one repository ends up acting as another. The runner is the only caller that needs this scope, and it owns
 * exactly one repository.
 */
export async function repoScopedToken(gh: GitHubDeps, installationId: number, repo: string): Promise<string> {
    return (await mintScoped(gh, installationId, repo)).token;
}

/** Same exchange, keeping the expiry so GET /github/token can report it without a second call. */
export async function mintScoped(
    gh: GitHubDeps,
    installationId: number,
    repo: string,
): Promise<{ token: string; expiresAt: string }> {
    const fresh = await createInstallationToken(gh.fetch, await jwtFor(gh), installationId, repo);
    return { token: fresh.token, expiresAt: fresh.expires_at };
}

/**
 * An installation-wide token, cached until shortly before GitHub expires it. Dispatching a workflow and listing
 * installations need the installation itself rather than one repository.
 */
export async function installationToken(gh: GitHubDeps, installationId: number): Promise<string> {
    const kek = requireKek(gh.secret);
    const now = gh.now();
    const cached = await gh.store.cachedToken(installationId, kek);
    if (cached && Date.parse(cached.expiresAt) - TOKEN_EARLY_EXPIRY_MS > now.getTime()) {
        return cached.token;
    }
    const fresh = await createInstallationToken(gh.fetch, await jwtFor(gh), installationId, "");
    await gh.store.cacheToken(installationId, fresh.token, fresh.expires_at, kek, now.toISOString());
    return fresh.token;
}

/** Installation that covers repo, from the state the installation webhooks keep. */
export async function installationFor(gh: GitHubDeps, repo: string): Promise<number> {
    const id = await gh.store.installationIdForRepo(repo);
    if (id === null) {
        throw new HttpError(404, `the GitHub App is not installed on ${repo}`);
    }
    return id;
}
