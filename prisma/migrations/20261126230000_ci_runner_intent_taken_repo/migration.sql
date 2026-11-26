-- The REPOSITORY of the job a CI runner took (MOTIR-12266). A fleet runner is
-- org-level and takes any queued job carrying its label, so the job it took may
-- be in another repository than the one its intent was booted for. A Spot
-- re-run of that job, the interruption count carried to it and the on-demand
-- pin all key on the taken job's own repository. ADDITIVE: both columns are
-- NULLABLE, nothing is backfilled (a NULL row is read as the intent's own
-- repository), and no policy changes — the table's RLS covers the new columns.
ALTER TABLE "ci_runner_provisioning_intent"
  ADD COLUMN "taken_repo_owner" TEXT,
  ADD COLUMN "taken_repo_name" TEXT;

-- The queued delivery's look-up of an earlier attempt's interrupted runner, by
-- the taken job's own repository.
CREATE INDEX "ci_runner_provisioning_intent_taken_repo_owner_taken_repo_n_idx"
  ON "ci_runner_provisioning_intent"("taken_repo_owner", "taken_repo_name", "taken_run_id", "taken_job_name");
