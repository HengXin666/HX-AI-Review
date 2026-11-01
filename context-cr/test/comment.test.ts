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
    // The marker carries the kind, so a context CR and a code CR keep separate comments on one PR.
    assert.ok(renderComment(report([]), {}).startsWith("<!-- hx-context-review:code -->"));
    assert.ok(renderComment(report([], "context"), {}).startsWith("<!-- hx-context-review:context -->"));
});

test("each finding with criteria gets a criteria line under it, and an empty criteria adds nothing", () => {
    const body = renderComment(
        report([
            finding({ ruleId: "ARCH-003", criteria: "at most 6 files per directory", fingerprint: "a" }),
            finding({ ruleId: "CODE-AI", criteria: "", fingerprint: "b", line: 20 }),
        ]),
        {},
    );
    assert.match(body, /<tr><td><\/td><td colspan="3"><sub>判据: at most 6 files per directory<\/sub><\/td><\/tr>/);
    assert.equal(body.match(/<sub>判据: /g)?.length, 1);
    // The findings table keeps its four columns: criteria is a row, not a fifth header.
    assert.match(
        body,
        /<th align="left">等级<\/th><th align="left">规则<\/th><th align="left">位置<\/th><th align="left">说明<\/th><\/tr>/,
    );
});

test("a collapsed rule table at the top lists each rule of the report once with its severity and criteria", () => {
    const body = renderComment(
        report([
            finding({ ruleId: "ARCH-003", severity: "warning", criteria: "", fingerprint: "a" }),
            finding({ ruleId: "ARCH-003", severity: "error", criteria: "at most 6 files", fingerprint: "b", line: 2 }),
            finding({ ruleId: "CODE-AI", criteria: "", fingerprint: "c", line: 3 }),
        ]),
        {},
    );
    const details = body.slice(body.indexOf("<details>"), body.indexOf("</details>"));
    assert.ok(body.indexOf("<details>") > 0 && body.indexOf("<details>") < body.indexOf('<th align="left">位置'));
    assert.match(details, /本次报告涉及的规则 \(2 条\)/);
    assert.match(details, /<code>ARCH-003<\/code><\/td><td>error<\/td><td>at most 6 files<\/td>/);
    assert.match(details, /<code>CODE-AI<\/code><\/td><td>warning<\/td><td>-<\/td>/);
    assert.equal(renderComment(report([]), {}).includes("<details>"), false);
});

test("criteria text is escaped like any other finding field", () => {
    const body = renderComment(report([finding({ criteria: "<script>x</script>" })]), {});
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /判据: &lt;script&gt;/);
});
