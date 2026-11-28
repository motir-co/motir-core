-- The SCIP upload credential Motir installed in a Motir-hosted repository's own
-- Actions (MOTIR-12339 · story MOTIR-12262). It holds the code graph's CREDENTIAL ID,
-- never a token: the token lives only in the repository's Actions secret. ADDITIVE:
-- one NULLABLE column on an existing tenant table, nothing backfilled, and no policy
-- changes — `project_repository`'s RLS covers the new column.
ALTER TABLE "project_repository"
  ADD COLUMN "scip_upload_installed_credential_id" TEXT;
