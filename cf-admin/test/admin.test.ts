import assert from "node:assert/strict";
import { test } from "node:test";
import { registered, setup } from "./harness.ts";

const provider = { apiUrl: "https://llm.test/v1", keySecret: "KEY_DEFAULT" };

test("provider names are validated and decoded; prices are required for a new provider", async () => {
    const { call } = setup();
    assert.equal(
        (await call("PUT", "/api/providers/my%20provider", { ...provider, priceInput: 1, priceOutput: 1 })).status,
        400,
    );
    assert.equal((await call("PUT", "/api/providers/new", provider)).status, 400);
    assert.equal(
        (await call("PUT", "/api/providers/new", { ...provider, priceInput: -1, priceOutput: 1 })).status,
        400,
    );
    assert.equal((await call("PUT", "/api/providers/new", { ...provider, priceInput: 0, priceOutput: 0 })).status, 200);
});

test("updating a provider keeps omitted prices and limits", async () => {
    const { call, store } = await registered();
    await call("PUT", "/api/providers/default", { maxTokens: 2048 });
    const saved = await store.provider("default");
    assert.equal(saved?.priceInput, 1);
    assert.equal(saved?.priceOutput, 2);
    assert.equal(saved?.maxTokens, 2048);
    assert.equal(saved?.apiUrl, "https://llm.test/v1");
});

test("a unique-constraint race on repo create maps to 409", async () => {
    const { call, store } = setup();
    store.createRepo = async () => {
        throw new Error("D1_ERROR: UNIQUE constraint failed: repos.name");
    };
    assert.equal((await call("POST", "/api/repos", { name: "a/b" })).status, 409);
});

test("a failed D1 insert removes the R2 objects of that run", async () => {
    const { call, token, store, blobs } = await registered();
    store.insertRun = async () => {
        throw new Error("D1 down");
    };
    const response = await call("POST", "/runs", { repo: "o/r", sha: "s", event: "push", findings: [] }, token);
    assert.equal(response.status, 500);
    assert.equal(blobs.data.size, 0);
});

test("only push events move last_sha; incomplete runs are never passed", async () => {
    const { call, token, store } = await registered();
    await call("POST", "/runs", { repo: "o/r", sha: "d1", event: "workflow_dispatch", findings: [] }, token);
    assert.equal(store.repos[0].lastSha, null);
    await call("POST", "/runs", { repo: "o/r", sha: "p1", event: "push", findings: [], complete: false }, token);
    assert.equal(store.repos[0].lastSha, null);
    assert.equal(store.runs.at(-1)?.status, "incomplete");
    await call("POST", "/runs", { repo: "o/r", sha: "p2", event: "push", findings: [] }, token);
    assert.equal(store.repos[0].lastSha, "p2");
});

test("cache tokens are charged at cache prices", async () => {
    const { call, token, store } = await registered();
    await call("PUT", "/api/providers/default", { priceCacheRead: 10 });
    const usage = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0, cost: 0 };
    await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "c", event: "pull_request", prNumber: 1, findings: [], usage },
        token,
    );
    assert.equal(store.repos[0].spentUsd, 10);
});

test("present-but-invalid repo fields are a 400, never silently ignored", async () => {
    const { call } = await registered();
    for (const body of [
        { budgetUsd: "5" },
        { budgetUsd: -1 },
        { mode: "fast" },
        { enabled: "yes" },
        { provider: "a b" },
    ]) {
        assert.equal((await call("PATCH", "/api/repos/o/r", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await call("POST", "/api/repos", { name: "x/y", budgetUsd: "ten" })).status, 400);
});

test("provider api protocol: unknown is a 400, omitted keeps the stored one; token limits are integers", async () => {
    const { call, store } = await registered();
    await call("PUT", "/api/providers/default", { api: "anthropic-messages" });
    await call("PUT", "/api/providers/default", { priceInput: 5 });
    assert.equal((await store.provider("default"))?.api, "anthropic-messages");
    assert.equal((await call("PUT", "/api/providers/default", { api: "openai-chat" })).status, 400);
    assert.equal((await call("PUT", "/api/providers/default", { maxTokens: 2048.5 })).status, 400);
});

test("runner status cannot override derived failed or incomplete; init carries the remaining budget", async () => {
    const { call, token, store } = await registered();
    await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "x", event: "push", findings: [], complete: false, status: "passed" },
        token,
    );
    assert.equal(store.runs.at(-1)?.status, "incomplete");
    assert.equal(
        (await call("POST", "/runs", { repo: "o/r", sha: "y", findings: [], status: "great" }, token)).status,
        400,
    );
    const init = (await (await call("GET", "/init", undefined, token)).json()) as { limits: { maxRunUsd: number } };
    assert.equal(init.limits.maxRunUsd, 1);
});

test("/runs rejects coerced values and keeps last_sha when the runner says incomplete", async () => {
    const { call, token, store } = await registered();
    const run = { repo: "o/r", sha: "a", event: "push", findings: [] };
    for (const extra of [{ complete: "false" }, { usage: { cost: "0.5" } }, { prNumber: "12" }, { durationMs: -1 }]) {
        assert.equal((await call("POST", "/runs", { ...run, ...extra }, token)).status, 400, JSON.stringify(extra));
    }
    await call("POST", "/runs", { ...run, status: "incomplete" }, token);
    assert.equal(store.runs.at(-1)?.status, "incomplete");
    assert.equal((await store.repoByName("o/r"))?.lastSha ?? null, null);
});

test("concurrent /init calls cannot both be handed the same unspent budget", async () => {
    const { call, token, store } = await registered();
    const read = async () => (await (await call("GET", "/init", undefined, token)).json()) as Record<string, unknown>;
    const repo = (await store.repoByName("o/r"))!;
    assert.equal(repo.budgetUsd, 1);
    // Two runs start before either reports its cost: the second must not get the same remainder.
    const [first, second] = await Promise.all([read(), read()]);
    const l0Only = [first.l0Only, second.l0Only].filter(Boolean);
    assert.equal(l0Only.length, 1);
    const blocked = first.l0Only ? first : second;
    assert.equal(blocked.l0Cause, "budget");
    assert.equal(blocked.apiKey, undefined);
    // Charging the finished run releases the claim, so the next run may claim the remainder again.
    await store.charge(repo.id, 0.25, "2026-10");
    const next = await read();
    assert.equal(next.l0Only, false);
    assert.equal((next.limits as { maxRunUsd: number }).maxRunUsd, 0.75);
});

test("an abandoned claim expires so a crashed run cannot block the month forever", async () => {
    const { call, token, store } = await registered();
    const read = async () => (await (await call("GET", "/init", undefined, token)).json()) as Record<string, unknown>;
    const repo = (await store.repoByName("o/r"))!;
    assert.equal((await read()).l0Only, false);
    assert.equal((await read()).l0Cause, "budget");
    // Older than the TTL: the claim is treated as abandoned and may be taken over.
    store.reservedAt.set(repo.id, "2000-01-01T00:00:00.000Z");
    assert.equal((await read()).l0Only, false);
});

test("init: a spent budget and invalid stored limits are machine-readable L0 causes", async () => {
    const { call, token, store } = await registered();
    const read = async () => (await (await call("GET", "/init", undefined, token)).json()) as Record<string, unknown>;
    const provider = (await store.provider("default"))!;
    await store.upsertProvider({ ...provider, maxTokens: 0 });
    assert.equal((await read()).l0Cause, "config");
    await store.upsertProvider(provider);
    // The harness clock is fixed; the real system month would land in a different budgetMonth and be ignored.
    await store.charge((await store.repoByName("o/r"))!.id, 5, "2026-10");
    const init = await read();
    assert.equal(init.l0Cause, "budget");
    assert.equal(init.apiKey, undefined);
});
