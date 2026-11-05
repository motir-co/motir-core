-- MOTIR-10333 (Story MOTIR-10327; `docs/decisions/approval-gates.md` §12.11–§12.14) — the
-- agent review VERDICT record, and the supersede cause a send-back withdraws the
-- approve-and-merge gate under.
--
-- Every agent verdict, hosted or from a person's own review agent, is a row: a gate-off
-- verdict has no gate to live on, and a late or second verdict decides nothing but must
-- be kept as the card's history. Append-only.

-- CreateEnum
CREATE TYPE "review_verdict_outcome" AS ENUM ('decided', 'recorded', 'late', 'second');

-- AlterEnum
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE 'agent_changes_requested';

-- CreateTable
CREATE TABLE "review_verdict_record" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "gate_id" TEXT,
    "subject_version" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "outcome" "review_verdict_outcome" NOT NULL,
    "summary_md" TEXT,
    "findings_md" TEXT,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "submitted_by_id" TEXT,
    "authority" "approval_gate_authority" NOT NULL DEFAULT 'review_agent',
    "harness" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_verdict_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_verdict_record_workspace_id_idx" ON "review_verdict_record"("workspace_id");

-- CreateIndex
CREATE INDEX "review_verdict_record_project_id_idx" ON "review_verdict_record"("project_id");

-- CreateIndex
CREATE INDEX "review_verdict_record_work_item_id_created_at_idx" ON "review_verdict_record"("work_item_id", "created_at");

-- CreateIndex
CREATE INDEX "review_verdict_record_gate_id_idx" ON "review_verdict_record"("gate_id");

-- CreateIndex
CREATE INDEX "review_verdict_record_submitted_by_id_idx" ON "review_verdict_record"("submitted_by_id");

-- AddForeignKey
ALTER TABLE "review_verdict_record" ADD CONSTRAINT "review_verdict_record_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_verdict_record" ADD CONSTRAINT "review_verdict_record_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_verdict_record" ADD CONSTRAINT "review_verdict_record_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_verdict_record" ADD CONSTRAINT "review_verdict_record_gate_id_fkey" FOREIGN KEY ("gate_id") REFERENCES "approval_gate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_verdict_record" ADD CONSTRAINT "review_verdict_record_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- THE CONCURRENCY BACKSTOP: at most ONE answering verdict (`decided` or `recorded`) per
-- (card, version). Two submissions racing on one version cannot both answer it — the
-- loser hits this index and is kept as `second`. Its column list matches no `@@index` on
-- the model, so Prisma's differ never pairs it (`20260908210000_add_approval_gate`).
CREATE UNIQUE INDEX "review_verdict_record_one_answer_per_version"
  ON "review_verdict_record" ("work_item_id", "subject_version")
  WHERE "outcome" IN ('decided', 'recorded');

-- Tenancy: the row carries its own workspace and its own policy (RLS does not traverse
-- FKs).
ALTER TABLE "review_verdict_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_verdict_record" FORCE ROW LEVEL SECURITY;

CREATE POLICY "review_verdict_record_active_workspace" ON "review_verdict_record"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
