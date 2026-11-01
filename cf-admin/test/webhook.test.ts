// Webhook trigger path against real SQL: node:sqlite runs every migration, GitHub is a recorded fake fetch.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { b64 } from "../worker/github/crypto.ts";
import type { GitHubDeps } from "../worker/github/deps.ts";
import { GitHubStore } from "../worker/github/store.ts";
import { HttpError, json } from "../worker/http.ts";
import { handleGithubWebhook } from "../worker/routes/webhook.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const WEBHOOK_SECRET = "whsec-0123456789abcdef";
const KEK = "kek-for-tests";
const INSTALLATION = 77;

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
            db.exec("BEGIN");
            try {
                const out = [];
                for (const item of items) {
                    out.push(await item.run());
                }
                db.exec("COMMIT");
                return out;
            } catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
    } as unknown as D1Database;
}

async function pem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    return `-----BEGIN PRIVATE KEY-----\n${b64(der).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

type Call = { method: string; path: string; auth: string; body: unknown };

async function world(options: { repoKind?: string; dispatchStatus?: number } = {}) {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(MIGRATIONS).sort()) {
        db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
    db.prepare("INSERT INTO repos (name, token_hash, kind) VALUES (?, ?, ?)").run(
        "o/r",
        "hash",
        options.repoKind ?? "context",
    );
    const clock = { now: new Date("2026-11-01T09:00:00.000Z") };
    const calls: Call[] = [];
    let tokens = 0;
    let ids = 0;
    const fetchFn = async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        const headers = new Headers(init?.headers);
        const call = {
            method: init?.method ?? "GET",
            path: url.pathname,
            auth: headers.get("authorization") ?? "",
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        if (call.method === "POST" && call.path === `/app/installations/${INSTALLATION}/access_tokens`) {
            tokens++;
            return json(
                { token: "ghs_" + tokens, expires_at: new Date(clock.now.getTime() + 3600_000).toISOString() },
                201,
            );
        }
        if (call.method === "POST" && call.path.endsWith("/dispatches")) {
            const status = options.dispatchStatus ?? 204;
            return status === 204
                ? new Response(null, { status })
                : json({ message: "Workflow does not have 'workflow_dispatch' trigger" }, status);
        }
        return json({ message: "unexpected " + call.method + " " + call.path }, 500);
    };
    const store = new GitHubStore(d1(db));
    const gh: GitHubDeps = {
        store,
        secret: (name) => (name === "GITHUB_APP_KEK" ? KEK : undefined),
        fetch: fetchFn,
        now: () => clock.now,
        id: () => "q" + ++ids,
    };
    const privateKey = await pem();
    await store.saveApp(
        { appId: "123", slug: "hx-review", privateKey, webhookSecret: WEBHOOK_SECRET },
        KEK,
        clock.now.toISOString(),
    );
    await store.upsertInstallation(
        {
            installationId: INSTALLATION,
            account: "o",
            accountType: "User",
            repositorySelection: "selected",
            status: "active",
            repos: ["o/r"],
        },
        clock.now.toISOString(),
    );
    const send = async (event: string, payload: unknown, signature?: string) => {
        const body = JSON.stringify(payload);
        const sig = signature ?? "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
        const request = new Request("https://cf.test/api/webhook/github", {
            method: "POST",
            headers: { "X-Hub-Signature-256": sig, "x-github-event": event, "x-github-delivery": "d-" + Math.random() },
            body,
        });
        try {
            return await handleGithubWebhook(request, gh);
        } catch (error) {
            if (error instanceof HttpError) {
                return json({ error: error.message }, error.status);
            }
            throw error;
        }
    };
    const queue = () =>
        db.prepare("SELECT * FROM run_queue ORDER BY created_at, id").all() as Record<string, unknown>[];
    const dispatches = () => calls.filter((call) => call.path.endsWith("/dispatches"));
    const tokenCalls = () => calls.filter((call) => call.path.endsWith("/access_tokens"));
    return { db, gh, clock, calls, send, queue, dispatches, tokenCalls, privateKey };
}

function push(sha: string, ref = "refs/heads/main") {
    return {
        ref,
        after: sha,
        deleted: false,
        repository: { full_name: "o/r", default_branch: "main" },
        installation: { id: INSTALLATION },
    };
}

test("a wrong X-Hub-Signature-256 is 401 and writes nothing", async () => {
    const w = await world();
    const before = w.db.prepare("SELECT COUNT(*) AS n FROM github_installations").get() as { n: number };
    const bad = await w.send("push", push("a".repeat(40)), "sha256=" + "0".repeat(64));
    assert.equal(bad.status, 401);
    const missing = await w.send("push", push("a".repeat(40)), "");
    assert.equal(missing.status, 401);
    assert.equal(w.queue().length, 0);
    assert.equal(w.calls.length, 0);
    const after = w.db.prepare("SELECT COUNT(*) AS n FROM github_installations").get() as { n: number };
    assert.equal(after.n, before.n);
});

test("a push to a non-default branch does not trigger", async () => {
    const w = await world();
    const response = await w.send("push", push("b".repeat(40), "refs/heads/feature"));
    assert.equal(response.status, 202);
    assert.match(await response.text(), /not to the default branch/);
    assert.equal(w.queue().length, 0);
    assert.equal(w.dispatches().length, 0);
});

test("a push to the default branch queues and dispatches exactly once with head_sha and kind", async () => {
    const w = await world();
    const sha = "c".repeat(40);
    const response = await w.send("push", push(sha));
    assert.equal(response.status, 202);
    const rows = w.queue();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "dispatched");
    assert.equal(rows[0].sha, sha);
    assert.equal(rows[0].kind, "context");
    assert.equal(w.dispatches().length, 1);
    const dispatch = w.dispatches()[0];
    assert.equal(dispatch.path, "/repos/o/r/actions/workflows/hx-context-review.yml/dispatches");
    assert.equal(dispatch.auth, "Bearer ghs_1");
    assert.deepEqual(dispatch.body, { ref: "main", inputs: { head_sha: sha, kind: "context" } });
});

test("the same sha pushed again within 10 minutes triggers once; after the window it triggers again", async () => {
    const w = await world();
    const sha = "d".repeat(40);
    await w.send("push", push(sha));
    w.clock.now = new Date(w.clock.now.getTime() + 9 * 60_000);
    const again = await w.send("push", push(sha));
    assert.match(await again.text(), /duplicate/);
    assert.equal(w.queue().length, 1);
    assert.equal(w.dispatches().length, 1);
    w.clock.now = new Date(w.clock.now.getTime() + 2 * 60_000);
    await w.send("push", push(sha));
    assert.equal(w.queue().length, 2);
    assert.equal(w.dispatches().length, 2);
});

test("an unexpired installation token is reused from D1 and refreshed 5 minutes before expiry", async () => {
    const w = await world();
    await w.send("push", push("e".repeat(40)));
    await w.send("push", push("f".repeat(40)));
    assert.equal(w.tokenCalls().length, 1);
    assert.deepEqual(
        w.dispatches().map((call) => call.auth),
        ["Bearer ghs_1", "Bearer ghs_1"],
    );
    // Token lives 60 minutes; at minute 56 it is inside the 5-minute early-expiry margin.
    w.clock.now = new Date(w.clock.now.getTime() + 56 * 60_000);
    await w.send("push", push("1".repeat(40)));
    assert.equal(w.tokenCalls().length, 2);
    assert.equal(w.dispatches()[2].auth, "Bearer ghs_2");
    const stored = w.db.prepare("SELECT token_enc FROM github_installations").get() as { token_enc: string };
    assert.ok(!stored.token_enc.includes("ghs_"), "cached token is sealed, not plaintext");
});

test("the app JWT is RS256 with iat backdated 60 s and exp within 10 minutes", async () => {
    const w = await world();
    await w.send("push", push("2".repeat(40)));
    const jwt = w.tokenCalls()[0].auth.slice("Bearer ".length);
    const [head, claims] = jwt
        .split(".")
        .slice(0, 2)
        .map((part) => JSON.parse(Buffer.from(part, "base64url").toString()));
    const now = Math.floor(w.clock.now.getTime() / 1000);
    assert.equal(head.alg, "RS256");
    assert.equal(claims.iss, "123");
    assert.equal(claims.iat, now - 60);
    assert.ok(claims.exp - now <= 600 && claims.exp > now);
});

test("a failed dispatch is recorded in run_queue with its reason, and a redelivery may retry it", async () => {
    const w = await world({ dispatchStatus: 422 });
    const sha = "3".repeat(40);
    const response = await w.send("push", push(sha));
    assert.equal(response.status, 202);
    const [row] = w.queue();
    assert.equal(row.status, "failed");
    assert.match(String(row.error), /422 Workflow does not have 'workflow_dispatch' trigger/);
    await w.send("push", push(sha));
    assert.equal(w.queue().length, 2, "a failed attempt does not block the retry");
});

test("a repo registered for both kinds queues one review per kind", async () => {
    const w = await world({ repoKind: "both" });
    await w.send("push", push("4".repeat(40)));
    assert.deepEqual(
        w.queue().map((row) => row.kind),
        ["context", "code"],
    );
    assert.equal(w.dispatches().length, 2);
});

test("pull_request synchronize triggers, fork and draft PRs and other actions do not", async () => {
    const w = await world();
    const pr = (action: string, extra: Record<string, unknown> = {}) => ({
        action,
        number: 5,
        pull_request: { number: 5, draft: false, head: { sha: "5".repeat(40), repo: { full_name: "o/r" } }, ...extra },
        repository: { full_name: "o/r", default_branch: "main" },
        installation: { id: INSTALLATION },
    });
    assert.match(await (await w.send("pull_request", pr("closed"))).text(), /does not trigger/);
    assert.match(await (await w.send("pull_request", pr("opened", { draft: true }))).text(), /draft/);
    const fork = pr("opened", { head: { sha: "6".repeat(40), repo: { full_name: "x/r" } } });
    assert.match(await (await w.send("pull_request", fork)).text(), /fork/);
    assert.equal(w.queue().length, 0);
    await w.send("pull_request", pr("synchronize"));
    const [row] = w.queue();
    assert.equal(row.event, "pull_request");
    assert.equal(row.pr_number, 5);
    assert.equal(w.dispatches().length, 1);
});

test("installation and installation_repositories webhooks keep installation state", async () => {
    const w = await world();
    const installation = { id: 99, account: { login: "acme", type: "Organization" }, repository_selection: "selected" };
    await w.send("installation", { action: "created", installation, repositories: [{ full_name: "acme/a" }] });
    assert.equal(await w.gh.store.installationIdForRepo("acme/a"), 99);
    assert.ok((await w.gh.store.app())?.installedAt);
    await w.send("installation_repositories", {
        action: "added",
        installation,
        repositories_added: [{ full_name: "acme/b" }],
        repositories_removed: [{ full_name: "acme/a" }],
    });
    assert.deepEqual((await w.gh.store.installation(99))?.repos, ["acme/b"]);
    await w.send("installation", { action: "deleted", installation });
    assert.equal((await w.gh.store.installation(99))?.status, "deleted");
    assert.equal(await w.gh.store.installationIdForRepo("acme/b"), null);
});
