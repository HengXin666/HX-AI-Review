import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyAccess } from "../worker/auth.ts";
import { ORIGIN, registered, setup } from "./harness.ts";

test("non-API GETs go to the assets binding, so the overview and the API share one hostname", async () => {
    const seen: string[] = [];
    const assets = {
        fetch: async (request: Request) => {
            seen.push(new URL(request.url).pathname);
            return new Response("<!doctype html><div id=root></div>", {
                headers: { "content-type": "text/html" },
            });
        },
    } as unknown as Fetcher;
    const { call } = setup("me@test", undefined, assets);
    const page = await call("GET", "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id=root/);
    const deep = await call("GET", "/runs/42");
    assert.equal(deep.status, 200);
    assert.deepEqual(seen, ["/", "/runs/42"]);
});

test("the API still wins over assets on the shared hostname", async () => {
    const seen: string[] = [];
    const assets = {
        fetch: async (request: Request) => {
            seen.push(new URL(request.url).pathname);
            return new Response("asset");
        },
    } as unknown as Fetcher;
    const { call } = setup("me@test", undefined, assets);
    assert.equal((await call("GET", "/api/overview")).status, 200);
    assert.equal((await call("GET", "/healthz")).status, 200);
    assert.deepEqual(seen, []);
});

test("a run defaults to context and a repo registered for code rejects a context run", async () => {
    const { call, token } = await registered();
    const plain = await call("GET", "/init?repo=o/r", undefined, token);
    assert.equal(((await plain.json()) as Record<string, unknown>).kind, "context");

    const asCode = await call("GET", "/init?repo=o/r&kind=code", undefined, token);
    assert.equal(asCode.status, 400);
    assert.match(await asCode.text(), /registered for context reviews/);

    assert.equal((await call("PATCH", "/api/repos/o/r", { kind: "both" })).status, 200);
    const both = await call("GET", "/init?repo=o/r&kind=code", undefined, token);
    assert.equal(both.status, 200);
    assert.equal(((await both.json()) as Record<string, unknown>).kind, "code");
});

test("a code run does not advance last_sha, because it says nothing about the context files", async () => {
    const { call, token, store } = await registered();
    await call("PATCH", "/api/repos/o/r", { kind: "both" });
    const init = (await (await call("GET", "/init?repo=o/r&kind=code", undefined, token)).json()) as Record<
        string,
        unknown
    >;
    // A code run must not inherit the context cursor either.
    assert.equal(init.lastSha, undefined);

    const posted = await call(
        "POST",
        "/runs",
        {
            repo: "o/r",
            sha: "abc",
            baseSha: "def",
            event: "push",
            kind: "code",
            complete: true,
            findings: [
                {
                    ruleId: "CODE-AI",
                    severity: "warning",
                    path: "src/a.ts",
                    line: 3,
                    message: "unchecked null",
                    evidence: "e",
                    fingerprint: "fp-code",
                },
            ],
            budgetClaim: init.budgetClaim,
        },
        token,
    );
    assert.equal(posted.status, 201);
    assert.equal(store.repos[0].lastSha, null);
    assert.equal(store.runs[0].kind, "code");
    assert.equal(store.findings[0].kind, "code");
});

test("mode l0 with kind code is refused, because a code review has no deterministic stage", async () => {
    const { call, token } = await registered();
    await call("PATCH", "/api/repos/o/r", { kind: "both", mode: "l0" });
    const refused = await call("GET", "/init?repo=o/r&kind=code", undefined, token);
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /mode is l0 but the requested kind is code/);
    // The context kind is still fine: it does have L0 rules to run.
    const context = await call("GET", "/init?repo=o/r&kind=context", undefined, token);
    assert.equal(context.status, 200);
    assert.equal(((await context.json()) as Record<string, unknown>).l0Only, true);
});

test("the repo kind is validated and an unknown value is a 400", async () => {
    const { call } = await registered();
    assert.equal((await call("PATCH", "/api/repos/o/r", { kind: "nope" })).status, 400);
    assert.equal(
        (await call("POST", "/runs", { repo: "o/r", sha: "a", kind: "nope", findings: [] }, undefined)).status,
        401,
    );
});

test("without an assets binding the Worker answers 404 instead of pretending to serve a page", async () => {
    const { call } = setup();
    assert.equal((await call("GET", "/")).status, 404);
});

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
    await store.charge(1, 1.5, "2026-10", "");
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
    assert.deepEqual(await response.json(), {
        runId: "run1",
        overviewUrl: "https://overview.test/#/runs/run1",
        resolved: 0,
    });
    assert.equal(store.repos[0].lastSha, "abc");
    assert.equal(store.repos[0].spentUsd, 0.2);
    assert.equal(store.runs[0].status, "warned");
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

test("pull request runs are charged but do not move last_sha", async () => {
    const { call, token, store } = await registered();
    const usage = { input: 1_000_000, output: 0, cost: 0 };
    await call("POST", "/runs", { repo: "o/r", sha: "pr-head", prNumber: 7, findings: [], usage }, token);
    assert.equal(store.repos[0].lastSha, null);
    assert.equal(store.repos[0].spentUsd, 1);
});

test("incomplete push runs keep last_sha so the range is reviewed again", async () => {
    const { call, token, store } = await registered();
    await call("POST", "/runs", { repo: "o/r", sha: "s1", findings: [], complete: false }, token);
    assert.equal(store.repos[0].lastSha, null);
});

test("invalid findings are rejected before anything is written; status derives from findings", async () => {
    const { call, token, store, blobs } = await registered();
    const bad = await call("POST", "/runs", { repo: "o/r", sha: "s", findings: [null], reportMarkdown: "x" }, token);
    assert.equal(bad.status, 400);
    assert.equal(blobs.data.size, 0);
    const error = {
        ruleId: "HC-CONTEXT",
        severity: "error",
        path: "a/AGENTS.md",
        line: 1,
        message: "m",
        evidence: "e",
    };
    const findings = [
        { ...error, fingerprint: "new1", origin: "new" },
        { ...error, fingerprint: "old1", origin: "historical" },
    ];
    await call("POST", "/runs", { repo: "o/r", sha: "s2", findings }, token);
    assert.equal(store.runs[0].status, "failed");
    assert.equal(store.runs[0].errors, 2);
    assert.deepEqual(
        store.findings.map((item) => item.fingerprint),
        ["new1"],
    );
});

test("null, fractional and missing required fields are 400s, never coerced defaults", async () => {
    const { call, token } = await registered();
    const base = { repo: "o/r", sha: "s", findings: [] };
    const post = (body: Record<string, unknown>) => call("POST", "/runs", body, token);
    // An explicit null is a present-but-invalid value, not an omission.
    assert.equal((await post({ ...base, prNumber: null })).status, 400);
    assert.equal((await post({ ...base, event: null })).status, 400);
    assert.equal((await post({ ...base, durationMs: null })).status, 400);
    // Token counts and durations are integers; fractions would be billed and stored in integer columns.
    assert.equal((await post({ ...base, durationMs: 1.5 })).status, 400);
    assert.equal((await post({ ...base, usage: { input: 1.5 } })).status, 400);
    assert.equal((await post({ ...base, usage: { cost: 0.5 } })).status, 201);
    // finding.line is required: a missing line must not be filed as line 1.
    const finding = { ruleId: "HC-CONTEXT", severity: "error", path: "a/AGENTS.md", message: "m", evidence: "e" };
    assert.equal((await post({ ...base, findings: [{ ...finding, fingerprint: "f" }] })).status, 400);
    assert.equal((await post({ ...base, findings: [{ ...finding, fingerprint: "f", line: 2 }] })).status, 201);
});

test("patches with invalid fields are a 400; only a valid non-applying patch is dropped", async () => {
    const { call, token, store, blobs } = await registered();
    const base = { repo: "o/r", sha: "s", findings: [] };
    const post = (patches: unknown[]) => call("POST", "/runs", { ...base, patches }, token);
    assert.equal((await post([{ fingerprint: "fp", diff: "d" }])).status, 400);
    assert.equal((await post([{ fingerprint: "fp", applies: "yes", diff: "d" }])).status, 400);
    assert.equal((await post([{ applies: true, diff: "d" }])).status, 400);
    // A well-formed patch that does not apply is skipped on purpose, not an error.
    assert.equal((await post([{ fingerprint: "fp", applies: false, diff: "d" }])).status, 201);
    // The mandatory report blob only proves the run wrote something; the dropped patch must have no object.
    assert.equal(blobs.data.has(`runs/o/r/${store.runs[0].id}/report.md`), true);
    assert.equal(blobs.data.has(`runs/o/r/${store.runs[0].id}/patches/fp.diff`), false);
    assert.equal(store.runs[0].status, "passed");
});

test("repo names are case-insensitive and malformed Access tokens are a 403, not a 500", async () => {
    const { call, token } = await registered();
    assert.equal((await call("GET", "/init?repo=O/R", undefined, token)).status, 200);
    assert.equal((await call("POST", "/api/repos", { name: "O/R" })).status, 409);
    const garbage = new Request(ORIGIN + "/api/overview", { headers: { "cf-access-jwt-assertion": "%%%.@@@.###" } });
    assert.equal(await verifyAccess(garbage, "aud", "team.cloudflareaccess.com"), null);
});

test("admin API fails closed without an Access identity", async () => {
    const { call } = setup(null);
    assert.equal((await call("GET", "/api/overview")).status, 403);
    assert.equal((await call("POST", "/api/repos", { name: "o/r" })).status, 403);
});

test("an Access assertion that decodes to JSON null is unauthenticated, not a 500", async () => {
    const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "");
    const request = new Request(ORIGIN + "/api/overview", {
        headers: { "cf-access-jwt-assertion": `${part(null)}.${part({})}.c2ln` },
    });
    assert.equal(await verifyAccess(request, "aud", "team.example"), null);
});
