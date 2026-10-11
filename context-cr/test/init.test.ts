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

test("an unknown or missing l0Cause fails closed as config, so the range is not marked reviewed", () => {
    const l0 = { ...ok, l0Only: true, apiKey: undefined, apiUrl: undefined };
    assert.equal(parseInit({ ...l0, l0Cause: "budget" }).l0Cause, "budget");
    assert.equal(parseInit({ ...l0, l0Cause: "something-new" }).l0Cause, "config");
    assert.equal(parseInit(l0).l0Cause, "config");
});
