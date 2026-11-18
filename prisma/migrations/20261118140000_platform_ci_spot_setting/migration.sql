-- The CI runner Spot setting (MOTIR-11725), persisted so a superadmin can turn
-- Spot launches on or off, and change the ordered instance-type list a CI runner
-- may launch on, without a redeploy. ONE row, keyed by `scope = 'ci_runner'`,
-- written on the first save; no row = Spot OFF and the default instance types
-- (`lib/ciFleet/ciSpotInstanceTypes.ts`). Read by system code on every launch,
-- never cached. ADDITIVE: a new table, nothing existing changes, nothing is
-- seeded — so deploying it changes no launch.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- `platform_fleet_kind_switch`'s shape (20261025090000), copied rather than
-- invented:
--   · READ is unconditional. The row holds a flag, a list of EC2 instance types
--     and the operator's stated reason — platform configuration with nothing a
--     tenant could learn from it — and the launch read is not a platform
--     transaction.
--   · WRITE is `app.platform_staff` only: every write runs inside
--     `withPlatformWrite`, which appends the audit row in the same transaction.
-- ONE `FOR ALL` write arm, so UPDATE/DELETE have a permissive policy
-- (`tests/tenant-root-creation-rls.test.ts`). Grants: the add_workspace_rls
-- migration's ALTER DEFAULT PRIVILEGES covers every new table.
-- CreateTable
CREATE TABLE "platform_ci_spot_setting" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "instance_types" TEXT[],
    "last_reason" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_ci_spot_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_ci_spot_setting_scope_key" ON "platform_ci_spot_setting"("scope");

-- CreateIndex
CREATE INDEX "platform_ci_spot_setting_updated_by_user_id_idx" ON "platform_ci_spot_setting"("updated_by_user_id");

-- AddForeignKey
ALTER TABLE "platform_ci_spot_setting" ADD CONSTRAINT "platform_ci_spot_setting_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — platform_ci_spot_setting
-- ===========================================================================
ALTER TABLE "platform_ci_spot_setting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_ci_spot_setting" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_ci_spot_setting_read" ON "platform_ci_spot_setting"
  FOR SELECT
  USING (true);

CREATE POLICY "platform_ci_spot_setting_platform_staff" ON "platform_ci_spot_setting"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
