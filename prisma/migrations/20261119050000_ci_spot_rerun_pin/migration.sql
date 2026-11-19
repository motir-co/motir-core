-- The ON-DEMAND PIN HOLD of a job's second Spot re-run (MOTIR-11732). A job Spot
-- interrupted twice is re-run once more, and only an on-demand runner may take
-- that re-run. A fleet runner takes the OLDEST queued job its labels match, so a
-- hold per runner target (the org) is opened BEFORE the re-run is requested:
-- while it is open every boot in that org is on-demand, the org's jobless Spot
-- runners are withdrawn from GitHub first (`runner_withdrawn_at` marks each), and
-- the reconcile counts the pinned job as on-demand demand. It closes when a
-- runner takes the re-run, when the re-run is refused or expires, or at 24 hours.
-- ADDITIVE: a new table and one NULLABLE column, nothing backfilled.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- One arm. Every reader and writer is the fleet's own machinery — the
-- supervisor's settle, the boot, the reconcile pass and the `workflow_job`
-- delivery — under `withSystemContext` (`app.system_admin`), both ways. The hold
-- is not a workspace's data (it pins a whole org's runners), so it carries no
-- `workspace_id` and no platform arm: no console reads it. The intent table's
-- existing policy covers the new column. Grants: the add_workspace_rls
-- migration's ALTER DEFAULT PRIVILEGES covers every new table.

-- AlterTable
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN "runner_withdrawn_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ci_spot_rerun_pin" (
    "id" TEXT NOT NULL,
    "target_org" TEXT NOT NULL,
    "repo_owner" TEXT NOT NULL,
    "repo_name" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "run_attempt" INTEGER NOT NULL,
    "job_name" TEXT NOT NULL,
    "source_intent_id" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "close_reason" TEXT,

    CONSTRAINT "ci_spot_rerun_pin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ci_spot_rerun_pin_source_intent_id_key" ON "ci_spot_rerun_pin"("source_intent_id");

-- CreateIndex
CREATE INDEX "ci_spot_rerun_pin_target_org_closed_at_idx" ON "ci_spot_rerun_pin"("target_org", "closed_at");

-- CreateIndex
CREATE INDEX "ci_spot_rerun_pin_repo_owner_repo_name_run_id_job_name_idx" ON "ci_spot_rerun_pin"("repo_owner", "repo_name", "run_id", "job_name");

-- AddForeignKey
ALTER TABLE "ci_spot_rerun_pin" ADD CONSTRAINT "ci_spot_rerun_pin_source_intent_id_fkey" FOREIGN KEY ("source_intent_id") REFERENCES "ci_runner_provisioning_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — ci_spot_rerun_pin
-- ===========================================================================
ALTER TABLE "ci_spot_rerun_pin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_spot_rerun_pin" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_spot_rerun_pin_system_admin" ON "ci_spot_rerun_pin"
  FOR ALL
  USING (coalesce(current_setting('app.system_admin', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.system_admin', true), '') = 'true');
