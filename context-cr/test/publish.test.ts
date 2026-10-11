import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { headSha, patchFiles } from "../src/git.ts";
import { pushPatchBranch } from "../src/publish/github.ts";

function repo(): string {
    const base = mkdtempSync(join(tmpdir(), "hx-ctx-publish-"));
    const work = join(base, "work");
    const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
    run(base, "init", "-q", "--bare", "remote.git");
    run(base, "init", "-q", "-b", "main", "work");
    writeFileSync(join(work, "AGENTS.md"), "# a\n\nEntry is `src/old.ts`.\n");
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
