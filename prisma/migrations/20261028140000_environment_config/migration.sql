-- A Motir repository's environment configuration (Story MOTIR-9795 · MOTIR-9960):
-- one entry per (repository, environment, name), secrets stored only as the
-- `v1.` ciphertext of `environmentConfigCrypto`, and an append-only change record
-- that has no value column at all. Both tables are workspace tenant data under
-- row-level security, the same pure workspace gate `project_repository` carries.

-- CreateEnum
CREATE TYPE "app_environment" AS ENUM ('production', 'preview', 'release');

-- CreateEnum
CREATE TYPE "environment_config_action" AS ENUM ('added', 'replaced', 'deleted');

-- CreateTable
CREATE TABLE "environment_config_entry" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_repository_id" TEXT NOT NULL,
    "environment" "app_environment" NOT NULL,
    "name" TEXT NOT NULL,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "environment_config_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment_config_change" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_repository_id" TEXT NOT NULL,
    "environment" "app_environment" NOT NULL,
    "name" TEXT NOT NULL,
    "action" "environment_config_action" NOT NULL,
    "is_secret" BOOLEAN NOT NULL,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environment_config_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "environment_config_entry_workspace_id_idx" ON "environment_config_entry"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "environment_config_entry_project_repository_id_environment__key" ON "environment_config_entry"("project_repository_id", "environment", "name");

-- CreateIndex
CREATE INDEX "environment_config_change_project_repository_id_environment_idx" ON "environment_config_change"("project_repository_id", "environment", "created_at");

-- CreateIndex
CREATE INDEX "environment_config_change_workspace_id_idx" ON "environment_config_change"("workspace_id");

-- CreateIndex
CREATE INDEX "environment_config_change_actor_id_idx" ON "environment_config_change"("actor_id");

-- AddForeignKey
ALTER TABLE "environment_config_entry" ADD CONSTRAINT "environment_config_entry_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_config_entry" ADD CONSTRAINT "environment_config_entry_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_config_change" ADD CONSTRAINT "environment_config_change_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_config_change" ADD CONSTRAINT "environment_config_change_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_config_change" ADD CONSTRAINT "environment_config_change_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- The database's own refusals — a backstop for a path that bypasses the
-- service, which throws the typed error first.
-- ===========================================================================

-- The names the platform owns (`isReservedEnvironmentName`): `PORT`,
-- `DATABASE_URL` and anything beginning `MOTIR_`, compared exactly
-- (case-sensitive). `starts_with`, not `LIKE`, because `_` is a LIKE wildcard.
ALTER TABLE "environment_config_entry" ADD CONSTRAINT "environment_config_entry_name_not_reserved_check"
  CHECK ("name" <> 'PORT' AND "name" <> 'DATABASE_URL' AND NOT starts_with("name", 'MOTIR_'));
ALTER TABLE "environment_config_change" ADD CONSTRAINT "environment_config_change_name_not_reserved_check"
  CHECK ("name" <> 'PORT' AND "name" <> 'DATABASE_URL' AND NOT starts_with("name", 'MOTIR_'));

-- A secret's value is only ever ciphertext, so a stored secret row cannot hold
-- the plain value.
ALTER TABLE "environment_config_entry" ADD CONSTRAINT "environment_config_entry_secret_ciphertext_check"
  CHECK (NOT "is_secret" OR starts_with("value", 'v1.'));

-- ===========================================================================
-- Row-level security — one PERMISSIVE FOR ALL policy per table against
-- `current_setting('app.workspace_id', true)` (an unset GUC yields NULL, so
-- every row is hidden — the safe failure). ENABLE + FORCE so the table owner is
-- subject to it too. Grants come from the workspace RLS migration's ALTER
-- DEFAULT PRIVILEGES.
-- ===========================================================================
ALTER TABLE "environment_config_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "environment_config_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "environment_config_entry_active_workspace" ON "environment_config_entry"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "environment_config_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "environment_config_change" FORCE ROW LEVEL SECURITY;
CREATE POLICY "environment_config_change_active_workspace" ON "environment_config_change"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
