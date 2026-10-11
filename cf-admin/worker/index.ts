// Cloudflare Worker entry. Model traffic never passes through here: the runner calls api_url directly.
import { verifyAccess } from "./auth.ts";
import { HttpError, json } from "./http.ts";
import type { Deps, Env } from "./http.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleFeedback } from "./routes/feedback.ts";
import { handleInit } from "./routes/init.ts";
import { handleRuns } from "./routes/runs.ts";
import { D1Store, R2Blobs } from "./store/d1.ts";

export function route(request: Request, deps: Deps): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    if (method === "GET" && pathname === "/init") {
        return handleInit(request, deps);
    }
    if (method === "POST" && pathname === "/runs") {
        return handleRuns(request, deps);
    }
    if (method === "POST" && pathname === "/feedback") {
        return handleFeedback(request, deps);
    }
    if (pathname.startsWith("/api/")) {
        return handleAdmin(request, deps, pathname.slice(5).split("/").filter(Boolean));
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

export default {
    fetch(request: Request, env: Env): Promise<Response> {
        const deps: Deps = {
            store: new D1Store(env.DB),
            blobs: new R2Blobs(env.BLOBS),
            secret: (name) => (typeof env[name] === "string" ? (env[name] as string) : undefined),
            admin: (req) => verifyAccess(req, env.ACCESS_AUD, env.ACCESS_TEAM_DOMAIN),
            overviewUrl: env.OVERVIEW_URL,
            now: () => new Date(),
            id: () => crypto.randomUUID(),
        };
        return serve(request, deps);
    },
} satisfies ExportedHandler<Env>;
