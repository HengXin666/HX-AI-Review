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
     * Atomically claim the repo's run budget under `claim` for `allowanceUsd`, until `expiresAt`. False
     * means a live claim from a different concurrency group holds it. A claim from the same group may be
     * taken over, because GitHub already cancelled the older run in that group and it will never report.
     *
     * Taking over settles the old claim's allowance into the month's spend first, so repeated cancellations
     * on one branch cannot each start from the full remaining budget. Returns the spend for the month after
     * any settlement, which the caller must use for the new allowance.
     */
    reserveBudget(
        repoId: number,
        claim: string,
        group: string,
        allowanceUsd: number,
        month: string,
        now: string,
        expiresAt: string,
    ): Promise<{ claimed: false } | { claimed: true; remainingUsd: number }>;
    /**
     * Record that the claim's run opened a model session, so a later takeover settles its allowance.
     * False when the claim is no longer current, i.e. a newer run has taken it over.
     */
    startSpend(repoId: number, claim: string): Promise<boolean>;
    /** Release the claim only when `claim` is the one held; another run's claim is left untouched. */
    releaseBudget(repoId: number, claim: string): Promise<void>;
    /** Add to the month's spend; releases the run's own claim, never another run's. Every run is charged. */
    charge(repoId: number, costUsd: number, month: string, claim: string): Promise<void>;
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
