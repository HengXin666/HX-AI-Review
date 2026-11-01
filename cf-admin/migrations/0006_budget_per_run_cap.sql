-- Budget claims become per-run and multi-slot.
--
-- per_run_cap_usd bounds what one run may be granted. Before this, /init claimed the whole monthly
-- remainder for every run, so a same-group takeover of a run cancelled after its first model session
-- settled the entire remainder into spent_usd, and a cancelled run never reports back to correct it.
-- Now a claim is at most the per-run cap, and a takeover settles at most that cap. 0 means "not set":
-- the Worker then uses a quarter of budget_usd (see routes/init.ts perRunCap).
ALTER TABLE repos ADD COLUMN per_run_cap_usd REAL NOT NULL DEFAULT 0 CHECK (per_run_cap_usd >= 0);

-- One row per live or settled claim, replacing the single claim slot on repos (0002). Runs in different
-- concurrency groups now hold separate rows, so they really run concurrently and only share the month:
-- remaining = budget_usd - spent_usd - SUM(usd of unsettled claims of this month).
--
-- claim      opaque id handed out by GET /init and echoed by POST /spend and POST /runs.
-- group_key  the caller's concurrency group; a newer run of the same group takes the older claim over,
--            because GitHub cancelled the older run and it will never report.
-- usd        the allowance granted to the run (never more than the per-run cap).
-- started    1 once the run opened a model session (POST /spend); only started claims are charged on
--            takeover, so a run cancelled during install or scope costs nothing.
-- expires_at an abandoned claim (job killed, crash) may be settled by any later /init after this time.
-- month      the budget month the claim belongs to; a claim from an earlier month never reduces this one.
-- settled    1 after a takeover charged usd into spent_usd. The row is kept so a late POST /runs from
--            that run replaces the charged allowance with its real cost instead of adding to it.
CREATE TABLE budget_claims (
    claim TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    group_key TEXT NOT NULL DEFAULT '',
    usd REAL NOT NULL DEFAULT 0,
    started INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    month TEXT NOT NULL,
    settled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX budget_claims_repo_open ON budget_claims (repo_id, settled, month);

-- Carry over a claim live at deploy time and the settlements still awaiting a late report, so a run that
-- straddles the deploy keeps working: its POST /spend and POST /runs find the same claim id here.
INSERT INTO budget_claims (claim, repo_id, group_key, usd, started, expires_at, month, settled)
SELECT budget_claim, id, claim_group, claim_usd, claim_started, claim_expires_at, claim_month, 0
FROM repos WHERE budget_claim != '';

INSERT OR IGNORE INTO budget_claims (claim, repo_id, group_key, usd, started, expires_at, month, settled)
SELECT json_extract(value, '$.c'), repos.id, '', json_extract(value, '$.u'), 1, '', json_extract(value, '$.m'), 1
FROM repos, json_each(repos.settled_claims)
WHERE json_extract(value, '$.c') IS NOT NULL AND json_extract(value, '$.c') != '';

-- The 0002 slot columns stay for old readers but are no longer written.
UPDATE repos SET budget_claim = '', claim_group = '', claim_usd = 0, claim_month = '', claim_started = 0,
    claim_expires_at = '', settled_claims = '[]';
