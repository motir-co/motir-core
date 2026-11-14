-- MOTIR-11289 (Story MOTIR-11283) — release every motir.site claim held by a
-- workspace with no Motir repository.
--
-- `docs/decisions/public-tenant-addresses.md` §8 AMENDMENT 5: only a workspace
-- with a Motir repository may claim or rename its `motir.site` name, and the
-- claims already held when the amendment lands by a workspace without one are
-- released ONCE, here, at deploy. In production that is
-- `verify-20261114.motir.site`; this file keys on the RULE, never on a hostname
-- or a workspace id, so it is a no-op wherever no such claim exists.
--
-- THE PREDICATE, restated from `projectRepoRepository.hasMotirRepositoryInWorkspace`
-- in the same order. A workspace has a Motir repository when it holds a
-- `project_repository` row with:
--   1. `seed_source` <> 'organization'   (an imported repository is the customer's)
--   2. `state` = 'created'               (only the creation primitive reaches it)
--   3. `takeover_state` IS NULL, or not 'awaiting_reinstall' / 'done'
--                                        (a takeover has not transferred it)
-- ⚠️ The NULL arm is the rule: NULL is "no takeover ever requested", and a bare
-- `NOT IN` yields NULL for it, which would count every untransferred repository
-- as absent.
--
-- WHAT IT WRITES: NOTHING. No `public_hostname_reservation` row (no 90-day
-- quarantine) and no `public_subdomain_change` row, so the label is claimable at
-- once and the workspace's 30-day change limit is untouched. A quarantine
-- protects the readers of a name that served someone (Amendment 3 rule 3); a
-- stray claim never served anyone — the same reasoning as rule 3's
-- under-24-hours case. Only `workspace_subdomain` rows are deleted: legacy
-- `workspace_subdomain_alias` rows and custom domains are not touched.
--
-- RLS: `public_address` and `project_repository` are both FORCE ROW LEVEL
-- SECURITY. This block does not lean on the migration role being the BYPASSRLS
-- owner: it binds `app.system_admin` transaction-locally (`set_config(…, true)`)
-- for the one statement, which `public_address_system` (FOR ALL, so DELETE) and
-- `project_repository_system_read` (FOR SELECT, so the subquery sees every row)
-- admit. Without it, under the non-bypass runtime role the subquery would see NO
-- repository and the delete would remove every claim in the database. The
-- integration test replays the file under both roles.
--
-- IDEMPOTENT: a second run finds nothing to delete. One `DO` block, so the file
-- is a single statement the test replays verbatim; `RAISE NOTICE` makes the
-- deploy log the report. No schema change.
DO $$
DECLARE
  released integer;
BEGIN
  PERFORM set_config('app.system_admin', 'true', true);

  DELETE FROM "public_address" pa
   WHERE pa."kind" = 'workspace_subdomain'
     AND NOT EXISTS (
       SELECT 1
         FROM "project_repository" pr
        WHERE pr."workspace_id" = pa."workspace_id"
          AND pr."seed_source" <> 'organization'
          AND pr."state" = 'created'
          AND (pr."takeover_state" IS NULL
               OR pr."takeover_state" NOT IN ('awaiting_reinstall', 'done'))
     );
  GET DIAGNOSTICS released = ROW_COUNT;

  PERFORM set_config('app.system_admin', '', true);

  RAISE NOTICE 'MOTIR-11289: released % motir.site claim(s) held by a workspace with no Motir repository',
    released;
END $$;
