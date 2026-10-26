-- MOTIR-9619 (Story MOTIR-9540): a planner session's provider-retry wait lives on
-- its step row — when it started waiting, when the retry goes out, which retry
-- and of how many.
--
-- Expand-only: four nullable columns, no default, no backfill. NULL is "not
-- waiting", so every existing row reads exactly as it did.
ALTER TABLE "plan_step" ADD COLUMN "provider_wait_since" TIMESTAMPTZ;
ALTER TABLE "plan_step" ADD COLUMN "provider_wait_until" TIMESTAMPTZ;
ALTER TABLE "plan_step" ADD COLUMN "provider_wait_attempt" INTEGER;
ALTER TABLE "plan_step" ADD COLUMN "provider_wait_max_attempts" INTEGER;

-- A wait is all four facts or none: a half-written wait has no reading.
ALTER TABLE "plan_step" ADD CONSTRAINT "plan_step_provider_wait_complete"
  CHECK (
    ("provider_wait_since" IS NULL AND "provider_wait_until" IS NULL
      AND "provider_wait_attempt" IS NULL AND "provider_wait_max_attempts" IS NULL)
    OR ("provider_wait_since" IS NOT NULL AND "provider_wait_until" IS NOT NULL
      AND "provider_wait_attempt" IS NOT NULL AND "provider_wait_max_attempts" IS NOT NULL)
  );
