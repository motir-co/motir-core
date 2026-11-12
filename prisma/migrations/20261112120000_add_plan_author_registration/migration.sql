-- Every hand-off and rename a planner's author session registered, kept with the
-- plan (MOTIR-11085).
--
-- `plan_author_registration` is plan-scoped like `plan_raised_gap`: one row per
-- registration, ordered by a gapless per-plan `seq`, named by the planner's own
-- `registration_id`. A registration is written the moment it is made and stamped
-- `relayed_at` once its level's amend has been handed it, so a resumed walk can hand
-- the amend the registrations the dead attempt made. No `workspace_id`: the policies
-- JOIN to the parent `plan`, the `plan_raised_gap` shape.

-- CreateTable
CREATE TABLE "plan_author_registration" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "registration_id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "registered_by" TEXT NOT NULL,
    "level" TEXT,
    "receiver" TEXT,
    "what" TEXT,
    "hand_off_reason" TEXT,
    "rename_from" TEXT,
    "rename_to" TEXT,
    "code_fact" TEXT,
    "relayed_at" TIMESTAMP(3),
    "outcome" TEXT,
    "outcome_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_author_registration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_author_registration_plan_id_registration_id_key" ON "plan_author_registration"("plan_id", "registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "plan_author_registration_plan_id_seq_key" ON "plan_author_registration"("plan_id", "seq");

-- AddForeignKey
ALTER TABLE "plan_author_registration" ADD CONSTRAINT "plan_author_registration_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security (the `plan_raised_gap` pattern, copied)
-- ===========================================================================
ALTER TABLE "plan_author_registration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_author_registration" FORCE ROW LEVEL SECURITY;

-- The workspace gate, FOR ALL, joined through the parent plan. WITH CHECK closes
-- "write a registration onto somebody ELSE's plan". An unset GUC hides every row.
CREATE POLICY "plan_author_registration_active_workspace" ON "plan_author_registration"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_author_registration"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."id" = "plan_author_registration"."plan_id"
        AND p."workspace_id" = current_setting('app.workspace_id', true)
    )
  );

-- The READ-ONLY system arm `plan_raised_gap` carries. `FOR SELECT` only.
CREATE POLICY "plan_author_registration_system_read" ON "plan_author_registration"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
