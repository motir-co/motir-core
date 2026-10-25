-- MOTIR-9468 (Story MOTIR-9361): the agent instance records the fleet account it
-- lives in and the availability zone of its disk.
--
-- Expand-only: two nullable columns, no default, no backfill. NULL
-- `fleet_shard_id` is the permanent meaning of "the process-wide Fly app", so
-- every existing row reads exactly as it did.
ALTER TABLE "agent_instance" ADD COLUMN "fleet_shard_id" TEXT;
ALTER TABLE "agent_instance" ADD COLUMN "availability_zone" TEXT;

-- An account that still holds an instance cannot be deleted.
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_fleet_shard_id_fkey" FOREIGN KEY ("fleet_shard_id") REFERENCES "fleet_shard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "agent_instance_fleet_shard_id_idx" ON "agent_instance"("fleet_shard_id");

-- A zone only means something inside an account.
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_zone_needs_account_check"
  CHECK ("availability_zone" IS NULL OR "fleet_shard_id" IS NOT NULL);
