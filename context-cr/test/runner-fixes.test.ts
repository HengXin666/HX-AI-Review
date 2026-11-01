import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadTrustedConfig } from "../src/config.ts";
import { AI_FILE, CONFIG_FILE, ENV, INIT_FILE, REPORT_DIR, REPORT_NAME, SCOPE_FILE, UTF8 } from "../src/constants.ts";
import { makeFinding } from "../src/contract/finding.ts";
import type { InitConfig } from "../src/init/client.ts";
import { markHistorical } from "../src/rules/run.ts";
import { load, resetState, save } from "../src/state.ts";
import { stepL0, stepPublish, stepReview } from "../src/steps.ts";

const created: string[] = [];
after(() => {
    for (const dir of created) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function git(work: string, args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: work,
        encoding: "utf8",
    }).trim();
}

/** Base commit with a config that excludes nothing extra; head widens exclude to hide pkg/. */
function repo(): { work: string; base: string } {
    const dir = mkdtempSync(join(tmpdir(), "hx-ctx-fix-"));
    created.push(dir);
    const work = join(dir, "work");
    execFileSync("git", ["init", "-q", "-b", "main", work], { encoding: "utf8" });
    writeFileSync(join(work, "AGENTS.md"), "# r\n");
    writeFileSync(join(work, "README.md"), "# r\n");
    writeFileSync(join(work, CONFIG_FILE), JSON.stringify({ exclude: [] }) + "\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", "base"]);
    const base = git(work, ["rev-parse", "HEAD"]);
    mkdirSync(join(work, "pkg"));
    writeFileSync(join(work, "pkg", "AGENTS.md"), "# pkg\n");
    writeFileSync(join(work, CONFIG_FILE), JSON.stringify({ exclude: ["pkg/"] }) + "\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", "head"]);
    return { work, base };
}

const CONFIG: InitConfig = {
    repo: "o/r",
    kind: "context",
    enabled: true,
    l0Only: false,
    apiUrl: "http://model.invalid",
    api: "openai-completions",
    models: { finder: "small", verifier: "large" },
    limits: { contextWindow: 128000, maxTokens: 8192, maxCandidates: 5, maxRunUsd: null },
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    suppressions: [],
};

/** Run fn with an isolated RUNNER_TEMP and a CI-like init state, then restore the environment. */
async function withRun<T>(work: string, base: string, fn: (nonce: string) => Promise<T> | T): Promise<T> {
    const keys = [ENV.runnerTemp, ENV.endpoint, ENV.token, ENV.githubToken, ENV.apiKey, ENV.kind];
    const previous = keys.map((key) => process.env[key]);
    const temp = mkdtempSync(join(tmpdir(), "hx-ctx-fix-temp-"));
    created.push(temp);
    for (const key of keys) {
        delete process.env[key];
    }
    process.env[ENV.runnerTemp] = temp;
    try {
        const nonce = resetState(work);
        const head = git(work, ["rev-parse", "HEAD"]);
        const event = { name: "push", base, reason: "push before", defaultBranch: "main" };
        save(work, INIT_FILE, { nonce, config: CONFIG, startedAt: Date.now(), head, event });
        return await fn(nonce);
    } finally {
        keys.forEach((key, index) => {
            const value = previous[index];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        });
    }
}

function reportStages(work: string): Record<string, string> {
    const text = readFileSync(join(work, REPORT_DIR, REPORT_NAME + ".json"), UTF8);
    return (JSON.parse(text) as { stages: Record<string, string> }).stages;
}

test("config comes from the trusted base, so a change cannot exclude itself from L0", async () => {
    const { work, base } = repo();
    assert.deepEqual(loadTrustedConfig(work, base).exclude, []);
    const ids = await withRun(work, base, () => stepL0(work).map((item) => item.ruleId + " " + item.path));
    // pkg/ is excluded only by the head copy: the base copy applies, so HC-CONTEXT still fires on it.
    assert.ok(ids.includes("HC-CONTEXT pkg/AGENTS.md"));
    // The edit to the config file itself is reported once as a Warning.
    assert.ok(ids.includes("HX-CONFIG " + CONFIG_FILE));
});

test("a review that cannot start records an unfinished result instead of throwing", async () => {
    const { work, base } = repo();
    await withRun(work, base, async (nonce) => {
        save(work, SCOPE_FILE, {
            kind: "context",
            base,
            head: "h",
            changed: ["pkg/AGENTS.md"],
            contexts: [{ path: "pkg/AGENTS.md", reasons: ["r"] }],
        });
        const ai = await stepReview(work);
        assert.equal(ai?.complete, false);
        assert.match(ai?.errors[0] ?? "", /no api key/);
        const stored = load<{ nonce: string; complete: boolean }>(work, AI_FILE);
        assert.equal(stored?.nonce, nonce);
        assert.equal(stored?.complete, false);
        await stepPublish(work);
        assert.match(reportStages(work).ai, /incomplete: no api key/);
    });
});

test("a review cut short by the candidate cap is published as truncated", async () => {
    const { work, base } = repo();
    await withRun(work, base, async (nonce) => {
        save(work, SCOPE_FILE, {
            kind: "context",
            base,
            head: "h",
            changed: ["pkg/AGENTS.md"],
            contexts: [{ path: "pkg/AGENTS.md", reasons: ["r"] }],
        });
        save(work, AI_FILE, {
            nonce,
            findings: [],
            patches: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            rejected: 0,
            complete: true,
            truncated: true,
            errors: [],
            notReviewed: ["pkg/AGENTS.md (candidate limit)"],
            rejections: [],
        });
        await stepPublish(work);
        assert.match(reportStages(work).ai, /truncated/);
    });
});

test("rules findings outside the changed files or in the base baseline are historical", () => {
    const changed = makeFinding("STYLE-003", "error", "src/new.ts", 1, "m", "e");
    const stock = makeFinding("STYLE-003", "error", "src/old.ts", 1, "m", "e");
    const accepted = makeFinding("ARCH-001", "error", "src/new.ts", 2, "n", "e");
    const whole = makeFinding("tool-error", "error", ".", 1, "crashed", "e");
    const approved = new Set([accepted.ruleId + "\0" + accepted.path + "\0" + accepted.fingerprint]);
    const marked = markHistorical([changed, stock, accepted, whole], ["src/new.ts"], approved);
    assert.deepEqual(
        marked.map((item) => item.origin),
        ["new", "historical", "historical", "new"],
    );
});
