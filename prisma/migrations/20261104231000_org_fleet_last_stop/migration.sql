-- The newest stop an organisation owner or admin made from the org's Fleet page
-- (`docs/decisions/agent-instances.md` §8 AMENDMENT 8): one row per org, so
-- "Last stopped by {name}, {when}" survives a new browser and is the same for
-- every admin. Additive: a new enum and a new table, nothing else touched.
-- CreateEnum
CREATE TYPE "org_fleet_stop_action" AS ENUM ('stop_everything', 'cancel_hosted_run', 'hibernate_agent');

-- CreateTable
CREATE TABLE "org_fleet_last_stop" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_name" TEXT,
    "action" "org_fleet_stop_action" NOT NULL,
    "stopped_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_fleet_last_stop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_fleet_last_stop_organization_id_key" ON "org_fleet_last_stop"("organization_id");

-- AddForeignKey
ALTER TABLE "org_fleet_last_stop" ADD CONSTRAINT "org_fleet_last_stop_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- The organisation's own row, as `enterprise_request`: the system arm (the
-- stop and read services run under `withSystemContext`, filtered by org id)
-- or the org's own binding.
-- ===========================================================================
ALTER TABLE "org_fleet_last_stop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_fleet_last_stop" FORCE ROW LEVEL SECURITY;

CREATE POLICY "org_fleet_last_stop_org_or_system" ON "org_fleet_last_stop"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "organization_id" = current_setting('app.organization_id', true)
  );
