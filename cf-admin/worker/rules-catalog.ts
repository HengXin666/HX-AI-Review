// Read-only copy of every rule id the runner can report, for GET /api/rules/catalog. Three sources:
//   ci    context-cr/src/rules/*.ts: the L0 rules of the CI gate, copied from their definitions.
//   local context-cr/src/local/checks/rules.ts LOCAL_RULE: ids only the local diff check adds (the other ten are ci).
//   test  context-cr/src/local/suite/categories.ts CATEGORIES: description is the title, criteria the failure text.
// cf-admin never imports context-cr, so this is static; test/rules-catalog.test.ts parses the three files and
// fails when an id or a copied text drifts. severity none marks an id that is declared but reported by no check.

export type CatalogSeverity = "error" | "warning" | "none";
export type CatalogSource = "ci" | "local" | "test";

/** One rule: stable id, declared severity, what it is about, the yardstick it applies, and which set it is in. */
export type CatalogRule = {
    id: string;
    severity: CatalogSeverity;
    description: string;
    criteria: string;
    source: CatalogSource;
};

/** Every rule id across the three sets, in id order. */
export const RULES_CATALOG: readonly CatalogRule[] = [
    {
        id: "ARCH-001",
        severity: "error",
        description: "Public interface and impl/ stay separated",
        criteria: "module with impl/ exposes a public entry and other modules import only that entry",
        source: "ci",
    },
    {
        id: "ARCH-002",
        severity: "error",
        description: "Dependency direction has no cycle",
        criteria: "the directory import graph is acyclic",
        source: "ci",
    },
    {
        id: "ARCH-003",
        severity: "warning",
        description: "One directory holds at most 6 files",
        criteria: "at most 6 files per directory; mixed source languages escalate to error",
        source: "ci",
    },
    {
        id: "ARCH-004",
        severity: "error",
        description: "API and data source stay separated",
        criteria: "API layer imports no data-source package and holds no SQL",
        source: "ci",
    },
    {
        id: "CI-001",
        severity: "error",
        description: "Workflows exist and are invoked",
        criteria: "each workflow has on: and jobs:, and every local script, package and workflow it calls exists",
        source: "ci",
    },
    {
        id: "CTX-001",
        severity: "error",
        description: "AGENTS.md structure",
        criteria: "under 150 lines and 16 KB, one level 1 heading, no heading jump, paired README.md",
        source: "ci",
    },
    {
        id: "CTX-002",
        severity: "error",
        description: "SKILL.md structure",
        criteria: "front matter with a matching name and description, plus a body with a heading",
        source: "ci",
    },
    {
        id: "DOC-001",
        severity: "error",
        description: "Documentation links resolve",
        criteria: "every relative markdown link points at a tracked file or directory",
        source: "ci",
    },
    {
        id: "DOC-002",
        severity: "error",
        description: "Linked docs change with the code they describe",
        criteria:
            "when a path watched in scripts/quality/doc-links/links.json changes, the linked doc changes in the same diff; a missing or invalid config is itself an error",
        source: "local",
    },
    {
        id: "META-001",
        severity: "none",
        description: "Reserved id, no local check reports it yet",
        criteria:
            "declared as LOCAL_RULE.meta, but no check in context-cr reports this id, so it never produces a finding",
        source: "local",
    },
    {
        id: "STYLE-001",
        severity: "error",
        description: "Formatter contract on changed text files",
        criteria:
            "changed text files have no CRLF line endings, no tab indentation, no trailing whitespace, and end with a newline",
        source: "local",
    },
    {
        id: "STYLE-002",
        severity: "none",
        description: "Reserved id, no local check reports it yet",
        criteria:
            "declared as LOCAL_RULE.lint, but no check in context-cr reports this id, so it never produces a finding",
        source: "local",
    },
    {
        id: "STYLE-003",
        severity: "error",
        description: "Comments describe semantics only",
        criteria: "header comment at most 10 lines, comments use ASCII punctuation and no emoji",
        source: "ci",
    },
    {
        id: "STYLE-004",
        severity: "warning",
        description: "New third-party dependency needs a human decision",
        criteria: "dependency absent from the base revision",
        source: "ci",
    },
    {
        id: "TEST-001",
        severity: "error",
        description: "Backend API against a fake store and against a real deployment",
        criteria:
            "any selected test exits non-zero; the real tier fails when HX_API_BASE is set and /healthz is not 2xx with status ok",
        source: "test",
    },
    {
        id: "TEST-002",
        severity: "error",
        description: "Frontend request layer",
        criteria: "any request layer test exits non-zero, or the test branch has no test/frontend/request suite",
        source: "test",
    },
    {
        id: "TEST-003",
        severity: "error",
        description: "Frontend UI against fake data",
        criteria: "any UI test exits non-zero, or the test branch has no test/frontend/ui suite",
        source: "test",
    },
    {
        id: "TEST-004",
        severity: "error",
        description: "End to end",
        criteria: "any end to end test exits non-zero, or the test branch has no test/e2e suite",
        source: "test",
    },
    {
        id: "TEST-005",
        severity: "error",
        description: "Performance budget",
        criteria:
            "a measured budget is exceeded, the measurement tool is missing, or the test branch has no test/perf suite",
        source: "test",
    },
    {
        id: "TEST-006",
        severity: "error",
        description: "Build and history compatibility",
        criteria: "the build fails, or a migration is modified or deleted instead of appended",
        source: "test",
    },
];
