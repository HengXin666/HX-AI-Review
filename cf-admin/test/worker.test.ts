import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deps } from "../worker/http.ts";
import { serve } from "../worker/index.ts";
import { FakeBlobs, FakeStore } from "./fake-store.ts";

const ORIGIN = "https://cf.test";

function setup(admin: string | null = "me@test") {
    const store = new FakeStore();
    const blobs = new FakeBlobs();
    let counter = 0;
    const deps: Deps = {
        store,
        blobs,
        secret: (name) => (name === "KEY_DEFAULT" ? "sk-live" : undefined),
        admin: async () => admin,
        overviewUrl: "https://overview.test",
        now: () => new Date("2026-10-11T00:00:00Z"),
        id: () => "run" + ++counter,
    };
    const call = (method: string, path: string, body?: unknown, token?: string) =>
        serve(
            new Request(ORIGIN + path, {
                method,
                headers: token ? { authorization: "Bearer " + token } : {},
                body: body === undefined ? undefined : JSON.stringify(body),
            }),
            deps,
        );
    return { store, blobs, call };
}

async function registered(admin = "me@test") {
    const ctx = setup(admin);
    await ctx.call("PUT", "/api/providers/default", { apiUrl: "https://llm.test/v1", keySecret: "KEY_DEFAULT" });
    const created = await ctx.call("POST", "/api/repos", {
        name: "o/r",
        finderModel: "small",
        verifierModel: "large",
        budgetUsd: 1,
    });
    const { token } = (await created.json()) as { token: string };
    return { ...ctx, token };
}

test("init returns api_url, key and model tiers only for a valid token", async () => {
    const { call, token } = await registered();
    assert.equal((await call("GET", "/init?repo=o/r")).status, 401);
    assert.equal((await call("GET", "/init?repo=x/y", undefined, token)).status, 403);
    const body = (await (await call("GET", "/init?repo=o/r", undefined, token)).json()) as Record<string, unknown>;
    assert.equal(body.apiUrl, "https://llm.test/v1");
    assert.equal(body.apiKey, "sk-live");
    assert.deepEqual(body.models, { finder: "small", verifier: "large" });
    assert.equal(body.l0Only, false);
});

test("disabled or over-budget repos get L0 config without a key", async () => {
    const { call, token, store } = await registered();
    await call("PATCH", "/api/repos/o/r", { enabled: false });
    let body = (await (await call("GET", "/init", undefined, token)).json()) as Record<string, unknown>;
    assert.equal(body.l0Only, true);
    assert.equal(body.apiKey, undefined);
    await call("PATCH", "/api/repos/o/r", { enabled: true });
    await store.advance(1, "abc", 1.5, "2026-10");
    body = (await (await call("GET", "/init", undefined, token)).json()) as Record<string, unknown>;
    assert.equal(body.l0Only, true);
    assert.match(String(body.reason), /budget/);
});

test("runs ingest stores rows, R2 blobs, advances last_sha; rejected feedback becomes a suppression", async () => {
    const { call, token, store, blobs } = await registered();
    const finding = {
        ruleId: "CX-AI",
        severity: "warning",
        path: "AGENTS.md",
        line: 3,
        message: "m",
        evidence: "e",
        fingerprint: "fp1",
    };
    const response = await call(
        "POST",
        "/runs",
        {
            repo: "o/r",
            sha: "abc",
            baseSha: "000",
            event: "push",
            status: "warned",
            usage: { input: 100, output: 10, cost: 0.2 },
            counts: { error: 0, warning: 1 },
            findings: [finding],
            patches: [{ fingerprint: "fp1", diff: "diff --git a/AGENTS.md b/AGENTS.md\n", applies: true }],
            reportMarkdown: "# r",
            reportJson: "{}",
            sessionsJsonl: "{}\n",
        },
        token,
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { runId: "run1", overviewUrl: "https://overview.test/#/runs/run1" });
    assert.equal(store.repos[0].lastSha, "abc");
    assert.equal(store.repos[0].spentUsd, 0.2);
    assert.ok(blobs.data.has("runs/o/r/run1/sessions.jsonl"));
    assert.equal(store.findings[0].patchKey, "runs/o/r/run1/patches/fp1.diff");
    const patch = await call("GET", "/api/findings/run1-0/patch");
    assert.match(await patch.text(), /AGENTS\.md/);

    assert.equal((await call("POST", "/feedback", { fingerprint: "fp1", verdict: "rejected" }, token)).status, 400);
    await call("POST", "/feedback", { fingerprint: "fp1", verdict: "rejected", reason: "wording is intended" }, token);
    const init = (await (await call("GET", "/init", undefined, token)).json()) as { suppressions: unknown[] };
    assert.deepEqual(init.suppressions, [{ fingerprint: "fp1", reason: "wording is intended" }]);
    assert.equal(store.findings[0].status, "rejected");
});

test("pull request runs do not move last_sha", async () => {
    const { call, token, store } = await registered();
    await call("POST", "/runs", { repo: "o/r", sha: "pr-head", prNumber: 7, findings: [] }, token);
    assert.equal(store.repos[0].lastSha, null);
});

test("admin API fails closed without an Access identity", async () => {
    const { call } = setup(null);
    assert.equal((await call("GET", "/api/overview")).status, 403);
    assert.equal((await call("POST", "/api/repos", { name: "o/r" })).status, 403);
});
