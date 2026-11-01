-- `motir auth refresh` (MOTIR-10189): a device grant can UPDATE an existing CLI
-- token instead of minting a new one. `update_token_id` names the token the
-- terminal proved it holds when it opened the grant (it presented the secret as
-- a bearer at `POST /api/cli/device/start`); null is the ordinary `motir login`
-- grant.
--
-- An expand-only change: one nullable column, its FK and its index. The FK
-- CASCADES, like the table's other two: revoking the token drops the grant that
-- would have updated it, so the terminal's next poll answers `invalid_grant`
-- and the CLI tells the person to run `motir login` — there is nothing left to
-- update. No RLS change: `device_code` carries none (see 20260730101748).

-- AlterTable
ALTER TABLE "device_code" ADD COLUMN "update_token_id" TEXT;

-- CreateIndex
CREATE INDEX "device_code_update_token_id_idx" ON "device_code"("update_token_id");

-- AddForeignKey
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_update_token_id_fkey" FOREIGN KEY ("update_token_id") REFERENCES "api_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
