import assert from "node:assert/strict";
import { test } from "node:test";
import { NIT_KEEP_CONFIDENCE, publishKeys } from "../src/review/budget.ts";
import { resolutionRate, rulesFromDismissals } from "../src/review/learn.ts";
import { issueRefs, renderIntent } from "../src/review/intent.ts";
import { scoreCase } from "../src/eval/score.ts";

test("the comment budget keeps higher grades and drops nits while a higher finding exists", () => {
    const keep = publishKeys(
        [
            { key: "nit", grade: "nit", confidence: 0.99 },
            { key: "major", grade: "major", confidence: 0.4 },
            { key: "critical", grade: "critical", confidence: 0.5 },
        ],
        5,
    );
    assert.deepEqual([...keep].sort(), ["critical", "major"]);
});

test("a lone high-confidence nit is kept and a low-confidence one is not", () => {
    const high = publishKeys([{ key: "n", grade: "nit", confidence: NIT_KEEP_CONFIDENCE }], 5);
    const low = publishKeys([{ key: "n", grade: "nit", confidence: NIT_KEEP_CONFIDENCE - 0.01 }], 5);
    assert.equal(high.has("n"), true);
    assert.equal(low.size, 0);
});

test("more criticals than the budget drops the lowest confidence ones", () => {
    const keep = publishKeys(
        [
            { key: "a", grade: "critical", confidence: 0.9 },
            { key: "b", grade: "critical", confidence: 0.2 },
            { key: "c", grade: "critical", confidence: 0.5 },
        ],
        2,
    );
    assert.deepEqual([...keep].sort(), ["a", "c"]);
});

test("resolution rate ignores an empty history and counts dismissals", () => {
    assert.equal(resolutionRate([]).rate, null);
    const rate = resolutionRate([{ verdict: "accepted" }, { verdict: "accepted" }, { verdict: "rejected" }]);
    assert.equal(rate.accepted, 2);
    assert.equal(rate.dismissed, 1);
    assert.equal(rate.rate, 2 / 3);
});

test("a dismissal reason becomes a repo rule only when it is repeated", () => {
    const once = rulesFromDismissals([{ reason: "wording is intended" }]);
    assert.deepEqual(once, []);
    const twice = rulesFromDismissals([
        { reason: "Wording is intended" },
        { reason: "wording   is intended" },
        { reason: "different" },
    ]);
    assert.equal(twice.length, 1);
    assert.match(twice[0], /dismissed 2 times/);
    assert.match(twice[0], /Do not report this again/);
});

test("issue refs keep first-seen order and ignore words that only look like numbers", () => {
    assert.deepEqual(issueRefs("Fixes #12 and closes #12, also #3. See issues/9."), [12, 3, 9]);
    assert.deepEqual(issueRefs("no issues here"), []);
});

test("the intent card renders the title, commits and linked issues as data", () => {
    const text = renderIntent({
        source: "pull_request",
        title: "Keep cents",
        body: "integer cents only",
        commits: [{ subject: "adjust charge", body: "" }],
        issues: [{ number: 4, title: "cents", body: "do not divide" }],
    });
    assert.match(text, /integer cents only/);
    assert.match(text, /#4 cents/);
    assert.match(text, /adjust charge/);
});

test("scoring matches one finding to one expected bug and counts the rest as false positives", () => {
    const scored = scoreCase(
        [
            { path: "a.ts", message: "real: broken", grade: "critical", category: "security" },
            { path: "a.ts", message: "nit: rename", grade: "nit", category: "other" },
        ],
        [{ path: "a.ts", grade: "critical", category: "security", titleIncludes: "real" }],
    );
    assert.equal(scored.hits.length, 1);
    assert.equal(scored.misses.length, 0);
    assert.equal(scored.falsePositives.length, 1);
});
