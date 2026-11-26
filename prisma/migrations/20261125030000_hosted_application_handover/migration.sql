-- THE HANDOVER STATES (Story MOTIR-9800 · MOTIR-12126): the records the takeover
-- handover reads and writes. Expand-only: columns and tables are added, nothing
-- is renamed or dropped. No column holds a credential, a payment detail, a root
-- credential or a database URL.

-- ── hosted_application: its handover state ───────────────────────────────────
-- CreateEnum
CREATE TYPE "hosted_application_state" AS ENUM ('live', 'handing_over', 'grace', 'handed_over');

-- AlterTable. `state` has a DATABASE default, so every existing row and the raw
-- `INSERT` of `hostedApplicationRepository.insertIfAbsent` read `live`.
ALTER TABLE "hosted_application"
  ADD COLUMN "state" "hosted_application_state" NOT NULL DEFAULT 'live',
  ADD COLUMN "stops_at" TIMESTAMP(3),
  ADD COLUMN "handed_over_at" TIMESTAMP(3),
  ADD COLUMN "upstream_address" TEXT,
  ADD COLUMN "handed_over_account_id" TEXT;

-- ── hosting_tenant_account: the handover states and who it goes to ────────────
ALTER TABLE "hosting_tenant_account" DROP CONSTRAINT "hosting_tenant_account_state_check";
ALTER TABLE "hosting_tenant_account" ADD CONSTRAINT "hosting_tenant_account_state_check"
  CHECK ("state" IN ('requested', 'creating', 'bootstrapping', 'ready', 'refused',
                     'handing_over', 'awaiting_standalone', 'removing', 'handed_over'));

-- The address and GitHub owner the administrator names at handover — typed by a
-- person, not derived, and never a credential.
ALTER TABLE "hosting_tenant_account"
  ADD COLUMN "handover_owner_email" TEXT,
  ADD COLUMN "handover_github_owner" TEXT;

-- ── hosting_tenant_handover_step: per-step progress of one handover ───────────
-- CreateTable
CREATE TABLE "hosting_tenant_handover_step" (
    "id" TEXT NOT NULL,
    "tenant_account_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "lease_holder" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hosting_tenant_handover_step_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hosting_tenant_handover_step_step_check" CHECK ("step" IN (
      'destroy_previews', 'create_deploy_role', 'open_upstream', 'move_email',
      'await_standalone', 'remove_access', 'leave_organization', 'transfer_repositories')),
    CONSTRAINT "hosting_tenant_handover_step_status_check" CHECK ("status" IN (
      'pending', 'running', 'waiting_on_you', 'done', 'failed'))
);

-- CreateIndex
CREATE UNIQUE INDEX "hosting_tenant_handover_step_tenant_account_id_step_key" ON "hosting_tenant_handover_step"("tenant_account_id", "step");

-- AddForeignKey
ALTER TABLE "hosting_tenant_handover_step" ADD CONSTRAINT "hosting_tenant_handover_step_tenant_account_id_fkey" FOREIGN KEY ("tenant_account_id") REFERENCES "hosting_tenant_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Platform-only, as its parent `hosting_tenant_account`: `app.system_admin` and
-- nothing else. The handover runs from jobs under the system context, and the
-- account belongs to an organisation, not a workspace.
ALTER TABLE "hosting_tenant_handover_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosting_tenant_handover_step" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hosting_tenant_handover_step_system_only" ON "hosting_tenant_handover_step"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');

-- ── hosted_application_export: every database export of an application ───────
-- CreateTable
CREATE TABLE "hosted_application_export" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requested_by_user_id" TEXT,
    "storage_key" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hosted_application_export_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hosted_application_export_kind_check" CHECK ("kind" IN ('on_demand', 'final'))
);

-- CreateIndex
CREATE INDEX "hosted_application_export_workspace_id_idx" ON "hosted_application_export"("workspace_id");

-- CreateIndex
CREATE INDEX "hosted_application_export_application_id_created_at_idx" ON "hosted_application_export"("application_id", "created_at");

-- AddForeignKey
ALTER TABLE "hosted_application_export" ADD CONSTRAINT "hosted_application_export_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application_export" ADD CONSTRAINT "hosted_application_export_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A workspace's data: the house tenancy shape. System code (the stop job) writes
-- it under `withWorkspaceServiceContext`, taking the workspace from the
-- application row.
ALTER TABLE "hosted_application_export" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosted_application_export" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hosted_application_export_active_workspace" ON "hosted_application_export"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
