-- PREVIEW USAGE charged to the CI-minutes pool (Story MOTIR-5766 · Subtask
-- MOTIR-5777). ADDITIVE and in ONE step: enum + table + indexes + FKs + RLS.
--
-- One row per accrual slice of one preview's usage, converted to Linux-equivalent
-- minutes at MOTIR-5769 §9's factors, with Motir's own cost beside it.
-- `ciMinutesMeterService.getOrgPeriodConsumption` adds these minutes to the
-- `ci_period_usage` sum, so the pool, the thresholds and the `ci_overage` debit
-- apply with no second path (`docs/decisions/ci-minutes-allowance.md`, amendment
-- 2026-10-29).
--
-- RLS: the CI usage tables' tenancy columns and system escape, but a tenant may
-- only READ. Every write comes from the accrual job or the destroy wrap under
-- withSystemContext, and a slice a tenant could delete would be charged again
-- by the next accrual (`ci_live_accrual`'s reasoning).

-- CreateEnum
CREATE TYPE "PreviewUsageKind" AS ENUM ('machine_seconds', 'lambda_gb_seconds', 'lambda_requests', 'neon_compute_hours');

-- CreateTable
CREATE TABLE "preview_usage" (
    "id" TEXT NOT NULL,
    "preview_deployment_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "PreviewUsageKind" NOT NULL,
    "source_ref" TEXT NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "linux_equivalent_minutes" DECIMAL(14,4) NOT NULL,
    "motir_cost_usd" DECIMAL(20,12) NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "slice_start" TIMESTAMP(3) NOT NULL,
    "slice_end" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "preview_usage_organization_id_period_start_idx" ON "preview_usage"("organization_id", "period_start");

-- CreateIndex
CREATE INDEX "preview_usage_workspace_id_idx" ON "preview_usage"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "preview_usage_preview_deployment_id_kind_slice_end_key" ON "preview_usage"("preview_deployment_id", "kind", "slice_end");

-- AddForeignKey
ALTER TABLE "preview_usage" ADD CONSTRAINT "preview_usage_preview_deployment_id_fkey" FOREIGN KEY ("preview_deployment_id") REFERENCES "preview_deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_usage" ADD CONSTRAINT "preview_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_usage" ADD CONSTRAINT "preview_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;



ALTER TABLE "preview_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preview_usage" FORCE ROW LEVEL SECURITY;

CREATE POLICY "preview_usage_system" ON "preview_usage"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "preview_usage_tenant_read" ON "preview_usage"
  FOR SELECT
  USING (
    "workspace_id" = current_setting('app.workspace_id', true)
    OR "organization_id" = (SELECT app_caller_organization_id())
    OR "organization_id" = (SELECT current_setting('app.organization_id', true))
  );
