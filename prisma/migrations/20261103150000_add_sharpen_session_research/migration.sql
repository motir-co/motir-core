-- MOTIR-10284 — Grill me researches how shipped products handle what a request
-- leaves open once, when the interview opens, and every later turn holds that record.
-- motir-ai owns its shape; core keeps it with the session and sends it back on each
-- turn. Nullable: a session opened before this, or one whose first turn has not
-- landed, has none, and motir-ai then researches.

-- AlterTable
ALTER TABLE "sharpen_session" ADD COLUMN "research" JSONB;
