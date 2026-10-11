// Client for the Worker admin API. Same origin: Access sets the identity cookie for both Pages and /api.

export type Repo = {
    name: string;
    enabled: boolean;
    mode: "full" | "l0";
    finderModel: string;
    verifierModel: string;
    budgetUsd: number;
    spentUsd: number;
    lastSha: string | null;
};

export type Run = {
    id: string;
    repo: string;
    sha: string;
    event: string;
    prNumber: number | null;
    status: string;
    errors: number;
    warnings: number;
    costUsd: number;
    durationMs: number;
    patchBranch: string | null;
    createdAt: string;
};

export type Finding = {
    id: string;
    repo: string;
    ruleId: string;
    severity: string;
    path: string;
    line: number;
    message: string;
    patchKey: string | null;
};

export type Provider = {
    name: string;
    apiUrl: string;
    api: "openai-completions" | "anthropic-messages";
    keySecret: string;
    keyPresent: boolean;
    contextWindow: number;
    maxTokens: number;
    priceInput: number;
    priceOutput: number;
};

export type Deployment = { sha?: string; deployedAt?: string; runUrl?: string; accessConfigured: boolean };

export type Overview = {
    month: string;
    deployment: Deployment;
    repos: Repo[];
    runs: Run[];
    findings: Finding[];
    providers: Provider[];
};

export type ProviderInput = Omit<Provider, "name" | "keyPresent">;
export type RepoInput = Pick<Repo, "name" | "finderModel" | "verifierModel" | "budgetUsd"> & { provider: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch("/api/" + path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${method} /api/${path}: ${response.status}`);
    }
    return (await response.json()) as T;
}

export const api = {
    overview: () => call<Overview>("GET", "overview"),
    updateRepo: (name: string, patch: Partial<Repo>) => call<{ repo: Repo }>("PATCH", "repos/" + name, patch),
    createRepo: (input: RepoInput) => call<{ repo: Repo; token: string }>("POST", "repos", input),
    rotateToken: (name: string) => call<{ token: string }>("POST", `repos/${name}/rotate-token`),
    saveProvider: (name: string, input: ProviderInput) =>
        call<{ ok: boolean }>("PUT", "providers/" + encodeURIComponent(name), input),
    feedback: (id: string, verdict: "accepted" | "rejected", reason: string) =>
        call<{ updated: number }>("POST", `findings/${id}/feedback`, { verdict, reason }),
};

/** One-click merge: open a PR from the runner's patch branch into the default branch. */
export function patchBranchUrl(repo: string, branch: string): string {
    return `https://github.com/${repo}/compare/${encodeURIComponent(branch)}?expand=1`;
}

/** The deploy workflow page, derived from the run that deployed this Worker. */
export function deployWorkflowUrl(runUrl?: string): string | undefined {
    const match = runUrl ? /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/actions\/runs\/\d+/.exec(runUrl) : null;
    return match ? match[1] + "/actions/workflows/deploy-cf.yml" : undefined;
}

export function commitUrl(runUrl: string | undefined, sha: string): string | undefined {
    const match = runUrl ? /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\//.exec(runUrl) : null;
    return match ? `${match[1]}/commit/${sha}` : undefined;
}
