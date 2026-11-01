import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { INGEST_FINDING_LIMIT, LEGACY_COMMENT_MARKER, REPORT_DIR, commentMarker } from "../src/constants.ts";
import type { Finding } from "../src/contract/finding.ts";
import { buildReport, isBlocking } from "../src/contract/report.ts";
import { renderComment } from "../src/publish/comment.ts";
import { findOwnComment, writeBack } from "../src/publish/github.ts";
import { capFindings, rulesFindings } from "../src/steps.ts";

const created: string[] = [];
after(() => {
    for (const dir of created) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function finding(over: Partial<Finding> = {}): Finding {
    return {
        ruleId: "HC-CONTEXT",
        severity: "warning",
        path: "src/a.ts",
        line: 1,
        message: "m",
        evidence: "e",
        fingerprint: "fp",
        origin: "new",
        criteria: "",
        exemption: null,
        ...over,
    };
}

function report(kind: "context" | "code", findings: Finding[] = []) {
    return buildReport({
        repo: "o/r",
        kind,
        base: "1111111",
        head: "2222222",
        durationMs: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        stages: {},
        findings,
        patches: [],
    });
}

test("comment marker: the two kinds get different markers and each comment carries its own", () => {
    assert.equal(commentMarker("context"), "<!-- hx-context-review:context -->");
    assert.equal(commentMarker("code"), "<!-- hx-context-review:code -->");
    assert.notEqual(commentMarker("context"), commentMarker("code"));
    assert.ok(renderComment(report("context"), {}).startsWith(commentMarker("context")));
    assert.ok(renderComment(report("code"), {}).startsWith(commentMarker("code")));
});

test("comment marker: a kind never takes the other kind's comment", () => {
    const comments = [{ id: 1, body: commentMarker("code") + "\nx" }];
    assert.equal(findOwnComment(comments, "context"), undefined);
    assert.equal(findOwnComment(comments, "code")?.id, 1);
});

test("comment marker: a legacy bare marker is still matched and taken over, own marker preferred", () => {
    const legacy = { id: 7, body: LEGACY_COMMENT_MARKER + "\nold" };
    assert.equal(findOwnComment([legacy], "context")?.id, 7);
    assert.equal(findOwnComment([legacy], "code")?.id, 7);
    const own = { id: 9, body: commentMarker("context") + "\nnew" };
    assert.equal(findOwnComment([legacy, own], "context")?.id, 9);
});

test("writeBack pages through PR comments and patches the kind's comment found on page 2", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        calls.push((init?.method ?? "GET") + " " + href);
        const page = /[?&]page=(\d+)/.exec(href)?.[1];
        if (page === "1") {
            const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "other" }));
            return new Response(JSON.stringify(full), { status: 200 });
        }
        if (page === "2") {
            return new Response(JSON.stringify([{ id: 555, body: commentMarker("code") + "\n" }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    try {
        await writeBack({ apiUrl: "https://api.test", repo: "o/r", token: "t" }, "abc", "body", 3, "code");
    } finally {
        globalThis.fetch = original;
    }
    assert.ok(calls.some((c) => c.includes("&page=2")));
    assert.ok(!calls.some((c) => c.includes("&page=3")));
    assert.ok(calls.some((c) => c.startsWith("PATCH ") && c.endsWith("/issues/comments/555")));
});

function rulesRoot(head: string, findings: Finding[]): string {
    const root = mkdtempSync(join(tmpdir(), "hx-ctx-rules-"));
    created.push(root);
    mkdirSync(join(root, REPORT_DIR), { recursive: true });
    writeFileSync(join(root, REPORT_DIR, "rules.json"), JSON.stringify({ head, findings }));
    return root;
}

test("rules findings enter the /runs payload as report-only warnings and never block", () => {
    const root = rulesRoot("2222222", [
        finding({ ruleId: "ARCH-001", severity: "error", fingerprint: "a" }),
        finding({ ruleId: "STYLE-003", severity: "warning", fingerprint: "b" }),
    ]);
    const rules = rulesFindings(root, "context", "2222222");
    const built = report("context", [finding({ ruleId: "CX-AI", fingerprint: "c" }), ...rules]);
    const payload = capFindings(built.findings).map((item) => item.ruleId);
    assert.ok(payload.includes("ARCH-001") && payload.includes("STYLE-003"));
    assert.equal(built.counts.warning, 3);
    assert.equal(built.counts.blocking, 0);
    assert.equal(built.findings.filter(isBlocking).length, 0);
});

test("rules findings: missing file, code kind or another head merge nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "hx-ctx-rules-"));
    created.push(empty);
    assert.deepEqual(rulesFindings(empty, "context", "h"), []);
    const root = rulesRoot("h1", [finding({ ruleId: "DOC-001" })]);
    assert.deepEqual(rulesFindings(root, "code", "h1"), []);
    assert.deepEqual(rulesFindings(root, "context", "h2"), []);
    assert.equal(rulesFindings(root, "context", "h1").length, 1);
});

test("rules findings still respect the ingest cap", () => {
    const many = Array.from({ length: INGEST_FINDING_LIMIT + 50 }, (_, i) =>
        finding({ ruleId: "STYLE-001", fingerprint: "f" + i, line: i + 1 }),
    );
    const root = rulesRoot("h", many);
    assert.equal(capFindings(rulesFindings(root, "context", "h")).length, INGEST_FINDING_LIMIT);
});
