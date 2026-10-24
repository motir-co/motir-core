import { planRevisionHoldService } from '@/lib/services/planRevisionHoldService';
import type {
  ApprovalGateKind,
  ApprovalGateState,
  Prisma,
  WorkItem,
} from '@/generated/prisma/client';
import type {
  ApprovalGateAuthorityDTO,
  ApprovalGateDTO,
  ApprovalGateDecisionSourceDTO,
  ApprovalGateRefusalVerdictDTO,
  ApprovalGateKindDTO,
  ApprovalGatePendingPayloadDTO,
  EarlierApprovalDTO,
  HeldTransitionDTO,
  LatestRefusalDTO,
  ApprovalQueueDto,
  ApprovalQueueRowDto,
  ApprovalRecordsPageDto,
  GateDecision,
  PendingDecisionDTO,
} from '@/lib/dto/approvalGate';
import { APPROVAL_GATE_REFUSAL_VERDICTS } from '@/lib/dto/approvalGate';
import type { AppliedGateTransition, GateEffect } from '@/lib/approvalGates/registry';
import { emitAppliedGateTransitions } from '@/lib/approvalGates/gateTransition';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ApprovalGatePendingError } from '@/lib/workItems/errors';
import {
  APPROVAL_GATE_HANDLERS,
  handlerFor,
  isRegisteredGateKind,
  type RegisteredGateKind,
} from '@/lib/approvalGates/registry';
import { routedToDisplayName, routingTargetId } from '@/lib/approvalGates/routing';
import { foldPendingDecisions } from '@/lib/approvalGates/pendingDecision';
import {
  SETTINGS_DOOR_PERMISSION,
  settingsDoorFor,
  type GateSettingsDoor,
} from '@/lib/approvalGates/settingsDoor';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateNotAuthorisedError,
  ApprovalGateSyncedActorMismatchError,
  ApprovalGateNotFoundError,
  ApprovalGateSupersededError,
  ApprovalGateStaleSubjectError,
  ApprovalGateVerbNotOfferedError,
} from '@/lib/approvalGates/errors';
import {
  DECIDED_WITHOUT_A_READER,
  computeGateStamp,
  movedAsReaderSees,
  stampMoved,
  type DecisionStamp,
  type StampComponent,
} from '@/lib/approvalGates/stamp';
import {
  approvalGateRepository,
  type ApprovalRecordsScope,
  type AwaitingRoutingScope,
} from '@/lib/repositories/approvalGateRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { gateSetFor } from '@/lib/services/gateSetFor';
import { summarizeGateSubjects } from '@/lib/approvalGates/subjectSummary';
import { HOME_PAGE_SIZE, type HomeActorContext } from '@/lib/services/homeService';
import {
  VISITOR_ACTOR_ID,
  visitorServiceContext,
  type VisitorReadContext,
} from '@/lib/visitor/context';
import { personName } from '@/lib/people/personLabel';
import { isVisitorContext, openVisitorRead } from '@/lib/visitor/readScope';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  holdsRecordView,
  projectAccessService,
  type AccessActorContext,
} from '@/lib/services/projectAccessService';
import { canActOnApprovals } from '@/lib/approvalGates/actPermissions';
import { availableRoomViews, resolveRoomView, type RoomView } from '@/lib/rooms/roomView';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  toApprovalGateDto,
  toEarlierApprovalDto,
  toApprovalQueueRowDto,
  toApprovalRecordDecidedRowDto,
} from '@/lib/mappers/approvalGateMappers';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { heldMoves } from '@/lib/approvalGates/heldMoves';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { CANCELLED_STATUS_KEY } from '@/lib/approvalGates/heldMoves';
import { requireGateCard } from '@/lib/approvalGates/gateCard';
import { refusalVerdictOfferFor } from '@/lib/approvalGates/verdictOffer';
import { planGateStampInputs, planSubjectVersion } from '@/lib/approvalGates/planApprovalDigest';
import { readPlanGateHeld } from '@/lib/approvalGates/planApprovalHandler';
import { planRepository } from '@/lib/repositories/planRepository';
import { recomputeWorkItemFixReason } from './fixReasonService';
import { resumeStateService } from './resumeStateService';
import { requestGateResumeAfterDecision } from './gateResumeRequest';
import { isRunHoldingGateKind } from '@/lib/dispatchRuns/heldGates';
import { designAutoRerunRepository } from '@/lib/repositories/designAutoRerunRepository';
import { toDesignAutoRerunDto } from '@/lib/mappers/designAutoRerunMappers';

/**
 * WHAT A DECISION CAUSED, as the deciding write records it — the ONE writer of
 * `approval_gate.outcome_ref` (MOTIR-5520's pin, `tests/github/pullRequestMergeRecord.test.ts`).
 * Shared by the decide door and the system approval (MOTIR-697), so the column keeps one
 * meaning whichever of them decided.
 *
 * ⚠️ ON A CHOICE it is the OPTION'S ID (ADR §1's MOTIR-5887 amendment, point 7): Workflow A
 * always writes `done`, so the status is implied by the kind and the column holds what only
 * this decision caused. `confirmedRecord` is a CONFIRMED decision's written record, or that
 * there was none (ADR §1's MOTIR-5952 amendment, point 8); null on every other kind.
 */
function decisionOutcomeFields(effect: GateEffect): {
  outcomeRef: string | null;
  chosenOption: NonNullable<GateEffect['chosenOption']> | null;
  confirmedRecord: NonNullable<GateEffect['confirmedRecord']> | null;
} {
  return {
    outcomeRef: effect.chosenOption ? effect.chosenOption.optionId : effect.statusWritten,
    chosenOption: effect.chosenOption ?? null,
    confirmedRecord: effect.confirmedRecord ?? null,
  };
}

/** The design-approval switch's address — the card's anchor on Settings → Approvals. */
export const DESIGN_APPROVAL_SETTINGS_HREF = '/settings/project/approvals#design-approval';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { resolveStatusIntent } from '@/lib/workflows/statusIntent';

// THE DECIDE DOOR (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
// docs/decisions/approval-gates.md).
//
// ⚠️ ONE service and ONE route record a decision on ANY gate, for every kind that
// will ever exist — and the story's "one approve language" claim rests on that
// being true AT THE SERVICE LAYER, not merely on screen. If the two gates got two
// service doors, Motir would have two approval features that look alike, and
// every later change would have to be made twice and kept in agreement by nobody.
//
// So everything generic lives here — the lock, the re-read, the actor gate, the
// state refusals, the write of the decision — and everything kind-specific is a
// `GateHandler` in `lib/approvalGates/registry.ts`. A third kind is a row in the
// enum, a handler, and a renderer. No second vocabulary, no second control, no
// second decide door.

/** The two verbs — DECLARED in `lib/dto/approvalGate.ts` (the client/server
 *  boundary; see its own note) and re-exported here so every existing caller of
 *  this service keeps resolving it unchanged. */
export type { GateDecision };

const DECISION_STATE: Record<
  GateDecision,
  Extract<ApprovalGateState, 'approved' | 'changes_requested' | 'overturned' | 'declined'>
> = {
  approve: 'approved',
  request_changes: 'changes_requested',
  // A refused DIRECTION (ADR §1's MOTIR-5952 amendment, point 6a) — its own state,
  // terminal, never an overloaded `changes_requested`.
  overturn: 'overturned',
  // A CHOICE is an approval of one option — no new state value (ADR §1's MOTIR-5887
  // amendment, point 7). The option it picked is on `chosenOption` / `outcomeRef`.
  choose: 'approved',
  // A plan a person ENDED (ADR §11.4, MOTIR-6035) — its own terminal state, never
  // `changes_requested` (which keeps a question open) nor `overturned`.
  decline: 'declined',
};

/** The one kind whose verbs are its OPTIONS rather than `approve` (point 5). */
const CHOICE_KIND = 'decision_choice';
/** The one kind whose refusal is OVERTURN rather than `request_changes` (ADR §1's
 *  MOTIR-5952 amendment, point 6). */
const CONFIRMATION_KIND = 'decision_confirmation';
/** The one kind that offers no `request_changes` because a plan is changed by TALKING
 *  to the planner (ADR §11.4, MOTIR-6035). */
const PLAN_KIND = 'plan_approval';
/** The kind whose one verb is Mark done — manual work is done or not done
 *  (`docs/decisions/manual-work-gate.md` §4, MOTIR-7474). */
const MANUAL_WORK_KIND = 'manual_work';
/** The REVIEW AGENT's kind (ADR §12.3, MOTIR-6819) — decided by the agent through
 *  {@link approvalGatesService.decideAgentReview}, or APPROVED by the routed person with a
 *  reason (*Continue without the review*); a person has no refusal verb on it. */
const AGENT_REVIEW_KIND = 'agent_review';
/** The kind with NO verbs at all — the person answers a planning session by sending a turn
 *  (MOTIR-7913; ADR §1's MOTIR-7906 amendment). */
const PLANNING_SESSION_KIND = 'planning_session';

export interface DecideGateInput {
  gateId: string;
  decision: GateDecision;
  /**
   * WHICH OPTION a `choose` picks (MOTIR-5893) — its id as the parse slugs it.
   * Required with `choose` and meaningless with the other two verbs; the door
   * refuses a `choose` without one as an option the choice does not hold.
   */
  optionId?: string | null;
  /** Why they said yes, or what they sent back. Free text, optional. */
  noteMd?: string | null;
  /**
   * WHAT THE REFUSAL MEANT (Story MOTIR-6070 · MOTIR-6421; ADR `approval-gates.md` §10d) —
   * `revise` or `re_plan`. REQUIRED on a `request_changes` a person presses on a
   * `design_result` gate (`refusal_verdict_required`), and REFUSED on every other kind,
   * verb and source (`refusal_verdict_not_offered`) — a GitHub-synced refusal carries
   * none, because nobody was asked. Stored in the deciding write beside `noteMd`.
   */
  refusalVerdict?: ApprovalGateRefusalVerdictDTO | null;
  /**
   * THROUGH WHICH SURFACE this decision arrived — ADR §6a, *"a human click must
   * be distinguishable from a programmatic call"*.
   *
   * ⚠️ REQUIRED, AND IT HAS NO DEFAULT ON PURPOSE. It is the one audit field the
   * door cannot derive: every caller knows what it is and nothing inside the
   * service does. A default would be a guess written into the one table an
   * auditor trusts, and the likeliest default (`ui`) is the value that makes the
   * strongest claim — that a person was present.
   *
   * `github` is legal here and is the SYNC path's answer (§6b's amendment): a
   * review approved in GitHub's own UI, where nobody clicked in Motir. It is not
   * reachable from this build's two callers, both of which have a human or a
   * token behind them.
   *
   * `system` is NOT accepted here, and the type is what refuses it (MOTIR-697): no
   * caller of the door may claim that nobody pressed. Its one writer is
   * {@link approvalGatesService.approveBySystem}, on the publish path.
   */
  source: Exclude<ApprovalGateDecisionSourceDTO, 'system'>;
  /**
   * WHAT THE READER WAS SHOWN — the `stamp` the render read handed them
   * (`WorkItemGateRead.stamp`), handed back with the press (Story MOTIR-5232 ·
   * Subtask MOTIR-5234; ADR §6b's MOTIR-5234 amendment). The door recomputes it
   * under the lock and refuses with `ApprovalGateStaleSubjectError` when anything
   * it covers has moved.
   *
   * ⚠️ REQUIRED, AND IT HAS NO DEFAULT ON PURPOSE — for `source`'s reason. The
   * convenient default (skip the check) is exactly the one that silently disables
   * the guarantee on whichever surface forgot it. A caller that cannot supply it
   * has not rendered a gate.
   *
   * `DECIDED_WITHOUT_A_READER` is the ONE bypass, for a decision nobody pressed —
   * the GitHub review sync, and the companion gate inside a press whose primary
   * was already checked. It is a symbol, so no request can carry it.
   */
  stamp: DecisionStamp;
}

/**
 * INTERNAL options a composing SERVICE may pass to the door — never a route, a server action
 * or an MCP tool, none of which accepts them (Story MOTIR-4909 · MOTIR-5483).
 */
export interface DecideGateOptions {
  /**
   * The instant to record as `decidedAt`, instead of the door's own clock. The approve-and-merge
   * PRESS passes the approval's `decidedAt` to every merge gate it decides afterwards, so the
   * approval and each merge it caused read as ONE person's decision at ONE instant
   * (`approval-gates.md` §8's amendment, decision 5(c)).
   */
  decidedAt?: Date;

  /**
   * THE DECISION WAS MADE ON GITHUB, by somebody with no Motir session (Story
   * MOTIR-4910 · MOTIR-5596; ADR §8 FOURTH AMENDMENT, decisions 3, 4 and 5).
   *
   * ⚠️ THIS IS A SECOND ACTOR SHAPE ON ONE DOOR, NOT A SECOND WRITER.
   * `approvalGateRepository.decide` still has exactly one caller — the guard in
   * `tests/approval-gate-one-language.test.ts` passes unedited — because a synced
   * decision walks every step a press walks: the same lock, the same refusals, the
   * same handler effect, the same audit set. What differs is WHO is recorded and
   * under what authority.
   *
   * ⚠️ INTERNAL. No route, server action or MCP tool accepts it, and the source
   * agreement below is what stops one claiming to be GitHub even if it could.
   */
  synced?: {
    /** `review.user.id` — the stable identity the actor resolution joins on. */
    reviewerGithubUserId: string;
    /** `review.user.login` — what a surface SHOWS, and the whole label when Motir
     *  cannot map the reviewer to a member. */
    reviewerLogin: string;
  };

  /**
   * What the KIND's effect needs from the composing service and nothing else reads
   * (MOTIR-6038 — a plan approve's onboarding rename placeholder), handed through
   * untouched as `GateEffectArgs.effectOptions`. ⚠️ INTERNAL, like the two above.
   */
  effectOptions?: Readonly<Record<string, unknown>>;

  /**
   * THE REVIEW AGENT DECIDED (Story MOTIR-1626 · MOTIR-6819; ADR `approval-gates.md`
   * §12.3) — a hosted review run's verdict on an `agent_review` gate, about the version it
   * NAMES. Recorded under the authority `review_agent`, which `resolveGateAuthority` never
   * returns, so no person's press can claim it; `decidedById` is the run's attributed user
   * (`ctx.userId`). The door refuses it on any other kind, and refuses a verdict about a
   * version that is not the gate's as STALE.
   *
   * ⚠️ INTERNAL, like the three above — reached only through
   * {@link approvalGatesService.decideAgentReview}, whose one caller is the run-token
   * verdict route (MOTIR-6821). No route, server action or MCP tool accepts it.
   */
  reviewAgent?: { subjectVersion: string };
}

export interface DecideGateResult {
  gate: ApprovalGateDTO;
  /** What the decision DID — the status it wrote, or why it wrote none. */
  effect: GateEffect;
  /**
   * Whether the version this gate was ABOUT had its files pinned by this
   * decision (Bug MOTIR-5265) — the record band's `Files kept` line, returned so
   * a surface can draw it from the response instead of waiting for a server
   * render that MOTIR-5118 measured being intermittently lost.
   *
   * ⚠️ READ OFF THE PIN THIS TRANSACTION WROTE, NEVER DERIVED FROM
   * `state === 'approved'` — the same rule `DesignGateSubjectDTO.filesKept`
   * states. `pinCurrentForWorkItem` pins the CURRENT row, and a republish that
   * took the current row while this decision waited for its lock means the pin
   * landed on bytes nobody was asked about. So it is `true` only when the pinned
   * row IS the gate's subject; the decision stands either way.
   *
   * `null` when the question does not apply: a `request_changes` pins nothing,
   * and a kind with no design result never had files to keep.
   */
  filesKept: boolean | null;
  /**
   * The `subjectVersion` of the card's awaiting approve-to-merge gate AS THE DOOR
   * READ IT UNDER THE LOCK, when the decided gate is a design gate — the version
   * the stamp was checked against (MOTIR-5234). Null for every other kind, and
   * when the card has no such gate.
   *
   * ⚠️ IT IS WHAT MAKES THE TWO-GATE PRESS SAFE after the first commit.
   * `approvePrimaryAndMerge` decides the companion in a SECOND transaction, and a
   * push between the two would raise a new merge gate over commits the reader
   * never saw. The press decides the companion only when its version is still
   * this one.
   */
  companionSubjectVersion: string | null;
}

/**
 * What a SURFACE needs to render one gate: the gate itself, and whether THIS
 * actor may press its verbs (Story MOTIR-4778 · Subtask MOTIR-4792).
 *
 * ⚠️ `canDecide` is the AUTHORITY answer, not the ROUTING one — and after §2's
 * 2026-09-11 amendment the two axes COINCIDE for the relationship arms and part
 * company only at the escape hatch. ROUTING is `assigneeId ?? reporterId`;
 * AUTHORITY is **the assignee, or the reporter WHEN THERE IS NO ASSIGNEE, or
 * anyone holding `approval:decide_any`** (MOTIR-5292). So the person a gate is
 * shown to is exactly the person who may press it, plus the key's holders — the
 * only remaining escape hatch when that person is unavailable. State `B` — the
 * port live, the verbs absent — is exactly a reader for whom this is `false`: a
 * bystander without the key, or an actor below the kind's permission floor.
 */
export interface WorkItemGateRead {
  gate: ApprovalGateDTO | null;
  canDecide: boolean;
  /**
   * WHOSE DECISION THIS IS WAITING ON, as a name a reader can act on — the
   * frame's state `B` line, *"Waiting on Mara S."* (MOTIR-5191). Null when the
   * routing resolves to nobody or to a user row that has gone, and the frame
   * then draws its generic fallback.
   *
   * ⚠️ IT IS THE LIVE ROUTING ANSWER, NOT THE GATE'S `routedToId`, AND THE
   * DISTINCTION IS THE WHOLE OF WHY THIS FIELD EXISTS ON THE READ RATHER THAN
   * BEING READ OFF THE DTO. `routedToId` is frozen at CREATION (ADR §6a: *"the
   * assignee can change afterwards"*) and is the AUDIT record of who was asked.
   * The sentence this feeds is present tense, and the reader's next act is to go
   * and ask somebody — so on a reassigned card the frozen column names a person
   * who no longer sees the gate at all. `approvalGateRepository`'s queue
   * predicate makes the same choice for the same reason, in as many words:
   * answering *whose job is it to look, now* from the frozen column *"would
   * strand every gate on a reassigned card in the previous assignee's tab"*.
   * The two columns are both right, about different questions.
   */
  routedToLabel: string | null;
  /**
   * THE APPROVAL A RE-ASKED MERGE GATE REPLACED (Bug MOTIR-5863; § 28 panel 1's record
   * band, first span) — who gave it, when, over how many commits.
   *
   * Read ONLY for an `awaiting` `pull_request_approval` gate: that is the one question
   * with history behind it, and every other read pays nothing. It is the latest
   * `approved` row of the kind, by decision time, and null when there is none — a first
   * ask. Whether the frame DRAWS it is the frame's call (the members say whether a press
   * did not land); a gate re-raised over new commits after an approval carries one too,
   * and draws no band.
   */
  earlierApproval: EarlierApprovalDTO | null;
  /**
   * The SETTINGS DOOR this viewer is handed for the gate's kind (MOTIR-5513) —
   * the kind's own door when they hold `workflow:manage`, the key its destination
   * is guarded by, and `null` otherwise or for a kind with no project setting
   * (`lib/approvalGates/settingsDoor.ts`). The frame renders exactly what it is
   * handed, so this read is the ONLY place the door is gated.
   */
  settingsDoor: GateSettingsDoor | null;
  /**
   * WHAT THIS READER IS BEING SHOWN, as one opaque token (Story MOTIR-5232 ·
   * Subtask MOTIR-5234) — hand it back as `DecideGateInput.stamp` with the press.
   * Computed over the gate's `subjectVersion`, the companion approve-to-merge
   * gate's version for a design gate, and the card's `descriptionMd`
   * (`lib/approvalGates/stamp.ts`, the only definition).
   *
   * Null when there is no `awaiting` gate — a decided or withdrawn gate is not
   * something anybody can press, so there is nothing to stamp.
   */
  stamp: string | null;
  /**
   * WHAT HAS MOVED since the stamp the caller handed back as `since` — empty
   * when nothing has, when no `since` was given, and when there is no `awaiting`
   * gate to be stale (Story MOTIR-5238 · Subtask MOTIR-5243).
   *
   * ⚠️ IT IS THE REFUSAL'S OWN ANSWER, asked one press earlier. `stampMoved` is
   * what the decide door refuses with, and `movedAsReaderSees` is the same
   * renaming the refusal's copy uses — so the notice an open approval draws
   * BEFORE a press and the refusal it would meet AFTER one are two renderings of
   * one comparison rather than two comparisons that agree today.
   */
  movedSince: StampComponent[];
}

/**
 * The `subjectVersion` of the card's AWAITING approve-to-merge gate, when the gate
 * being read or decided is a DESIGN gate — the pull requests one press on a design
 * also decides and merges (MOTIR-5652, `pullRequestMergeService.approvePrimaryAndMerge`).
 * Null for every other kind, and when the card has no such gate.
 *
 * ⚠️ THE SAME LOOKUP THE PRESS MAKES — the card's awaiting gates, filtered to the
 * approve-to-merge kind — so the stamp covers exactly the gate the press will decide.
 */
async function companionSubjectVersion(
  gate: { id: string; kind: string; workItemId: string | null },
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  // A PRIMARY kind's press also decides the merge gate beside it, so its stamp covers
  // that gate: the design's (MOTIR-5652), the DECISION's (MOTIR-5677; `approval-gates.md`
  // §8's FIFTH AMENDMENT, clause 5) and a story's ACCEPTANCE (MOTIR-5789; §1's MOTIR-5787
  // amendment).
  if (
    gate.kind !== 'design_result' &&
    gate.kind !== 'decision_approval' &&
    gate.kind !== 'acceptance_result'
  ) {
    return null;
  }
  // A PRIMARY kind always carries a card (ADR §11.1): a card-less gate returned above.
  const merge = (
    await approvalGateRepository.findAwaitingByWorkItem(
      requireGateCard(gate, 'companionSubjectVersion'),
      tx,
    )
  ).find((row) => row.kind === 'pull_request_approval');
  return merge?.subjectVersion ?? null;
}

/**
 * ONE gate's withdraw-on-observation (MOTIR-7146), inside the caller's transaction:
 * lock it (its subject first, for a kind whose writers hold the subject's lock when they
 * reach the gate), re-check it is still `awaiting`, ask its kind's handler for the
 * subject, and supersede it `subject_gone` only when the handler answers null. True when
 * it withdrew the gate.
 *
 * `resolvedStatusKey` and `refusalVerdict` are null because nothing is being decided:
 * `resolveSubject` reads the gate and the transaction only, on every registered kind.
 */
async function withdrawIfSubjectGone(
  gateId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const preread = await approvalGateRepository.findById(gateId, tx);
  if (!preread || preread.state !== 'awaiting' || !isRegisteredGateKind(preread.kind)) {
    return false;
  }
  const handler = APPROVAL_GATE_HANDLERS[preread.kind];
  if (handler.lockSubjectBeforeGate) await handler.lockSubjectBeforeGate(preread.subjectId, tx);
  const locked = await approvalGateRepository.lockById(gateId, tx);
  if (!locked || locked.state !== 'awaiting') return false;
  const item =
    locked.workItemId === null ? null : await workItemRepository.findById(locked.workItemId, tx);
  const subject = await handler.resolveSubject({
    gate: locked,
    item,
    ctx,
    tx,
    resolvedStatusKey: null,
    refusalVerdict: null,
  });
  if (subject !== null) return false;
  return (await approvalGateRepository.supersedeAwaitingById(gateId, 'subject_gone', tx)) > 0;
}

/**
 * The gates a page read rendered with NO subject — the candidates for
 * `withdrawGoneQuestions`. A registered kind only: an unregistered kind's row is a
 * feature that has not shipped, never a gone subject (design § 20's *look alike and are
 * opposite*).
 */
function goneCandidates(
  rows: readonly { id: string; kind: ApprovalGateKind }[],
  subjects: ReadonlyMap<string, unknown>,
): string[] {
  return rows
    .filter((row) => isRegisteredGateKind(row.kind) && (subjects.get(row.id) ?? null) === null)
    .map((row) => row.id);
}

/**
 * Withdraw what a page read observed gone, AFTER that read committed — and never let the
 * withdrawal fail the read. A refused or failed write leaves the row `awaiting`, which is
 * exactly what the page showed before; the next read observes it again.
 */
async function withdrawObservedGone(
  candidates: readonly string[],
  ctx: ServiceContext,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  try {
    return await approvalGatesService.withdrawGoneQuestions(candidates, ctx);
  } catch (err) {
    console.error('[approvalGatesService] could not withdraw a gate whose subject is gone', {
      gateIds: candidates,
      err,
    });
    return new Set();
  }
}

/**
 * WHO decided, in a form that SURVIVES their deletion — ADR §6a's second row
 * (MOTIR-5046).
 *
 * `decidedById` is `onDelete: SetNull`, so the FK alone preserves *that* a
 * decision happened and destroys *who made it*. Worse, a null FK already means
 * something else in this table: §6b's `superseded` uses exactly that shape for
 * *the question was withdrawn and nobody decided it*. So the row denormalises the
 * actor's name and email AS AT THE DECISION, read here in the door's own
 * transaction rather than joined at audit time — a join answers what the user
 * row says today, which for a departed member is nothing at all.
 *
 * `Name <email>` — the form a reader already knows from a commit author, and one
 * that stays legible when either half is missing. `User.name` is non-nullable but
 * not non-EMPTY, so a blank one degrades to the bare email rather than to
 * `<email>`; a user row that has vanished between the decision and this read (it
 * cannot, inside the lock, but the type admits it) degrades to null, which the
 * column is honest about.
 */
async function actorLabel(userId: string, tx: Prisma.TransactionClient): Promise<string | null> {
  const user = await userRepository.findById(userId, tx);
  if (!user) return null;
  return user.name ? `${user.name} <${user.email}>` : user.email;
}

/**
 * How a caller narrows the Approvals tab's window — the same two options, with
 * the same names and the same meanings, as every other Workbench tab
 * (`HomeListOptions`).
 */
export interface ApprovalQueueListOptions {
  /** The 1-based page to serve; omit for page one. CLAMPED to the last page. */
  page?: number;
  /**
   * The window SIZE, defaulting to `HOME_PAGE_SIZE`. Named `limit` rather than
   * `pageSize` for the same reason `homeService` names it that — it is what
   * every caller of these reads already passes — and the DTO reports it back as
   * `pageSize`, which is `/items`' word for the same number.
   */
  limit?: number;
}

/**
 * THE TO-APPROVE READ'S SAFETY BOUND (Story MOTIR-5996 · MOTIR-5998). The tab lists
 * every approval routed to its reader with no pager, because one person's queue is
 * short; this ceiling exists only so a pathological queue cannot turn one render
 * into an unbounded query. It sits far above any real queue, and when it bites the
 * DTO says so (`truncated`) and the list says so in words.
 */
export const APPROVAL_QUEUE_CEILING = 500;

/** How a caller narrows the To-approve read — only its ceiling, and only a test lowers it. */
export interface ApprovalQueueReadOptions {
  /**
   * Overrides {@link APPROVAL_QUEUE_CEILING}. A TEST SEAM: exercising the bound
   * at its real value would mean seeding 501 gates.
   */
  ceiling?: number;
}

/** The ceiling a caller-supplied page size is clamped to — `homeService`'s. */
const APPROVAL_QUEUE_MAX_PAGE_SIZE = 100;

/** `homeService.clampLimit`'s rule, applied to this tab so the strip's five tabs
 *  cannot disagree about what a page is. */
function clampApprovalQueueLimit(limit: number | undefined): number {
  if (limit === undefined) return HOME_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit < 1) return HOME_PAGE_SIZE;
  return Math.min(Math.floor(limit), APPROVAL_QUEUE_MAX_PAGE_SIZE);
}

/**
 * Where a 1-based page starts, and which page is actually being served.
 *
 * ⚠️ AN OUT-OF-RANGE PAGE CLAMPS TO THE LAST ONE — it does not serve an empty
 * window, and it is never an error. That is `/items`' shipped contract and
 * `homeService.windowFor`'s, and this tab is deliberately shaped to match:
 * `IssueListPager` fed a `page` it did not ask for would draw a current-page
 * chip outside its own run. `total === 0` gives `page: 1` with an empty `items`,
 * which is the honest answer for a tab with nothing in it.
 */
function approvalQueueWindow(total: number, page: number | undefined, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.trunc(page ?? 1) || 1), totalPages);
  return { page: clamped, skip: (clamped - 1) * pageSize };
}

/**
 * WHICH projects this reader's queue may draw from — at most the ACTIVE one,
 * and NONE when they may not browse it.
 *
 * This is `homeService.resolveActiveProjectScope`'s access half, and only that half:
 * the LIFECYCLE axis it also resolves is a fact about work-item statuses, and a
 * gate has none — a decision is not filtered by the status of the card it hangs
 * off. Resolving it here would be carrying a join this read never uses.
 *
 * The workspace check beside the browse check is belt AND braces, for the reason
 * `homeService` records: RLS already bounds the read to `ctx.workspaceId`, but a
 * stale active-project pointer is exactly the input that would otherwise cross a
 * tenant on the day RLS is relaxed.
 */
async function routingScope(
  ctx: HomeActorContext,
  tx: Prisma.TransactionClient,
): Promise<AwaitingRoutingScope> {
  const projectIds = await browsableProjectIds(ctx.projectId, ctx, tx);
  // The planning sessions that STILL wait on their person, resolved in this transaction:
  // a `planning_session` gate's subject is an opaque id the gate query cannot join, so
  // the live set rides in the scope and the query admits a row only if its session is in
  // it (MOTIR-7913) — never a post-filter, so a page is never shortened after the read.
  const awaitingSessionIds = await planChangeSessionRepository.listAwaitingPersonIdsInProjects(
    projectIds,
    tx,
  );
  return {
    projectIds,
    userId: ctx.userId,
    awaitingSessionIds,
    // A plan a revision holds is being planned again, not waiting on anybody
    // (MOTIR-7988): its gate leaves the queue and the count until the lease ends.
    heldPlanIds: await planRevisionHoldService.heldPlanIds(
      { workspaceId: ctx.workspaceId, projectIds },
      tx,
    ),
  };
}

/**
 * `[projectId]` when this actor may browse it, else `[]` — the ACCESS half both
 * the queue ({@link routingScope}) and the decision-waiting marker
 * ({@link approvalGatesService.pendingDecisionsFor}) carry INTO their query, so a
 * private project answers empty rather than erroring (no existence leak).
 */
async function browsableProjectIds(
  projectId: string,
  ctx: AccessActorContext,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const project = await projectRepository.findById(projectId, tx);
  if (!project || project.workspaceId !== ctx.workspaceId) return [];
  const browsable = await projectAccessService.filterBrowsable([project], ctx, tx);
  return browsable.length === 0 ? [] : [projectId];
}

/**
 * WHICH ARM authorises this actor on this work item — the ONE statement of ADR
 * §2's authority rule, so the render read and the decide door cannot drift
 * (MOTIR-5192).
 *
 * **THE RULE — §2's 2026-09-11 amendment (Yue), which REVERSED the MOTIR-4911
 * one of 2026-09-08: the assignee, or the reporter WHEN THE ITEM HAS NO
 * ASSIGNEE, or — since MOTIR-5292 — anyone holding `approval:decide_any`, on
 * ANY item.** The reporter arm is CONDITIONAL now; it
 * used to be unconditional, and the paragraph that argued for that is
 * superseded on the record in the ADR rather than deleted.
 *
 * ⚠️ AUTHORITY NOW COINCIDES WITH ROUTING FOR THE RELATIONSHIP ARMS, and that
 * is the point of the amendment rather than a side effect. §2 routes a gate to
 * `assigneeId ?? reporterId` — exactly one person — and the two relationship
 * arms here are precisely that person. An approval says *somebody looked*, and
 * it says less when two people could have been the one who looked: a gate shown
 * to one person and pressable by two belongs to neither in particular, and
 * either can sign off work the other was accountable for.
 *
 * ⚠️ THE `_any` ARM IS THE ONLY REMAINING ESCAPE HATCH, and it is the whole of
 * the risk this rule accepts. The 2026-09-08 amendment widened authority to the
 * reporter to prevent the opposite failure — a gate whose single recipient is on
 * leave or has left, with nobody able to unblock the work. That worry is not
 * wrong and is not being dismissed: it is now answered by whoever holds
 * `approval:decide_any` rather than by the reporter.
 *
 * ⚠️ THE ESCAPE HATCH IS A PERMISSION, NEVER A ROLE (MOTIR-5292). Until then
 * this arm asked whether the actor was a WORKSPACE owner/admin, and a role is
 * not grantable in the sense the model means: no custom role could ever carry
 * it, and even a project `admin` whose workspace role is `member` was refused.
 * It is now the shape Motir already uses for acting on what is not yours —
 * your OWN row by relationship, ANYONE's by an `_any` key
 * (`attachment:delete_any`, `comment:moderate`). Workspace owners/admins keep it
 * through the always-pass rail, the built-in project Admin holds it, and a team
 * can grant it to whoever should unblock without granting anything else.
 *
 * ⚠️ THE KEY IS **ASKED**, NEVER DERIVED HERE. Reading this actor's own
 * membership row and testing a role in this file is exactly the SECOND POLICY
 * PATH the model forbids — `tests/permissions/storyGate.test.ts` guard 1 and
 * `memberFacingGate.integration.test.ts` both refuse it by name, because such a
 * rule is *"invisible in the grid, un-grantable to a custom role, and
 * un-auditable by the guard."* So the question goes to
 * `projectAccessService.getPermissions`; this function composes the answer and
 * derives nothing.
 *
 * ⚠️ THE ARM IS STILL RECORDED AS `admin`, and that is a decision, not an
 * oversight. `decided_under_authority`'s `admin` member now MEANS *decided under
 * `approval:decide_any`* — every row written before this change was written by a
 * workspace owner/admin, who holds the key, so no historical row becomes false,
 * nothing is migrated, and one authority does not end up with two names
 * (`docs/decisions/approval-gates.md` §2's third amendment).
 *
 * ⚠️ IT RESOLVES TO **WHICH ARM**, NOT TO A BOOLEAN (MOTIR-5046; ADR §6a —
 * *under which PERMISSION*). A boolean answers *may this press be honoured?* and
 * throws away the answer to *on what grounds?*, and the second is what
 * `decided_under_authority` exists to FREEZE, precisely because a role that has
 * since changed cannot be re-derived later. **Existing `reporter` rows are not
 * migrated or re-derived** — they record what was true when the press happened.
 *
 * ⚠️ AND THE ORDER OF THE ARMS IS THE ROUTING ORDER, NOT AN OPTIMISATION. §2
 * routes `assigneeId ?? reporterId`, so an actor who is BOTH assignee and
 * reporter was asked as the assignee, and that is what the row must say. Testing
 * `admin` last also keeps the short-circuit that avoids the membership read for
 * the common case — a happy consequence of the correct order, never its reason.
 *
 * ⚠️ IT IS THE RELATIONSHIP HALF ONLY. The kind's permission FLOOR is asserted
 * separately and FIRST by the decide door, and is what a project `viewer` who
 * happens to be the assignee fails; this function never sees it.
 */
export async function resolveGateAuthority(
  item: { assigneeId: string | null; reporterId: string | null; projectId: string },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  held?: ReadonlySet<PermissionKey>,
): Promise<ApprovalGateAuthorityDTO | null> {
  if (item.assigneeId === ctx.userId) return 'assignee';
  if (item.assigneeId === null && item.reporterId === ctx.userId) return 'reporter';
  const permissions = held ?? (await projectAccessService.getPermissions(item.projectId, ctx, tx));
  return permissions.has('approval:decide_any') ? 'admin' : null;
}

/**
 * The AUTHORITY half for a gate that belongs to NO work item (Story MOTIR-6012 ·
 * MOTIR-6034; ADR `approval-gates.md` §11.6) — the card-less arm of
 * {@link resolveGateAuthority}, kept beside it rather than folded in so that function's
 * arm order stays exactly the §2 routing order it documents.
 *
 * ⚠️ THERE IS NO RELATIONSHIP HALF TO ASK. §2's rule — assignee, reporter when there is
 * no assignee, `approval:decide_any` — quantifies over a WORK ITEM, and a plan gate has
 * none. Its authority is the KIND's own permission (for `plan_approval`,
 * `ai:decide_plan`, supplied by MOTIR-6035's handler) and nothing else, recorded under
 * `plan_permission`: none of the four other members is true of the decider, and
 * recording `assignee` or `admin` would claim a relationship or a key that does not
 * exist. The door has already asserted that permission as the floor, so on the decide
 * path this always answers `plan_permission`; a render read asks it with the page's
 * permission set.
 */
export async function resolveCardlessGateAuthority(
  gate: { projectId: string; permission: PermissionKey },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  held?: ReadonlySet<PermissionKey>,
): Promise<'plan_permission' | null> {
  const permissions = held ?? (await projectAccessService.getPermissions(gate.projectId, ctx, tx));
  return permissions.has(gate.permission) ? 'plan_permission' : null;
}

/**
 * Whether this actor may decide a CARD-LESS gate of `kind` — {@link canDecideGate}'s
 * card-less arm (MOTIR-6034; ADR §11.6), off a permission set the caller already read.
 *
 * ⚠️ AN UNREGISTERED CARD-LESS KIND IS DECIDABLE BY NOBODY. The card arm keeps the
 * authority answer alone for an unregistered kind, because a card has a relationship
 * to answer from; a gate with no card has only its kind's permission, and a kind this
 * build does not register names none — the decide door refuses it
 * (`ApprovalGateKindUnregisteredError`) before any actor question is asked.
 */
function canDecideCardlessGate(
  kind: ApprovalGateKindDTO,
  held: ReadonlySet<PermissionKey>,
): boolean {
  return isRegisteredGateKind(kind) && held.has(handlerFor(kind).permission);
}

/**
 * Whether this actor may decide a gate of `kind` on `item` — the RENDER read's
 * statement of the door's TWO checks, in the door's order (Bug MOTIR-5445).
 *
 * ⚠️ THE FLOOR FIRST, THEN THE AUTHORITY. `decide` asserts the permission the
 * kind names before it asks `resolveGateAuthority`, and a read that asked only
 * the second drew Approve for a project `viewer` who is the assignee — a press
 * the door refuses. The queue read already held the floor (`listAwaitingMe`'s
 * `canEdit`), so the item page and the approval overlay disagreed with the row
 * that opened them.
 *
 * ⚠️ A KIND THIS BUILD DOES NOT REGISTER HAS NO FLOOR TO HOLD — no handler names
 * one — so it keeps the AUTHORITY answer alone, exactly as before this fix. That
 * is what the Development block's pull-request frame draws *Awaiting you* from
 * for the person it is routed to (MOTIR-5336); its frame has no verbs, so no
 * door can disagree with it. The permissions are read ONCE and handed to the
 * authority test, because this is the item page's render path.
 */
async function canDecideGate(
  item: { assigneeId: string | null; reporterId: string | null; projectId: string },
  kind: ApprovalGateKindDTO,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  held: Awaited<ReturnType<typeof projectAccessService.getPermissions>>,
): Promise<boolean> {
  if (isRegisteredGateKind(kind) && !held.has(handlerFor(kind).permission)) return false;
  return (await resolveGateAuthority(item, ctx, tx, held)) !== null;
}

/** The kinds whose gate belongs to NO work item — the CHECK
 *  `approval_gate_work_item_iff_not_plan`'s one member (ADR §11.1). */
const CARDLESS_GATE_KINDS: ReadonlySet<ApprovalGateKindDTO> = new Set([
  'plan_approval',
  'planning_session',
]);

/**
 * WHO a queue / record row is routed to, read off the ROW (MOTIR-5191): §2's
 * `assigneeId ?? reporterId` for a card row, and — for a CARD-LESS row, which has no
 * card to re-derive it from (MOTIR-6034; ADR §11.6) — the `routedToId` written at
 * creation, the same column the routing predicate selects it by.
 */
function recordRoutedToId(row: {
  routedToId: string | null;
  workItem: { assigneeId: string | null; reporterId: string | null } | null;
}): string | null {
  return row.workItem ? routingTargetId(row.workItem) : row.routedToId;
}

/**
 * The room's view key, written ONCE (`tests/approval-records-story-gate.test.ts`):
 * the member read below and the Visitor reads (MOTIR-6645) name it through this.
 */
const APPROVAL_VIEW_KEY = 'approval:view_any' satisfies PermissionKey;

/**
 * The Approvals room's views for a reader (MOTIR-6333): `project` on
 * `approval:view_any` (role ∩ token grant), `mine` on a way to act
 * (`APPROVAL_ACT_PERMISSIONS`). The ONE place the service reads the view key.
 */
function approvalRoomViews(held: ReadonlySet<PermissionKey>, ctx: HomeActorContext): RoomView[] {
  return availableRoomViews({
    hasViewKey: holdsRecordView(held, ctx, APPROVAL_VIEW_KEY),
    canAct: canActOnApprovals(held),
  });
}

/**
 * Whether a read runs on a Visitor's narrowed service context (MOTIR-6645) — the
 * one actor every label below must name by display name only (MOTIR-6646).
 */
function isVisitorActor(ctx: { userId: string }): boolean {
  return ctx.userId === VISITOR_ACTOR_ID;
}

/**
 * The routed person's label for THIS reader: a member's keeps the shipped
 * `name || email` rule; a Visitor's is the name or the neutral label, never the
 * email (MOTIR-6646).
 */
function routedLabelFor(
  ctx: { userId: string },
  user: Parameters<typeof routedToDisplayName>[0],
): string | null {
  if (!isVisitorActor(ctx)) return routedToDisplayName(user);
  return user ? personName(user.name) : null;
}

/**
 * The deciders' display names by id, for a Visitor's read (MOTIR-6646). The
 * stored `decidedByLabel` is `"Name <email>"` and is NEVER parsed for a Visitor:
 * the name comes from the user row, and a decider with no row left reads as the
 * neutral label.
 */
async function visitorDeciderNames(
  ids: ReadonlyArray<string | null>,
  tx: Prisma.TransactionClient,
): Promise<(id: string | null) => string | null> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const users = wanted.length > 0 ? await userRepository.findByIds(wanted, tx) : [];
  const byId = new Map(users.map((u) => [u.id, personName(u.name)]));
  return (id) => (id === null ? null : (byId.get(id) ?? personName(null)));
}

export const approvalGatesService = {
  /**
   * The gate of one KIND the approval FRAME renders, WHATEVER STATE IT IS IN,
   * plus whether this actor may decide it (Subtask MOTIR-5033).
   *
   * ⚠️ THIS IS THE FRAME'S READ NOW, AND `getAwaitingForWorkItem` BELOW IS THE
   * NARROWER ONE. A decided gate leaves the awaiting set by design (that is
   * what deciding it means), so a frame reading only the awaiting set lost
   * states `E`, `F` and `G` at the next page load: the record of who decided,
   * when, and on WHICH bytes was written and immutable, and unreachable from
   * the card it was written about. The pin §6c keeps the approved files for is
   * then invisible, which is the fastest way for a pin to be tidied away by
   * somebody reclaiming storage.
   *
   * ⚠️ A LIVE QUESTION STILL WINS — the repository's ordering, not this
   * service's choice. A card approved on Monday and republished on Tuesday
   * holds three gates and exactly one of them can be acted on; showing the
   * decided one because it is newer would ask a reader to admire a receipt
   * while a question waits underneath it.
   *
   * ⚠️ `canDecide` IS COMPUTED THE SAME WAY IN BOTH STATES, and it is not
   * redundant on a decided gate: the frame renders no verbs there (a decided
   * gate is immutable — ADR §6a), so the flag is the AUTHORITY answer the
   * caller may use for anything else it draws, and the verb-gating is the
   * frame's own.
   *
   * ⚠️ NO LOCK AND NO TRANSACTION OF ITS OWN. This is a render read: the
   * decision it feeds re-derives every field under the lock in `decide` below,
   * and nothing here may be carried into that write.
   */
  async getForWorkItem(
    input: {
      workItemId: string;
      kind: ApprovalGateKindDTO;
      /**
       * A stamp this reader was shown EARLIER, handed back to ask ONE question:
       * what has moved since (Story MOTIR-5238 · Subtask MOTIR-5243)?
       *
       * ⚠️ THE COMPARISON IS THE SERVER'S, and that is the whole reason this
       * parameter exists rather than the client diffing two stamps. The token is
       * opaque on the wire by design (`lib/approvalGates/stamp.ts`) — a client
       * holds one string and compares nothing — and the answer has to name WHICH
       * component moved, which only the composite can do. Answered through the
       * SAME `stampMoved` the decide door refuses with, so the notice a reader
       * sees before pressing and the refusal they would meet after it cannot
       * disagree about whether something changed.
       */
      since?: string | null;
    },
    ctx: ServiceContext,
  ): Promise<WorkItemGateRead> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(input.workItemId, tx);
      // A cross-workspace row is indistinguishable from one that never existed,
      // exactly as the decide door has it — no existence leak through a read.
      if (!item || item.workspaceId !== ctx.workspaceId)
        return {
          gate: null,
          canDecide: false,
          routedToLabel: null,
          earlierApproval: null,
          settingsDoor: null,
          stamp: null,
          movedSince: [],
        };

      const row = await approvalGateRepository.findLatestByWorkItem(
        input.workItemId,
        input.kind,
        tx,
      );
      if (!row)
        return {
          gate: null,
          canDecide: false,
          routedToLabel: null,
          earlierApproval: null,
          settingsDoor: null,
          stamp: null,
          movedSince: [],
        };

      // ⚠️ THE SAME FUNCTION the decide door calls, not merely the same rule
      // written twice. `resolveGateAuthority` is the ONE statement of ADR §2's
      // authority test, so the surface cannot draw a verb the door then refuses
      // — which is what two conditionals side by side eventually do, and what
      // the 2026-09-11 narrowing made easy to half-apply (MOTIR-5192).
      //
      // It resolves an ARM; this read needs only whether there IS one. The
      // admin arm inside it is ASKED of `projectAccessService`, never derived
      // here (the second-policy-path rule this service already records).
      //
      // …behind the kind's permission FLOOR, which the door asserts first
      // (`canDecideGate`, MOTIR-5445).
      // ⚠️ THE PERMISSIONS ARE READ ONCE, here, and serve both answers this read
      // gives about the VIEWER — whether they may press, and whether they are handed
      // the settings door (MOTIR-5513). This is the item page's render path.
      const held = await projectAccessService.getPermissions(item.projectId, ctx, tx);
      const canDecide = await canDecideGate(item, input.kind, ctx, tx, held);

      // WHO the frame says it is waiting on — §2's routing rule asked of the
      // item as it stands NOW, which is the question the sentence poses. The id
      // comes from the KIND's own `routeTo` rather than from a second copy of
      // the rule here, so a kind that routes differently draws its own answer.
      //
      // ⚠️ ONE read, and only when there is somebody to name: this is the item
      // page's render path, so a per-render round trip is exactly what it may
      // not add. `routeTo` reads the item already in hand and resolves no row of
      // its own.
      //
      // ⚠️ A READ MUST NOT REFUSE AN UNREGISTERED KIND (MOTIR-4906 · MOTIR-5223).
      // `handlerFor` throws for a kind with no handler — right for the decide
      // door, which cannot act on it — but this read only NAMES whom a row is
      // waiting on, and a row of a not-yet-registered kind must still render its
      // frame: the Development block's pull-request gate, and the approval
      // overlay, which is addressed by (work item, kind) from a URL. Such a kind
      // has no `routeTo` of its own, so it routes by §2's shared rule.
      const routedToId = isRegisteredGateKind(input.kind)
        ? handlerFor(input.kind).routeTo({ item, ctx, tx })
        : routingTargetId(item);
      const routedTo = routedToId ? await userRepository.findById(routedToId, tx) : null;

      // THE STAMP — only an `awaiting` gate can be pressed, so only one is stamped,
      // and the companion read is skipped for every decided gate on this render path.
      // ⚠️ ONE set of inputs, TWO answers — the stamp this reader is being shown,
      // and (when they handed one back) what has moved since the one they held.
      // Computing the inputs twice would be two readings of the same rows a
      // transaction apart, which is the drift the single definition exists to
      // stop.
      const stampInputs =
        row.state === 'awaiting'
          ? {
              subjectVersion: row.subjectVersion,
              // Read BY this card, so the row carries it — no card-less gate is here.
              companionSubjectVersion: await companionSubjectVersion(
                { ...row, workItemId: item.id },
                tx,
              ),
              descriptionMd: item.descriptionMd,
            }
          : null;
      const stamp = stampInputs ? computeGateStamp(stampInputs) : null;
      // Only an `awaiting` gate can be pressed, so only one can be stale. A
      // decided or withdrawn gate answers `[]` — it has already moved past the
      // question this asks.
      const movedSince =
        input.since && stampInputs
          ? movedAsReaderSees(stampMoved(input.since, stampInputs), input.kind)
          : [];

      // THE SPENT APPROVAL (MOTIR-5863). The re-asked gate is a fresh row that names
      // nobody, so its record band's first line needs the approval before it — one read,
      // paid only by an awaiting merge gate.
      const earlier =
        row.state === 'awaiting' && input.kind === 'pull_request_approval'
          ? (
              await approvalGateRepository.findLatestApprovedByWorkItems(
                [input.workItemId],
                input.kind,
                tx,
              )
            ).get(input.workItemId)
          : undefined;

      // WHETHER A REFUSAL HERE ASKS FOR A VERDICT (MOTIR-6501) — the same function the
      // decide door calls under its lock, so the band draws the tiles exactly when the
      // door will require them. Only an `awaiting` gate can be refused, so only one pays
      // the read (an `acceptance_result`'s open-delivery count).
      const offersRefusalVerdict =
        row.state === 'awaiting' ? await refusalVerdictOfferFor(row, tx) : false;

      // THE TWO VIEW FACTS a design gate's record band draws (Story MOTIR-693 · MOTIR-702).
      // A refused design gate carries its automatic re-run's record, if one was written;
      // a SYSTEM-approved one carries the switch's address for a reader who may open it.
      const rerunRow =
        row.kind === 'design_result' && row.state === 'changes_requested'
          ? await designAutoRerunRepository.findByGateId(row.id, tx)
          : null;
      const baseDto = toApprovalGateDto(row, item.descriptionMd, offersRefusalVerdict);
      const gateDto = {
        ...baseDto,
        autoRerun: rerunRow ? toDesignAutoRerunDto(rerunRow) : null,
        systemApprovalSettingsHref:
          row.decisionSource === 'system' && held.has(SETTINGS_DOOR_PERMISSION)
            ? DESIGN_APPROVAL_SETTINGS_HREF
            : null,
      };
      const earlierDto = earlier ? toEarlierApprovalDto(earlier) : null;
      // A Visitor reads every person by name only (MOTIR-6646).
      const decider = isVisitorActor(ctx)
        ? await visitorDeciderNames([row.decidedById, earlier?.decidedById ?? null], tx)
        : null;
      return {
        gate: decider ? { ...gateDto, decidedByLabel: decider(row.decidedById) } : gateDto,
        canDecide,
        stamp,
        movedSince,
        routedToLabel: routedLabelFor(ctx, routedTo),
        earlierApproval:
          earlierDto && decider && earlier
            ? { ...earlierDto, decidedByLabel: decider(earlier.decidedById) }
            : earlierDto,
        settingsDoor: settingsDoorFor(
          isRegisteredGateKind(input.kind) ? handlerFor(input.kind).settingsDoor : undefined,
          held,
        ),
      };
    });
  },

  /**
   * THE PLAN GATE a plan's surface renders, WHATEVER STATE IT IS IN (Story MOTIR-6012 ·
   * MOTIR-6035; ADR `approval-gates.md` §11.3, §11.5b, §11.5c) — {@link getForWorkItem}
   * for the one kind whose gate has no card: the gate, whether this reader may decide
   * it, the STAMP to press with, what has moved since a stamp handed back, and whether
   * a revision HOLDS it.
   *
   * ⚠️ THE STAMP IS THE LIVE DIGEST, from the SAME function the decide door stamps with
   * (`planSubjectVersion`, beside `stamp.ts`). A revision rewrites the plan in place and
   * never supersedes its gate, so a stamp taken here before a revision is refused stale.
   *
   * ⚠️ `canDecide` is the door's own two checks for a card-less gate: the kind's
   * permission (`ai:decide_plan`) — which IS its authority (§11.6). It says nothing about
   * `held`: a held gate is decidable by this reader once the lease ends. A render read:
   * no lock, one transaction, nothing carried into a decision.
   */
  async getForPlan(
    input: { planId: string; since?: string | null },
    ctx: ServiceContext,
  ): Promise<WorkItemGateRead> {
    return withWorkspaceContext(ctx, async (tx) => {
      const none: WorkItemGateRead = {
        gate: null,
        canDecide: false,
        routedToLabel: null,
        earlierApproval: null,
        settingsDoor: null,
        stamp: null,
        movedSince: [],
      };
      const plan = await planRepository.findById(input.planId, ctx.workspaceId, tx);
      if (!plan) return none;
      const row = await approvalGateRepository.findLatestCardlessBySubject(PLAN_KIND, plan.id, tx);
      if (!row) return none;

      const held = await projectAccessService.getPermissions(plan.projectId, ctx, tx);
      const canDecide = canDecideCardlessGate(PLAN_KIND, held);
      const routedTo = row.routedToId ? await userRepository.findById(row.routedToId, tx) : null;

      const stampInputs =
        row.state === 'awaiting'
          ? planGateStampInputs(await planSubjectVersion(plan.id, tx))
          : null;
      const stamp = stampInputs ? computeGateStamp(stampInputs) : null;
      const movedSince =
        input.since && stampInputs
          ? movedAsReaderSees(stampMoved(input.since, stampInputs), PLAN_KIND)
          : [];

      const decider = isVisitorActor(ctx) ? await visitorDeciderNames([row.decidedById], tx) : null;
      return {
        gate: {
          ...toApprovalGateDto(row),
          ...(decider ? { decidedByLabel: decider(row.decidedById) } : {}),
          // Only a question still being asked can be held (§11.5c).
          held: row.state === 'awaiting' ? await readPlanGateHeld(plan.id, tx) : null,
        },
        canDecide,
        stamp,
        movedSince,
        routedToLabel: routedLabelFor(ctx, routedTo),
        earlierApproval: null,
        settingsDoor: null,
      };
    });
  },

  /**
   * THE LATEST REFUSAL on one work item, or null (Story MOTIR-6070 · MOTIR-6422; ADR
   * `approval-gates.md` §10h note 4) — the ONE read both the dispatched prompt's
   * CHANGES REQUESTED section and `get_work_item`'s `latestRefusal` answer from.
   *
   * The item's most recently DECIDED gate of ANY kind (by `decidedAt`); kept only when
   * its state is `changes_requested`. So an approval after a refusal answers null, a
   * refusal after an approval answers the refusal, and of two refusals the later wins.
   * An `awaiting` gate is not a decision: a design republished after a refusal still
   * carries that refusal until the new gate is decided.
   *
   * Keyed on the KIND-LESS question on purpose: a story's acceptance refusal
   * (MOTIR-6071) is handed to its re-run through this same read.
   *
   * Tenant-scoped like every gate read: an item outside the caller's workspace
   * answers null, indistinguishable from one with no refusal. A render read — no
   * lock, one transaction.
   */
  async latestRefusalFor(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<LatestRefusalDTO | null> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId) return null;
      const gate = await approvalGateRepository.findLatestDecidedByWorkItem(workItemId, tx);
      if (!gate || gate.state !== 'changes_requested' || gate.decidedAt === null) return null;
      return {
        gateId: gate.id,
        kind: gate.kind,
        noteMd: gate.noteMd,
        decidedByLabel: isVisitorActor(ctx)
          ? (await visitorDeciderNames([gate.decidedById], tx))(gate.decidedById)
          : gate.decidedByLabel,
        decidedAt: gate.decidedAt.toISOString(),
        decisionSource: gate.decisionSource,
        refusalVerdict: gate.refusalVerdict,
        subjectVersion: gate.subjectVersion,
      };
    });
  },

  /**
   * THE MOVES AN APPROVAL HOLDS on one work item, for the status control (Story
   * MOTIR-4887 · Subtask MOTIR-5528; ADR `approval-gates.md` §6d AMENDMENT rules 1
   * and 2b; design § _The status control says so_).
   *
   * ⚠️ THE GUARD'S OWN RULE, NOT A SECOND ONE. It hands this item's statuses, its
   * open-pull-request fact and its awaiting gates to `heldMoves` — the function
   * `applyStatusTransition` refuses with — so the item page, quick view and edit
   * page lock exactly the moves the door would refuse, and nothing else.
   *
   * The move INTO the item's CURRENT status is never listed: nothing is held about
   * a status the card already has. A render read — no lock, one transaction.
   */
  async listHeldTransitions(workItemId: string, ctx: ServiceContext): Promise<HeldTransitionDTO[]> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId) return [];
      const [statuses, openPullRequests, awaiting] = await Promise.all([
        workflowsService.listStatusesByProject(item.projectId, ctx.workspaceId, tx),
        workItemDeliveryRepository.countOpenByWorkItem(item.id, tx),
        approvalGateRepository.findAwaitingByWorkItem(item.id, tx),
      ]);
      const moves = heldMoves({
        statuses,
        hasOpenPullRequest: openPullRequests > 0,
        awaitingGates: awaiting,
        intentOf: (kind) =>
          isRegisteredGateKind(kind as ApprovalGateKindDTO)
            ? handlerFor(kind as ApprovalGateKindDTO).statusIntent
            : null,
      }).filter((move) => move.statusKey !== item.status);
      if (moves.length === 0) return [];

      const out: HeldTransitionDTO[] = [];
      // The actor's permissions, read ONCE for every held move — `canDecideGate`
      // takes them rather than re-reading per call (this is a render path).
      const permissions = moves.some((m) => m.waitingOn === 'decision' && m.gateId !== null)
        ? await projectAccessService.getPermissions(item.projectId, ctx, tx)
        : null;
      for (const move of moves) {
        const kind = move.gateKind as ApprovalGateKindDTO;
        const canDecide =
          permissions && move.waitingOn === 'decision' && move.gateId !== null
            ? await canDecideGate(item, kind, ctx, tx, permissions)
            : false;
        const routedToId = isRegisteredGateKind(kind)
          ? handlerFor(kind).routeTo({ item, ctx, tx })
          : routingTargetId(item);
        const routedTo = routedToId ? await userRepository.findById(routedToId, tx) : null;
        out.push({
          statusKey: move.statusKey,
          statusLabel: statuses.find((s) => s.key === move.statusKey)?.label ?? move.statusKey,
          waitingOn: move.waitingOn,
          kind,
          gateId: move.gateId,
          canDecide,
          routedToLabel: routedLabelFor(ctx, routedTo),
        });
      }
      return out;
    });
  },

  /**
   * ENTERING REVIEW ASKS AGAIN (Story MOTIR-4887 · Subtask MOTIR-5532; ADR
   * `approval-gates.md` §6d AMENDMENT, rule 7). Called by `applyStatusTransition`
   * when an item moves into `in_review`, IN that transaction, after the funnel has
   * taken the item's gate locks — so it never opens a transaction of its own.
   *
   * For every REGISTERED kind: ask the kind for its CURRENT subject; when there is
   * one and no gate on that subject is `awaiting` or `approved`, raise a fresh
   * `awaiting` gate routed the way the kind routes, the same row the publish path
   * writes. Returns how many were raised.
   *
   * ⚠️ WHY THIS EXISTS. Pulling work back withdraws the question (rule 6). Without
   * a re-ask, withdraw-then-return leaves a card in review with no gate, which the
   * guard then has nothing to hold — a quiet way around every approval.
   *
   * ⚠️ SYSTEM MOVES INCLUDED, unlike the guard and the withdraw. The CI-green
   * promotion into `in_review` is exactly the return to review that must ask
   * again. The importer and the rollup reach cards with no current subject, so
   * they raise nothing on their own.
   *
   * ⚠️ A CONCURRENT DOUBLE RAISE IS "ALREADY RAISED", not an error — resolved in
   * the insert itself (`createAwaitingIfAbsent`), because a caught unique
   * violation would have aborted the transition's transaction.
   */
  async raiseOnReviewEntry(
    item: WorkItem,
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    let raised = 0;
    for (const kind of Object.keys(APPROVAL_GATE_HANDLERS) as RegisteredGateKind[]) {
      // ⚠️ A CHOICE HAS ITS OWN RAISER (MOTIR-5891; `approval-gates.md` §1's MOTIR-5887
      // amendment, point 3). Its question is owed on the BODY and the BLOCKERS, not on
      // entering review, and it is raised with its stamp — `choiceGateService.reconcile`
      // does both, before it walks the item here. Raising it from this loop would ask a
      // blocked choice, and ask it with no `subjectVersion`.
      // A CONFIRM QUESTION likewise (MOTIR-5954; §1's MOTIR-5952 amendment, point 4):
      // `decisionConfirmationGateService.reconcile` raises it with its stamp.
      if (kind === 'decision_choice' || kind === 'decision_confirmation') continue;
      // ⚠️ A PLAN GATE IS NEVER RAISED FROM HERE (Story MOTIR-6012 · MOTIR-6034; ADR
      // `approval-gates.md` §11.7). Its question is about a PLAN, asked when the plan
      // reaches `planned` — never on a work item's review entry — and it belongs to no
      // card, so this card-only loop has nothing to raise it on. The raise is
      // MOTIR-6036's; once MOTIR-6035 registers the kind, this line keeps it out.
      if (CARDLESS_GATE_KINDS.has(kind)) continue;
      const handler = handlerFor(kind);
      const subjectId = await handler.currentSubject({ item, ctx, tx });
      if (!subjectId) continue;
      // ⚠️ A RECEIPT IS NOT BY ITSELF A QUESTION (Bug MOTIR-5903; `approval-gates.md` §1,
      // the MOTIR-5903 amendment). The acceptance video is the STORY's gate and is asked
      // only when the work it shows can finish — a story run's set green, or a subtask
      // run's subtree settled — which the gate-set predicate decides. A story rolling up
      // into review while its recording subtask is unmerged must not be asked here what
      // the predicate has not yet owed.
      if (
        kind === 'acceptance_result' &&
        !(await gateSetFor(item, tx)).awaited.some(
          (gate) => gate.kind === kind && gate.subjectId === subjectId,
        )
      ) {
        continue;
      }
      if (await approvalGateRepository.hasLiveGateForSubject(item.id, kind, subjectId, tx)) {
        continue;
      }
      const inserted = await approvalGateRepository.createAwaitingIfAbsent(
        {
          workspaceId: item.workspaceId,
          projectId: item.projectId,
          workItemId: item.id,
          kind,
          subjectId,
          routedToId: handler.routeTo({ item, ctx, tx }),
        },
        tx,
      );
      if (inserted) raised += 1;
    }
    return raised;
  },

  /**
   * The render payload for an `APPROVAL_GATE_PENDING` refusal (Story MOTIR-4887 ·
   * Subtask MOTIR-5526) — what every status door hands its surface.
   *
   * ⚠️ CALLED AFTER THE REFUSED TRANSACTION HAS ROLLED BACK, never inside it. The
   * guard throws from `applyStatusTransition` while that transaction holds the
   * item `FOR UPDATE`; computing authority there would widen the lock for a
   * render concern. So the error carries ids and this read resolves the rest in
   * a context of its own.
   *
   * `canDecide` is `canDecideGate` — the SAME function the approval frame's read
   * uses, floor first then authority — and `routedToLabel` is the kind's own live
   * routing answer, exactly as `getForWorkItem` computes both. A gate that has
   * vanished in between (decided, superseded) still answers: the refusal already
   * happened, and the surface re-reads the item on its next render.
   */
  async describePendingRefusal(
    err: ApprovalGatePendingError,
    ctx: ServiceContext,
  ): Promise<ApprovalGatePendingPayloadDTO> {
    return withWorkspaceContext(ctx, async (tx) => {
      const kind = err.gateKind as ApprovalGateKindDTO;
      const item = await workItemRepository.findById(err.workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId) {
        return {
          itemKey: err.itemKey,
          kind,
          waitingOn: err.waitingOn,
          gateRaised: err.gateId !== null,
          canDecide: false,
          routedToLabel: null,
        };
      }
      const canDecide = await canDecideGate(
        item,
        kind,
        ctx,
        tx,
        await projectAccessService.getPermissions(item.projectId, ctx, tx),
      );
      const routedToId = isRegisteredGateKind(kind)
        ? handlerFor(kind).routeTo({ item, ctx, tx })
        : routingTargetId(item);
      const routedTo = routedToId ? await userRepository.findById(routedToId, tx) : null;
      return {
        itemKey: err.itemKey,
        kind,
        waitingOn: err.waitingOn,
        gateRaised: err.gateId !== null,
        // Nothing is left to decide on an approved gate awaiting its merge, so no
        // surface may offer an approve door for it.
        // A door is offered only when a gate is actually waiting on a decision:
        // not while the merge is what the move waits for, and not while the pull
        // request is open but no gate has been raised yet.
        canDecide: err.waitingOn === 'decision' && err.gateId !== null && canDecide,
        routedToLabel: routedLabelFor(ctx, routedTo),
      };
    });
  },

  /**
   * THE APPROVALS TAB's read — every `awaiting` gate routed to THIS person in
   * the ACTIVE project, oldest-waiting first, as a page (Story MOTIR-4879 ·
   * Subtask MOTIR-4791; ADR docs/decisions/approval-gates.md §2).
   *
   * ⚠️ IT IS A DIFFERENT QUESTION FROM THE THREE TABS BESIDE IT, and the
   * predicate says so. They partition the member's own WORK by lifecycle with
   * `homeService`'s assignee-OR-reporter union; this one lists DECISIONS, which
   * are not work items and are not filtered by status. §2 records the divergence
   * and the reason in as many words — *"a gate shown to two people is a decision
   * neither owns"* — so this read does NOT reuse
   * `workItemRepository.findByAssigneeOrReporterInWorkspace`. `assigneeId ??
   * reporterId`, exactly one recipient, applied IN the query.
   *
   * ⚠️ ROUTING IS NOT AUTHORITY, and this read answers only the first. They
   * COINCIDE for the relationship arms after §2's 2026-09-11 amendment — the
   * reporter arm is conditional on there being no assignee, which is exactly
   * when routing reaches the reporter — so every row here is routed to somebody
   * the relationship rule also authorises. The two are still not the same
   * question: a reader may be shown a gate they cannot press because they are
   * below the kind's permission FLOOR, and an ADMIN may decide from the item
   * page a gate that never appears here. `canDecide` is the frame's answer,
   * computed per gate by {@link getForWorkItem} — do not collapse the two axes
   * back into one query.
   *
   * ⚠️ THE WHOLE SET, NOT A PAGE (Story MOTIR-5996 · MOTIR-5998). One reader's
   * queue is short, and a pager on a short list only hides its oldest questions
   * behind a click nobody makes. The read is bounded by {@link APPROVAL_QUEUE_CEILING}
   * — a SAFETY bound, not a page — and `truncated` says when it bit, so the tab
   * can say so in words rather than drop rows silently
   * (`design/workbench/design-notes.md` § 28, DECISION 5).
   *
   * ⚠️ COUNT FIRST, THEN THE SET — so the total is the true size of the awaiting
   * set even when the ceiling cuts the rows. Both halves call one `where`
   * builder in the repository, so the badge and the list cannot disagree.
   *
   * ⚠️ THE ACCESS DECISION IS THE SERVICE'S AND TRAVELS INTO THE QUERY. RLS is
   * WORKSPACE-rooted, so what this could leak is a PRIVATE PROJECT inside the
   * reader's own workspace — which RLS admits and `canBrowse` does not — and an
   * actor's ACTIVE project can be one they may not browse, because the pointer
   * is a stored preference and membership can be revoked under it. Such a reader
   * resolves to an EMPTY project list and the query returns nothing: empty
   * rather than an error, the no-existence-leak convention every other project
   * gate follows. It is passed IN, never applied to the output — a post-read
   * filter shortens pages instead of failing.
   */
  async listAwaitingMe(
    ctx: HomeActorContext,
    options: ApprovalQueueReadOptions = {},
  ): Promise<ApprovalQueueDto> {
    const ceiling = options.ceiling ?? APPROVAL_QUEUE_CEILING;
    const read = await withWorkspaceContext(ctx, async (tx) => {
      const scope = await routingScope(ctx, tx);

      const total = await approvalGateRepository.countAwaitingRoutedTo(scope, tx);
      const rows = await approvalGateRepository.findAwaitingRoutedTo(
        scope,
        { skip: 0, take: ceiling },
        tx,
      );

      // ONE query per KIND on the page, never one per gate: a 25-row queue that
      // read its subjects individually would be 25 round trips to render one
      // list. `summarizeGateSubjects` is also where the DTO's totality over the
      // kind enum is asserted.
      const subjects = await summarizeGateSubjects(rows, tx);

      // ⚠️ THE AUTHORITY ANSWER, resolved ONCE for the set rather than per row.
      // Every row here is in the ACTIVE project, so the permission floor is one
      // question, and asking it per gate would be N identical reads. It is the
      // FLOOR only: ADR §2's relationship arm is already satisfied by the
      // routing predicate that selected these rows, so what remains to check is
      // `work_item:edit` — which a project `viewer` who happens to be an
      // assignee does not have.
      //
      // ⚠️ THAT SHORTCUT IS EXACT AFTER §2's 2026-09-11 amendment, where it was
      // merely SUFFICIENT before it (MOTIR-5192). Routing selects the rows where
      // this actor is `assigneeId ?? reporterId`; the relationship rule
      // authorises the assignee, and the reporter when there is no assignee.
      // Those are the same set, term for term — so the shortcut no longer rests
      // on the relationship arms being WIDER than routing, which is what the
      // narrowing removed. A future widening of EITHER axis breaks the identity
      // and this read would owe a per-row `resolveGateAuthority` again.
      const canDecide =
        scope.projectIds.length > 0 &&
        (await projectAccessService.getCapabilities(ctx.projectId, ctx, tx)).canEdit;

      // THE *WAITING ON* NAMES, resolved ONCE for the set — the same discipline
      // `summarizeGateSubjects` keeps one read up, and for the same reason: a
      // 25-row queue that named its recipients one at a time would be 25 round
      // trips to draw one list. The ids are §2's routing rule read off each row,
      // never the session: see `ApprovalQueueRowDto.routedToName`.
      //
      // ⚠️ A CARD-LESS ROW (MOTIR-6034; ADR §11.6) has no card to re-derive routing
      // from: its recipient is the `routedToId` written at creation, which is also
      // what the predicate selected it by.
      const routedToIds = rows.map(recordRoutedToId);
      // ⚠️ AND ITS FLOOR IS ITS KIND'S PERMISSION, NOT `work_item:edit` (ADR §11.6) —
      // so the set's one `canEdit` answer does not speak for it. The permission set is
      // read once, and only when the page holds such a row.
      const cardlessHeld =
        scope.projectIds.length > 0 && rows.some((row) => row.workItem === null)
          ? await projectAccessService.getPermissions(ctx.projectId, ctx, tx)
          : new Set<PermissionKey>();
      const namesById = new Map(
        (await userRepository.findByIds([...new Set(routedToIds.filter((id) => id !== null))], tx))
          .map((user) => [user.id, routedToDisplayName(user)] as const)
          .filter((entry): entry is readonly [string, string] => entry[1] !== null),
      );

      return {
        queue: {
          items: rows.map((row, index) =>
            toApprovalQueueRowDto(
              row,
              subjects.get(row.id) ?? null,
              row.workItem ? canDecide : canDecideCardlessGate(row.kind, cardlessHeld),
              // A routed user whose row has gone resolves to nothing here, exactly
              // as it does on the item page — the frame's fallback copy is what
              // renders, which is the case that fallback is FOR (ADR §3).
              namesById.get(routedToIds[index] ?? '') ?? null,
            ),
          ),
          total,
          truncated: total > rows.length,
        },
        gone: goneCandidates(rows, subjects),
      };
    });

    // A ROW WHOSE SUBJECT IS GONE IS A QUESTION NOBODY CAN ANSWER (MOTIR-7146): it is
    // withdrawn now, after the read committed, and leaves the list and its count rather
    // than sitting on it as a *Gone* row for ever. A gate the withdrawal could not
    // retire — its subject came back, or the write failed — stays exactly as read.
    const withdrawn = await withdrawObservedGone(read.gone, ctx);
    if (withdrawn.size === 0) return read.queue;
    const items = read.queue.items.filter((row) => !withdrawn.has(row.gateId));
    const total = read.queue.total - withdrawn.size;
    return { items, total, truncated: total > items.length };
  },

  /**
   * WHICH of a set of work items has a decision waiting, and whether it is THIS
   * reader's — the one read behind the decision-waiting marker on the board card,
   * the `/items` rows and the item page header (Story MOTIR-4908 · MOTIR-5876).
   *
   * ⚠️ `yours` IS THE TO-APPROVE TAB'S ANSWER, COMPOSED FROM ITS PIECES rather than
   * restated: the carried merge gate is dropped by the same constant the queue
   * spreads, routing is `routingTargetId`, and the floor is the kind's own
   * permission — the test `canDecideGate` applies, which for every registered kind
   * today is the `work_item:edit` the queue's `canEdit` shortcut reads. So a card
   * marked yours is a card the tab lists with a press. An admin holding
   * `approval:decide_any` is NOT made `yours` by it: the marker says who is ASKED,
   * and the tab never lists a gate routed elsewhere.
   *
   * ⚠️ ONE GATE QUERY PER CALL, whatever the set's size, and none for an empty set.
   * The permission read is one more, and only when a gate came back. Neither grows
   * with the row count — the property a per-row lookup on the board would lose.
   *
   * Access travels INTO the query: a reader who may not browse the project gets an
   * empty map, never an error.
   */
  async pendingDecisionsFor(
    input: { projectId: string; workItemIds: string[] },
    ctx: ServiceContext,
  ): Promise<Map<string, PendingDecisionDTO>> {
    if (input.workItemIds.length === 0) return new Map();
    return withWorkspaceContext(ctx, async (tx) => {
      const projectIds = await browsableProjectIds(input.projectId, ctx, tx);
      const rows = await approvalGateRepository.findAwaitingOnItems(
        input.workItemIds,
        projectIds,
        tx,
      );
      if (rows.length === 0) return new Map();
      const held = await projectAccessService.getPermissions(input.projectId, ctx, tx);
      return foldPendingDecisions(
        // ⚠️ NO CARD-LESS ROW CAN BE HERE, and the filter says so in the type rather
        // than throwing: the read is `workItemId IN (…)`, which a NULL never matches,
        // and a marker is drawn ON a card — a plan gate has none to mark (ADR §11.1).
        rows.flatMap((row) =>
          row.workItemId !== null && row.workItem !== null
            ? [
                {
                  ...row,
                  kind: row.kind as ApprovalGateKindDTO,
                  workItemId: row.workItemId,
                  workItem: row.workItem,
                },
              ]
            : [],
        ),
        ctx.userId,
        (kind) => !isRegisteredGateKind(kind) || held.has(handlerFor(kind).permission),
      );
    });
  },

  /**
   * HOW MANY decisions are waiting on this person in the active project — the
   * tab strip's badge (`HomeTabCountsDto.approvals`).
   *
   * ⚠️ THE SAME PREDICATE AND THE SAME ACCESS GATE AS {@link listAwaitingMe},
   * reached through the same repository builder — *one read, not two, so they
   * cannot disagree*. A strip saying `3` above a list of two is what a second
   * copy of this predicate looks like from the reader's side.
   *
   * ⚠️ THIS CARD SUPPLIES THE NUMBER AND WIRES IT NOWHERE. `HomeTabCountsDto.approvals`
   * is still hardwired to `0` with a comment naming this story as its owner;
   * MOTIR-4794 is the card that renders the tab and feeds this into
   * `tabCounts`. Wiring it here would put a number on a strip above a tab that
   * does not exist yet.
   */
  async countAwaitingMe(ctx: HomeActorContext): Promise<number> {
    return withWorkspaceContext(ctx, async (tx) =>
      approvalGateRepository.countAwaitingRoutedTo(await routingScope(ctx, tx), tx),
    );
  },

  /**
   * WITHDRAW THE QUESTIONS NOBODY CAN ANSWER ANY MORE (Bug MOTIR-7146) — every gate in
   * `gateIds` that is still `awaiting` and whose SUBJECT no longer resolves is superseded
   * `subject_gone`. Returns the ids it withdrew.
   *
   * An awaiting gate whose subject stopped resolving — its design or recording gone, its
   * choice or decision body no longer parsing, its delivery set emptied — used to stay
   * `awaiting` for ever: a *Gone* row on To approve, counted, with nothing in the product
   * able to retire it. The subject-event writers each supersede on THEIR event; this is
   * the generic backstop for a subject that went away by any other route, which is why it
   * keys on the observation and never on how the subject went.
   *
   * ⚠️ WITHDRAWN ON OBSERVATION, IN ITS OWN TRANSACTION — chosen over a reconcile sweep.
   * The reads that render a gone subject (To approve, the Approvals room, the overlay)
   * call this AFTER their own read has committed, so a read never holds a gate's lock and
   * never writes inside its snapshot. A sweep would have to read every awaiting gate in
   * every workspace through every kind's resolver to find the rare gone one, and would
   * still leave it on screen until its next tick; the read has already done that work for
   * exactly the gates someone is looking at.
   *
   * ⚠️ THE READ'S VERDICT IS ONLY A CANDIDATE. Each gate is re-read UNDER ITS LOCK, in a
   * transaction of its own, and withdrawn only if it is still `awaiting` AND its kind's
   * handler — the registry's `resolveSubject`, the same seam the decide door reads — still
   * answers null. So a subject that came back between the read and the write is left
   * alone, a gate decided in between is left alone, and every registered kind is covered
   * by the registry rather than by a list here. An unregistered kind has no handler to
   * ask and is never touched.
   *
   * ⚠️ THE LOCK ORDER IS THE DECIDE DOOR'S: a kind that locks its subject before the gate
   * (a plan) has it locked first here too. A cause is not an actor — the write records
   * what happened to the subject and nobody as having decided anything (§6b).
   */
  async withdrawGoneQuestions(
    gateIds: readonly string[],
    ctx: ServiceContext,
  ): Promise<Set<string>> {
    const withdrawn = new Set<string>();
    for (const gateId of new Set(gateIds)) {
      const gone = await withWorkspaceContext(ctx, (tx) => withdrawIfSubjectGone(gateId, ctx, tx));
      if (gone) withdrawn.add(gateId);
    }
    return withdrawn;
  },

  /**
   * {@link withdrawGoneQuestions} over every `awaiting` gate on ONE work item — what the
   * approval overlay calls when its port finds the subject gone (MOTIR-7146). The whole
   * card rather than the one gate the address names, because the port a gate is drawn
   * through is not always its own: a design or acceptance question asked beside an
   * awaiting merge question is ported by the MERGE gate's delivery set, and when that set
   * has emptied it is the merge gate whose subject is gone.
   *
   * Like the list reads, a withdrawal that fails is logged and never fails the read that
   * observed it: the gate stays as it was, and the next open observes it again.
   */
  async withdrawGoneQuestionsOnWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<Set<string>> {
    const awaiting = await withWorkspaceContext(ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(workItemId, tx),
    );
    return withdrawObservedGone(
      awaiting.map((gate) => gate.id),
      ctx,
    );
  },

  /**
   * THE APPROVALS ROOM's READ (Story MOTIR-5299 · MOTIR-5301) — the approval
   * records of the ACTIVE project this reader may see, pending first then decided,
   * as ONE page over both sections.
   *
   * ⚠️ AMENDED (Story MOTIR-6179 · MOTIR-6333, 2026-09-25): THE READER NOW CHOOSES
   * A VIEW, AND THIS READ STILL DECIDES WHAT THAT CHOICE MAY SHOW. `view` is a
   * REQUEST — `mine` or `project` — and the served scope rides the DTO. `project`
   * is served only with `approval:view_any` (role ∩ token grant); `mine` is exactly
   * the no-key predicate below. The paragraph that follows is still the rule it
   * always was: no caller can widen what it may see, only narrow it.
   *
   * ⚠️ ONE METHOD, AND THE SCOPE IS NOT A PARAMETER. The obvious shape is two reads
   * — everyone's records, and mine — with the page picking. That makes the PAGE a
   * policy path: a rule outside the catalog is invisible in the grid, un-grantable
   * to a custom role and un-auditable by the guard, and a caller that can pick its
   * own scope can pick the wrong one. So this read RESOLVES the scope: it asks
   * `projectAccessService.getPermissions` for the reader's set and widens to the
   * whole project on **`approval:view_any`** alone. `fullView` comes back as a
   * fact about the answer, and nothing a caller passes can change it.
   *
   * ⚠️ A PERMISSION, NEVER A ROLE. Not the workspace-manager helper on
   * `projectAccessService` — that is `owner || admin`, a role check, and a room
   * scoped on it could never be opened to a custom role. No membership row is read and no role compared here.
   *
   * THE TWO VIEWS (`design/approvals/design-notes.md` § The two views):
   *   · WITHOUT the key — the gates ROUTED TO this reader and still `awaiting` (§2's
   *     routing predicate, CALLED in the repository, so this section and the
   *     Workbench tab cannot disagree), plus the gates this reader DECIDED.
   *   · WITH the key — every `awaiting` gate of the project, and every decided one.
   *   · IN NEITHER — `superseded`: withdrawn, not decided, and the design lists it
   *     nowhere.
   * Both are floored by `project:browse`: a reader who may not browse the active
   * project gets two empty sections and `fullView: false`, not an error.
   *
   * ⚠️ HOW THE WINDOW RUNS ACROSS TWO SECTIONS. The page windows the CONCATENATION
   * *awaiting-then-decided* as one ordered list, with the shipped clamp rule
   * (`approvalQueueWindow`: an out-of-range page serves the last page, never an
   * empty one). Both totals are counted FIRST, so the denominator is known before
   * a row is read. A window starting at `skip` takes `awaiting` rows from `skip`
   * while any remain, and fills the rest of the page from `decided` starting at
   * `max(0, skip - awaitingTotal)`. `total` is the sum of the two section totals
   * the same counts produced, so the pager cannot disagree with the rows.
   *
   * `canDecide` on a pending row is `canDecideGate` — the decide door's two checks
   * in the door's order, off the ONE permission set read for the page — because in
   * the full view a row is not necessarily routed to the reader, so
   * `listAwaitingMe`'s routed-only shortcut does not hold here.
   *
   * ⚠️ EVERY READ TAKES `tx`, threaded from `withWorkspaceContext` exactly as
   * `listAwaitingMe` does: without one the repository reads return `[]` on a
   * populated database and raise nothing.
   */
  /**
   * The views this reader HAS in the Approvals room (MOTIR-6333) — the same
   * answer `listRecords` returns as `views`, for the one surface that needs it
   * WITHOUT the records: the room's failed-read face keeps the switch, so the
   * other view stays one press away.
   */
  async recordViews(ctx: HomeActorContext | VisitorReadContext): Promise<RoomView[]> {
    // A Visitor's room is decided from the Visitor key set alone (MOTIR-6645):
    // `approval:view_any` and nothing that acts ⇒ Project only.
    if (isVisitorContext(ctx)) {
      openVisitorRead(ctx.project.id, ctx);
      return availableRoomViews({
        hasViewKey: ctx.permissions.has(APPROVAL_VIEW_KEY),
        canAct: false,
      });
    }
    return withWorkspaceContext(ctx, async (tx) => {
      const routing = await routingScope(ctx, tx);
      if (routing.projectIds.length === 0) return [];
      const held = await projectAccessService.getPermissions(ctx.projectId, ctx, tx);
      return approvalRoomViews(held, ctx);
    });
  },

  async listRecords(
    reader: HomeActorContext | VisitorReadContext,
    options: ApprovalQueueListOptions & { view?: RoomView | null } = {},
  ): Promise<ApprovalRecordsPageDto> {
    const pageSize = clampApprovalQueueLimit(options.limit);
    // A VISITOR (Story MOTIR-6170 · MOTIR-6645) reads their one public project's
    // records on a narrowed service context, holding the Visitor key set, decides
    // nothing, and never sees a record on a private epic's descendant or on a
    // withheld plan. A member's read is unchanged.
    const visitor = isVisitorContext(reader) ? reader : null;
    if (visitor) openVisitorRead(visitor.project.id, visitor, APPROVAL_VIEW_KEY);
    const ctx: HomeActorContext = visitor
      ? { ...visitorServiceContext(visitor), projectId: visitor.project.id }
      : (reader as HomeActorContext);
    const read = await withWorkspaceContext(ctx, async (tx) => {
      const routing = visitor
        ? // A Visitor sees no planning-session row: it is its owner's (MOTIR-7913).
          { projectIds: [visitor.project.id], userId: ctx.userId, awaitingSessionIds: [] }
        : await routingScope(ctx, tx);
      const browsable = routing.projectIds.length > 0;
      const held = visitor
        ? visitor.permissions
        : browsable
          ? await projectAccessService.getPermissions(ctx.projectId, ctx, tx)
          : new Set<PermissionKey>();
      const withheld = visitor
        ? {
            workItemIds: [...visitor.hiddenIds],
            planIds: await planChangeSessionRepository.findWithheldPlanIds(
              visitor.project.id,
              [...visitor.hiddenIds],
              tx,
            ),
          }
        : null;
      // THE VIEW (MOTIR-6333): the reader ASKS, this read SERVES. `project` needs
      // `approval:view_any`; `mine` needs a way to act (`APPROVAL_ACT_PERMISSIONS`).
      // A view the reader lacks falls back to the one they have; a reader with
      // neither is served `mine` — their own records, which the page answers with
      // the room's not-found face because `views` is empty.
      const views = browsable ? approvalRoomViews(held, ctx) : [];
      const served =
        (await resolveRoomView({
          requested: options.view ?? null,
          available: views,
          mineHasRows: async () => {
            const mine: ApprovalRecordsScope = { ...routing, fullView: false };
            return (
              (await approvalGateRepository.countRecordsAwaiting(mine, tx)) +
                (await approvalGateRepository.countRecordsDecided(mine, tx)) >
              0
            );
          },
        })) ?? 'mine';
      const scope: ApprovalRecordsScope = {
        ...routing,
        fullView: served === 'project',
        ...(withheld ? { withheld } : {}),
      };

      const awaitingTotal = await approvalGateRepository.countRecordsAwaiting(scope, tx);
      const decidedTotal = await approvalGateRepository.countRecordsDecided(scope, tx);
      const total = awaitingTotal + decidedTotal;
      const { page, skip } = approvalQueueWindow(total, options.page, pageSize);

      const awaitingTake = Math.max(0, Math.min(pageSize, awaitingTotal - skip));
      const decidedTake = pageSize - awaitingTake;
      const [awaitingRows, decidedRows] = await Promise.all([
        awaitingTake > 0
          ? approvalGateRepository.findRecordsAwaiting(scope, { skip, take: awaitingTake }, tx)
          : Promise.resolve([]),
        decidedTake > 0 && decidedTotal > 0
          ? approvalGateRepository.findRecordsDecided(
              scope,
              { skip: Math.max(0, skip - awaitingTotal), take: decidedTake },
              tx,
            )
          : Promise.resolve([]),
      ]);

      // A Visitor names each decider from the user row, never the stored label (MOTIR-6646).
      const decider = visitor
        ? await visitorDeciderNames(
            decidedRows.map((row) => row.decidedById),
            tx,
          )
        : null;

      // ONE subject query per KIND on the page, across BOTH sections.
      const subjects = await summarizeGateSubjects([...awaitingRows, ...decidedRows], tx);

      // THE ROUTED-TO NAMES, read ONCE for the page (never one read per row), keyed
      // by user id. Each row then resolves its own name and its own decide flag
      // directly, so there is no index-aligned array whose fallback no row can reach.
      const usersById = new Map<string | null, Parameters<typeof routedToDisplayName>[0]>(
        (
          await userRepository.findByIds(
            [...new Set(awaitingRows.map(recordRoutedToId))].filter(
              (id): id is string => id !== null,
            ),
            tx,
          )
        ).map((user) => [user.id, user] as const),
      );
      // `canDecideGate` is handed the page's permission set, so it reads nothing.
      const awaitingItems: ApprovalQueueRowDto[] = await Promise.all(
        awaitingRows.map(async (row) =>
          toApprovalQueueRowDto(
            row,
            subjects.get(row.id) ?? null,
            // A card-less row (MOTIR-6034; ADR §11.6) is decided on its kind's
            // permission alone — there is no card for the relationship half to read.
            visitor
              ? false
              : row.workItem
                ? await canDecideGate(
                    { ...row.workItem, projectId: ctx.projectId },
                    row.kind,
                    ctx,
                    tx,
                    held,
                  )
                : canDecideCardlessGate(row.kind, held),
            // A routed user whose row has gone resolves to nothing, as on the item page.
            routedLabelFor(ctx, usersById.get(recordRoutedToId(row)) ?? null),
          ),
        ),
      );

      const records: ApprovalRecordsPageDto = {
        fullView: scope.fullView,
        scope: served,
        views,
        sections: {
          awaiting: { items: awaitingItems, total: awaitingTotal },
          decided: {
            items: decidedRows.map((row) => {
              const dto = toApprovalRecordDecidedRowDto(row, subjects.get(row.id) ?? null);
              return decider ? { ...dto, decidedByLabel: decider(row.decidedById) } : dto;
            }),
            total: decidedTotal,
          },
        },
        total,
        page,
        pageSize,
      };
      // A Visitor reads and never writes, so nothing they look at is withdrawn.
      return { records, gone: visitor ? [] : goneCandidates(awaitingRows, subjects) };
    });

    // THE SAME WITHDRAWAL To approve makes (MOTIR-7146): a pending record whose subject
    // is gone is withdrawn after the read, and a withdrawn question is listed in neither
    // section — so it leaves this page now rather than on the next read.
    const withdrawn = await withdrawObservedGone(read.gone, ctx);
    if (withdrawn.size === 0) return read.records;
    const { records } = read;
    return {
      ...records,
      sections: {
        ...records.sections,
        awaiting: {
          items: records.sections.awaiting.items.filter((row) => !withdrawn.has(row.gateId)),
          total: records.sections.awaiting.total - withdrawn.size,
        },
      },
      total: records.total - withdrawn.size,
    };
  },

  /**
   * The AWAITING gate of one KIND on one work item, plus whether this actor may
   * decide it (Subtask MOTIR-4792).
   *
   * ⚠️ NARROWER THAN `getForWorkItem` ABOVE, AND STILL A DIFFERENT QUESTION:
   * *what is somebody being ASKED?* rather than *what does the frame show?* A
   * surface that lists outstanding work — the Approvals tab, a routing read —
   * wants this one, because a decided gate is not something anybody is waiting
   * on. It is expressed OVER the general read rather than beside it, so the two
   * cannot drift about the authority composition or the existence leak.
   *
   * ⚠️ SCOPED BY KIND, and that is not a convenience. A card carrying a
   * repository SET legitimately holds SEVERAL simultaneous awaiting gates — ADR
   * §6b's uniqueness is `(workItemId, kind, subjectId)` — so *"the awaiting
   * gate"* is only a well-formed question once a kind is named. The design
   * result section names `design_result`; the merge section will name its own.
   * Returns the OLDEST when a kind somehow has more than one, matching the
   * repository's `createdAt asc`, so the surface is deterministic rather than
   * arbitrary.
   *
   * ⚠️ NO LOCK AND NO TRANSACTION OF ITS OWN. This is a render read: the
   * decision it feeds re-derives every field under the lock in `decide` below,
   * and nothing here may be carried into that write. A gate this read reports
   * `awaiting` can be decided by somebody else a millisecond later, which is
   * precisely the race state `H` exists to draw.
   */
  async getAwaitingForWorkItem(
    input: { workItemId: string; kind: ApprovalGateKindDTO },
    ctx: ServiceContext,
  ): Promise<WorkItemGateRead> {
    const read = await this.getForWorkItem(input, ctx);
    // The general read returns the awaiting gate FIRST when one exists, so a
    // non-awaiting answer here means this kind has no live question — never
    // that one was hidden behind a decided row.
    if (read.gate?.state !== 'awaiting')
      return {
        gate: null,
        canDecide: false,
        routedToLabel: null,
        earlierApproval: null,
        settingsDoor: null,
        stamp: null,
        movedSince: [],
      };
    return read;
  },

  /**
   * DECIDE one gate. **The only way a gate's state ever changes.**
   *
   * The sequence, inside ONE `withWorkspaceContext` transaction, in this order —
   * and the order is the contract, not an implementation detail:
   *
   *   1. **Lock the gate row and RE-READ it.** Deciding is a read-derived write:
   *      the decision depends on the state it just read, so a plain
   *      read-then-write races two reviewers pressing in the same moment. The
   *      loser WAITS on the winner's commit (no `SKIP LOCKED` — there is no
   *      next-best gate to fall to) and then reads what actually happened, which
   *      is what lets the refusal NAME the winner.
   *   2. **Gate on the ACTOR** — the permission floor the kind names, then ADR
   *      §2's relationship rule. A reader who may browse but not decide gets a
   *      typed refusal, never a 404 and never a silent no-op.
   *   3. **Refuse a gate that is not `awaiting`**, naming who decided it and when,
   *      so the surface can say so in place rather than as a toast that scrolls
   *      away — and then **refuse a STALE press** (3b), one whose stamp no longer
   *      matches what the gate, its companion and the card say now (MOTIR-5234).
   *   4. **PIN what was approved** (§6c) — an approval keeps the bytes it was
   *      given on. MOTIR-4913, and it is in the DOOR rather than in a handler on
   *      purpose: retention belongs to the SUBJECT that was decided, never to the
   *      gate kind that carried the decision. Skipped for `request_changes`.
   *   5. **Run the kind's EFFECT**, dispatched through the registry.
   *   6. **Write the decision** — `state`, `decidedById`, `decidedAt`, `noteMd`,
   *      and §6a's five decision-time AUDIT columns.
   *
   * ⚠️ **THE WRITE IS LAST, AND THAT IS THE ORDER §6a ASKS FOR** (MOTIR-5046).
   * It used to be step 4, above the pin and the effect. `outcome_ref` records
   * WHAT THE DECISION CAUSED, which is not known until the effect returns — and
   * §6a forbids the obvious alternative in as many words: *"Written IN the
   * deciding write, never backfilled, and the immutability guard is what holds
   * that."* `trg_approval_gate_decided_immutable` enforces it, so a decision
   * written first and amended afterwards is REFUSED by the database rather than
   * merely untidy. Nothing else moved, and nothing is weakened: the whole
   * sequence is one transaction, so a failing effect still discards the decision.
   *
   * ⚠️ **NOTHING EXTERNAL HAPPENS INSIDE THE TRANSACTION.** There are no emails
   * and no webhooks in this card; the rule is stated and the seam is built so
   * the MERGE card — which does have an external call — inherits a boundary that
   * already exists rather than inventing one. A handler's `approve` performs
   * database work only; anything that leaves the process belongs after the
   * commit, in the door's caller.
   *
   * ⚠️ **WHERE THE OTHER HALF OF MOTIR-4913 LIVES.** The supersede predicate and
   * the product-written `superseded` transition (§6b) are in the PUBLISH path
   * (`designEvidenceService`), because that is where a subject stops being
   * current. This door has always REFUSED a `superseded` gate; what changed is
   * that a republish now writes that state.
   */
  async decide(
    input: DecideGateInput,
    ctx: ServiceContext,
    options: DecideGateOptions = {},
  ): Promise<DecideGateResult> {
    // ── BEFORE THE TRANSACTION ────────────────────────────────────────────────
    // Two reads that must NOT hold the gate's row lock:
    //
    //   · the gate's EXISTENCE and its kind, so the handler — and therefore the
    //     status INTENT — is known before anything is locked. This read is for
    //     existence and routing ONLY; every field the decision turns on is
    //     re-derived under the lock below, never carried over from here (the
    //     same discipline `acceptanceEvidenceService.decide` records);
    //   · the project's concrete key for that intent, which
    //     `workflowsService.resolveStatusKey` answers by opening its OWN
    //     transaction. Called from inside ours it would take a second pooled
    //     connection while we hold a `FOR UPDATE` lock — the deadlock shape
    //     `workItemsService` warns about at `applyStatusTransition`. It is a
    //     project's status VOCABULARY, i.e. reference data, so reading it early
    //     is both cheaper and correct.
    //
    // ⚠️ A CARD-LESS GATE HAS NO ITEM TO LOAD (Story MOTIR-6012 · MOTIR-6034; ADR
    // `approval-gates.md` §11.1). A `plan_approval` gate belongs to no work item, so
    // the pre-read resolves its project from the gate's OWN `projectId` column rather
    // than through a card; a card gate still resolves it through its card, and a card
    // gate whose card is gone is still the not-found it always was.
    const preread = await withWorkspaceContext(ctx, async (tx) => {
      const gate = await approvalGateRepository.findById(input.gateId, tx);
      if (!gate) return null;
      if (gate.workItemId === null) return { gate, projectId: gate.projectId };
      const item = await workItemRepository.findById(gate.workItemId, tx);
      return item ? { gate, projectId: item.projectId } : null;
    });
    // Missing, or hidden by the workspace RLS policy. Indistinguishable on
    // purpose — a 404 that cannot confirm a foreign gate exists.
    if (!preread) throw new ApprovalGateNotFoundError(input.gateId);

    // ── SOURCE AGREEMENT — before anything is locked, so a mismatch writes nothing.
    //
    // `source: 'github'` and `options.synced` say the same thing from two sides, so
    // either without the other is a caller claiming something it cannot back. The
    // direction that matters is the first: without this, any caller that can set
    // `source` could write `decisionSource = github` against its own `ctx.userId` —
    // a Motir surface claiming to be GitHub, in the one table an auditor trusts.
    if (input.source === 'github' && !options.synced) {
      throw new ApprovalGateSyncedActorMismatchError(input.gateId, 'source_without_actor');
    }
    if (options.synced && input.source !== 'github') {
      throw new ApprovalGateSyncedActorMismatchError(input.gateId, 'actor_without_source');
    }

    const handler = handlerFor(preread.gate.kind);
    // ⚠️ AN OVERTURN RESOLVES `cancelled` BY KEY, NEVER BY CATEGORY (MOTIR-5956).
    // `resolveStatusKey` falls back to the category, and `cancelled` shares hers with
    // `done` — so a project without a `cancelled` status would have an overturn write
    // `done`, the one status it must never write. No such status ⇒ null ⇒ the decision
    // is recorded and no status moves (ADR §1's MOTIR-5952 amendment, point 7).
    const resolvedStatusKey =
      input.decision === 'overturn'
        ? ((await workflowsService.listStatusesByProject(preread.projectId, ctx.workspaceId)).find(
            (status) => status.key === CANCELLED_STATUS_KEY,
          )?.key ?? null)
        : handler.statusIntent
          ? await workflowsService.resolveStatusKey(
              preread.projectId,
              ctx.workspaceId,
              handler.statusIntent,
            )
          : null;

    // THE KIND'S PRE-TRANSACTION WORK (MOTIR-6035) — reads that open their own context
    // and best-effort writes that must not ride the decision (a plan's approve resolves
    // its repository pins here, exactly as `approvePlan` does before its own
    // transaction). Only for a gate the pre-read found `awaiting`: a decided or
    // withdrawn gate is refused under the lock, and there is nothing to prepare for.
    const outside = {
      subjectId: preread.gate.subjectId,
      decision: input.decision,
      ctx,
      effectOptions: options.effectOptions,
    };
    const prepared =
      handler.beforeTransaction && preread.gate.state === 'awaiting'
        ? await handler.beforeTransaction(outside)
        : undefined;

    // ── THE TRANSACTION ───────────────────────────────────────────────────────
    // Every status hop the kind's effect applies is recorded here (`applyGateTransition`)
    // and announced after the commit, below (Bug MOTIR-9415). The connection retry runs
    // only before the body starts, so a dead attempt records nothing.
    const appliedTransitions: AppliedGateTransition[] = [];
    let decidedResult: DecideGateResult;
    try {
      decidedResult = await withWorkspaceContext(
        ctx,
        (tx) => decideUnderLock(tx),
        handler.transactionBudget,
      );
    } catch (err) {
      // What a kind repairs AFTER the rollback, outside any transaction (a plan's lazy
      // `stale` backstop), and the error to throw in its place.
      if (handler.afterRollback) throw await handler.afterRollback(err, { ...outside, prepared });
      throw err;
    }
    // AFTER THE COMMIT — the effect's post-commit work (MOTIR-6035: a plan's events and
    // its target-lock release), never inside the transaction and never for a decision
    // that rolled back. Stripped from the result so it never crosses the wire.
    const { afterCommit, ...effect } = decidedResult.effect;
    if (afterCommit) await afterCommit();
    // THE HOPS THE DECISION WROTE (Bug MOTIR-9415) — `work-item/transitioned` for each, as
    // every other mover sends it after its own commit. Without it the parent rollup, the
    // bell and automation rules never saw a gate-decided move.
    await emitAppliedGateTransitions(appliedTransitions, ctx);
    // TO RESUME (MOTIR-7707): a decision on a gate a parent run stopped at moves the
    // cards waiting on that run. After the commit, in the close's lock order —
    // `resumeStateService.afterGateDecided` says why.
    if (preread.gate.workItemId !== null && isRunHoldingGateKind(preread.gate.kind)) {
      await resumeStateService.afterGateDecided(preread.gate.workItemId, ctx);
      // …and an APPROVAL asks for the hosted resume of the run it released
      // (MOTIR-7710). Never fails the decision; the job decides if anything starts.
      if (DECISION_STATE[input.decision] === 'approved') {
        await requestGateResumeAfterDecision(preread.gate, ctx.workspaceId);
      }
    }
    return { ...decidedResult, effect };

    async function decideUnderLock(tx: Prisma.TransactionClient): Promise<DecideGateResult> {
      // 0 · THE SUBJECT'S LOCK FIRST, for a kind whose subject's writers already hold it
      //     when they reach the gate (ADR §11.5 — a plan: markPlanned, the drift writers,
      //     the last-withdrawal discard). The generic gate-then-effect order would
      //     deadlock against them. `subjectId` is immutable, so the pre-read's is safe.
      if (handler.lockSubjectBeforeGate) {
        await handler.lockSubjectBeforeGate(preread!.gate.subjectId, tx);
      }
      // 1 · LOCK AND RE-READ. Everything below reads THIS row, not the pre-read.
      const locked = await approvalGateRepository.lockById(input.gateId, tx);
      if (!locked) throw new ApprovalGateNotFoundError(input.gateId);

      // A card-less gate (ADR §11.1) has no item: it is answered from its own columns.
      const item =
        locked.workItemId === null
          ? null
          : await workItemRepository.findById(locked.workItemId, tx);
      // Tenant gate FIRST, exactly as `applyStatusTransition` does it: a
      // cross-workspace row is indistinguishable from a never-existed one, and
      // must not leak through a state or permission error.
      //
      // ⚠️ DEFENCE IN DEPTH, AND UNREACHABLE BY MEASUREMENT RATHER THAN BY
      // ARGUMENT (MOTIR-4796). Every route to it is closed one step earlier:
      // the PRE-READ above performs the same two reads under the same workspace
      // GUC and returns `ApprovalGateNotFoundError` when either comes back
      // empty, and RLS is what makes them come back empty. Even the one shape
      // that gets PAST the gate's own policy — a gate carrying this workspace's
      // id whose work item belongs to another, which nothing in the schema
      // forbids — is refused there, because the item read is the one that fails.
      //
      // It is kept because the door must not depend on the pre-read staying
      // correct: this is the check that runs UNDER THE LOCK, and the pre-read's
      // own note says every field the decision turns on is re-derived here and
      // never carried over. Removing it would make that sentence false.
      //
      // The invariant — that a mismatched pair is refused, and refused as a
      // not-found rather than as a permission or state error — is pinned by
      // `tests/approval-gate-coverage-floor.test.ts` § 'decide — the POST-LOCK
      // tenant gate', which builds exactly that row with the admin client and
      // asserts the refusal plus that nothing was written.
      //
      // A CARD-LESS gate (MOTIR-6034) is tenant-gated on its OWN `workspaceId`, which
      // the same RLS policy already bound — the same defence in depth, one read fewer.
      /* v8 ignore next 7 */
      if (
        locked.workItemId === null
          ? locked.workspaceId !== ctx.workspaceId
          : !item || item.workspaceId !== ctx.workspaceId
      ) {
        throw new ApprovalGateNotFoundError(input.gateId);
      }
      // The project the decision is asserted against: the card's, or — for a gate with
      // no card — the gate's own `projectId` column (ADR §11.1).
      const projectId = item?.projectId ?? locked.projectId;

      // 2 · THE ACTOR GATE, in two halves that are NOT interchangeable.
      //
      // (a) THE FLOOR — the permission the KIND names. It raises
      //     `ProjectNotFoundError` (→ 404) for an actor who cannot BROWSE the
      //     project and `PermissionDeniedError` (→ 403) for one who can browse
      //     but lacks the key, which is exactly the no-existence-leak posture
      //     the card asks for: *an actor without the decide permission gets a
      //     typed refusal; an actor who cannot browse gets a not-found, so
      //     neither leaks the other.* `tx` is threaded so the gate shares this
      //     transaction's snapshot AND its bound workspace GUC.
      await projectAccessService.assertPermission(projectId, ctx, handler.permission, tx);

      // (b) THE RELATIONSHIP — ADR §2's 2026-09-11 amendment (Yue): **the
      //     assignee, or the reporter WHEN THE ITEM HAS NO ASSIGNEE, or anyone
      //     holding `approval:decide_any` on ANY work item**, for both verbs.
      //     Your OWN gate follows a relationship to the item; ANYONE's follows a
      //     permission a team can grant (MOTIR-5292) — never a role.
      //
      //     ⚠️ It is APPLIED ON TOP OF the floor, never instead of it — that
      //     half is unchanged, and it is what a project `viewer` who happens to
      //     be the assignee fails.
      //
      //     ⚠️ AUTHORITY AND ROUTING NOW COINCIDE for the relationship arms.
      //     §2 routes a gate to `assigneeId ?? reporterId`, exactly one person,
      //     and that person is exactly who these two arms authorise. The gate is
      //     pressed by the person it is shown to, or by a key-holder. (Until
      //     2026-09-11 the reporter arm was UNCONDITIONAL and the two axes were
      //     deliberately apart; the ADR keeps that argument visible as
      //     superseded rather than deleting it, and this comment no longer
      //     makes it.)
      //
      //     ⚠️ THE `approval:decide_any` ARM IS THE ONLY REMAINING ESCAPE
      //     HATCH. The rule it replaced existed to prevent a gate whose single
      //     recipient is on leave or has left from holding the work for ever — a
      //     real failure, not a dismissed one. A key-holder still unblocks it,
      //     under a PERMISSION a team can grant to a custom role (MOTIR-5292) —
      //     not the workspace role it used to be, which nobody could be given.
      //
      //     The rule itself lives in `resolveGateAuthority` above — ONE
      //     statement, called by the render read and by this door, so the two
      //     cannot drift. Its header carries the asked-never-derived rule, the
      //     which-arm-not-a-boolean rule and why the arm order is the routing
      //     order.
      //     ⚠️ A SYNCED DECISION SKIPS BOTH HALVES OF STEP 2, and that is decision
      //     4 rather than a shortcut. A GitHub reviewer is not the card's assignee
      //     or reporter and holds no Motir permission — an unmapped one holds no
      //     Motir anything — so neither the floor nor the relationship is a
      //     question that can be asked about them. Their entitlement was checked
      //     against the HOST instead (`getRepositoryPermission`, decision 2), by
      //     the evaluator, before this door was called. §2 is unchanged for every
      //     Motir surface: `resolveGateAuthority` never returns `github_review`.
      //
      //     ⚠️ A CARD-LESS GATE HAS NO RELATIONSHIP HALF (ADR §11.6). §2's rule is
      //     about a WORK ITEM's assignee and reporter, and a plan gate has none, so
      //     its authority is the kind's permission alone — the floor just asserted —
      //     recorded as `plan_permission` (`resolveCardlessGateAuthority`).
      // ⚠️ THE REVIEW AGENT likewise skips the relationship half (MOTIR-6819; §12.3): its
      //     entitlement is the review run's token, checked by the verdict route before this
      //     door is called, and the attributed user may be the workspace's stand-in rather
      //     than the card's assignee. The FLOOR above still applies to that user, as it does
      //     to a synced decision's actor.
      const authority: ApprovalGateAuthorityDTO | null = options.synced
        ? 'github_review'
        : options.reviewAgent
          ? 'review_agent'
          : item
            ? await resolveGateAuthority(item, ctx, tx)
            : await resolveCardlessGateAuthority(
                { projectId, permission: handler.permission },
                ctx,
                tx,
              );
      if (!authority) throw new ApprovalGateNotAuthorisedError(input.gateId);

      // THE SYNCED ACTOR, resolved UNDER THE LOCK so the membership it reads is the
      // one at the decision rather than at the delivery.
      //
      // ⚠️ RESOLVING THE IDENTITY IS NOT ENOUGH — the bound user must also be a
      // member of THIS gate's workspace. A `GithubIdentity` is global, so without
      // the membership check a reviewer who has a Motir account in some OTHER
      // workspace would be recorded as a member of this one, which is a false
      // statement about who decided and about their access. The membership
      // repository is the one `projectAccessService` itself reads.
      let syncedActor: { userId: string | null; label: string } | null = null;
      if (options.synced) {
        const identity = await githubIdentityRepository.findByGithubUserId(
          options.synced.reviewerGithubUserId,
          tx,
        );
        const member = identity
          ? await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
              identity.userId,
              locked.workspaceId,
              tx,
            )
          : null;
        const memberUserId = member ? identity!.userId : null;
        const memberLabel = memberUserId ? await actorLabel(memberUserId, tx) : null;
        // ⚠️ THE UNRESOLVED LABEL IS THE LOGIN, NEVER NULL AND NEVER EMPTY (§6b —
        // an unattributable presence must not read as nobody). `decidedById` null
        // PLUS a label is what a surface reads as *"not a Motir member"*; a null
        // label would make it read as *nobody decided this*.
        syncedActor = {
          userId: memberUserId,
          label: memberLabel
            ? `${memberLabel} (@${options.synced.reviewerLogin})`
            : `@${options.synced.reviewerLogin}`,
        };
      }

      // 3 · REFUSE A GATE THAT IS NOT `awaiting`.
      //
      // ⚠️ TWO refusals, not one, and the split mirrors ADR §6b's own: a DECIDED
      // gate is somebody's answer and a SUPERSEDED one is a withdrawn question.
      // Collapsing them would make the surface say "somebody already decided
      // this" about a question nobody answered — the one sentence the audit must
      // never be able to produce.
      if (locked.state === 'superseded')
        throw new ApprovalGateSupersededError(input.gateId, locked.supersededCause);
      if (locked.state !== 'awaiting') {
        throw new ApprovalGateAlreadyDecidedError(
          input.gateId,
          locked.state,
          locked.decidedById,
          locked.decidedAt,
          locked.decidedByLabel,
        );
      }
      // 3a · REFUSE A QUESTION ABOUT ABANDONED WORK (MOTIR-7109). Archiving a card or
      //      moving it to Cancelled withdraws its `awaiting` gates in the same
      //      transaction (`withdrawQuestionsOnArchive`, the funnel's Cancelled rule), so
      //      this is the BACKSTOP for a gate that predates those writers or reached the
      //      card some other way: approving it would write a status and merge pull
      //      requests for work nobody intends to finish. Read off the item locked-read
      //      above, every kind alike. Refused as WITHDRAWN — the reader should leave,
      //      not look again — with the cause the withdrawing writers record, and with
      //      no `superseded` row behind it, as three other raise sites already do.
      if (item && (item.archivedAt !== null || item.status === CANCELLED_STATUS_KEY)) {
        throw new ApprovalGateSupersededError(input.gateId, 'pulled_back');
      }

      // 3b · REFUSE A STALE PRESS (Story MOTIR-5232 · Subtask MOTIR-5234; ADR §6b's
      //      MOTIR-5234 amendment) — the question is live, and what the reader was
      //      shown has moved since.
      //
      // ⚠️ AFTER THE STATE REFUSALS, ALWAYS. A withdrawn question must be reported
      // as withdrawn, never as stale — the two tell the reader opposite things
      // (leave, versus look again).
      //
      // ⚠️ RECOMPUTED HERE, UNDER THE LOCK, from the LOCKED gate and the item read
      // after it — never from the pre-read, whose own note forbids carrying any
      // field the decision turns on. A comparison against a value read before the
      // lock would have exactly the race this check exists to close, and would be
      // wrong only when two things happened close together.
      //
      // ⚠️ THE COMPANION IS READ EVEN FOR THE BYPASS, because the result reports it:
      // `approvePrimaryAndMerge` decides the companion only while its version is still
      // the one checked here.
      const companionVersion = await companionSubjectVersion(locked, tx);
      // What the kind's verb and version seams are handed — built here, under the lock,
      // because a kind whose version moves in place is asked for it by the stamp check.
      const args = {
        gate: {
          id: locked.id,
          workspaceId: locked.workspaceId,
          projectId: locked.projectId,
          workItemId: locked.workItemId,
          subjectId: locked.subjectId,
        },
        item,
        ctx,
        tx,
        resolvedStatusKey,
        prepared,
        effectOptions: options.effectOptions,
        appliedTransitions,
        // Validated in step 3c below, BEFORE any handler seam that acts reads it; the
        // version seam ignores it.
        refusalVerdict: input.refusalVerdict ?? null,
      };
      // §6a's first row — the subject's version AS DECIDED, answered by the KIND and read
      // under the lock BEFORE the effect runs. ⚠️ BEFORE, not after (MOTIR-6035): a plan's
      // approve writes the materialized ids back onto its proposals, which moves the
      // digest, so a version read after the effect would record what the approval MADE
      // rather than what was approved. No earlier kind's effect moves its own subject, so
      // for them the two readings agree.
      const decidedVersion = await handler.subjectVersion(args);
      // 3b′ · THE REVIEW AGENT'S VERDICT IS ABOUT ONE VERSION (MOTIR-6819; ADR §12.4, §12.5).
      //       A verdict naming a version that is not the gate's, or a gate whose set has
      //       moved under it, decides nothing — the push landed mid-review, and the verdict
      //       is recorded on the RUN, never on the gate. After the state refusals, so a
      //       withdrawn review is reported as withdrawn.
      if (
        options.reviewAgent &&
        (locked.subjectVersion !== options.reviewAgent.subjectVersion ||
          decidedVersion !== locked.subjectVersion)
      ) {
        throw new ApprovalGateStaleSubjectError(input.gateId, ['subject']);
      }
      if (input.stamp !== DECIDED_WITHOUT_A_READER) {
        const moved = stampMoved(input.stamp, {
          // ⚠️ A SUBJECT REVISED IN PLACE (a plan, ADR §11.3/§11.5c) stamps the version
          // AS IT IS NOW — its gate is never superseded by a revision, so the row's own
          // `subjectVersion` would never move and a stale reader would never be refused.
          subjectVersion: handler.stampsLiveVersion ? decidedVersion : locked.subjectVersion,
          companionSubjectVersion: companionVersion,
          // A card-less gate has no card body (ADR §11.3) — its stamp carries null.
          descriptionMd: item?.descriptionMd ?? null,
        });
        if (moved.length > 0) {
          throw new ApprovalGateStaleSubjectError(
            input.gateId,
            movedAsReaderSees(moved, locked.kind),
          );
        }
      }

      // 3c · THE VERB MUST BE ONE THIS GATE OFFERS (MOTIR-5893; ADR §1's MOTIR-5887
      //      amendment, point 5). A choice's verbs are its options plus *None of
      //      these*; every other kind's are Approve plus Request changes. Checked
      //      after the state and stale refusals, which describe the QUESTION, and
      //      before anything is written. An option the choice does not hold is the
      //      handler's to refuse, since only it reads the options.
      // THE REVIEW AGENT'S KIND (ADR §12.3, MOTIR-6819): the agent's verdict only on its own
      // gate; a PERSON only approves it — *Continue without the review* — and says why.
      // Waving a review past is the decision that most needs its reason (§10a, extended).
      const isAgentReview = locked.kind === AGENT_REVIEW_KIND;
      if (options.reviewAgent && !isAgentReview) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'review_agent_on_other_kind');
      }
      if (isAgentReview && !options.reviewAgent) {
        if (input.decision === 'request_changes') {
          throw new ApprovalGateVerbNotOfferedError(
            input.gateId,
            'request_changes_on_agent_review',
          );
        }
        if (input.decision === 'approve' && !input.noteMd?.trim()) {
          throw new ApprovalGateVerbNotOfferedError(input.gateId, 'override_needs_a_note');
        }
      }
      // A PLANNING SESSION'S GATE OFFERS NO VERB (MOTIR-7913): the person answers by sending
      // a turn, which withdraws it. Every decision is refused here, before anything is
      // written, and the gate stays `awaiting`.
      if (locked.kind === PLANNING_SESSION_KIND) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'no_verbs_on_planning_session');
      }
      const isChoice = locked.kind === CHOICE_KIND;
      if (input.decision === 'choose' && !isChoice) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'choose_on_other_kind');
      }
      if (input.decision === 'approve' && isChoice) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'approve_on_choice');
      }
      if (input.decision === 'request_changes' && locked.kind === CONFIRMATION_KIND) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'request_changes_on_confirmation');
      }
      // A plan is changed by TALKING to the planner, never by a gate verb (ADR §11.4).
      if (input.decision === 'request_changes' && locked.kind === PLAN_KIND) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'request_changes_on_plan');
      }
      // Manual work is done or not done (`manual-work-gate.md` §4): Mark done is the one
      // verb, and a person who cannot do the work says so on the card or in the guide.
      if (input.decision === 'request_changes' && locked.kind === MANUAL_WORK_KIND) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'request_changes_on_manual_work');
      }
      // …and DECLINE is offered by the one kind that supplies it (ADR §11.4). Its note
      // is OPTIONAL, deliberately — see `planApprovalHandler.ts`'s header.
      if (input.decision === 'decline' && !handler.decline) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'decline_on_other_kind');
      }
      if (input.decision === 'overturn' && !handler.overturn) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'overturn_on_other_kind');
      }
      // An overturn says what was ACTUALLY discussed, or it is not written at all
      // (point 6b) — the note is the only record of the right direction until the
      // re-plan happens.
      if (input.decision === 'overturn' && !input.noteMd?.trim()) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'overturn_needs_a_note');
      }
      // A REFUSAL SAYS WHY (ADR §10a, MOTIR-6074) — the reason is what whoever picks the
      // work up next acts on, and a refusal without one is a dead end. Keyed on the SOURCE,
      // never on the caller: every surface a person presses from owes it, and `github` is
      // the one source nobody pressed — the review already happened on the host, so the
      // sync records its body (or NULL) instead of being refused (§10b).
      if (
        input.decision === 'request_changes' &&
        input.source !== 'github' &&
        !input.noteMd?.trim()
      ) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'request_changes_needs_a_note');
      }
      // A REFUSAL CAN BE A VERDICT (ADR §10d, MOTIR-6421; `design-refusal-verdict.md`,
      // widened by `acceptance-refusal-verdict.md` §1, MOTIR-6501) — `revise` or
      // `re_plan`, offered on a `request_changes` a person pressed on a gate that ASKS
      // for one: a `design_result`, or an `acceptance_result` on a STORY RUN (the story
      // has an open delivery of its own). `refusalVerdictOfferFor` answers that under
      // this lock, so the shape cannot change between the question and the write. Total
      // over kind × run shape × verb × source: the offered case REQUIRES one, and every
      // other case that names one is refused, so a verdict never lands on a row that did
      // not ask for it. Keyed on the source exactly as the reason is — a `github` refusal
      // was never asked, so it is recorded verdict-less rather than refused, and a
      // verdict SENT with one is refused as not offered.
      const refusalVerdict = input.refusalVerdict ?? null;
      const offersVerdict =
        input.decision === 'request_changes' &&
        input.source !== 'github' &&
        (await refusalVerdictOfferFor(locked, tx));
      if (
        refusalVerdict !== null &&
        (!offersVerdict ||
          !(APPROVAL_GATE_REFUSAL_VERDICTS as readonly string[]).includes(refusalVerdict))
      ) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'refusal_verdict_not_offered');
      }
      if (offersVerdict && refusalVerdict === null) {
        throw new ApprovalGateVerbNotOfferedError(input.gateId, 'refusal_verdict_required');
      }

      // 4 · RETENTION — an APPROVAL PINS the version it was given on
      //      (MOTIR-4913; ADR §6c, with its MOTIR-4911 amendment).
      //
      // ⚠️ IT IS HERE, IN THE GENERIC DOOR, AND NOT IN A HANDLER — and that
      // placement IS the rule rather than a tidiness preference. §6c originally
      // keyed retention on the `design_result` gate; §1's amendment then made the
      // KIND depend on whether the card has a pull request, so a design that
      // opened one is approved through `pull_request_approval`. A pin written by
      // the design handler would therefore stop firing for the COMMON case, with
      // no error and no failing test — the supersede path would simply find
      // nothing to keep, unlink as it always did, and the orphan-GC would reclaim
      // the bytes seven days later. The general form, worth holding on to: **a
      // retention rule belongs to the SUBJECT that was decided, never to the door
      // the decision came through.**
      //
      // So this asks one kind-free question — *does this work item carry a
      // current design result?* — and it is a no-op for every card that does not.
      // When `pull_request_approval` registers (MOTIR-4909 / MOTIR-4910) it
      // inherits the pin by existing, with no line of code in its handler.
      //
      // ⚠️ ONLY APPROVALS PIN. `changes_requested` moves nothing and keeps
      // nothing: the gate ROW records who sent it back and why, and the bytes go
      // with the next publish. That is §6c's intended loss.
      //
      // ⚠️ IN THIS TRANSACTION, which is what §6c asks for in as many words —
      // *written afterwards, a republish racing an approval re-opens the window
      // it exists to close.* The gate row is held under the lock taken in step 1,
      // and the publish path retires an `awaiting` gate BEFORE it locks
      // `design_evidence`, so the two paths take the same two locks in the same
      // ORDER and a race resolves by waiting rather than by deadlocking.
      let filesKept: boolean | null = null;
      // A card-less gate carries no design result to keep (ADR §11.1), so it pins nothing.
      if (DECISION_STATE[input.decision] === 'approved' && locked.workItemId !== null) {
        const pinnedId = await designEvidenceService.pinCurrentForWorkItem(locked.workItemId, tx);
        // Only a kind whose subject IS a design result has files to keep.
        filesKept = locked.kind === 'design_result' ? pinnedId === locked.subjectId : null;
      }

      // 5 · THE KIND'S EFFECT, dispatched through the registry — in the SAME
      // transaction, which is what makes "approving unblocks the cards
      // `blocked_by` this one" true in the same request rather than eventually.
      const effect =
        input.decision === 'request_changes'
          ? await handler.requestChanges(args)
          : input.decision === 'overturn' && handler.overturn
            ? await handler.overturn(args)
            : input.decision === 'decline' && handler.decline
              ? await handler.decline(args)
              : await handler.approve(
                  input.decision === 'choose'
                    ? { ...args, choice: { optionId: input.optionId ?? '' } }
                    : args,
                );

      // 6 · WRITE THE DECISION — LAST, and carrying THE WHOLE AUDIT SET
      //     (MOTIR-5046; ADR §6a).
      //
      // ⚠️ IT USED TO BE STEP 4, ABOVE THE PIN AND THE EFFECT, AND IT HAD TO
      // MOVE. §6a says of `outcome_ref`: *"Written IN the deciding write, never
      // backfilled, and the immutability guard is what holds that … so the
      // outcome is known before the row is written."* Those two clauses are one
      // instruction. `trg_approval_gate_decided_immutable` fires on any UPDATE
      // whose OLD row is `approved` / `changes_requested`, so a decision written
      // first and amended with its outcome afterwards is not merely untidy — the
      // second statement is REFUSED by the database. The only place the outcome
      // and the decision can be written together is after the effect has
      // returned.
      //
      // ⚠️ AND THE ORDER COSTS THE OLD COMMENT'S GUARANTEE NOTHING. The reason
      // given for writing first was *"a failing effect rolls the decision back
      // with it"* — which is a property of the TRANSACTION, not of the order:
      // every statement here is inside the door's single `withWorkspaceContext`,
      // so an effect that throws discards a decision written before it and a
      // decision never written at all, identically. What the order does change is
      // the lock sequence, and it changes it not at all: the gate row is held
      // `FOR UPDATE` from step 1, and the pin and the effect take
      // `design_evidence` and `work_item` after it exactly as they did before.
      const decided = await approvalGateRepository.decide(
        locked.id,
        {
          state: DECISION_STATE[input.decision],
          // WHO SAID YES. For a synced decision this is the resolved member, or
          // null — never `ctx.userId`, which on that path is only the actor
          // entitled to WRITE A STATUS from a webhook (decision 5). The two are
          // different questions and the row keeps them apart.
          decidedById: syncedActor ? syncedActor.userId : ctx.userId,
          decidedAt: options.decidedAt ?? new Date(),
          noteMd: input.noteMd?.trim() ? input.noteMd : null,
          // §6a's first row, answered by the KIND — never by this door. Read
          // under the lock and before the effect (above), so it is the version the
          // subject had at the decision.
          subjectVersion: decidedVersion,
          // What survives `decidedById`'s `SetNull`. Read in this transaction, so
          // it is the name and email as at the decision rather than as at the
          // audit.
          decidedByLabel: syncedActor ? syncedActor.label : await actorLabel(ctx.userId, tx),
          // The rung step 2(b) actually matched, rather than re-derived later
          // against a role that may have changed.
          decidedUnderAuthority: authority,
          // The one field the door cannot derive — the caller says it.
          decisionSource: input.source,
          // WHAT IT CAUSED. `statusWritten` is null on exactly the arms that
          // deliberately wrote nothing (`merge_writes_done`,
          // `request_changes_moves_nothing`, `no_status_in_target_category`), and
          // null is the honest record for those: the decision caused no
          // transition, and `statusDeferredReason` says why on the returned
          // effect. Never a stale value carried from a different arm.
          //
          // ⚠️ EXCEPT ON A CHOICE, where it is the OPTION'S ID (ADR §1's MOTIR-5887
          // amendment, point 7): Workflow A always writes `done`, so the status is
          // implied by the kind and the column holds what only this decision caused —
          // which option won. `chosenOption` carries the rest of the pick.
          //
          // Written through {@link decisionOutcomeFields}, the ONE writer of `outcomeRef`,
          // which the system approval (MOTIR-697) shares rather than duplicates.
          ...decisionOutcomeFields(effect),
          // WHAT THE REFUSAL MEANT (ADR §10d, MOTIR-6421) — validated in step 3c, so it is
          // non-null only on a Motir-pressed `design_result` refusal. HERE, in the deciding
          // write, because the decided-row trigger refuses any later amendment.
          refusalVerdict,
        },
        tx,
      );

      // 6b · WHAT THE DECISION CAUSES ONCE ITS ROW SAYS SO (MOTIR-6819; ADR §12.4) — the
      //      review agent's pass raises the approve-and-merge gate, which the gate set asks
      //      only once it reads this review as decided.
      if (handler.afterDecisionWritten) {
        await handler.afterDecisionWritten({ ...args, state: decided.state });
      }

      // A card's to-fix answer reads its LATEST decided gate of any kind — a Request
      // changes on the approve-to-merge question, or an acceptance Re-run — so every
      // card decision re-decides it (MOTIR-6602). After the write, in this transaction,
      // under the gate lock and the card lock the effect already took in that order.
      if (item) await recomputeWorkItemFixReason(item.id, tx);

      return {
        gate: toApprovalGateDto(decided, item?.descriptionMd ?? null),
        effect,
        filesKept,
        companionSubjectVersion: companionVersion,
      };
    }
  },

  /**
   * THE REVIEW AGENT'S VERDICT (Story MOTIR-1626 · MOTIR-6819; ADR `approval-gates.md`
   * §12.3–§12.5, `hosted-agent-run.md` §8.4) — the INTERNAL entry the run-token verdict
   * route calls (MOTIR-6821). `ctx` is the review run's attributed user, who becomes
   * `decidedById`; the row's authority is `review_agent`, which is what says a machine
   * decided.
   *
   * `pass` approves — the door then raises the approve-and-merge gate for the SAME version
   * and settles the card after the commit. `changes_requested` records the findings, which
   * are REQUIRED and non-empty (the door's `request_changes_needs_a_note`), and moves
   * nothing: the card is To fix `changes_requested`.
   *
   * REFUSED, and nothing written: a gate that is not awaiting (`ApprovalGateSupersededError`
   * for a withdrawn review — the push landed mid-review — or `ApprovalGateAlreadyDecidedError`,
   * one verdict per question), a verdict about another version or a set that moved
   * (`ApprovalGateStaleSubjectError`), and a gate of any other kind.
   *
   * Addressed by the gate's id, or by the card — then its awaiting review, else its latest
   * one, so a verdict for a withdrawn or decided review is refused as such rather than as
   * a not-found.
   */
  async decideAgentReview(
    input: ({ gateId: string } | { workItemId: string }) & {
      subjectVersion: string;
      verdict: 'pass' | 'changes_requested';
      noteMd?: string | null;
    },
    ctx: ServiceContext,
  ): Promise<DecideGateResult> {
    const gateId =
      'gateId' in input
        ? input.gateId
        : await withWorkspaceContext(ctx, async (tx) => {
            const gate = await approvalGateRepository.findLatestByWorkItem(
              input.workItemId,
              AGENT_REVIEW_KIND,
              tx,
            );
            if (!gate) throw new ApprovalGateNotFoundError(input.workItemId);
            return gate.id;
          });
    return approvalGatesService.decide(
      {
        gateId,
        decision: input.verdict === 'pass' ? 'approve' : 'request_changes',
        noteMd: input.noteMd ?? null,
        // The verdict arrives through a token calling the REST API (§12.3) — never `ui`,
        // which would claim a person pressed.
        source: 'api',
        // Nobody was shown a stamp: the version the run reviewed is checked instead.
        stamp: DECIDED_WITHOUT_A_READER,
      },
      ctx,
      { reviewAgent: { subjectVersion: input.subjectVersion } },
    );
  },

  /**
   * APPROVE A GATE ON BEHALF OF A PROJECT SETTING — the design gate of a project whose
   * design approval is switched OFF (Story MOTIR-693 · MOTIR-697;
   * `docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §2).
   *
   * ⚠️ IT RUNS IN THE CALLER'S TRANSACTION, which is the whole reason it is not
   * {@link approvalGatesService.decide}. The gate it decides was created a few statements
   * earlier in the PUBLISH's own transaction and is not visible to any other connection,
   * so the door — which opens its own — would not find it. §2b asks for the gate to be
   * raised and approved in the same transaction, so a rollback never leaves one without
   * the other.
   *
   * ⚠️ AND IT IS THE SAME DECISION, NOT A SECOND ONE. It takes the door's steps 1, 4, 5
   * and 6 through the door's own parts, in the door's order: lock and re-read the gate,
   * PIN the version (§6c), run the kind's `approve` EFFECT (so §3's status effect is a
   * person's approval's exactly), then write the decision LAST with the whole audit set.
   * What it skips is what has no subject here — step 2's actor gate (nobody pressed),
   * step 3b's stale check (nobody was shown anything) and 3c's verb check (the verb is
   * `approve`, which every kind but a choice offers; only `design_result` calls this).
   *
   * THE ROW (§2c): no actor and no label — `decidedById` / `decidedByLabel` null, which
   * §6a warns reads as *nobody decided* ONLY when nothing else says who did; here
   * `decisionSource = system` and `decidedUnderAuthority = project_setting` say it.
   *
   * The status key is resolved from statuses read ON `tx` through the pure
   * `resolveStatusIntent` — never `workflowsService.resolveStatusKey`, which opens a
   * second connection while this one holds the gate lock (the shape
   * `applyStatusTransition` warns about).
   *
   * ⚠️ THE CALLER EMITS THE HOPS (Bug MOTIR-9415). The effect's status hops are recorded
   * on `appliedTransitions`, and only the caller knows when ITS transaction commits, so
   * it sends `emitAppliedGateTransitions` for them then — never this method.
   */
  async approveBySystem(
    gateId: string,
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
    appliedTransitions: AppliedGateTransition[],
  ): Promise<DecideGateResult> {
    // 1 · LOCK AND RE-READ.
    const locked = await approvalGateRepository.lockById(gateId, tx);
    if (!locked || locked.workItemId === null) throw new ApprovalGateNotFoundError(gateId);
    // The door's two refusals, split as its own step 3 splits them (§6b): a withdrawn
    // question is never reported as somebody's answer.
    if (locked.state === 'superseded') {
      throw new ApprovalGateSupersededError(gateId, locked.supersededCause);
    }
    if (locked.state !== 'awaiting') {
      throw new ApprovalGateAlreadyDecidedError(
        gateId,
        locked.state,
        locked.decidedById,
        locked.decidedAt,
        locked.decidedByLabel,
      );
    }
    const item = await workItemRepository.findById(locked.workItemId, tx);
    if (!item || item.workspaceId !== ctx.workspaceId) throw new ApprovalGateNotFoundError(gateId);
    // The door's step 3a backstop (MOTIR-7109): no system approval of abandoned work.
    if (item.archivedAt !== null || item.status === CANCELLED_STATUS_KEY) {
      throw new ApprovalGateSupersededError(gateId, 'pulled_back');
    }

    const handler = handlerFor(locked.kind);
    const statuses = await workflowsRepository.findStatuses(item.projectId, ctx.workspaceId, tx);
    const resolvedStatusKey = handler.statusIntent
      ? resolveStatusIntent(statuses, handler.statusIntent)
      : null;
    const args = {
      gate: {
        id: locked.id,
        workspaceId: locked.workspaceId,
        projectId: locked.projectId,
        workItemId: locked.workItemId,
        subjectId: locked.subjectId,
      },
      item,
      ctx,
      tx,
      resolvedStatusKey,
      prepared: undefined,
      effectOptions: undefined,
      refusalVerdict: null,
      appliedTransitions,
    };
    const decidedVersion = await handler.subjectVersion(args);

    // 4 · THE PIN — an approval keeps the bytes it was given on (§6c).
    const pinnedId = await designEvidenceService.pinCurrentForWorkItem(locked.workItemId, tx);
    const filesKept = locked.kind === 'design_result' ? pinnedId === locked.subjectId : null;

    // 5 · THE KIND'S EFFECT — the same `approve` a person's press runs.
    const effect = await handler.approve(args);

    // 6 · THE DECISION, LAST, with the §2c markers.
    const decided = await approvalGateRepository.decide(
      locked.id,
      {
        state: 'approved',
        decidedById: null,
        decidedAt: new Date(),
        noteMd: null,
        subjectVersion: decidedVersion,
        decidedByLabel: null,
        decidedUnderAuthority: 'project_setting',
        decisionSource: 'system',
        ...decisionOutcomeFields(effect),
        refusalVerdict: null,
      },
      tx,
    );
    await recomputeWorkItemFixReason(item.id, tx);

    return {
      gate: toApprovalGateDto(decided, item.descriptionMd),
      effect,
      filesKept,
      companionSubjectVersion: null,
    };
  },
};
