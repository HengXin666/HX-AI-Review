// Budget claims through the real routes: per-run caps (review issue 2) and one claim per run, so different
// concurrency groups run at the same time (review issue 3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { registered } from "./harness.ts";

type Init = Record<string, unknown> & { limits: { maxRunUsd: number | null } };

async function budgeted(budgetUsd: number, perRunCapUsd: number) {
    const ctx = await registered();
    await ctx.store.updateRepo("o/r", { budgetUsd, perRunCapUsd });
    const repo = (await ctx.store.repoByName("o/r"))!;
    const init = async (group = "") =>
        (await (
            await ctx.call("GET", group ? `/init?group=${encodeURIComponent(group)}` : "/init", undefined, ctx.token)
        ).json()) as Init;
    const spent = () => ctx.store.repos.find((item) => item.id === repo.id)!.spentUsd;
    const close = (actual: number, expected: number) =>
        assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
    return { ...ctx, repo, init, spent, close };
}

test("two different groups claiming at the same time both get a model run", async () => {
    const { init, store, repo } = await budgeted(20, 5);
    // kind both: the context job and the code job have different concurrency groups and start together.
    const [context, code] = await Promise.all([init("pr-7-context"), init("pr-7-code")]);
    for (const body of [context, code]) {
        assert.equal(body.l0Only, false);
        assert.equal(body.l0Cause, undefined);
        assert.equal(body.apiKey, "sk-live");
        assert.equal(body.limits.maxRunUsd, 5);
    }
    assert.notEqual(context.budgetClaim, code.budgetClaim);
    const open = await store.openClaims(repo.id, "2026-10");
    assert.deepEqual(open.map((item) => item.group).sort(), ["pr-7-code", "pr-7-context"]);
});

test("concurrent claims never hand out more than the month: the run past the remainder is L0-only", async () => {
    const { init, close } = await budgeted(1, 0.4);
    const bodies = await Promise.all([init("a"), init("b"), init("c")]);
    const granted = bodies.filter((body) => !body.l0Only).map((body) => body.limits.maxRunUsd as number);
    // 0.4 + 0.4 + the last 0.2: the sum is the budget, never more.
    close(
        granted.reduce((sum, usd) => sum + usd, 0),
        1,
    );
    const refused = await init("d");
    assert.equal(refused.l0Only, true);
    assert.equal(refused.l0Cause, "budget");
    assert.equal(refused.apiKey, undefined);
});

test("without per_run_cap_usd a run is granted a quarter of the budget", async () => {
    const { init } = await budgeted(1, 0);
    assert.equal((await init("g")).limits.maxRunUsd, 0.25);
});

test("rapid pushes on one branch: a takeover settles one per-run cap, not the month (review counterexample 2)", async () => {
    const { init, call, token, spent, close } = await budgeted(20, 2);
    await call("PATCH", "/api/repos/o/r", { budgetUsd: 20 });
    // Month already 2 USD in.
    await call("POST", "/runs", { repo: "o/r", sha: "earlier", findings: [], usage: { cost: 2 } }, token);
    const first = await init("push-main");
    assert.equal(first.limits.maxRunUsd, 2);
    assert.equal((await call("POST", "/spend", { budgetClaim: first.budgetClaim }, token)).status, 200);
    // GitHub cancels the first run; the second takes over its claim in the same group.
    const second = await init("push-main");
    assert.equal(second.l0Only, false);
    assert.equal(second.limits.maxRunUsd, 2);
    // Only the cap was settled: 2 already spent + 2 settled, 16 still free for the rest of the month.
    close(spent(), 4);
    // A late report from the cancelled run replaces the settled cap with its real cost.
    await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "late", findings: [], budgetClaim: first.budgetClaim, usage: { cost: 0.3 } },
        token,
    );
    close(spent(), 2.3);
});

test("a run cancelled before its first session costs nothing on takeover", async () => {
    const { init, spent } = await budgeted(1, 0.5);
    const first = await init("g");
    const second = await init("g");
    assert.equal(second.l0Only, false);
    assert.notEqual(second.budgetClaim, first.budgetClaim);
    assert.equal(second.limits.maxRunUsd, 0.5);
    assert.equal(spent(), 0);
});

test("a superseded run cannot mark its claim as spending", async () => {
    const { init, call, token } = await budgeted(1, 0.5);
    const first = await init("g");
    await init("g");
    assert.equal((await call("POST", "/spend", { budgetClaim: first.budgetClaim }, token)).status, 409);
});

test("a run in another group is not taken over; an expired claim is taken over by anyone", async () => {
    const { init, store, repo, spent, call, token } = await budgeted(1, 0.5);
    const first = await init("g");
    await call("POST", "/spend", { budgetClaim: first.budgetClaim }, token);
    await init("h");
    // Different groups: g is still live and still marked spending.
    assert.equal((await store.openClaims(repo.id, "2026-10")).length, 2);
    assert.equal((await call("POST", "/spend", { budgetClaim: first.budgetClaim }, token)).status, 200);
    // The month is fully reserved, so a third group is refused...
    assert.equal((await init("i")).l0Cause, "budget");
    // ...until g's claim expires (job killed): any /init settles it (charging its started allowance).
    store.claims.find((item) => item.claim === first.budgetClaim)!.expiresAt = "2000-01-01T00:00:00.000Z";
    const third = await init("i");
    assert.equal(third.l0Only, true);
    assert.equal(spent(), 0.5);
    assert.equal((await call("POST", "/spend", { budgetClaim: first.budgetClaim }, token)).status, 409);
});

test("a refused run publishing L0 results cannot release another run's claim", async () => {
    const { init, call, token, store, repo } = await budgeted(1, 1);
    const holder = await init("g");
    const refused = await init("h");
    assert.equal(refused.l0Cause, "budget");
    const published = await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "l0", event: "push", findings: [], budgetClaim: refused.budgetClaim },
        token,
    );
    assert.equal(published.status, 201);
    assert.deepEqual(
        (await store.openClaims(repo.id, "2026-10")).map((item) => item.claim),
        [holder.budgetClaim],
    );
});

test("the holder's report frees its claim for the next run", async () => {
    const { init, call, token, close, spent } = await budgeted(1, 1);
    const holder = await init("g");
    assert.equal((await init("h")).l0Only, true);
    await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "s", findings: [], budgetClaim: holder.budgetClaim, usage: { cost: 0.4 } },
        token,
    );
    close(spent(), 0.4);
    const next = await init("h");
    assert.equal(next.l0Only, false);
    close(next.limits.maxRunUsd as number, 0.6);
});

test("a claim settled in an earlier month never reduces the new month", async () => {
    const { init, call, token, store, spent } = await budgeted(1, 0.5);
    const first = await init("g");
    await call("POST", "/spend", { budgetClaim: first.budgetClaim }, token);
    const row = store.claims.find((item) => item.claim === first.budgetClaim)!;
    row.month = "2026-09";
    const repo = store.repos[0];
    repo.budgetMonth = "2026-09";
    repo.spentUsd = 0.7;
    const next = await init("g");
    assert.equal(next.l0Only, false);
    assert.equal(next.limits.maxRunUsd, 0.5);
    assert.equal(spent(), 0);
});
