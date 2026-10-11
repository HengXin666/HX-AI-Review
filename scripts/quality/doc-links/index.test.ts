import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLinks, parseLinks } from "./index.ts";

const links = parseLinks(
    JSON.stringify({
        links: [{ doc: "docs/q.md", watch: ["scripts/quality/", ".github/workflows/quality-"], reason: "q" }],
    }),
);
const tracked = ["docs/q.md", "scripts/quality/ci.json", ".github/workflows/quality-code.yml", "src/a.ts"];

test("watched change without the doc is an Error; with the doc it passes", () => {
    const only = checkLinks(links, [{ status: "M", path: "scripts/quality/ci.json" }], tracked);
    assert.equal(only.length, 1);
    assert.equal(only[0].path, "docs/q.md");
    const both = [
        { status: "M", path: "scripts/quality/ci.json" },
        { status: "M", path: "docs/q.md" },
    ];
    assert.deepEqual(checkLinks(links, both, tracked), []);
});

test("unrelated changes pass; renames out of a watched path count", () => {
    assert.deepEqual(checkLinks(links, [{ status: "M", path: "src/a.ts" }], tracked), []);
    const moved = [{ status: "R100", oldPath: ".github/workflows/quality-code.yml", path: "ci/code.yml" }];
    assert.equal(checkLinks(links, moved, tracked).length, 1);
});

test("stale mappings fail: missing doc or a watch prefix with no tracked file", () => {
    const stale = parseLinks(JSON.stringify({ links: [{ doc: "docs/gone.md", watch: ["nowhere/"], reason: "x" }] }));
    const messages = checkLinks(stale, [], tracked).map((item) => item.message);
    assert.equal(messages.length, 2);
    assert.throws(() => parseLinks(JSON.stringify({ links: [{ doc: 1 }] })));
});
