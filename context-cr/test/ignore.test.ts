import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, globMatch, isIgnoredPath } from "../src/config.ts";
import { computeCodeScope } from "../src/scope/code.ts";
import type { Change } from "../src/git.ts";

const change = (path: string, status: Change["status"] = "M"): Change => ({ path, status });

test("an image or archive never reaches the review, and the skip is counted", () => {
    const scope = computeCodeScope(
        () => "diff --git a/x b/x\n@@ -1,1 +1,2 @@\n old\n+new\n",
        DEFAULT_CONFIG,
        [change("assets/logo.png"), change("src/a.ts")],
        "b",
        "h",
    );
    assert.deepEqual(scope.skipped, ["assets/logo.png"]);
    assert.equal(scope.hunks.length, 1);
    assert.equal(scope.hunks[0].path, "src/a.ts");
});

test("a deleted image is still reviewed, because the deletion can be the defect", () => {
    const scope = computeCodeScope(
        () => "diff --git a/x b/x\n@@ -1,1 +0,0 @@\n-gone\n",
        DEFAULT_CONFIG,
        [change("assets/old.png", "D")],
        "b",
        "h",
    );
    assert.deepEqual(scope.skipped, []);
    assert.equal(scope.hunks.length, 1);
});

test("glob patterns exclude paths an extension cannot name", () => {
    const config = { ...DEFAULT_CONFIG, ignoreGlobs: ["**/fixtures/**", "*.min.js"] };
    assert.equal(isIgnoredPath(config, "app/fixtures/data.json"), true);
    assert.equal(isIgnoredPath(config, "fixtures/data.json"), true);
    // .min.js is already in the default extension list, so it is ignored under dist/ too.
    assert.equal(isIgnoredPath(config, "dist/app.min.js"), true);
    assert.equal(isIgnoredPath(config, "app.min.js"), true);
    // A glob that only names a single segment must not match a deeper path.
    assert.equal(globMatch("*.dat", "a/b.dat"), false);
    assert.equal(globMatch("*.dat", "b.dat"), true);
    assert.equal(isIgnoredPath(config, "src/app.ts"), false);
});

test("an ordinary source file is never ignored by the default list", () => {
    for (const path of ["src/a.ts", "docs/x.md", "package.json", ".hx-context-review.json"]) {
        assert.equal(isIgnoredPath(DEFAULT_CONFIG, path), false, path);
    }
});

test("glob supports a star inside one segment but not across it", () => {
    assert.equal(globMatch("a/*/c.txt", "a/b/c.txt"), true);
    assert.equal(globMatch("a/*/c.txt", "a/b/x/c.txt"), false);
    assert.equal(globMatch("**/b.txt", "b.txt"), true);
});

test("the config file can extend the list without losing the defaults", async () => {
    const { parseConfig } = await import("../src/config.ts");
    const parsed = parseConfig(JSON.stringify({ ignoreExtensions: [".PNG", ".dat"] }));
    // Extensions normalize to lower case; a value is what the file says, not a merge.
    assert.deepEqual(parsed.ignoreExtensions, [".png", ".dat"]);
    const plain = parseConfig("{}");
    assert.deepEqual(plain.ignoreExtensions, DEFAULT_CONFIG.ignoreExtensions);
});
