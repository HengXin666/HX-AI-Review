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

export type Overview = { month: string; repos: Repo[]; runs: Run[]; findings: Finding[] };

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
    feedback: (id: string, verdict: "accepted" | "rejected", reason: string) =>
        call<{ updated: number }>("POST", `findings/${id}/feedback`, { verdict, reason }),
};

/** One-click merge: open a PR from the runner's patch branch into the default branch. */
export function patchBranchUrl(repo: string, branch: string): string {
    return `https://github.com/${repo}/compare/${encodeURIComponent(branch)}?expand=1`;
}
