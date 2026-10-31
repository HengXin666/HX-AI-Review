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
    spentUsd: number;
    budgetMonth: string;
    lastSha: string | null;
};

export type RepoPatch = Partial<
    Pick<RepoRow, "enabled" | "mode" | "kind" | "provider" | "finderModel" | "verifierModel" | "budgetUsd">
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

export type GithubAppRow = {
    appId: number;
    slug: string;
    name: string;
    ownerLogin: string;
    htmlUrl: string;
    /** PKCS#1 or PKCS#8 PEM. Admin responses never include this. */
    privateKey: string;
    /** Admin responses never include this. */
    webhookSecret: string;
};

export type GithubInstallation = {
    installationId: number;
    accountLogin: string;
    accountType: string;
    repos: string[];
    /** True when the installation covers every repo of the account, not a selected list. */
    allRepos: boolean;
    suspended: boolean;
};

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
     * on one branch cannot each start from the full remaining budget. remainingUsd is the allowance still
     * available after any such settlement, i.e. what the caller may grant this claim, not the amount the
     * month has already spent.
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
    /** Rule and severity totals over recorded rule results, most frequent rule first. */
    ruleStats(filter: RuleFilter, limit: number): Promise<RuleAggregate>;
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
    githubApp(): Promise<GithubAppRow | null>;
    saveGithubApp(row: GithubAppRow): Promise<void>;
    listInstallations(): Promise<GithubInstallation[]>;
    saveInstallation(row: GithubInstallation): Promise<void>;
    deleteInstallation(installationId: number): Promise<void>;
    /** Remember a manifest state until GitHub redirects back. */
    putSetupState(state: string, expiresAt: string): Promise<void>;
    /** Consume a state that has not expired. False when it is unknown or stale. */
    takeSetupState(state: string, now: string): Promise<boolean>;
}

export interface BlobStore {
    put(key: string, body: string, contentType: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(keys: string[]): Promise<void>;
}
