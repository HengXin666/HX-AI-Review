import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByDirectory, hasEvidence, lineUrl, stagesFor } from "../pages/src/review-model.ts";

test("directory groups keep root files apart and sort paths", () => {
    const groups = groupByDirectory([
        { path: "src/b.ts", id: "2" },
        { path: "README.md", id: "1" },
        { path: "src/a.ts", id: "3" },
    ]);
    assert.deepEqual(
        groups.map((group) => group.name),
        ["(根目录)", "src"],
    );
    assert.deepEqual(
        groups[1]?.files.map((file) => file.path),
        ["src/a.ts", "src/b.ts"],
    );
});

test("a code run with a quote-less finding stops on evidence", () => {
    const { stages, current } = stagesFor("code", "warned", 1);
    assert.equal(current, 3);
    assert.equal(stages[3]?.status, "error");
    assert.equal(stages[4]?.status, undefined);
});

test("a clean code run marks every stage done", () => {
    const { stages, current } = stagesFor("code", "passed", 0);
    assert.equal(current, stages.length);
    assert.equal(
        stages.every((stage) => stage.status === undefined),
        true,
    );
});

test("an unfinished run stays on the first stage", () => {
    const { current } = stagesFor("context", "incomplete", 0);
    assert.equal(current, 0);
});

test("blank evidence is missing and a line link keeps the fragment", () => {
    assert.equal(hasEvidence({ evidence: "  " }), false);
    assert.equal(hasEvidence({ evidence: "if (n < 0)" }), true);
    assert.equal(lineUrl("acme/app", "abc", "src/a b.ts", 12), "https://github.com/acme/app/blob/abc/src/a%20b.ts#L12");
});
