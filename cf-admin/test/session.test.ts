import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./harness.ts";

const CREDS = { user: "admin", password: "hx-context-review" };

test("a password session unlocks the overview when Access returns nobody", async () => {
    const { call } = setup(null, CREDS);
    assert.equal((await call("GET", "/api/overview")).status, 403);
    const bad = await call("POST", "/api/session", { user: "admin", password: "nope" });
    assert.equal(bad.status, 401);
    const login = await call("POST", "/api/session", CREDS);
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /hxctx_admin=/);
    assert.match(cookie, /HttpOnly/);
    const token = cookie.split(";")[0] ?? "";
    const overview = await call("GET", "/api/overview", undefined, undefined, { cookie: token });
    assert.equal(overview.status, 200);
    const body = (await overview.json()) as { deployment: { passwordLogin: boolean } };
    assert.equal(body.deployment.passwordLogin, true);
});

test("password login stays closed when Worker credentials are unset", async () => {
    const { call } = setup(null);
    assert.equal((await call("POST", "/api/session", CREDS)).status, 403);
    assert.equal((await call("GET", "/api/overview")).status, 403);
});
