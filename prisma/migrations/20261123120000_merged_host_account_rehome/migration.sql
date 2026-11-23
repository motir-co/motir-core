-- THE MERGED HOST ACCOUNT, RE-HOMED ONTO ITS AGENT ROW (MOTIR-12038 · Story
-- MOTIR-11026). A Host organisation's merged AWS account was ONE account written
-- as TWO `fleet_shard` rows: the `code_graph_index` row, which the provisioning
-- walk created and filed the account's one quota raise against, and the
-- `agent_instance` twin written from it. The container-based indexer has left
-- motir-core, so the account belongs to the agent hoster alone and is ONE
-- `agent_instance` row. DATA ONLY: no schema changes, and the `fleet_kind`
-- CHECKs already allow `agent_instance` (they are tightened by MOTIR-12041).
--
-- For every `org_owned` `code_graph_index` row (a platform-pool index row of any
-- other role, and the kind's switch row, are not touched):
--
--   WITH A TWIN (the `org_owned` `agent_instance` row of the same organisation)
--     1. RE-POINT every reference to the index row onto the twin FIRST:
--          * `fleet_quota_request` — ON DELETE CASCADE, so deleting the index row
--            first would silently delete the account's raise; the agent cap would
--            read no grant and drop to 0, and a replay would file a second raise,
--            which AWS refuses. Its `fleet_kind` becomes `agent_instance`: the
--            raise is the account's, and the account is the agent kind's now.
--          * `fleet_capacity_request`, `fleet_in_flight_slot`, `agent_instance`,
--            `ci_runner_provisioning_intent` — ON DELETE RESTRICT, they would
--            block the delete. A capacity request is past history: it keeps its
--            stored `fleet_kind` and `aws_account_id`; only its shard moves.
--          * `fleet_growth_event` (three columns) and `dispatch_run` — ON DELETE
--            SET NULL, they would lose their link.
--     2. DELETE the index row, which frees its unique `name`.
--     3. UPDATE the twin with what the index row held (captured before the
--        delete): its name — the one the AWS member email was derived from, so a
--        replay recomputes it and finds the account instead of creating a second
--        one — its AWS location, credential reference, vCPU quota, limits source
--        and times; and its state when the twin is still `provisioning`. The twin
--        keeps its own admission override and pause fields.
--
--   WITH NO TWIN — the index row becomes the `agent_instance` row in place (same
--   id), and its quota requests' `fleet_kind` likewise. Nothing is deleted.
--
-- IDEMPOTENT: a second run finds no `org_owned` `code_graph_index` row and
-- changes nothing. ONE TRANSACTION: `prisma migrate deploy` runs the file as one
-- script, and the DO block is one statement.
--
-- RLS: the fleet tables admit `app.system_admin = 'true'`, set for this
-- transaction only. `agent_instance` and `dispatch_run` admit the system admin
-- for SELECT alone; their writes are admitted per workspace, so each workspace's
-- rows are re-pointed under its own `app.workspace_id` rather than any policy
-- being weakened. `SET LOCAL` / `set_config(…, true)` unset both at commit.
-- ===========================================================================

SET LOCAL "app.system_admin" = 'true';

DO $$
DECLARE
  idx "fleet_shard"%ROWTYPE;
  twin_id text;
  ws text;
BEGIN
  FOR idx IN
    SELECT * FROM "fleet_shard"
    WHERE "fleet_kind" = 'code_graph_index' AND "role" = 'org_owned'
    ORDER BY "id"
    FOR UPDATE
  LOOP
    SELECT "id" INTO twin_id
    FROM "fleet_shard"
    WHERE "fleet_kind" = 'agent_instance'
      AND "role" = 'org_owned'
      AND "owner_organization_id" = idx."owner_organization_id"
    ORDER BY "created_at", "id"
    LIMIT 1
    FOR UPDATE;

    IF twin_id IS NULL THEN
      -- No twin: the index row is the account's agent row, in place.
      UPDATE "fleet_quota_request" SET "fleet_kind" = 'agent_instance', "updated_at" = CURRENT_TIMESTAMP
        WHERE "shard_id" = idx."id";
      UPDATE "fleet_shard" SET "fleet_kind" = 'agent_instance', "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = idx."id";
      CONTINUE;
    END IF;

    -- 1. Re-point every reference onto the twin, before the delete.
    UPDATE "fleet_quota_request"
      SET "shard_id" = twin_id, "fleet_kind" = 'agent_instance', "updated_at" = CURRENT_TIMESTAMP
      WHERE "shard_id" = idx."id";
    UPDATE "fleet_capacity_request" SET "shard_id" = twin_id WHERE "shard_id" = idx."id";
    UPDATE "fleet_growth_event" SET "triggering_shard_id" = twin_id WHERE "triggering_shard_id" = idx."id";
    UPDATE "fleet_growth_event" SET "spare_shard_id" = twin_id WHERE "spare_shard_id" = idx."id";
    UPDATE "fleet_growth_event" SET "new_shard_id" = twin_id WHERE "new_shard_id" = idx."id";
    UPDATE "fleet_in_flight_slot" SET "fleet_shard_id" = twin_id WHERE "fleet_shard_id" = idx."id";
    UPDATE "ci_runner_provisioning_intent" SET "fleet_shard_id" = twin_id WHERE "fleet_shard_id" = idx."id";
    FOR ws IN SELECT DISTINCT "workspace_id" FROM "agent_instance" WHERE "fleet_shard_id" = idx."id" LOOP
      PERFORM set_config('app.workspace_id', ws, true);
      UPDATE "agent_instance" SET "fleet_shard_id" = twin_id WHERE "fleet_shard_id" = idx."id";
    END LOOP;
    FOR ws IN SELECT DISTINCT "workspace_id" FROM "dispatch_run" WHERE "fleet_shard_id" = idx."id" LOOP
      PERFORM set_config('app.workspace_id', ws, true);
      UPDATE "dispatch_run" SET "fleet_shard_id" = twin_id WHERE "fleet_shard_id" = idx."id";
    END LOOP;
    PERFORM set_config('app.workspace_id', '', true);

    -- 2. Delete the index row: nothing references it now, and its name is free.
    DELETE FROM "fleet_shard" WHERE "id" = idx."id";

    -- 3. The twin takes the account's name, location, limits and times.
    UPDATE "fleet_shard" SET
      "name" = idx."name",
      "aws_account_id" = idx."aws_account_id",
      "aws_region" = idx."aws_region",
      "credential_ref" = idx."credential_ref",
      "vcpu_quota" = idx."vcpu_quota",
      "limits_source" = idx."limits_source",
      "limits_verified_at" = idx."limits_verified_at",
      "quota_requested_at" = idx."quota_requested_at",
      "granted_at" = idx."granted_at",
      "live_at" = idx."live_at",
      "state" = CASE WHEN "state" = 'provisioning' THEN idx."state" ELSE "state" END,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = twin_id;
  END LOOP;
END $$;
