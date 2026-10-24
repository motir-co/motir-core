-- MOTIR-9457 (Story MOTIR-9362): the quota raises filed for a fleet account, and
-- the pool growths the growth pass decides. Both are platform infrastructure,
-- read and written only under `withSystemContext`.

-- CreateEnum
CREATE TYPE "fleet_quota_request_status" AS ENUM ('pending', 'case_opened', 'approved', 'denied', 'not_approved', 'case_closed', 'invalid_request');

-- CreateEnum
CREATE TYPE "fleet_growth_outcome" AS ENUM ('spare_promoted', 'account_created', 'waiting_for_quota', 'refused');

-- CreateTable
CREATE TABLE "fleet_quota_request" (
    "id" TEXT NOT NULL,
    "shard_id" TEXT NOT NULL,
    "fleet_kind" TEXT NOT NULL,
    "quota_code" TEXT NOT NULL,
    "desired_value" INTEGER NOT NULL,
    "aws_request_id" TEXT NOT NULL,
    "status" "fleet_quota_request_status" NOT NULL DEFAULT 'pending',
    "granted_value" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_quota_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_growth_event" (
    "id" TEXT NOT NULL,
    "fleet_kind" TEXT NOT NULL,
    "triggering_shard_id" TEXT,
    "vcpu_in_use" INTEGER NOT NULL,
    "granted_quota" INTEGER NOT NULL,
    "outcome" "fleet_growth_outcome" NOT NULL,
    "reason" TEXT,
    "spare_shard_id" TEXT,
    "new_shard_id" TEXT,
    "quota_request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_growth_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fleet_quota_request_fleet_kind_status_idx" ON "fleet_quota_request"("fleet_kind", "status");

-- CreateIndex
CREATE INDEX "fleet_quota_request_fleet_kind_created_at_idx" ON "fleet_quota_request"("fleet_kind", "created_at");

-- CreateIndex
CREATE INDEX "fleet_quota_request_shard_id_created_at_idx" ON "fleet_quota_request"("shard_id", "created_at");

-- CreateIndex
CREATE INDEX "fleet_growth_event_fleet_kind_created_at_idx" ON "fleet_growth_event"("fleet_kind", "created_at");

-- CreateIndex
CREATE INDEX "fleet_growth_event_triggering_shard_id_idx" ON "fleet_growth_event"("triggering_shard_id");

-- CreateIndex
CREATE INDEX "fleet_growth_event_spare_shard_id_idx" ON "fleet_growth_event"("spare_shard_id");

-- CreateIndex
CREATE INDEX "fleet_growth_event_new_shard_id_idx" ON "fleet_growth_event"("new_shard_id");

-- CreateIndex
CREATE INDEX "fleet_growth_event_quota_request_id_idx" ON "fleet_growth_event"("quota_request_id");

-- AddForeignKey
ALTER TABLE "fleet_quota_request" ADD CONSTRAINT "fleet_quota_request_shard_id_fkey" FOREIGN KEY ("shard_id") REFERENCES "fleet_shard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_growth_event" ADD CONSTRAINT "fleet_growth_event_triggering_shard_id_fkey" FOREIGN KEY ("triggering_shard_id") REFERENCES "fleet_shard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_growth_event" ADD CONSTRAINT "fleet_growth_event_spare_shard_id_fkey" FOREIGN KEY ("spare_shard_id") REFERENCES "fleet_shard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_growth_event" ADD CONSTRAINT "fleet_growth_event_new_shard_id_fkey" FOREIGN KEY ("new_shard_id") REFERENCES "fleet_shard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_growth_event" ADD CONSTRAINT "fleet_growth_event_quota_request_id_fkey" FOREIGN KEY ("quota_request_id") REFERENCES "fleet_quota_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- THE INVARIANTS, held by the database. `fleetQuotaRequestService` and
-- `fleetGrowthEventService` refuse the same rows first with typed errors.

-- Both records belong to one of the four fleet kinds (`lib/ciFleet/workloads.ts`).
ALTER TABLE "fleet_quota_request" ADD CONSTRAINT "fleet_quota_request_fleet_kind_check"
  CHECK ("fleet_kind" IN ('ci_runner', 'code_graph_index', 'hosted_agent', 'agent_instance'));
ALTER TABLE "fleet_growth_event" ADD CONSTRAINT "fleet_growth_event_fleet_kind_check"
  CHECK ("fleet_kind" IN ('ci_runner', 'code_graph_index', 'hosted_agent', 'agent_instance'));

-- A raise asks for, and is granted, a real value.
ALTER TABLE "fleet_quota_request" ADD CONSTRAINT "fleet_quota_request_values_positive_check"
  CHECK ("desired_value" > 0 AND ("granted_value" IS NULL OR "granted_value" > 0));

-- A request is closed exactly when its status is terminal
-- (`FLEET_QUOTA_REQUEST_TERMINAL_STATUSES`).
ALTER TABLE "fleet_quota_request" ADD CONSTRAINT "fleet_quota_request_closed_check"
  CHECK (
    ("status" IN ('approved', 'denied', 'not_approved', 'case_closed', 'invalid_request'))
    = ("closed_at" IS NOT NULL)
  );

-- At most one OPEN request per account and quota code: AWS refuses a second
-- pending request for the same quota, and the create is idempotent on it.
CREATE UNIQUE INDEX "fleet_quota_request_one_open"
  ON "fleet_quota_request" ("shard_id", "quota_code")
  WHERE "closed_at" IS NULL;

-- A growth reads real figures.
ALTER TABLE "fleet_growth_event" ADD CONSTRAINT "fleet_growth_event_figures_check"
  CHECK ("vcpu_in_use" >= 0 AND "granted_quota" >= 0);

-- ===========================================================================
-- Platform-only, as `fleet_shard`: `app.system_admin` and nothing else.
ALTER TABLE "fleet_quota_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_quota_request" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fleet_quota_request_system_only" ON "fleet_quota_request"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');

ALTER TABLE "fleet_growth_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_growth_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fleet_growth_event_system_only" ON "fleet_growth_event"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
