-- MOTIR-11256 — the amend, the final check and the fix report their own step.
--
-- A laid level's amend ran through the lay session and reported `lay`, the
-- plan's final check (the code's "dry run") reported no step at all, and the fix
-- after it reported an untargeted `lay` — so the planning notes headed all three
-- as laying. Each now has its own kind, on the in-flight step (and the narration
-- that keys on it) and on a failed walk's stop point.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE policy;
-- this migration creates no table and touches no row.
--
-- EXPAND ONLY. A stored `lay` step is not rewritten (a plan recorded before the
-- change reads as it did), and the release before this one never reads the new
-- values: it refuses a step it does not know at the door, before a row is
-- written. `ADD VALUE IF NOT EXISTS` is idempotent; the values append to the
-- enum's sort order, which nothing orders by.

ALTER TYPE "plan_step_kind" ADD VALUE IF NOT EXISTS 'amend';
ALTER TYPE "plan_step_kind" ADD VALUE IF NOT EXISTS 'check';
ALTER TYPE "plan_step_kind" ADD VALUE IF NOT EXISTS 'repair';

ALTER TYPE "plan_session_walk_phase" ADD VALUE IF NOT EXISTS 'amend';
ALTER TYPE "plan_session_walk_phase" ADD VALUE IF NOT EXISTS 'check';
ALTER TYPE "plan_session_walk_phase" ADD VALUE IF NOT EXISTS 'repair';
