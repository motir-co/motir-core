-- MOTIR-10235 — a conversation note finds its owner by the job alone, on every POST.

-- CreateIndex
CREATE INDEX "plan_change_turn_workspace_id_job_id_idx" ON "plan_change_turn"("workspace_id", "job_id");

-- CreateIndex
CREATE INDEX "sharpen_turn_workspace_id_job_id_idx" ON "sharpen_turn"("workspace_id", "job_id");
