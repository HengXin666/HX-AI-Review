import assert from "node:assert/strict";
import { test } from "node:test";
import { importsOf, renderDiscussions, renderGraph } from "../src/review/evidence.ts";

test("importsOf keeps relative edges and package dependencies", () => {
    const text = `import { a } from "./a.ts";\nimport React from "react";\nconst x = require("../lib");\n`;
    assert.deepEqual(importsOf(text), ["./a.ts", "react", "../lib"]);
});

test("renderGraph lists imports and callers and renderDiscussions stays empty-safe", () => {
    const graph = renderGraph(
        ["src/a.ts"],
        [{ path: "src/a.ts", text: `import { b } from "./b.ts";` }],
        new Map([["src/a.ts", ["src/app.ts"]]]),
    );
    assert.match(graph, /src\/a\.ts/);
    assert.match(graph, /imports: \.\/b\.ts/);
    assert.match(graph, /mentioned by: src\/app\.ts/);
    assert.equal(renderDiscussions("issue", []), "Recent issues: none");
    assert.match(
        renderDiscussions("pr", [{ kind: "pr", number: 4, title: "rename cli", updated: "2026-10-01" }]),
        /#4 rename cli/,
    );
});
