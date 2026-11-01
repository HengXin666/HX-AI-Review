// What the GitHub module needs from the Worker. The mount point builds it with githubDeps(env, deps).
import type { Deps, Env } from "../http.ts";
import type { Fetch } from "./client.ts";
import { GitHubStore } from "./store.ts";
import { WORKFLOW_TEMPLATE_URL } from "./workflow-template.ts";

async function fetchTemplate(): Promise<string | null> {
    try {
        const response = await fetch(WORKFLOW_TEMPLATE_URL, { headers: { "user-agent": "hx-context-review" } });
        return response.ok ? await response.text() : null;
    } catch {
        return null;
    }
}

export type GitHubDeps = {
    store: GitHubStore;
    secret(name: string): string | undefined;
    fetch: Fetch;
    now(): Date;
    id(): string;
    /**
     * Caller workflow template for one-click enable (templates/hx-context-review.workflow.yml). null or absent means
     * the built-in DEFAULT_WORKFLOW_TEMPLATE is used. A Worker has no file system, so the default reads the file
     * from the tool repository at WORKFLOW_TEMPLATE_URL.
     */
    template?(): Promise<string | null>;
};

export function githubDeps(env: Env, deps: Deps): GitHubDeps {
    return {
        store: new GitHubStore(env.DB),
        secret: deps.secret,
        fetch: (input, init) => fetch(input, init),
        now: deps.now,
        id: deps.id,
        template: fetchTemplate,
    };
}
