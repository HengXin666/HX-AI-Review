import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_USAGE } from "../src/contract/finding.ts";
import { buildReport, summarize } from "../src/contract/report.ts";
import type { InitConfig } from "../src/init/client.ts";
import type { AgentRequest, AgentRunner } from "../src/review/agent.ts";
import { runReview } from "../src/review/index.ts";
import type { ContextScope } from "../src/scope/index.ts";

const config: InitConfig = {
    repo: "o/r",
    enabled: true,
    l0Only: false,
    apiUrl: "http://model.invalid",
    api: "openai-completions",
    models: { finder: "small", verifier: "large" },
    limits: { contextWindow: 1000, maxTokens: 100, maxCandidates: 5 },
    suppressions: [],
};

const scope: ContextScope = {
    base: "b",
    head: "h",
    changed: ["api/user.ts"],
    contexts: [{ path: "api/AGENTS.md", reasons: ["ancestor of api/user.ts"] }],
};

/** Finder reports three candidates; verifier confirms only titles starting with "real". */
function fake(calls: AgentRequest[]): AgentRunner {
    return async (request) => {
        calls.push(request);
        const [tool] = request.tools;
        if (request.role === "finder") {
            for (const title of ["real stale path", "style nit", "real outside scope"]) {
                const path = title.includes("outside") ? "web/AGENTS.md" : "api/AGENTS.md";
                tool.execute({ path, line: 3, title, message: "m", evidence: "e", patch: "diff --git a/x b/x\n" });
            }
        } else {
            const real = request.prompt.includes("title: real");
            tool.execute({ verdict: real ? "confirmed" : "rejected", reason: "checked" });
        }
        return { usage: { ...EMPTY_USAGE, input: 10, output: 2, cost: 0.01 }, transcript: [{ role: request.role }] };
    };
}

test("finder -> verifier keeps only confirmed, in-scope candidates as warnings", async () => {
    const calls: AgentRequest[] = [];
    const result = await runReview(config, scope, { run: fake(calls), diff: "d", patchApplies: () => true });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "warning");
    assert.equal(result.findings[0].ruleId, "CX-AI");
    assert.equal(result.rejected, 2);
    assert.equal(result.patches.length, 1);
    assert.deepEqual(
        calls.map((item) => `${item.role}:${item.model}`),
        ["finder:small", "verifier:large", "verifier:large"],
    );
    assert.equal(result.usage.input, 30);
});

test("suppressed fingerprints never reach the verifier", async () => {
    const first = await runReview(config, scope, { run: fake([]), diff: "d", patchApplies: () => true });
    const calls: AgentRequest[] = [];
    const suppressions = [{ fingerprint: first.findings[0].fingerprint, reason: "intended wording" }];
    const again = await runReview({ ...config, suppressions }, scope, {
        run: fake(calls),
        diff: "d",
        patchApplies: () => true,
    });
    assert.equal(again.findings.length, 0);
    assert.ok(calls[0].prompt.includes("intended wording"));
});

test("display rule: more than 10 findings lists counts only", () => {
    const findings = Array.from({ length: 11 }, (_, index) => ({
        ruleId: "CX-AI",
        severity: "warning" as const,
        path: "a.md",
        line: index + 1,
        message: "m" + index,
        evidence: "e",
        fingerprint: "f" + index,
        origin: "new" as const,
    }));
    assert.ok(!summarize(findings).includes("| warning |"));
    assert.ok(summarize(findings.slice(0, 10)).includes("| warning |"));
    const report = buildReport({
        repo: "o/r",
        base: "b",
        head: "h",
        findings,
        patches: [],
        usage: EMPTY_USAGE,
        durationMs: 1,
        stages: {},
    });
    assert.equal(report.counts.blocking, 0);
});
