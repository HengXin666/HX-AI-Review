import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureDnsRecord, ensurePagesDomain, findZone } from "../scripts/deploy.ts";

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

test("a missing zone fails the deploy instead of skipping the attach", async () => {
    await withFetch(
        () => json([]),
        async () => {
            await assert.rejects(ensurePagesDomain("hx-context-review", "cr.example.com"), /no Cloudflare zone found/);
        },
    );
});

test("an existing matching CNAME is reused and a mismatching one is left alone", async () => {
    const posts: unknown[] = [];
    await withFetch(
        (call) => {
            if (call.method === "POST") {
                posts.push(call.body);
                return json({});
            }
            return json([{ type: "CNAME", content: "hx-context-review.pages.dev" }]);
        },
        async () => {
            assert.equal(await ensureDnsRecord("zone-1", "cr.woa.qzz.io", "hx-context-review.pages.dev"), "reused");
        },
    );
    assert.deepEqual(posts, []);

    await withFetch(
        () => json([{ type: "A", content: "192.0.2.1" }]),
        async () => {
            const outcome = await ensureDnsRecord("zone-1", "cr.woa.qzz.io", "hx-context-review.pages.dev");
            assert.match(outcome, /left alone \(existing A -> 192\.0\.2\.1\)/);
        },
    );
});

test("a missing record is created as a proxied CNAME and reported", async () => {
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
            assert.equal(await ensureDnsRecord("zone-1", "cr.woa.qzz.io", "hx-context-review.pages.dev"), "created");
        },
    );
    assert.deepEqual(bodies, [
        { type: "CNAME", name: "cr.woa.qzz.io", content: "hx-context-review.pages.dev", proxied: true },
    ]);
});
test("a token without DNS permission names the missing permission, not just 403", async () => {
    await withFetch(
        () => new Response(JSON.stringify({ success: false }), { status: 403 }),
        async () => {
            await assert.rejects(
                ensureDnsRecord("zone-1", "cr.woa.qzz.io", "hx-context-review.pages.dev"),
                /lacks DNS:Edit/,
            );
        },
    );
});
