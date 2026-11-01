// POST /runs: only default-branch pushes move last_sha (review issue 9), and a truncated findings list
// does not distort the run's counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registered } from "./harness.ts";

const push = { repo: "o/r", event: "push", findings: [] };

test("last_sha moves only for a push to the default branch", async () => {
    const { call, token, store } = await registered();
    const post = (body: Record<string, unknown>) => call("POST", "/runs", { ...push, ...body }, token);
    assert.equal((await post({ sha: "f1", ref: "refs/heads/feature", defaultBranch: "main" })).status, 201);
    assert.equal(store.repos[0].lastSha, null);
    // No ref or no defaultBranch: the Worker cannot tell, so the cursor stays.
    await post({ sha: "n1" });
    await post({ sha: "n2", ref: "refs/heads/main" });
    await post({ sha: "n3", defaultBranch: "main" });
    assert.equal(store.repos[0].lastSha, null);
    // A tag is not a branch, even one named like the default branch.
    await post({ sha: "t1", ref: "refs/tags/main", defaultBranch: "main" });
    assert.equal(store.repos[0].lastSha, null);
    await post({ sha: "m1", ref: "refs/heads/main", defaultBranch: "main" });
    assert.equal(store.repos[0].lastSha, "m1");
    // Short and full branch names are the same branch (a master-default repo, review counterexample 5).
    await post({ sha: "m2", ref: "master", defaultBranch: "refs/heads/master" });
    assert.equal(store.repos[0].lastSha, "m2");
    await post({ sha: "m3", ref: "main", defaultBranch: "main" });
    assert.equal(store.repos[0].lastSha, "m3");
    // A feature-branch push after that leaves the default-branch cursor alone.
    await post({ sha: "f2", ref: "refs/heads/feature", defaultBranch: "main" });
    assert.equal(store.repos[0].lastSha, "m3");
    assert.equal((await post({ sha: "bad", ref: 7, defaultBranch: "main" })).status, 400);
});

test("a truncated run is counted from totalCounts, not from the findings it sent", async () => {
    const { call, token, store } = await registered();
    const warning = {
        ruleId: "CX-AI",
        severity: "warning",
        path: "AGENTS.md",
        line: 1,
        message: "m",
        fingerprint: "w",
    };
    const sent = await call(
        "POST",
        "/runs",
        {
            ...push,
            sha: "big",
            findings: [warning],
            truncated: true,
            totalCounts: { error: 3, warning: 700, blocking: 2 },
        },
        token,
    );
    assert.equal(sent.status, 201);
    const run = store.runs.at(-1)!;
    assert.equal(run.errors, 3);
    assert.equal(run.warnings, 700);
    // Two blocking Errors were cut from the list, but the run still fails.
    assert.equal(run.status, "failed");
});

test("truncated without totalCounts, or totals below the list, is a 400 before anything is written", async () => {
    const { call, token, store, blobs } = await registered();
    const error = {
        ruleId: "HC-CONTEXT",
        severity: "error",
        path: "AGENTS.md",
        line: 1,
        message: "m",
        fingerprint: "e",
    };
    const bodies = [
        { truncated: true },
        { truncated: "yes", totalCounts: { error: 1, warning: 0, blocking: 1 } },
        { totalCounts: { error: 0, warning: 0, blocking: 0 } },
        { totalCounts: { error: 1, warning: 0, blocking: 2 } },
        { totalCounts: { error: 1.5, warning: 0, blocking: 0 } },
        { totalCounts: [1, 0, 0] },
    ];
    for (const extra of bodies) {
        const response = await call("POST", "/runs", { ...push, sha: "x", findings: [error], ...extra }, token);
        assert.equal(response.status, 400, JSON.stringify(extra));
    }
    assert.equal(store.runs.length, 0);
    assert.equal(blobs.data.size, 0);
});

test("an untruncated run without totalCounts is still counted from its findings", async () => {
    const { call, token, store } = await registered();
    const warning = { ruleId: "CX-AI", severity: "warning", path: "a.md", line: 2, message: "m", fingerprint: "w" };
    await call("POST", "/runs", { ...push, sha: "s", findings: [warning], counts: { error: 9, warning: 9 } }, token);
    const run = store.runs.at(-1)!;
    assert.equal(run.errors, 0);
    assert.equal(run.warnings, 1);
    assert.equal(run.status, "warned");
});
