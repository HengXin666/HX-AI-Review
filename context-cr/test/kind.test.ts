import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_KIND, CONTEXT_KIND, parseKind } from "../src/contract/kind.ts";
import { parseInit } from "../src/init/client.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { computeCodeScope, parseHunks } from "../src/scope/code.ts";

const ok = {
    repo: "o/r",
    l0Only: false,
    apiUrl: "https://llm.test/v1",
    apiKey: "sk",
    api: "anthropic-messages",
    models: { finder: "a", verifier: "b" },
    limits: { contextWindow: 1000, maxTokens: 100, maxCandidates: 5, maxRunUsd: 0.5 },
    pricing: { input: 1, output: 2 },
    budgetClaim: "claim-1",
};

test("an absent kind is context, so an older Worker keeps the old behaviour", () => {
    assert.equal(parseKind(undefined), CONTEXT_KIND);
    assert.equal(parseKind(null), CONTEXT_KIND);
    assert.equal(parseKind(""), CONTEXT_KIND);
    assert.equal(parseKind(CODE_KIND), CODE_KIND);
    assert.equal(parseInit(ok).kind, CONTEXT_KIND);
    assert.equal(parseInit({ ...ok, kind: "code" }).kind, CODE_KIND);
});

test("an unknown kind fails closed instead of silently reviewing the wrong thing", () => {
    assert.throws(() => parseKind("codereview"), /kind must be one of context, code/);
    assert.throws(() => parseInit({ ...ok, kind: "docs" }), /kind must be one of/);
    // A number or an object is not a kind either; defaulting it would run a review nobody asked for.
    assert.throws(() => parseInit({ ...ok, kind: 1 }), /kind must be one of/);
});

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " export { a };",
].join("\n");

test("hunks keep only the lines the diff added, with their new-side numbers", () => {
    const [hunk] = parseHunks(DIFF);
    assert.equal(
        hunk.lines
            .filter((item) => item.number !== undefined)
            .map((item) => item.number)
            .join(","),
        "1,2,3,4",
    );
    // The removed line has no new-side number, so it can never be reported against the new file.
    assert.equal(hunk.lines.find((item) => item.raw.startsWith("-"))?.number, undefined);
});

test("code scope covers added lines, skips deleted and ignored files, and keeps both rename names", () => {
    const read = (path: string): string => (path === "src/a.ts" ? DIFF : "");
    const changes = [
        { status: "M", path: "src/a.ts" },
        { status: "D", path: "src/gone.ts" },
        { status: "M", path: "pnpm-lock.yaml" },
        { status: "R100", path: "src/new.ts", oldPath: "src/old.ts" },
    ];
    const scope = computeCodeScope(read, DEFAULT_CONFIG, changes, "b", "h");
    assert.deepEqual(
        scope.hunks.map((item) => item.path),
        ["src/a.ts"],
    );
    // The removed line consumes no new-side number, so the two additions land on 2 and 3.
    assert.deepEqual(scope.hunks[0].lines, [2, 3]);
    // The rename's old name stays in changed so reverse references and feedback still resolve it.
    assert.ok(scope.changed.includes("src/old.ts"));
    assert.ok(scope.changed.includes("src/new.ts"));
    assert.equal(scope.kind, "code");
});

test("a hunk that only removes lines yields nothing to review", () => {
    const removal = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,1 @@", "-a", "-b", " c"].join(
        "\n",
    );
    const scope = computeCodeScope(() => removal, DEFAULT_CONFIG, [{ status: "M", path: "x.ts" }], "b", "h");
    assert.deepEqual(scope.hunks, []);
});
test("an older Worker that omits kind answers with the kind the run asked for", () => {
    // A caller that asked for a code CR must not silently get a context CR from an older Worker.
    assert.equal(parseInit(ok, CODE_KIND).kind, CODE_KIND);
    // The Worker's answer still wins when it carries one.
    assert.equal(parseInit({ ...ok, kind: "context" }, CODE_KIND).kind, CONTEXT_KIND);
    assert.equal(parseInit(ok).kind, CONTEXT_KIND);
});
