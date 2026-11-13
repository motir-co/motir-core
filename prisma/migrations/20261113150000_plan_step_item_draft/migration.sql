-- MOTIR-11199 (Story MOTIR-11190): an author session's in-flight card — the partial
-- title, description and explanation its model has written so far — lives on the
-- session's step row, beside the proposal it names and never in it.
--
-- Expand-only: six nullable columns, no default, no backfill. NULL is "no draft",
-- so every existing row reads exactly as it did. `plan_step` carries no
-- `workspace_id`; its policy joins to `plan`, so no new tenancy is needed.
ALTER TABLE "plan_step" ADD COLUMN "draft_plan_item_id" TEXT;
ALTER TABLE "plan_step" ADD COLUMN "draft_seq" INTEGER;
ALTER TABLE "plan_step" ADD COLUMN "draft_title" TEXT;
ALTER TABLE "plan_step" ADD COLUMN "draft_description_md" TEXT;
ALTER TABLE "plan_step" ADD COLUMN "draft_explanation_md" TEXT;
ALTER TABLE "plan_step" ADD COLUMN "draft_updated_at" TIMESTAMPTZ;

-- A draft names its proposal, its sequence and when it arrived, or none of them.
ALTER TABLE "plan_step" ADD CONSTRAINT "plan_step_item_draft_complete"
  CHECK (
    ("draft_plan_item_id" IS NULL AND "draft_seq" IS NULL AND "draft_updated_at" IS NULL)
    OR ("draft_plan_item_id" IS NOT NULL AND "draft_seq" IS NOT NULL
      AND "draft_updated_at" IS NOT NULL)
  );
