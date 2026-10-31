-- Every code read a planner session made, kept with the plan (MOTIR-10122).
--
-- `plan_code_read` is APPEND-ONLY and plan-scoped like `plan_narration`: one row
-- per read, ordered by a gapless per-plan `seq`, keyed by the session's opaque
-- key. It holds what was asked, the commit it was read at and how much came back
-- — never file contents. No FK to `plan_step`, and no `workspace_id`: the
-- policies JOIN to the parent `plan`, the `plan_narration` shape.

-- CreateTable
CREATE TABLE "plan_code_read" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "repo" TEXT,
    "path" TEXT,
    "start_line" INTEGER,
    "end_line" INTEGER,
    "asked_ref" TEXT,
    "query" TEXT,
    "commits" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "lines" INTEGER,
    "hits" INTEGER,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_code_read_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_code_read_plan_id_session_key_idx" ON "plan_code_read"("plan_id", "session_key");

-- CreateIndex
CREATE UNIQUE INDEX "plan_code_read_plan_id_seq_key" ON "plan_code_read"("plan_id", "seq");

-- AddForeignKey
ALTER TABLE "plan_code_read" ADD CONSTRAINT "plan_code_read_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (the `plan_narration` pattern, copied)
-- ===========================================================================
ALTER TABLE "plan_code_read" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_code_read" FORCE ROW LEVEL SECURITY;

-- The workspace gate, FOR ALL, joined through the parent plan. WITH CHECK closes
-- "write a read onto somebody ELSE's plan". An unset GUC hides every row.
CREATE POLICY "plan_code_read_active_workspace" ON "plan_code_read"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_code_read"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_code_read"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- The READ-ONLY system arm `plan_narration` carries. `FOR SELECT` only.
CREATE POLICY "plan_code_read_system_read" ON "plan_code_read"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
