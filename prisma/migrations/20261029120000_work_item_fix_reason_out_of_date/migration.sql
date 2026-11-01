-- Bug MOTIR-10054 — `out_of_date` joins `work_item_fix_reason`.
--
-- A pull request behind a base branch that requires branches to be up to date is
-- refused by the host however green its checks are, and nothing listed it under To
-- fix. It is now a reason of its own, ranked right after `conflicted`: both mean the
-- members cannot land as they stand, and a push that merges the base answers both.
--
-- ⚠️ DECLARATION ORDER IS PRIORITY (`FIX_REASON_PRIORITY`), so the value is placed
-- with `AFTER 'conflicted'` — a bare `ADD VALUE` appends at the END and would rank it
-- below a reviewer's refusal.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION: no table is created and no row
-- is touched. `ADD VALUE IF NOT EXISTS` makes a re-applied migration a no-op.

ALTER TYPE "work_item_fix_reason" ADD VALUE IF NOT EXISTS 'out_of_date' AFTER 'conflicted';
