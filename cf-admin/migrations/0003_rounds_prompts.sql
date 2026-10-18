-- Multi-round findings and operator prompt versions.
-- SQLite cannot widen a CHECK, so findings is rebuilt to allow status 'resolved'.

CREATE TABLE findings_next (
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
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'resolved')),
    resolved_by_run TEXT
);

INSERT INTO findings_next (
    id, run_id, repo_id, fingerprint, rule_id, severity, path, line, message, evidence, patch_key, status, resolved_by_run
)
SELECT id, run_id, repo_id, fingerprint, rule_id, severity, path, line, message, evidence, patch_key, status, NULL
FROM findings;

DROP TABLE findings;
ALTER TABLE findings_next RENAME TO findings;

CREATE INDEX findings_repo_fingerprint ON findings (repo_id, fingerprint);
CREATE INDEX findings_status ON findings (status);

CREATE TABLE prompt_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('finder', 'verifier')),
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (role, version)
);

CREATE TABLE prompt_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    fingerprint TEXT NOT NULL,
    reason TEXT NOT NULL,
    folded_into INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX prompt_notes_open ON prompt_notes (folded_into, created_at);
