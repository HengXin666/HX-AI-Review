import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInit } from "../src/init/client.ts";

const ok = {
    repo: "o/r",
    l0Only: false,
    apiUrl: "https://llm.test/v1",
    apiKey: "sk",
    api: "anthropic-messages",
    models: { finder: "a", verifier: "b" },
    limits: { contextWindow: 1000, maxTokens: 100, maxCandidates: 5, maxRunUsd: 0.5 },
    pricing: { input: 1, output: 2 },
    // A capped non-L0 response always carries the reservation the runner must mark as spending.
    budgetClaim: "claim-1",
};

test("init keeps a valid config and its run budget", () => {
    const config = parseInit(ok);
    assert.equal(config.api, "anthropic-messages");
    assert.equal(config.limits.maxRunUsd, 0.5);
    assert.equal(parseInit({ ...ok, limits: { ...ok.limits, maxRunUsd: null } }).limits.maxRunUsd, null);
});

test("malformed init values fail instead of silently defaulting", () => {
    assert.throws(() => parseInit({ ...ok, api: "openai-chat" }), /protocol/);
    assert.throws(() => parseInit({ ...ok, pricing: { input: -1 } }), /pricing.input/);
    assert.throws(() => parseInit({ ...ok, limits: { ...ok.limits, maxTokens: 10.5 } }), /maxTokens/);
});

test("a missing run budget fails closed; only an explicit null means no cap", () => {
    const { maxRunUsd: _drop, ...limits } = ok.limits;
    assert.throws(() => parseInit({ ...ok, limits }), /maxRunUsd is required/);
    // L0-only runs never open a session, so there the missing field is harmless.
    assert.equal(parseInit({ ...ok, l0Only: true, limits }).limits.maxRunUsd, null);
});

test("a capped run without a budget claim fails closed instead of spending unmarked", () => {
    const { budgetClaim: _drop, ...noClaim } = ok;
    // Without the claim the runner cannot POST /spend, so a takeover would settle this run as free and
    // hand the same remainder out again. Refusing to parse keeps the range unreviewed instead.
    assert.throws(() => parseInit(noClaim), /budgetClaim is required/);
    // No cap means nothing to reserve: an uncapped Worker response carries no claim, and that must parse.
    // Keeping a claim here would make stepReview POST /spend for an uncapped run, which the Worker refuses.
    assert.equal(parseInit({ ...noClaim, limits: { ...noClaim.limits, maxRunUsd: null } }).budgetClaim, undefined);
    // An L0-only run never opens a session either, so it needs no claim whatever the cap says.
    assert.equal(parseInit({ ...noClaim, l0Only: true }).budgetClaim, undefined);
});

test("an unknown or missing l0Cause fails closed as config, so the range is not marked reviewed", () => {
    const l0 = { ...ok, l0Only: true, apiKey: undefined, apiUrl: undefined };
    assert.equal(parseInit({ ...l0, l0Cause: "budget" }).l0Cause, "budget");
    assert.equal(parseInit({ ...l0, l0Cause: "something-new" }).l0Cause, "config");
    assert.equal(parseInit(l0).l0Cause, "config");
});
