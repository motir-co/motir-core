-- MOTIR-11835 — a delivery row the link door writes on an ANCESTOR because one of its
-- descendants was linked ("Complete children when a parent is done" on) is marked, so
-- the merge sync can tell a pull request the container carries in its own right from
-- one it inherited.
--
-- One column on an existing table: the table's own workspace policy already covers it,
-- so no policy changes. Every existing row was linked explicitly and reads false.

-- AlterTable
ALTER TABLE "work_item_delivery" ADD COLUMN     "inherited" BOOLEAN NOT NULL DEFAULT false;
