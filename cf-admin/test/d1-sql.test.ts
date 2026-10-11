// Real-SQL coverage for D1Store: node:sqlite runs the actual migrations, so a placeholder/bind mismatch
// or a SQL function the local emulator lacks fails here instead of in production.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { D1Store } from "../worker/store/d1.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

type Row = Record<string, unknown>;

/** The subset of D1Database that D1Store uses, backed by node:sqlite (same SQLite family, JSON1 included). */
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
            for (const item of items) {
                await item.run();
            }
            return [];
        },
    } as unknown as D1Database;
}

function migrated(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(MIGRATIONS).sort()) {
        db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
    return db;
}

async function seeded() {
    const db = migrated();
    const store = new D1Store(d1(db));
    await store.upsertProvider({
        name: "default",
        apiUrl: "https://llm.test/v1",
        api: "openai-completions",
        keySecret: "K",
        contextWindow: 128000,
        maxTokens: 8192,
        priceInput: 1,
        priceOutput: 2,
        priceCacheRead: 0,
        priceCacheWrite: 0,
    });
    const repo = await store.createRepo("o/r", "hash", {
        enabled: true,
        mode: "full",
        provider: "default",
        finderModel: "f",
        verifierModel: "v",
        budgetUsd: 1,
    });
    const spent = async () =>
        Number((db.prepare("SELECT spent_usd FROM repos WHERE id = ?").get(repo!.id) as Row).spent_usd);
    const claim = async () =>
        (db.prepare("SELECT budget_claim FROM repos WHERE id = ?").get(repo!.id) as Row).budget_claim;
    return { db, store, repo: repo!, spent, claim };
}

test("the migrations apply to a real database and the seeded repo is readable", async () => {
    const { store, repo } = await seeded();
    assert.equal(repo.budgetUsd, 1);
    assert.equal((await store.repoByName("o/r"))!.name, "o/r");
});

test("charge binds every placeholder: a real /runs settlement records the cost and frees the claim", async () => {
    const { store, repo, spent, claim } = await seeded();
    const held = await store.reserveBudget(
        repo.id,
        "c1",
        "g",
        1,
        "2026-10",
        "2026-10-11T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z",
    );
    assert.deepEqual(held, { claimed: true, remainingUsd: 1 });
    // This is the call that failed when charge had one placeholder more than bind arguments: the run row
    // was already written, so a throw here loses the settlement for a run that really happened.
    await store.charge(repo.id, 0.25, "2026-10", "c1");
    assert.equal(await spent(), 0.25);
    assert.equal(await claim(), "");
});

test("a takeover settles a spending claim, and its late report replaces the allowance", async () => {
    const { store, repo, spent } = await seeded();
    const now = "2026-10-11T00:00:00.000Z";
    const far = "2030-01-01T00:00:00.000Z";
    await store.reserveBudget(repo.id, "A", "g", 1, "2026-10", now, far);
    await store.startSpend(repo.id, "A");
    // Run B supersedes A in the same group: A's allowance is charged, since A may never report.
    assert.deepEqual(await store.reserveBudget(repo.id, "B", "g", 1, "2026-10", now, far), {
        claimed: true,
        remainingUsd: 0,
    });
    assert.equal(await spent(), 1);
    // A reports late with its real cost: it must replace the settled allowance, not be added to it.
    await store.charge(repo.id, 0.3, "2026-10", "A");
    assert.ok(Math.abs((await spent()) - 0.3) < 1e-9, `spent ${await spent()}`);
    // B then reports its own cost on top.
    await store.charge(repo.id, 0.2, "2026-10", "B");
    assert.ok(Math.abs((await spent()) - 0.5) < 1e-9, `spent ${await spent()}`);
});

test("a claim taken over in a later month does not consume the new month's budget", async () => {
    const { store, repo, spent } = await seeded();
    await store.reserveBudget(repo.id, "A", "g", 1, "2026-09", "2026-09-11T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
    await store.startSpend(repo.id, "A");
    const held = await store.reserveBudget(
        repo.id,
        "B",
        "g",
        1,
        "2026-10",
        "2026-10-11T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z",
    );
    assert.deepEqual(held, { claimed: true, remainingUsd: 1 });
    assert.equal(await spent(), 0);
});
