import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';

import { planDecisionService } from '@/lib/services/planDecisionService';
import { planDecisionRefusalResponse } from '@/lib/approvalGates/decisionRefusalResponse';
import { readPlanDecisionPress } from '@/lib/plans/decisionPress';
import {
  InvalidProposalError,
  PlanApproveTimedOutError,
  PlanGrammarError,
  PlanHasNoProposalsError,
  PlanItemFieldRejectedError,
  PlanItemTargetMissingError,
  PlanItemUnknownTargetRepoError,
  PlanItemUnknownTargetRepoRoleError,
  PlanItemUnresolvableTargetRepoRoleError,
  PlanNotFoundError,
  PlanNotInExpectedStatusError,
  PlanProposalRepoPinMovedError,
  PlanRefGraphError,
  PlanTargetImmutableError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import {
  CrossWorkspaceLinkError,
  DuplicateLinkError,
  SelfLinkError,
  WorkItemLinkCycleError,
  WorkspaceMismatchLinkError,
} from '@/lib/workItems/linkErrors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { aiPlanGateErrorResponse } from '@/lib/ai/planGateResponse';

// POST /api/plans/[id]/approve — APPROVE = materialize (Subtask 7.4.5 / MOTIR-847,
// calling the MOTIR-1336 substrate). Adds become real work items, modifies apply
// to the same id (one logged revision), removes archive. The service is the atomic
// one-shot guard: a second concurrent approve observes `approved` and 409s.
//
// ⚠️ IT DECIDES THE PLAN'S GATE (Story MOTIR-6012 · MOTIR-6038; ADR `approval-gates.md`
// §11.8). `planDecisionService.approve` resolves the plan's `awaiting` `plan_approval`
// gate and decides it through the ONE decide door, with the stamp the reader was shown
// — the plan page, the planning rail (and its close guard's *Confirm & add*), the
// `/ready` nudge and the onboarding approve all press through here. The door's refusals
// answer in the decide route's words and statuses (`planDecisionRefusalResponse`):
// already decided / withdrawn / stale / held by a revision → 409, a `planned` plan
// nobody has been asked about yet → 409 `PLAN_NOT_DECIDABLE_YET`, an asked plan pressed
// without its stamp → 400.
//
// JSON body (optional — an empty body is a press with no stamp): `stamp` (the
// `PlanReviewDto.gate.stamp` the reader was shown), `noteMd` (optional).
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, call ONE service method,
// map typed errors. The service asserts `ai:decide_plan` (→ 403/404).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const press = await readPlanDecisionPress(req);
  // The provisional name an AI-onboarding draft is minted with (MOTIR-1486,
  // `startNewAiProjectAction`). Passed so approve can name the draft from the
  // plan's `productName` (MOTIR-1551) ONLY while the name is still this
  // placeholder — resolved here (i18n stays out of the service layer).
  const t = await getTranslations('shell');
  try {
    const plan = await planDecisionService.approve(
      { planId: id, stamp: press.stamp, noteMd: press.noteMd, source: 'api' },
      ctx,
      { provisionalProjectName: t('project.untitled') },
    );
    return NextResponse.json(plan);
  } catch (err) {
    // MOTIR-2291 — the shared project gate's two refusals (404 for a non-browser,
    // 403 naming the key). Without this arm they fall through to a 500.
    const gate = aiPlanGateErrorResponse(err);
    if (gate) return gate;
    // The decide door's refusals, and the entrance's own three (MOTIR-6038).
    const refusal = planDecisionRefusalResponse(err);
    if (refusal) return refusal;
    if (err instanceof PlanNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotInExpectedStatusError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    // The plan holds NOTHING (MOTIR-4146) — 409 for the same reason as the arm
    // directly above: the request is well-formed and the PLAN is in a state
    // approve cannot act on. Nothing was written; the reviewer's remaining move
    // is Decline, which the message says and the rail is the surface for.
    if (err instanceof PlanHasNoProposalsError) {
      return NextResponse.json(
        { code: err.code, planId: err.planId, error: err.message },
        { status: 409 },
      );
    }
    // The confirmation gate (7.12.5 · MOTIR-911) — the proposal set was rejected
    // BEFORE any write, so the tree is untouched. A malformed proposal is a 400
    // (never the DB trigger's raw SQLSTATE surfacing as a 500); a target that
    // reached a terminal status is a 409 (it moved under the proposal).
    if (err instanceof PlanGrammarError || err instanceof PlanRefGraphError) {
      return NextResponse.json(
        { code: err.code, reason: err.reason, planItemId: err.planItemId, error: err.message },
        { status: 400 },
      );
    }
    // A proposal's repo pin MOVED between approve's pre-transaction resolution and
    // the transaction that materializes it (MOTIR-3604) — 409, like the two
    // arms above and for the same reason: nothing is malformed, the proposal set
    // moved under the approve. The transaction rolled back, so the correction
    // stands and re-pressing Approve applies it.
    if (err instanceof PlanProposalRepoPinMovedError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, error: err.message },
        { status: 409 },
      );
    }
    if (err instanceof PlanTargetImmutableError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, error: err.message },
        { status: 409 },
      );
    }
    // A `modify` MARKS a target that is not finished — reopened since the append
    // (MOTIR-6663). 422, the status the same refusal gets at the proposal doors:
    // the plan's author removes the card instead. Raised by the gate before any
    // write, so the tree is untouched.
    if (err instanceof InvalidProposalError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, error: err.message },
        { status: 422 },
      );
    }
    // A proposal pinned to a repo outside the project's set (MOTIR-1884) — 422,
    // the same status the identical bad pin gets on the direct work-item write
    // path. Raised before the transaction opens, so nothing was written; the
    // `planItemId` says WHICH proposal to fix.
    if (err instanceof PlanItemUnknownTargetRepoError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, error: err.message },
        { status: 422 },
      );
    }
    // A proposal pinning a repo ROLE outside ADR §1.1's vocabulary (MOTIR-1912) —
    // 422 like the bad NAME above, and for the same reason: a malformed pin means
    // the same thing however it arrived. Also raised before the transaction opens,
    // so nothing was written.
    if (err instanceof PlanItemUnknownTargetRepoRoleError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, role: err.role, error: err.message },
        { status: 422 },
      );
    }
    // A vocabulary role the project's set resolves to no single row (MOTIR-11039),
    // refused before the transaction opens — nothing was written.
    if (err instanceof PlanItemUnresolvableTargetRepoRoleError) {
      return NextResponse.json(
        {
          code: err.code,
          planItemId: err.planItemId,
          role: err.role,
          reason: err.reason,
          error: err.message,
        },
        { status: 422 },
      );
    }
    // Materialize-time proposal failures the gate cannot pre-empt (a target
    // archived between the gate and the write). The transaction rolled back.
    if (err instanceof UnresolvedPlanRefError || err instanceof PlanItemTargetMissingError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    // The transaction budget was exhausted (Prisma P2028) — MOTIR-3396. 503, not
    // 500: the transaction rolled back, so the tree is byte-identical, the plan
    // is still `planned`, and a retry is a legitimate next move. Without this arm
    // it fell through to the rethrow below and the caller got a bare 500 with an
    // empty body — which reads as "something is broken" and led to Approve being
    // pressed three more times on the plan that produced this bug. `itemCount`
    // rides on the payload because "too large for one transaction" is only
    // actionable if the response says how large.
    if (err instanceof PlanApproveTimedOutError) {
      return NextResponse.json(
        { code: err.code, planId: err.planId, itemCount: err.itemCount, error: err.message },
        { status: 503 },
      );
    }
    // A proposal carried a value the `work_item` schema rejects, and the ORM said
    // so from inside materialize (MOTIR-3654) — 422, the same status the other two
    // malformed-proposal arms above get, because it means the same thing: fix the
    // proposal, not the request. The transaction rolled back, so the tree is
    // byte-identical and the key counter has not advanced.
    //
    // This is the arm the P2028 comment directly above predicted one failure over:
    // without it a `PrismaClientValidationError` falls through to the rethrow and
    // the caller gets a bare 500 with an empty body — which reads as "something is
    // broken" and led to Approve being pressed twice on the plan that produced
    // this bug. `planItemId` says WHICH proposal, and `field` (when Prisma's
    // message yields it) says which column.
    if (err instanceof PlanItemFieldRejectedError) {
      return NextResponse.json(
        { code: err.code, planItemId: err.planItemId, field: err.field, error: err.message },
        { status: 422 },
      );
    }
    // ── A REFUSAL RAISED BY A DATABASE TRIGGER (MOTIR-3936) ───────────────────
    //
    // `materialize` wires `is_blocked_by` edges, and four `work_item_link`
    // triggers can reject one. `workItemLinkRepository` already translates their
    // SQLSTATE-23514 markers into typed errors — so the refusal arrives here
    // fully classified and, until this arm, fell straight through the rethrow
    // below to a bare 500 with an empty body.
    //
    // ⚠️ THE THIRD TIME. The P2028 arm above and the
    // `PrismaClientValidationError` arm below it EACH record that a missing arm
    // "led to Approve being pressed three more times"; a `WI_LINK_CYCLE` from two
    // `modify` patches writing opposite directions of one edge produced exactly
    // that outcome again on 2026-08-30. The plan's OWN cycles are now refused at
    // the CLOSE (`validateProposals.ts`'s edge-graph check), so what reaches this
    // arm is tree-caused — a ring closed by an edge somebody committed while the
    // plan waited — and the reviewer is told which two cards, from the ids the
    // trigger message already interpolates.
    if (err instanceof WorkItemLinkCycleError) {
      return NextResponse.json(
        {
          code: err.code,
          fromWorkItemId: err.attempted.fromId,
          toWorkItemId: err.attempted.toId,
          error: `${err.message} The plan would wire ${err.attempted.fromId} \`is_blocked_by\` ${err.attempted.toId}, and a chain of existing dependencies already leads back. The plan's author must drop one of the two edges — a reviewer cannot repair a proposal.`,
        },
        { status: 409 },
      );
    }
    if (err instanceof SelfLinkError || err instanceof DuplicateLinkError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    // 404 rather than 409, deliberately: `linkErrors.ts` records that naming the
    // other workspace is the existence oracle every other surface refuses.
    if (err instanceof CrossWorkspaceLinkError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    // An invariant violation, and it STAYS a 5xx (`linkErrors.ts`) — but as a
    // CLASSIFIED one carrying its code, which is the property this card asserts:
    // no approve failure reaches the caller as a bare 500 with an empty body.
    if (err instanceof WorkspaceMismatchLinkError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 500 });
    }
    throw err;
  }
}
