-- A Host organisation's ask for more capacity on one of its own accounts
-- (Story MOTIR-9365 · MOTIR-9583).

-- CreateEnum
CREATE TYPE "fleet_capacity_request_status" AS ENUM ('open', 'filed', 'closed');

-- CreateTable
CREATE TABLE "fleet_capacity_request" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "shard_id" TEXT NOT NULL,
    "aws_account_id" TEXT NOT NULL,
    "fleet_kind" TEXT NOT NULL,
    "quota_code" TEXT NOT NULL DEFAULT 'L-1216C47A',
    "desired_vcpu" INTEGER NOT NULL,
    "reason_md" TEXT NOT NULL,
    "status" "fleet_capacity_request_status" NOT NULL DEFAULT 'open',
    "quota_request_id" TEXT,
    "closed_note" TEXT,
    "requested_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filed_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_capacity_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fleet_capacity_request_organization_id_created_at_idx" ON "fleet_capacity_request"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "fleet_capacity_request_status_created_at_idx" ON "fleet_capacity_request"("status", "created_at");

-- AddForeignKey
ALTER TABLE "fleet_capacity_request" ADD CONSTRAINT "fleet_capacity_request_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_capacity_request" ADD CONSTRAINT "fleet_capacity_request_shard_id_fkey" FOREIGN KEY ("shard_id") REFERENCES "fleet_shard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_capacity_request" ADD CONSTRAINT "fleet_capacity_request_quota_request_id_fkey" FOREIGN KEY ("quota_request_id") REFERENCES "fleet_quota_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A request asks for a real figure.
ALTER TABLE "fleet_capacity_request" ADD CONSTRAINT "fleet_capacity_request_desired_vcpu_check"
  CHECK ("desired_vcpu" > 0);

-- `filed` names the quota request the platform admin filed.
ALTER TABLE "fleet_capacity_request" ADD CONSTRAINT "fleet_capacity_request_filed_check"
  CHECK ("status" <> 'filed' OR "quota_request_id" IS NOT NULL);

-- A request is closed exactly when its status is `closed`.
ALTER TABLE "fleet_capacity_request" ADD CONSTRAINT "fleet_capacity_request_closed_check"
  CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL));

-- At most one OPEN or FILED request per AWS account — the merged indexer + agent
-- hoster account is two rows with one quota, so the account, not the row, is
-- what one ask is about.
CREATE UNIQUE INDEX "fleet_capacity_request_one_active"
  ON "fleet_capacity_request" ("aws_account_id")
  WHERE "status" IN ('open', 'filed');

-- ===========================================================================
-- Platform-only, as `fleet_shard`: `app.system_admin` and nothing else.
-- ===========================================================================
ALTER TABLE "fleet_capacity_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_capacity_request" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fleet_capacity_request_system_only" ON "fleet_capacity_request"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
