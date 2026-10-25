import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../src/contract/report.ts";
import type { Finding } from "../src/contract/finding.ts";
import { renderComment } from "../src/publish/comment.ts";

function finding(over: Partial<Finding> = {}): Finding {
    return {
        ruleId: "CODE-AI",
        severity: "warning",
        path: "src/a.ts",
        line: 12,
        message: "missing null check",
        evidence: "e",
        fingerprint: "fp",
        origin: "new",
        criteria: "",
        exemption: null,
        ...over,
    };
}

function report(findings: Finding[], kind: "context" | "code" = "code") {
    return buildReport({
        repo: "o/r",
        kind,
        base: "1111111111",
        head: "2222222222",
        durationMs: 1500,
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 },
        stages: {},
        findings,
        patches: [],
    });
}

test("the comment keeps every number outside the images, so a client that drops them still reads", () => {
    const body = renderComment(report([finding()]), {});
    assert.match(body, /<picture>/);
    assert.match(body, /prefers-color-scheme: dark/);
    // The counts must appear as text too, not only inside the SVG data URIs, so a client that drops
    // images still shows the numbers.
    assert.match(body, /<\/picture> 1<\/td>/);
    assert.match(body, /1 个告警, 无阻断/);
});

test("the grade follows the gate: a blocking error is F, clean is A, warnings step down", () => {
    const blocking = renderComment(report([finding({ severity: "error", ruleId: "HC-CONTEXT" })]), {});
    assert.match(blocking, /alt="等级 F"/);
    const clean = renderComment(report([]), {});
    assert.match(clean, /alt="等级 A"/);
    const one = renderComment(report([finding()]), {});
    assert.match(one, /alt="等级 B"/);
    const many = renderComment(report([1, 2, 3, 4].map((n) => finding({ fingerprint: "fp" + n }))), {});
    assert.match(many, /alt="等级 C"/);
});

test("more findings than the detail limit collapse to per-rule counts", () => {
    const many = Array.from({ length: 12 }, (_, index) => finding({ fingerprint: "fp" + index, line: index + 1 }));
    const body = renderComment(report(many), {});
    assert.match(body, /超过 10 条明细上限/);
    assert.doesNotMatch(body, /src\/a\.ts:1<\/code>/);
});

test("the kind decides the scope line, because the two reviews look at different things", () => {
    const code = renderComment(report([], "code"), {});
    assert.match(code, /代码 CR/);
    assert.match(code, /审 diff 新增与修改的行/);
    const context = renderComment(report([], "context"), {});
    assert.match(context, /上下文 CR/);
    assert.match(context, /AGENTS\.md/);
});

test("html in a finding message is escaped, so a report cannot inject markup into the comment", () => {
    const body = renderComment(report([finding({ message: '<img src=x onerror="alert(1)">' })]), {});
    assert.doesNotMatch(body, /<img src=x onerror/);
    assert.match(body, /&lt;img/);
});

test("the marker stays first, so the publisher still finds and updates its own comment", () => {
    assert.ok(renderComment(report([]), {}).startsWith("<!-- hx-context-review -->"));
});
