-- Budget reservation: GET /init atomically claims the repo's run budget, so two concurrent runs
-- (different PRs or refs) cannot both be handed the same unspent remainder and overspend the month.
-- The claim is released by POST /runs (charge) and expires on its own if the run never reports.
ALTER TABLE repos ADD COLUMN reserved_at TEXT NOT NULL DEFAULT '';
