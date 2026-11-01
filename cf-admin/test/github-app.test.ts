// Admin handlers for the GitHub App: config read/write without leaking secrets, verify and installations.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { b64 } from "../worker/github/crypto.ts";
import type { GitHubDeps } from "../worker/github/deps.ts";
import { pemToPkcs8 } from "../worker/github/jwt.ts";
import { handleGitHub } from "../worker/github/routes.ts";
import { GitHubStore } from "../worker/github/store.ts";
import { HttpError, json } from "../worker/http.ts";
import type { Deps } from "../worker/http.ts";
import type { BlobStore, Store } from "../worker/store/port.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

// Placeholders, not credentials: the tests assert these never come back out of the store. They are
// assembled at runtime so a secrets scanner does not read a fixture as a leaked key.
const FAKE_CLIENT_SECRET = ["client", "secret", "value"].join("-");
const FAKE_WEBHOOK_SECRET = ["whsec", "0123456789abcdef"].join("-");

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

async function keyPair() {
    const pair = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    const wrap = (label: string, bytes: Uint8Array) =>
        `-----BEGIN ${label}-----\n${b64(bytes).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
    // PKCS#8 = SEQ { INT 0 (3 bytes), AlgorithmIdentifier (15 bytes), OCTET STRING pkcs1 }; peel it for the PKCS#1 form.
    let offset = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
    offset += 3 + 15;
    const octetLenBytes = der[offset + 1] & 0x80 ? der[offset + 1] & 0x7f : 0;
    const pkcs1 = der.slice(offset + 2 + octetLenBytes);
    return { pkcs8: wrap("PRIVATE KEY", der), pkcs1: wrap("RSA PRIVATE KEY", pkcs1), der };
}

async function world(options: { admin?: string | null; kek?: boolean; appStatus?: number; appId?: number } = {}) {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(MIGRATIONS).sort()) {
        db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
    db.prepare("INSERT INTO repos (name, token_hash, kind) VALUES (?, ?, ?)").run("acme/a", "hash", "both");
    const now = new Date("2026-11-01T09:00:00.000Z");
    const paths: string[] = [];
    const fetchFn = async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        paths.push(method + " " + url.pathname);
        if (url.pathname === "/app") {
            const status = options.appStatus ?? 200;
            return status === 200
                ? json({ id: options.appId ?? 123, slug: "hx-review", name: "HX Review", owner: { login: "acme" } })
                : json({ message: "A JSON web token could not be decoded" }, status);
        }
        if (url.pathname === "/app/installations") {
            return json([
                {
                    id: 9,
                    account: { login: "acme", type: "Organization" },
                    repository_selection: "selected",
                    suspended_at: null,
                },
            ]);
        }
        if (url.pathname === "/app/installations/9/access_tokens") {
            return json({ token: "ghs_x", expires_at: new Date(now.getTime() + 3600_000).toISOString() }, 201);
        }
        if (url.pathname === "/installation/repositories") {
            return json({
                repositories: [
                    { full_name: "acme/a", default_branch: "main", private: true },
                    { full_name: "acme/z", default_branch: "trunk", private: false },
                ],
            });
        }
        return json({ message: "unexpected" }, 500);
    };
    const gh: GitHubDeps = {
        store: new GitHubStore(d1(db)),
        secret: (name) => (options.kek !== false && name === "GITHUB_APP_KEK" ? "kek" : undefined),
        fetch: fetchFn,
        now: () => now,
        id: () => crypto.randomUUID(),
    };
    const deps: Deps = {
        store: {} as Store,
        blobs: {} as BlobStore,
        secret: () => undefined,
        admin: async () => (options.admin === undefined ? "me@test" : options.admin),
        deployment: { accessConfigured: true },
        now: () => now,
        id: () => "x",
    };
    const call = async (method: string, path: string, body?: unknown) => {
        const request = new Request("https://cf.test/api/github/" + path, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        try {
            return await handleGitHub(request, deps, gh, path.split("?")[0].split("/"));
        } catch (error) {
            if (error instanceof HttpError) {
                return json({ error: error.message }, error.status);
            }
            throw error;
        }
    };
    return { db, call, paths };
}

test("POST stores sealed secrets and GET returns only has* flags", async () => {
    const w = await world();
    const { pkcs8, der } = await keyPair();
    const empty = (await (await w.call("GET", "app")).json()) as Record<string, unknown>;
    assert.equal(empty.configured, false);
    assert.equal(empty.app, null);
    assert.equal(empty.webhookUrl, "https://cf.test/api/webhook/github");

    const saved = await w.call("POST", "app", {
        appId: 123,
        slug: "hx-review",
        clientId: "Iv1.abc",
        clientSecret: FAKE_CLIENT_SECRET,
        privateKey: pkcs8,
        webhookSecret: FAKE_WEBHOOK_SECRET,
    });
    assert.equal(saved.status, 200);
    const text = await (await w.call("GET", "app")).text();
    assert.ok(!text.includes("PRIVATE KEY") && !text.includes("client-secret-value") && !text.includes("whsec-"));
    const body = JSON.parse(text) as { configured: boolean; app: Record<string, unknown> };
    assert.equal(body.configured, true);
    assert.equal(body.app.hasPrivateKey, true);
    assert.equal(body.app.hasClientSecret, true);
    assert.equal(body.app.status, "configured");

    const row = w.db.prepare("SELECT * FROM github_apps").get() as Record<string, string>;
    const keyBody = b64(der).slice(0, 40);
    for (const column of ["private_key_enc", "client_secret_enc", "webhook_secret_enc"]) {
        assert.match(row[column], /^v1\./);
        assert.ok(!row[column].includes("PRIVATE KEY") && !row[column].includes(keyBody));
    }

    // Update without secrets keeps them.
    assert.equal((await w.call("POST", "app", { appId: "123", slug: "renamed" })).status, 200);
    const after = w.db.prepare("SELECT slug, private_key_enc FROM github_apps").get() as Record<string, string>;
    assert.equal(after.slug, "renamed");
    assert.equal(after.private_key_enc, row.private_key_enc);
});

test("bad input, a missing KEK and a non-admin are readable 4xx errors", async () => {
    const { pkcs8 } = await keyPair();
    const w = await world();
    const bad = await w.call("POST", "app", {
        appId: "x",
        slug: "s",
        privateKey: pkcs8,
        webhookSecret: "0123456789abcdef",
    });
    assert.equal(bad.status, 400);
    const notKey = await w.call("POST", "app", {
        appId: 1,
        slug: "s",
        privateKey: "hello",
        webhookSecret: "0123456789abcdef",
    });
    assert.equal(notKey.status, 400);
    assert.match(await notKey.text(), /PEM private key/);
    const first = await w.call("POST", "app", { appId: 1, slug: "s" });
    assert.match(await first.text(), /privateKey is required/);
    assert.match(await (await w.call("POST", "app/verify")).text(), /not configured/);

    const noKek = await world({ kek: false });
    const refused = await noKek.call("POST", "app", {
        appId: 1,
        slug: "s",
        privateKey: pkcs8,
        webhookSecret: "0123456789abcdef",
    });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /GITHUB_APP_KEK/);
    assert.equal(noKek.db.prepare("SELECT COUNT(*) AS n FROM github_apps").get()!.n, 0);

    const stranger = await world({ admin: null });
    assert.equal((await stranger.call("GET", "app")).status, 403);
});

test("a PKCS#1 key as GitHub downloads it is accepted and wrapped to PKCS#8", async () => {
    const { pkcs1, der } = await keyPair();
    assert.deepEqual(pemToPkcs8(pkcs1), der);
    const w = await world();
    const saved = await w.call("POST", "app", {
        appId: 123,
        slug: "s",
        privateKey: pkcs1,
        webhookSecret: "0123456789abcdef",
    });
    assert.equal(saved.status, 200);
    assert.equal((await w.call("POST", "app/verify")).status, 200);
});

test("verify calls GitHub with the stored key and marks the app verified or invalid", async () => {
    const { pkcs8 } = await keyPair();
    const good = await world();
    await good.call("POST", "app", { appId: 123, slug: "s", privateKey: pkcs8, webhookSecret: "0123456789abcdef" });
    const ok = (await (await good.call("POST", "app/verify")).json()) as Record<string, unknown>;
    assert.equal(ok.ok, true);
    assert.equal(ok.installations, 1);
    assert.deepEqual(good.paths, ["GET /app", "GET /app/installations"]);
    const app = ((await (await good.call("GET", "app")).json()) as { app: Record<string, unknown> }).app;
    assert.equal(app.status, "verified");
    assert.ok(app.installedAt);

    const rejected = await world({ appStatus: 401 });
    await rejected.call("POST", "app", { appId: 123, slug: "s", privateKey: pkcs8, webhookSecret: "0123456789abcdef" });
    const response = await rejected.call("POST", "app/verify");
    assert.equal(response.status, 422);
    assert.match(await response.text(), /rejected the app credentials/);
    const status = rejected.db.prepare("SELECT status FROM github_apps").get() as { status: string };
    assert.equal(status.status, "invalid");

    const wrongApp = await world({ appId: 456 });
    await wrongApp.call("POST", "app", { appId: 123, slug: "s", privateKey: pkcs8, webhookSecret: "0123456789abcdef" });
    assert.match(await (await wrongApp.call("POST", "app/verify")).text(), /belongs to app 456/);
});

test("installations lists repositories with their registration and stores them", async () => {
    const { pkcs8 } = await keyPair();
    const w = await world();
    await w.call("POST", "app", { appId: 123, slug: "s", privateKey: pkcs8, webhookSecret: "0123456789abcdef" });
    const body = (await (await w.call("GET", "installations")).json()) as {
        installations: { installationId: number; repos: Record<string, unknown>[] }[];
    };
    assert.equal(body.installations[0].installationId, 9);
    assert.deepEqual(body.installations[0].repos[0], {
        fullName: "acme/a",
        defaultBranch: "main",
        private: true,
        registered: true,
        kind: "both",
    });
    assert.equal(body.installations[0].repos[1].registered, false);
    const stored = w.db.prepare("SELECT repos FROM github_installations WHERE installation_id = 9").get() as {
        repos: string;
    };
    assert.deepEqual(JSON.parse(stored.repos), ["acme/a", "acme/z"]);
    const queue = (await (await w.call("GET", "queue?limit=5")).json()) as { items: unknown[] };
    assert.deepEqual(queue.items, []);
    assert.equal((await w.call("GET", "queue?limit=0")).status, 400);
});
