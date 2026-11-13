-- What GitHub has said about a CI runner intent's job and its runner (MOTIR-11230).
--
-- A fleet runner is single-use but not bound to the job it was booted for, so in a
-- burst a runner can find nothing to take — its job went to another runner, or was
-- finished before it booted — and it idled until the one-hour job timeout, billed
-- and counted as in use. Supervision now retires such a runner. These two stamps
-- are what it reads:
--
--   job_picked_up_at  this intent's runner has taken a job (never retire it as idle)
--   job_completed_at  the job this intent was booted for is done on GitHub
--
-- Both nullable with no default, so the ALTER rewrites nothing; the table keeps its
-- RLS policy unchanged.

-- AlterTable
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN     "job_completed_at" TIMESTAMP(3),
ADD COLUMN     "job_picked_up_at" TIMESTAMP(3);

-- The `in_progress` delivery stamps job_picked_up_at by the runner GitHub assigned the
-- job to, which is often not the runner booted for that job.
-- CreateIndex
CREATE INDEX "ci_runner_provisioning_intent_github_runner_id_idx" ON "ci_runner_provisioning_intent"("github_runner_id");
