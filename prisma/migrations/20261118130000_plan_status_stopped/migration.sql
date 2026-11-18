-- MOTIR-11701 — a walk that ends before every card is written closes its plan
-- `stopped`, never `planned`, and its session waits in To resume.
--
-- `plan_status.stopped`: the close writes it instead of `planned` when any card
-- the walk owes is not written (the person's Stop, a failed author session, a
-- limit, a crash). It raises no approval gate and every approve door refuses it;
-- Resume moves it back to `generating`, and Decline ends it.
--
-- `plan_session_failure_reason.stopped`: the reason the stopped close records on
-- the plan's session, so the session reads failed-waiting and offers the
-- failed-attempt Resume (Story MOTIR-7905) on the same plan.
--
-- Additive and non-breaking: no existing row changes, and no backfill is owed.
-- ⚠️ NO RLS CLAUSE HERE: no table is created and no row is touched; `plan` and
-- `plan_change_session` keep their workspace policies. `ADD VALUE IF NOT EXISTS`
-- is idempotent, so a re-applied migration is a no-op. Postgres appends each
-- value at the end of its enum's sort order, which is where the schema lists it.

ALTER TYPE "plan_status" ADD VALUE IF NOT EXISTS 'stopped';
ALTER TYPE "plan_session_failure_reason" ADD VALUE IF NOT EXISTS 'stopped';
