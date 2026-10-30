-- A production release's GITHUB DEPLOYMENT HANDLE (Story MOTIR-9797 · Subtask
-- MOTIR-10033): the id of the deployment Motir created for the release on its
-- repository, and the last deployment status it posted there. ADDITIVE, nullable
-- columns; the table's RLS (`hosted_release_workspace_or_system`) already covers
-- them. The statuses themselves are stored where every deployment status is —
-- `repo_deployment`, through the `deployment_status` webhook — so this is a
-- handle, not a second status store.

-- AlterTable
ALTER TABLE "hosted_release" ADD COLUMN     "github_deployment_id" TEXT,
ADD COLUMN     "status_posted_state" TEXT;
