-- Finish the GitHub App merge: one implementation (worker/github/) and one set of tables.
-- 0006_github_app.sql belonged to the retired routes/github.ts stack: a plaintext github_app table, one-hour
-- github_setup_states, and the installation columns that stack read. Nothing reads them any more, so they go here.
-- github_apps (sealed secrets), github_app_states (manifest state), github_installations as 0008 extends it, and
-- run_queue stay. The App has to be connected again through the overview if it was only ever saved in github_app.

DROP TABLE IF EXISTS github_app;
DROP TABLE IF EXISTS github_setup_states;

-- account replaces account_login, repos replaces repos_json, repository_selection replaces all_repos, and status
-- replaces suspended. None of these columns is indexed or constrained beyond NOT NULL, so DROP COLUMN applies.
ALTER TABLE github_installations DROP COLUMN account_login;
ALTER TABLE github_installations DROP COLUMN repos_json;
ALTER TABLE github_installations DROP COLUMN all_repos;
ALTER TABLE github_installations DROP COLUMN suspended;
