-- A Host organisation's refused account creations (Story MOTIR-9365 · MOTIR-9582):
-- one row per (organisation, slot), counts and times only.

-- CreateTable
CREATE TABLE "host_account_attempt" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "refused_count" INTEGER NOT NULL DEFAULT 0,
    "last_refused_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "host_account_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "host_account_attempt_organization_id_slot_key" ON "host_account_attempt"("organization_id", "slot");

-- AddForeignKey
ALTER TABLE "host_account_attempt" ADD CONSTRAINT "host_account_attempt_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Platform-only, as `fleet_shard`: `app.system_admin` and nothing else.
-- ===========================================================================
ALTER TABLE "host_account_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "host_account_attempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "host_account_attempt_system_only" ON "host_account_attempt"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
