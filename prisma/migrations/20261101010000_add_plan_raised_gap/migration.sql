-- Every gap a planner's author session raised, kept with the plan (MOTIR-10176).
--
-- `plan_raised_gap` is plan-scoped like `plan_code_read`: one row per gap, ordered
-- by a gapless per-plan `seq`, named by the planner's own `gap_id`. A gap is written
-- the moment it is raised and stamped `amended_at` once its level's amend has been
-- handed it, so a resumed walk can hand the amend the gaps the dead attempt raised.
-- No `workspace_id`: the policies JOIN to the parent `plan`, the `plan_narration` shape.

-- CreateTable
CREATE TABLE "plan_raised_gap" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "gap_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "level" TEXT,
    "raised_by" TEXT,
    "what" TEXT NOT NULL,
    "decision" TEXT,
    "after" TEXT,
    "before" TEXT,
    "note" TEXT,
    "amended_at" TIMESTAMP(3),
    "answer_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "answer_open" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_raised_gap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_raised_gap_plan_id_gap_id_key" ON "plan_raised_gap"("plan_id", "gap_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_raised_gap_plan_id_seq_key" ON "plan_raised_gap"("plan_id", "seq");

-- AddForeignKey
ALTER TABLE "plan_raised_gap" ADD CONSTRAINT "plan_raised_gap_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (the `plan_code_read` pattern, copied)
-- ===========================================================================
ALTER TABLE "plan_raised_gap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_raised_gap" FORCE ROW LEVEL SECURITY;

-- The workspace gate, FOR ALL, joined through the parent plan. WITH CHECK closes
-- "write a gap onto somebody ELSE's plan". An unset GUC hides every row.
CREATE POLICY "plan_raised_gap_active_workspace" ON "plan_raised_gap"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_raised_gap"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_raised_gap"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- The READ-ONLY system arm `plan_code_read` carries. `FOR SELECT` only.
CREATE POLICY "plan_raised_gap_system_read" ON "plan_raised_gap"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
