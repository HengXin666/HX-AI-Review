// Request routing, kept apart from the Worker entry so plain node tests can import it: index.ts must re-export
// the RealtimeHub Durable Object class, which imports cloudflare:workers and does not load outside workerd.
import type { GitHubDeps } from "./github/deps.ts";
import { handleGitHub, handleRunnerToken } from "./github/routes.ts";
import { HttpError, json } from "./http.ts";
import type { Deps } from "./http.ts";
import type { HubPort } from "./realtime/emit.ts";
import { handleEmit, handleLive, LIVE_EMIT_PATH, LIVE_PATH } from "./realtime/routes.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleFeedback } from "./routes/feedback.ts";
import { handleInit } from "./routes/init.ts";
import { handleRuns, handleSpend } from "./routes/runs.ts";
import { handleGithubWebhook } from "./routes/webhook.ts";

const GITHUB_PREFIX = "/api/github/";

// http.ts widens Deps.gh to unknown and Deps.live to a loose shape on purpose, so it never imports github/ or
// realtime/ and cannot close an import cycle. index.ts fills them with githubDeps() and hubFromNamespace(), so the
// assertions below only restore the concrete types those builders return.
function liveHub(deps: Deps): HubPort | undefined {
    return deps.live as HubPort | undefined;
}

function githubOrFail(gh: GitHubDeps | undefined): GitHubDeps {
    if (!gh) {
        throw new HttpError(503, "GitHub App is not configured");
    }
    return gh;
}

export function route(request: Request, deps: Deps): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    if (method === "GET" && pathname === "/healthz") {
        return Promise.resolve(json({ status: "ok" }));
    }
    if (method === "GET" && pathname === "/init") {
        return handleInit(request, deps);
    }
    if (method === "POST" && pathname === "/spend") {
        return handleSpend(request, deps);
    }
    if (method === "POST" && pathname === "/runs") {
        return handleRuns(request, deps);
    }
    if (method === "POST" && pathname === "/feedback") {
        return handleFeedback(request, deps);
    }
    // These four groups must be matched before the generic /api/* admin dispatch: the webhook is signed by
    // GitHub instead of requireAdmin, and the live and GitHub App routes have their own handlers.
    if (method === "POST" && pathname === "/api/webhook/github") {
        return handleGithubWebhook(request, githubOrFail(deps.gh as GitHubDeps | undefined));
    }
    // The runner, not an admin, calls this: its HX_CTX_TOKEN is the credential and limits it to its own repo.
    if (method === "GET" && pathname === "/github/token") {
        return handleRunnerToken(request, deps, githubOrFail(deps.gh as GitHubDeps | undefined));
    }
    if (pathname === LIVE_EMIT_PATH) {
        return handleEmit(request, deps, liveHub(deps));
    }
    if (pathname === LIVE_PATH) {
        return handleLive(request, deps, liveHub(deps));
    }
    if (pathname.startsWith(GITHUB_PREFIX)) {
        const segments = pathname.slice(GITHUB_PREFIX.length).split("/").filter(Boolean);
        return handleGitHub(request, deps, githubOrFail(deps.gh as GitHubDeps | undefined), segments);
    }
    if (pathname.startsWith("/api/")) {
        return handleAdmin(request, deps, pathname.slice(5).split("/").filter(Boolean));
    }
    // Anything else is the overview SPA. The Worker runs before assets, so it has to hand them over itself;
    // single-page-app handling turns unknown paths into index.html so client routing works on a deep link.
    if (deps.assets && (method === "GET" || method === "HEAD")) {
        return deps.assets.fetch(request);
    }
    throw new HttpError(404, "not found");
}

export async function serve(request: Request, deps: Deps): Promise<Response> {
    try {
        return await route(request, deps);
    } catch (error) {
        if (error instanceof HttpError) {
            return json({ error: error.message }, error.status);
        }
        console.error(error);
        return json({ error: "internal error" }, 500);
    }
}
