-- MOTIR-11981 — deleting a Motir-hosted repository is a sequence of host calls (previews,
-- production, the GitHub repository) with the row deleted LAST, so a delete that stops part
-- way leaves the row behind. This stamp marks the row as being deleted: the Repositories room
-- reads it as "Deletion didn't finish" and offers only Try again, which finishes the rest.
--
-- One nullable column on an existing table: the table's own workspace policy already covers
-- it, so no policy changes. Every existing row reads null (no deletion started).

-- AlterTable
ALTER TABLE "project_repository" ADD COLUMN     "hosted_deletion_started_at" TIMESTAMP(3);
