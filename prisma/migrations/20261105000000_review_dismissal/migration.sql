-- Story MOTIR-10327 · MOTIR-10334 — a person DISMISSES a standing agent send-back
-- (`approval-gates.md` §12.15). Append-only history beside `review_verdict_record`.

-- CreateTable
CREATE TABLE "review_dismissal" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "review_verdict_record_id" TEXT,
    "approval_gate_id" TEXT,
    "subject_version" TEXT NOT NULL,
    "reason_md" TEXT NOT NULL,
    "dismissed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_dismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_dismissal_workspace_id_idx" ON "review_dismissal"("workspace_id");

-- CreateIndex
CREATE INDEX "review_dismissal_project_id_idx" ON "review_dismissal"("project_id");

-- CreateIndex
CREATE INDEX "review_dismissal_review_verdict_record_id_idx" ON "review_dismissal"("review_verdict_record_id");

-- CreateIndex
CREATE INDEX "review_dismissal_approval_gate_id_idx" ON "review_dismissal"("approval_gate_id");

-- CreateIndex
CREATE INDEX "review_dismissal_dismissed_by_id_idx" ON "review_dismissal"("dismissed_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_dismissal_work_item_id_subject_version_key" ON "review_dismissal"("work_item_id", "subject_version");

-- AddForeignKey
ALTER TABLE "review_dismissal" ADD CONSTRAINT "review_dismissal_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_dismissal" ADD CONSTRAINT "review_dismissal_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_dismissal" ADD CONSTRAINT "review_dismissal_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_dismissal" ADD CONSTRAINT "review_dismissal_review_verdict_record_id_fkey" FOREIGN KEY ("review_verdict_record_id") REFERENCES "review_verdict_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_dismissal" ADD CONSTRAINT "review_dismissal_approval_gate_id_fkey" FOREIGN KEY ("approval_gate_id") REFERENCES "approval_gate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_dismissal" ADD CONSTRAINT "review_dismissal_dismissed_by_id_fkey" FOREIGN KEY ("dismissed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A dismissal dismisses EXACTLY ONE send-back: a gate-off record or a decided gate.
ALTER TABLE "review_dismissal" ADD CONSTRAINT "review_dismissal_one_send_back"
  CHECK (num_nonnulls("review_verdict_record_id", "approval_gate_id") = 1);

-- Tenancy: the row carries its own workspace and its own policy (RLS does not traverse
-- FKs).
ALTER TABLE "review_dismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_dismissal" FORCE ROW LEVEL SECURITY;

CREATE POLICY "review_dismissal_active_workspace" ON "review_dismissal"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
