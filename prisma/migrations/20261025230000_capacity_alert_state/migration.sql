-- Story MOTIR-9539 · MOTIR-9609 — the capacity ALERT SHARE (a platform setting,
-- default 80 when no row exists) and the RAISED capacity alerts, one row per
-- (provider, model, limit unit). Neither table carries a tenant column.

-- CreateTable
CREATE TABLE "capacity_alert_setting" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "alert_share_percent" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" TEXT,

    CONSTRAINT "capacity_alert_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_raised_alert" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "limit_unit" TEXT NOT NULL,
    "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observed_value" BIGINT NOT NULL,
    "limit_value" BIGINT NOT NULL,
    "alert_share_percent" INTEGER NOT NULL,

    CONSTRAINT "capacity_raised_alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "capacity_alert_setting_updated_by_user_id_idx" ON "capacity_alert_setting"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_raised_alert_provider_model_limit_unit_key" ON "capacity_raised_alert"("provider", "model", "limit_unit");

-- AddForeignKey
ALTER TABLE "capacity_alert_setting" ADD CONSTRAINT "capacity_alert_setting_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- THE INVARIANTS, held by the database. `capacityAlertStateService` refuses the
-- same values first with typed errors.

-- The singleton: one row, keyed 'platform'.
ALTER TABLE "capacity_alert_setting" ADD CONSTRAINT "capacity_alert_setting_singleton_check"
  CHECK ("id" = 'platform');

-- The alert share is a whole percent from 1 to 100.
ALTER TABLE "capacity_alert_setting" ADD CONSTRAINT "capacity_alert_setting_share_check"
  CHECK ("alert_share_percent" BETWEEN 1 AND 100);

-- The key's sets are closed by the gateway's capacity contract (§3).
ALTER TABLE "capacity_raised_alert" ADD CONSTRAINT "capacity_raised_alert_provider_check"
  CHECK ("provider" IN ('claude', 'qwen', 'deepseek'));
ALTER TABLE "capacity_raised_alert" ADD CONSTRAINT "capacity_raised_alert_limit_unit_check"
  CHECK ("limit_unit" IN ('max_concurrency', 'rpm', 'input_tpm', 'output_tpm', 'tpm', 'tpd'));
ALTER TABLE "capacity_raised_alert" ADD CONSTRAINT "capacity_raised_alert_figures_check"
  CHECK (
    length(btrim("model")) > 0
    AND "observed_value" >= 0
    AND "limit_value" >= 0
    AND "alert_share_percent" BETWEEN 1 AND 100
  );

-- ===========================================================================
-- Platform-only. The alert job reads and writes under `app.system_admin`
-- (`withSystemContext`); the console's audited write runs in `withPlatformWrite`,
-- which binds `app.platform_staff` and NOT `app.system_admin`, so the setting
-- admits both. Raise and clear are system effects only; staff may read.
ALTER TABLE "capacity_alert_setting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capacity_alert_setting" FORCE ROW LEVEL SECURITY;
CREATE POLICY "capacity_alert_setting_system_or_platform" ON "capacity_alert_setting"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR coalesce(current_setting('app.platform_staff', true), '') = 'true'
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR coalesce(current_setting('app.platform_staff', true), '') = 'true'
  );

ALTER TABLE "capacity_raised_alert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capacity_raised_alert" FORCE ROW LEVEL SECURITY;
CREATE POLICY "capacity_raised_alert_system_only" ON "capacity_raised_alert"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
CREATE POLICY "capacity_raised_alert_platform_read" ON "capacity_raised_alert"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');
