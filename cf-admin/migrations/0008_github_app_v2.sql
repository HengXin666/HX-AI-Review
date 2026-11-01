-- GitHub App integration: app credentials, installation state with its token cache, and the webhook trigger queue.
-- Three tables because the three rows live on different clocks:
--   github_apps          one row per Worker (id = 1), changed only by an admin;
--   github_installations one row per installation, changed by installation webhooks, holds the cached token;
--   run_queue            one row per triggered review, written on every push / PR webhook.
-- Secrets (private key, client secret, webhook secret, installation token) are AES-GCM envelopes sealed with the
-- Worker secret GITHUB_APP_KEK; no column below ever holds plaintext.

CREATE TABLE github_apps (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    app_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    private_key_enc TEXT NOT NULL,
    client_id TEXT NOT NULL DEFAULT '',
    client_secret_enc TEXT,
    webhook_secret_enc TEXT NOT NULL,
    -- Workflow file in each reviewed repository that accepts workflow_dispatch with head_sha and kind inputs.
    workflow_file TEXT NOT NULL DEFAULT 'hx-context-review.yml',
    status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'verified', 'invalid')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    installed_at TEXT
);

-- github_installations already exists from 0006_github_app.sql, which owns the columns that routes/github.ts
-- reads (account_login, repos_json, all_repos). The columns below are the ones this side reads: repos as a JSON
-- array for installationIdForRepo, status for suspension, and the sealed installation-token cache. During this
-- merge both method sets write the same table; 0010_installation_columns.sql drops the unused side.
ALTER TABLE github_installations ADD COLUMN account TEXT NOT NULL DEFAULT '';
ALTER TABLE github_installations ADD COLUMN repository_selection TEXT NOT NULL DEFAULT 'selected';
ALTER TABLE github_installations ADD COLUMN repos TEXT NOT NULL DEFAULT '[]';
ALTER TABLE github_installations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE github_installations ADD COLUMN token_enc TEXT;
ALTER TABLE github_installations ADD COLUMN token_expires_at TEXT;
ALTER TABLE github_installations ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE github_installations ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE TABLE run_queue (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL COLLATE NOCASE,
    sha TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('context', 'code')),
    event TEXT NOT NULL CHECK (event IN ('push', 'pull_request')),
    ref TEXT NOT NULL,
    pr_number INTEGER,
    installation_id INTEGER,
    delivery_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Dedup lookup (repo + sha + kind within 10 minutes) and the overview list.
CREATE INDEX run_queue_dedup ON run_queue (repo, sha, kind, created_at);
CREATE INDEX run_queue_created ON run_queue (created_at DESC);
