-- MOTIR-12204 — the "Planning cadence" setting, stored on the project.
--
-- NULLABLE, with NO DEFAULT, deliberately — the shape of `ai_final_check`
-- (20261114130000) and for the same reasons. NULL means "this project has never
-- expressed a preference", and every reader resolves NULL to 'story' through
-- `resolvePlanningCadence` (lib/projectAiSettings/limits.ts). So every project
-- that existed before this migration keeps today's walk, with no backfill step to
-- miss rows, and a test can construct the "predates the column" state and assert
-- the default.
--
-- Only an explicit 'subtask' changes how far the planner plans. Adding a nullable
-- column with no default is a metadata-only change in Postgres: no table rewrite,
-- no lock held beyond the catalog update. This migration updates no row.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE policy;
-- this migration adds a column to a table whose policy already covers it.
CREATE TYPE "AiPlanningCadence" AS ENUM ('story', 'subtask');

ALTER TABLE "project" ADD COLUMN "ai_planning_cadence" "AiPlanningCadence";
