// Real adapter: D1 for rows, R2 for reports, sessions and patches.
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
} from "./port.ts";

type Row = Record<string, unknown>;

const REPO_COLUMNS: Record<keyof RepoPatch, string> = {
    enabled: "enabled",
    mode: "mode",
    provider: "provider",
    finderModel: "finder_model",
    verifierModel: "verifier_model",
    budgetUsd: "budget_usd",
};

function repo(row: Row): RepoRow {
    return {
        id: Number(row.id),
        name: String(row.name),
        enabled: Number(row.enabled) === 1,
        mode: row.mode === "l0" ? "l0" : "full",
        provider: String(row.provider),
        finderModel: String(row.finder_model),
        verifierModel: String(row.verifier_model),
        budgetUsd: Number(row.budget_usd),
        spentUsd: Number(row.spent_usd),
        budgetMonth: String(row.budget_month),
        lastSha: row.last_sha === null ? null : String(row.last_sha),
    };
}

function run(row: Row): RunRow & { repo: string } {
    return {
        id: String(row.id),
        repoId: Number(row.repo_id),
        repo: String(row.repo ?? ""),
        sha: String(row.sha),
        baseSha: String(row.base_sha),
        event: String(row.event),
        prNumber: row.pr_number === null ? null : Number(row.pr_number),
        status: String(row.status),
        l0Only: Number(row.l0_only) === 1,
        errors: Number(row.errors),
        warnings: Number(row.warnings),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        costUsd: Number(row.cost_usd),
        durationMs: Number(row.duration_ms),
        patchBranch: row.patch_branch === null ? null : String(row.patch_branch),
        createdAt: String(row.created_at),
    };
}

function finding(row: Row): FindingRow & { repo: string } {
    return {
        id: String(row.id),
        runId: String(row.run_id),
        repoId: Number(row.repo_id),
        repo: String(row.repo ?? ""),
        fingerprint: String(row.fingerprint),
        ruleId: String(row.rule_id),
        severity: String(row.severity),
        path: String(row.path),
        line: Number(row.line),
        message: String(row.message),
        evidence: String(row.evidence),
        patchKey: row.patch_key === null ? null : String(row.patch_key),
        status: row.status === "accepted" || row.status === "rejected" ? row.status : "open",
    };
}

export class D1Store implements Store {
    private readonly db: D1Database;

    constructor(db: D1Database) {
        this.db = db;
    }

    private async one(sql: string, ...args: unknown[]): Promise<Row | null> {
        return this.db
            .prepare(sql)
            .bind(...args)
            .first<Row>();
    }

    private async all(sql: string, ...args: unknown[]): Promise<Row[]> {
        return (
            await this.db
                .prepare(sql)
                .bind(...args)
                .all<Row>()
        ).results;
    }

    async repoByTokenHash(hash: string) {
        const row = await this.one("SELECT * FROM repos WHERE token_hash = ?", hash);
        return row ? repo(row) : null;
    }

    async repoByName(name: string) {
        const row = await this.one("SELECT * FROM repos WHERE name = ?", name);
        return row ? repo(row) : null;
    }

    async listRepos() {
        return (await this.all("SELECT * FROM repos ORDER BY name")).map(repo);
    }

    async createRepo(name: string, tokenHash: string, patch: RepoPatch) {
        await this.db.prepare("INSERT INTO repos (name, token_hash) VALUES (?, ?)").bind(name, tokenHash).run();
        return (await this.updateRepo(name, patch))!;
    }

    async updateRepo(name: string, patch: RepoPatch) {
        const entries = Object.entries(patch).filter(([key, value]) => key in REPO_COLUMNS && value !== undefined);
        if (entries.length) {
            const sets = entries.map(([key]) => `${REPO_COLUMNS[key as keyof RepoPatch]} = ?`).join(", ");
            const values = entries.map(([, value]) => (typeof value === "boolean" ? Number(value) : value));
            const sql = `UPDATE repos SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?`;
            await this.db
                .prepare(sql)
                .bind(...values, name)
                .run();
        }
        return this.repoByName(name);
    }

    async setTokenHash(name: string, tokenHash: string) {
        const result = await this.db
            .prepare("UPDATE repos SET token_hash = ? WHERE name = ?")
            .bind(tokenHash, name)
            .run();
        return result.meta.changes > 0;
    }

    async provider(name: string) {
        const row = await this.one("SELECT * FROM providers WHERE name = ?", name);
        if (!row) {
            return null;
        }
        return {
            name: String(row.name),
            apiUrl: String(row.api_url),
            api: row.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
            keySecret: String(row.key_secret),
            contextWindow: Number(row.context_window),
            maxTokens: Number(row.max_tokens),
        } satisfies ProviderRow;
    }

    async upsertProvider(row: ProviderRow) {
        const sql = `INSERT INTO providers (name, api_url, api, key_secret, context_window, max_tokens) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET api_url = excluded.api_url, api = excluded.api, key_secret = excluded.key_secret,
            context_window = excluded.context_window, max_tokens = excluded.max_tokens`;
        await this.db
            .prepare(sql)
            .bind(row.name, row.apiUrl, row.api, row.keySecret, row.contextWindow, row.maxTokens)
            .run();
    }

    async suppressions(repoId: number): Promise<Suppression[]> {
        const rows = await this.all(
            "SELECT fingerprint, reason FROM suppressions WHERE repo_id = ? ORDER BY created_at",
            repoId,
        );
        return rows.map((row) => ({ fingerprint: String(row.fingerprint), reason: String(row.reason) }));
    }

    async insertRun(r: RunRow, findings: FindingRow[]) {
        const runSql = `INSERT INTO runs (id, repo_id, sha, base_sha, event, pr_number, status, l0_only, errors, warnings,
            input_tokens, output_tokens, cost_usd, duration_ms, patch_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const findingSql = `INSERT INTO findings (id, run_id, repo_id, fingerprint, rule_id, severity, path, line, message, evidence,
            patch_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`;
        await this.db.batch([
            this.db
                .prepare(runSql)
                .bind(
                    r.id,
                    r.repoId,
                    r.sha,
                    r.baseSha,
                    r.event,
                    r.prNumber,
                    r.status,
                    Number(r.l0Only),
                    r.errors,
                    r.warnings,
                    r.inputTokens,
                    r.outputTokens,
                    r.costUsd,
                    r.durationMs,
                    r.patchBranch,
                    r.createdAt,
                ),
            ...findings.map((f) =>
                this.db
                    .prepare(findingSql)
                    .bind(
                        f.id,
                        f.runId,
                        f.repoId,
                        f.fingerprint,
                        f.ruleId,
                        f.severity,
                        f.path,
                        f.line,
                        f.message,
                        f.evidence,
                        f.patchKey,
                    ),
            ),
        ]);
    }

    async advance(repoId: number, sha: string, costUsd: number, month: string) {
        const sql = `UPDATE repos SET last_sha = ?,
            spent_usd = CASE WHEN budget_month = ? THEN spent_usd + ? ELSE ? END, budget_month = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`;
        await this.db.prepare(sql).bind(sha, month, costUsd, costUsd, month, repoId).run();
    }

    async recentRuns(limit: number) {
        const sql =
            "SELECT runs.*, repos.name AS repo FROM runs JOIN repos ON repos.id = runs.repo_id ORDER BY runs.created_at DESC LIMIT ?";
        return (await this.all(sql, limit)).map(run);
    }

    async openFindings(limit: number) {
        const sql = `SELECT findings.*, repos.name AS repo FROM findings JOIN repos ON repos.id = findings.repo_id
            WHERE findings.status = 'open' ORDER BY findings.rowid DESC LIMIT ?`;
        return (await this.all(sql, limit)).map(finding);
    }

    async finding(id: string) {
        const row = await this.one("SELECT * FROM findings WHERE id = ?", id);
        return row ? finding(row) : null;
    }

    async feedback(input: FeedbackInput) {
        const statements = [
            this.db
                .prepare("UPDATE findings SET status = ? WHERE repo_id = ? AND fingerprint = ? AND status = 'open'")
                .bind(input.verdict, input.repoId, input.fingerprint),
            this.db
                .prepare("INSERT INTO feedback (repo_id, fingerprint, verdict, reason, source) VALUES (?, ?, ?, ?, ?)")
                .bind(input.repoId, input.fingerprint, input.verdict, input.reason, input.source),
        ];
        if (input.verdict === "rejected") {
            statements.push(
                this.db
                    .prepare(
                        `INSERT INTO suppressions (repo_id, fingerprint, reason) VALUES (?, ?, ?)
                ON CONFLICT(repo_id, fingerprint) DO UPDATE SET reason = excluded.reason`,
                    )
                    .bind(input.repoId, input.fingerprint, input.reason),
            );
        }
        const [update] = await this.db.batch(statements);
        return update.meta.changes;
    }
}

export class R2Blobs implements BlobStore {
    private readonly bucket: R2Bucket;

    constructor(bucket: R2Bucket) {
        this.bucket = bucket;
    }

    async put(key: string, body: string, contentType: string) {
        await this.bucket.put(key, body, { httpMetadata: { contentType } });
    }

    async get(key: string) {
        const object = await this.bucket.get(key);
        return object ? object.text() : null;
    }
}
