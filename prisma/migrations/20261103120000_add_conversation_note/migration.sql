-- MOTIR-10235 — a conversation job's plain-language NOTES (a Grill me read, an
-- answering session), kept against the conversation the job was submitted for,
-- so a person who leaves and comes back sees what the job said it was doing.
-- Append-only kept history; the owner's cascade is the only delete.

-- CreateTable
CREATE TABLE "conversation_note" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "sharpen_session_id" TEXT,
    "plan_change_session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_note_workspace_id_idx" ON "conversation_note"("workspace_id");

-- CreateIndex
CREATE INDEX "conversation_note_sharpen_session_id_idx" ON "conversation_note"("sharpen_session_id");

-- CreateIndex
CREATE INDEX "conversation_note_plan_change_session_id_idx" ON "conversation_note"("plan_change_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_note_job_id_seq_key" ON "conversation_note"("job_id", "seq");

-- AddForeignKey
ALTER TABLE "conversation_note" ADD CONSTRAINT "conversation_note_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_note" ADD CONSTRAINT "conversation_note_sharpen_session_id_fkey" FOREIGN KEY ("sharpen_session_id") REFERENCES "sharpen_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_note" ADD CONSTRAINT "conversation_note_plan_change_session_id_fkey" FOREIGN KEY ("plan_change_session_id") REFERENCES "plan_change_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Exactly one owner: the Grill me session, or the plan-change conversation.
ALTER TABLE "conversation_note" ADD CONSTRAINT "conversation_note_owner_check" CHECK (
  ("sharpen_session_id" IS NOT NULL) <> ("plan_change_session_id" IS NOT NULL)
);

-- Tenancy: the row carries its own workspace and its own policy (RLS does not
-- traverse FKs).
ALTER TABLE "conversation_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_note" FORCE ROW LEVEL SECURITY;

CREATE POLICY "conversation_note_active_workspace" ON "conversation_note"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
