-- A CI runner EC2 reclaimed for Spot capacity (MOTIR-11728): the job the runner
-- actually TOOK (run id, attempt, job id, name — written once, from the
-- `workflow_job` `in_progress` delivery), the job's carried interruption count,
-- the taken job's count once reclaimed, the state of its re-run, and the
-- conclusion GitHub gave a completed job (a reclaimed job completes `failure`
-- and must still be re-run; only one that passed is spared). ADDITIVE:
-- every new column is NULLABLE or has a default, nothing is backfilled, and no
-- policy changes — the table's RLS covers the new columns.
ALTER TABLE "ci_runner_provisioning_intent"
  ADD COLUMN "taken_run_id" TEXT,
  ADD COLUMN "taken_run_attempt" INTEGER,
  ADD COLUMN "taken_job_id" TEXT,
  ADD COLUMN "taken_job_name" TEXT,
  ADD COLUMN "spot_interruption_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "taken_job_spot_interruptions" INTEGER,
  ADD COLUMN "rerun_state" TEXT,
  ADD COLUMN "rerun_attempted_at" TIMESTAMP(3),
  ADD COLUMN "job_conclusion" TEXT;

-- The queued delivery's look-up of an earlier attempt's interrupted runner.
CREATE INDEX "ci_runner_provisioning_intent_repo_owner_repo_name_taken_ru_idx"
  ON "ci_runner_provisioning_intent"("repo_owner", "repo_name", "taken_run_id", "taken_job_name");

-- The reconcile pass's read of re-runs still to request.
CREATE INDEX "ci_runner_provisioning_intent_rerun_state_settled_at_idx"
  ON "ci_runner_provisioning_intent"("rerun_state", "settled_at");
