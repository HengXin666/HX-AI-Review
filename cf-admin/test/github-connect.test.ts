// One-click GitHub connection: manifest registration, callback, repository sync, enable / disable.
// node:sqlite runs every migration (0001-0008); GitHub is a recorded fake fetch; the repos table goes through the
// real D1Store, so enable / disable are checked against the SQL the Worker runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
    handleAppCallback,
    handleAppManifest,
    handleDisable,
    handleEnable,
    handleListRepos,
} from "../worker/github/connect.ts";
import { b64, unseal } from "../worker/github/crypto.ts";
import type { GitHubDeps } from "../worker/github/deps.ts";
import { blake2b, x25519 } from "../worker/github/sealbox.ts";
import { GitHubStore } from "../worker/github/store.ts";
import { HttpError, json } from "../worker/http.ts";
import type { Deps } from "../worker/http.ts";
import type { BlobStore } from "../worker/store/port.ts";
import { D1Store } from "../worker/store/d1.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const ORIGIN = "https://cf.test";
const KEK = "kek-for-tests";

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

/** A PKCS#1 PEM, as POST /app-manifests/{code}/conversions returns it. */
async function pkcs1Pem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let offset = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
    offset += 3 + 15;
    const octetLenBytes = der[offset + 1] & 0x80 ? der[offset + 1] & 0x7f : 0;
    const pkcs1 = der.slice(offset + 2 + octetLenBytes);
    return `-----BEGIN RSA PRIVATE KEY-----\n${b64(pkcs1).replace(/(.{64})/g, "$1\n")}\n-----END RSA PRIVATE KEY-----\n`;
}

type Recorded = {
    method: string;
    path: string;
    query: string;
    body: Record<string, unknown> | null;
    auth: string | null;
};
type Fail = Partial<Record<"conversion" | "publicKey" | "putFile" | "putSecret", number>>;

const RECIPIENT_PUBLIC = x25519(new Uint8Array(32).fill(7), Uint8Array.from([9, ...new Array(31).fill(0)]));

async function world(options: { admin?: string | null; kek?: boolean; fail?: Fail; pem?: string } = {}) {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(MIGRATIONS).sort()) {
        db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
    db.prepare("INSERT INTO repos (name, token_hash, kind) VALUES (?, ?, ?)").run("acme/a", "old-hash", "both");
    let clock = new Date("2026-11-01T09:00:00.000Z");
    const requests: Recorded[] = [];
    const fail = options.fail ?? {};
    const files = new Set<string>(["acme/a"]);
    const secrets = new Set<string>(["acme/a"]);
    const fetchFn = async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        requests.push({ method, path: url.pathname, query: url.search, body, auth: headers.get("authorization") });
        const path = url.pathname;
        const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(path)?.[1].replace("%2F", "/") ?? "";
        if (method === "POST" && path === "/app-manifests/good-code/conversions") {
            return fail.conversion
                ? json({ message: "bad code" }, fail.conversion)
                : json(
                      {
                          id: 4242,
                          slug: "hx-context-review-abc123",
                          pem: options.pem,
                          webhook_secret: "whsec-plain-0123456789",
                          client_id: "Iv1.client",
                          client_secret: "client-secret-plain",
                      },
                      201,
                  );
        }
        if (path === "/installation/repositories") {
            return json({
                total_count: 70,
                repositories: [
                    { full_name: "acme/a", default_branch: "main", private: true },
                    { full_name: "acme/z", default_branch: "trunk", private: false },
                ],
            });
        }
        if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
            return json({ full_name: repo, default_branch: repo === "acme/z" ? "trunk" : "main", private: false });
        }
        if (path.endsWith("/contents/.github/workflows/hx-context-review.yml")) {
            if (method === "GET") {
                return files.has(repo) ? json({ sha: "blob-sha-1" }) : json({ message: "Not Found" }, 404);
            }
            if (fail.putFile) {
                return json({ message: "Resource not accessible by integration" }, fail.putFile);
            }
            files.add(repo);
            return json({ content: { sha: "blob-sha-2" }, commit: { sha: "c1" } }, 201);
        }
        if (path.endsWith("/actions/secrets/public-key")) {
            return fail.publicKey
                ? json({ message: "Server Error" }, fail.publicKey)
                : json({ key_id: "kid-1", key: b64(RECIPIENT_PUBLIC) });
        }
        if (path.endsWith("/actions/secrets/HX_CTX_TOKEN")) {
            if (method === "GET") {
                return secrets.has(repo) ? json({ name: "HX_CTX_TOKEN" }) : json({ message: "Not Found" }, 404);
            }
            if (fail.putSecret) {
                return json({ message: "denied" }, fail.putSecret);
            }
            secrets.add(repo);
            return new Response(null, { status: 201 });
        }
        return json({ message: "unexpected " + method + " " + path }, 500);
    };
    const gh: GitHubDeps = {
        store: new GitHubStore(d1(db)),
        secret: (name) => (options.kek !== false && name === "GITHUB_APP_KEK" ? KEK : undefined),
        fetch: fetchFn,
        now: () => clock,
        id: () => crypto.randomUUID(),
        template: async () => null,
    };
    // A cached installation token keeps these tests off the App JWT path (covered by github-app.test.ts).
    await gh.store.cacheToken(9, "ghs_cached", "2026-11-01T12:00:00.000Z", KEK, clock.toISOString());
    const deps: Deps = {
        store: new D1Store(d1(db)),
        blobs: {} as BlobStore,
        secret: () => undefined,
        admin: async () => (options.admin === undefined ? "me@test" : options.admin),
        deployment: { accessConfigured: true },
        now: () => clock,
        id: () => "x",
    };
    const handlers: Record<string, (request: Request, deps: Deps, gh: GitHubDeps) => Promise<Response>> = {
        "GET app/manifest": handleAppManifest,
        "GET app/callback": handleAppCallback,
        "GET repos": handleListRepos,
        "POST enable": handleEnable,
        "POST disable": handleDisable,
    };
    const call = async (method: string, path: string, body?: unknown) => {
        const request = new Request(`${ORIGIN}/api/github/${path}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        try {
            return await handlers[method + " " + path.split("?")[0]](request, deps, gh);
        } catch (error) {
            if (error instanceof HttpError) {
                return json({ error: error.message }, error.status);
            }
            throw error;
        }
    };
    const advance = (ms: number) => {
        clock = new Date(clock.getTime() + ms);
    };
    return { db, call, requests, advance, files, secrets };
}

type ManifestBody = {
    action: string;
    state: string;
    expiresAt: string;
    manifest: {
        name: string;
        url: string;
        redirect_url: string;
        public: boolean;
        hook_attributes: { url: string; active: boolean };
        default_permissions: Record<string, string>;
        default_events: string[];
    };
};

test("manifest returns action, a stored one-time state and a manifest pointing at this Worker", async () => {
    const w = await world();
    const response = await w.call("GET", "app/manifest");
    assert.equal(response.status, 200);
    const body = (await response.json()) as ManifestBody;
    assert.equal(body.action, "https://github.com/settings/apps/new");
    assert.match(body.state, /^[\w-]{20,}$/);
    assert.equal(body.manifest.redirect_url, ORIGIN + "/api/github/app/callback");
    assert.deepEqual(body.manifest.hook_attributes, { url: ORIGIN + "/api/webhook/github", active: true });
    assert.equal(body.manifest.url, ORIGIN);
    assert.equal(body.manifest.public, false);
    assert.match(body.manifest.name, /^hx-context-review-[0-9a-f]{6}$/);
    assert.deepEqual(body.manifest.default_permissions, {
        actions: "write",
        contents: "write",
        pull_requests: "write",
        issues: "write",
        metadata: "read",
        secrets: "write",
        workflows: "write",
    });
    assert.deepEqual(body.manifest.default_events, [
        "push",
        "pull_request",
        "installation",
        "installation_repositories",
    ]);
    const row = w.db.prepare("SELECT used FROM github_app_states WHERE state = ?").get(body.state) as { used: number };
    assert.equal(row.used, 0);
    const second = (await (await w.call("GET", "app/manifest")).json()) as ManifestBody;
    assert.notEqual(second.state, body.state);
    assert.notEqual(second.manifest.name, body.manifest.name);
});

test("manifest requires an admin", async () => {
    const w = await world({ admin: null });
    assert.equal((await w.call("GET", "app/manifest")).status, 403);
    assert.equal((w.db.prepare("SELECT count(*) AS n FROM github_app_states").get() as { n: number }).n, 0);
});

test("callback with an unknown state answers 400, calls nothing and writes nothing", async () => {
    const w = await world({ pem: await pkcs1Pem() });
    const before = w.db.prepare("SELECT count(*) AS n FROM github_app_states").get();
    const response = await w.call("GET", "app/callback?code=good-code&state=never-issued");
    assert.equal(response.status, 400);
    assert.equal(w.requests.length, 0);
    assert.equal((w.db.prepare("SELECT count(*) AS n FROM github_apps").get() as { n: number }).n, 0);
    assert.deepEqual(w.db.prepare("SELECT count(*) AS n FROM github_app_states").get(), before);
    assert.equal((await w.call("GET", "app/callback?code=good-code")).status, 400);
});

test("callback stores the converted App sealed: no plaintext private key or secrets in github_apps", async () => {
    const pem = await pkcs1Pem();
    const w = await world({ pem });
    const { state } = (await (await w.call("GET", "app/manifest")).json()) as ManifestBody;
    const response = await w.call("GET", `app/callback?code=good-code&state=${state}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), ORIGIN + "/#/github?connected=1&slug=hx-context-review-abc123");
    const conversion = w.requests.find((item) => item.path === "/app-manifests/good-code/conversions");
    assert.equal(conversion?.method, "POST");
    assert.equal(conversion?.auth, null, "the conversion is authenticated by its code, not a JWT");

    const row = w.db.prepare("SELECT * FROM github_apps WHERE id = 1").get() as Record<string, string>;
    assert.equal(row.app_id, "4242");
    assert.equal(row.slug, "hx-context-review-abc123");
    assert.equal(row.client_id, "Iv1.client");
    assert.equal(row.status, "configured");
    const pemBody = pem.split("\n")[1];
    for (const column of Object.values(row)) {
        const text = String(column);
        assert.ok(!text.includes("PRIVATE KEY"), "PEM armor must not reach D1");
        assert.ok(!text.includes(pemBody), "PEM body must not reach D1");
        assert.ok(!text.includes("whsec-plain-0123456789"), "webhook secret must not reach D1");
        assert.ok(!text.includes("client-secret-plain"), "client secret must not reach D1");
    }
    assert.match(row.private_key_enc, /^v1\./);
    assert.equal(await unseal(row.private_key_enc, KEK), pem);
    assert.equal(await unseal(row.webhook_secret_enc, KEK), "whsec-plain-0123456789");
    assert.equal(await unseal(row.client_secret_enc, KEK), "client-secret-plain");

    // One-time: the same state cannot be replayed.
    assert.equal((await w.call("GET", `app/callback?code=good-code&state=${state}`)).status, 400);
});

test("callback rejects an expired state and redirects with a reason when GitHub refuses the code", async () => {
    const w = await world({ pem: await pkcs1Pem(), fail: { conversion: 404 } });
    const first = (await (await w.call("GET", "app/manifest")).json()) as ManifestBody;
    w.advance(11 * 60_000);
    assert.equal((await w.call("GET", `app/callback?code=good-code&state=${first.state}`)).status, 400);
    const second = (await (await w.call("GET", "app/manifest")).json()) as ManifestBody;
    const response = await w.call("GET", `app/callback?code=good-code&state=${second.state}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), ORIGIN + "/#/github?error=conversion_failed");
    assert.equal((w.db.prepare("SELECT count(*) AS n FROM github_apps").get() as { n: number }).n, 0);
});

test("callback without GITHUB_APP_KEK redirects with kek_missing and does not spend the code", async () => {
    const w = await world({ pem: await pkcs1Pem(), kek: false });
    w.db.prepare("INSERT INTO github_app_states (state, created_at) VALUES ('s1', '2026-11-01T08:59:00.000Z')").run();
    const response = await w.call("GET", "app/callback?code=good-code&state=s1");
    assert.equal(response.headers.get("location"), ORIGIN + "/#/github?error=kek_missing");
    assert.ok(!w.requests.some((item) => item.path.startsWith("/app-manifests/")));
});

type RepoItem = {
    fullName: string;
    defaultBranch: string;
    private: boolean;
    registered: boolean;
    kind: string | null;
    enabled: boolean;
    workflowInstalled: boolean;
    secretInstalled: boolean;
};

test("GET repos joins the installation's repositories with the repos table", async () => {
    const w = await world();
    const response = await w.call("GET", "repos?installationId=9");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { installationId: number; repos: RepoItem[] };
    assert.equal(body.installationId, 9);
    assert.deepEqual(body.repos, [
        {
            fullName: "acme/a",
            defaultBranch: "main",
            private: true,
            registered: true,
            kind: "both",
            enabled: true,
            workflowInstalled: true,
            secretInstalled: true,
        },
        {
            fullName: "acme/z",
            defaultBranch: "trunk",
            private: false,
            registered: false,
            kind: null,
            enabled: false,
            workflowInstalled: false,
            secretInstalled: false,
        },
    ]);
    const secretProbe = w.requests.find((item) => item.path === "/repos/acme/z/actions/secrets/HX_CTX_TOKEN");
    assert.equal(secretProbe?.method, "GET");
    const synced = w.db.prepare("SELECT repos FROM github_installations WHERE installation_id = 9").get() as {
        repos: string;
    };
    assert.deepEqual(JSON.parse(synced.repos), ["acme/a", "acme/z"]);
    assert.equal((await w.call("GET", "repos?installationId=abc")).status, 400);
});

test("GET repos page=2 asks GitHub for per_page=32&page=2 and echoes the page", async () => {
    const w = await world();
    const response = await w.call("GET", "repos?installationId=9&page=2");
    assert.equal(response.status, 200);
    const listing = w.requests.filter((item) => item.path === "/installation/repositories");
    assert.deepEqual(
        listing.map((item) => item.query),
        ["?per_page=32&page=2"],
    );
    const body = (await response.json()) as { page: number };
    assert.equal(body.page, 2);
    // Without ?page the first page is asked for.
    await w.call("GET", "repos?installationId=9");
    assert.equal(
        w.requests.filter((item) => item.path === "/installation/repositories")[1].query,
        "?per_page=32&page=1",
    );
    for (const bad of ["0", "1001", "-1", "1.5", "abc", ""]) {
        assert.equal((await w.call("GET", "repos?installationId=9&page=" + bad)).status, 400, "page=" + bad);
    }
});

test("GET repos passes GitHub's total_count through as totalCount", async () => {
    const w = await world();
    const body = (await (await w.call("GET", "repos?installationId=9")).json()) as {
        installationId: number;
        page: number;
        totalCount: number;
        repos: RepoItem[];
    };
    assert.equal(body.totalCount, 70);
    assert.equal(body.page, 1);
    assert.equal(body.repos.length, 2);
});

type EnableBody = {
    ok: boolean;
    steps: { name: string; ok: boolean; message: string }[];
    manualSecret?: { name: string; value: string };
};

test("enable writes workflow, sealed secret and registration; token hash matches the secret it wrote", async () => {
    const w = await world();
    const response = await w.call("POST", "enable", { fullName: "acme/z", kind: "code", installationId: 9 });
    const body = (await response.json()) as EnableBody;
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.deepEqual(
        body.steps.map((item) => [item.name, item.ok]),
        [
            ["workflow", true],
            ["secret", true],
            ["register", true],
        ],
    );
    assert.equal(body.manualSecret, undefined);

    const put = w.requests.find(
        (item) =>
            item.method === "PUT" && item.path === "/repos/acme/z/contents/.github/workflows/hx-context-review.yml",
    );
    assert.equal(put?.body?.message, "chore: enable hx-context-review");
    assert.equal(put?.body?.sha, undefined, "new file: no sha");
    const yaml = Buffer.from(String(put?.body?.content), "base64").toString("utf8");
    assert.match(yaml, /uses: HengXin666\/HX-AI-Review\/\.github\/workflows\/review\.yml@v1/);
    assert.match(yaml, /HX_CTX_TOKEN: \$\{\{ secrets\.HX_CTX_TOKEN \}\}/);
    assert.match(yaml, /workflow_dispatch:/);
    assert.match(yaml, /head_sha: \$\{\{ inputs\.head_sha/);
    assert.match(yaml, /branches: \[trunk\]/);
    assert.match(yaml, /fromJSON\('\["code"\]'\)/);
    assert.ok(!yaml.includes("__"), "every placeholder is rendered");

    const secretPut = w.requests.find(
        (item) => item.method === "PUT" && item.path === "/repos/acme/z/actions/secrets/HX_CTX_TOKEN",
    );
    assert.equal(secretPut?.body?.key_id, "kid-1");
    const sealed = Buffer.from(String(secretPut?.body?.encrypted_value), "base64");
    // ephemeral pk (32) + MAC (16) + "hxctx_" + 43 base64url chars
    assert.equal(sealed.length, 32 + 16 + 49);

    const row = w.db.prepare("SELECT kind, enabled, provider, token_hash FROM repos WHERE name = 'acme/z'").get() as {
        kind: string;
        enabled: number;
        provider: string;
        token_hash: string;
    };
    assert.equal(row.kind, "code");
    assert.equal(row.enabled, 1);
    assert.equal(row.provider, "default");
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test("enable keeps going when a step fails and says which one failed", async () => {
    const w = await world({ fail: { putFile: 403 } });
    const body = (await (
        await w.call("POST", "enable", { fullName: "acme/a", kind: "context", installationId: 9 })
    ).json()) as EnableBody;
    assert.equal(body.ok, false);
    assert.deepEqual(
        body.steps.map((item) => [item.name, item.ok]),
        [
            ["workflow", false],
            ["secret", true],
            ["register", true],
        ],
    );
    assert.match(body.steps[0].message, /Resource not accessible by integration/);
    const update = w.requests.find(
        (item) =>
            item.method === "PUT" && item.path === "/repos/acme/a/contents/.github/workflows/hx-context-review.yml",
    );
    assert.equal(update?.body?.sha, "blob-sha-1", "existing file is updated with its sha");
    const row = w.db.prepare("SELECT kind, token_hash FROM repos WHERE name = 'acme/a'").get() as {
        kind: string;
        token_hash: string;
    };
    assert.equal(row.kind, "context");
    assert.notEqual(row.token_hash, "old-hash", "secret written, so the token was rotated");
});

test("enable with a failed secret step still registers and hands over the token for a manual secret", async () => {
    const w = await world({ fail: { publicKey: 500 } });
    const body = (await (
        await w.call("POST", "enable", { fullName: "acme/z", kind: "both", installationId: 9 })
    ).json()) as EnableBody;
    assert.deepEqual(
        body.steps.map((item) => [item.name, item.ok]),
        [
            ["workflow", true],
            ["secret", false],
            ["register", true],
        ],
    );
    assert.equal(body.manualSecret?.name, "HX_CTX_TOKEN");
    const row = w.db.prepare("SELECT kind, token_hash FROM repos WHERE name = 'acme/z'").get() as {
        kind: string;
        token_hash: string;
    };
    assert.equal(row.kind, "both");
    assert.equal(row.token_hash, createHash("sha256").update(body.manualSecret!.value).digest("hex"));

    // Existing repository with a failed secret: its token is not rotated, so the secret it holds keeps working.
    const again = (await (
        await w.call("POST", "enable", { fullName: "acme/a", kind: "code", installationId: 9 })
    ).json()) as EnableBody;
    assert.equal(again.steps[1].ok, false);
    assert.equal(again.manualSecret, undefined);
    const kept = w.db.prepare("SELECT token_hash FROM repos WHERE name = 'acme/a'").get() as { token_hash: string };
    assert.equal(kept.token_hash, "old-hash");
});

test("enable validates its body before touching anything", async () => {
    const w = await world();
    assert.equal((await w.call("POST", "enable", { fullName: "nope", kind: "code", installationId: 9 })).status, 400);
    assert.equal((await w.call("POST", "enable", { fullName: "a/b", kind: "all", installationId: 9 })).status, 400);
    assert.equal((await w.call("POST", "enable", { fullName: "a/b", kind: "code", installationId: 0 })).status, 400);
    assert.equal(w.requests.length, 0);
});

test("disable only flips repos.enabled", async () => {
    const w = await world();
    const before = w.db.prepare("SELECT * FROM repos WHERE name = 'acme/a'").get() as Record<string, unknown>;
    const response = await w.call("POST", "disable", { fullName: "acme/a" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const after = w.db.prepare("SELECT * FROM repos WHERE name = 'acme/a'").get() as Record<string, unknown>;
    assert.equal(after.enabled, 0);
    const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
    assert.deepEqual(
        changed.filter((key) => key !== "updated_at"),
        ["enabled"],
    );
    assert.equal(w.requests.length, 0, "no GitHub call: the workflow file stays");
    assert.ok(w.files.has("acme/a") && w.secrets.has("acme/a"));
    assert.equal((await w.call("POST", "disable", { fullName: "acme/missing" })).status, 404);
});

test("sealbox primitives match RFC 7748 and RFC 7693 vectors", () => {
    const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
    const scalar = Buffer.from("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4", "hex");
    const point = Buffer.from("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c", "hex");
    assert.equal(hexOf(x25519(scalar, point)), "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552");
    assert.equal(
        hexOf(blake2b(new TextEncoder().encode("abc"), 64)),
        "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
            "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
});
