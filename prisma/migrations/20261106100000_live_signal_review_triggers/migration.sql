-- LIVE-SIGNAL TRIGGERS ON THE REVIEW TABLES (Bug MOTIR-10504)
--
-- The Workbench's To approve tab draws a review line and a Reviewed badge on every
-- approve-and-merge row (MOTIR-10342), derived from the review state read model
-- (`lib/services/reviewStateService.ts` -> `lib/repositories/reviewStateRepository.ts`).
-- Its watermark used to read only `approval_gate`, so a review that writes no gate row
-- -- a passing verdict with the review gate off, a GitHub approval at the head -- moved
-- nothing and the open row kept its old review line until a reload.
--
-- The watermark now folds in a reading over the rows the read model derives from
-- (`reviewStateRepository.watermarkReviewsOfSubtrees`), and every table that reading
-- touches must be heard, for the reason `20261015230000_live_signal_triggers` records:
-- a trigger fires for every writer, and `tests/integration/live/liveSignalTriggers.test.ts`
-- derives the table set from the readings, so a forgotten table is a failing test.
--
-- New tables heard: `review_verdict_record`, `review_dismissal`, `work_item_delivery`,
-- `github_pull_request_review`. Per-row cost: none for the first two (they carry their
-- own workspace and project); one primary-key lookup on `work_item` for a delivery; one
-- indexed read of a pull request's deliveries (`work_item_delivery_github_pull_request_id_idx`)
-- for a GitHub review.
--
-- `dispatch_run` is deliberately NOT heard: a hosted review run in flight shows only
-- while an `agent_review` gate awaits, and while it awaits the approve-and-merge question
-- is not asked (`mergeGates.agentReviewHoldsMerge`), so no To approve row can draw it.
--
-- The function is redefined whole (CREATE OR REPLACE), its existing branches unchanged.
-- No lookup raises, so no trigger can roll back the write it observes.

CREATE OR REPLACE FUNCTION live_signal_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  w text;
  p text;
  pl text;
  plan_id_of_row text;
  session_id_of_row text;
  linked record;
  found_plan boolean;
BEGIN
  IF TG_TABLE_NAME = 'work_item' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM live_signal_emit(OLD."workspaceId", OLD."projectId", NULL);
    ELSE
      PERFORM live_signal_emit(NEW."workspaceId", NEW."projectId", NULL);
      -- A move between projects is heard by the project it LEFT as well.
      IF TG_OP = 'UPDATE' AND (OLD."projectId" IS DISTINCT FROM NEW."projectId"
          OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId") THEN
        PERFORM live_signal_emit(OLD."workspaceId", OLD."projectId", NULL);
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'watcher' THEN
    SELECT wi."workspaceId", wi."projectId" INTO w, p
      FROM "work_item" wi
     WHERE wi."id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."work_item_id" ELSE NEW."work_item_id" END);
    PERFORM live_signal_emit(w, p, NULL);

  ELSIF TG_TABLE_NAME = 'approval_gate' THEN
    IF TG_OP = 'DELETE' THEN
      pl := CASE WHEN OLD."kind"::text = 'plan_approval' THEN OLD."subject_id" END;
      PERFORM live_signal_emit(OLD."workspace_id", OLD."project_id", pl);
    ELSE
      pl := CASE WHEN NEW."kind"::text = 'plan_approval' THEN NEW."subject_id" END;
      PERFORM live_signal_emit(NEW."workspace_id", NEW."project_id", pl);
    END IF;

  ELSIF TG_TABLE_NAME = 'plan_change_session' THEN
    IF TG_OP = 'DELETE' THEN
      w := OLD."workspace_id";
      p := OLD."project_id";
      session_id_of_row := OLD."id";
    ELSE
      w := NEW."workspace_id";
      p := NEW."project_id";
      session_id_of_row := NEW."id";
    END IF;
    found_plan := false;
    FOR linked IN SELECT pn."id" FROM "plan" pn WHERE pn."session_id" = session_id_of_row LOOP
      found_plan := true;
      PERFORM live_signal_emit(w, p, linked."id");
    END LOOP;
    IF NOT found_plan THEN
      PERFORM live_signal_emit(w, p, NULL);
    END IF;

  ELSIF TG_TABLE_NAME = 'plan' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM live_signal_emit(OLD."workspace_id", OLD."project_id", OLD."id");
    ELSE
      PERFORM live_signal_emit(NEW."workspace_id", NEW."project_id", NEW."id");
    END IF;

  ELSIF TG_TABLE_NAME IN ('review_verdict_record', 'review_dismissal') THEN
    -- A review verdict record or a dismissal (Bug MOTIR-10504): both carry their own
    -- workspace and project.
    IF TG_OP = 'DELETE' THEN
      PERFORM live_signal_emit(OLD."workspace_id", OLD."project_id", NULL);
    ELSE
      PERFORM live_signal_emit(NEW."workspace_id", NEW."project_id", NULL);
    END IF;

  ELSIF TG_TABLE_NAME = 'work_item_delivery' THEN
    -- A pull request linked to or unlinked from a card (Bug MOTIR-10504): the workspace
    -- is the row's, the project its card's. A card deleted in the same statement reads
    -- NULL and wakes the whole workspace, which is a redundant read, never a missed one.
    IF TG_OP = 'DELETE' THEN
      w := OLD."workspace_id";
      SELECT wi."projectId" INTO p FROM "work_item" wi WHERE wi."id" = OLD."work_item_id";
    ELSE
      w := NEW."workspace_id";
      SELECT wi."projectId" INTO p FROM "work_item" wi WHERE wi."id" = NEW."work_item_id";
    END IF;
    PERFORM live_signal_emit(w, p, NULL);

  ELSIF TG_TABLE_NAME = 'github_pull_request_review' THEN
    -- A GitHub review (Bug MOTIR-10504) has no workspace of its own: it hangs off a pull
    -- request, which any number of cards in any number of workspaces deliver. Every
    -- (workspace, project) of a delivering card hears it. A review on a pull request no
    -- card delivers emits nothing: no row can draw it, and the link that later makes one
    -- draw it fires `work_item_delivery`'s own trigger.
    FOR linked IN
      SELECT DISTINCT wi."workspaceId" AS w, wi."projectId" AS p
        FROM "work_item_delivery" d
        JOIN "work_item" wi ON wi."id" = d."work_item_id"
       WHERE d."github_pull_request_id" = (CASE WHEN TG_OP = 'DELETE'
                                                THEN OLD."github_pull_request_id"
                                                ELSE NEW."github_pull_request_id" END)
    LOOP
      PERFORM live_signal_emit(linked.w, linked.p, NULL);
    END LOOP;

  ELSE
    -- The plan-child tables: plan_item, plan_revision, plan_step,
    -- plan_narration, plan_narration_session. Each carries `plan_id` only.
    IF TG_OP = 'DELETE' THEN
      plan_id_of_row := OLD."plan_id";
    ELSE
      plan_id_of_row := NEW."plan_id";
    END IF;
    SELECT pn."workspace_id", pn."project_id" INTO w, p
      FROM "plan" pn
     WHERE pn."id" = plan_id_of_row;
    PERFORM live_signal_emit(w, p, plan_id_of_row);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_live_signal_review_verdict_record"
  AFTER INSERT OR UPDATE OR DELETE ON "review_verdict_record"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_review_dismissal"
  AFTER INSERT OR UPDATE OR DELETE ON "review_dismissal"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_work_item_delivery"
  AFTER INSERT OR UPDATE OR DELETE ON "work_item_delivery"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();

CREATE TRIGGER "trg_live_signal_github_pull_request_review"
  AFTER INSERT OR UPDATE OR DELETE ON "github_pull_request_review"
  FOR EACH ROW EXECUTE FUNCTION live_signal_notify();
