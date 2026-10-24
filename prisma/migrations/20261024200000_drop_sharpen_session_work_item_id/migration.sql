-- MOTIR-9349 — drop the retired `sharpen_session.work_item_id` column, the
-- CONTRACT phase of its removal (docs/decisions/delivery-reader-migration.md §6a).
--
-- 1. MOTIR-9314 (Story MOTIR-9221) retired the Sharpen work-item target:
--    `20261023010000_sharpen_session_conversation_scope` deleted every
--    `work_item`-scope row and `@ignore`d `SharpenSession.workItemId`, its
--    relation, its index and `WorkItem.sharpenSessions`, leaving the column, its
--    FK and its index in place for the image still serving during that rollout.
-- 2. That release stopped the generated client selecting the column.
-- 3. This release drops it.
--
-- @client-stopped-selecting: MOTIR-9314
--
-- The scope check is re-added without its `work_item_id IS NULL` arm, which it
-- carried only because the column outlived the target. `IF EXISTS` keeps the
-- drops idempotent against a database a repair already cleaned.

ALTER TABLE "sharpen_session" DROP CONSTRAINT "sharpen_session_scope_check";
ALTER TABLE "sharpen_session" DROP CONSTRAINT IF EXISTS "sharpen_session_work_item_id_fkey";
DROP INDEX IF EXISTS "sharpen_session_work_item_id_idx";
ALTER TABLE "sharpen_session" DROP COLUMN IF EXISTS "work_item_id";

-- Exactly one target, and it matches the scope kind.
ALTER TABLE "sharpen_session" ADD CONSTRAINT "sharpen_session_scope_check" CHECK (
  ("scope_kind" = 'plan' AND "plan_id" IS NOT NULL AND "plan_change_session_id" IS NULL)
  OR ("scope_kind" = 'conversation' AND "plan_change_session_id" IS NOT NULL AND "plan_id" IS NULL)
);
