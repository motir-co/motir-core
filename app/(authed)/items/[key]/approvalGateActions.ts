'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import type { GateDecision } from '@/lib/services/approvalGatesService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { ApprovalGateError, ApprovalGateMergeRefusedError } from '@/lib/approvalGates/errors';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGatePrimaryPendingError,
  ApprovalGateSupersededError,
  ApprovalGateStaleSubjectError,
  ApprovalGateVerbNotOfferedError,
  ApprovalGateTransitionRefusedError,
} from '@/lib/approvalGates/errors';
import { MergeChangeRequestError } from '@/lib/git/errors';
import { QueueAgainRefusedError } from '@/lib/mergeQueue/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  hostNonAnswerRefusal,
  toGateRefusal,
  type GateRefusal,
} from '@/lib/approvalGates/refusals';
import type {
  ApprovalGateDTO,
  ApprovalGateRefusalVerdictDTO,
  ApproveAndMergeMemberOutcomeDTO,
} from '@/lib/dto/approvalGate';
import { reportUnmappedActionRefusal } from '@/lib/actions/unmappedRefusal';

// Server Action for the approval FRAME (Story MOTIR-4778 · Subtask MOTIR-4792),
// beside the section that renders it — the shape `acceptanceActions.ts` ships,
// one service call and a typed result.
//
// ⚠️ IT RETURNS A TYPED REFUSAL, NEVER A MESSAGE STRING. The frame draws each
// refusal in place with its own copy and its own next action
// (`lib/approvalGates/refusals.ts`), so handing it a server sentence would put
// untranslated prose on a decision surface and let anybody add a failure by
// writing one. The tag is the contract; the words are the client's.
//
// ⚠️ IT REVALIDATES THE ITEM PAGE, AND THE CALLER REFRESHES TOO — BOTH HALVES,
// ON PURPOSE (Bug MOTIR-5118). The page-state contract (CLAUDE.md) splits the
// surfaces: the frame reconciles its OWN state from THIS response (the
// inline-edit rule — refreshing the cell that just changed re-reads stale data
// and causes a visible revert), while the SERVER surfaces the decision also
// moves — the core-fields status rail, the record band's `Files kept` line, the
// readiness of every card this one was blocking — are case 2, and they need a
// server render to arrive.
//
// ⚠️ THIS USED TO SAY *IT DOES NOT `revalidatePath` — THE CALLER REFRESHES*, AND
// THE CALLER'S REFRESH ALONE WAS MEASURED INSUFFICIENT. It is not that
// `router.refresh()` fails to fire. In the failing run's trace it fires, and it
// succeeds: the decide action POSTs at `14:23:14.429` and returns 200 in 95 ms,
// the refresh GETs `/items/GATE-2?_rsc=…` at `14:23:14.526` and returns 200 in
// 113 ms — and the status rail still read `In Progress` twenty seconds later,
// with the frame beside it reading `Approved`. The action's own response carried
// no revalidation (no `x-action-revalidated`), so the fresh tree arrived on a
// SECOND, separate apply, and that apply is the one that goes missing. It is
// intermittent by construction: the same walk repaints in place on a quiet lane
// and does not on a loaded one, which is why this shipped looking correct.
//
// So the fix is to put the fresh tree on the ACTION'S OWN RESPONSE, where
// nothing can race it away — which is exactly what the sibling twenty lines away
// in `actions.ts` already does (`createLinkAction`, whose last line is
// `revalidatePath(`/items/${input.identifier}`)`). The client half stays: it is
// what reaches the surfaces on a navigation the server tree does not cover, and
// removing it is a separate claim nobody has measured.
//
// ⚠️ AND IT DOES NOT UNDO THE INLINE-EDIT RULE. The frame's own state is
// `useState`-seeded in `DesignResultSection`, so a fresh `gate` prop cannot
// clobber the value this reader was just handed — the port is keyed on the
// SERVER's gate deliberately, and a re-render is what swaps in its pinned
// answer. Case 1 is about re-READING the edited cell, and nothing here does.
//
// ⚠️ THE IDENTIFIER IS A PARAMETER RATHER THAN A LOOKUP. The action knows a
// gate id; the path is the CARD's. `DesignResultSection` already holds
// `itemIdentifier` (it renders it in the consequence line), so passing it costs
// nothing and keeps this action free of a read it would otherwise need.

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

export type DecideGateActionResult =
  | {
      ok: true;
      gate: ApprovalGateDTO;
      /** Whether the approved version's files were pinned — see
       *  `DecideGateResult.filesKept` (MOTIR-5265). */
      filesKept: boolean | null;
      /**
       * The status key the decision WROTE onto the card, or null (MOTIR-5896). For
       * every kind but a choice this equals `gate.outcomeRef`; a choice's
       * `outcomeRef` is the option it picked (MOTIR-5893), so the status rail reads
       * this instead.
       */
      statusWritten: string | null;
    }
  | { ok: false; refusal: GateRefusal };

/** Record a decision on one approval gate, whatever its kind. */
export async function decideApprovalGateAction(input: {
  gateId: string;
  decision: GateDecision;
  /** The option a `choose` picks (MOTIR-5893) — the route's `optionId`, mirrored. */
  optionId?: string | null;
  /** The card whose page the frame is on — the path revalidated on success. */
  identifier: string;
  noteMd?: string | null;
  /**
   * WHAT A DESIGN REFUSAL MEANT — `revise` or `re_plan` (MOTIR-6421; ADR §10d). The door
   * requires it on a `request_changes` of a `design_result` gate and refuses it on every
   * other kind and verb, so the action passes it through untouched.
   */
  refusalVerdict?: ApprovalGateRefusalVerdictDTO | null;
  /**
   * The `stamp` the frame's read handed this reader (MOTIR-5234) — what they were
   * shown. REQUIRED: a press that cannot say what it saw has not rendered a gate.
   */
  stamp: string;
}): Promise<DecideGateActionResult> {
  const { gateId, decision, identifier, noteMd, stamp } = input;
  const refusalVerdict = input.refusalVerdict ?? null;
  const optionId = decision === 'choose' ? (input.optionId?.trim() ?? '') : null;
  const ctx = await requireContext();
  try {
    // Through the merge entry point (MOTIR-5517 · MOTIR-5624): an approve on the card's
    // approve-to-merge gate is decided and then merges, exactly as the press does; every
    // other decision is the door's.
    const { gate, filesKept, effect } = await pullRequestMergeService.decideGate(
      // `ui` — a SERVER ACTION is a person pressing the control in Motir. It is
      // the audit's strongest claim (ADR §6a: *"a human click must be
      // distinguishable from a programmatic call"*), so it is stated at the one
      // call site that actually knows it rather than defaulted in the door.
      { gateId, decision, optionId, noteMd, refusalVerdict, source: 'ui', stamp },
      ctx,
    );
    // The server half, on the action's own response. A REFUSAL revalidates
    // nothing — no surface moved, and re-rendering the page under a reader who
    // is about to be shown why their press did not land helps nobody.
    revalidatePath(`/items/${identifier}`);
    // ⚠️ AND THE WORKBENCH, ALWAYS — because EVERY decision moves its
    // **To approve** count, whichever surface the press came from (MOTIR-4794).
    // The tab is the other home of this frame: a decision made there must leave
    // the row AND drop the badge in ONE render, and the paragraph above is the
    // measurement that says the client refresh alone cannot be trusted to do
    // it. A decision made on the ITEM page moves that same badge, so this is
    // correct for both callers rather than a branch for one of them.
    revalidatePath(AUTHED_LANDING_PATH);
    return { ok: true, gate, filesKept, statusWritten: effect.statusWritten };
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) return { ok: false, refusal };
    // A typed refusal no arm above maps is still a refusal, not a fault: the
    // frame's unexpected arm in place of a 500, reported (MOTIR-6147).
    if (reportUnmappedActionRefusal(err, 'decideApprovalGateAction')) {
      return { ok: false, refusal: toGateRefusal('UNEXPECTED') };
    }
    throw err;
  }
}

/** A door's refusal in the frame's vocabulary, or null for an error that is not one. */
function refusalOf(err: unknown): GateRefusal | null {
  // The shared project gate's two refusals. A non-browser reads NOT_FOUND and
  // a browser without the kind's permission floor reads NOT_AUTHORISED, so
  // neither leaks the other — the same posture the HTTP route takes.
  if (err instanceof ProjectNotFoundError) return toGateRefusal('APPROVAL_GATE_NOT_FOUND');
  if (err instanceof PermissionDeniedError) return toGateRefusal('APPROVAL_GATE_NOT_AUTHORISED');
  if (err instanceof ApprovalGateMergeRefusedError) {
    return toGateRefusal(err.tag, {
      permission: err.permission,
      reason: err.reason,
      atPress: err.atPress,
      conflicts: err.conflicts,
    });
  }
  // The host did not answer the merge: nothing was decided, and there is no refusal
  // of the host's to draw — the frame's unexpected arm, logged by the service; or the
  // host THROTTLED it, named with GitHub's wait (Bug MOTIR-11841).
  if (err instanceof MergeChangeRequestError) return hostNonAnswerRefusal(err);
  if (err instanceof ApprovalGateError) {
    // ⚠️ The already-decided refusal is the one that can NAME the winner, and
    // that is the whole reason the door locks and re-reads rather than
    // guessing. Passing the label through is what lets the frame say "Mara
    // approved this a moment ago" instead of a generic conflict.
    const decidedByLabel =
      err instanceof ApprovalGateAlreadyDecidedError ? err.decidedByLabel : null;
    // ⚠️ And the SUPERSEDED refusal is the one that can say WHY (MOTIR-5667),
    // for the same reason: the door read the row under its lock, so the cause is
    // known here and nowhere the frame could re-derive it.
    const supersedeCause = err instanceof ApprovalGateSupersededError ? err.supersedeCause : null;
    // ⚠️ And the STALE refusal is the one that can say WHAT MOVED (MOTIR-5234),
    // because the door compared component by component under its lock.
    const moved = err instanceof ApprovalGateStaleSubjectError ? err.moved : null;
    // ⚠️ And the PRIMARY-PENDING refusal names WHICH question holds the merge (MOTIR-5785).
    const primary = err instanceof ApprovalGatePrimaryPendingError ? err.primary : null;
    // ⚠️ And the VERB-NOT-OFFERED refusal says which input was missing (MOTIR-6427), so a
    // design band can answer a missing verdict under the verdict, not under the reason.
    const reason = err instanceof ApprovalGateVerbNotOfferedError ? err.reason : null;
    // ⚠️ And the TRANSITION refusal says whether the card is already closed (MOTIR-11835),
    // which is what decides the way out the frame names.
    const closed = err instanceof ApprovalGateTransitionRefusedError ? err.closed : null;
    return toGateRefusal(err.tag, {
      decidedByLabel,
      supersedeCause,
      moved,
      primary,
      reason,
      closed,
    });
  }
  return null;
}

export type ApproveAndMergeActionResult =
  | {
      ok: true;
      /** The APPROVAL, decided — it stands whatever the merges below did. */
      gate: ApprovalGateDTO;
      /** Each pull request of the set: merged, queued, refused, or no merge gate. */
      members: ApproveAndMergeMemberOutcomeDTO[];
    }
  | { ok: false; refusal: GateRefusal };

/**
 * APPROVE AND MERGE (Story MOTIR-4909 · Subtask MOTIR-5484) — the Development frame's press,
 * through `pullRequestMergeService.approveAndMerge` (MOTIR-5483): the approval commits first,
 * then each pull request merges or joins its merge queue. A refusal of the APPROVAL returns
 * here and merges nothing; a refused pull request is a MEMBER outcome of a successful press.
 * Revalidates both halves exactly as `decideApprovalGateAction` does, for the same reasons.
 */
export async function approveAndMergeAction(input: {
  gateId: string;
  identifier: string;
  /** What this reader was shown (MOTIR-5234) — see {@link decideApprovalGateAction}. */
  stamp: string;
}): Promise<ApproveAndMergeActionResult> {
  const ctx = await requireContext();
  try {
    const { approval, members } = await pullRequestMergeService.approveAndMerge(
      { gateId: input.gateId, noteMd: null, source: 'ui', stamp: input.stamp },
      ctx,
    );
    revalidatePath(`/items/${input.identifier}`);
    revalidatePath(AUTHED_LANDING_PATH);
    return { ok: true, gate: approval.gate, members };
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) return { ok: false, refusal };
    // A typed refusal no arm above maps is still a refusal, not a fault: the
    // frame's unexpected arm in place of a 500, reported (MOTIR-6147).
    if (reportUnmappedActionRefusal(err, 'approveAndMergeAction')) {
      return { ok: false, refusal: toGateRefusal('UNEXPECTED') };
    }
    throw err;
  }
}

export type RetryApproveAndMergeMemberActionResult =
  | { ok: true; member: ApproveAndMergeMemberOutcomeDTO }
  | { ok: false; refusal: GateRefusal };

/**
 * THE ROW'S VERB — *Retry merge* on a refused member, *Queue again* on one the queue
 * removed (MOTIR-5484 · MOTIR-5634).
 *
 * ⚠️ ON THE RE-ASKED GATE THE PRESS IS THE NEW APPROVAL (MOTIR-5802; §4 FOURTH AMENDMENT,
 * point 4), so the reader's `stamp` travels with it exactly as it does with *Approve and
 * merge*: what they were shown is what they decided about.
 */
export async function retryApproveAndMergeMemberAction(input: {
  approvalGateId: string;
  pullRequestId: string;
  identifier: string;
  stamp: string;
}): Promise<RetryApproveAndMergeMemberActionResult> {
  const ctx = await requireContext();
  try {
    const member = await pullRequestMergeService.retryApproveAndMergeMember(
      {
        approvalGateId: input.approvalGateId,
        pullRequestId: input.pullRequestId,
        noteMd: null,
        source: 'ui',
        stamp: input.stamp,
      },
      ctx,
    );
    revalidatePath(`/items/${input.identifier}`);
    revalidatePath(AUTHED_LANDING_PATH);
    return { ok: true, member };
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) return { ok: false, refusal };
    // A typed refusal no arm above maps is still a refusal, not a fault: the
    // frame's unexpected arm in place of a 500, reported (MOTIR-6147).
    if (reportUnmappedActionRefusal(err, 'retryApproveAndMergeMemberAction')) {
      return { ok: false, refusal: toGateRefusal('UNEXPECTED') };
    }
    throw err;
  }
}

export type QueueAgainAutoActionResult =
  | { ok: true; status: string }
  | { ok: false; refusal: GateRefusal };

/**
 * *Queue again* in an `auto` project (MOTIR-5634) — a person's press that re-sends the
 * automatic merge for the head the merge queue removed. The `manual` press is
 * {@link retryApproveAndMergeMemberAction}: it reuses the card's decided approval.
 */
export async function queueAgainAutoAction(input: {
  workItemId: string;
  pullRequestId: string;
  identifier: string;
}): Promise<QueueAgainAutoActionResult> {
  const ctx = await requireContext();
  try {
    const result = await pullRequestMergeService.requeueAutoMember(
      { workItemId: input.workItemId, pullRequestId: input.pullRequestId },
      ctx,
    );
    revalidatePath(`/items/${input.identifier}`);
    return { ok: true, status: result.status };
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) return { ok: false, refusal };
    // Queue again's own refusals (wrong mode, a moved head, no standing exit) are
    // states the frame never offers the button in, so reaching one is a stale page.
    if (err instanceof QueueAgainRefusedError) return { ok: false, refusal: { tag: 'UNEXPECTED' } };
    // A typed refusal no arm above maps is still a refusal, not a fault: the
    // frame's unexpected arm in place of a 500, reported (MOTIR-6147).
    if (reportUnmappedActionRefusal(err, 'queueAgainAutoAction')) {
      return { ok: false, refusal: toGateRefusal('UNEXPECTED') };
    }
    throw err;
  }
}
