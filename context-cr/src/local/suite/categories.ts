export type StepKind = "cmd" | "probe" | "history";

export type TestStep = { id: string; kind: StepKind; command?: string; probe?: string; timeoutMs?: number };

export type TestTier = { id: string; title: string; steps: TestStep[]; requiresEnv?: string };

export type TestCategory = {
    ruleId: string;
    id: string;
    title: string;
    workflow: string;
    trigger: string;
    failure: string;
    tiers: TestTier[];
};

export const AGGREGATE_WORKFLOW = "tests-all.yml";
export const AUDIT_WORKFLOW = "audit.yml";
export const AUDIT_MARKER = "<!-- hx-audit -->";
export const DEFAULT_TEST_BRANCH = "test";
export const MIGRATIONS_PATH = "cf-admin/migrations";

/** The six test categories of the gate; the workflows and local checks read this list. */
export const CATEGORIES: TestCategory[] = [
    {
        ruleId: "TEST-001",
        id: "backend-api",
        title: "Backend API against a fake store and against a real deployment",
        workflow: "tests-backend-api.yml",
        trigger: "pull_request, push to the default branch, tests-all dispatch",
        failure: "any selected test exits non-zero; the real tier fails when HX_API_BASE is set and the probe is not 2xx",
        tiers: [
            {
                id: "fake",
                title: "fake data",
                steps: [{ id: "suite", kind: "cmd", command: "pnpm --filter cf-admin test" }],
            },
            {
                id: "real",
                title: "real data",
                requiresEnv: "HX_API_BASE",
                steps: [{ id: "probe", kind: "probe", probe: "/" }],
            },
        ],
    },
    {
        ruleId: "TEST-002",
        id: "frontend-request",
        title: "Frontend request layer",
        workflow: "tests-frontend-request.yml",
        trigger: "pull_request touching cf-admin/pages, tests-all dispatch",
        failure: "any request layer test exits non-zero, or the test branch has no test/frontend/request suite",
        tiers: [
            {
                id: "fake",
                title: "fake data",
                steps: [{ id: "suite", kind: "cmd", command: "node --test test/frontend/request/*.test.ts" }],
            },
        ],
    },
    {
        ruleId: "TEST-003",
        id: "frontend-ui",
        title: "Frontend UI against fake data",
        workflow: "tests-frontend-ui.yml",
        trigger: "pull_request touching cf-admin/pages, tests-all dispatch",
        failure: "any UI test exits non-zero, or the test branch has no test/frontend/ui suite",
        tiers: [
            {
                id: "fake",
                title: "fake data",
                steps: [{ id: "suite", kind: "cmd", command: "node --test test/frontend/ui/*.test.ts" }],
            },
        ],
    },
    {
        ruleId: "TEST-004",
        id: "e2e",
        title: "End to end",
        workflow: "tests-e2e.yml",
        trigger: "pull_request labelled e2e, nightly schedule, tests-all dispatch",
        failure: "any end to end test exits non-zero, or the test branch has no test/e2e suite",
        tiers: [
            {
                id: "fake",
                title: "fake data",
                steps: [{ id: "suite", kind: "cmd", command: "node --test test/e2e/*.test.ts" }],
            },
        ],
    },
    {
        ruleId: "TEST-005",
        id: "perf",
        title: "Performance budget",
        workflow: "tests-perf.yml",
        trigger: "nightly schedule, release tags, tests-all dispatch",
        failure: "a measured budget is exceeded, the measurement tool is missing, or the test branch has no test/perf suite",
        tiers: [
            {
                id: "fake",
                title: "fake data",
                steps: [{ id: "suite", kind: "cmd", command: "node --test test/perf/*.test.ts" }],
            },
        ],
    },
    {
        ruleId: "TEST-006",
        id: "build-compat",
        title: "Build and history compatibility",
        workflow: "tests-build-compat.yml",
        trigger: "pull_request, push to the default branch, tests-all dispatch",
        failure: "the build fails, or a migration is modified or deleted instead of appended",
        tiers: [
            {
                id: "default",
                title: "build and migrations",
                steps: [
                    { id: "build", kind: "cmd", command: "pnpm -r build" },
                    { id: "history", kind: "history" },
                ],
            },
        ],
    },
];

export function category(id: string): TestCategory | undefined {
    return CATEGORIES.find((item) => item.id === id);
}

export function tierOf(item: TestCategory, id: string | undefined): TestTier[] {
    return id && id !== "all" ? item.tiers.filter((tier) => tier.id === id) : item.tiers;
}
