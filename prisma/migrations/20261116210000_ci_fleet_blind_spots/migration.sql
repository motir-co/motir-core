-- The CI fleet's blind spots as the provision sweep's last reconcile computed them
-- (MOTIR-11439; design MOTIR-11467): per GitHub organisation the repos with queued
-- fleet jobs but no workflow_job deliveries, the linked repos the fleet's
-- credential cannot read, and the org's read error, plus the reconcile's own
-- error, with the time of that tick. ONE row (`id = 'latest'`), replaced on every
-- tick, so the Fleet status page reads it and never calls GitHub on a page load.
-- ADDITIVE: a new table, nothing seeded. Not a workspace's data: it spans every
-- organisation the fleet serves, so it carries no `workspace_id`.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- Two arms. The WRITER is the provision sweep, under `withSystemContext`
-- (`app.system_admin`), both ways because the upsert reads the row it replaces.
-- The READER is `ciFleetBlindSpotsService.read`, inside `withPlatformRead`
-- (`app.platform_staff`), SELECT only: the console never writes the record.
-- Grants: the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES covers
-- every new table.
-- CreateTable
CREATE TABLE "ci_fleet_blind_spots" (
    "id" TEXT NOT NULL DEFAULT 'latest',
    "outcome" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_fleet_blind_spots_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Row-level security — ci_fleet_blind_spots
-- ===========================================================================
ALTER TABLE "ci_fleet_blind_spots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_fleet_blind_spots" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_fleet_blind_spots_system_admin" ON "ci_fleet_blind_spots"
  FOR ALL
  USING (coalesce(current_setting('app.system_admin', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.system_admin', true), '') = 'true');

CREATE POLICY "ci_fleet_blind_spots_platform_staff" ON "ci_fleet_blind_spots"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');
