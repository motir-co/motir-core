-- The platform starter is RENAMED (Story MOTIR-704 · MOTIR-708; decision
-- MOTIR-706 v2, 3.7 step 2): every `project_repository` row storing the old key
-- `nextjs-prisma-vercel-starter` now stores `nextjs-prisma-serverless-starter`.
--
-- WHY. "Serverless" is AWS Lambda (MOTIR-5769 D-2), which rejects Vercel by name,
-- so a starter called "vercel" misleads every person and agent reading a row.
-- The registry entry keeps the old key in `legacy_keys`, so a row written by an
-- instance still running the old code during the rollout resolves to the same
-- entry; this rewrite is what lets that alias be removed later (3.7 step 4,
-- once `SELECT count(*) FROM project_repository WHERE seed_source =
-- 'nextjs-prisma-vercel-starter'` is 0 in production — re-run this first if not).
--
-- IDEMPOTENT and NARROW: it touches `seed_source` alone, on exactly the rows that
-- store the old key; a second run finds none. `initialised` and `organization`
-- rows do not move, no row's matching is re-run, and repositories already
-- generated from the starter keep their own names (a template rename does not
-- reach them). `updated_at` is left alone on purpose: nothing a person did
-- changed the row. Shipped migrations that name the old key (for example
-- `20260819090000_retire_spurious_project_repo_rows`) are history and are not
-- edited.
UPDATE "project_repository"
SET "seed_source" = 'nextjs-prisma-serverless-starter'
WHERE "seed_source" = 'nextjs-prisma-vercel-starter';
