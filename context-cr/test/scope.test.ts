import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { memorySnapshot } from "../src/l0/snapshot.ts";
import { computeScope } from "../src/scope/index.ts";

const repo = memorySnapshot({
    "AGENTS.md": "# root\n",
    "README.md": "# root\n",
    "api/AGENTS.md": "Handlers live in `api/routes/user.ts`.\n",
    "api/README.md": "# api\n",
    "api/routes/user.ts": "export {};\n",
    "api/deep/AGENTS.md": "# deep\n",
    "api/deep/README.md": "# deep\n",
    "docs/architecture/overview.md": "The worker is in [cf](../../worker/).\n",
    "worker/index.ts": "export {};\n",
    "web/app.ts": "export {};\n",
});

function paths(changes: { status: string; path: string; oldPath?: string }[]): string[] {
    return computeScope(repo, DEFAULT_CONFIG, changes, "b", "h").contexts.map((item) => item.path);
}

test("code change pulls the ancestor AGENTS chain and reverse references", () => {
    assert.deepEqual(paths([{ status: "M", path: "api/routes/user.ts" }]), ["AGENTS.md", "api/AGENTS.md"]);
});

test("directory references count for files inside that directory", () => {
    assert.deepEqual(paths([{ status: "M", path: "worker/index.ts" }]), ["AGENTS.md", "docs/architecture/overview.md"]);
});

test("deleted and renamed paths still resolve reverse references by old name", () => {
    const found = paths([{ status: "R100", path: "api/routes/account.ts", oldPath: "api/routes/user.ts" }]);
    assert.ok(found.includes("api/AGENTS.md"));
});

test("changing an AGENTS.md pulls every descendant AGENTS.md", () => {
    assert.deepEqual(paths([{ status: "M", path: "api/AGENTS.md" }]), [
        "AGENTS.md",
        "api/AGENTS.md",
        "api/deep/AGENTS.md",
    ]);
});

test("lockfile-only change yields an empty scope and zero model calls", () => {
    assert.deepEqual(paths([{ status: "M", path: "pnpm-lock.yaml" }]), []);
});

test("repository without context files yields an empty scope", () => {
    const bare = memorySnapshot({ "src/a.ts": "" });
    assert.equal(computeScope(bare, DEFAULT_CONFIG, [{ status: "M", path: "src/a.ts" }], "", "h").contexts.length, 0);
});

test("path segments named like Object members do not crash scope", () => {
    const repo2 = memorySnapshot({
        "AGENTS.md": "# r\n",
        "README.md": "# r\n",
        "constructor/toString.ts": "",
        "__proto__/x.ts": "",
    });
    const changes = [
        { status: "M", path: "constructor/toString.ts" },
        { status: "A", path: "__proto__/x.ts" },
    ];
    assert.deepEqual(
        computeScope(repo2, DEFAULT_CONFIG, changes, "b", "h").contexts.map((item) => item.path),
        ["AGENTS.md"],
    );
});
