-- THE `code_graph_index` FLEET KIND, RETIRED (MOTIR-12041 · Story MOTIR-11026).
-- Indexing runs through motir-ai and motir-codegraph; no build since that move
-- admits or writes a run of the kind. motir-core now has three fleet kinds —
-- `ci_runner`, `hosted_agent`, `agent_instance` (`FLEET_WORKLOADS` in
-- `lib/ciFleet/workloads.ts`) — and this migration removes the last rows of the
-- fourth and makes the database refuse it.
--
-- Runs after `20261123120000_merged_host_account_rehome`, which already turned
-- every merged Host account's `code_graph_index` row into its `agent_instance`
-- row. What is left of the kind is the platform-pool index shards and their
-- operational records, which nothing reads.
--
-- IN ORDER, in one transaction (`prisma migrate deploy` runs the file as one):
--   1. RE-KEY, never delete, a quota request of the kind whose shard is NOT a
--      `code_graph_index` shard: it is that account's raise history (the
--      re-home re-keys its own, so this is a guard for any other shape).
--   2. DELETE the kind's in-flight slots (`workload`, or any slot on an index
--      shard). `fleet_in_flight_slot` → `fleet_shard` is ON DELETE RESTRICT.
--   3. DELETE the capacity requests on an index shard (RESTRICT on the shard),
--      and detach any other capacity request from a quota request on an index
--      shard (RESTRICT on the quota request). A capacity request of the kind on
--      an `agent_instance` row — the merged account's past request the re-home
--      re-pointed — is KEPT with its stored `fleet_kind` and `aws_account_id`:
--      billing lists it as history, and that table has no CHECK.
--   4. DELETE the kind's quota requests (the rest would cascade with the shard;
--      deleting them by kind is explicit) and growth events (their shard
--      columns SET NULL on a shard delete, so they would survive it and fail
--      the tightened CHECK).
--   5. DELETE the kind's shards and its `platform_fleet_kind_switch` row.
--   6. REPLACE the three `fleet_kind` CHECK constraints with the three kinds.
--
-- Past `ci_container_usage` rows and their `index` cost line are billing
-- history and are not touched. The migrations that created the kind stay.
--
-- IDEMPOTENT: every step is a no-op on a migrated database, and each constraint
-- is dropped IF EXISTS before it is added again.
--
-- RLS: the fleet tables admit `app.system_admin = 'true'`; the switch table's
-- writes admit `app.platform_staff = 'true'`. Both are set for this transaction
-- only (`SET LOCAL`). Constraint validation is not subject to RLS.
-- ===========================================================================

SET LOCAL "app.system_admin" = 'true';
SET LOCAL "app.platform_staff" = 'true';

-- 1. Re-key a quota request of the kind on a shard of another kind.
UPDATE "fleet_quota_request" AS q
  SET "fleet_kind" = s."fleet_kind", "updated_at" = CURRENT_TIMESTAMP
  FROM "fleet_shard" AS s
  WHERE q."shard_id" = s."id"
    AND q."fleet_kind" = 'code_graph_index'
    AND s."fleet_kind" <> 'code_graph_index';

-- 2. The kind's in-flight slots.
DELETE FROM "fleet_in_flight_slot"
  WHERE "workload" = 'code_graph_index'
     OR "fleet_shard_id" IN (SELECT "id" FROM "fleet_shard" WHERE "fleet_kind" = 'code_graph_index');

-- 3. Capacity requests on an index shard go; others are detached from an index
--    shard's quota request.
DELETE FROM "fleet_capacity_request"
  WHERE "shard_id" IN (SELECT "id" FROM "fleet_shard" WHERE "fleet_kind" = 'code_graph_index');
UPDATE "fleet_capacity_request"
  SET "quota_request_id" = NULL, "updated_at" = CURRENT_TIMESTAMP
  WHERE "quota_request_id" IN (SELECT "id" FROM "fleet_quota_request" WHERE "fleet_kind" = 'code_graph_index');

-- 4. The kind's quota requests and growth events.
DELETE FROM "fleet_growth_event" WHERE "fleet_kind" = 'code_graph_index';
DELETE FROM "fleet_quota_request" WHERE "fleet_kind" = 'code_graph_index';

-- 5. The kind's shards and its switch row.
DELETE FROM "fleet_shard" WHERE "fleet_kind" = 'code_graph_index';
DELETE FROM "platform_fleet_kind_switch" WHERE "fleet_kind" = 'code_graph_index';

-- 6. The database refuses the retired kind.
ALTER TABLE "fleet_shard" DROP CONSTRAINT IF EXISTS "fleet_shard_fleet_kind_check";
ALTER TABLE "fleet_shard" ADD CONSTRAINT "fleet_shard_fleet_kind_check"
  CHECK ("fleet_kind" IN ('ci_runner', 'hosted_agent', 'agent_instance'));
ALTER TABLE "fleet_quota_request" DROP CONSTRAINT IF EXISTS "fleet_quota_request_fleet_kind_check";
ALTER TABLE "fleet_quota_request" ADD CONSTRAINT "fleet_quota_request_fleet_kind_check"
  CHECK ("fleet_kind" IN ('ci_runner', 'hosted_agent', 'agent_instance'));
ALTER TABLE "fleet_growth_event" DROP CONSTRAINT IF EXISTS "fleet_growth_event_fleet_kind_check";
ALTER TABLE "fleet_growth_event" ADD CONSTRAINT "fleet_growth_event_fleet_kind_check"
  CHECK ("fleet_kind" IN ('ci_runner', 'hosted_agent', 'agent_instance'));
