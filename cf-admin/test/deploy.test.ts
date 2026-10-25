import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureWorkerRoute, findZone } from "../scripts/deploy.ts";

type Call = { url: string; method: string; body?: unknown };

/** Swap the global fetch for one scripted handler and restore it afterwards. */
function withFetch(handler: (call: Call) => Response | Promise<Response>, run: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const call: Call = { url: String(input), method: init?.method ?? "GET" };
        if (typeof init?.body === "string") {
            call.body = JSON.parse(init.body);
        }
        return handler(call);
    }) as typeof fetch;
    return run().finally(() => {
        globalThis.fetch = original;
    });
}

function json(result: unknown, status = 200): Response {
    return new Response(JSON.stringify({ result }), { status, headers: { "content-type": "application/json" } });
}

process.env.CLOUDFLARE_API_TOKEN = "test-token";
process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";

test("the zone is resolved by walking the hostname up to the first owned zone", async () => {
    const seen: string[] = [];
    await withFetch(
        (call) => {
            seen.push(call.url);
            const name = new URL(call.url).searchParams.get("name");
            return json(name === "woa.qzz.io" ? [{ id: "zone-1", name: "woa.qzz.io" }] : []);
        },
        async () => {
            const zone = await findZone("cr.woa.qzz.io");
            assert.deepEqual(zone, { id: "zone-1", name: "woa.qzz.io" });
        },
    );
    assert.deepEqual(
        seen.map((url) => new URL(url).searchParams.get("name")),
        ["woa.qzz.io"],
    );
});

test("a hostname with no owned zone is undefined, not an exception", async () => {
    await withFetch(
        () => json([]),
        async () => {
            assert.equal(await findZone("cr.example.com"), undefined);
        },
    );
});

test("an existing route to the same Worker is reused instead of duplicated", async () => {
    const posts: unknown[] = [];
    await withFetch(
        (call) => {
            if (call.method === "POST") {
                posts.push(call.body);
                return json({});
            }
            return json([{ pattern: "cr.woa.qzz.io/*", script: "hx-context-review" }]);
        },
        async () => {
            assert.equal(await ensureWorkerRoute("zone-1", "cr.woa.qzz.io", "hx-context-review"), "reused");
        },
    );
    assert.deepEqual(posts, []);
});

test("a missing route is created and reported", async () => {
    const bodies: unknown[] = [];
    await withFetch(
        (call) => {
            if (call.method === "POST") {
                bodies.push(call.body);
                return json({});
            }
            return json([]);
        },
        async () => {
            assert.equal(await ensureWorkerRoute("zone-1", "cr.woa.qzz.io", "hx-context-review"), "created");
        },
    );
    assert.deepEqual(bodies, [{ pattern: "cr.woa.qzz.io/*", script: "hx-context-review" }]);
});

test("a route pointing at another Worker is replaced, not silently kept", async () => {
    const bodies: unknown[] = [];
    await withFetch(
        (call) => {
            if (call.method === "POST") {
                bodies.push(call.body);
                return json({});
            }
            return json([{ pattern: "cr.woa.qzz.io/*", script: "some-other-worker" }]);
        },
        async () => {
            assert.equal(await ensureWorkerRoute("zone-1", "cr.woa.qzz.io", "hx-context-review"), "created");
        },
    );
    assert.deepEqual(bodies, [{ pattern: "cr.woa.qzz.io/*", script: "hx-context-review" }]);
});
