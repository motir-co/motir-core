-- MOTIR-9523 · a customer domain is a WORKSPACE asset naming at most one
-- application (ADR MOTIR-9521 §1, MOTIR-9790 §3). It no longer belongs to a
-- project, and a project no longer has a primary address: the product's single
-- link is the application's production address, else its earliest-issued domain.
--
-- No backfill: no customer domain has ever been verified in production (the
-- add/verify pane shipped behind the edge that MOTIR-9521 replaces), so every
-- existing row is left unbound (`application_id` NULL) and is re-pointed by its
-- workspace with PATCH {applicationId}.
--
-- Rollback: re-add `public_address.project_id` (CASCADE to project) and
-- `project.primary_address_id` (SET NULL), their two indexes, and restore the
-- `public_address_public_read` policy from
-- 20260928000100_public_read_policies_on_access_mode. The project a domain
-- named is not recoverable from this schema; every row comes back unbound.

-- The anonymous read policy depends on `project_id`, so it is replaced before
-- the column goes. A custom domain is admitted only once its certificate is
-- issued — the host contract never answers for a domain mid-verification. The
-- workspace-subdomain arm is unchanged.
DROP POLICY "public_address_public_read" ON "public_address";

-- DropForeignKey
ALTER TABLE "project" DROP CONSTRAINT "project_primary_address_id_fkey";

-- DropForeignKey
ALTER TABLE "public_address" DROP CONSTRAINT "public_address_project_id_fkey";

-- DropIndex
DROP INDEX "project_primary_address_id_idx";

-- DropIndex
DROP INDEX "public_address_project_id_idx";

-- AlterTable
ALTER TABLE "project" DROP COLUMN "primary_address_id";

-- AlterTable
ALTER TABLE "public_address" DROP COLUMN "project_id",
ADD COLUMN     "application_id" TEXT;

-- CreateIndex
CREATE INDEX "public_address_application_id_idx" ON "public_address"("application_id");

-- AddForeignKey
ALTER TABLE "public_address" ADD CONSTRAINT "public_address_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE POLICY "public_address_public_read" ON "public_address"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND (
      CASE
        WHEN "kind" = 'custom_domain' THEN "status" = 'issued'
        ELSE EXISTS (SELECT 1 FROM "project" p WHERE p."workspaceId" = "public_address"."workspace_id" AND p."access_mode" = 'public')
      END
    )
  );
