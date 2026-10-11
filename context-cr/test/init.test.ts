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
