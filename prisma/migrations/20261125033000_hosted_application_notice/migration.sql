-- The grace-window notices of a hosted application (Story MOTIR-9800 ·
-- MOTIR-12136). Expand-only: one new enum and one new table.
--
-- One row per `(application_id, kind)`, written after the notice's emails are
-- enqueued: the unique key is what makes each notice go out once, and the
-- newest row is the banner the Production panel shows. The rows go with their
-- application and their workspace (CASCADE).

-- CreateEnum
CREATE TYPE "hosted_application_notice_kind" AS ENUM ('transferred', 'seven_days', 'one_day', 'stopped');

-- CreateTable
CREATE TABLE "hosted_application_notice" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "kind" "hosted_application_notice_kind" NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_application_notice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hosted_application_notice_workspace_id_idx" ON "hosted_application_notice"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_application_notice_application_id_kind_key" ON "hosted_application_notice"("application_id", "kind");

-- AddForeignKey
ALTER TABLE "hosted_application_notice" ADD CONSTRAINT "hosted_application_notice_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application_notice" ADD CONSTRAINT "hosted_application_notice_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A workspace's data: the house tenancy shape, as on the application it is about.
ALTER TABLE "hosted_application_notice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosted_application_notice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hosted_application_notice_active_workspace" ON "hosted_application_notice"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
