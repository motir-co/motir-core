-- PRODUCTION HOSTING — the application record and its releases (Story MOTIR-9797 ·
-- Subtask MOTIR-10026). ADDITIVE and in ONE step — enums, tables, indexes, FKs
-- and RLS — so it ships in one deploy with no unguarded window.
--
-- `hosted_application` is one row per Motir `project_repository` row (unique),
-- `hosted_release` one row per release of a commit on it. The two release
-- pointers and `workspace.default_application_id` are real FKs modelled on both
-- sides in schema.prisma.
--
-- RLS shape = `repo_deployment`'s: each row carries its own `workspace_id`, and
--   · `<table>_workspace_or_system` (FOR ALL) — the release paths write from the
--     merge webhook and from jobs under withSystemContext (no tenant session), and
--     a member's session (rollback, the Production panel) reads and writes its
--     own workspace's rows.
-- No organisation-tier read arm: nothing reads these rows across the org's
-- workspaces, and an arm nobody needs only widens the surface.

-- CreateEnum
CREATE TYPE "hosted_release_state" AS ENUM ('building', 'releasing', 'live', 'failed', 'replaced', 'rolled_back');

-- CreateEnum
CREATE TYPE "hosted_release_cause" AS ENUM ('merge', 'config_change', 'ref', 'rollback');

-- AlterTable
ALTER TABLE "workspace" ADD COLUMN     "default_application_id" TEXT;

-- CreateTable
CREATE TABLE "hosted_application" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "project_repository_id" TEXT NOT NULL,
    "target" "hosting_target" NOT NULL,
    "slug" TEXT NOT NULL,
    "production_address" TEXT,
    "current_release_id" TEXT,
    "previous_release_id" TEXT,
    "database_project_id" TEXT,
    "database_url_ciphertext" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_release" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "ref" TEXT,
    "cause" "hosted_release_cause" NOT NULL,
    "state" "hosted_release_state" NOT NULL DEFAULT 'building',
    "artifact_ref" TEXT,
    "provider_release_id" TEXT,
    "failure_reason" TEXT,
    "usage_seconds" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "live_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_release_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_application_project_repository_id_key" ON "hosted_application"("project_repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_application_production_address_key" ON "hosted_application"("production_address");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_application_current_release_id_key" ON "hosted_application"("current_release_id");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_application_previous_release_id_key" ON "hosted_application"("previous_release_id");

-- CreateIndex
CREATE INDEX "hosted_application_project_id_idx" ON "hosted_application"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_application_workspace_id_slug_key" ON "hosted_application"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "hosted_release_application_id_created_at_idx" ON "hosted_release"("application_id", "created_at");

-- CreateIndex
CREATE INDEX "hosted_release_workspace_id_idx" ON "hosted_release"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_default_application_id_key" ON "workspace"("default_application_id");

-- AddForeignKey
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_default_application_id_fkey" FOREIGN KEY ("default_application_id") REFERENCES "hosted_application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application" ADD CONSTRAINT "hosted_application_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application" ADD CONSTRAINT "hosted_application_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application" ADD CONSTRAINT "hosted_application_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application" ADD CONSTRAINT "hosted_application_current_release_id_fkey" FOREIGN KEY ("current_release_id") REFERENCES "hosted_release"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application" ADD CONSTRAINT "hosted_application_previous_release_id_fkey" FOREIGN KEY ("previous_release_id") REFERENCES "hosted_release"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_release" ADD CONSTRAINT "hosted_release_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_release" ADD CONSTRAINT "hosted_release_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hosted_application" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosted_application" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hosted_application_workspace_or_system" ON "hosted_application"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

ALTER TABLE "hosted_release" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosted_release" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hosted_release_workspace_or_system" ON "hosted_release"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
