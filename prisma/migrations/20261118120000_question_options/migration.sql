-- A question put to a person carries its OPTIONS as data, and the answer says which
-- option was picked or that the person used their own words (MOTIR-11700).
--
-- Purely ADDITIVE: nullable JSON columns and one boolean defaulting to false, no
-- back-fill. Every existing row reads exactly as it did — a null is "no options",
-- which is how a question from an engine that predates them is drawn.
--
-- No RLS stanza, deliberately: RLS is a TABLE-level policy and all three tables
-- already carry it, so the new columns inherit it.

-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN "question_options" JSONB;
ALTER TABLE "plan_change_turn" ADD COLUMN "answer_option" JSONB;

-- AlterTable
ALTER TABLE "plan_change_run_pauses" ADD COLUMN "options" JSONB;
ALTER TABLE "plan_change_run_pauses" ADD COLUMN "reply_option" JSONB;

-- AlterTable
ALTER TABLE "plan_change_mailbox_entry" ADD COLUMN "answer_option" JSONB;
ALTER TABLE "plan_change_mailbox_entry" ADD COLUMN "answer_own_words" BOOLEAN NOT NULL DEFAULT false;
