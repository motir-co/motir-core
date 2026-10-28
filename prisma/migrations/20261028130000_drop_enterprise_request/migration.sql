-- Drop the retired Contact-sales table and its five enum types — the CONTRACT
-- phase of the Enterprise removal (Story MOTIR-9385 · MOTIR-9394).
--
-- MOTIR-9386 deleted every reader and writer of `enterprise_request` and shipped
-- the SCHEMA-ONLY phase: the model `@@ignore`d, so the generated client stopped
-- naming the table, while the table stayed. That release reached production
-- (`/api/health/release` answered `9e3018a`, which contains it), so no serving
-- image selects the table any more and `release_command` may drop it before the
-- new image takes traffic (`docs/decisions/delivery-reader-migration.md` §6a).
--
-- @client-stopped-selecting: MOTIR-9386
--
-- DROP TABLE takes the table's indexes, foreign keys and both RLS policies with
-- it. The enums go after it: they were typed only by its columns.

-- DropTable
DROP TABLE "enterprise_request";

-- DropEnum
DROP TYPE "enterprise_request_status";

-- DropEnum
DROP TYPE "enterprise_agent_path";

-- DropEnum
DROP TYPE "enterprise_autonomy";

-- DropEnum
DROP TYPE "enterprise_start_when";

-- DropEnum
DROP TYPE "enterprise_team_size";
