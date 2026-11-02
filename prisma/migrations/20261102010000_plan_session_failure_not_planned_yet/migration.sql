-- MOTIR-10209 — a failure record keeps the halted walk's "not planned yet" lines.
--
-- A hosted planning job that halts writes no plan briefing, so the lines that say
-- which cards were left unplanned (and why) travel on its terminal Problem as
-- `walkStop.notPlannedYet`. Core parsed the walk stop with a strict object and
-- dropped them. `failure_not_planned_yet` stores them, verbatim and in order.
-- NOT NULL DEFAULT '{}': an existing failure (and any record motir-ai sent no lines
-- for) holds an empty list, which renders exactly as it always did.

ALTER TABLE "plan_change_session"
  ADD COLUMN "failure_not_planned_yet" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
