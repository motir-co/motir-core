-- ===========================================================================
-- RLS: take the `app.system_admin` arm off `WITH CHECK` on the seven policies
-- whose system code never writes through it (MOTIR-10217).
--
-- A system-admin `WITH CHECK` arm lets a `withSystemContext` transaction write
-- a row into ANY workspace. The coding convention (*Tenancy*) asks that new
-- system writes bind the workspace and that the arm exist only where no
-- workspace can be known first. On these seven tables every system write either
-- binds a tenant already or is a DELETE, so the arm only widens what a future
-- bug could reach.
--
-- RE-CHECKED BEFORE CHANGING, at origin/main a97335f: every repository write
-- method on the seven tables was traced to its callers, and
-- `tests/rls/contextArmScan.ts` (`scanContexts(SYSTEM_CONTEXT)`, three helper
-- hops) was run over the tree. The only statements a bare system context
-- reaches on these tables are reads and three deletes:
--
--   attachment                — `attachmentsService.sweepOrphanAttachments`
--                               deletes; every create / link / unlink runs
--                               under `withWorkspaceContext`.
--   public_follow             — `publicFollowDigestService.sweepUnconfirmed`
--                               deletes; creates and updates (the digest stamp
--                               included) run under `withWorkspaceServiceContext`.
--   saved_filter_subscription — `savedFilterSubscriptionsService.unsubscribeByToken`
--                               deletes; create / update run under
--                               `withWorkspaceContext`.
--   work_item_delivery        — `add` / `remove` run under `withWorkspaceContext`
--                               (`githubPullRequestService`). The header of
--                               20260828120000 says the sync writes it from a
--                               system context; it no longer does. That header
--                               is left as written: it records why the arm was
--                               added then.
--   migrate_onboarding        — the two sweeps READ under the system flag and
--                               commit each run under `withWorkspaceServiceContext`
--                               (20260804180000 says the same).
--   import_source_identity    — every write runs under `withUserContext`.
--   public_subdomain_change   — every write is `recordChangeInTx` inside a rename
--                               or release under `withWorkspaceContext`.
--
-- WHY THE DELETES SURVIVE: Postgres evaluates only `USING` for a DELETE —
-- `WITH CHECK` governs the post-image of an INSERT or UPDATE, and a DELETE has
-- none. Every `USING` clause below is left exactly as it was, so system reads and
-- the three sweeps' deletes are untouched.
--
-- WHY `ALTER POLICY` for six and DROP + CREATE for one: `ALTER POLICY … WITH
-- CHECK` replaces only that clause and keeps the policy's name, command, roles and
-- `USING`. `public_subdomain_change_system`'s `WITH CHECK` IS the system test
-- alone, so removing the arm leaves it nothing to admit a write with; a policy's
-- command cannot be altered, so it is recreated `FOR SELECT` under the same name.
-- The workspace's own writes stay on `public_subdomain_change_active_workspace`.
--
-- Out of scope (MOTIR-10219): the seven tables whose system code writes without
-- a bound workspace today, which must bind before their arm can go.
-- ===========================================================================

ALTER POLICY "attachment_workspace_or_system_admin" ON "attachment"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "public_follow_workspace_or_system" ON "public_follow"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "saved_filter_subscription_access" ON "saved_filter_subscription"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "work_item_delivery_workspace_or_system" ON "work_item_delivery"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "migrate_onboarding_workspace_or_system_admin" ON "migrate_onboarding"
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER POLICY "import_source_identity_owner_or_system" ON "import_source_identity"
  WITH CHECK ("user_id" = current_setting('app.user_id', true));

DROP POLICY "public_subdomain_change_system" ON "public_subdomain_change";

CREATE POLICY "public_subdomain_change_system" ON "public_subdomain_change"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
