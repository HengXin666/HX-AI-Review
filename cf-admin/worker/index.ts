// Cloudflare Worker entry. Model traffic never passes through here: the runner calls api_url directly.
// Routing lives in router.ts; this module only builds Deps from Env and exports what workerd needs.
import { verifyAccess } from "./auth.ts";
import { githubDeps } from "./github/deps.ts";
import type { Deps, Env } from "./http.ts";
import { hubFromNamespace } from "./realtime/index.ts";
import { serve } from "./router.ts";
import { D1Store, R2Blobs } from "./store/d1.ts";

// Durable Object classes must be exported from the Worker's main module, or the deploy fails.
export { RealtimeHub } from "./realtime/index.ts";
export { route, serve } from "./router.ts";

// router.ts matches these before the generic /api/* admin dispatch, in this order:
//   POST /api/webhook/github  -> handleGithubWebhook(request, deps.gh)       X-Hub-Signature-256, no admin login
//   LIVE_EMIT_PATH            -> handleEmit(request, deps, deps.live)        HX_CTX_TOKEN of the repo, or admin
//   LIVE_PATH                 -> handleLive(request, deps, deps.live)        WebSocket upgrade, admin
//   /api/github/*             -> handleGitHub(request, deps, deps.gh, ...)   admin
// fetch() below fills deps.live from env.REALTIME and deps.gh from githubDeps(env, deps).

export default {
    fetch(request: Request, env: Env): Promise<Response> {
        const deps: Deps = {
            store: new D1Store(env.DB),
            blobs: new R2Blobs(env.BLOBS),
            assets: env.ASSETS,
            secret: (name) => (typeof env[name] === "string" ? (env[name] as string) : undefined),
            admin: (req) => verifyAccess(req, env.ACCESS_AUD, env.ACCESS_TEAM_DOMAIN),
            credentials:
                env.ADMIN_USER && env.ADMIN_PASSWORD
                    ? { user: env.ADMIN_USER, password: env.ADMIN_PASSWORD }
                    : undefined,
            overviewUrl: env.OVERVIEW_URL,
            deployment: {
                sha: env.DEPLOY_SHA || undefined,
                deployedAt: env.DEPLOYED_AT || undefined,
                runUrl: env.DEPLOY_RUN_URL || undefined,
                accessConfigured: Boolean(env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN),
            },
            now: () => new Date(),
            id: () => crypto.randomUUID(),
        };
        deps.live = env.REALTIME ? hubFromNamespace(env.REALTIME) : undefined;
        deps.gh = githubDeps(env, deps);
        return serve(request, deps);
    },
} satisfies ExportedHandler<Env>;
