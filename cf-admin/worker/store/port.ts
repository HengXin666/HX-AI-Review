// Storage port. routes/ only see these interfaces; d1.ts is the real D1/R2 adapter, tests use a fake.

export type Mode = "full" | "l0";
/** Which review a run performs: context (are the context files still true?) or code (is the diff sound?). */
export type Kind = "context" | "code";
/** A repo may serve one review or both; a single run is always exactly one kind. */
export type RepoKind = Kind | "both";
export type FindingStatus = "open" | "accepted" | "rejected" | "resolved";
export type Verdict = "accepted" | "rejected";
export type PromptRole = "finder" | "verifier";

export type RepoRow = {
    id: number;
    name: string;
    enabled: boolean;
    mode: Mode;
    kind: RepoKind;
    provider: string;
    finderModel: string;
    verifierModel: string;
    budgetUsd: number;
    /** Most one run may be granted from the month; 0 means not set (init falls back to a share of budgetUsd). */
    perRunCapUsd: number;
    spentUsd: number;
    budgetMonth: string;
    lastSha: string | null;
};

export type RepoPatch = Partial<
    Pick<
        RepoRow,
        "enabled" | "mode" | "kind" | "provider" | "finderModel" | "verifierModel" | "budgetUsd" | "perRunCapUsd"
    >
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
    kind: Kind;
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
    /** Inherited from the run, so the overview can filter findings by kind without a join. */
    kind: Kind;
    fingerprint: string;
    ruleId: string;
    severity: string;
    path: string;
    line: number;
    message: string;
    evidence: string;
    /**
     * One-line criteria of the rule that produced the finding, as the runner reported it. Empty when the
     * runner predates criteria or the finding came from a source without one (migration 0011).
     */
    criteria?: string;
    patchKey: string | null;
    status: FindingStatus;
    /** Run that marked this finding resolved, when status is resolved. */
    resolvedByRun?: string | null;
};

export type RuleSeverity = "error" | "warning";

/** One (rule, severity) total from the rule dimension table. */
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

export type SeveritySummary = { severity: RuleSeverity; total: number; rules: number; waived: number };

/** Totals cover every matching row; byRule keeps the most frequent rules up to the caller's limit. */
export type RuleAggregate = {
    total: number;
    waived: number;
    byRule: RuleSummary[];
    bySeverity: SeveritySummary[];
    topRule: string | null;
};

export type RuleFilter = { repoId?: number; severity?: RuleSeverity; kind?: Kind };

/** One live run reservation against the month (budget_claims row). */
export type BudgetClaim = { claim: string; group: string; usd: number; started: boolean; expiresAt: string };

export type Suppression = { fingerprint: string; reason: string };
export type FeedbackInput = { repoId: number; fingerprint: string; verdict: Verdict; reason: string; source: string };

export type RoundInput = {
    repoId: number;
    prNumber: number;
    runId: string;
    /**
     * Which review just finished. A round resolves only findings of its own kind: a context run reports
     * the HC and CX fingerprints and says nothing about the diff findings a code run filed, so without
     * this filter every code finding on the pull request is resolved by the next context run.
     */
    kind: Kind;
    /** Fingerprints reported by the run that just finished. Absent ones on this PR can be resolved. */
    seen: string[];
    /** False when the model stage did not run: AI findings stay open because they were not re-checked. */
    aiRechecked: boolean;
};

export type PromptVersion = {
    id: number;
    role: PromptRole;
    version: number;
    body: string;
    note: string;
    active: boolean;
    createdAt: string;
};

export type PromptNote = {
    id: number;
    repoId: number;
    fingerprint: string;
    reason: string;
    foldedInto: number | null;
    createdAt: string;
};

/** Dimension one usage bucket is keyed by. provider is the repo's configured provider, since runs do not store one. */
export type UsageGroup = "day" | "repo" | "provider" | "kind" | "status";

/** Half-open window over runs.created_at, both bounds ISO timestamps in UTC: from <= created_at < to. */
export type UsageRange = { from: string; to: string };

/**
 * Token counts summed over runs. failedRuns counts status failed (blocking L0 errors) and incompleteRuns
 * status incomplete (the model stage did not finish, for example a 402 from the provider); zeroTokenRuns
 * counts runs that reported no input and no output tokens at all, so "4 runs, 0 tokens" can be explained.
 */
export type UsageCounts = {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    failedRuns: number;
    incompleteRuns: number;
    zeroTokenRuns: number;
};

export type UsageBucket = UsageCounts & { key: string };

/** Totals over the whole window plus how many distinct repos ran in it. */
export type UsageTotals = UsageCounts & { repos: number };

export type UsageAggregate = { totals: UsageTotals; buckets: UsageBucket[] };

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
     * Atomically claim up to `perRunCapUsd` of the month for one run under `claim`, until `expiresAt`.
     * Claims are rows of their own (budget_claims), so runs in different concurrency groups hold separate
     * claims at once; the grant is min(cap, budget - spent - other unsettled claims of the month).
     * claimed false means nothing is left to grant.
     *
     * A live claim from the same non-empty group, and any expired claim, is taken over first, because
     * GitHub already cancelled that run and it will never report. Taking over settles the old claim: its
     * allowance (at most one per-run cap, never the month) is charged when it had started spending, and
     * nothing when it was cancelled before its first model session. remainingUsd is this claim's grant.
     */
    reserveBudget(
        repoId: number,
        claim: string,
        group: string,
        perRunCapUsd: number,
        month: string,
        now: string,
        expiresAt: string,
    ): Promise<{ claimed: false } | { claimed: true; remainingUsd: number }>;
    /**
     * Record that the claim's run opened a model session, so a later takeover settles its allowance.
     * False when the claim is no longer current, i.e. a newer run has taken it over.
     */
    startSpend(repoId: number, claim: string): Promise<boolean>;
    /** Release the claim only when `claim` is a live claim of this repo; other runs' claims are untouched. */
    releaseBudget(repoId: number, claim: string): Promise<void>;
    /**
     * Add to the month's spend and free the run's own claim, never another run's. Every run is charged; a
     * claim a takeover already settled has its charged allowance replaced by this real cost.
     */
    charge(repoId: number, costUsd: number, month: string, claim: string): Promise<void>;
    /** Unsettled claims of the repo in `month`: what is reserved but not yet spent. */
    openClaims(repoId: number, month: string): Promise<BudgetClaim[]>;
    /** Move the push cursor; only complete context push runs on the default branch call this. */
    setLastSha(repoId: number, sha: string): Promise<void>;
    recentRuns(limit: number): Promise<(RunRow & { repo: string })[]>;
    openFindings(limit: number): Promise<(FindingRow & { repo: string })[]>;
    finding(id: string): Promise<FindingRow | null>;
    /** Rule and severity totals over recorded rule results, most frequent rule first. */
    ruleStats(filter: RuleFilter, limit: number): Promise<RuleAggregate>;
    /**
     * Token usage of the runs in `range`, summed by SQL: totals over the window and one bucket per value of
     * `group`. day buckets are UTC dates (YYYY-MM-DD), newest first; the other groups are ordered by total
     * tokens, largest first. An empty window is all zeros, never an error.
     */
    usage(range: UsageRange, group: UsageGroup): Promise<UsageAggregate>;
    /** Mark every open finding of the repo with this fingerprint; rejected also feeds suppressions and prompt notes. */
    feedback(input: FeedbackInput): Promise<number>;
    /**
     * Same pull request, later commit: open findings whose fingerprint was not reported again become resolved.
     * Returns how many rows changed.
     */
    resolveRound(input: RoundInput): Promise<number>;
    findingsByStatus(status: FindingStatus, limit: number): Promise<(FindingRow & { repo: string })[]>;
    activePrompts(): Promise<PromptVersion[]>;
    listPromptVersions(): Promise<PromptVersion[]>;
    listPromptNotes(limit: number): Promise<PromptNote[]>;
    publishPrompt(role: PromptRole, body: string, note: string): Promise<PromptVersion>;
    foldNotes(ids: number[], versionId: number): Promise<void>;
}

export interface BlobStore {
    put(key: string, body: string, contentType: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(keys: string[]): Promise<void>;
}
