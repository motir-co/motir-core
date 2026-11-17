-- MOTIR-11585 — a board's swimlane group-by gains the work-item fields every card
-- already carries: reporter, type, difficulty, executor, kind, label, component
-- and repository.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE policy;
-- this migration creates no table and touches no row. `board` keeps its policy.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent, so a re-applied migration is a no-op.
-- Postgres appends each value at the end of the enum's sort order; nothing orders
-- boards by their grouping, so the position carries no meaning.

ALTER TYPE "board_swimlane_group_by" ADD VALUE IF NOT EXISTS 'reporter';
ALTER TYPE "board_swimlane_group_by" ADD VALUE IF NOT EXISTS 'type';
ALTER TYPE "board_swimlane_group_by" ADD VALUE IF NOT EXISTS 'difficulty';
ALTER TYPE "board_swimlane_group_by" ADD VALUE IF NOT EXISTS 'executor';
ALTER TYPE "board_swimlane_group_by" ADD VALUE IF NOT EXISTS 'kind';
ALTER TYPE "board_swimlane_group_by" ADD VALUE IF NOT EXISTS 'label';
ALTER TYPE "board_swimlane_group_by" ADD VALUE IF NOT EXISTS 'component';
ALTER TYPE "board_swimlane_group_by" ADD VALUE IF NOT EXISTS 'repository';
