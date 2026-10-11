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
    async charge(repoId: number, costUsd: number, month: string) {
        const row = this.repos.find((item) => item.id === repoId)!;
        row.spentUsd = row.budgetMonth === month ? row.spentUsd + costUsd : costUsd;
        row.budgetMonth = month;
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
}
