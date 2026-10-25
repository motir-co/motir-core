-- One fleet kind's Fly↔AWS switch (MOTIR-9503), persisted so a superadmin can
-- flip it on a served app from /admin/fleet-settings. One row per fleet kind,
-- written on its first flip; no row = OFF = Fly. Only `agent_instance` is
-- offered today. Read on every placement through the reader
-- `lib/ciFleet/fleetKindSwitches.ts` wires, never cached. ADDITIVE: a new
-- table, nothing existing changes, nothing is seeded.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- `platform_fleet_org_ci`'s shape (20261015300000), copied rather than invented:
--   · READ is unconditional. A row holds a fleet kind, a flag and the
--     operator's stated reason — platform configuration with nothing a tenant
--     could learn from it — and the placement read is not a platform
--     transaction.
--   · WRITE is `app.platform_staff` only: every write runs inside
--     `withPlatformWrite`, which appends the audit row in the same transaction.
-- ONE `FOR ALL` write arm, so UPDATE/DELETE have a permissive policy
-- (`tests/tenant-root-creation-rls.test.ts`). Grants: the add_workspace_rls
-- migration's ALTER DEFAULT PRIVILEGES covers every new table.
-- CreateTable
CREATE TABLE "platform_fleet_kind_switch" (
    "id" TEXT NOT NULL,
    "fleet_kind" TEXT NOT NULL,
    "on_pool" BOOLEAN NOT NULL DEFAULT false,
    "last_reason" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_fleet_kind_switch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_fleet_kind_switch_fleet_kind_key" ON "platform_fleet_kind_switch"("fleet_kind");

-- CreateIndex
CREATE INDEX "platform_fleet_kind_switch_updated_by_user_id_idx" ON "platform_fleet_kind_switch"("updated_by_user_id");

-- AddForeignKey
ALTER TABLE "platform_fleet_kind_switch" ADD CONSTRAINT "platform_fleet_kind_switch_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — platform_fleet_kind_switch
-- ===========================================================================
ALTER TABLE "platform_fleet_kind_switch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_fleet_kind_switch" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_fleet_kind_switch_read" ON "platform_fleet_kind_switch"
  FOR SELECT
  USING (true);

CREATE POLICY "platform_fleet_kind_switch_platform_staff" ON "platform_fleet_kind_switch"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
