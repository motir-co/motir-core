-- MOTIR-10219 — the system-admin WRITE arm comes off seven workspace tables.
--
-- `hosted_application`, `hosted_release`, `preview_deployment`, `repo_deployment`,
-- `monitor_connection`, `monitor_installation` and `monitor_issue` each carry one
-- `FOR ALL` policy, `<table>_workspace_or_system`, whose USING and WITH CHECK both
-- read `app.system_admin OR workspace_id = app.workspace_id`. Every row has a
-- workspace (`workspace_id` is NOT NULL) and every system writer of these tables
-- now reads its row first and binds that row's workspace before it writes
-- (`withWorkspaceServiceContext` or `bindWorkspaceContext`), so the system arm on
-- WITH CHECK admits nothing a writer needs. Removing it means a write is confined
-- to the workspace it bound: a system path that names the wrong row, or none, is
-- refused (SQLSTATE 42501) instead of writing into another tenant.
--
-- ⚠️ USING IS UNTOUCHED, deliberately. The sweeps and webhooks still find a row
-- under the system flag BEFORE they know its workspace (the monitor poll's
-- `listForPolling`, the preview reaper's `listStale`, a release's
-- `findStatusTarget`), and a DELETE / `SELECT … FOR UPDATE` is judged by USING
-- alone. `ALTER POLICY … WITH CHECK` replaces the check expression and leaves the
-- USING expression as it is.
--
-- Rolling back is the same statement with the system branch put back.

ALTER POLICY "hosted_application_workspace_or_system" ON "hosted_application"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "hosted_release_workspace_or_system" ON "hosted_release"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "preview_deployment_workspace_or_system" ON "preview_deployment"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "repo_deployment_workspace_or_system" ON "repo_deployment"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "monitor_connection_workspace_or_system" ON "monitor_connection"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "monitor_installation_workspace_or_system" ON "monitor_installation"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "monitor_issue_workspace_or_system" ON "monitor_issue"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
