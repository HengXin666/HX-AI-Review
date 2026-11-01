// Worker-side handlers for the live channel. Mounted by worker/index.ts (not here):
//   GET  /api/live?repo=<owner/name>[&lastEventId=<n>]   WebSocket upgrade, console session or Access
//   POST /api/live/emit                                  one event, HX_CTX_TOKEN (its own repo) or console session
// Both must be matched before the generic /api/* admin dispatch.
import { repoFromToken, requireAdmin } from "../auth.ts";
import { HttpError, json, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import { parseEvent, repoName, roomKey } from "./events.ts";
import type { HubPort } from "./emit.ts";

export const LIVE_PATH = "/api/live";
export const LIVE_EMIT_PATH = "/api/live/emit";

function hubOrFail(hub: HubPort | undefined): HubPort {
    if (!hub) {
        throw new HttpError(503, "live channel is not configured (REALTIME binding missing)");
    }
    return hub;
}

/**
 * Cross-site WebSocket hijacking guard: browsers send Origin on upgrades and attach the session cookie, so an
 * upgrade from another origin is refused. Non-browser clients send no Origin and still need a valid login.
 */
function sameOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) {
        return true;
    }
    try {
        return new URL(origin).host === new URL(request.url).host;
    } catch {
        return false;
    }
}

/** GET /api/live?repo=owner/name: authorize, then hand the upgrade to that repository's RealtimeHub. */
export async function handleLive(request: Request, deps: Deps, hub: HubPort | undefined): Promise<Response> {
    if (request.method !== "GET") {
        throw new HttpError(405, "GET only");
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new HttpError(426, "expected a websocket upgrade");
    }
    if (!sameOrigin(request)) {
        throw new HttpError(403, "cross-origin websocket refused");
    }
    await requireAdmin(request, deps);
    const repo = repoName(new URL(request.url).searchParams.get("repo"));
    return hubOrFail(hub).connect(repo, request);
}

/**
 * Who may emit for `repo`. A Bearer HX_CTX_TOKEN must belong to that repository (a runner can only speak for
 * its own repo); without a Bearer header the console session / Access identity is required.
 */
async function authorizeEmit(request: Request, deps: Deps, repo: string): Promise<string> {
    if ((request.headers.get("authorization") ?? "").startsWith("Bearer ")) {
        const owner = await repoFromToken(request, deps);
        if (roomKey(owner.name) !== roomKey(repo)) {
            throw new HttpError(403, "HX_CTX_TOKEN does not belong to this repository");
        }
        return "token:" + owner.name;
    }
    return requireAdmin(request, deps);
}

/** POST /api/live/emit: validate one event fully, authorize it against its repo, then fan it out. */
export async function handleEmit(request: Request, deps: Deps, hub: HubPort | undefined): Promise<Response> {
    if (request.method !== "POST") {
        throw new HttpError(405, "POST only");
    }
    const event = parseEvent(await readJson(request), deps.now());
    await authorizeEmit(request, deps, event.repo);
    const stored = await hubOrFail(hub).emit(event);
    return json({ id: stored.id, at: stored.at }, 202);
}
