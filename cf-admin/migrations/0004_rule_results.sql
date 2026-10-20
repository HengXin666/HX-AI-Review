-- Rule-dimension results: one row per rule hit at a file and line, derived from findings.
-- Replaying this file is safe: the table and indexes are created only when missing, and the
-- backfill skips rows that already exist.

CREATE TABLE IF NOT EXISTS rule_results (
    run_id TEXT NOT NULL REFERENCES runs(id),
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'resolved')),
    waived INTEGER NOT NULL DEFAULT 0 CHECK (waived IN (0, 1)),
    PRIMARY KEY (run_id, rule_id, file, line)
);

CREATE INDEX IF NOT EXISTS rule_results_rule ON rule_results (rule_id, severity);
CREATE INDEX IF NOT EXISTS rule_results_severity ON rule_results (severity);

INSERT OR IGNORE INTO rule_results (run_id, rule_id, severity, file, line, status, waived)
SELECT run_id, rule_id, severity, path, line, status,
    CASE WHEN status = 'rejected' THEN 1 ELSE 0 END
FROM findings;
