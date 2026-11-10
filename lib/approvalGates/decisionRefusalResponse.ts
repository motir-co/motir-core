import { NextResponse } from 'next/server';
import {
  ApprovalGateError,
  ApprovalGateMergeRefusedError,
  ApprovalGatePrimaryPendingError,
  ApprovalGateStaleSubjectError,
  ApprovalGateVerbNotOfferedError,
} from '@/lib/approvalGates/errors';
import { APPROVAL_GATE_STATUS } from '@/lib/approvalGates/httpStatus';
import {
  PlanApprovingError,
  PlanDecisionStampRequiredError,
  PlanGateAwaitingError,
  PlanNotDecidableYetError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';

// THE DECIDE DOOR'S REFUSALS AS HTTP — one mapping for every route that decides a gate
// (MOTIR-6038). It was the decide route's own (`app/api/approval-gates/[id]/decide`);
// the plan routes (`/api/plans/[id]/approve` · `/decline`) and the v1 plan-approval route
// now decide a plan's gate through the same door, so they answer its refusals in the
// same words and the same statuses rather than each keeping a copy that could drift.

/**
 * A gate refusal from the decide door, or null for an error that is not one.
 *
 * Each refusal carries what a caller needs to act on it: a stale one says WHAT moved, a
 * primary-pending one WHICH question to answer first, a verb-not-offered one WHICH of
 * the refusals, a conflict found at the press WHICH members — and a plan HELD by a
 * revision (ADR §11.5c) says who holds it and until when, as data.
 */
export function gateDecisionRefusalResponse(err: unknown): NextResponse | null {
  // A PLAN gate whose plan another press is APPROVING right now (Bug MOTIR-9006): the
  // gate is still awaiting until that approval commits. 409 — the request is well-formed;
  // a second approve, or a decline, conflicts with the approval in progress. It was a
  // misleading 503 *approve timed out* when the second press queued on the plan's lock.
  if (err instanceof PlanApprovingError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        planId: err.planId,
        approvingSince: err.approvingSince?.toISOString() ?? null,
      },
      { status: 409 },
    );
  }
  // A PLAN gate's inherited hold (MOTIR-6035; §11.5c): the gate is still awaiting and
  // says until when. 409 — the request is well-formed, the plan is being rewritten.
  if (err instanceof PlanRevisionInFlightError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        heldBy: err.heldBy,
        expiresAt: err.expiresAt.toISOString(),
      },
      { status: 409 },
    );
  }
  if (err instanceof ApprovalGateError) {
    return NextResponse.json(
      err instanceof ApprovalGateStaleSubjectError
        ? { code: err.code, error: err.message, moved: err.moved }
        : err instanceof ApprovalGatePrimaryPendingError
          ? { code: err.code, error: err.message, primary: err.primary }
          : err instanceof ApprovalGateVerbNotOfferedError
            ? { code: err.code, error: err.message, reason: err.reason }
            : err instanceof ApprovalGateMergeRefusedError && err.atPress
              ? { code: err.code, error: err.message, atPress: true, conflicts: err.conflicts }
              : { code: err.code, error: err.message },
      { status: APPROVAL_GATE_STATUS[err.tag] },
    );
  }
  return null;
}

/**
 * The refusals of a PLAN decision entrance (`planDecisionService`) — the door's, plus
 * the three only an entrance can meet: a `planned` plan nobody has been asked about yet
 * (the pre-backfill state), a plain write that met a question raised meanwhile, and a
 * person's decision of an asked plan sent without the stamp they were shown.
 */
export function planDecisionRefusalResponse(err: unknown): NextResponse | null {
  if (err instanceof PlanNotDecidableYetError) {
    return NextResponse.json(
      { code: err.code, planId: err.planId, error: err.message },
      { status: 409 },
    );
  }
  if (err instanceof PlanGateAwaitingError) {
    return NextResponse.json(
      { code: err.code, planId: err.planId, gateId: err.gateId, error: err.message },
      { status: 409 },
    );
  }
  if (err instanceof PlanDecisionStampRequiredError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  return gateDecisionRefusalResponse(err);
}
