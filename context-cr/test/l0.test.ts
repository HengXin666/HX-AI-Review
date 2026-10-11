import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runL0 } from "../src/l0/index.ts";
import { memorySnapshot } from "../src/l0/snapshot.ts";

const ok = {
    "README.md": "# Root\n\nSee [arch](docs/architecture/overview.md) and `src/app.ts`.\n",
    "AGENTS.md": "# Agents\n\nRead `docs/architecture/overview.md` first.\n",
    "docs/architecture/overview.md": "# Overview\n",
    "src/app.ts": "export {};\n",
    ".agents/skills/demo/SKILL.md": "---\nname: demo\ndescription: A demo skill\n---\n\nBody with `references/a.md`.\n",
    ".agents/skills/demo/references/a.md": "# A\n",
};

function rules(content: Record<string, string>): string[] {
    return runL0(memorySnapshot(content), DEFAULT_CONFIG).map((item) => `${item.ruleId}:${item.severity}:${item.path}`);
}

test("clean repository passes every L0 rule", () => {
    assert.deepEqual(rules(ok), []);
});

test("HC-CONTEXT: missing pair and oversized AGENTS are errors", () => {
    const content: Record<string, string> = { ...ok, "pkg/AGENTS.md": "x\n".repeat(150) };
    const found = rules(content);
    assert.ok(found.includes("HC-CONTEXT:error:pkg/AGENTS.md"));
    assert.equal(found.filter((item) => item.startsWith("HC-CONTEXT")).length, 2);
    content["pkg/AGENTS.md"] = "x\n".repeat(149);
    content["pkg/README.md"] = "# pkg\n";
    assert.deepEqual(rules(content), []);
});

test("HC-BUDGET: ancestor chain plus skills over 65536 bytes is an error, equal passes", () => {
    const filler = (size: number): string => "a".repeat(size - 1) + "\n";
    const head = "---\nname: s\ndescription: d\n---\n";
    const tree = (skillBytes: number): Record<string, string> => ({
        "README.md": "# r\n",
        "AGENTS.md": filler(16000),
        "a/README.md": "# a\n",
        "a/AGENTS.md": filler(16000),
        "a/b/README.md": "# b\n",
        "a/b/AGENTS.md": filler(16000),
        "a/b/c/README.md": "# c\n",
        "a/b/c/AGENTS.md": filler(16000),
        "a/b/c/x.ts": "export {};\n",
        ".agents/skills/s/SKILL.md": head + filler(skillBytes - head.length),
    });
    assert.deepEqual(rules(tree(1536)), []);
    assert.ok(rules(tree(1537)).includes("HC-BUDGET:error:a/b/c/AGENTS.md"));
});

test("HC-BUDGET: an excluded ancestor AGENTS.md does not count toward the byte total", () => {
    const filler = (size: number): string => "a".repeat(size - 1) + "\n";
    const tree: Record<string, string> = {
        "README.md": "# r\n",
        "AGENTS.md": filler(16000),
        "vendor/README.md": "# v\n",
        "vendor/AGENTS.md": filler(60000),
        "vendor/pkg/README.md": "# p\n",
        "vendor/pkg/x.ts": "export {};\n",
    };
    const budget = (config: typeof DEFAULT_CONFIG) =>
        runL0(memorySnapshot(tree), config).filter((item) => item.ruleId === "HC-BUDGET");
    // The excluded AGENTS.md is never injected, so its 60000 bytes must not reach the vendor/pkg chain.
    assert.deepEqual(budget({ ...DEFAULT_CONFIG, exclude: ["vendor/AGENTS.md"] }), []);
    // Without the exclusion the same chain is over the limit, so the fixture is an error by itself.
    assert.ok(budget(DEFAULT_CONFIG).some((item) => item.path === "vendor/AGENTS.md"));
});

test("HC-BUDGET: an excluded SKILL.md does not count toward the skill injection bound", () => {
    const head = "---\nname: big\ndescription: d\n---\n";
    const tree: Record<string, string> = {
        "README.md": "# r\n",
        "AGENTS.md": "# a\n",
        "src/app.ts": "export {};\n",
        ".agents/skills/big/SKILL.md": head + "a".repeat(70000 - head.length - 1) + "\n",
    };
    const budget = (config: typeof DEFAULT_CONFIG) =>
        runL0(memorySnapshot(tree), config).filter((item) => item.ruleId === "HC-BUDGET");
    // The excluded skill is never injected, so it must not appear in the resident-plus-loaded bound.
    assert.deepEqual(budget({ ...DEFAULT_CONFIG, exclude: [".agents/skills/big"] }), []);
    // Without the exclusion the same skill alone pushes every directory over the limit.
    assert.ok(budget(DEFAULT_CONFIG).length > 0);
});

test("HC-DOCNAME: kebab names pass, v2/Upper/dated outside decisions fail", () => {
    const docs = {
        ...ok,
        "docs/tutorials/local-setup.md": "",
        "docs/decisions/2026-10-11-pick-pi.md": "",
        "docs/reference/api-v2.md": "",
        "docs/Setup_Guide.md": "",
        "docs/reference/2026-10-01-notes.md": "",
    };
    const found = rules(docs).filter((item) => item.startsWith("HC-DOCNAME"));
    assert.deepEqual(found.sort(), [
        "HC-DOCNAME:error:docs/Setup_Guide.md",
        "HC-DOCNAME:error:docs/reference/2026-10-01-notes.md",
        "HC-DOCNAME:error:docs/reference/api-v2.md",
    ]);
});

test("CX-DEADREF: dead link is an error, dead backtick path a warning, fences ignored", () => {
    const content = {
        ...ok,
        "README.md": ok["README.md"] + "[gone](docs/gone.md)\n`src/missing.ts`\n```\n[x](nope.md)\n```\n",
    };
    const found = rules(content);
    assert.ok(found.includes("CX-DEADREF:error:README.md"));
    assert.ok(found.includes("CX-DEADREF:warning:README.md"));
    assert.equal(found.filter((item) => item.startsWith("CX-DEADREF")).length, 2);
});

test("CX-SKILL: name must match directory and description must exist", () => {
    const content = { ...ok, ".agents/skills/demo/SKILL.md": "---\nname: other\ndescription:\n---\n" };
    const found = rules(content).filter((item) => item.startsWith("CX-SKILL"));
    assert.equal(found.length, 2);
});

test("CX-ORPHAN: unreferenced doc is a warning only", () => {
    const found = rules({ ...ok, "docs/reference/lonely.md": "# lonely\n" });
    assert.deepEqual(found, ["CX-ORPHAN:warning:docs/reference/lonely.md"]);
});

test("baseline marks approved findings historical so they do not block", () => {
    const content = { ...ok, "docs/Bad.md": "" };
    const [finding] = runL0(memorySnapshot(content), DEFAULT_CONFIG).filter((item) => item.ruleId === "HC-DOCNAME");
    const again = runL0(memorySnapshot(content), DEFAULT_CONFIG, [finding]);
    assert.equal(again.find((item) => item.fingerprint === finding.fingerprint)?.origin, "historical");
});

test("fences close only on a matching marker; malformed escapes do not crash L0", () => {
    const readme = ok["README.md"] + "~~~~\n```\n[x](nope.md)\n~~~~\n[bad](docs/%ZZ.md)\n";
    const found = rules({ ...ok, "README.md": readme });
    assert.deepEqual(found, ["CX-DEADREF:error:README.md"]);
});

test("CRLF SKILL.md front matter is accepted; allowed file names still check their directories", () => {
    const crlf = { ...ok, ".agents/skills/demo/SKILL.md": "---\r\nname: demo\r\ndescription: d\r\n---\r\n" };
    assert.deepEqual(rules(crlf), []);
    const found = rules({ ...ok, "docs/Bad_Dir/README.md": "# r\n", "docs/Bad_Dir/AGENTS.md": "# a\n" });
    assert.ok(found.includes("HC-DOCNAME:error:docs/Bad_Dir/README.md"));
});
