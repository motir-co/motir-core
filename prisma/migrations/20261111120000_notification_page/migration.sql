-- NOTIFICATIONS ABOUT A PAGE (Story MOTIR-10868 · MOTIR-10922).
--
-- A page mention or a page reply is a notification whose subject is a PAGE, not
-- a work item. It carries the page's id here and leaves `work_item_id` NULL.
-- Additive only: one column, its foreign key, and its lookup index. No backfill
-- (no existing row is about a page), no enum change (the rows reuse the
-- `mentioned` / `commented` types), and no RLS statement (the table's policy
-- compares its own `workspace_id`, which a new nullable column does not touch).

-- 1. The column -----------------------------------------------------------------
ALTER TABLE "notification" ADD COLUMN "page_id" TEXT;

-- 2. The foreign key --------------------------------------------------------------
--
-- CASCADE, exactly as `work_item_id`: a page is hard-deleted
-- (`pageRepository.deletePages` issues one DELETE), and its notifications go
-- with it, so no row is left pointing at a page that no longer exists.
ALTER TABLE "notification" ADD CONSTRAINT "notification_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. The cascade's lookup index -----------------------------------------------------
--
-- A PARTIAL index over the rows that carry a page id. The cascade above has to
-- find the referencing rows on every permanent page delete; without an index
-- that is a scan of a table that grows with every event in every workspace.
-- Page rows are a small minority of the table, so the index holds only them.
-- Prisma's schema language cannot express a WHERE-filtered index, so it is
-- written here and deliberately absent from `prisma/schema.prisma` (the
-- `notification_unread_idx` precedent), and `migrate dev` does not drift on it.
CREATE INDEX "notification_page_id_idx" ON "notification"("page_id") WHERE "page_id" IS NOT NULL;
