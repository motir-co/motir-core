-- MOTIR-9666: why a pending CI intent waits now, and since when. Nullable, no
-- backfill: a pending row from before reads as "not judged yet".
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN "waiting_reason" TEXT;
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN "waiting_since" TIMESTAMP(3);
