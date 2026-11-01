// Live channel: event schema, the persisted 200-event ring, resume, heartbeat rule, emit auth and deploy config.
// Runs under plain node: only the runtime-free modules are imported (hub.ts needs cloudflare:workers).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DO_MIGRATIONS, durableObjectLines } from "../scripts/deploy.ts";
import { newToken, sha256Hex } from "../worker/auth.ts";
import { HttpError } from "../worker/http.ts";
import type { Deps } from "../worker/http.ts";
import {
    ACTIVE_RUN_TTL_MS,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS,
    HubCore,
    RING_CAPACITY,
    heartbeat,
    resumeId,
} from "../worker/realtime/core.ts";
import type { KvStorage } from "../worker/realtime/core.ts";
import { emitLive, tryEmitLive } from "../worker/realtime/emit.ts";
import type { HubPort } from "../worker/realtime/emit.ts";
import { EVENT_TYPES, parseEvent } from "../worker/realtime/events.ts";
import type { LiveEvent, LiveEventInput } from "../worker/realtime/events.ts";
import { handleEmit, handleLive } from "../worker/realtime/routes.ts";
import { FakeBlobs, FakeStore } from "./fake-store.ts";

const NOW = new Date("2026-11-01T09:00:00.000Z");
const REPO = "o/r";

/** In-memory stand-in for DurableObjectStorage, keyed and listed in lexicographic order like the real one. */
class MemoryStorage implements KvStorage {
    readonly data = new Map<string, unknown>();

    async get<T>(key: string): Promise<T | undefined> {
        const value = this.data.get(key);
        return value === undefined ? undefined : (structuredClone(value) as T);
    }
    async put<T>(entries: Record<string, T>): Promise<void> {
        for (const [key, value] of Object.entries(entries)) {
            this.data.set(key, structuredClone(value));
        }
    }
    async delete(keys: string[]): Promise<number> {
        return keys.filter((key) => this.data.delete(key)).length;
    }
    async list<T>(options: { prefix?: string; start?: string; limit?: number }): Promise<Map<string, T>> {
        const keys = [...this.data.keys()]
            .filter(
                (key) => key.startsWith(options.prefix ?? "") && (options.start === undefined || key >= options.start),
            )
            .sort()
            .slice(0, options.limit ?? Infinity);
        return new Map(keys.map((key) => [key, structuredClone(this.data.get(key)) as T]));
    }
}

function log(runId: string, i: number): LiveEventInput {
    return parseEvent(
        {
            type: "log",
            repo: REPO,
            runId,
            kind: "context",
            payload: { stage: "review", level: "info", message: `line ${i}` },
        },
        NOW,
    );
}

function eventKeys(storage: MemoryStorage): string[] {
    return [...storage.data.keys()].filter((key) => key.startsWith("ev:"));
}

test("the five producer event types are defined and validated", () => {
    assert.deepEqual([...EVENT_TYPES], ["stage", "log", "finding", "progress", "done"]);
    const base = { repo: REPO, runId: "run-1", kind: "code" };
    const ok = [
        { type: "stage", ...base, payload: { stage: "scope", status: "done", durationMs: 1200 } },
        { type: "log", ...base, payload: { stage: "l0", level: "warn", message: "x" } },
        {
            type: "finding",
            ...base,
            payload: { ruleId: "AI-CODE-001", path: "src/a.ts", line: 3, severity: "warning" },
        },
        {
            type: "progress",
            ...base,
            payload: { finder: { batch: 2, batches: 5 }, candidates: 7, verifier: { done: 3 } },
        },
        { type: "done", ...base, payload: { complete: true, counts: { findings: 2, errors: 0, warnings: 2 } } },
    ];
    for (const raw of ok) {
        const parsed = parseEvent(raw, NOW);
        assert.equal(parsed.type, raw.type);
        assert.equal(parsed.at, NOW.toISOString(), "a missing at is stamped by the server");
    }
    const bad = [
        { ...ok[0], type: "snapshot" },
        { ...ok[0], repo: "not-a-full-name" },
        { ...ok[0], kind: "both" },
        { ...ok[0], payload: { stage: "deploy", status: "done" } },
        { ...ok[0], payload: { stage: "scope", status: "done", durationMs: 1.5 } },
        { ...ok[1], payload: { stage: "l0", level: "fatal", message: "x" } },
        { ...ok[2], payload: { path: "src/a.ts" } },
        { ...ok[3], payload: { stage: "review" } },
        { ...ok[4], payload: { counts: { findings: 0, errors: 0, warnings: 0 } } },
        { ...ok[4], at: "yesterday" },
    ];
    for (const raw of bad) {
        assert.throws(
            () => parseEvent(raw, NOW),
            (error: unknown) => error instanceof HttpError && error.status === 400,
        );
    }
});

test("writing 250 events keeps exactly the newest 200 in storage", async () => {
    const storage = new MemoryStorage();
    const core = new HubCore(storage, () => NOW.getTime());
    for (let i = 1; i <= 250; i++) {
        const stored = await core.append(log("run-1", i));
        assert.equal(stored.id, i);
    }
    assert.equal(RING_CAPACITY, 200);
    const keys = eventKeys(storage);
    assert.equal(keys.length, 200);
    const all = await core.since(0);
    assert.equal(all.length, 200);
    assert.equal(all[0]!.id, 51);
    assert.equal(all.at(-1)!.id, 250);
    // A fresh core over the same storage (a DO restart) sees the same ring: it is persisted, not in memory.
    const restarted = new HubCore(storage, () => NOW.getTime());
    assert.equal((await restarted.since(0)).length, 200);
    assert.equal((await restarted.append(log("run-1", 251))).id, 251);
    assert.equal(eventKeys(storage).length, 200);
});

test("reconnect with lastEventId replays only newer events, and flags a gap behind the ring", async () => {
    const core = new HubCore(new MemoryStorage(), () => NOW.getTime());
    for (let i = 1; i <= 250; i++) {
        await core.append(log("run-1", i));
    }
    const fresh = await core.connect(REPO, null);
    assert.equal(fresh.snapshot.type, "snapshot");
    assert.equal(fresh.replay.length, 0);
    assert.deepEqual(
        {
            last: fresh.snapshot.payload.lastEventId,
            oldest: fresh.snapshot.payload.oldestEventId,
            gap: fresh.snapshot.payload.gap,
        },
        { last: 250, oldest: 51, gap: false },
    );
    const resumed = await core.connect(REPO, 240);
    assert.deepEqual(
        resumed.replay.map((event) => event.id),
        [241, 242, 243, 244, 245, 246, 247, 248, 249, 250],
    );
    assert.equal(resumed.snapshot.payload.replayed, 10);
    assert.equal(resumed.snapshot.payload.gap, false);
    const behind = await core.connect(REPO, 10);
    assert.equal(behind.replay.length, 200);
    assert.equal(behind.snapshot.payload.gap, true);
    assert.equal((await core.connect(REPO, 250)).replay.length, 0);
});

test("the snapshot lists active runs with their current stage and drops finished ones", async () => {
    let nowMs = NOW.getTime();
    const core = new HubCore(new MemoryStorage(), () => nowMs);
    const at = (offset: number) => new Date(NOW.getTime() + offset).toISOString();
    const send = (raw: Record<string, unknown>) =>
        core.append(parseEvent({ repo: REPO, kind: "context", ...raw }, NOW));
    await send({ type: "stage", runId: "a", at: at(0), payload: { stage: "init", status: "running" } });
    await send({ type: "stage", runId: "a", at: at(1000), payload: { stage: "review", status: "running" } });
    await send({
        type: "stage",
        runId: "b",
        kind: "code",
        at: at(2000),
        payload: { stage: "scope", status: "running" },
    });
    let runs = (await core.connect(REPO, null)).snapshot.payload.runs;
    assert.deepEqual(
        runs.map((run) => [run.runId, run.kind, run.stage, run.status]),
        [
            ["a", "context", "review", "running"],
            ["b", "code", "scope", "running"],
        ],
    );
    await send({
        type: "done",
        runId: "a",
        at: at(3000),
        payload: { complete: true, counts: { findings: 0, errors: 0, warnings: 0 } },
    });
    runs = (await core.connect(REPO, null)).snapshot.payload.runs;
    assert.deepEqual(
        runs.map((run) => run.runId),
        ["b"],
    );
    nowMs += ACTIVE_RUN_TTL_MS + 5000;
    assert.deepEqual((await core.connect(REPO, null)).snapshot.payload.runs, [], "a run silent for an hour is stale");
});

test("heartbeat: ping every 30 s, a socket silent for more than 90 s is dead", () => {
    assert.equal(HEARTBEAT_INTERVAL_MS, 30_000);
    assert.equal(HEARTBEAT_TIMEOUT_MS, 90_000);
    assert.equal(heartbeat(100_000, 100_000 - 90_000), "alive");
    assert.equal(heartbeat(100_000, 100_000 - 90_001), "dead");
    assert.equal(resumeId("42"), 42);
    assert.equal(resumeId("-1"), null);
    assert.equal(resumeId("abc"), null);
    assert.equal(resumeId(null), null);
});

/** Hub fake that records what reached it. */
function fakeHub() {
    const emitted: LiveEventInput[] = [];
    const connected: string[] = [];
    let seq = 0;
    const hub: HubPort = {
        async emit(event) {
            emitted.push(event);
            return { ...event, id: ++seq } as LiveEvent;
        },
        async connect(repo) {
            connected.push(repo);
            return new Response("upgraded", { status: 200 });
        },
    };
    return { hub, emitted, connected };
}

async function depsWithRepo(admin: string | null) {
    const store = new FakeStore();
    const token = newToken();
    await store.createRepo(REPO, await sha256Hex(token), {});
    const deps: Deps = {
        store,
        blobs: new FakeBlobs(),
        secret: () => undefined,
        admin: async () => admin,
        deployment: { accessConfigured: true },
        now: () => NOW,
        id: () => "id",
    };
    return { deps, token };
}

async function status(promise: Promise<Response>): Promise<number> {
    try {
        return (await promise).status;
    } catch (error) {
        if (error instanceof HttpError) {
            return error.status;
        }
        throw error;
    }
}

function emitRequest(body: unknown, token?: string): Request {
    return new Request("https://cf.test/api/live/emit", {
        method: "POST",
        headers: token ? { authorization: "Bearer " + token } : {},
        body: JSON.stringify(body),
    });
}

test("POST /api/live/emit: token must own the repo, session works without a token, bad events are 400", async () => {
    const { deps, token } = await depsWithRepo(null);
    const { hub, emitted } = fakeHub();
    const event = {
        type: "stage",
        repo: REPO,
        runId: "r1",
        kind: "context",
        payload: { stage: "l0", status: "running" },
    };
    const accepted = await handleEmit(emitRequest(event, token), deps, hub);
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { id: 1, at: NOW.toISOString() });
    assert.equal(await status(handleEmit(emitRequest({ ...event, repo: "o/other" }, token), deps, hub)), 403);
    assert.equal(await status(handleEmit(emitRequest(event, "hxctx_unknown"), deps, hub)), 401);
    assert.equal(await status(handleEmit(emitRequest(event), deps, hub)), 403, "no token and no session");
    assert.equal(await status(handleEmit(emitRequest({ ...event, type: "nope" }, token), deps, hub)), 400);
    assert.equal(await status(handleEmit(emitRequest(event, token), deps, undefined)), 503);
    const admin = await depsWithRepo("me@test");
    assert.equal(await status(handleEmit(emitRequest({ ...event, repo: "o/other" }), admin.deps, hub)), 202);
    assert.equal(emitted.length, 2);
});

test("GET /api/live needs an upgrade, a login, the same origin and a full repo name", async () => {
    const { hub, connected } = fakeHub();
    const live = (query: string, headers: Record<string, string>) =>
        new Request("https://cf.test/api/live" + query, { headers: { upgrade: "websocket", ...headers } });
    const admin = (await depsWithRepo("me@test")).deps;
    const nobody = (await depsWithRepo(null)).deps;
    assert.equal(await status(handleLive(new Request("https://cf.test/api/live?repo=o/r"), admin, hub)), 426);
    assert.equal(await status(handleLive(live("?repo=o/r", {}), nobody, hub)), 403);
    assert.equal(await status(handleLive(live("?repo=o/r", { origin: "https://evil.test" }), admin, hub)), 403);
    assert.equal(await status(handleLive(live("?repo=bad", {}), admin, hub)), 400);
    assert.equal(
        await status(handleLive(live("?repo=o%2Fr&lastEventId=5", { origin: "https://cf.test" }), admin, hub)),
        200,
    );
    assert.deepEqual(connected, ["o/r"]);
});

test("tryEmitLive never throws on the ingest path", async () => {
    assert.equal(await tryEmitLive(undefined, {}), null);
    const failing: HubPort = {
        emit: async () => {
            throw new Error("hub down");
        },
        connect: async () => new Response(null),
    };
    const original = console.warn;
    console.warn = () => {};
    try {
        assert.equal(await tryEmitLive(failing, { type: "log" }), null);
    } finally {
        console.warn = original;
    }
    const { hub } = fakeHub();
    const stored = await emitLive(hub, {
        type: "log",
        repo: REPO,
        runId: "r",
        kind: "code",
        payload: { stage: "publish", level: "info", message: "ok" },
    });
    assert.equal(stored.id, 1);
});

test("the generated deploy config binds RealtimeHub and carries migration tag v1", () => {
    const text = durableObjectLines().join("\n");
    assert.match(text, /\[\[durable_objects\.bindings\]\]\nname = "REALTIME"\nclass_name = "RealtimeHub"/);
    assert.match(text, /\[\[migrations\]\]\ntag = "v1"\nnew_sqlite_classes = \["RealtimeHub"\]/);
    assert.deepEqual(
        DO_MIGRATIONS.map((item) => item.tag),
        ["v1"],
    );
});
