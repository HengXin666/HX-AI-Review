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

export async function installationToken(gh: GitHubDeps, installationId: number): Promise<string> {
    const kek = requireKek(gh.secret);
    const now = gh.now();
    const cached = await gh.store.cachedToken(installationId, kek);
    if (cached && Date.parse(cached.expiresAt) - TOKEN_EARLY_EXPIRY_MS > now.getTime()) {
        return cached.token;
    }
    const fresh = await createInstallationToken(gh.fetch, await jwtFor(gh), installationId);
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
