-- Budget reservation: GET /init atomically claims the repo's run budget, so two concurrent runs
-- (different PRs or refs) cannot both be handed the same unspent remainder and overspend the month.
--
-- The claim is an opaque id, not just a flag: POST /runs releases only the claim its own run holds, so
-- a run that was refused the budget and then published L0 results cannot free the holder's claim.
--
-- claim_group is the caller's concurrency group. GitHub cancels the older run in a group, and a
-- cancelled run never reaches POST /runs, so without this its claim would block the very run that
-- superseded it; a claim from the same group may therefore be taken over. Runs in different groups are
-- genuinely concurrent and still contend. claim_expires_at bounds a claim whose run died outright.
ALTER TABLE repos ADD COLUMN budget_claim TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN claim_group TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN claim_expires_at TEXT NOT NULL DEFAULT '';
