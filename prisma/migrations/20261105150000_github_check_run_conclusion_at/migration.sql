-- MOTIR-10456: the provider's own time for the state a check row holds, so a late
-- `pending` delivery can no longer overwrite a terminal conclusion it predates.
-- Nullable and additive: existing rows carry no time and keep last-write-wins.
ALTER TABLE "github_check_run" ADD COLUMN "conclusion_at" TIMESTAMP(3);
