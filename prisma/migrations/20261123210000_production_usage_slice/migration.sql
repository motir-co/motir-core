-- MOTIR-12108: PRODUCTION HOSTING USAGE, metered into credits (Story MOTIR-9799;
-- Decision MOTIR-12100).
--
-- `production_usage_slice` holds one row per (application, unit, slice end): a
-- window of one Motir-hosted production application's compute or database usage,
-- priced at the decision's derived factor (one credit per Linux-equivalent
-- minute, fractional here) with Motir's own list-price cost beside it. The hourly
-- accrual and the final slice taken before a release is replaced both write it;
-- `idempotency_key` is unique, so a replayed window writes nothing. A day's
-- slices are charged once, rounded up, as `hosting_production`.
--
-- `hosted_application.credits_exhausted_since` records since when the
-- application's organisation has been below zero (§9): the Usage read's
-- `credits_exhausted` and the 7-day switch of an always-on app to suspend.
--
-- TENANCY: `workspace_id` with a cascading FK and an index, ENABLE + FORCE ROW
-- LEVEL SECURITY, and one `FOR ALL` policy on `app.workspace_id`. No system arm:
-- the meter reads the applications under the system context (their table
-- admits it) and writes each one's slices under its own workspace
-- (`withWorkspaceServiceContext`). Additive only.

-- CreateEnum
CREATE TYPE "production_usage_unit" AS ENUM ('fly_small_seconds', 'fly_medium_seconds', 'fly_large_seconds', 'lambda_gb_seconds', 'lambda_requests', 'fargate_vcpu_seconds', 'fargate_gb_seconds', 'neon_compute_hours', 'neon_storage_gb_hours', 'aurora_compute_hours', 'aurora_storage_gb_hours');

-- CreateEnum
CREATE TYPE "production_usage_charge_state" AS ENUM ('pending', 'charging', 'charged', 'refused', 'not_charged');

-- AlterTable
ALTER TABLE "hosted_application" ADD COLUMN     "credits_exhausted_since" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "production_usage_slice" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "release_id" TEXT,
    "unit" "production_usage_unit" NOT NULL,
    "quantity" DECIMAL(24,9) NOT NULL,
    "credits" DECIMAL(20,9) NOT NULL,
    "motir_cost_usd" DECIMAL(24,12) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "charge_day" TIMESTAMPTZ(3) NOT NULL,
    "slice_start" TIMESTAMPTZ(3) NOT NULL,
    "slice_end" TIMESTAMPTZ(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "charge_state" "production_usage_charge_state" NOT NULL DEFAULT 'pending',
    "charged_at" TIMESTAMPTZ(3),
    "charge_attempts" INTEGER NOT NULL DEFAULT 0,
    "charge_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_usage_slice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_usage_slice_idempotency_key_key" ON "production_usage_slice"("idempotency_key");

-- CreateIndex
CREATE INDEX "production_usage_slice_application_id_slice_end_idx" ON "production_usage_slice"("application_id", "slice_end");

-- CreateIndex
CREATE INDEX "production_usage_slice_charge_state_charge_day_idx" ON "production_usage_slice"("charge_state", "charge_day");

-- CreateIndex
CREATE INDEX "production_usage_slice_workspace_id_idx" ON "production_usage_slice"("workspace_id");

-- CreateIndex
CREATE INDEX "production_usage_slice_organization_id_idx" ON "production_usage_slice"("organization_id");

-- AddForeignKey
ALTER TABLE "production_usage_slice" ADD CONSTRAINT "production_usage_slice_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_usage_slice" ADD CONSTRAINT "production_usage_slice_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_usage_slice" ADD CONSTRAINT "production_usage_slice_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security
ALTER TABLE "production_usage_slice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_usage_slice" FORCE ROW LEVEL SECURITY;

CREATE POLICY "production_usage_slice_active_workspace" ON "production_usage_slice"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
