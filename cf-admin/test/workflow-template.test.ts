import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_WORKFLOW_TEMPLATE, renderWorkflow } from "../worker/github/workflow-template.ts";

// One-click enable prefers the repository template over the built-in one, so both must carry the same contract:
// head_sha passed down to review.yml and one run per registered kind.
const REPO_TEMPLATE = readFileSync(new URL("../../templates/hx-context-review.workflow.yml", import.meta.url), "utf8");

for (const [label, template] of [
    ["templates/hx-context-review.workflow.yml", REPO_TEMPLATE],
    ["DEFAULT_WORKFLOW_TEMPLATE", DEFAULT_WORKFLOW_TEMPLATE],
] as const) {
    test(`${label} passes head_sha to the reusable workflow`, () => {
        assert.match(template, /head_sha: \$\{\{ inputs\.head_sha/);
    });

    test(`${label} renders every registered kind into the matrix`, () => {
        const both = renderWorkflow(template, "main", "both");
        assert.ok(both.includes(`fromJSON('["context","code"]')`));
        assert.match(both, /kind: \$\{\{ matrix\.kind \}\}/);
        assert.ok(!both.includes("__KINDS_JSON__"));
        assert.ok(renderWorkflow(template, "main", "code").includes(`fromJSON('["code"]')`));
    });
}
