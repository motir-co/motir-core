-- BACKFILL `github_repo.indexed_at` FROM THE SUCCEEDED-INDEX LEDGER
-- Bug MOTIR-10171.
--
-- Every index state (`never | indexing | indexed | stale`) now reads whether a
-- graph exists off the repository ROW (`hasBuiltGraph`: `indexed_at IS NOT
-- NULL`), the same column the surfaces print beside it — no longer off the
-- `output.repoRef` of a succeeded `system.code-graph-index` run. The two
-- disagreed because the settle stamped the row only when it knew the head the
-- run started at, so an index that succeeded before anybody had pushed left the
-- ledger saying "indexed" and the row saying nothing. `get_code_health` answered
-- `indexed` with `indexedAt: null`. The settle now stamps `indexed_at` on every
-- success.
--
-- ⚠️ THIS IS WHAT KEEPS THE SWITCH FROM UN-INDEXING A REPOSITORY. A row the old
-- settle skipped has a real graph and no stamp; without this UPDATE it would read
-- `never` after deploy. It is stamped with the finish time of the newest
-- succeeded index run that names it — the time the graph was last built, which is
-- what `indexed_at` means — matched on the ORGANISATION the run's workspace
-- belongs to, because `owner/name` alone is not unique across tenants
-- (MOTIR-9177). The retention sweep keeps the newest succeeded run per
-- repository (MOTIR-6935), so that run is still present.
--
-- Only NULL rows are touched, and a re-run changes nothing. `indexed_head_sha` is
-- left alone: the ledger never recorded a sha, and inventing one would claim a
-- comparison nobody made. Migrations run as the BYPASSRLS owner, so neither
-- table's RLS narrows the read.

UPDATE "github_repo" AS r
   SET "indexed_at" = s."built_at"
  FROM (
    SELECT w."organizationId"                              AS "organization_id",
           jr."output"->>'repoRef'                         AS "repo_ref",
           MAX(COALESCE(jr."finished_at", jr."started_at")) AS "built_at"
      FROM "job_run" AS jr
      JOIN "workspace" AS w ON w."id" = jr."workspace_id"
     WHERE jr."function_id" = 'system.code-graph-index'
       AND jr."status" = 'succeeded'
       AND jr."output"->>'repoRef' IS NOT NULL
     GROUP BY w."organizationId", jr."output"->>'repoRef'
  ) AS s
 WHERE r."indexed_at" IS NULL
   AND r."organization_id" = s."organization_id"
   AND r."owner" || '/' || r."name" = s."repo_ref";
