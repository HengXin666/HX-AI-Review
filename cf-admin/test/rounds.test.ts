import assert from "node:assert/strict";
import { test } from "node:test";
import { registered } from "./harness.ts";

const finding = (fingerprint: string, ruleId: string) => ({
    ruleId,
    severity: ruleId === "HC-CONTEXT" ? "error" : "warning",
    path: "AGENTS.md",
    line: 2,
    message: fingerprint,
    evidence: "e",
    fingerprint,
});

test("a later commit on the same pull request resolves findings that were not reported again", async () => {
    const { call, token, store } = await registered();
    await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "a", prNumber: 4, findings: [finding("stay", "CX-AI"), finding("gone", "HC-CONTEXT")] },
        token,
    );
    const second = await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "b", prNumber: 4, findings: [finding("stay", "CX-AI")], complete: true, l0Only: false },
        token,
    );
    assert.equal(second.status, 201);
    assert.equal(((await second.json()) as { resolved: number }).resolved, 1);
    assert.equal(store.findings.find((item) => item.fingerprint === "gone")?.status, "resolved");
    assert.equal(store.findings.find((item) => item.fingerprint === "stay" && item.runId === "run1")?.status, "open");
});

test("an incomplete run does not resolve CX-AI findings it did not re-check", async () => {
    const { call, token, store } = await registered();
    await call("POST", "/runs", { repo: "o/r", sha: "a", prNumber: 5, findings: [finding("ai", "CX-AI")] }, token);
    const second = await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "b", prNumber: 5, findings: [], complete: false, l0Only: false },
        token,
    );
    assert.equal(((await second.json()) as { resolved: number }).resolved, 0);
    assert.equal(store.findings[0].status, "open");
});

test("rejecting a finding writes a suppression and an unfolded prompt note that can be folded", async () => {
    const { call, token, store } = await registered();
    await call("POST", "/runs", { repo: "o/r", sha: "a", findings: [finding("fp", "CX-AI")] }, token);
    const rejected = await call("POST", "/api/findings/run1-0/feedback", { verdict: "rejected", reason: "intended" });
    assert.equal(rejected.status, 200);
    assert.equal(store.notes.length, 1);
    assert.equal(store.supp.get("1:fp")?.reason, "intended");
    const folded = await call("POST", "/api/prompts/fold", { role: "finder" });
    assert.equal(folded.status, 201);
    const body = (await folded.json()) as { version: { id: number; body: string; active: boolean }; folded: number };
    assert.equal(body.folded, 1);
    assert.match(body.version.body, /intended/);
    assert.equal(store.notes[0].foldedInto, body.version.id);
    const init = (await (await call("GET", "/init", undefined, token)).json()) as {
        prompts: { finder: { body: string } | null };
    };
    assert.match(init.prompts.finder?.body ?? "", /intended/);
});
