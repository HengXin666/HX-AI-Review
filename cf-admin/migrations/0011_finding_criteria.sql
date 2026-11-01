-- Rule criteria travel with every finding.
-- The runner has always put the rule's one-line criteria (rules/*.ts, Finding.criteria) on each finding, but
-- findings and rule_results had no column for it, so ingest dropped it and the overview and the PR comment
-- showed a verdict without the yardstick it was measured against. Reviewers had to guess what a rule checks.
-- Both columns default to the empty string: rows written before this migration, and runs from older runners
-- that do not send criteria, stay valid and simply show no criteria line.

ALTER TABLE findings ADD COLUMN criteria TEXT NOT NULL DEFAULT '';
ALTER TABLE rule_results ADD COLUMN criteria TEXT NOT NULL DEFAULT '';
