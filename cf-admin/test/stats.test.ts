// /api/stats/usage and /api/stats/summary: route behaviour on the fake store, and the real SQL on node:sqlite.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import type { Deps } from "../worker/http.ts";
import { serve } from "../worker/router.ts";
import { D1Store } from "../worker/store/d1.ts";
import type { RunRow, Store } from "../worker/store/port.ts";
import { FakeBlobs, FakeStore } from "./fake-store.ts";
import { ORIGIN, setup } from "./harness.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
/** Fixed clock for these tests: mid November 2026, UTC. */
const NOW = new Date(Date.UTC(2026, 10, 15, 12));

type Usage = {
    from: string;
    to: string;
    group: string;
    totals: Record<string, number>;
    buckets: ({ key: string } & Record<string, number>)[];
};

function runRow(id: string, repoId: number, day: string, extra: Partial<RunRow> = {}): RunRow {
    return {
        id,
        repoId,
        kind: "context",
        sha: "s-" + id,
        baseSha: "",
        event: "push",
        prNumber: null,
        status: "passed",
        l0Only: false,
        errors: 0,
        warnings: 0,
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0,
        durationMs: 1,
        patchBranch: null,
        createdAt: day + "T08:00:00.000Z",
        ...extra,
    };
}

/** The same fixture in any Store: two repos, a failed run, an incomplete zero-token run, one old run. */
async function seed(store: Store) {
    const a = await store.createRepo("o/a", "ha", { provider: "free" });
    const b = await store.createRepo("o/b", "hb", { provider: "other", kind: "both" });
    const rows = [
        runRow("r1", a.id, "2026-11-14"),
        runRow("r2", a.id, "2026-11-14", { kind: "code", inputTokens: 200, outputTokens: 20 }),
        runRow("r3", b.id, "2026-11-13", { status: "failed", inputTokens: 50, outputTokens: 5, errors: 1 }),
        runRow("r4", b.id, "2026-11-13", { status: "incomplete", inputTokens: 0, outputTokens: 0 }),
        runRow("r5", a.id, "2026-10-20", { inputTokens: 1000, outputTokens: 100 }),
    ];
    for (const row of rows) {
        await store.insertRun(row, []);
    }
}

function fakeDeps(store: Store): Deps {
    return {
        store,
        blobs: new FakeBlobs(),
        secret: () => undefined,
        admin: async () => "me@test",
        deployment: { accessConfigured: true },
        now: () => NOW,
        id: () => "id",
    };
}

function caller(store: Store) {
    const deps = fakeDeps(store);
    return async (path: string, method = "GET") => serve(new Request(ORIGIN + path, { method }), deps);
}

function d1(db: DatabaseSync) {
    const statement = (sql: string) => {
        const stmt = db.prepare(sql);
        return {
            bind: (...args: unknown[]) => ({
                run: async () => ({ meta: { changes: Number(stmt.run(...(args as never[])).changes) } }),
                first: async <T>() => (stmt.get(...(args as never[])) as T | undefined) ?? null,
                all: async <T>() => ({ results: stmt.all(...(args as never[])) as T[] }),
            }),
            run: async () => ({ meta: { changes: Number(stmt.run().changes) } }),
        };
    };
    return {
        prepare: statement,
        batch: async (items: { run: () => Promise<unknown> }[]) => {
            db.exec("BEGIN");
            try {
                const results = [];
                for (const item of items) {
                    results.push(await item.run());
                }
                db.exec("COMMIT");
                return results;
            } catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
    } as unknown as D1Database;
}

function realStore(): D1Store {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(MIGRATIONS).sort()) {
        db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
    return new D1Store(d1(db));
}

/** Every scenario runs against the fake store and the real SQL, so the two cannot drift apart. */
const STORES: [string, () => Store][] = [
    ["fake", () => new FakeStore()],
    ["d1", () => realStore()],
];

for (const [name, make] of STORES) {
    test(`${name}: an empty database gives all-zero totals and no buckets`, async () => {
        const call = caller(make());
        const response = await call("/api/stats/usage");
        assert.equal(response.status, 200);
        const body = (await response.json()) as Usage;
        assert.equal(body.group, "day");
        assert.equal(body.to, "2026-11-15");
        assert.equal(body.from, "2026-10-17");
        assert.deepEqual(body.totals, {
            runs: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            costUsd: 0,
            failedRuns: 0,
            incompleteRuns: 0,
            zeroTokenRuns: 0,
            repos: 0,
        });
        assert.deepEqual(body.buckets, []);
        const summary = (await (await call("/api/stats/summary")).json()) as Record<string, unknown>;
        assert.equal(summary.tokenChangePct, null);
        assert.equal(summary.activeRepos, 0);
        assert.equal((summary.last7Days as unknown[]).length, 7);
    });

    test(`${name}: day buckets are newest first and keep failed and zero-token runs apart`, async () => {
        const store = make();
        await seed(store);
        const body = (await (await caller(store)("/api/stats/usage?from=2026-11-01&to=2026-11-30")).json()) as Usage;
        assert.equal(body.totals.runs, 4);
        assert.equal(body.totals.inputTokens, 350);
        assert.equal(body.totals.outputTokens, 35);
        assert.equal(body.totals.failedRuns, 1);
        assert.equal(body.totals.incompleteRuns, 1);
        assert.equal(body.totals.zeroTokenRuns, 1);
        assert.equal(body.totals.repos, 2);
        assert.deepEqual(
            body.buckets.map((row) => [row.key, row.runs, row.inputTokens, row.failedRuns, row.incompleteRuns]),
            [
                ["2026-11-14", 2, 300, 0, 0],
                ["2026-11-13", 2, 50, 1, 1],
            ],
        );
        assert.equal(body.buckets[1].zeroTokenRuns, 1);
    });

    test(`${name}: repo, provider, kind and status groups aggregate by name, largest first`, async () => {
        const store = make();
        await seed(store);
        const call = caller(store);
        const get = async (group: string) =>
            ((await (await call(`/api/stats/usage?from=2026-11-01&to=2026-11-30&group=${group}`)).json()) as Usage)
                .buckets;
        assert.deepEqual(
            (await get("repo")).map((row) => [row.key, row.runs, row.inputTokens, row.failedRuns]),
            [
                ["o/a", 2, 300, 0],
                ["o/b", 2, 50, 1],
            ],
        );
        assert.deepEqual(
            (await get("provider")).map((row) => [row.key, row.inputTokens]),
            [
                ["free", 300],
                ["other", 50],
            ],
        );
        assert.deepEqual(
            (await get("kind")).map((row) => [row.key, row.runs, row.inputTokens]),
            [
                ["code", 1, 200],
                ["context", 3, 150],
            ],
        );
        const status = await get("status");
        assert.deepEqual(
            status.map((row) => [row.key, row.runs, row.failedRuns, row.incompleteRuns]),
            [
                ["passed", 2, 0, 0],
                ["failed", 1, 1, 0],
                ["incomplete", 1, 0, 1],
            ],
        );
    });

    test(`${name}: from and to filter by UTC day, both ends inclusive`, async () => {
        const store = make();
        await seed(store);
        const call = caller(store);
        const one = (await (await call("/api/stats/usage?from=2026-11-13&to=2026-11-13")).json()) as Usage;
        assert.equal(one.totals.runs, 2);
        assert.deepEqual(
            one.buckets.map((row) => row.key),
            ["2026-11-13"],
        );
        const october = (await (await call("/api/stats/usage?from=2026-10-01&to=2026-10-31")).json()) as Usage;
        assert.equal(october.totals.runs, 1);
        assert.equal(october.totals.inputTokens, 1000);
        const all = (await (await call("/api/stats/usage?from=1970-01-01")).json()) as Usage;
        assert.equal(all.totals.runs, 5);
    });

    test(`${name}: summary compares this month with the last and fills seven days`, async () => {
        const store = make();
        await seed(store);
        const body = (await (await caller(store)("/api/stats/summary")).json()) as {
            month: string;
            previousMonth: string;
            current: Record<string, number>;
            previous: Record<string, number>;
            tokenChangePct: number | null;
            activeRepos: number;
            last7Days: { day: string; totalTokens: number; runs: number; failedRuns: number }[];
        };
        assert.equal(body.month, "2026-11");
        assert.equal(body.previousMonth, "2026-10");
        assert.equal(body.current.totalTokens, 385);
        assert.equal(body.current.runs, 4);
        assert.equal(body.current.failedRuns, 1);
        assert.equal(body.current.incompleteRuns, 1);
        assert.equal(body.previous.totalTokens, 1100);
        assert.equal(body.tokenChangePct, -65);
        assert.equal(body.activeRepos, 2);
        assert.deepEqual(
            body.last7Days.map((row) => [row.day, row.totalTokens, row.runs]),
            [
                ["2026-11-09", 0, 0],
                ["2026-11-10", 0, 0],
                ["2026-11-11", 0, 0],
                ["2026-11-12", 0, 0],
                ["2026-11-13", 55, 2],
                ["2026-11-14", 330, 2],
                ["2026-11-15", 0, 0],
            ],
        );
    });
}

test("bad parameters are a 400, never silently defaulted", async () => {
    const call = caller(new FakeStore());
    for (const query of [
        "group=week",
        "from=2026-13-01",
        "from=2026-02-30",
        "to=yesterday",
        "from=2026-11-10&to=2026-11-01",
    ]) {
        assert.equal((await call("/api/stats/usage?" + query)).status, 400, query);
    }
});

test("stats routes require an admin and are read only", async () => {
    const { call } = setup(null);
    assert.equal((await call("GET", "/api/stats/usage")).status, 403);
    assert.equal((await call("GET", "/api/stats/summary")).status, 403);
    const admin = caller(new FakeStore());
    assert.equal((await admin("/api/stats/usage", "POST")).status, 405);
    assert.equal((await admin("/api/stats/nope")).status, 404);
});
