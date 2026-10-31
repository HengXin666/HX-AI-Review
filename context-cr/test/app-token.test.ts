import assert from "node:assert/strict";
import { test } from "node:test";
import { ENV } from "../src/constants.ts";
import { adoptGithubActor } from "../src/publish/app-token.ts";

const KEYS = [ENV.endpoint, ENV.token, ENV.githubToken, ENV.githubActor, ENV.githubActorVia] as const;

function restore(before: Record<string, string | undefined>) {
    for (const key of KEYS) {
        if (before[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = before[key];
        }
    }
}

test("the runner posts as the app when the worker mints a token, else as actions", async () => {
    const before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    const original = globalThis.fetch;
    try {
        process.env[ENV.endpoint] = "https://cf.test";
        process.env[ENV.token] = "hxctx_test";
        process.env[ENV.githubToken] = "ghs_actions";
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ token: "ghs_app", bot: "hx-ai-review[bot]" }), {
                status: 200,
            })) as typeof fetch;
        const app = await adoptGithubActor();
        assert.deepEqual(app, { login: "hx-ai-review[bot]", via: "app" });
        assert.equal(process.env[ENV.githubToken], "ghs_app");

        globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
        const fallback = await adoptGithubActor();
        assert.equal(fallback.via, "actions");
        assert.equal(process.env[ENV.githubToken], "ghs_app");
    } finally {
        globalThis.fetch = original;
        restore(before);
    }
});
