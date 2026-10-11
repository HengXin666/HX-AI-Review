-- Budget reservation: GET /init atomically claims the repo's run budget, so two concurrent runs
-- (different PRs or refs) cannot both be handed the same unspent remainder and overspend the month.
--
-- The claim is an opaque id, not just a flag: POST /runs releases only the claim its own run holds, so
-- a run that was refused the budget and then published L0 results cannot free the holder's claim.
--
-- claim_group is the caller's concurrency group. GitHub cancels the older run in a group, and a
-- cancelled run never reaches POST /runs, so without this its claim would block the very run that
-- superseded it; a claim from the same group may therefore be taken over. Runs in different groups are
-- genuinely concurrent and still contend.
--
-- claim_usd is the allowance handed to the claim's run. A cancelled or crashed run never reports its
-- real cost, so taking over its claim first charges that allowance in full: otherwise every rapid push
-- on one branch would get the whole remaining budget again while none of the spending was ever
-- recorded. charge settles the real cost instead and clears the allowance.
ALTER TABLE repos ADD COLUMN budget_claim TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN claim_group TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN claim_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN claim_expires_at TEXT NOT NULL DEFAULT '';
