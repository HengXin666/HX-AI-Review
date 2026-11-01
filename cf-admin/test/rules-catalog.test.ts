// GET /api/rules/catalog and the static rule catalog: the catalog must match the runner's rule definitions,
// and criteria on POST /runs is optional so runners that predate it keep working.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RULES_CATALOG } from "../worker/rules-catalog.ts";
import type { CatalogSource } from "../worker/rules-catalog.ts";
import { registered, setup } from "./harness.ts";

const CONTEXT_CR = join(import.meta.dirname, "..", "..", "context-cr", "src");

/**
 * The three places a rule id is declared, read in this order; an id seen earlier keeps its source, so the ten
 * CI rules that LOCAL_RULE repeats stay "ci". This is the one list the tests below take ids from.
 */
const RULE_SOURCES: { source: CatalogSource; ids: () => string[] }[] = [
    { source: "ci", ids: () => runnerRules().map((rule) => rule.id) },
    {
        source: "local",
        ids: () => {
            const text = readFileSync(join(CONTEXT_CR, "local", "checks", "rules.ts"), "utf8");
            const block = text.slice(text.indexOf("export const LOCAL_RULE"), text.indexOf("} as const"));
            return [...block.matchAll(/"([A-Z]+-\d{3})"/g)].map((match) => match[1]);
        },
    },
    { source: "test", ids: () => testCategories().map((item) => item.id) },
];

/**
 * Rule definitions as context-cr/src/rules writes them: { id, severity, description, criteria }, where severity
 * is the ERROR / WARNING constant or its string literal. Parsed from source because cf-admin never imports
 * context-cr; the two only share the HTTP contract.
 */
function runnerRules() {
    const shape =
        /id:\s*"([^"]+)",\s*severity:\s*(ERROR|WARNING|"error"|"warning"),\s*description:\s*"([^"]*)",\s*criteria:\s*"([^"]*)"/g;
    const dir = join(CONTEXT_CR, "rules");
    const found: { id: string; severity: string; description: string; criteria: string }[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
        for (const match of readFileSync(join(dir, file), "utf8").matchAll(shape)) {
            const error = match[2] === "ERROR" || match[2] === '"error"';
            found.push({
                id: match[1],
                severity: error ? "error" : "warning",
                description: match[3],
                criteria: match[4],
            });
        }
    }
    return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** CATEGORIES entries of the local test suite: ruleId, title and failure text. */
function testCategories() {
    const text = readFileSync(join(CONTEXT_CR, "local", "suite", "categories.ts"), "utf8");
    const shape = /ruleId:\s*"([^"]+)",[\s\S]*?title:\s*"([^"]*)",[\s\S]*?failure:\s*"([^"]*)"/g;
    return [...text.matchAll(shape)].map((match) => ({ id: match[1], title: match[2], failure: match[3] }));
}

function sourceOf(): Map<string, CatalogSource> {
    const owner = new Map<string, CatalogSource>();
    for (const item of RULE_SOURCES) {
        for (const id of item.ids()) {
            if (!owner.has(id)) {
                owner.set(id, item.source);
            }
        }
    }
    return owner;
}

test("the catalog holds exactly the union of the three rule sources, each id under its own source", () => {
    const owner = sourceOf();
    assert.equal(RULES_CATALOG.length, 20);
    assert.equal(new Set(RULES_CATALOG.map((rule) => rule.id)).size, RULES_CATALOG.length);
    assert.deepEqual(RULES_CATALOG.map((rule) => rule.id).sort(), [...owner.keys()].sort());
    for (const rule of RULES_CATALOG) {
        assert.equal(rule.source, owner.get(rule.id), `${rule.id} source`);
        assert.ok(rule.severity.length > 0 && rule.criteria.length > 0, `${rule.id} severity and criteria`);
    }
});

test("copied texts match their source: ci rules field for field, test rules by title and failure", () => {
    const ci = RULES_CATALOG.filter((rule) => rule.source === "ci").map(({ source: _source, ...rule }) => rule);
    assert.deepEqual(ci, runnerRules());
    for (const item of testCategories()) {
        const rule = RULES_CATALOG.find((entry) => entry.id === item.id)!;
        assert.equal(rule.description, item.title);
        assert.equal(rule.criteria, item.failure);
    }
});

test("GET /api/rules/catalog returns every rule with id, severity and criteria", async () => {
    const { call } = setup();
    const response = await call("GET", "/api/rules/catalog");
    assert.equal(response.status, 200);
    const rules = (await response.json()) as Record<string, unknown>[];
    assert.ok(Array.isArray(rules));
    assert.equal(rules.length, 20);
    for (const rule of rules) {
        assert.equal(typeof rule.id, "string");
        assert.ok(rule.severity === "error" || rule.severity === "warning" || rule.severity === "none");
        assert.ok(rule.source === "ci" || rule.source === "local" || rule.source === "test");
        assert.equal(typeof rule.criteria, "string");
        assert.ok((rule.criteria as string).length > 0, `${rule.id} has no criteria`);
    }
    assert.equal(
        rules.find((rule) => rule.id === "ARCH-003")!.criteria,
        "at most 6 files per directory; mixed source languages escalate to error",
    );
});

test("GET /api/rules/catalog requires an admin, and does not fall through to the hit statistics", async () => {
    const anonymous = setup(null);
    assert.equal((await anonymous.call("GET", "/api/rules/catalog")).status, 403);
    const { call } = setup();
    const body = await (await call("GET", "/api/rules/catalog")).json();
    // GET /api/rules answers an object with byRule; the catalog is a plain array of definitions.
    assert.ok(Array.isArray(body));
});

const finding = {
    ruleId: "ARCH-003",
    severity: "warning",
    path: "src",
    line: 1,
    message: "7 files",
    fingerprint: "fp-a",
};

test("POST /runs without criteria (an older runner) is accepted, not a 400, and stores empty criteria", async () => {
    const { call, token, store } = await registered();
    const response = await call("POST", "/runs", { repo: "o/r", sha: "s1", event: "push", findings: [finding] }, token);
    assert.notEqual(response.status, 400);
    assert.equal(response.status, 201);
    assert.equal(store.findings.at(-1)!.criteria, "");
    // null is what a runner without the field may serialise; it means the same thing.
    const nulled = await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "s2", event: "push", findings: [{ ...finding, fingerprint: "fp-b", criteria: null }] },
        token,
    );
    assert.equal(nulled.status, 201);
    assert.equal(store.findings.at(-1)!.criteria, "");
});

test("POST /runs keeps criteria through to the overview, and a non-string criteria is a 400", async () => {
    const { call, token, store } = await registered();
    const criteria = "at most 6 files per directory; mixed source languages escalate to error";
    const response = await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "s1", event: "push", findings: [{ ...finding, criteria }] },
        token,
    );
    assert.equal(response.status, 201);
    assert.equal(store.findings.at(-1)!.criteria, criteria);
    const overview = (await (await call("GET", "/api/overview")).json()) as { findings: { criteria?: string }[] };
    assert.equal(overview.findings[0].criteria, criteria);
    const before = store.runs.length;
    const bad = await call(
        "POST",
        "/runs",
        { repo: "o/r", sha: "s2", event: "push", findings: [{ ...finding, criteria: 7 }] },
        token,
    );
    assert.equal(bad.status, 400);
    assert.equal(store.runs.length, before);
});
