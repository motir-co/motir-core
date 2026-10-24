-- The growth pass (Story MOTIR-9362 · MOTIR-9462): a request's alert mark, and
-- the pass's single-flight lease.

-- AlterTable
ALTER TABLE "fleet_quota_request" ADD COLUMN     "alerted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "fleet_growth_pass_lease" (
    "id" TEXT NOT NULL,
    "held_until" TIMESTAMP(3) NOT NULL,
    "holder" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_growth_pass_lease_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- Platform-only, as `fleet_shard`: `app.system_admin` and nothing else.
-- ===========================================================================
ALTER TABLE "fleet_growth_pass_lease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_growth_pass_lease" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fleet_growth_pass_lease_system_only" ON "fleet_growth_pass_lease"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
