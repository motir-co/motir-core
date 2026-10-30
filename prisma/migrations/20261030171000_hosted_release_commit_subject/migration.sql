-- WHAT A PRODUCTION RELEASE WAS (MOTIR-10103): the released commit's subject
-- line, the pull request a merge came from, and who asked for a release of a
-- ref, so the Production panel can say `Merge of #48` and show the subject the
-- design draws. ADDITIVE, nullable columns; the table's RLS
-- (`hosted_release_workspace_or_system`) already covers them. Releases made
-- before this carry none and read as they did. SET NULL on the user's deletion
-- keeps the release.


-- AlterTable
ALTER TABLE "hosted_release" ADD COLUMN     "commit_subject" TEXT,
ADD COLUMN     "pull_request_number" INTEGER,
ADD COLUMN     "requested_by_id" TEXT;

-- CreateIndex
CREATE INDEX "hosted_release_requested_by_id_idx" ON "hosted_release"("requested_by_id");

-- AddForeignKey
ALTER TABLE "hosted_release" ADD CONSTRAINT "hosted_release_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
