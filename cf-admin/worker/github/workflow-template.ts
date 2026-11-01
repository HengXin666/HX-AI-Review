// Caller workflow written into a repository by POST /api/github/enable.
// The source of truth is templates/hx-context-review.workflow.yml in the tool repository (owned by another task).
// A Worker cannot read the checkout, so githubDeps fetches that file from WORKFLOW_TEMPLATE_URL at run time and
// falls back to DEFAULT_WORKFLOW_TEMPLATE below when it is missing or unreachable.
//
// Placeholders, replaced by renderWorkflow when present (a template without them is used as is):
//   __DEFAULT_BRANCH__  the repository default branch (push trigger filter)
//   __KINDS_JSON__      JSON array of kinds for push / pull_request runs: ["context"], ["code"] or ["context","code"]

export const WORKFLOW_TEMPLATE_URL =
    "https://raw.githubusercontent.com/HengXin666/HX-AI-Review/v1/templates/hx-context-review.workflow.yml";

/**
 * Same contract as .github/workflows/review.yml (workflow_call, secret HX_CTX_TOKEN, input kind), plus head_sha:
 * workflow_dispatch from the GitHub App webhook sends inputs {head_sha, kind} (routes/webhook.ts), and head_sha is
 * passed down so the reusable workflow can check out the reviewed commit instead of the default-branch head.
 * kind runs as a one-entry matrix on dispatch and as the repository's registered kinds on push / pull_request.
 */
export const DEFAULT_WORKFLOW_TEMPLATE = `# Written by hx-context-review (one-click enable). Safe to edit; enabling again overwrites it.
name: hx-context-review
on:
    push:
        branches: [__DEFAULT_BRANCH__]
    pull_request:
        types: [opened, synchronize, reopened, ready_for_review]
    workflow_dispatch:
        inputs:
            head_sha:
                description: Commit to review (sent by the hx-context-review GitHub App)
                type: string
                required: false
                default: ""
            kind:
                description: Which review to run
                type: choice
                options: [context, code]
                default: context

permissions:
    contents: write
    pull-requests: write

jobs:
    review:
        strategy:
            fail-fast: false
            matrix:
                kind: \${{ github.event_name == 'workflow_dispatch' && fromJSON(format('["{0}"]', inputs.kind)) || fromJSON('__KINDS_JSON__') }}
        uses: HengXin666/HX-AI-Review/.github/workflows/review.yml@v1
        with:
            kind: \${{ matrix.kind }}
            head_sha: \${{ inputs.head_sha || '' }}
        secrets:
            HX_CTX_TOKEN: \${{ secrets.HX_CTX_TOKEN }}
`;

export type RepoKindChoice = "context" | "code" | "both";

export function renderWorkflow(template: string, defaultBranch: string, kind: RepoKindChoice): string {
    const kinds = kind === "both" ? ["context", "code"] : [kind];
    return template.replaceAll("__DEFAULT_BRANCH__", defaultBranch).replaceAll("__KINDS_JSON__", JSON.stringify(kinds));
}
