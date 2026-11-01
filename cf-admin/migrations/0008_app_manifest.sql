-- One-click GitHub connection: one-time state for the GitHub App Manifest flow.
-- GET /api/github/app/manifest inserts a row; GET /api/github/app/callback accepts it once (used = 0 -> 1) and only
-- within 10 minutes of created_at. Rows older than a day are swept whenever a new state is created.

CREATE TABLE github_app_states (
    state TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
    used_at TEXT
);

CREATE INDEX github_app_states_created ON github_app_states (created_at);
