import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RepoConfig } from "../src/config.ts";
import { checkContext } from "../src/l0/context.ts";
import { checkDocNames } from "../src/l0/naming.ts";
import { memorySnapshot } from "../src/l0/snapshot.ts";

function config(over: Partial<RepoConfig> = {}): RepoConfig {
    return { ...DEFAULT_CONFIG, ...over };
}

/**
 * These pin the false positives found by running L0 against real repositories. Each case is a file a
 * maintainer would refuse to rename, so a regression here means the tool starts demanding busywork.
 */
test("a docs tree that also holds its own site is not a naming violation", () => {
    const snapshot = memorySnapshot({
        "docs/index.html": "<html></html>",
        "docs/blueprint.tsx": "export {};",
        "docs/guide.md": "# guide",
    });
    assert.deepEqual(
        checkDocNames(snapshot, config()).map((item) => item.path),
        [],
    );
});

test("a numbered section in another script is allowed, including its ASCII children", () => {
    const snapshot = memorySnapshot({
        "docs/001-计佬常識/002-KMP/index.md": "# kmp",
        "docs/003-游戏引擎/004-UML/note.md": "# uml",
    });
    assert.deepEqual(checkDocNames(snapshot, config()), []);
});

test("a genuine naming violation is still reported", () => {
    const snapshot = memorySnapshot({ "docs/BadName.md": "# bad" });
    const findings = checkDocNames(snapshot, config());
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /not lowercase kebab-case/);
});

test("a version suffix is still banned even inside a numbered section", () => {
    const snapshot = memorySnapshot({ "docs/001-notes/guide-v2.md": "# v2" });
    const findings = checkDocNames(snapshot, config());
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /version or temporary word/);
});

test("tool-owned notes are excluded, so a generated AGENTS.md needs no README beside it", () => {
    const snapshot = memorySnapshot({ ".agents/notes/archived/AGENTS.md": "# notes" });
    assert.deepEqual(checkContext(snapshot, config()), []);
});

test("skills are NOT excluded: the pairing rule still sees them", () => {
    const snapshot = memorySnapshot({ ".agents/skills/demo/README.md": "# demo" });
    const findings = checkContext(snapshot, config());
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /has no paired AGENTS.md/);
});
