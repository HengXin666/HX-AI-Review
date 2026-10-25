-- Dual CR: a repository and a run now carry the kind of review they perform.
-- context: are AGENTS.md / README.md / SKILL.md / docs still true? code: is the diff itself sound?
-- Existing rows are context runs, so the default keeps every old client and old report valid.

ALTER TABLE repos ADD COLUMN kind TEXT NOT NULL DEFAULT 'context' CHECK (kind IN ('context', 'code', 'both'));

ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'context' CHECK (kind IN ('context', 'code'));

-- Findings inherit the kind of their run so the overview can filter without joining runs.
ALTER TABLE findings ADD COLUMN kind TEXT NOT NULL DEFAULT 'context' CHECK (kind IN ('context', 'code'));

-- Backfill from runs: a finding belongs to exactly one run, and that run knows its kind.
UPDATE findings
SET kind = (SELECT runs.kind FROM runs WHERE runs.id = findings.run_id)
WHERE EXISTS (SELECT 1 FROM runs WHERE runs.id = findings.run_id);

CREATE INDEX IF NOT EXISTS runs_repo_kind_created ON runs (repo_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS findings_repo_kind_status ON findings (repo_id, kind, status);
