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
