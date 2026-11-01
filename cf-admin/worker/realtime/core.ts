// Runtime-free core of the RealtimeHub: the persisted 200-event ring, the active-run table, snapshot/resume and
// the heartbeat rule. It only needs a key-value storage, so node tests drive it with an in-memory map while the
// Durable Object hands it ctx.storage.
import { EVENT_DONE, EVENT_STAGE, FRAME_PING, FRAME_SNAPSHOT } from "./events.ts";
import type { ActiveRun, LiveEvent, LiveEventInput, PingFrame, SnapshotFrame } from "./events.ts";

/** Events kept per repository room; older ones are deleted from storage as new ones arrive. */
export const RING_CAPACITY = 200;
/** Server sends a ping frame every 30 seconds. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A socket with no pong for 90 seconds is closed. */
export const HEARTBEAT_TIMEOUT_MS = 90_000;
/** A run with no event for an hour is dropped from the snapshot (the runner job was killed without `done`). */
export const ACTIVE_RUN_TTL_MS = 60 * 60_000;
/** WebSocket close code used for a heartbeat timeout (4000-4999 is application space). */
export const CLOSE_HEARTBEAT = 4000;

const EVENT_PREFIX = "ev:";
const META_KEY = "meta";
const RUNS_KEY = "runs";

/** The subset of DurableObjectStorage the hub uses. */
export interface KvStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T>(entries: Record<string, T>): Promise<void>;
    delete(keys: string[]): Promise<number>;
    list<T = unknown>(options: { prefix?: string; start?: string; limit?: number }): Promise<Map<string, T>>;
}

type Meta = { seq: number };
type Runs = Record<string, ActiveRun>;

/** Zero-padded so lexicographic storage order is numeric order. */
export function eventKey(id: number): string {
    return EVENT_PREFIX + String(id).padStart(12, "0");
}

/** Parse a client's lastEventId (query or Last-Event-ID header); anything that is not a non-negative integer is null. */
export function resumeId(value: string | null | undefined): number | null {
    if (value === null || value === undefined || !/^\d{1,15}$/.test(value)) {
        return null;
    }
    return Number(value);
}

/** Heartbeat rule, kept pure so it can be tested without a socket. */
export function heartbeat(nowMs: number, lastPongMs: number): "alive" | "dead" {
    return nowMs - lastPongMs > HEARTBEAT_TIMEOUT_MS ? "dead" : "alive";
}

export function pingFrame(nowMs: number): PingFrame {
    return { type: FRAME_PING, at: new Date(nowMs).toISOString() };
}

export class HubCore {
    readonly #storage: KvStorage;
    readonly #now: () => number;

    constructor(storage: KvStorage, now: () => number = Date.now) {
        this.#storage = storage;
        this.#now = now;
    }

    async #meta(): Promise<Meta> {
        return (await this.#storage.get<Meta>(META_KEY)) ?? { seq: 0 };
    }

    async #runs(): Promise<Runs> {
        return (await this.#storage.get<Runs>(RUNS_KEY)) ?? {};
    }

    /** Persist one event, trim the ring to RING_CAPACITY, update the active-run table, return it with its id. */
    async append(input: LiveEventInput): Promise<LiveEvent> {
        const meta = await this.#meta();
        const id = meta.seq + 1;
        const event = { ...input, id } as LiveEvent;
        const runs = this.#track(await this.#runs(), event);
        await this.#storage.put<unknown>({ [META_KEY]: { seq: id }, [eventKey(id)]: event, [RUNS_KEY]: runs });
        if (id > RING_CAPACITY) {
            await this.#storage.delete([eventKey(id - RING_CAPACITY)]);
        }
        return event;
    }

    #track(runs: Runs, event: LiveEvent): Runs {
        const nowMs = this.#now();
        for (const [runId, run] of Object.entries(runs)) {
            if (nowMs - Date.parse(run.updatedAt) > ACTIVE_RUN_TTL_MS) {
                delete runs[runId];
            }
        }
        if (event.type === EVENT_DONE) {
            delete runs[event.runId];
            return runs;
        }
        const run: ActiveRun = runs[event.runId] ?? {
            runId: event.runId,
            kind: event.kind,
            stage: null,
            status: null,
            startedAt: event.at,
            updatedAt: event.at,
            lastEventId: event.id,
        };
        if (event.type === EVENT_STAGE) {
            run.stage = event.payload.stage;
            run.status = event.payload.status;
        } else if (run.stage === null && "stage" in event.payload) {
            run.stage = event.payload.stage;
            run.status = "running";
        }
        run.updatedAt = event.at;
        run.lastEventId = event.id;
        runs[event.runId] = run;
        return runs;
    }

    /** Buffered events with id > afterId, oldest first (at most RING_CAPACITY). */
    async since(afterId: number): Promise<LiveEvent[]> {
        const listed = await this.#storage.list<LiveEvent>({ prefix: EVENT_PREFIX, start: eventKey(afterId + 1) });
        return [...listed.values()].sort((a, b) => a.id - b.id);
    }

    async activeRuns(): Promise<ActiveRun[]> {
        const nowMs = this.#now();
        return Object.values(await this.#runs())
            .filter((run) => nowMs - Date.parse(run.updatedAt) <= ACTIVE_RUN_TTL_MS)
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }

    /**
     * What a (re)connecting client gets: the snapshot frame first, then the events to replay. Without a
     * lastEventId nothing is replayed (the snapshot is the state); with one, every buffered event after it.
     */
    async connect(repo: string, lastEventId: number | null): Promise<{ snapshot: SnapshotFrame; replay: LiveEvent[] }> {
        const { seq } = await this.#meta();
        const oldest = seq === 0 ? 0 : Math.max(1, seq - RING_CAPACITY + 1);
        const replay = lastEventId === null || lastEventId >= seq ? [] : await this.since(lastEventId);
        const snapshot: SnapshotFrame = {
            type: FRAME_SNAPSHOT,
            repo,
            at: new Date(this.#now()).toISOString(),
            payload: {
                runs: await this.activeRuns(),
                lastEventId: seq,
                oldestEventId: oldest,
                replayed: replay.length,
                // Ids are never reused: a client ahead of seq or behind the ring missed events it cannot get back.
                gap: lastEventId !== null && (lastEventId > seq || (oldest > 0 && lastEventId < oldest - 1)),
            },
        };
        return { snapshot, replay };
    }
}
