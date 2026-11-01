-- MOTIR-9978 — a plan can hold its planner's own record (plan.py's settled
-- targets) as data, instead of in the reviewer-facing summary. Additive and
-- nullable: no backfill (NULL means "the planner keeps none"; plan.py moves a
-- legacy record out of the summary on its next write), and no RLS change,
-- because the column sits on `plan`, which is already workspace-scoped.
ALTER TABLE "plan" ADD COLUMN "planner_record" JSONB;
