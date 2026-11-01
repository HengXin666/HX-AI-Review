import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_LOG_CLIP, LIVE_LOG_MAX } from "../src/constants.ts";
import { createLive, liveRunId } from "../src/live.ts";
import type { LiveEvent } from "../src/live.ts";

const CTX = { repo: "HengXin666/demo", kind: "context" as const, nonce: "nonce-1" };
const ENV_ON = {
    HX_CTX_ENDPOINT: "https://cr.example.test/",
    HX_CTX_TOKEN: "tok",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "2",
};
const STAGES = ["init", "l0", "rules", "scope", "review", "publish"];

type Sent = { url: string; init: RequestInit; event: LiveEvent };

function recorder(status = 202) {
    const sent: Sent[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), init: init ?? {}, event: JSON.parse(String(init?.body)) as LiveEvent });
        return new Response(JSON.stringify({ id: sent.length }), { status });
    }) as typeof fetch;
    return { sent, fake };
}

/** Mirror of the field checks in cf-admin/worker/realtime/events.ts parseEvent, for the fields we send. */
function assertSchema(event: LiveEvent): void {
    assert.ok(["stage", "log", "finding", "progress", "done"].includes(event.type));
    assert.match(event.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.ok(event.runId.length > 0 && event.runId.length <= 128);
    assert.ok(["context", "code"].includes(event.kind));
    assert.ok(!Number.isNaN(Date.parse(event.at)));
    const p = event.payload as Record<string, any>;
    const optInt = (v: unknown, min: number) => v === undefined || (Number.isSafeInteger(v) && (v as number) >= min);
    switch (event.type) {
        case "stage":
            assert.ok(STAGES.includes(p.stage));
            assert.ok(["running", "done", "failed"].includes(p.status));
            assert.ok(optInt(p.durationMs, 0));
            break;
        case "log":
            assert.ok(STAGES.includes(p.stage));
            assert.ok(["debug", "info", "warn", "error"].includes(p.level));
            assert.ok(typeof p.message === "string" && p.message.length > 0 && p.message.length <= 4000);
            break;
        case "finding":
            assert.ok(typeof p.ruleId === "string" && p.ruleId.length <= 200);
            assert.ok(typeof p.path === "string" && p.path.length > 0);
            assert.ok(optInt(p.line, 1));
            assert.ok(p.severity === undefined || ["error", "warning"].includes(p.severity));
            break;
        case "progress":
            assert.ok(STAGES.includes(p.stage));
            assert.ok(p.finder || p.candidates !== undefined || p.verifier);
            if (p.finder) assert.ok(optInt(p.finder.batch, 1) && p.finder.batch !== undefined);
            if (p.verifier) assert.ok(optInt(p.verifier.done, 0) && p.verifier.done !== undefined);
            break;
        case "done":
            assert.equal(typeof p.complete, "boolean");
            for (const key of ["findings", "errors", "warnings"]) {
                assert.ok(Number.isSafeInteger(p.counts[key]) && p.counts[key] >= 0);
            }
            break;
    }
}

test("live: without HX_CTX_ENDPOINT the reporter is a no-op and sends nothing", async () => {
    const { sent, fake } = recorder();
    for (const env of [{ HX_CTX_TOKEN: "tok" }, { HX_CTX_ENDPOINT: "https://x.test" }, {}]) {
        const live = createLive(CTX, { env, fetch: fake });
        assert.equal(live.enabled, false);
        live.stage("init", "done", 5);
        live.log("l0", "info", "x");
        live.done({ complete: true, errors: 0, warnings: 0 });
        await live.flush();
    }
    // A repo name the Worker would refuse (local runs) also disables it.
    const local = createLive({ ...CTX, repo: "local" }, { env: ENV_ON, fetch: fake });
    assert.equal(local.enabled, false);
    local.stage("init", "done");
    await local.flush();
    assert.equal(sent.length, 0);
});

test("live: every event type is POSTed to /api/live/emit in order and matches the events.ts schema", async () => {
    const { sent, fake } = recorder();
    const live = createLive(CTX, { env: ENV_ON, fetch: fake });
    live.stage("review", "running");
    live.log("scope", "info", "3 个上下文文件");
    live.progress("review", { batch: 1, batches: 2 });
    live.progress("review", { candidates: 4, verifierDone: 1 });
    live.progress("review", { batch: 0 }); // nothing valid: not sent, events.ts would 400 it
    live.finding("CX-AI", "AGENTS.md", 7, "warning", "stale path");
    live.stage("review", "done", 1234.0);
    live.done({ complete: true, errors: 1, warnings: 2 });
    await live.flush();
    assert.deepEqual(
        sent.map((item) => item.event.type),
        ["stage", "log", "progress", "progress", "finding", "stage", "done"],
    );
    for (const item of sent) {
        assert.equal(item.url, "https://cr.example.test/api/live/emit");
        assert.equal(item.init.method, "POST");
        const headers = item.init.headers as Record<string, string>;
        assert.equal(headers.authorization, "Bearer tok");
        assert.equal(headers["content-type"], "application/json");
        assert.equal(item.event.repo, "HengXin666/demo");
        assert.equal(item.event.runId, "42-2");
        assert.equal(item.event.kind, "context");
        assertSchema(item.event);
    }
    assert.deepEqual(sent[2]?.event.payload, { stage: "review", finder: { batch: 1, batches: 2 } });
    assert.deepEqual(sent[3]?.event.payload, { stage: "review", candidates: 4, verifier: { done: 1 } });
    assert.deepEqual(sent[6]?.event.payload, { complete: true, counts: { findings: 3, errors: 1, warnings: 2 } });
    assert.equal(liveRunId({}, "nonce-1"), "nonce-1");
});

test("live: a failing or rejecting send never throws and warns one line per event", async () => {
    const warnings: string[] = [];
    const broken = (async () => {
        throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const live = createLive(CTX, { env: ENV_ON, fetch: broken, warn: (line) => warnings.push(line) });
    live.stage("init", "done", 1);
    live.log("init", "error", "boom");
    await live.flush();
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /ECONNREFUSED/);

    const { fake } = recorder(403);
    const refused = createLive(CTX, { env: ENV_ON, fetch: fake, warn: (line) => warnings.push(line) });
    refused.stage("l0", "running");
    await refused.flush();
    assert.match(warnings[2] ?? "", /HTTP 403/);

    // A hung Worker is cut off by the timeout instead of stalling the run.
    const hung = ((_url: unknown, init?: RequestInit) =>
        new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        )) as typeof fetch;
    const slow = createLive(CTX, { env: ENV_ON, fetch: hung, timeoutMs: 20, warn: (line) => warnings.push(line) });
    slow.stage("publish", "running");
    await slow.flush();
    assert.equal(warnings.length, 4);
});

test("live: a log line over 4000 characters is clipped to 3900 plus ...", async () => {
    const { sent, fake } = recorder();
    const live = createLive(CTX, { env: ENV_ON, fetch: fake });
    live.log("review", "error", "x".repeat(LIVE_LOG_MAX + 500));
    live.log("review", "info", "y".repeat(LIVE_LOG_MAX));
    await live.flush();
    const first = sent[0]?.event.payload.message as string;
    assert.equal(first.length, LIVE_LOG_CLIP + 3);
    assert.ok(first.endsWith("..."));
    assert.equal((sent[1]?.event.payload.message as string).length, LIVE_LOG_MAX);
    for (const item of sent) {
        assertSchema(item.event);
    }
});
