-- ===========================================================================
-- PROMOTE-TO-STARTER (Story MOTIR-704 · MOTIR-710; decision MOTIR-706 v2 §3.6).
--
-- 1. `promoted_ref` — the COMMIT an entry was promoted at. `promoted_from` names
--    the source row; the pair is what makes a re-promotion of the same source at
--    the same ref an UPDATE of that entry rather than a second one, so it is
--    unique where both are set (a registered entry has neither).
--
-- 2. Two `platform_staff` READ arms, for the one console read promotion makes
--    across tenants: the source `project_repository` row and the `github_repo`
--    it realised. The operator names a row in any workspace, so no tenant
--    binding exists to narrow by. The predicate is the estate arms' verbatim
--    (`20261001200000_platform_staff_estate_read_arms`): a constant per row, no
--    subquery. SELECT ONLY, and `app.platform_staff` — never the system-admin
--    GUC, which the job runtime binds (`docs/decisions/platform-staff-auth.md`
--    §3a). No tenant policy is altered; these are additional PERMISSIVE arms.
-- ===========================================================================

ALTER TABLE "seed_registry_entry" ADD COLUMN "promoted_ref" TEXT;

CREATE UNIQUE INDEX "seed_registry_entry_promoted_from_promoted_ref_key"
  ON "seed_registry_entry"("promoted_from", "promoted_ref");

CREATE POLICY "project_repository_platform_staff_read" ON "project_repository"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');

CREATE POLICY "github_repo_platform_staff_read" ON "github_repo"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');
