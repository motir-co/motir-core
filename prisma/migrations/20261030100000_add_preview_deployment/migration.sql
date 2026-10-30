-- MOTIR'S OWN PREVIEWS of pull requests (Story MOTIR-5766 · Subtask MOTIR-5772).
-- ADDITIVE and in ONE step — enum + table + indexes + FKs + RLS — so it ships in
-- one deploy with no unguarded window.
--
-- `preview_deployment` is Motir's OPERATING record (what it started, where it
-- lives, its MOTIR-5769 §9 state); `repo_deployment` stays the display store of
-- what a host reports, and nothing here touches it.
--
-- RLS shape = `repo_deployment`'s (20260913130000), for the same reason: the
-- webhook lifecycle and the reaper write under withSystemContext (a delivery
-- has no tenant session), a tenant reader sees its own workspace's rows, and an
-- organisation-tier caller reads the rows of its organisation's repositories
-- through the uncorrelated `(SELECT app_caller_organization_id())` InitPlan.

-- CreateEnum
CREATE TYPE "PreviewDeploymentState" AS ENUM ('building', 'starting', 'ready', 'failed', 'closed');

-- CreateTable
CREATE TABLE "preview_deployment" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "pull_request_number" INTEGER NOT NULL,
    "head_sha" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "state" "PreviewDeploymentState" NOT NULL DEFAULT 'building',
    "failure_reason" TEXT,
    "fly_app_name" TEXT,
    "fly_machine_id" TEXT,
    "neon_project_id" TEXT,
    "neon_branch_id" TEXT,
    "github_deployment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "preview_deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "preview_deployment_host_key" ON "preview_deployment"("host");

-- CreateIndex
CREATE INDEX "preview_deployment_state_updated_at_idx" ON "preview_deployment"("state", "updated_at");

-- CreateIndex
CREATE INDEX "preview_deployment_workspace_id_idx" ON "preview_deployment"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "preview_deployment_repo_id_pull_request_number_key" ON "preview_deployment"("repo_id", "pull_request_number");

-- AddForeignKey
ALTER TABLE "preview_deployment" ADD CONSTRAINT "preview_deployment_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_deployment" ADD CONSTRAINT "preview_deployment_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "preview_deployment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preview_deployment" FORCE ROW LEVEL SECURITY;

CREATE POLICY "preview_deployment_workspace_or_system" ON "preview_deployment"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

CREATE POLICY "preview_deployment_org_read" ON "preview_deployment"
  FOR SELECT
  USING (
    "repo_id" IN (
      SELECT r."id" FROM "github_repo" r
       WHERE r."organization_id" = (SELECT app_caller_organization_id())
          OR r."organization_id" = (SELECT current_setting('app.organization_id', true))
    )
  );
