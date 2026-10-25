// In-memory Store/BlobStore with the same semantics as the D1/R2 adapter, for route tests.
import type {
    BlobStore,
    FeedbackInput,
    FindingRow,
    FindingStatus,
    PromptNote,
    PromptRole,
    PromptVersion,
    ProviderRow,
    RepoPatch,
    RepoRow,
    RoundInput,
    RuleAggregate,
    RuleFilter,
    RuleSeverity,
    RuleSummary,
    RunRow,
    Store,
    Suppression,
} from "../worker/store/port.ts";
import { isStale } from "../worker/store/rounds.ts";

export class FakeStore implements Store {
    repos: (RepoRow & { tokenHash: string })[] = [];
    providers = new Map<string, ProviderRow>();
    runs: RunRow[] = [];
    findings: FindingRow[] = [];
    ruleResults: {
        findingId: string;
        runId: string;
        ruleId: string;
        severity: RuleSeverity;
        file: string;
        line: number;
        status: FindingStatus;
        waived: boolean;
    }[] = [];
    supp = new Map<string, Suppression>();
    feedbackLog: FeedbackInput[] = [];
    prompts: PromptVersion[] = [];
    notes: PromptNote[] = [];
    /** Live budget claim per repo id (see reserveBudget); usd is the allowance, started whether it spent. */
    claims = new Map<
        number,
        { claim: string; group: string; usd: number; month: string; started: boolean; expiresAt: string }
    >();
    /** Claims already settled by a takeover, by claim id: their allowance is charged but may be replaced. */
    settled = new Map<string, { usd: number; month: string }>();

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
            kind: "context",
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
        for (const item of findings) {
            this.ruleResults.push({
                findingId: item.id,
                runId: item.runId,
                ruleId: item.ruleId,
                severity: item.severity === "warning" ? "warning" : "error",
                file: item.path,
                line: item.line,
                status: "open",
                waived: false,
            });
        }
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
            // Settled, not spent for certain: a late /runs replaces this allowance with the real cost.
            this.settled.set(held.claim, { usd: held.usd, month: held.month });
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
        if (held?.claim !== claim) {
            return false;
        }
        held.started = true;
        return true;
    }
    async releaseBudget(repoId: number, claim: string) {
        if (this.claims.get(repoId)?.claim === claim) {
            this.claims.delete(repoId);
        }
    }
    async charge(repoId: number, costUsd: number, month: string, claim: string) {
        const row = this.repos.find((item) => item.id === repoId)!;
        // A takeover already charged this claim its allowance; the real cost replaces it rather than
        // being added on top, so one run is never counted twice.
        const prior = this.settled.get(claim);
        const replacement = prior && prior.month === month ? prior.usd : 0;
        row.spentUsd = row.budgetMonth === month ? row.spentUsd + costUsd - replacement : costUsd;
        row.budgetMonth = month;
        this.settled.delete(claim);
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
        for (const hit of hits) {
            for (const row of this.ruleResults) {
                if (row.findingId === hit.id) {
                    row.status = input.verdict;
                    row.waived = input.verdict === "rejected" || row.waived;
                }
            }
        }
        if (input.verdict === "rejected") {
            this.supp.set(`${input.repoId}:${input.fingerprint}`, {
                fingerprint: input.fingerprint,
                reason: input.reason,
            });
            this.notes.push({
                id: this.notes.length + 1,
                repoId: input.repoId,
                fingerprint: input.fingerprint,
                reason: input.reason,
                foldedInto: null,
                createdAt: new Date(0).toISOString(),
            });
        }
        return hits.length;
    }
    async resolveRound(input: RoundInput) {
        let changed = 0;
        for (const item of this.findings) {
            const pr = this.runs.find((run) => run.id === item.runId)?.prNumber ?? null;
            if (!isStale(item, pr, input)) {
                continue;
            }
            item.status = "resolved";
            item.resolvedByRun = input.runId;
            for (const row of this.ruleResults) {
                if (row.findingId === item.id) {
                    row.status = "resolved";
                }
            }
            changed++;
        }
        return changed;
    }
    async ruleStats(filter: RuleFilter, limit: number): Promise<RuleAggregate> {
        const repoOf = new Map(this.runs.map((run) => [run.id, run.repoId]));
        const rows = this.ruleResults.filter(
            (row) =>
                (filter.repoId === undefined || repoOf.get(row.runId) === filter.repoId) &&
                (filter.severity === undefined || row.severity === filter.severity),
        );
        const rules = new Map<string, RuleSummary & { runIds: Set<string>; fileNames: Set<string> }>();
        const severities = new Map<RuleSeverity, { total: number; rules: Set<string>; waived: number }>();
        for (const row of rows) {
            const repoId = repoOf.get(row.runId);
            const rule = rules.get(row.ruleId) ?? {
                ruleId: row.ruleId,
                total: 0,
                errors: 0,
                warnings: 0,
                open: 0,
                waived: 0,
                runs: 0,
                files: 0,
                runIds: new Set<string>(),
                fileNames: new Set<string>(),
            };
            rule.total += 1;
            rule.errors += row.severity === "error" ? 1 : 0;
            rule.warnings += row.severity === "warning" ? 1 : 0;
            rule.open += row.status === "open" ? 1 : 0;
            rule.waived += row.waived ? 1 : 0;
            rule.runIds.add(row.runId);
            rule.fileNames.add(`${repoId}:${row.file}`);
            rule.runs = rule.runIds.size;
            rule.files = rule.fileNames.size;
            rules.set(row.ruleId, rule);
            const group = severities.get(row.severity) ?? { total: 0, rules: new Set<string>(), waived: 0 };
            group.total += 1;
            group.waived += row.waived ? 1 : 0;
            group.rules.add(row.ruleId);
            severities.set(row.severity, group);
        }
        const byRule = [...rules.values()]
            .sort((a, b) => b.total - a.total || a.ruleId.localeCompare(b.ruleId))
            .slice(0, limit)
            .map(({ runIds: _runIds, fileNames: _fileNames, ...rule }) => rule);
        const bySeverity = [...severities.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([severity, group]) => ({
                severity,
                total: group.total,
                rules: group.rules.size,
                waived: group.waived,
            }));
        return {
            total: bySeverity.reduce((sum, row) => sum + row.total, 0),
            waived: bySeverity.reduce((sum, row) => sum + row.waived, 0),
            byRule,
            bySeverity,
            topRule: byRule[0]?.ruleId ?? null,
        };
    }

    async findingsByStatus(status: FindingStatus, limit: number) {
        return this.findings
            .filter((item) => item.status === status)
            .slice(-limit)
            .map((item) => ({ ...item, repo: this.repos[item.repoId - 1]?.name ?? "" }));
    }
    async activePrompts() {
        return this.prompts.filter((item) => item.active);
    }
    async listPromptVersions() {
        return [...this.prompts].reverse();
    }
    async listPromptNotes(limit: number) {
        return this.notes.slice(-limit).reverse();
    }
    async publishPrompt(role: PromptRole, body: string, note: string) {
        for (const item of this.prompts) {
            if (item.role === role) {
                item.active = false;
            }
        }
        const version = this.prompts.filter((item) => item.role === role).length + 1;
        const row: PromptVersion = {
            id: this.prompts.length + 1,
            role,
            version,
            body,
            note,
            active: true,
            createdAt: new Date(0).toISOString(),
        };
        this.prompts.push(row);
        return row;
    }
    async foldNotes(ids: number[], versionId: number) {
        for (const note of this.notes) {
            if (ids.includes(note.id) && note.foldedInto === null) {
                note.foldedInto = versionId;
            }
        }
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
