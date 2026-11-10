-- The last successful read of one AWS figure the operator console shows live
-- (MOTIR-10890, the Services page): the ECS cluster and the Fargate vCPU quota.
-- One row per subject, upserted when a read succeeds, so a read that fails can
-- name when the figure was last read. No figure is stored — a failed read never
-- shows an earlier number. ADDITIVE: a new table, nothing seeded.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- Platform staff only, both ways: the one reader and writer is
-- `platformServicesService.read`, inside `withPlatformRead`, which binds
-- `app.platform_staff` and appends the `estate.read` audit row in the same
-- transaction. ONE `FOR ALL` arm, so UPDATE/DELETE have a permissive policy.
-- Grants: the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES covers
-- every new table.
-- CreateTable
CREATE TABLE "platform_aws_read" (
    "subject" TEXT NOT NULL,
    "account_id" TEXT,
    "read_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_aws_read_pkey" PRIMARY KEY ("subject")
);

-- ===========================================================================
-- Row-level security — platform_aws_read
-- ===========================================================================
ALTER TABLE "platform_aws_read" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_aws_read" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_aws_read_platform_staff" ON "platform_aws_read"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
