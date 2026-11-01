-- PRODUCTION ENABLEMENT on a hosted application (Story MOTIR-9797 · Subtask
-- MOTIR-10027): the Fly app name, when production was switched on and when its
-- deploy token was last minted. ADDITIVE, nullable columns; the table's RLS
-- (`hosted_application_workspace_or_system`) already covers them.

-- AlterTable
ALTER TABLE "hosted_application" ADD COLUMN     "production_app_name" TEXT,
ADD COLUMN     "production_enabled_at" TIMESTAMP(3),
ADD COLUMN     "production_token_minted_at" TIMESTAMP(3);

