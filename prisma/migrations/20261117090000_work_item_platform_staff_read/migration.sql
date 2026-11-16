-- ===========================================================================
-- A `platform_staff` READ arm on `work_item` (Story MOTIR-11455 · Subtask MOTIR-11504).
--
-- `POST /api/platform/planner-findings/records/:id/links` links a work-item key
-- to a planner finding record, and only core can say whether the key names a
-- work item: `platformPlanRepository.findWorkItemByIdentifier` resolves it in the
-- record's own project, inside `withPlatformWrite`. `work_item` runs FORCE ROW
-- LEVEL SECURITY with no arm reading `app.platform_staff`, and a platform
-- transaction binds no tenant GUC, so before this file that lookup returned
-- ZERO ROWS for a private project and raised nothing. Worse, it was not empty
-- everywhere: `work_item_public_project_read`'s first clause holds when no
-- `app.workspace_id` is bound, so keys in PUBLIC projects resolved and every
-- other key read as "not a work item" — correct-looking on a public test
-- project, wrong in the field (the MOTIR-2880 silent-narrowing shape).
--
-- The shape is copied from `20261116120000_plan_platform_staff_read`, not
-- invented: `coalesce(current_setting('app.platform_staff', true), '') =
-- 'true'`, which names no row column and no subquery (a constant per row).
--
-- ⚠️ `app.platform_staff`, NEVER the system-admin GUC — the ADR's §3a reason:
-- that one is what the job runtime binds.
-- ⚠️ SELECT ONLY: no tenant table gains a `platform_staff` write arm (ADR §3a).
-- ⚠️ NO TENANT-SCOPED POLICY IS ALTERED OR DROPPED. An additional PERMISSIVE
-- arm, OR-ed with `work_item_active_workspace` and
-- `work_item_public_project_read`; the RESTRICTIVE `work_item_project_narrow`
-- still applies to it, and a request that never binds `app.platform_staff`
-- sees exactly what it saw before.
-- ===========================================================================

CREATE POLICY "work_item_platform_staff_read" ON "work_item"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');
