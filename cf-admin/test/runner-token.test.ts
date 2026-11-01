// GET /github/token: the runner trades its own HX_CTX_TOKEN for an installation token of the product App, so a
// review comment appears as <slug>[bot] rather than github-actions[bot]. This capability existed on main before
// the merge (served from routes/github.ts over a plaintext github_app table); these tests pin it to the merged
// implementation, which reads the sealed github_apps table and looks the repository up from the token.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { newToken, sha256Hex } from "../worker/auth.ts";
import type { GitHubDeps } from "../worker/github/deps.ts";
import { handleRunnerToken } from "../worker/github/routes.ts";
import { GitHubStore } from "../worker/github/store.ts";
import { HttpError, json } from "../worker/http.ts";
import type { Deps } from "../worker/http.ts";
import { D1Store } from "../worker/store/d1.ts";
import type { BlobStore } from "../worker/store/port.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

function d1(db: DatabaseSync): D1Database {
    const statement = (sql: string) => {
        const stmt = db.prepare(sql);
        const bound = (args: unknown[]) => ({
            run: async () => ({ meta: { changes: Number(stmt.run(...(args as never[])).changes) } }),
            first: async <T>() => (stmt.get(...(args as never[])) as T | undefined) ?? null,
            all: async <T>() => ({ results: stmt.all(...(args as never[])) as T[] }),
        });
        return { ...bound([]), bind: (...args: unknown[]) => bound(args) };
    };
    return {
        prepare: statement,
        batch: async (items: { run: () => Promise<unknown> }[]) => {
            const out = [];
            for (const item of items) {
                out.push(await item.run());
            }
            return out;
        },
    } as unknown as D1Database;
}

async function pemKey(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let text = "";
    for (const byte of der) {
        text += String.fromCharCode(byte);
    }
    const body = btoa(text).replace(/(.{64})/g, "$1\n");
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

type Options = { installed?: boolean; suspended?: boolean };

async function world(options: Options = {}) {
    const sqlite = new DatabaseSync(":memory:");
    for (const file of readdirSync(MIGRATIONS).sort()) {
        sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
    const db = d1(sqlite);
    const now = new Date("2026-11-01T09:00:00.000Z");
    const store = new GitHubStore(db);
    const kek = "kek-value";
    await store.saveApp(
        {
            appId: "4242",
            slug: "hx-review",
            clientId: "",
            clientSecret: "",
            privateKey: await pemKey(),
            webhookSecret: "whsec-0123456789abcdef",
        },
        kek,
        now.toISOString(),
    );
    if (options.installed !== false) {
        sqlite
            .prepare(
                // Both column groups exist during the merge: account_login comes from 0006, repos and status
                // from 0008. A row must satisfy whatever 0006 declared NOT NULL.
                `INSERT INTO github_installations
                     (installation_id, account_login, account, account_type, repository_selection, repos, status,
                      created_at, updated_at)
                 VALUES (77, 'acme', 'acme', 'Organization', 'selected', '["acme/r"]', ?, ?, ?)`,
            )
            .run(options.suspended ? "suspended" : "active", now.toISOString(), now.toISOString());
    }
    sqlite.prepare("INSERT INTO repos (name, token_hash, kind) VALUES ('acme/r', '', 'context')").run();
    const token = newToken();
    const d1Store = new D1Store(db);
    await d1Store.setTokenHash("acme/r", await sha256Hex(token));
    const seen = { auth: "", body: "", url: "" };
    let exchanges = 0;
    const gh: GitHubDeps = {
        store,
        secret: (name) => (name === "GITHUB_APP_KEK" ? kek : undefined),
        fetch: async (url, init) => {
            exchanges += 1;
            seen.url = String(url);
            seen.auth = String((init?.headers as Record<string, string>).authorization ?? "");
            seen.body = String(init?.body ?? "");
            return json({ token: "ghs_test", expires_at: new Date(now.getTime() + 3600_000).toISOString() }, 201);
        },
        now: () => now,
        id: () => "id",
    };
    const deps: Deps = {
        store: d1Store,
        blobs: {} as BlobStore,
        secret: () => undefined,
        admin: async () => "me@test",
        deployment: { accessConfigured: true },
        now: () => now,
        id: () => "x",
    };
    const call = async (bearer: string) => {
        const request = new Request("https://cf.test/github/token", {
            headers: { authorization: "Bearer " + bearer },
        });
        try {
            return await handleRunnerToken(request, deps, gh);
        } catch (error) {
            if (error instanceof HttpError) {
                return json({ error: error.message }, error.status);
            }
            throw error;
        }
    };
    return {
        call,
        token,
        seen,
        gh,
        get exchanges() {
            return exchanges;
        },
    };
}

test("the runner mints an installation token for its own repository only", async () => {
    const w = await world();
    const response = await w.call(w.token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string; bot: string; installationId: number };
    assert.equal(body.token, "ghs_test");
    assert.equal(body.bot, "hx-review[bot]");
    assert.equal(body.installationId, 77);
    assert.match(w.seen.url, /\/app\/installations\/77\/access_tokens$/);
    assert.match(w.seen.auth, /^Bearer ey/);
    assert.match(w.seen.body, /"repositories":\["r"\]/);
});

test("an unknown token and an app not installed on the repo are readable 4xx", async () => {
    const w = await world();
    const bad = await w.call("hxctx_nope");
    assert.equal(bad.status, 401);
    assert.match(await bad.text(), /unknown HX_CTX_TOKEN/);

    const absent = await world({ installed: false });
    const nowhere = await absent.call(absent.token);
    assert.equal(nowhere.status, 404);
    assert.match(await nowhere.text(), /not installed/);
});

test("a suspended installation mints nothing", async () => {
    const w = await world({ suspended: true });
    const refused = await w.call(w.token);
    assert.equal(refused.status, 404);
});

test("a repository-scoped token is never cached, so one repo cannot act as another", async () => {
    const w = await world();
    assert.equal((await w.call(w.token)).status, 200);
    assert.equal((await w.call(w.token)).status, 200);
    // Two exchanges, deliberately: a cached per-repository token handed to a different repository would let
    // that repository comment and write workflows on the strength of someone else's installation.
    assert.equal(w.exchanges, 2);
});

test("the installation-wide token used for dispatch is still cached", async () => {
    const w = await world();
    assert.equal((await w.call(w.token)).status, 200);
    const before = w.exchanges;
    const { installationToken } = await import("../worker/github/tokens.ts");
    await installationToken(w.gh, 77);
    await installationToken(w.gh, 77);
    assert.equal(w.exchanges, before + 1, "the second installation-wide call must hit the cache");
});
