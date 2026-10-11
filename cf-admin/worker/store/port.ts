// Storage port. routes/ only see these interfaces; d1.ts is the real D1/R2 adapter, tests use a fake.

export type Mode = "full" | "l0";
export type FindingStatus = "open" | "accepted" | "rejected";
export type Verdict = "accepted" | "rejected";

export type RepoRow = {
    id: number;
    name: string;
    enabled: boolean;
    mode: Mode;
    provider: string;
    finderModel: string;
    verifierModel: string;
    budgetUsd: number;
    spentUsd: number;
    budgetMonth: string;
    lastSha: string | null;
};

export type RepoPatch = Partial<
    Pick<RepoRow, "enabled" | "mode" | "provider" | "finderModel" | "verifierModel" | "budgetUsd">
>;

export type ProviderRow = {
    name: string;
    apiUrl: string;
    api: "openai-completions" | "anthropic-messages";
    /** Name of the Worker secret that holds the key; the key itself never lives in D1. */
    keySecret: string;
    contextWindow: number;
    maxTokens: number;
    /** USD per million input / output tokens. */
    priceInput: number;
    priceOutput: number;
    priceCacheRead: number;
    priceCacheWrite: number;
};

export type RunRow = {
    id: string;
    repoId: number;
    sha: string;
    baseSha: string;
    event: string;
    prNumber: number | null;
    status: string;
    l0Only: boolean;
    errors: number;
    warnings: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    patchBranch: string | null;
    createdAt: string;
};

export type FindingRow = {
    id: string;
    runId: string;
    repoId: number;
    fingerprint: string;
    ruleId: string;
    severity: string;
    path: string;
    line: number;
    message: string;
    evidence: string;
    patchKey: string | null;
    status: FindingStatus;
};

export type Suppression = { fingerprint: string; reason: string };
export type FeedbackInput = { repoId: number; fingerprint: string; verdict: Verdict; reason: string; source: string };

export interface Store {
    repoByTokenHash(hash: string): Promise<RepoRow | null>;
    repoByName(name: string): Promise<RepoRow | null>;
    listRepos(): Promise<RepoRow[]>;
    createRepo(name: string, tokenHash: string, patch: RepoPatch): Promise<RepoRow>;
    updateRepo(name: string, patch: RepoPatch): Promise<RepoRow | null>;
    setTokenHash(name: string, tokenHash: string): Promise<boolean>;
    provider(name: string): Promise<ProviderRow | null>;
    upsertProvider(row: ProviderRow): Promise<void>;
    suppressions(repoId: number): Promise<Suppression[]>;
    insertRun(run: RunRow, findings: FindingRow[]): Promise<void>;
    listProviders(): Promise<ProviderRow[]>;
    /**
     * Atomically claim the repo's run budget until `staleBefore`, so concurrent runs cannot both be
     * handed the same remainder. False means another live claim holds it. Released by charge.
     */
    reserveBudget(repoId: number, now: string, staleBefore: string): Promise<boolean>;
    /** Add to the month's spend and release the run-budget claim; every run is charged, PRs included. */
    charge(repoId: number, costUsd: number, month: string): Promise<void>;
    /** Move the push cursor; only complete push runs call this, so cancelled ranges are re-reviewed. */
    setLastSha(repoId: number, sha: string): Promise<void>;
    recentRuns(limit: number): Promise<(RunRow & { repo: string })[]>;
    openFindings(limit: number): Promise<(FindingRow & { repo: string })[]>;
    finding(id: string): Promise<FindingRow | null>;
    /** Mark every open finding of the repo with this fingerprint; rejected also feeds suppressions. */
    feedback(input: FeedbackInput): Promise<number>;
}

export interface BlobStore {
    put(key: string, body: string, contentType: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(keys: string[]): Promise<void>;
}
