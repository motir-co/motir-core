-- MOTIR-11266 — a person can SKIP the plan's final check while it runs, and the skip
-- travels the plan-change mailbox as its own kind, beside `stop`.
--
-- It is a third KIND of the same mailbox, never a second channel: a skip, a stop and
-- the turns typed before them share one `seq` per job, so motir-ai reads them in the
-- order they were made. The entry carries no body and no disposition, as a stop does.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE policy; this
-- migration creates no table and touches no row. `plan_change_mailbox_entry` keeps the
-- workspace-scoped policy `20260903050000_plan_change_mailbox` gave it.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent, so a re-applied migration is a no-op.
-- Postgres appends the value at the end of the enum's sort order; nothing orders
-- entries by kind (`seq` is the order), so the position carries no meaning.

ALTER TYPE "plan_change_mailbox_kind" ADD VALUE IF NOT EXISTS 'skip_final_check';
