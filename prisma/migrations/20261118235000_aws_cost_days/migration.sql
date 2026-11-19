-- The console's Costs page (MOTIR-11712): what AWS charged Motir, per UTC day and
-- per line, as AWS Cost Explorer reports it for the Organization's management
-- account (unblended, every linked account). `aws_cost_day` holds one row per day
-- and line — an AWS service, or the day's Tax, Credits or Refund — in micro-USD;
-- `aws_cost_fetch` records each successful read: the day range it replaced and
-- when. The fetch job (`system.aws-cost-fetch`, every 6 hours) re-reads the
-- current and previous month and replaces those days in one transaction, so the
-- page never calls Cost Explorer (each request is billed). ADDITIVE: two new
-- tables, nothing seeded. Not a workspace's data — it is Motir's own bill — so
-- neither carries a `workspace_id`. motir-core stores no MODEL cost here: the
-- page reads that live from motir-ai.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- `ci_fleet_blind_spots`' shape (20261116210000), copied rather than invented.
-- Two arms per table. The WRITER is the fetch job and the backfill script, under
-- `withSystemContext` (`app.system_admin`), both ways because the replace deletes
-- the rows it supersedes. The READER is the Costs page's
-- `platformReadService.getCosts`, inside `withPlatformRead`
-- (`app.platform_staff`), SELECT only: the console never writes a cost. Grants:
-- the add_workspace_rls migration's ALTER DEFAULT PRIVILEGES covers every new
-- table.
-- CreateTable
CREATE TABLE "aws_cost_day" (
    "day" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "amount_micro_usd" BIGINT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aws_cost_day_pkey" PRIMARY KEY ("day","kind","service")
);

-- CreateTable
CREATE TABLE "aws_cost_fetch" (
    "id" TEXT NOT NULL,
    "from_day" DATE NOT NULL,
    "to_day" DATE NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aws_cost_fetch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aws_cost_fetch_fetched_at_idx" ON "aws_cost_fetch"("fetched_at");

-- ===========================================================================
-- Row-level security — aws_cost_day
-- ===========================================================================
ALTER TABLE "aws_cost_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "aws_cost_day" FORCE ROW LEVEL SECURITY;

CREATE POLICY "aws_cost_day_system_admin" ON "aws_cost_day"
  FOR ALL
  USING (coalesce(current_setting('app.system_admin', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.system_admin', true), '') = 'true');

CREATE POLICY "aws_cost_day_platform_staff" ON "aws_cost_day"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- Row-level security — aws_cost_fetch
-- ===========================================================================
ALTER TABLE "aws_cost_fetch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "aws_cost_fetch" FORCE ROW LEVEL SECURITY;

CREATE POLICY "aws_cost_fetch_system_admin" ON "aws_cost_fetch"
  FOR ALL
  USING (coalesce(current_setting('app.system_admin', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.system_admin', true), '') = 'true');

CREATE POLICY "aws_cost_fetch_platform_staff" ON "aws_cost_fetch"
  FOR SELECT
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true');
