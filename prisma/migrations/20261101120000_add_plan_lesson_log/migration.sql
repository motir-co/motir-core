-- Every lesson call a planner session made, kept with the plan (MOTIR-10191).
--
-- `plan_lesson_call` is APPEND-ONLY and plan-scoped like `plan_code_read`: one row
-- per call (a search with its ranked result ids, a reinforce or add, a hosted
-- session's injected ids), ordered by a gapless per-plan `seq`, keyed by the
-- session's opaque key. Ids only, never a lesson's text.
--
-- `plan_lesson_session` marks each session whose lesson log was recorded at all, so
-- an empty log reads "made no lesson call" rather than "not recorded".
--
-- Neither has a `workspace_id` or an FK to `plan_step`: the policies JOIN to the
-- parent `plan`, the `plan_narration` shape.

-- CreateTable
CREATE TABLE "plan_lesson_call" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "query" TEXT,
    "filters" JSONB NOT NULL,
    "lesson_ids" JSONB NOT NULL,
    "lesson_id" TEXT,
    "occurrence_ref" TEXT,
    "outcome" TEXT NOT NULL,
    "counted" BOOLEAN,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_lesson_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_lesson_session" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "first_report_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_report_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_lesson_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_lesson_call_plan_id_session_key_idx" ON "plan_lesson_call"("plan_id", "session_key");

-- CreateIndex
CREATE UNIQUE INDEX "plan_lesson_call_plan_id_seq_key" ON "plan_lesson_call"("plan_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "plan_lesson_session_plan_id_session_key_key" ON "plan_lesson_session"("plan_id", "session_key");

-- AddForeignKey
ALTER TABLE "plan_lesson_call" ADD CONSTRAINT "plan_lesson_call_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_lesson_session" ADD CONSTRAINT "plan_lesson_session_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (the `plan_code_read` pattern, copied for both tables)
-- ===========================================================================
ALTER TABLE "plan_lesson_call" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_lesson_call" FORCE ROW LEVEL SECURITY;
ALTER TABLE "plan_lesson_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_lesson_session" FORCE ROW LEVEL SECURITY;

-- The workspace gate, FOR ALL, joined through the parent plan. WITH CHECK closes
-- "write a call onto somebody ELSE's plan". An unset GUC hides every row.
CREATE POLICY "plan_lesson_call_active_workspace" ON "plan_lesson_call"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_lesson_call"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_lesson_call"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

CREATE POLICY "plan_lesson_session_active_workspace" ON "plan_lesson_session"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_lesson_session"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_lesson_session"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- The READ-ONLY system arm `plan_code_read` carries. `FOR SELECT` only.
CREATE POLICY "plan_lesson_call_system_read" ON "plan_lesson_call"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "plan_lesson_session_system_read" ON "plan_lesson_session"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
