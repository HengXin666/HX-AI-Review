import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ENV } from "../src/constants.ts";
import { stepL0 } from "../src/steps.ts";

const created: string[] = [];
after(() => {
    for (const dir of created) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * A committed repo that really breaks HC-CONTEXT: pkg/AGENTS.md exists without the paired pkg/README.md.
 * The fixture must fail L0, or asserting that code CR reports nothing would prove nothing.
 */
function repo(): string {
    const base = mkdtempSync(join(tmpdir(), "hx-ctx-steps-"));
    created.push(base);
    const work = join(base, "work");
    execFileSync("git", ["init", "-q", "-b", "main", work], { encoding: "utf8" });
    writeFileSync(join(work, "AGENTS.md"), "# r\n");
    writeFileSync(join(work, "README.md"), "# r\n");
    mkdirSync(join(work, "pkg"));
    writeFileSync(join(work, "pkg", "AGENTS.md"), "# pkg\n");
    execFileSync("git", ["add", "-A"], { cwd: work, encoding: "utf8" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], {
        cwd: work,
        encoding: "utf8",
    });
    return work;
}

/** Run stepL0 for one kind with an isolated state directory, then restore the environment. */
function l0For(work: string, kind: string): string[] {
    const previousTemp = process.env[ENV.runnerTemp];
    const previousKind = process.env[ENV.kind];
    const temp = mkdtempSync(join(tmpdir(), "hx-ctx-temp-"));
    created.push(temp);
    process.env[ENV.runnerTemp] = temp;
    process.env[ENV.kind] = kind;
    try {
        return stepL0(work).map((item) => item.ruleId);
    } finally {
        if (previousTemp === undefined) {
            delete process.env[ENV.runnerTemp];
        } else {
            process.env[ENV.runnerTemp] = previousTemp;
        }
        if (previousKind === undefined) {
            delete process.env[ENV.kind];
        } else {
            process.env[ENV.kind] = previousKind;
        }
    }
}

test("a context CR runs the L0 context rules", () => {
    // The fixture is broken on purpose, so a passing run here proves L0 really executed.
    assert.ok(l0For(repo(), "context").includes("HC-CONTEXT"));
});

test("a code CR runs no L0 rule, so context findings never enter a kind=code run", () => {
    // Same broken fixture: the context run reports it, the code run must not, or publish would file
    // HC-*/CX-* findings under kind=code and a stale AGENTS.md could fail a review of the diff.
    assert.deepEqual(l0For(repo(), "code"), []);
});
