// In-memory Store/BlobStore with the same semantics as the D1/R2 adapter, for route tests.
import type {
    BlobStore,
    FeedbackInput,
    FindingRow,
    ProviderRow,
    RepoPatch,
    RepoRow,
    RunRow,
    Store,
    Suppression,
} from "../worker/store/port.ts";

export class FakeStore implements Store {
    repos: (RepoRow & { tokenHash: string })[] = [];
    providers = new Map<string, ProviderRow>();
    runs: RunRow[] = [];
    findings: FindingRow[] = [];
    supp = new Map<string, Suppression>();
    feedbackLog: FeedbackInput[] = [];
    /** Live budget claim per repo id (see reserveBudget); usd is the allowance, started whether it spent. */
    claims = new Map<
        number,
        { claim: string; group: string; usd: number; month: string; started: boolean; expiresAt: string }
    >();

    private strip(row?: RepoRow & { tokenHash: string }): RepoRow | null {
        if (!row) {
            return null;
        }
        const { tokenHash: _hash, ...repo } = row;
        return repo;
    }

    async repoByTokenHash(hash: string) {
        return this.strip(this.repos.find((item) => item.tokenHash === hash));
    }
    async repoByName(name: string) {
        return this.strip(this.repos.find((item) => item.name.toLowerCase() === name.toLowerCase()));
    }
    async listRepos() {
        return this.repos.map((item) => this.strip(item)!);
    }
    async createRepo(name: string, tokenHash: string, patch: RepoPatch) {
        this.repos.push({
            id: this.repos.length + 1,
            name,
            tokenHash,
            enabled: true,
            mode: "full",
            provider: "default",
            finderModel: "",
            verifierModel: "",
            budgetUsd: 0,
            spentUsd: 0,
            budgetMonth: "",
            lastSha: null,
        });
        return (await this.updateRepo(name, patch))!;
    }
    async updateRepo(name: string, patch: RepoPatch) {
        const row = this.repos.find((item) => item.name === name);
        if (row) {
            Object.assign(row, patch);
        }
        return this.strip(row);
    }
    async setTokenHash(name: string, tokenHash: string) {
        const row = this.repos.find((item) => item.name === name);
        if (row) {
            row.tokenHash = tokenHash;
        }
        return Boolean(row);
    }
    async provider(name: string) {
        return this.providers.get(name) ?? null;
    }
    async upsertProvider(row: ProviderRow) {
        this.providers.set(row.name, row);
    }
    async suppressions(repoId: number) {
        return [...this.supp.entries()].filter(([key]) => key.startsWith(repoId + ":")).map(([, value]) => value);
    }
    async insertRun(run: RunRow, findings: FindingRow[]) {
        this.runs.push(run);
        this.findings.push(...findings);
    }
    async listProviders() {
        return [...this.providers.values()];
    }
    async reserveBudget(
        repoId: number,
        claim: string,
        group: string,
        allowanceUsd: number,
        month: string,
        now: string,
        expiresAt: string,
    ) {
        // Mirrors the conditional UPDATE: claim only when the slot is free, expired, or held by the same
        // concurrency group (whose older run GitHub already cancelled).
        // An empty group means "unknown" and never matches: only a real, equal group may take over.
        const held = this.claims.get(repoId);
        const sameGroup = group !== "" && held?.group === group;
        if (held && held.expiresAt >= now && !sameGroup) {
            return { claimed: false } as const;
        }
        const row = this.repos.find((item) => item.id === repoId)!;
        // Taking over settles the old claim first: a run that opened a model session is charged its
        // allowance (its real cost will never be reported), one cancelled earlier is charged nothing.
        // A claim from an earlier month settles into that month and never reduces this month's budget.
        if (held?.started && held.month === month) {
            row.spentUsd = row.budgetMonth === month ? row.spentUsd + held.usd : held.usd;
            row.budgetMonth = month;
        }
        if (row.budgetMonth !== month) {
            row.spentUsd = 0;
            row.budgetMonth = month;
        }
        const remaining = Math.max(0, Math.min(allowanceUsd, row.budgetUsd - row.spentUsd));
        this.claims.set(repoId, { claim, group, usd: remaining, month, started: false, expiresAt });
        return { claimed: true, remainingUsd: remaining } as const;
    }
    async startSpend(repoId: number, claim: string) {
        const held = this.claims.get(repoId);
        if (held?.claim === claim) {
            held.started = true;
        }
    }
    async releaseBudget(repoId: number, claim: string) {
        if (this.claims.get(repoId)?.claim === claim) {
            this.claims.delete(repoId);
        }
    }
    async charge(repoId: number, costUsd: number, month: string, claim: string) {
        const row = this.repos.find((item) => item.id === repoId)!;
        row.spentUsd = row.budgetMonth === month ? row.spentUsd + costUsd : costUsd;
        row.budgetMonth = month;
        // Only the holder releases; a refused run publishing L0 results must not free someone else's claim.
        if (this.claims.get(repoId)?.claim === claim) {
            this.claims.delete(repoId);
        }
    }
    async setLastSha(repoId: number, sha: string) {
        this.repos.find((item) => item.id === repoId)!.lastSha = sha;
    }
    async recentRuns(limit: number) {
        return this.runs
            .slice(-limit)
            .reverse()
            .map((run) => ({ ...run, repo: this.repos[run.repoId - 1].name }));
    }
    async openFindings(limit: number) {
        return this.findings
            .filter((item) => item.status === "open")
            .slice(-limit)
            .map((item) => ({ ...item, repo: this.repos[item.repoId - 1].name }));
    }
    async finding(id: string) {
        return this.findings.find((item) => item.id === id) ?? null;
    }
    async feedback(input: FeedbackInput) {
        this.feedbackLog.push(input);
        const hits = this.findings.filter(
            (item) => item.repoId === input.repoId && item.fingerprint === input.fingerprint && item.status === "open",
        );
        hits.forEach((item) => (item.status = input.verdict));
        if (input.verdict === "rejected") {
            this.supp.set(`${input.repoId}:${input.fingerprint}`, {
                fingerprint: input.fingerprint,
                reason: input.reason,
            });
        }
        return hits.length;
    }
}

export class FakeBlobs implements BlobStore {
    data = new Map<string, string>();
    async put(key: string, body: string) {
        this.data.set(key, body);
    }
    async get(key: string) {
        return this.data.get(key) ?? null;
    }
    async delete(keys: string[]) {
        for (const key of keys) {
            this.data.delete(key);
        }
    }
}
