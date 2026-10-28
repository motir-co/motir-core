-- ===========================================================================
-- project_repository — a SYSTEM READ ARM (Story MOTIR-9794 · MOTIR-10010).
--
-- The AWS hosting adapter is handed a repository row's id and nothing else (the
-- deploy port's `ensureApp({ repositoryId })`, and the `mh-<rid>` app name every
-- later call carries). Before any AWS call it must know three facts about that
-- row: the organisation its workspace belongs to (whose tenant account it deploys
-- into), its seed source (a customer repository is never hosted, D1) and its
-- realized GitHub repository (whose ids the push roles trust). It reads them in a
-- `withSystemContext` transaction — `awsHostingLookupService` — joining
-- `workspace` and `github_repo`, both of which already carry a system arm.
--
-- `project_repository` did not: its policies are `project_repository_active_
-- workspace` (FOR ALL, the bound workspace) and `project_repository_org_read`
-- (FOR SELECT, the bound organisation). The tenant cannot be bound first,
-- because the row being read IS what names it, so under `motir_app` the read
-- returned no row and every hosted repository looked absent.
--
-- Disposition 2 of `tests/rls/system-context-arm-guard.test.ts`: ARM the table,
-- FOR SELECT only. `withSystemContext` binds a constant and is never fed request
-- input, so a tenant cannot reach this arm. The FOR ALL write policy is
-- untouched — no system write to a tenant's repository set is admitted.
-- ===========================================================================

CREATE POLICY "project_repository_system_read" ON "project_repository"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
