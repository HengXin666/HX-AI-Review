// In-Worker emit: other routes call these to publish a live event without an HTTP hop. The call goes straight
// to the repository's RealtimeHub over Durable Object RPC.
import { parseEvent, roomKey } from "./events.ts";
import type { LiveEvent, LiveEventInput } from "./events.ts";
import type { RealtimeHub } from "./hub.ts";

/** Binding name in wrangler.toml and scripts/deploy.ts. */
export const REALTIME_BINDING = "REALTIME";

export type RealtimeNamespace = DurableObjectNamespace<RealtimeHub>;

/** What the live routes need from the hub; tests pass a fake, the Worker passes hubFromNamespace(env.REALTIME). */
export interface HubPort {
    emit(event: LiveEventInput): Promise<LiveEvent>;
    /** Forward an already-authorized WebSocket upgrade into the repository's room. */
    connect(repo: string, request: Request): Promise<Response>;
}

export function stubFor(ns: RealtimeNamespace, repo: string): DurableObjectStub<RealtimeHub> {
    return ns.get(ns.idFromName(roomKey(repo)));
}

export function hubFromNamespace(ns: RealtimeNamespace): HubPort {
    return {
        async emit(event) {
            return (await stubFor(ns, event.repo).emit(event)) as LiveEvent;
        },
        connect(repo, request) {
            const target = new URL("https://realtime.internal/connect");
            target.searchParams.set("repo", repo);
            const resume = new URL(request.url).searchParams.get("lastEventId") ?? request.headers.get("last-event-id");
            if (resume !== null) {
                target.searchParams.set("lastEventId", resume);
            }
            return stubFor(ns, repo).fetch(new Request(target, request));
        },
    };
}

/**
 * Validate and publish one event. Throws HttpError(400) on a bad event, so a route bug is loud in tests.
 * `raw` may omit `at`; it is stamped with `now`.
 */
export async function emitLive(hub: HubPort, raw: unknown, now: Date = new Date()): Promise<LiveEvent> {
    return hub.emit(parseEvent(raw, now));
}

/**
 * Best-effort variant for code on the ingest path (/runs, /spend): live updates must never fail the request
 * that carries the real data, so a missing binding or a hub error is logged and swallowed.
 */
export async function tryEmitLive(
    hub: HubPort | undefined,
    raw: unknown,
    now: Date = new Date(),
): Promise<LiveEvent | null> {
    if (!hub) {
        return null;
    }
    try {
        return await emitLive(hub, raw, now);
    } catch (error) {
        console.warn("live emit dropped", error);
        return null;
    }
}
