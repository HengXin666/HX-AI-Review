import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { webhookSignature } from "../worker/github/crypto.ts";
import { installationCovers } from "../worker/routes/github.ts";
import { registered } from "./harness.ts";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
}) as string;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SIGNING_PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

function appBody(pem = PEM) {
    return {
        appId: 4242,
        slug: "hx-ai-review",
        name: "HX AI Review",
        privateKey: pem,
        webhookSecret: "webhook-secret-value",
    };
}

test("an installation token is minted only for the repo that holds the HX token", async () => {
    let seenAuth = "";
    let seenBody = "";
    const ctx = await registered("me@test", async (url, init) => {
        seenAuth = String((init.headers as Record<string, string>).authorization);
        seenBody = String(init.body);
        assert.match(url, /\/app\/installations\/77\/access_tokens$/);
        return new Response(JSON.stringify({ token: "ghs_test", expires_at: "2026-10-11T01:00:00Z" }), { status: 201 });
    });
    const saved = await ctx.call("PUT", "/api/github/app", appBody(SIGNING_PEM));
    assert.equal(saved.status, 200);
    const view = (await (await ctx.call("GET", "/api/github/app")).json()) as Record<string, unknown>;
    assert.equal(view.bot, "hx-ai-review[bot]");
    assert.equal(JSON.stringify(view).includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(view).includes("webhook-secret-value"), false);

    const payload = JSON.stringify({
        action: "created",
        installation: { id: 77, account: { login: "acme", type: "Organization" }, repository_selection: "selected" },
        repositories: [{ full_name: "o/r" }],
    });
    const sig = await webhookSignature("webhook-secret-value", payload);
    const bad = await fetchHook(ctx, payload, "sha256=00");
    assert.equal(bad.status, 401);
    const hooked = await fetchHook(ctx, payload, sig);
    assert.equal(hooked.status, 200);

    const missing = await ctx.call("GET", "/github/token", undefined, "hxctx_nope");
    assert.equal(missing.status, 401);
    const minted = await ctx.call("GET", "/github/token", undefined, ctx.token);
    assert.equal(minted.status, 200);
    const token = (await minted.json()) as { token: string; bot: string };
    assert.equal(token.token, "ghs_test");
    assert.equal(token.bot, "hx-ai-review[bot]");
    assert.match(seenBody, /"repositories":\["r"\]/);
    const jwt = seenAuth.replace("Bearer ", "");
    const [head, payloadPart, signature] = jwt.split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${head}.${payloadPart}`);
    assert.equal(verify.verify(publicKey, Buffer.from(signature, "base64url")), true);

    ctx.store.installations[0].suspended = true;
    const paused = await ctx.call("GET", "/github/token", undefined, ctx.token);
    assert.equal(paused.status, 404);
});

test("the manifest callback stores the app github created and rejects a reused state", async () => {
    const ctx = await registered("me@test", async () => {
        return new Response(
            JSON.stringify({
                id: 9,
                slug: "hx-ai-review",
                name: "HX AI Review",
                pem: PEM,
                webhook_secret: "from-github-secret",
                html_url: "https://github.com/apps/hx-ai-review",
                owner: { login: "HengXin666" },
            }),
            { status: 201 },
        );
    });
    const started = await ctx.call("POST", "/api/github/manifest");
    assert.equal(started.status, 200);
    const { state, action, manifest } = (await started.json()) as {
        state: string;
        action: string;
        manifest: { default_permissions: { pull_requests: string }; redirect_url: string };
    };
    assert.match(action, /^https:\/\/github.com\/settings\/apps\/new\?state=/);
    assert.equal(manifest.default_permissions.pull_requests, "write");
    assert.equal(manifest.redirect_url, "https://overview.test/api/github/setup");
    const done = await ctx.call("GET", `/api/github/setup?code=once&state=${state}`);
    assert.equal(done.status, 200);
    assert.match(await done.text(), /已登记/);
    const again = await ctx.call("GET", `/api/github/setup?code=once&state=${state}`);
    assert.equal(again.status, 400);
    const view = (await (await ctx.call("GET", "/api/github/app")).json()) as { appId: number; ownerLogin: string };
    assert.equal(view.appId, 9);
    assert.equal(view.ownerLogin, "HengXin666");
});

test("all-repos installations cover the account, selected ones do not", () => {
    const selected = {
        installationId: 1,
        accountLogin: "acme",
        accountType: "Organization",
        repos: ["acme/one"],
        allRepos: false,
        suspended: false,
    };
    assert.equal(installationCovers(selected, "acme/one"), true);
    assert.equal(installationCovers(selected, "acme/two"), false);
    assert.equal(installationCovers({ ...selected, repos: [], allRepos: true }, "acme/two"), true);
    assert.equal(installationCovers({ ...selected, allRepos: true, suspended: true }, "acme/two"), false);
});

type HookCtx = {
    call: (
        method: string,
        path: string,
        body?: unknown,
        token?: string,
        headers?: Record<string, string>,
    ) => Promise<Response>;
};

function fetchHook(ctx: HookCtx, payload: string, signature: string): Promise<Response> {
    return ctx.call("POST", "/github/webhook", payload, undefined, {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": signature,
    });
}
