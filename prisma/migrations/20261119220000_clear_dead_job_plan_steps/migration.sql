-- Bug MOTIR-11833 — delete every `plan_step` row a DEAD planning job left behind.
--
-- A job that dies while its plan is `generating` sends no `end` for its sessions,
-- and since MOTIR-11184 a step never ages out, so each row it left reads its card
-- as still being written: the overlay's spinner, an `authoring` card to the
-- authoring state and an unwritten one to the walk's completeness check. The code
-- now deletes a plan's steps when its failure is recorded
-- (`planSessionEndService.recordFailureWithin`) and again when a Resume binds the
-- new job (`planSessionResumeService.bindWithin`). The rows already left behind
-- before that shipped are deleted ONCE, here, at deploy. This file keys on the
-- RULE, never on a plan or job id, so it is a no-op wherever no such row exists.
--
-- THE TWO ARMS — a step is dead when:
--   1. its plan's attempt is RECORDED FAILED and not yet resumed: the plan's
--      session is open, carries a failure, and `failed_job_id` is the plan's
--      `source_job_id`. The same rule the failure record now applies — every
--      step of the plan goes, whatever planner wrote it.
--   2. it was written by a hosted job that is NOT the plan's current one: the
--      hosted planner keys its sessions `ai:<jobId>:<n>` (motir-ai
--      `planStepReporter` / `planEntryRecorder`), and a job prefix other than the
--      plan's `source_job_id` is an attempt a Resume (or a revision) replaced.
--      Only `ai:` keys are judged — every other planner's keys are opaque.
--   ⚠️ `IS DISTINCT FROM`, not `<>`: a NULL `source_job_id` (a plan no hosted job
--   writes) makes every `ai:` row on it dead, and `<>` would yield NULL and keep it.
--
-- RLS: `plan_step` is FORCE ROW LEVEL SECURITY with a workspace policy and a
-- system arm that is READ-ONLY (`plan_step_system_read`, FOR SELECT), so no
-- system binding can delete a row. This block does not lean on the migration
-- role being the BYPASSRLS owner: it binds `app.system_admin` transaction-locally
-- to FIND the workspaces holding a dead row (`plan`, `plan_step` and
-- `plan_change_session` all carry the read arm), then binds each workspace's
-- `app.workspace_id` in turn for its DELETE, which `plan_step_active_workspace`
-- admits. The integration test replays the file under both roles.
--
-- IDEMPOTENT: a second run finds nothing to delete. One `DO` block, so the file
-- is a single statement the test replays verbatim; `RAISE NOTICE` makes the
-- deploy log the report. No schema change.
DO $$
DECLARE
  ws text;
  n integer;
  cleared integer := 0;
BEGIN
  PERFORM set_config('app.system_admin', 'true', true);

  FOR ws IN
    SELECT DISTINCT p."workspace_id"
      FROM "plan_step" s
      JOIN "plan" p ON p."id" = s."plan_id"
      LEFT JOIN "plan_change_session" c ON c."id" = p."session_id"
     WHERE (c."ended_at" IS NULL
            AND c."failed_at" IS NOT NULL
            AND c."failed_job_id" = p."source_job_id")
        OR (s."session_key" LIKE 'ai:%'
            AND split_part(s."session_key", ':', 2) IS DISTINCT FROM p."source_job_id")
  LOOP
    PERFORM set_config('app.workspace_id', ws, true);

    DELETE FROM "plan_step" s
     USING "plan" p
      LEFT JOIN "plan_change_session" c ON c."id" = p."session_id"
     WHERE p."id" = s."plan_id"
       AND p."workspace_id" = ws
       AND ((c."ended_at" IS NULL
             AND c."failed_at" IS NOT NULL
             AND c."failed_job_id" = p."source_job_id")
         OR (s."session_key" LIKE 'ai:%'
             AND split_part(s."session_key", ':', 2) IS DISTINCT FROM p."source_job_id"));
    GET DIAGNOSTICS n = ROW_COUNT;
    cleared := cleared + n;
  END LOOP;

  PERFORM set_config('app.workspace_id', '', true);
  PERFORM set_config('app.system_admin', '', true);

  RAISE NOTICE 'MOTIR-11833: deleted % plan step(s) left by a dead planning job', cleared;
END $$;
