// RealtimeHub: one Durable Object per repository room (idFromName(roomKey(repo))). Uses the hibernation API, so
// idle subscribers cost nothing; the 30 s ping runs on an alarm that is only armed while sockets are open.
import { DurableObject } from "cloudflare:workers";
import { FRAME_PONG, roomKey } from "./events.ts";
import type { LiveEvent, LiveEventInput, SnapshotFrame } from "./events.ts";
import { CLOSE_HEARTBEAT, HEARTBEAT_INTERVAL_MS, HubCore, heartbeat, pingFrame, resumeId } from "./core.ts";

/** Per-socket state that survives hibernation (serializeAttachment). */
type Attachment = { repo: string; lastPong: number };

/** Internal path the Worker forwards a WebSocket upgrade to; never reachable from outside the binding. */
export const HUB_CONNECT_PATH = "/connect";

export class RealtimeHub extends DurableObject<unknown> {
    readonly #core: HubCore;

    constructor(ctx: DurableObjectState, env: unknown) {
        super(ctx, env);
        this.#core = new HubCore(ctx.storage);
    }

    /** RPC: persist and broadcast one validated event. Called by emit.ts; returns the stored event. */
    async emit(input: LiveEventInput): Promise<LiveEvent> {
        const event = await this.#core.append(input);
        const text = JSON.stringify(event);
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(text);
            } catch {
                // A socket that is already closing is cleaned up by webSocketClose or the heartbeat sweep.
            }
        }
        return event;
    }

    /** RPC: the snapshot a new subscriber would get, for callers that want state without a socket. */
    async snapshot(repo: string): Promise<SnapshotFrame> {
        return (await this.#core.connect(repo, null)).snapshot;
    }

    /** WebSocket upgrade only: GET /connect?repo=<full name>&lastEventId=<n>, forwarded by handleLive. */
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== HUB_CONNECT_PATH || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
            return new Response("expected a websocket upgrade", { status: 426 });
        }
        const repo = url.searchParams.get("repo") ?? "";
        const lastEventId = resumeId(url.searchParams.get("lastEventId") ?? request.headers.get("last-event-id"));
        const { 0: client, 1: server } = new WebSocketPair();
        this.ctx.acceptWebSocket(server, [roomKey(repo)]);
        server.serializeAttachment({ repo, lastPong: Date.now() } satisfies Attachment);
        const { snapshot, replay } = await this.#core.connect(repo, lastEventId);
        server.send(JSON.stringify(snapshot));
        for (const event of replay) {
            server.send(JSON.stringify(event));
        }
        await this.#arm();
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        let type: unknown = text;
        try {
            type = (JSON.parse(text) as { type?: unknown }).type;
        } catch {
            // A bare "pong" string is accepted as well as {"type":"pong"}.
        }
        if (type === FRAME_PONG) {
            const state = (ws.deserializeAttachment() as Attachment | null) ?? { repo: "", lastPong: 0 };
            ws.serializeAttachment({ ...state, lastPong: Date.now() } satisfies Attachment);
        }
        // Subscribers are read-only; anything else is ignored rather than echoed.
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        try {
            ws.close(code === 1005 ? 1000 : code, reason);
        } catch {
            // already closed
        }
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        try {
            ws.close(1011, "socket error");
        } catch {
            // already closed
        }
    }

    /** Every 30 s: ping live sockets, close those silent for more than 90 s, re-arm while any remain. */
    async alarm(): Promise<void> {
        const nowMs = Date.now();
        const frame = JSON.stringify(pingFrame(nowMs));
        for (const ws of this.ctx.getWebSockets()) {
            const state = ws.deserializeAttachment() as Attachment | null;
            if (heartbeat(nowMs, state?.lastPong ?? 0) === "dead") {
                try {
                    ws.close(CLOSE_HEARTBEAT, "heartbeat timeout");
                } catch {
                    // already closed
                }
                continue;
            }
            try {
                ws.send(frame);
            } catch {
                // closing; the next sweep drops it
            }
        }
        await this.#arm(true);
    }

    async #arm(force = false): Promise<void> {
        if (this.ctx.getWebSockets().length === 0) {
            return;
        }
        if (force || (await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
        }
    }
}
