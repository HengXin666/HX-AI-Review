// D1 queries for the GitHub App tables (migration 0007). Kept here, outside worker/store/, so the Store port
// stays untouched; it uses the same DB binding. Secrets are sealed before they reach a bind parameter.
import { HttpError } from "../http.ts";
import { seal, unseal } from "./crypto.ts";

export type AppStatus = "configured" | "verified" | "invalid";
export type InstallationStatus = "active" | "suspended" | "deleted";
export type QueueStatus = "pending" | "dispatched" | "failed";
export type QueueKind = "context" | "code";
export type QueueEvent = "push" | "pull_request";

/** What the admin API may show: no secret, only whether each one is set. */
export type AppView = {
    appId: string;
    slug: string;
    clientId: string;
    workflowFile: string;
    status: AppStatus;
    hasPrivateKey: boolean;
    hasClientSecret: boolean;
    hasWebhookSecret: boolean;
    createdAt: string;
    updatedAt: string;
    installedAt: string | null;
};

export type AppInput = {
    appId: string;
    slug: string;
    clientId?: string;
    workflowFile?: string;
    /** Omitted on update keeps the stored value. */
    privateKey?: string;
    clientSecret?: string;
    webhookSecret?: string;
};

export type InstallationView = {
    installationId: number;
    account: string;
    accountType: string;
    repositorySelection: string;
    repos: string[];
    status: InstallationStatus;
    updatedAt: string;
};

export type InstallationInput = {
    installationId: number;
    account: string;
    accountType: string;
    repositorySelection: string;
    status: InstallationStatus;
    /** Undefined keeps the stored list. */
    repos?: string[];
};

export type QueueRow = {
    id: string;
    repo: string;
    sha: string;
    kind: QueueKind;
    event: QueueEvent;
    ref: string;
    prNumber: number | null;
    installationId: number | null;
    deliveryId: string | null;
    status: QueueStatus;
    error: string | null;
    createdAt: string;
    updatedAt: string;
};

export type QueueInput = Omit<QueueRow, "status" | "error" | "createdAt" | "updatedAt">;

export type RegisteredRepo = { name: string; enabled: boolean; kind: "context" | "code" | "both" };

type AppRaw = {
    app_id: string;
    slug: string;
    client_id: string;
    workflow_file: string;
    status: AppStatus;
    private_key_enc: string | null;
    client_secret_enc: string | null;
    webhook_secret_enc: string | null;
    created_at: string;
    updated_at: string;
    installed_at: string | null;
};

type InstallationRaw = {
    installation_id: number;
    account: string;
    account_type: string;
    repository_selection: string;
    repos: string;
    status: InstallationStatus;
    updated_at: string;
};

type QueueRaw = {
    id: string;
    repo: string;
    sha: string;
    kind: QueueKind;
    event: QueueEvent;
    ref: string;
    pr_number: number | null;
    installation_id: number | null;
    delivery_id: string | null;
    status: QueueStatus;
    error: string | null;
    created_at: string;
    updated_at: string;
};

const APP_COLUMNS =
    "app_id, slug, client_id, workflow_file, status, private_key_enc, client_secret_enc, webhook_secret_enc, " +
    "created_at, updated_at, installed_at";

function appView(raw: AppRaw): AppView {
    return {
        appId: raw.app_id,
        slug: raw.slug,
        clientId: raw.client_id,
        workflowFile: raw.workflow_file,
        status: raw.status,
        hasPrivateKey: Boolean(raw.private_key_enc),
        hasClientSecret: Boolean(raw.client_secret_enc),
        hasWebhookSecret: Boolean(raw.webhook_secret_enc),
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
        installedAt: raw.installed_at,
    };
}

function parseRepos(text: string): string[] {
    try {
        const value = JSON.parse(text) as unknown;
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

function installationView(raw: InstallationRaw): InstallationView {
    return {
        installationId: Number(raw.installation_id),
        account: raw.account,
        accountType: raw.account_type,
        repositorySelection: raw.repository_selection,
        repos: parseRepos(raw.repos),
        status: raw.status,
        updatedAt: raw.updated_at,
    };
}

function queueRow(raw: QueueRaw): QueueRow {
    return {
        id: raw.id,
        repo: raw.repo,
        sha: raw.sha,
        kind: raw.kind,
        event: raw.event,
        ref: raw.ref,
        prNumber: raw.pr_number === null ? null : Number(raw.pr_number),
        installationId: raw.installation_id === null ? null : Number(raw.installation_id),
        deliveryId: raw.delivery_id,
        status: raw.status,
        error: raw.error,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
    };
}

export class GitHubStore {
    readonly db: D1Database;

    constructor(db: D1Database) {
        this.db = db;
    }

    private rawApp(): Promise<AppRaw | null> {
        return this.db.prepare(`SELECT ${APP_COLUMNS} FROM github_apps WHERE id = 1`).first<AppRaw>();
    }

    async app(): Promise<AppView | null> {
        const raw = await this.rawApp();
        return raw ? appView(raw) : null;
    }

    /**
     * Insert or update the single app row. Every secret is sealed with the KEK here, before binding, so D1 only
     * ever receives envelopes. Changing app_id drops every cached installation token, which belonged to the old app.
     */
    async saveApp(input: AppInput, kek: string, now: string): Promise<AppView> {
        const existing = await this.rawApp();
        const privateKeyEnc =
            input.privateKey !== undefined ? await seal(input.privateKey, kek) : (existing?.private_key_enc ?? null);
        const clientSecretEnc =
            input.clientSecret !== undefined
                ? input.clientSecret
                    ? await seal(input.clientSecret, kek)
                    : null
                : (existing?.client_secret_enc ?? null);
        const webhookSecretEnc =
            input.webhookSecret !== undefined
                ? await seal(input.webhookSecret, kek)
                : (existing?.webhook_secret_enc ?? null);
        if (!privateKeyEnc) {
            throw new HttpError(400, "privateKey is required the first time the app is configured");
        }
        if (!webhookSecretEnc) {
            throw new HttpError(400, "webhookSecret is required the first time the app is configured");
        }
        const statements = [
            this.db
                .prepare(
                    `INSERT INTO github_apps (id, app_id, slug, private_key_enc, client_id, client_secret_enc,
                        webhook_secret_enc, workflow_file, status, created_at, updated_at)
                     VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?)
                     ON CONFLICT (id) DO UPDATE SET app_id = excluded.app_id, slug = excluded.slug,
                        private_key_enc = excluded.private_key_enc, client_id = excluded.client_id,
                        client_secret_enc = excluded.client_secret_enc, webhook_secret_enc = excluded.webhook_secret_enc,
                        workflow_file = excluded.workflow_file, status = 'configured', updated_at = excluded.updated_at`,
                )
                .bind(
                    input.appId,
                    input.slug,
                    privateKeyEnc,
                    input.clientId ?? existing?.client_id ?? "",
                    clientSecretEnc,
                    webhookSecretEnc,
                    input.workflowFile ?? existing?.workflow_file ?? "hx-context-review.yml",
                    now,
                    now,
                ),
        ];
        if (existing && existing.app_id !== input.appId) {
            statements.push(
                this.db.prepare("UPDATE github_installations SET token_enc = NULL, token_expires_at = NULL"),
            );
        }
        await this.db.batch(statements);
        return appView((await this.rawApp())!);
    }

    async setAppStatus(status: AppStatus, now: string): Promise<void> {
        await this.db.prepare("UPDATE github_apps SET status = ?, updated_at = ? WHERE id = 1").bind(status, now).run();
    }

    async markInstalled(now: string): Promise<void> {
        await this.db
            .prepare("UPDATE github_apps SET installed_at = COALESCE(installed_at, ?), updated_at = ? WHERE id = 1")
            .bind(now, now)
            .run();
    }

    /** The only place the private key is decrypted; its sole caller is jwtFor in tokens.ts. */
    async privateKey(kek: string): Promise<string | null> {
        const raw = await this.rawApp();
        return raw?.private_key_enc ? unseal(raw.private_key_enc, kek) : null;
    }

    /** Decrypted only to check X-Hub-Signature-256 on an incoming webhook. */
    async webhookSecret(kek: string): Promise<string | null> {
        const raw = await this.rawApp();
        return raw?.webhook_secret_enc ? unseal(raw.webhook_secret_enc, kek) : null;
    }

    async upsertInstallation(input: InstallationInput, now: string): Promise<void> {
        await this.db
            .prepare(
                // account_login is NOT NULL from 0006_github_app.sql and is the same value as `account`; both
                // column groups exist on this table for the length of the merge.
                `INSERT INTO github_installations (installation_id, account_login, account, account_type,
                    repository_selection, repos, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (installation_id) DO UPDATE SET account = excluded.account,
                    account_login = excluded.account,
                    account_type = excluded.account_type, repository_selection = excluded.repository_selection,
                    repos = CASE WHEN ? THEN excluded.repos ELSE github_installations.repos END,
                    status = excluded.status, updated_at = excluded.updated_at,
                    token_enc = CASE WHEN excluded.status = 'active' THEN github_installations.token_enc END,
                    token_expires_at = CASE WHEN excluded.status = 'active' THEN github_installations.token_expires_at END`,
            )
            .bind(
                input.installationId,
                input.account,
                input.account,
                input.accountType,
                input.repositorySelection,
                JSON.stringify(input.repos ?? []),
                input.status,
                now,
                now,
                input.repos === undefined ? 0 : 1,
            )
            .run();
    }

    async installation(installationId: number): Promise<InstallationView | null> {
        const raw = await this.db
            .prepare("SELECT * FROM github_installations WHERE installation_id = ?")
            .bind(installationId)
            .first<InstallationRaw>();
        return raw ? installationView(raw) : null;
    }

    async listInstallations(): Promise<InstallationView[]> {
        const { results } = await this.db
            .prepare("SELECT * FROM github_installations ORDER BY installation_id")
            .all<InstallationRaw>();
        return results.map(installationView);
    }

    /** Add and remove repository names on one installation (installation_repositories webhook). */
    async changeInstallationRepos(installationId: number, added: string[], removed: string[], now: string) {
        const current = await this.installation(installationId);
        const gone = new Set(removed.map((name) => name.toLowerCase()));
        const repos = [...(current?.repos ?? []), ...added].filter(
            (name, index, all) =>
                !gone.has(name.toLowerCase()) &&
                all.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index,
        );
        await this.db
            .prepare("UPDATE github_installations SET repos = ?, updated_at = ? WHERE installation_id = ?")
            .bind(JSON.stringify(repos), now, installationId)
            .run();
    }

    async installationIdForRepo(repo: string): Promise<number | null> {
        const row = await this.db
            .prepare(
                `SELECT installation_id FROM github_installations, json_each(github_installations.repos)
                 WHERE status = 'active' AND lower(json_each.value) = lower(?) LIMIT 1`,
            )
            .bind(repo)
            .first<{ installation_id: number }>();
        return row ? Number(row.installation_id) : null;
    }

    async cachedToken(installationId: number, kek: string): Promise<{ token: string; expiresAt: string } | null> {
        const row = await this.db
            .prepare("SELECT token_enc, token_expires_at FROM github_installations WHERE installation_id = ?")
            .bind(installationId)
            .first<{ token_enc: string | null; token_expires_at: string | null }>();
        if (!row?.token_enc || !row.token_expires_at) {
            return null;
        }
        return { token: await unseal(row.token_enc, kek), expiresAt: row.token_expires_at };
    }

    async cacheToken(installationId: number, token: string, expiresAt: string, kek: string, now: string) {
        await this.db
            .prepare(
                // 0006_github_app.sql declared account_login NOT NULL on this same table, so the insert branch has
                // to supply it even when only the token cache is being written. The row always exists by the time a
                // token is cached (installationFor found it), so the conflict path is what actually runs.
                `INSERT INTO github_installations
                     (installation_id, account_login, account_type, token_enc, token_expires_at, created_at,
                      updated_at)
                 VALUES (?, '', '', ?, ?, ?, ?)
                 ON CONFLICT (installation_id) DO UPDATE SET token_enc = excluded.token_enc,
                    token_expires_at = excluded.token_expires_at, updated_at = excluded.updated_at`,
            )
            .bind(installationId, await seal(token, kek), expiresAt, now, now)
            .run();
    }

    /**
     * Queue a review unless the same repo + sha + kind was queued after `since` and did not fail. One statement,
     * INSERT OR IGNORE ... WHERE NOT EXISTS, so two concurrent deliveries cannot both pass the check.
     * Returns false for a duplicate.
     */
    async enqueue(input: QueueInput, now: string, since: string): Promise<boolean> {
        const result = await this.db
            .prepare(
                `INSERT OR IGNORE INTO run_queue (id, repo, sha, kind, event, ref, pr_number, installation_id,
                    delivery_id, status, created_at, updated_at)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
                 WHERE NOT EXISTS (
                    SELECT 1 FROM run_queue WHERE repo = ? AND sha = ? AND kind = ? AND created_at > ? AND status != 'failed'
                 )`,
            )
            .bind(
                input.id,
                input.repo,
                input.sha,
                input.kind,
                input.event,
                input.ref,
                input.prNumber,
                input.installationId,
                input.deliveryId,
                now,
                now,
                input.repo,
                input.sha,
                input.kind,
                since,
            )
            .run();
        return Number(result.meta?.changes ?? 0) > 0;
    }

    async markQueue(id: string, status: QueueStatus, error: string | null, now: string): Promise<void> {
        await this.db
            .prepare("UPDATE run_queue SET status = ?, error = ?, updated_at = ? WHERE id = ?")
            .bind(status, error, now, id)
            .run();
    }

    async listQueue(repo: string | undefined, limit: number): Promise<QueueRow[]> {
        const statement = repo
            ? this.db
                  .prepare("SELECT * FROM run_queue WHERE repo = ? ORDER BY created_at DESC LIMIT ?")
                  .bind(repo, limit)
            : this.db.prepare("SELECT * FROM run_queue ORDER BY created_at DESC LIMIT ?").bind(limit);
        const { results } = await statement.all<QueueRaw>();
        return results.map(queueRow);
    }

    /** Read-only look at the repos table owned by worker/store: is this repository registered, and for what. */
    async registeredRepo(name: string): Promise<RegisteredRepo | null> {
        const row = await this.db
            .prepare("SELECT name, enabled, kind FROM repos WHERE name = ?")
            .bind(name)
            .first<{ name: string; enabled: number; kind: string | null }>();
        if (!row) {
            return null;
        }
        const kind = row.kind === "code" || row.kind === "both" ? row.kind : "context";
        return { name: row.name, enabled: Boolean(row.enabled), kind };
    }

    // ---- App Manifest state (migration 0008) ----------------------------------------------------------------

    /** Remember a manifest state; states older than a day are swept on the way so the table stays small. */
    async createAppState(state: string, now: string, sweepBefore: string): Promise<void> {
        await this.db.batch([
            this.db.prepare("DELETE FROM github_app_states WHERE created_at < ?").bind(sweepBefore),
            this.db
                .prepare("INSERT INTO github_app_states (state, created_at, used) VALUES (?, ?, 0)")
                .bind(state, now),
        ]);
    }

    /**
     * Mark the state used if it exists, is unused and was created after notBefore. One UPDATE, so two callbacks
     * racing on the same state cannot both win. False means unknown, expired or already used; nothing changes then.
     */
    async consumeAppState(state: string, notBefore: string, now: string): Promise<boolean> {
        const result = await this.db
            .prepare(
                "UPDATE github_app_states SET used = 1, used_at = ? WHERE state = ? AND used = 0 AND created_at > ?",
            )
            .bind(now, state, notBefore)
            .run();
        return Number(result.meta?.changes ?? 0) > 0;
    }
}
