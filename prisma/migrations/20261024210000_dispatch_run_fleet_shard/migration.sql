-- AlterTable
ALTER TABLE "dispatch_run" ADD COLUMN     "fleet_shard_id" TEXT;

-- CreateIndex
CREATE INDEX "dispatch_run_fleet_shard_id_idx" ON "dispatch_run"("fleet_shard_id");

-- AddForeignKey
ALTER TABLE "dispatch_run" ADD CONSTRAINT "dispatch_run_fleet_shard_id_fkey" FOREIGN KEY ("fleet_shard_id") REFERENCES "fleet_shard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
