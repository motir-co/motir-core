-- MOTIR-10546: a `code_grep` read records its MODE. `code_grep` matches literally
-- unless `regex: true` is passed, so `a|b` searched literally finds the three
-- characters `a|b` — a zero that says nothing about `a` or `b`. Without the mode,
-- a check of a plan cannot tell that zero from a true absence.
--
-- Nullable and without a default: every row written before this column, and
-- every read of a tool other than `code_grep`, reads `NULL` — "not said", never
-- a guessed `false`. Additive and metadata-only on Postgres (no rewrite, no
-- backfill), so it is safe ahead of the code that writes it.
ALTER TABLE "plan_code_read" ADD COLUMN "regex" BOOLEAN;
