import assert from "node:assert/strict";
import { test } from "node:test";
import { INGEST_FINDING_LIMIT } from "../src/constants.ts";

/**
 * The cap lives in stepPublish, which needs a git repo and a live endpoint, so this exercises the
 * ordering rule it relies on rather than the function itself: errors must survive truncation because
 * they are what blocks a merge, and warnings fill the rest.
 */
function cap(findings: { severity: string; id: number }[]): { severity: string; id: number }[] {
    if (findings.length <= INGEST_FINDING_LIMIT) {
        return findings;
    }
    const errors = findings.filter((item) => item.severity === "error");
    const warnings = findings.filter((item) => item.severity !== "error");
    return [...errors, ...warnings].slice(0, INGEST_FINDING_LIMIT);
}

test("a backlog larger than the ingest limit keeps every error and drops the tail of the warnings", () => {
    const findings = [
        ...Array.from({ length: 3 }, (_, index) => ({ severity: "error", id: index })),
        ...Array.from({ length: 900 }, (_, index) => ({ severity: "warning", id: 1000 + index })),
    ];
    const kept = cap(findings);
    assert.equal(kept.length, INGEST_FINDING_LIMIT);
    assert.equal(kept.filter((item) => item.severity === "error").length, 3);
    // The dropped ones are the warnings at the end, never an error.
    assert.equal(kept[0].severity, "error");
});

test("a payload already under the limit is returned untouched, order included", () => {
    const findings = [
        { severity: "warning", id: 1 },
        { severity: "error", id: 2 },
    ];
    assert.deepEqual(cap(findings), findings);
});

test("more errors than the limit keeps only errors, because a warning never blocks", () => {
    const findings = Array.from({ length: 600 }, (_, index) => ({ severity: "error", id: index }));
    const kept = cap(findings);
    assert.equal(kept.length, INGEST_FINDING_LIMIT);
    assert.ok(kept.every((item) => item.severity === "error"));
});
