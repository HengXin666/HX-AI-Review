import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { headSha, isPlainEdit, patchFiles } from "../src/git.ts";
import { pushPatchBranch } from "../src/publish/github.ts";
import { statusOf } from "../src/publish/ingest.ts";

const created: string[] = [];
after(() => {
    for (const dir of created) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function repo(): string {
    const base = mkdtempSync(join(tmpdir(), "hx-ctx-publish-"));
    created.push(base);
    const work = join(base, "work");
    const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
    run(base, "init", "-q", "--bare", "remote.git");
    run(base, "init", "-q", "-b", "main", "work");
    writeFileSync(join(work, "AGENTS.md"), "# a\n\nEntry is `src/old.ts`.\n");
    writeFileSync(join(work, "说明.md"), "# a\n\nEntry is `src/old.ts`.\n");
    run(work, "add", "-A");
    run(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    run(work, "remote", "add", "origin", join(base, "remote.git"));
    run(work, "checkout", "-q", "--detach");
    return work;
}

const fix = (to: string): string =>
    "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -3 +3 @@\n-Entry is `src/old.ts`.\n+Entry is `" + to + "`.\n";

test("patchFiles lists touched files only when the patch applies", () => {
    const work = repo();
    assert.deepEqual(patchFiles(work, fix("src/new.ts")), ["AGENTS.md"]);
    assert.equal(patchFiles(work, fix("x").replace("old.ts", "missing.ts")), undefined);
});

test("overlapping patches: the first applies, the conflicting one is skipped, the branch is still pushed", () => {
    const work = repo();
    const head = headSha(work);
    const patches = [
        { fingerprint: "a", diff: fix("src/new.ts"), applies: true },
        { fingerprint: "b", diff: fix("src/other.ts"), applies: true },
    ];
    const branch = pushPatchBranch(work, head, patches);
    assert.equal(branch, "hx-ctx/patch-" + head.slice(0, 12));
    const pushed = execFileSync("git", ["show", `origin/${branch}:AGENTS.md`], { cwd: work, encoding: "utf8" });
    assert.match(pushed, /src\/new\.ts/);
    assert.equal(headSha(work), head);
});

test("patchFiles returns raw non-ASCII paths", () => {
    const work = repo();
    const diff = fix("src/new.ts").replaceAll("AGENTS.md", "说明.md");
    assert.deepEqual(patchFiles(work, diff), ["说明.md"]);
});

test("an unfinished AI stage is reported as incomplete, never passed", () => {
    const counts = { error: 0, warning: 0, blocking: 0 };
    assert.equal(statusOf(counts, false, false), "incomplete");
    assert.equal(statusOf({ ...counts, error: 1, blocking: 1 }, false, false), "failed");
    assert.equal(statusOf(counts, false), "passed");
});

test("a path containing a tab is kept whole, so it cannot pass as the reported file", () => {
    const work = repo();
    writeFileSync(join(work, "AGENTS.md\tother"), "# a\n\nEntry is `src/old.ts`.\n");
    const diff = fix("src/new.ts")
        .replace("--- a/AGENTS.md", '--- "a/AGENTS.md\\tother"')
        .replace("+++ b/AGENTS.md", '+++ "b/AGENTS.md\\tother"');
    assert.deepEqual(patchFiles(work, diff), ["AGENTS.md\tother"]);
});

test("only plain single-file text edits are accepted as patches", () => {
    const edit = fix("src/new.ts");
    assert.equal(isPlainEdit(edit), true);
    assert.equal(isPlainEdit("diff --git a/AGENTS.md b/AGENTS.md\nold mode 100644\nnew mode 100755\n"), false);
    assert.equal(isPlainEdit("diff --git a/AGENTS.md b/AGENTS.md\ndeleted file mode 100644\n" + edit), false);
    assert.equal(isPlainEdit("diff --git a/AGENTS.md b/AGENTS.md\nnew file mode 120000\n" + edit), false);
    assert.equal(isPlainEdit(edit + edit), false);
    // A /dev/null side means the patch creates or deletes the file, even without a mode header.
    const create = "diff --git a/AGENTS.md b/AGENTS.md\n--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1 @@\n+# new\n";
    const remove = "diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-# gone\n";
    assert.equal(isPlainEdit(create), false);
    assert.equal(isPlainEdit(remove), false);
});
