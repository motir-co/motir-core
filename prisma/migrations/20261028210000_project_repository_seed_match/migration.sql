-- HOW the seed matching chose a row's seed (Story MOTIR-704 · MOTIR-709; decision
-- MOTIR-706 v2 §3.5): `matched`, `no_stack_signal`, `no_target` or `no_match`,
-- written by the repo-set proposer beside the key it chose, so a fallback is
-- never shown as a match. ADDITIVE and nullable: every existing row reads NULL,
-- which is the honest answer — nothing matched it — and a person's re-point
-- writes NULL too. A plain TEXT column, like `proposal_signal`: the vocabulary is
-- checked at the one writer (`projectRepoSetService`). The table's RLS policies
-- already cover every column.
ALTER TABLE "project_repository" ADD COLUMN "seed_match" TEXT;
