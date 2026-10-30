-- WHO RESTORED a production release, and when (Story MOTIR-9797 · Subtask
-- MOTIR-10035): a rollback brings the previous release back to live and records
-- the project administrator who asked for it, for the Production panel. ADDITIVE,
-- nullable columns; the table's RLS (`hosted_release_workspace_or_system`)
-- already covers them. SET NULL on the user's deletion keeps the release.


-- AlterTable
ALTER TABLE "hosted_release" ADD COLUMN     "restored_at" TIMESTAMPTZ(3),
ADD COLUMN     "restored_by_id" TEXT;

-- CreateIndex
CREATE INDEX "hosted_release_restored_by_id_idx" ON "hosted_release"("restored_by_id");

-- AddForeignKey
ALTER TABLE "hosted_release" ADD CONSTRAINT "hosted_release_restored_by_id_fkey" FOREIGN KEY ("restored_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

