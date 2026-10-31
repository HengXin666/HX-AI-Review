// Client for the Worker admin API. Same origin: Access sets the identity cookie for both Pages and /api.

/** Which review a run performs: context (are the context files still true?) or code (is the diff sound?). */
export type Kind = "context" | "code";
/** A repo may serve one review or both; a single run is always exactly one kind. */
export type RepoKind = Kind | "both";

/**
 * Rows written before the kind column existed are context runs, and an unknown value must not widen
 * the meaning. The Worker already normalizes this, but the page may talk to an older deployment.
 */
export function kindOf(value: unknown): Kind {
    return value === "code" ? "code" : "context";
}

export function repoKindOf(value: unknown): RepoKind {
    return value === "code" || value === "both" ? value : "context";
}

export type Repo = {
    name: string;
    enabled: boolean;
    mode: "full" | "l0";
    kind?: RepoKind;
    finderModel: string;
    verifierModel: string;
    budgetUsd: number;
    spentUsd: number;
    lastSha: string | null;
};

export type Run = {
    id: string;
    repo: string;
    kind?: Kind;
    sha: string;
    baseSha?: string;
    event: string;
    prNumber: number | null;
    status: string;
    l0Only?: boolean;
    errors: number;
    warnings: number;
    costUsd: number;
    durationMs: number;
    patchBranch: string | null;
    createdAt: string;
};

export type RunReport = {
    kind?: Kind;
    trace?: {
        groups: { id: string; path: string; hunks: number; added: number[]; batch: number; excerpt: string }[];
        checks: {
            path: string;
            line: number;
            title: string;
            verdict: "confirmed" | "rejected";
            reason: string;
            quote?: string;
        }[];
    };
};

export type Finding = {
    id: string;
    repo: string;
    kind?: Kind;
    ruleId: string;
    severity: string;
    path: string;
    line: number;
    message: string;
    evidence?: string;
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
export type RepoInput = Pick<Repo, "name" | "finderModel" | "verifierModel" | "budgetUsd"> & {
    provider: string;
    kind?: RepoKind;
};

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
    runReport: (repo: string, id: string) => call<RunReport>("GET", `runs/${repo}/${id}/report`),
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
