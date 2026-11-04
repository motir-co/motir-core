-- MOTIR-10308 — a card waiting To resume leaves the tab once CI starts on its delivery set
-- after the gated run stopped. "After" is measured against the run's snapshot of the set
-- (each member's head, and whether CI had settled there), so the run's own last push,
-- checked after it stops, is not a new start. Nullable: a card stored before this takes
-- its snapshot on its next recompute.

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN "resume_detail" JSONB;
