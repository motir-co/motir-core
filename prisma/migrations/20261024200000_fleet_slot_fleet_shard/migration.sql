-- AlterTable
ALTER TABLE "fleet_in_flight_slot" ADD COLUMN     "fleet_shard_id" TEXT;

-- CreateIndex
CREATE INDEX "fleet_in_flight_slot_fleet_shard_id_workload_idx" ON "fleet_in_flight_slot"("fleet_shard_id", "workload");

-- AddForeignKey
ALTER TABLE "fleet_in_flight_slot" ADD CONSTRAINT "fleet_in_flight_slot_fleet_shard_id_fkey" FOREIGN KEY ("fleet_shard_id") REFERENCES "fleet_shard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
