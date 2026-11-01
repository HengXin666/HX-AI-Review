import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_USAGE } from "../src/contract/finding.ts";
import { CODE_KIND } from "../src/contract/kind.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { InitConfig } from "../src/init/client.ts";
import type { AgentRequest, AgentRunner } from "../src/review/agent.ts";
import { defersToUser, groundEvidence } from "../src/review/ground.ts";
import { assembleFileGroups, batchGroups } from "../src/review/groups.ts";
import { runReview } from "../src/review/index.ts";
import { diffLineComment, renderChunkReview } from "../src/publish/comment.ts";
import { computeCodeScope } from "../src/scope/code.ts";

const DIFF_A = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " const keep = 1;",
    "+const added = read();",
    "+if (!added) return;",
    " export { keep };",
].join("\n");

const DIFF_B = [
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1,2 @@",
    " const keep = 1;",
    "+const other = read();",
].join("\n");

test("file groups keep one file together and a tiny budget splits files, not hunks of different files", () => {
    const scope = computeCodeScope(
        (path) => (path === "src/b.ts" ? DIFF_B : DIFF_A),
        DEFAULT_CONFIG,
        [
            { status: "M", path: "src/a.ts" },
            { status: "M", path: "src/b.ts" },
        ],
        "b",
        "h",
    );
    const groups = assembleFileGroups(scope.hunks);
    assert.deepEqual(
        groups.map((group) => group.path),
        ["src/a.ts", "src/b.ts"],
    );
    assert.equal(groups[0].hunks.length, 1);
    const packed = batchGroups(groups, 1);
    assert.equal(packed.length, 2);
    assert.equal(packed[0][0].path, "src/a.ts");
    assert.equal(packed[1][0].path, "src/b.ts");
});

test("evidence that asks the reader, or quotes text that is not in the diff, is refused", () => {
    const hunk = assembleFileGroups(
        computeCodeScope(() => DIFF_A, DEFAULT_CONFIG, [{ status: "M", path: "src/a.ts" }], "b", "h").hunks,
    )[0].hunks[0].body;
    assert.equal(defersToUser("请确认上下文是否正确"), true);
    assert.equal(defersToUser("please check whether this is correct"), true);
    const ask = groundEvidence(
        { title: "maybe", message: "请确认上下文是否正确", evidence: "`const added = read()`" },
        hunk,
        undefined,
    );
    assert.equal(ask.ok, false);
    const missing = groundEvidence(
        { title: "ghost", message: "null deref", evidence: "`this line is not in the file`" },
        hunk,
        "const added = read();\n",
    );
    assert.equal(missing.ok, false);
    const held = groundEvidence(
        { title: "unchecked", message: "read() can throw", evidence: "`const added = read()`" },
        hunk,
        undefined,
    );
    assert.equal(held.ok, true);
});

const config: InitConfig = {
    repo: "o/r",
    kind: CODE_KIND,
    enabled: true,
    l0Only: false,
    api: "openai-completions",
    models: { finder: "small", verifier: "large" },
    limits: { contextWindow: 128000, maxTokens: 8192, maxCandidates: 5, maxRunUsd: null },
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    suppressions: [],
};

test("a finding that defers to the reader never opens a verifier", async () => {
    const scope = computeCodeScope(() => DIFF_A, DEFAULT_CONFIG, [{ status: "M", path: "src/a.ts" }], "b", "h");
    const calls: AgentRequest[] = [];
    const run: AgentRunner = async (request) => {
        calls.push(request);
        const [tool] = request.tools;
        if (request.role === "finder") {
            tool.execute({
                path: "src/a.ts",
                line: 2,
                title: "please confirm",
                message: "请确认上下文是否正确",
                evidence: "`const added = read()`",
            });
        }
        return { usage: { ...EMPTY_USAGE, input: 1, output: 1, cost: 0 }, transcript: [] };
    };
    const result = await runReview(config, scope, { diff: "", patchFiles: () => [], readFile: () => undefined, run });
    assert.equal(calls.filter((item) => item.role === "verifier").length, 0);
    assert.equal(result.findings.length, 0);
    assert.match(result.rejections[0].reason, /asks a person/);
    assert.equal(result.trace?.checks[0].verdict, "rejected");
});

test("the chunk review shows the diff, and a line comment does not ask the reader to check", () => {
    const body = renderChunkReview({
        groups: [
            {
                id: "g1",
                path: "src/a.ts",
                hunks: 1,
                added: [2],
                batch: 1,
                excerpt: "@@ -1,2 +1,3 @@\n2| +const added = read();",
            },
        ],
        checks: [],
    });
    assert.match(body, /const added = read\(\)/);
    assert.match(body, /分块审查/);
    const line = diffLineComment({
        path: "src/a.ts",
        line: 2,
        title: "unchecked read",
        verdict: "confirmed",
        reason: "read() is called with no handler",
        quote: "const added = read()",
    });
    assert.match(line, /const added = read\(\)/);
    assert.doesNotMatch(line, /请确认|please check|是否正确/);
});
