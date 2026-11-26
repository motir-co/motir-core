-- Every download of a hosted application's database export (Story MOTIR-9800 ·
-- MOTIR-12134). Expand-only: one new table.
--
-- One row per signed link minted, so every download is traceable to who asked
-- and when. `user_id` is a plain id, not a foreign key, as on the export itself,
-- so a user's erasure is never blocked. The rows go with their export (CASCADE),
-- which the expiry sweep deletes.

-- CreateTable
CREATE TABLE "hosted_application_export_download" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "export_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_application_export_download_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosted_application_export_download_workspace_id_idx" ON "hosted_application_export_download"("workspace_id");

-- CreateIndex
CREATE INDEX "hosted_application_export_download_export_id_created_at_idx" ON "hosted_application_export_download"("export_id", "created_at");

-- AddForeignKey
ALTER TABLE "hosted_application_export_download" ADD CONSTRAINT "hosted_application_export_download_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application_export_download" ADD CONSTRAINT "hosted_application_export_download_export_id_fkey" FOREIGN KEY ("export_id") REFERENCES "hosted_application_export"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A workspace's data: the house tenancy shape, as on the export it belongs to.
ALTER TABLE "hosted_application_export_download" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosted_application_export_download" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hosted_application_export_download_active_workspace" ON "hosted_application_export_download"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
