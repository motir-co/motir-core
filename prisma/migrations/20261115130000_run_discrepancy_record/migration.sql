-- A RUN'S DISCREPANCY RECORD, AS DATA (Task MOTIR-11361).
--
-- `record_run_discrepancy` kept its content only in a card comment, which is
-- editable and deletable. These two tables are the record itself: one row per
-- call (`run_discrepancy_record`) and one per point or decision
-- (`run_discrepancy_entry`), written by the server in the same transaction as
-- the comment, which stays the human-readable view.
--
-- TENANCY is the card's (`CLAUDE.md` § Tenancy): `workspace_id` with a cascading
-- FK and an index on BOTH tables, ENABLE + FORCE ROW LEVEL SECURITY, and one
-- `FOR ALL` policy each on `app.workspace_id`. There is deliberately NO public-read
-- or system-admin arm: the record holds agent-written customer text, and is never
-- readable more widely than the comment it mirrors (which has neither).
--
-- Existing records are not filled here: parsing a comment's markdown belongs in
-- TypeScript beside the composer that wrote it, so it is the data script
-- `backfill-run-discrepancy` (`scripts/backfill-run-discrepancy-records.ts`).

-- CreateEnum
CREATE TYPE "run_discrepancy_source" AS ENUM ('recorded', 'backfilled', 'backfill_unreadable');

-- CreateEnum
CREATE TYPE "run_discrepancy_entry_kind" AS ENUM ('point', 'decision');

-- CreateTable
CREATE TABLE "run_discrepancy_record" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "dispatch_run_id" TEXT,
    "dispatch_run_card_id" TEXT,
    "comment_id" TEXT,
    "recorded_by_id" TEXT,
    "source" "run_discrepancy_source" NOT NULL DEFAULT 'recorded',
    "point_count" INTEGER NOT NULL,
    "decision_count" INTEGER NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_discrepancy_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_discrepancy_entry" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "kind" "run_discrepancy_entry_kind" NOT NULL,
    "position" INTEGER NOT NULL,
    "plan_text" TEXT NOT NULL,
    "outcome_text" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "alternatives" TEXT,

    CONSTRAINT "run_discrepancy_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "run_discrepancy_record_dispatch_run_card_id_key" ON "run_discrepancy_record"("dispatch_run_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_discrepancy_record_comment_id_key" ON "run_discrepancy_record"("comment_id");

-- CreateIndex
CREATE INDEX "run_discrepancy_record_project_id_recorded_at_idx" ON "run_discrepancy_record"("project_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "run_discrepancy_record_work_item_id_idx" ON "run_discrepancy_record"("work_item_id");

-- CreateIndex
CREATE INDEX "run_discrepancy_record_dispatch_run_id_idx" ON "run_discrepancy_record"("dispatch_run_id");

-- CreateIndex
CREATE INDEX "run_discrepancy_record_workspace_id_idx" ON "run_discrepancy_record"("workspace_id");

-- CreateIndex
CREATE INDEX "run_discrepancy_entry_workspace_id_idx" ON "run_discrepancy_entry"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_discrepancy_entry_record_id_kind_position_key" ON "run_discrepancy_entry"("record_id", "kind", "position");

-- AddForeignKey
ALTER TABLE "run_discrepancy_record" ADD CONSTRAINT "run_discrepancy_record_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_discrepancy_record" ADD CONSTRAINT "run_discrepancy_record_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_discrepancy_record" ADD CONSTRAINT "run_discrepancy_record_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_discrepancy_record" ADD CONSTRAINT "run_discrepancy_record_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_discrepancy_record" ADD CONSTRAINT "run_discrepancy_record_dispatch_run_card_id_fkey" FOREIGN KEY ("dispatch_run_card_id") REFERENCES "dispatch_run_card"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_discrepancy_record" ADD CONSTRAINT "run_discrepancy_record_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_discrepancy_record" ADD CONSTRAINT "run_discrepancy_record_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_discrepancy_entry" ADD CONSTRAINT "run_discrepancy_entry_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_discrepancy_entry" ADD CONSTRAINT "run_discrepancy_entry_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "run_discrepancy_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Shape the writers keep, as constraints rather than conventions.
-- ===========================================================================

ALTER TABLE "run_discrepancy_record"
  ADD CONSTRAINT "run_discrepancy_record_counts_check"
  CHECK ("point_count" >= 0 AND "decision_count" >= 0);

-- A leg belongs to a run: a record names its leg only together with that run.
ALTER TABLE "run_discrepancy_record"
  ADD CONSTRAINT "run_discrepancy_record_leg_has_run_check"
  CHECK ("dispatch_run_card_id" IS NULL OR "dispatch_run_id" IS NOT NULL);

ALTER TABLE "run_discrepancy_entry"
  ADD CONSTRAINT "run_discrepancy_entry_position_check" CHECK ("position" >= 1);

-- Only a decision carries alternatives.
ALTER TABLE "run_discrepancy_entry"
  ADD CONSTRAINT "run_discrepancy_entry_alternatives_check"
  CHECK ("kind" = 'decision' OR "alternatives" IS NULL);

-- ===========================================================================
-- Row-level security — both tables, the card's own workspace scope.
-- ===========================================================================

ALTER TABLE "run_discrepancy_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_discrepancy_record" FORCE ROW LEVEL SECURITY;

CREATE POLICY "run_discrepancy_record_active_workspace" ON "run_discrepancy_record"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "run_discrepancy_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_discrepancy_entry" FORCE ROW LEVEL SECURITY;

CREATE POLICY "run_discrepancy_entry_active_workspace" ON "run_discrepancy_entry"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
