-- THE EXPIRING NAME HOLD — Story MOTIR-4528 · Subtask MOTIR-9506.
--
-- `docs/decisions/public-tenant-addresses.md` §8 Amendment 3 retires the
-- reservation held for ever. A released or renamed subdomain is now held for 90
-- days (or not at all, if it was held under 24 hours), and a workspace may change
-- its name once per 30 days. Two additive halves, read by nothing until the
-- rebuilt subdomain service ships later in the same story:
--
--   1. `public_hostname_reservation.expires_at`, with the one RLS arm an
--      expiring row needs: a tenant may refresh a LAPSED row or its OWN row.
--   2. `public_subdomain_change`, the per-workspace change ledger, and its RLS.

-- 1. The expiry ------------------------------------------------------------------
--
-- Backfilled to `retired_at + 90 days`, the row's only timestamp, so no dormant
-- reservation becomes claimable earlier than the new rules allow. There are no
-- customers yet (the story, 2026-09-04), so this is conservative rather than
-- load-bearing.
ALTER TABLE "public_hostname_reservation" ADD COLUMN "expires_at" TIMESTAMP(3);
UPDATE "public_hostname_reservation" SET "expires_at" = "retired_at" + INTERVAL '90 days';
ALTER TABLE "public_hostname_reservation" ALTER COLUMN "expires_at" SET NOT NULL;

-- REFRESH: an UPDATE arm for tenant callers, which the table never had.
--
-- `reserveMany` writes with `ON CONFLICT (hostname_hash) DO UPDATE`, and must be
-- able to raise the expiry of a digest whose row has LAPSED but not yet been
-- swept, or the name would be left free. Under RLS the conflicting row must pass
-- an UPDATE `USING`; this admits exactly the two rows the repository's own
-- `WHERE` targets: one that protects nothing any more, and one the caller wrote.
-- `WITH CHECK` keeps the insert arm's rule, so a refreshed row is always
-- attributed to the workspace that refreshed it.
CREATE POLICY "public_hostname_reservation_refresh" ON "public_hostname_reservation"
  FOR UPDATE
  USING (
    "expires_at" <= now()
    OR "retired_from_workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK ("retired_from_workspace_id" = current_setting('app.workspace_id', true));

-- The daily sweep and every operator path still run under the system arm, which
-- is FOR ALL; nothing here widens what a tenant can delete.

-- 2. The change ledger -------------------------------------------------------------
CREATE TABLE "public_subdomain_change" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "last_changed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_subdomain_change_pkey" PRIMARY KEY ("id")
);

-- One row per workspace: the unique is what makes the upsert a single statement.
CREATE UNIQUE INDEX "public_subdomain_change_workspace_id_key" ON "public_subdomain_change"("workspace_id");

-- CASCADE: the limit is per workspace, and a deleted workspace has nothing left
-- to limit. The workspace delete (and both erasure sweeps that route through it)
-- therefore succeeds with a ledger row present.
ALTER TABLE "public_subdomain_change" ADD CONSTRAINT "public_subdomain_change_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Workspace-scoped, read and write: every caller is the rename or release inside
-- a `withWorkspaceContext` transaction bound to the workspace it changes. The
-- workspace RLS migration's `ALTER DEFAULT PRIVILEGES` grants the app role.
ALTER TABLE "public_subdomain_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_subdomain_change" FORCE ROW LEVEL SECURITY;

CREATE POLICY "public_subdomain_change_active_workspace" ON "public_subdomain_change"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- The operator arm, for the jobs runtime and operator tooling only.
CREATE POLICY "public_subdomain_change_system" ON "public_subdomain_change"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
