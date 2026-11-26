-- The takeover handover's actor and its waiting reasons (Story MOTIR-9800 ·
-- MOTIR-12131). Expand-only.
--
-- `handover_started_by_user_id`: the organisation admin who started the
-- handover; its repository transfers run as them. SET NULL on the user's
-- deletion, so an erasure is never blocked (the transfer step then fails by
-- name instead of acting as nobody).
--
-- `missing`: what a `waiting_on_you` step waits on the new owner for (AWS's
-- unmet standalone requirements, or AWS's reason for refusing the removal).

-- AlterTable
ALTER TABLE "hosting_tenant_account" ADD COLUMN     "handover_started_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "hosting_tenant_handover_step" ADD COLUMN     "missing" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AddForeignKey
ALTER TABLE "hosting_tenant_account" ADD CONSTRAINT "hosting_tenant_account_handover_started_by_user_id_fkey" FOREIGN KEY ("handover_started_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
