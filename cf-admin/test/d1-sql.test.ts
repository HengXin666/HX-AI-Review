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
        // D1Store.insertRun relies on batch being atomic, so this must be a real transaction: a later
        // statement failing rolls the earlier writes back instead of leaving them in the database.
        batch: async (items: { run: () => Promise<{ meta?: { changes?: number } }> }[]) => {
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

test("a later pull request run resolves missing L0 findings but not unchecked CX-AI rows", async () => {
    const { db, store, repo } = await seeded();
    const row = (id: string, runId: string, fingerprint: string, ruleId: string) => ({
        id,
        runId,
        repoId: repo.id,
        kind: "context" as const,
        fingerprint,
        ruleId,
        severity: "warning",
        path: "AGENTS.md",
        line: 1,
        message: "m",
        evidence: "e",
        patchKey: null,
        status: "open" as const,
    });
    const run = (id: string) => ({
        id,
        repoId: repo.id,
        kind: "context" as const,
        sha: id,
        baseSha: "base",
        event: "pull_request",
        prNumber: 9,
        status: "warned",
        l0Only: false,
        errors: 0,
        warnings: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 1,
        patchBranch: null,
        createdAt: "2026-10-11T00:00:00.000Z",
    });
    await store.insertRun(run("r1"), [
        row("r1-0", "r1", "keep", "CX-AI"),
        row("r1-1", "r1", "gone-l0", "HC-CONTEXT"),
        row("r1-2", "r1", "gone-ai", "CX-AI"),
    ]);
    await store.insertRun(run("r2"), [row("r2-0", "r2", "keep", "CX-AI")]);
    const changed = await store.resolveRound({
        repoId: repo.id,
        prNumber: 9,
        runId: "r2",
        kind: "context",
        seen: ["keep"],
        aiRechecked: false,
    });
    assert.equal(changed, 1);
    const status = (id: string) => (db.prepare("SELECT status FROM findings WHERE id = ?").get(id) as Row).status;
    assert.equal(status("r1-0"), "open");
    assert.equal(status("r1-1"), "resolved");
    assert.equal(status("r1-2"), "open");
    const published = await store.publishPrompt("finder", "Prefer the code.", "note");
    assert.equal(published.version, 1);
    assert.equal(published.active, true);
    const updated = await store.feedback({
        repoId: repo.id,
        fingerprint: "keep",
        verdict: "rejected",
        reason: "still true",
        source: "test",
    });
    assert.equal(updated, 2);
    const notes = db.prepare("SELECT reason FROM prompt_notes").all() as Row[];
    assert.equal(notes.length, 1);
    assert.equal(notes[0].reason, "still true");
});

test("same-line hits of one rule keep separate rows and feedback touches only its own finding", async () => {
    const { db, store, repo } = await seeded();
    const hit = {
        runId: "r1",
        repoId: repo.id,
        kind: "context" as const,
        ruleId: "HC-CONTEXT",
        severity: "warning",
        path: "src/index.ts",
        line: 7,
        message: "m",
        evidence: "e",
        patchKey: null,
        status: "open" as const,
    };
    await store.insertRun(
        {
            id: "r1",
            repoId: repo.id,
            kind: "context" as const,
            sha: "r1",
            baseSha: "base",
            event: "pull_request",
            prNumber: 9,
            status: "warned",
            l0Only: false,
            errors: 0,
            warnings: 2,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            durationMs: 1,
            patchBranch: null,
            createdAt: "2026-10-11T00:00:00.000Z",
        },
        [
            { ...hit, id: "r1-0", fingerprint: "fp-a" },
            { ...hit, id: "r1-1", fingerprint: "fp-b" },
        ],
    );
    const before = await store.ruleStats({}, 10);
    assert.equal(before.total, 2);
    assert.equal(before.byRule[0].files, 1);
    await store.feedback({
        repoId: repo.id,
        fingerprint: "fp-a",
        verdict: "rejected",
        reason: "intended",
        source: "test",
    });
    const rows = (
        db.prepare("SELECT finding_id, status, waived FROM rule_results ORDER BY finding_id").all() as Row[]
    ).map((row) => ({ finding_id: row.finding_id, status: row.status, waived: row.waived }));
    assert.deepEqual(rows, [
        { finding_id: "r1-0", status: "rejected", waived: 1 },
        { finding_id: "r1-1", status: "open", waived: 0 },
    ]);
});

test("the same file path in two repositories counts as two files", async () => {
    const { store, repo } = await seeded();
    const other = (await store.createRepo("o/s", "hash2", {}))!;
    const run = (id: string, repoId: number) => ({
        id,
        repoId,
        kind: "context" as const,
        sha: id,
        baseSha: "base",
        event: "push",
        prNumber: null,
        status: "warned",
        l0Only: false,
        errors: 0,
        warnings: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 1,
        patchBranch: null,
        createdAt: "2026-10-11T00:00:00.000Z",
    });
    const hit = (id: string, runId: string, repoId: number) => ({
        id,
        runId,
        repoId,
        kind: "context" as const,
        fingerprint: "fp",
        ruleId: "HC-CONTEXT",
        severity: "warning",
        path: "src/index.ts",
        line: 1,
        message: "m",
        evidence: "e",
        patchKey: null,
        status: "open" as const,
    });
    await store.insertRun(run("r1", repo.id), [hit("r1-0", "r1", repo.id)]);
    await store.insertRun(run("r2", other.id), [hit("r2-0", "r2", other.id)]);
    const stats = await store.ruleStats({}, 10);
    assert.equal(stats.total, 2);
    assert.equal(stats.byRule[0].files, 2);
});

test("a context round never resolves a code finding it did not look at", async () => {
    const db = migrated();
    const store = new D1Store(d1(db));
    const repo = await store.createRepo("o/both-kinds", "hash", { kind: "both", mode: "full" });
    const finding = (id: string, runId: string, kind: "context" | "code", fingerprint: string) => ({
        id,
        runId,
        repoId: repo.id,
        kind,
        fingerprint,
        ruleId: kind === "code" ? "CX-AI" : "HC-CONTEXT",
        severity: "warning",
        path: "a.ts",
        line: 1,
        message: "m",
        evidence: "e",
        patchKey: null,
        status: "open" as const,
    });
    const run = (id: string, kind: "context" | "code") => ({
        id,
        repoId: repo.id,
        kind,
        sha: id,
        baseSha: "base",
        event: "pull_request",
        prNumber: 7,
        status: "warned",
        l0Only: false,
        errors: 0,
        warnings: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 1,
        patchBranch: null,
        createdAt: "2026-10-11T00:00:00.000Z",
    });
    await store.insertRun(run("ctx1", "context"), [finding("ctx1-0", "ctx1", "context", "ctx-fp")]);
    await store.insertRun(run("code1", "code"), [finding("code1-0", "code1", "code", "code-fp")]);

    // The context round reports its own fingerprint only. The code finding is absent from that list, but
    // the context review never saw it, so it must stay open: it was not re-checked, only out of scope.
    await store.resolveRound({
        repoId: repo.id,
        prNumber: 7,
        runId: "ctx1",
        kind: "context",
        seen: ["ctx-fp"],
        aiRechecked: true,
    });

    const status = (id: string) => (db.prepare("SELECT status FROM findings WHERE id = ?").get(id) as Row).status;
    assert.equal(status("code1-0"), "open");
});
