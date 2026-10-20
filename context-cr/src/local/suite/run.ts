import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_DIR, UTF8 } from "../../constants.ts";
import { tryGit } from "../../git.ts";
import { CATEGORIES, MIGRATIONS_PATH, category as findCategory, tierOf } from "./categories.ts";
import type { TestCategory, TestStep, TestTier } from "./categories.ts";

const DEFAULT_STEP_TIMEOUT_MS = 20 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15000;
const OUTPUT_TAIL = 4000;

export type StepStatus = "passed" | "failed" | "skipped";
export type StepResult = { id: string; kind: string; status: StepStatus; exitCode: number | null; durationMs: number; detail: string };
export type TierResult = {
    ruleId: string;
    category: string;
    tier: string;
    status: StepStatus;
    steps: StepResult[];
    failure: string;
};
export type RunOptions = { testsRoot: string; codeRoot: string; base: string };

/** Keep only the tail of a command output so a report stays readable. */
function tail(text: string): string {
    return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

function timedOut(error: unknown): boolean {
    return (error as { code?: unknown } | undefined)?.code === "ETIMEDOUT";
}

/** Run one shell command inside the tests tree and record its exit code and output tail. */
function runCommand(step: TestStep, root: string): StepResult {
    const started = Date.now();
    const timeout = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    const result = spawnSync("bash", ["-lc", step.command ?? ""], {
        cwd: root,
        encoding: UTF8 as BufferEncoding,
        timeout,
        env: process.env,
    });
    const output = tail(String(result.stdout ?? "") + String(result.stderr ?? ""));
    const detail = timedOut(result.error) ? "timed out after " + timeout + "ms\n" + output : output;
    return {
        id: step.id,
        kind: "cmd",
        status: result.status === 0 ? "passed" : "failed",
        exitCode: result.status,
        durationMs: Date.now() - started,
        detail,
    };
}

/** Probe a deployed base url; a missing base url is a skipped tier, never a pass. */
async function runProbe(step: TestStep): Promise<StepResult> {
    const started = Date.now();
    const base = (process.env.HX_API_BASE ?? "").replace(/\/+$/, "");
    if (!base) {
        return { id: step.id, kind: "probe", status: "skipped", exitCode: null, durationMs: 0, detail: "no base url" };
    }
    const url = base + (step.probe ?? "/");
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: "*/*" } });
        const ok = response.status >= 200 && response.status < 300;
        return {
            id: step.id,
            kind: "probe",
            status: ok ? "passed" : "failed",
            exitCode: response.status,
            durationMs: Date.now() - started,
            detail: "GET " + url + " -> " + response.status,
        };
    } catch (error) {
        return {
            id: step.id,
            kind: "probe",
            status: "failed",
            exitCode: null,
            durationMs: Date.now() - started,
            detail: String(error),
        };
    }
}

/** Migrations are append only: a modified or deleted migration breaks deployed history. */
function runHistory(step: TestStep, options: RunOptions): StepResult {
    const started = Date.now();
    const raw = tryGit(options.codeRoot, ["diff", "--name-status", "-M", options.base || "HEAD", "--", MIGRATIONS_PATH]);
    if (raw === undefined) {
        return {
            id: step.id,
            kind: "history",
            status: "failed",
            exitCode: null,
            durationMs: Date.now() - started,
            detail: "git diff failed for " + MIGRATIONS_PATH,
        };
    }
    const broken = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("A"));
    const detail = broken.length ? broken.join("\n") : "migrations are append only";
    return {
        id: step.id,
        kind: "history",
        status: broken.length ? "failed" : "passed",
        exitCode: null,
        durationMs: Date.now() - started,
        detail,
    };
}

/** Run every step of one tier in order and stop at the first failure. */
export async function runCategory(item: TestCategory, tier: TestTier, options: RunOptions): Promise<TierResult> {
    const result: TierResult = {
        ruleId: item.ruleId,
        category: item.id,
        tier: tier.id,
        status: "passed",
        steps: [],
        failure: "",
    };
    if (tier.requiresEnv && !process.env[tier.requiresEnv]) {
        return { ...result, status: "skipped", failure: "skipped, " + tier.requiresEnv + " is not set" };
    }
    if (!existsSync(options.testsRoot)) {
        return { ...result, status: "failed", failure: "tests root missing: " + options.testsRoot };
    }
    for (const step of tier.steps) {
        const stepResult =
            step.kind === "cmd"
                ? runCommand(step, options.testsRoot)
                : step.kind === "probe"
                  ? await runProbe(step)
                  : runHistory(step, options);
        result.steps.push(stepResult);
        if (stepResult.status === "failed") {
            return { ...result, status: "failed", failure: step.id + " failed" };
        }
    }
    return result;
}

export type CategorySelection = { category: TestCategory; tier: TestTier };

/** Every category and tier selected by the filters; an unknown id yields an empty list. */
export function selection(ids: string[] | undefined, tierId: string | undefined): CategorySelection[] {
    const chosen = ids?.length ? ids.map((id) => findCategory(id)).filter((item) => item !== undefined) : CATEGORIES;
    return chosen.flatMap((item) => tierOf(item, tierId).map((tier) => ({ category: item, tier })));
}

function flag(args: string[], name: string): string | undefined {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
}

function writeResult(codeRoot: string, result: TierResult): string {
    const dir = join(codeRoot, REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test-" + result.category + "-" + result.tier + ".json");
    writeFileSync(file, JSON.stringify(result, null, 4) + "\n", UTF8);
    return file;
}

async function main(args: string[]): Promise<number> {
    const id = flag(args, "--category");
    const tierId = flag(args, "--tier") ?? "all";
    const testsRoot = flag(args, "--root");
    const codeRoot = flag(args, "--code-root") ?? ".";
    const base = flag(args, "--base") ?? "HEAD";
    if (!id) {
        process.stderr.write("usage: run.ts --category <id> [--tier <id>] --root <tests tree> --code-root <repo> --base <ref>\n");
        return 2;
    }
    const item = findCategory(id);
    if (!item) {
        process.stderr.write("unknown category: " + id + "\n");
        return 2;
    }
    if (!testsRoot) {
        process.stderr.write("--root is required: point it at the overlay of the test branch\n");
        return 2;
    }
    const options: RunOptions = { testsRoot, codeRoot, base };
    let failed = 0;
    for (const tier of tierOf(item, tierId)) {
        const result = await runCategory(item, tier, options);
        const file = writeResult(codeRoot, result);
        process.stdout.write(result.ruleId + " " + result.category + "/" + result.tier + ": " + result.status);
        process.stdout.write(result.failure ? " (" + result.failure + ")" : "");
        process.stdout.write(" -> " + file + "\n");
        if (result.status === "failed") {
            failed++;
        }
    }
    return failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("suite/run.ts")) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error: unknown) => {
            process.stderr.write("run.ts: " + String(error) + "\n");
            process.exit(2);
        },
    );
}
