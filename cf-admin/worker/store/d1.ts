// Real adapter: D1 for rows, R2 for reports, sessions and patches.
import { finding, promptNote, promptVersion, provider, repo, ruleSummary, run, severitySummary } from "./rows.ts";
import type { Row } from "./rows.ts";
import type {
    BlobStore,
    FeedbackInput,
    FindingRow,
    FindingStatus,
    PromptRole,
    PromptVersion,
    ProviderRow,
    RepoPatch,
    RoundInput,
    RuleAggregate,
    RuleFilter,
    RunRow,
    Store,
    Suppression,
} from "./port.ts";

const REPO_COLUMNS: Record<keyof RepoPatch, string> = {
    enabled: "enabled",
    mode: "mode",
    provider: "provider",
    finderModel: "finder_model",
    verifierModel: "verifier_model",
    budgetUsd: "budget_usd",
};

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
        return row ? provider(row) : null;
    }

    async listProviders() {
        return (await this.all("SELECT * FROM providers ORDER BY name")).map(provider);
    }

    async upsertProvider(row: ProviderRow) {
        const sql = `INSERT INTO providers (name, api_url, api, key_secret, context_window, max_tokens,
            price_input, price_output, price_cache_read, price_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET api_url = excluded.api_url, api = excluded.api, key_secret = excluded.key_secret,
            context_window = excluded.context_window, max_tokens = excluded.max_tokens,
            price_input = excluded.price_input, price_output = excluded.price_output,
            price_cache_read = excluded.price_cache_read, price_cache_write = excluded.price_cache_write`;
        await this.db
            .prepare(sql)
            .bind(
                row.name,
                row.apiUrl,
                row.api,
                row.keySecret,
                row.contextWindow,
                row.maxTokens,
                row.priceInput,
                row.priceOutput,
                row.priceCacheRead,
                row.priceCacheWrite,
            )
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
        const ruleSql = `INSERT INTO rule_results (finding_id, run_id, rule_id, severity, file, line, status, waived)
            VALUES (?, ?, ?, ?, ?, ?, 'open', 0)`;
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
            ...findings.map((f) => this.db.prepare(ruleSql).bind(f.id, f.runId, f.ruleId, f.severity, f.path, f.line)),
        ]);
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
        // Settlement and claim are one statement: a claim is only ever visible with its allowance already
        // recorded, so two interleaved /init calls cannot both read the same remainder and both be granted
        // it. Numbered parameters (?1...) let one bind set drive the whole expression.
        //
        // Taking over a claim settles it first. A run that opened a model session is charged its allowance,
        // the only safe bound on a cost that will never be reported; a run cancelled before its first
        // session is charged nothing, so rapid pushes on one branch do not each burn the month. A claim from
        // an earlier month settles into its own month and never reduces this month's budget.
        const settle = `CASE WHEN claim_started = 1 AND claim_month = ?1 THEN claim_usd ELSE 0 END`;
        // Settlements from earlier months are pruned here: a run that reports late is charged in the month
        // it reports, so keeping its old entry would only grow the row without ever matching again.
        const kept = `COALESCE((SELECT json_group_array(value) FROM json_each(settled_claims)
            WHERE json_extract(value, '$.m') = ?1), '[]')`;
        const settled = `CASE WHEN claim_started = 1 AND claim_month = ?1 AND claim_usd > 0
            THEN json_insert((${kept}), '$[#]', json_object('c', budget_claim, 'u', claim_usd, 'm', claim_month))
            ELSE (${kept}) END`;
        const sql = `UPDATE repos SET
            spent_usd = CASE WHEN budget_month = ?1 THEN spent_usd + (${settle}) ELSE (${settle}) END,
            budget_month = ?1,
            budget_claim = ?2, claim_group = ?3, claim_expires_at = ?4,
            claim_usd = MAX(0, MIN(?5, budget_usd - (CASE WHEN budget_month = ?1 THEN spent_usd + (${settle}) ELSE (${settle}) END))),
            claim_month = ?1, claim_started = 0, settled_claims = (${settled}),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?6 AND (claim_expires_at = '' OR claim_expires_at < ?7 OR (?3 != '' AND claim_group = ?3))
            RETURNING claim_usd AS allowance`;
        const row = await this.db
            .prepare(sql)
            .bind(month, claim, group, expiresAt, allowanceUsd, repoId, now)
            .first<{ allowance: number }>();
        return row ? ({ claimed: true, remainingUsd: row.allowance } as const) : ({ claimed: false } as const);
    }

    /**
     * Marks the claim's run as having opened a model session, so a later takeover settles its allowance.
     * Returns false when the claim is no longer current: the run was superseded and must not spend.
     */
    async startSpend(repoId: number, claim: string) {
        const sql = `UPDATE repos SET claim_started = 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND budget_claim = ?`;
        const result = await this.db.prepare(sql).bind(repoId, claim).run();
        return result.meta.changes > 0;
    }

    async releaseBudget(repoId: number, claim: string) {
        // Only the holder may release: a run that was refused the budget must not free someone else's.
        const sql = `UPDATE repos SET budget_claim = '', claim_group = '', claim_usd = 0, claim_month = '',
            claim_started = 0, claim_expires_at = '',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND budget_claim = ?`;
        await this.db.prepare(sql).bind(repoId, claim).run();
    }

    async charge(repoId: number, costUsd: number, month: string, claim: string) {
        // A takeover already charged this claim its allowance on the assumption it would never report. If
        // it reports after all, the real cost replaces that allowance instead of being added on top, so the
        // month is not charged twice for one run.
        const settled = `COALESCE((SELECT json_extract(value, '$.u') FROM json_each(settled_claims)
            WHERE json_extract(value, '$.c') = ?3 AND json_extract(value, '$.m') = ?1), 0)`;
        const drop = `COALESCE((SELECT json_group_array(value) FROM json_each(settled_claims)
            WHERE json_extract(value, '$.c') != ?3 AND json_extract(value, '$.m') = ?1), '[]')`;
        const sql = `UPDATE repos SET
            spent_usd = CASE WHEN budget_month = ?1 THEN spent_usd + ?2 - (${settled}) ELSE ?2 END,
            budget_month = ?1, settled_claims = (${drop}),
            budget_claim = CASE WHEN budget_claim = ?3 THEN '' ELSE budget_claim END,
            claim_group = CASE WHEN budget_claim = ?3 THEN '' ELSE claim_group END,
            claim_usd = CASE WHEN budget_claim = ?3 THEN 0 ELSE claim_usd END,
            claim_month = CASE WHEN budget_claim = ?3 THEN '' ELSE claim_month END,
            claim_started = CASE WHEN budget_claim = ?3 THEN 0 ELSE claim_started END,
            claim_expires_at = CASE WHEN budget_claim = ?3 THEN '' ELSE claim_expires_at END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?4`;
        await this.db.prepare(sql).bind(month, costUsd, claim, repoId).run();
    }

    async setLastSha(repoId: number, sha: string) {
        const sql = "UPDATE repos SET last_sha = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?";
        await this.db.prepare(sql).bind(sha, repoId).run();
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
                .prepare(
                    `UPDATE rule_results SET status = ?1, waived = CASE WHEN ?1 = 'rejected' THEN 1 ELSE waived END
                WHERE finding_id IN (SELECT id FROM findings
                    WHERE repo_id = ?2 AND fingerprint = ?3 AND status = ?1)`,
                )
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
                this.db
                    .prepare("INSERT INTO prompt_notes (repo_id, fingerprint, reason) VALUES (?, ?, ?)")
                    .bind(input.repoId, input.fingerprint, input.reason),
            );
        }
        const [update] = await this.db.batch(statements);
        return update.meta.changes;
    }

    async resolveRound(input: RoundInput) {
        // json_each of an empty array matches nothing, so NOT IN that set keeps every missing fingerprint.
        const sql = `UPDATE findings SET status = 'resolved', resolved_by_run = ?1
            WHERE status = 'open' AND repo_id = ?2 AND run_id != ?4
            AND run_id IN (SELECT id FROM runs WHERE repo_id = ?2 AND pr_number = ?3)
            AND fingerprint NOT IN (SELECT value FROM json_each(?5))
            AND (?6 = 1 OR rule_id != 'CX-AI')`;
        const rules = this.db
            .prepare(
                `UPDATE rule_results SET status = 'resolved'
            WHERE finding_id IN (SELECT id FROM findings WHERE resolved_by_run = ?1)`,
            )
            .bind(input.runId);
        const [result] = await this.db.batch([
            this.db
                .prepare(sql)
                .bind(
                    input.runId,
                    input.repoId,
                    input.prNumber,
                    input.runId,
                    JSON.stringify(input.seen),
                    input.aiRechecked ? 1 : 0,
                ),
            rules,
        ]);
        return result.meta.changes;
    }

    async ruleStats(filter: RuleFilter, limit: number): Promise<RuleAggregate> {
        const from = "FROM rule_results JOIN runs ON runs.id = rule_results.run_id";
        const where: string[] = [];
        const args: unknown[] = [];
        if (filter.repoId !== undefined) {
            where.push("runs.repo_id = ?");
            args.push(filter.repoId);
        }
        if (filter.severity) {
            where.push("rule_results.severity = ?");
            args.push(filter.severity);
        }
        const clause = where.length ? " WHERE " + where.join(" AND ") : "";
        const byRuleSql = `SELECT rule_results.rule_id AS rule_id, COUNT(*) AS total,
            SUM(CASE WHEN rule_results.severity = 'error' THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN rule_results.severity = 'warning' THEN 1 ELSE 0 END) AS warnings,
            SUM(CASE WHEN rule_results.status = 'open' THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN rule_results.waived = 1 THEN 1 ELSE 0 END) AS waived,
            COUNT(DISTINCT rule_results.run_id) AS runs,
            COUNT(DISTINCT runs.repo_id || '/' || rule_results.file) AS files
            ${from}${clause} GROUP BY rule_results.rule_id ORDER BY total DESC, rule_results.rule_id LIMIT ?`;
        const bySeveritySql = `SELECT rule_results.severity AS severity, COUNT(*) AS total,
            COUNT(DISTINCT rule_results.rule_id) AS rules,
            SUM(CASE WHEN rule_results.waived = 1 THEN 1 ELSE 0 END) AS waived
            ${from}${clause} GROUP BY rule_results.severity ORDER BY rule_results.severity`;
        const [rules, severities] = await Promise.all([
            this.all(byRuleSql, ...args, limit),
            this.all(bySeveritySql, ...args),
        ]);
        const byRule = rules.map(ruleSummary);
        const bySeverity = severities.map(severitySummary);
        return {
            total: bySeverity.reduce((sum, row) => sum + row.total, 0),
            waived: bySeverity.reduce((sum, row) => sum + row.waived, 0),
            byRule,
            bySeverity,
            topRule: byRule[0]?.ruleId ?? null,
        };
    }

    async findingsByStatus(status: FindingStatus, limit: number) {
        const sql = `SELECT findings.*, repos.name AS repo FROM findings JOIN repos ON repos.id = findings.repo_id
            WHERE findings.status = ? ORDER BY findings.rowid DESC LIMIT ?`;
        return (await this.all(sql, status, limit)).map(finding);
    }

    async activePrompts() {
        const rows = await this.all("SELECT * FROM prompt_versions WHERE active = 1 ORDER BY role");
        return rows.map(promptVersion);
    }

    async listPromptVersions() {
        return (await this.all("SELECT * FROM prompt_versions ORDER BY role, version DESC")).map(promptVersion);
    }

    async listPromptNotes(limit: number) {
        return (await this.all("SELECT * FROM prompt_notes ORDER BY id DESC LIMIT ?", limit)).map(promptNote);
    }

    async publishPrompt(role: PromptRole, body: string, note: string): Promise<PromptVersion> {
        const current = await this.one(
            "SELECT COALESCE(MAX(version), 0) AS version FROM prompt_versions WHERE role = ?",
            role,
        );
        const version = Number(current?.version ?? 0) + 1;
        await this.db.batch([
            this.db.prepare("UPDATE prompt_versions SET active = 0 WHERE role = ?").bind(role),
            this.db
                .prepare("INSERT INTO prompt_versions (role, version, body, note, active) VALUES (?, ?, ?, ?, 1)")
                .bind(role, version, body, note),
        ]);
        const row = await this.one("SELECT * FROM prompt_versions WHERE role = ? AND version = ?", role, version);
        return promptVersion(row!);
    }

    async foldNotes(ids: number[], versionId: number) {
        if (!ids.length) {
            return;
        }
        const marks = ids.map(() => "?").join(", ");
        await this.db
            .prepare(`UPDATE prompt_notes SET folded_into = ? WHERE folded_into IS NULL AND id IN (${marks})`)
            .bind(versionId, ...ids)
            .run();
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

    async delete(keys: string[]) {
        if (keys.length) {
            await this.bucket.delete(keys);
        }
    }
}
