-- hx-context-review D1 schema v0.3: repos / runs / findings / feedback / budget / suppressions.
-- api keys are not stored here: providers.key_secret names a Worker secret.

CREATE TABLE providers (
    name TEXT PRIMARY KEY,
    api_url TEXT NOT NULL,
    api TEXT NOT NULL DEFAULT 'openai-completions' CHECK (api IN ('openai-completions', 'anthropic-messages')),
    key_secret TEXT NOT NULL,
    context_window INTEGER NOT NULL DEFAULT 128000,
    max_tokens INTEGER NOT NULL DEFAULT 8192,
    -- USD per million tokens; the Worker charges budgets from reported token counts with these prices.
    price_input REAL NOT NULL DEFAULT 0,
    price_output REAL NOT NULL DEFAULT 0,
    price_cache_read REAL NOT NULL DEFAULT 0,
    price_cache_write REAL NOT NULL DEFAULT 0
);

CREATE TABLE repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- GitHub owner/repo names are case-insensitive, so the uniqueness check is too.
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    token_hash TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'l0')),
    provider TEXT NOT NULL DEFAULT 'default',
    finder_model TEXT NOT NULL DEFAULT '',
    verifier_model TEXT NOT NULL DEFAULT '',
    budget_usd REAL NOT NULL DEFAULT 0,
    spent_usd REAL NOT NULL DEFAULT 0,
    budget_month TEXT NOT NULL DEFAULT '',
    last_sha TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    event TEXT NOT NULL,
    pr_number INTEGER,
    status TEXT NOT NULL,
    l0_only INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    warnings INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    patch_branch TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX runs_repo_created ON runs (repo_id, created_at DESC);

CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    fingerprint TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    message TEXT NOT NULL,
    evidence TEXT NOT NULL,
    patch_key TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected'))
);
CREATE INDEX findings_repo_fingerprint ON findings (repo_id, fingerprint);
CREATE INDEX findings_status ON findings (status);

CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    fingerprint TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE suppressions (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    fingerprint TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (repo_id, fingerprint)
);
