-- Budget reservation: GET /init atomically claims the repo's run budget, so two concurrent runs
-- (different PRs or refs) cannot both be handed the same unspent remainder and overspend the month.
--
-- budget_claim is an opaque id, not a flag: POST /runs releases only the claim its own run holds, so a
-- run that was refused the budget and then published L0 results cannot free the holder's claim.
--
-- claim_group is the caller's concurrency group. GitHub cancels the older run in a group and a cancelled
-- run never reaches POST /runs, so without this its claim would block the very run that superseded it;
-- a claim from the same group may therefore be taken over. Runs in different groups genuinely contend.
--
-- claim_usd is the allowance handed to the claim's run, claim_month the month it belongs to, and
-- claim_started whether that run ever opened a model session (POST /spend). Taking over a claim settles
-- it: a run that started spending is charged its allowance, which is the only safe bound on a cost that
-- will never be reported, while a run cancelled before its first session is charged nothing, so rapid
-- pushes on one branch do not each burn the month. A claim from an earlier month settles into its own
-- month and never reduces this month's budget.
ALTER TABLE repos ADD COLUMN budget_claim TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN claim_group TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN claim_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN claim_month TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN claim_started INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN claim_expires_at TEXT NOT NULL DEFAULT '';
