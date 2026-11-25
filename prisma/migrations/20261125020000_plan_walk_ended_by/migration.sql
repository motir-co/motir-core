-- How a walk that left cards laid ended on purpose (Story MOTIR-12203 · MOTIR-12207).
-- A nullable column with no default and no backfill: every existing plan reads
-- NULL, which is "not a deliberate end" — exactly what those plans were.
CREATE TYPE "plan_walk_ended_by" AS ENUM ('cadence', 'person_stop');

ALTER TABLE "plan" ADD COLUMN "walk_ended_by" "plan_walk_ended_by";
