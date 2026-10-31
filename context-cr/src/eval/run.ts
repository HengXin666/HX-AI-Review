// Offline replay of the code reviewer against the versioned golden set.
// The runner is the real runReview pipeline (scope, intent card, gates, verifier, comment budget).
// The model is a pinned transcript per case, so a run does not call a provider and the metrics
// move when prompts, gates, or the budget change. Design: docs/reference/code-eval.md.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_COMMENT_BUDGET } from "../constants.ts";
import { EMPTY_USAGE } from "../contract/finding.ts";
import type { CodeCategory, CodeGrade } from "../contract/finding.ts";
import { CODE_KIND } from "../contract/kind.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import type { InitConfig } from "../init/client.ts";
import type { AgentRunner } from "../review/agent.ts";
import { renderIntent } from "../review/intent.ts";
import type { IntentCard } from "../review/intent.ts";
import { runReview } from "../review/index.ts";
import { CODE_FINDER_SYSTEM, CODE_VERIFIER_SYSTEM } from "../review/prompts.ts";
import { computeCodeScope } from "../scope/code.ts";
import { scoreCase } from "./score.ts";
import type { ExpectedHit } from "./score.ts";

const GOLDEN_DIR = dirname(fileURLToPath(new URL("../../eval/golden/v1/manifest.json", import.meta.url)));

const PINNED_LIMITS = { contextWindow: 128000, maxTokens: 8192, maxCandidates: 12, maxRunUsd: null };

export type ReplayReport = {
    path: string;
    line: number;
    side?: "left" | "right";
    title: string;
    message: string;
    evidence: string;
    category?: CodeCategory;
    grade?: CodeGrade;
    confidence?: number;
    repro?: string;
    /** Skip this report unless the finder system prompt or user prompt contains the string. */
    requires?: string;
};

export type GoldenCase = {
    id: string;
    note: string;
    intent?: IntentCard;
    diff: string;
    path: string;
    status?: string;
    replay: { finder: ReplayReport[]; verdicts: Record<string, "confirmed" | "rejected"> };
    expect: ExpectedHit[];
};

export type CategoryRecall = { hit: number; expected: number; recall: number };

export type EvalReport = {
    dataset: string;
    mode: "replay";
    models: { finder: string; verifier: string };
    promptHash: string;
    configHash: string;
    commentBudget: number;
    cases: number;
    precision: number;
    recallByCategory: Record<string, CategoryRecall>;
    falsePositiveRate: number;
    criticalMisses: number;
    findingsPerPr: number;
    truePositives: number;
    falsePositives: number;
    details: { id: string; published: number; hits: number; falsePositives: number; misses: string[] }[];
};

type Manifest = { version: string; cases: string[] };

function sha16(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Hash of the two code-review system prompts. A prompt edit changes it. */
export function promptHash(): string {
    return sha16(CODE_FINDER_SYSTEM + "\0" + CODE_VERIFIER_SYSTEM);
}

/** Hash of the pinned eval config and the case ids. A dataset or budget edit changes it. */
export function configHash(dataset: string, caseIds: string[]): string {
    return sha16(
        JSON.stringify({
            dataset,
            caseIds: [...caseIds].sort(),
            budget: CODE_COMMENT_BUDGET,
            finder: "replay",
            verifier: "replay",
            limits: PINNED_LIMITS,
        }),
    );
}

function loadCases(dir: string): { version: string; cases: GoldenCase[] } {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const cases = manifest.cases.map((name) => {
        const item = JSON.parse(readFileSync(join(dir, name), "utf8")) as GoldenCase;
        if (!item.id || !item.diff || !item.path || !item.replay) {
            throw new Error(`golden case ${name} is missing id, diff, path, or replay`);
        }
        return item;
    });
    return { version: manifest.version, cases };
}

function titleFromPrompt(prompt: string): string {
    const match = prompt.match(/"title": "((?:\\.|[^"\\])*)"/);
    if (!match) {
        return "";
    }
    try {
        return JSON.parse(`"${match[1]}"`) as string;
    } catch {
        return match[1];
    }
}

function replayOf(item: GoldenCase): AgentRunner {
    return async (request) => {
        const [tool] = request.tools;
        const blob = request.system + "\n" + request.prompt;
        if (request.role === "finder") {
            for (const report of item.replay.finder) {
                if (report.requires && !blob.includes(report.requires)) {
                    continue;
                }
                const { requires: _requires, ...fields } = report;
                await tool.execute(fields);
            }
        } else {
            const title = titleFromPrompt(request.prompt);
            const verdict = item.replay.verdicts[title] ?? "rejected";
            await tool.execute({
                verdict,
                reason: "checked the diff, the quotes, and the intent card",
                patch: "none",
            });
        }
        return { usage: { ...EMPTY_USAGE, input: 1, output: 1, cost: 0 }, transcript: [{ role: request.role }] };
    };
}

const reviewConfig: InitConfig = {
    repo: "eval/golden",
    kind: CODE_KIND,
    enabled: true,
    l0Only: false,
    apiUrl: "http://replay.invalid",
    api: "openai-completions",
    models: { finder: "replay", verifier: "replay" },
    limits: PINNED_LIMITS,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    suppressions: [],
};

async function reviewCase(item: GoldenCase) {
    const scope = computeCodeScope(
        () => item.diff,
        DEFAULT_CONFIG,
        [{ status: item.status ?? "M", path: item.path }],
        "base",
        "head",
    );
    return runReview(reviewConfig, scope, {
        run: replayOf(item),
        diff: "",
        patchFiles: () => undefined,
        readFile: () => undefined,
        intent: item.intent ? renderIntent(item.intent) : "",
    });
}

function expectKey(want: ExpectedHit): string {
    return [want.grade, want.category, want.path, want.titleIncludes ?? ""].join("\0");
}

/** Replay every case in the golden set and aggregate precision, recall, noise, and critical misses. */
export async function runGolden(dir = GOLDEN_DIR): Promise<EvalReport> {
    const { version, cases } = loadCases(dir);
    let truePositives = 0;
    let falsePositives = 0;
    let criticalMisses = 0;
    let publishedTotal = 0;
    let clean = 0;
    let cleanWithFinding = 0;
    const details: EvalReport["details"] = [];
    const missed = new Map<string, Set<string>>();
    for (const item of cases) {
        const result = await reviewCase(item);
        const scored = scoreCase(result.findings, item.expect);
        truePositives += scored.hits.length;
        falsePositives += scored.falsePositives.length;
        publishedTotal += result.findings.length;
        if (item.expect.length === 0) {
            clean += 1;
            if (result.findings.length > 0) {
                cleanWithFinding += 1;
            }
        }
        const keys = new Set(scored.misses.map(expectKey));
        missed.set(item.id, keys);
        for (const miss of scored.misses) {
            if (miss.grade === "critical") {
                criticalMisses += 1;
            }
        }
        details.push({
            id: item.id,
            published: result.findings.length,
            hits: scored.hits.length,
            falsePositives: scored.falsePositives.length,
            misses: scored.misses.map(expectKey),
        });
    }
    return finish(
        version,
        cases,
        details,
        missed,
        truePositives,
        falsePositives,
        criticalMisses,
        publishedTotal,
        clean,
        cleanWithFinding,
    );
}

function finish(
    version: string,
    cases: GoldenCase[],
    details: EvalReport["details"],
    missed: Map<string, Set<string>>,
    truePositives: number,
    falsePositives: number,
    criticalMisses: number,
    publishedTotal: number,
    clean: number,
    cleanWithFinding: number,
): EvalReport {
    const recall = new Map<string, { hit: number; expected: number }>();
    for (const item of cases) {
        const missSet = missed.get(item.id) ?? new Set<string>();
        for (const want of item.expect) {
            const row = recall.get(want.category) ?? { hit: 0, expected: 0 };
            row.expected += 1;
            if (!missSet.has(expectKey(want))) {
                row.hit += 1;
            }
            recall.set(want.category, row);
        }
    }
    const recallByCategory: Record<string, CategoryRecall> = {};
    for (const [category, row] of [...recall.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        recallByCategory[category] = {
            hit: row.hit,
            expected: row.expected,
            recall: row.expected === 0 ? 1 : row.hit / row.expected,
        };
    }
    const decided = truePositives + falsePositives;
    const ids = cases.map((item) => item.id);
    return {
        dataset: version,
        mode: "replay",
        models: { finder: "replay", verifier: "replay" },
        promptHash: promptHash(),
        configHash: configHash(version, ids),
        commentBudget: CODE_COMMENT_BUDGET,
        cases: cases.length,
        precision: decided === 0 ? 1 : truePositives / decided,
        recallByCategory,
        falsePositiveRate: clean === 0 ? 0 : cleanWithFinding / clean,
        criticalMisses,
        findingsPerPr: cases.length === 0 ? 0 : publishedTotal / cases.length,
        truePositives,
        falsePositives,
        details,
    };
}

export async function runEvalCommand(): Promise<number> {
    const report = await runGolden();
    process.stdout.write(JSON.stringify(report, null, 4) + "\n");
    return report.criticalMisses > 0 ? 1 : 0;
}
