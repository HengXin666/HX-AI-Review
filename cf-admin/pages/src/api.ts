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
    status?: string;
    fingerprint?: string;
};

export type RuleSummary = {
    ruleId: string;
    total: number;
    errors: number;
    warnings: number;
    open: number;
    waived: number;
    runs: number;
    files: number;
};

export type SeveritySummary = { severity: "error" | "warning"; total: number; rules: number; waived: number };

export type RuleStats = {
    repo: string | null;
    severity: "error" | "warning" | null;
    limit: number;
    total: number;
    waived: number;
    byRule: RuleSummary[];
    bySeverity: SeveritySummary[];
    topRule: string | null;
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
    priceCacheRead: number;
    priceCacheWrite: number;
};

export type Deployment = {
    sha?: string;
    deployedAt?: string;
    runUrl?: string;
    accessConfigured: boolean;
    passwordLogin?: boolean;
};

export type PromptVersion = {
    id: number;
    role: "finder" | "verifier";
    version: number;
    body: string;
    note: string;
    active: boolean;
};

export type PromptNote = {
    id: number;
    fingerprint: string;
    reason: string;
    foldedInto: number | null;
};

export type Overview = {
    month: string;
    deployment: Deployment;
    repos: Repo[];
    runs: Run[];
    findings: Finding[];
    resolved?: Finding[];
    prompts?: PromptVersion[];
    notes?: PromptNote[];
    providers: Provider[];
};

export type ProviderInput = Omit<Provider, "name" | "keyPresent">;
export type RepoInput = Pick<Repo, "name" | "finderModel" | "verifierModel" | "budgetUsd"> & { provider: string };

export class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch("/api/" + path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new ApiError(response.status, `${method} /api/${path}: ${response.status}`);
    }
    return (await response.json()) as T;
}

export const api = {
    overview: () => call<Overview>("GET", "overview"),
    rules: () => call<RuleStats>("GET", "rules"),
    updateRepo: (name: string, patch: Partial<Repo>) => call<{ repo: Repo }>("PATCH", "repos/" + name, patch),
    createRepo: (input: RepoInput) => call<{ repo: Repo; token: string }>("POST", "repos", input),
    rotateToken: (name: string) => call<{ token: string }>("POST", `repos/${name}/rotate-token`),
    saveProvider: (name: string, input: Partial<ProviderInput>) =>
        call<{ ok: boolean }>("PUT", "providers/" + encodeURIComponent(name), input),
    feedback: (id: string, verdict: "accepted" | "rejected", reason: string) =>
        call<{ updated: number }>("POST", `findings/${id}/feedback`, { verdict, reason }),
    login: (user: string, password: string) => call<{ ok: boolean }>("POST", "session", { user, password }),
    logout: () => call<{ ok: boolean }>("DELETE", "session"),
    publishPrompt: (role: "finder" | "verifier", body: string, note: string) =>
        call<{ version: PromptVersion }>("POST", "prompts", { role, body, note }),
    foldNotes: (role: "finder" | "verifier") =>
        call<{ version: PromptVersion; folded: number }>("POST", "prompts/fold", { role }),
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
