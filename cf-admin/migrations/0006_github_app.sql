-- One GitHub App for the whole product (the Qodo shape): credentials live here so the overview
-- can save them, and installations record which accounts have installed that app.
-- The private key and webhook secret are never returned by the admin API.

CREATE TABLE github_app (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    app_id INTEGER NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_login TEXT NOT NULL DEFAULT '',
    html_url TEXT NOT NULL DEFAULT '',
    private_key TEXT NOT NULL,
    webhook_secret TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE github_installations (
    installation_id INTEGER PRIMARY KEY,
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL,
    repos_json TEXT NOT NULL DEFAULT '[]',
    all_repos INTEGER NOT NULL DEFAULT 0,
    suspended INTEGER NOT NULL DEFAULT 0
);

-- One-time state for the manifest redirect. The browser comes back without a session cookie.
CREATE TABLE github_setup_states (
    state TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
);
