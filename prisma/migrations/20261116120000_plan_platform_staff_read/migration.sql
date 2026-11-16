-- ===========================================================================
-- A `platform_staff` READ arm on `plan` (Story MOTIR-11455 · Subtask MOTIR-11458).
--
-- `POST /api/platform/planner-findings/records` names a CORE plan id, and core
-- resolves the record's organization, workspace, project and plan session from
-- that plan (`platformPlanRepository.findRecordContext`, read inside
-- `withPlatformRead`, so every read is an audited `estate.read`). The staff
-- member checking a plan is rarely a member of the plan's workspace, and
-- `plan` runs FORCE ROW LEVEL SECURITY with no arm reading `app.platform_staff`,
-- so before this file that read returned ZERO ROWS and raised nothing — the
-- MOTIR-2880 silent-narrowing shape, which would have read as "the plan is gone".
--
-- The shape is copied from `20261001200000_platform_staff_estate_read_arms`,
-- not invented: `coalesce(current_setting('app.platform_staff', true), '') =
-- 'true'`, which names no row column and no subquery (a constant per row).
--
-- ⚠️ `app.platform_staff`, NEVER the system-admin GUC — the ADR's §3a reason:
-- that one is what the job runtime binds.
-- ⚠️ SELECT ONLY: no tenant table gains a `platform_staff` write arm (ADR §3a).
-- ⚠️ NO TENANT-SCOPED POLICY IS ALTERED. An additional PERMISSIVE arm, OR-ed
-- with `plan_active_workspace` and `plan_system_read`; a request that never
-- binds `app.platform_staff` sees exactly what it saw before.
-- ===========================================================================

CREATE POLICY "plan_platform_staff_read" ON "plan"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');
