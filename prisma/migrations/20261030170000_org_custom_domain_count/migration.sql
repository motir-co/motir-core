-- The organisation-wide custom-domain count the §9 cap reads (MOTIR-10116).
--
-- `entitlementsService.assertCanAddCustomDomain` counts the org's custom
-- domains inside the ADDING workspace's transaction, because the count and the
-- create must serialize under the same org-row lock. That transaction binds
-- `app.workspace_id`, so `public_address_active_workspace` admits only that
-- workspace's rows: the count saw one workspace, and a scaled org (cap 5) with
-- two workspaces could add five domains in each. A raw join on
-- `workspace."organizationId"` is filtered by the same policy, so it is no fix.
--
-- So this one function reads past `public_address`'s policies — the reach comes
-- from the owner's BYPASSRLS attribute, the dependency
-- 20260817120000_link_workspace_trigger_security_definer writes down — and
-- returns ONE number, for ONE organisation: the org that owns the workspace the
-- CALLER'S transaction is already bound to. Binding a workspace context requires
-- the workspace's own RLS to admit the caller, so the function tells a caller
-- only the size of an estate it already belongs to. Any other organisation id,
-- or no bound workspace at all, reads 0 — the same answer the unbound read gave
-- before, so nothing is admitted that was not admitted before.
--
-- A COUNT, not a widened read arm: an org-scoped SELECT policy on
-- `public_address` would hand every workspace of the org its siblings' hostnames
-- and verification tokens, which the cap does not need.

CREATE OR REPLACE FUNCTION app_org_custom_domain_count(target_organization_id text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*)
    FROM "public_address" pa
    JOIN "workspace" w ON w."id" = pa."workspace_id"
   WHERE pa."kind" = 'custom_domain'
     AND w."organizationId" = target_organization_id
     AND EXISTS (
       SELECT 1
         FROM "workspace" bound
        WHERE bound."id" = current_setting('app.workspace_id', true)
          AND bound."organizationId" = target_organization_id
     )
$$;

COMMENT ON FUNCTION app_org_custom_domain_count(text) IS
  'MOTIR-10116: custom domains across every workspace of the organisation owning the bound workspace; 0 for any other organisation or with no workspace bound.';
