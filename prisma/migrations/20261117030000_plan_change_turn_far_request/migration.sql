-- A request TOO FAR from a conversation's waiting plan, KEPT on the person's turn
-- (Story MOTIR-11515 · MOTIR-11518).
--
-- Purely ADDITIVE to `plan_change_turn`: two nullable columns, no back-fill. Every
-- existing row reads exactly as it did — a null requirement is "no request kept".
--
-- No RLS stanza, deliberately: RLS is a TABLE-level policy and `plan_change_turn`
-- already carries it (plus the composite FK to `(session_id, workspace_id)`), so the
-- new columns inherit it. See 20260819234500_plan_change_turn_intent_and_citations.

-- AlterTable
ALTER TABLE "plan_change_turn" ADD COLUMN "far_request_requirement" TEXT;
ALTER TABLE "plan_change_turn" ADD COLUMN "far_request_consumed_at" TIMESTAMP(3);
