'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CircleX, Loader2, Snowflake } from 'lucide-react';
import type { PillProps } from '@/components/ui/Pill';
import {
  ApprovalGateControl,
  useRefusalCopy,
  type GateVerb,
} from '@/components/approvals/ApprovalGateControl';
import { useRefusalVerb, type DesignRefusalFacts } from '@/components/approvals/RefusalReason';
import { asksAfterPress, useRefusalReplanSlots } from '@/components/approvals/RefusalReplan';
import { useOptimisticStatusWriter } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';
import type {
  approveAndMergeAction,
  decideApprovalGateAction,
  retryApproveAndMergeMemberAction,
} from '@/app/(authed)/items/[key]/approvalGateActions';
import { GateCallToActionBand } from '@/components/approvals/GateCallToActionBand';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { announceGateDecided, useDecidedGate } from '@/lib/approvals/decidedGates';
import { membersOf, type MemberVersion } from '@/lib/approvalGates/memberVersion';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type {
  ApprovalGateDTO,
  ApprovalGateRefusalVerdictDTO,
  ApproveAndMergeMemberOutcomeDTO,
  EarlierApprovalDTO,
  GateDecision,
  PullRequestApprovalMemberDTO,
} from '@/lib/dto/approvalGate';
import {
  MergeOutcomeProvider,
  persistedRowOutcome,
  rowKey,
  type PersistedRowOutcome,
  type RowMergeOutcome,
} from './MergeOutcomeSlot';
import { hungCheckSentenceKey, QueueExitLine } from './QueueExitLine';
import { decisionDocumentShown } from './DecisionDocumentSlot';
import { withdrawnMergeCopy, type WithdrawnMessage } from './withdrawnMergeCopy';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import type { AgentReviewViewDto } from '@/lib/dto/agentReview';
import {
  CouldNotRunBand,
  OverrideBand,
  PassedBand,
  ReviewingBand,
  SentBackBand,
} from './AgentReviewBand';
import { reviewAgainRequest, type ReviewAgainResult } from './reviewAgainRequest';

// THE DEVELOPMENT BLOCK'S FRAME ARM (Story MOTIR-4906 · Subtask MOTIR-5336),
// `design/github/design-notes.md` §20 · Panel 12c — AND ITS VERBS (Story MOTIR-4909 ·
// Subtask MOTIR-5484, Panels 12p–12w). When the card holds a `pull_request_approval` gate,
// in ANY state, the block IS the universal frame — composed exactly as
// `DesignResultSection` composes the design gate: band 2 (the port) is the pull-request rows
// plus How to test, unchanged; ONE frame for all the run target's pull requests, never one
// per row.
//
// ⚠️ NO CARD INSIDE A CARD (§20, Yue 2026-09-15). The Development section card is the
// container, so the frame renders `layout="flush"` and steps out of the card body's padding:
// its bands run edge to edge under the card head, and the port keeps its floor, ceiling and
// Expand.
//
// ⚠️ THE PRESS IS ONE SERVER CALL, AND ITS ORDER IS THE SERVICE'S. *Approve and merge* calls
// `pullRequestMergeService.approveAndMerge` (MOTIR-5483): the approval commits first, then
// each pull request merges, joins its merge queue, or is refused. The frame draws what that
// ONE response reports — the approval stands whatever the merges did — and a refused member
// offers *Retry merge* on its own row.
//
// ⚠️ A REFUSAL'S REASON LIVES ONLY IN THIS COMPONENT'S STATE. The press does not persist it,
// so after a reload the row reads *Not merged yet* with *Retry merge* and no reason — the
// server read (`members`) says only that the merge gate still awaits. Showing a reason the
// page no longer has would be inventing one.
//
// ⚠️ THE ACTIONS ARRIVE AS PROPS. A host hands its server actions down; a surface that hands
// none (every test of the block, and any read-only host) draws the frame with no verbs,
// exactly as it did before this card.
//
// ⚠️ THE ITEM PAGE HANDS THE DECISION OVER (Bug MOTIR-6323; `design/work-items/design-notes.md`
// § *The item page HANDS THE DECISION OVER*, planning flag 2). A `GateDecision` is submitted
// from ONE place, the approval overlay, so the overlay is the only host that passes `decide`
// and `approveAndMerge`. The item page passes `handOver` and `retryMember` alone: an awaiting
// gate its reader may decide becomes the block plus the call-to-action band, and a decided
// gate keeps *Retry merge* / *Queue again*, which carry out the decision already made.

export interface DevelopmentGateRead {
  gate: ApprovalGateDTO;
  canDecide: boolean;
  routedToLabel: string | null;
  /**
   * WHAT THIS READER IS BEING SHOWN (Story MOTIR-5232 · Subtask MOTIR-5235) — the stamp
   * the gate read handed over, sent back with the press. For a design gate it also covers
   * the pull requests beneath it, which the one press merges. Null when the gate is not
   * awaiting, which is also when there is nothing to press.
   */
  stamp: string | null;
  /**
   * What a reload still knows about each member once the gate is APPROVED — whether its merge
   * gate still awaits and whether the press queued it (MOTIR-5484). Empty before that.
   */
  members?: PullRequestApprovalMemberDTO[];
  /**
   * The approve-to-merge gate's version — its delivery SET — when the frame is handed a
   * PRIMARY gate whose own version is not a set (MOTIR-5790). A story run's acceptance
   * gate is versioned by its recording's commit, so without this the frame would count no
   * members and could not name what its one press merges (panel A's consequence). Absent
   * for every other host, which keeps each shipped frame byte-for-byte as it was.
   */
  mergeSubjectVersion?: string | null;
  /**
   * The approval a RE-ASKED merge gate replaced (Bug MOTIR-5863; § 28 panel 1) — the record
   * band's first line. Drawn only when the frame is re-asked; absent or null, the band is
   * exactly what it was, and it is never reconstructed from the fresh gate, whose decider
   * fields are null by construction.
   */
  earlierApproval?: EarlierApprovalDTO | null;
}

/**
 * THE DECISION PORT'S FACTS (Story MOTIR-4907 · Subtask MOTIR-5678; design §27) — what the
 * frame needs when the gate it asks is a `decision_approval`: the document the slot drew,
 * and the pull requests one press on it will merge. A decision gate's own version names a
 * FILE, not a set, so the pull requests cannot be read out of it the way a merge gate's are.
 */
export interface DecisionPortFacts {
  document: DecisionDocumentViewDTO | null;
  /** `owner/name · #n` of every open pull request delivering the card, in row order. */
  openPullRequests: string[];
}

/** `owner/name:path@blob` → its path and blob; null for an unresolvable version. */
function parseDecisionVersion(version: string | null): { path: string; blob: string } | null {
  if (!version) return null;
  const colon = version.indexOf(':');
  const at = version.lastIndexOf('@');
  if (colon <= 0 || at <= colon) return null;
  const path = version.slice(colon + 1, at);
  if (path.startsWith('unresolvable:')) return null;
  return { path, blob: version.slice(at + 1) };
}

/**
 * The server actions this frame presses. `decide` and `approveAndMerge` are the DECISION
 * doors and only the approval overlay passes them (MOTIR-6323); without both the frame draws
 * no verb, and a row press that would approve a re-asked gate is not offered.
 */
export interface DevelopmentGateActions {
  decide?: typeof decideApprovalGateAction;
  approveAndMerge?: typeof approveAndMergeAction;
  retryMember: typeof retryApproveAndMergeMemberAction;
}

/** The head a pull request is at NOW — what names the member a push moved (state `G`). */
export interface CurrentHead {
  repo: string;
  number: number;
  headSha: string;
}

/** A pull request's derived state as its ROW draws it — what splits a `member_closed`
 *  withdrawal into *merged* and *closed without merging* (MOTIR-5884, § 29). */
export interface RowState {
  repo: string;
  number: number;
  state: 'open' | 'merged' | 'closed';
  /** The host reports the row conflicted at its head (MOTIR-5916) — what names the member
   *  in a `conflict` withdrawal. Absent = no. */
  conflicted?: boolean;
  /** The branch the row targets, for `{base}` (MOTIR-5916). */
  baseRef?: string | null;
  /** The row's delivery carries a standing queue FAILURE the class holds (MOTIR-6596) —
   *  what names the member in a `queue_failed` withdrawal. Absent = no. */
  leftQueue?: boolean;
}

/** What the press, or a retry, reported about one member — the response's outcome, minus
 *  the ids a row does not need. */
type PressOutcome =
  | { outcome: 'merged' | 'enqueued' | 'no_merge_gate' }
  | { outcome: 'refused'; refusal: GateRefusal; pullRequestId: string | null };

function pressOutcomeOf(member: ApproveAndMergeMemberOutcomeDTO): PressOutcome {
  return member.outcome === 'refused'
    ? { outcome: 'refused', refusal: member.refusal, pullRequestId: member.pullRequestId }
    : { outcome: member.outcome };
}

/** One refused member's line in the alert band: the pull request, then the refusal's own
 *  words from MOTIR-4882's union — never a string this surface writes. A refused *Queue
 *  again* says so in its title (E7). */
function RefusedMemberLine({
  name,
  refusal,
  requeue,
}: {
  name: string;
  refusal: GateRefusal;
  requeue: boolean;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  const { headline, nextAction } = useRefusalCopy(refusal);
  return (
    <span className="block">
      <b>{t(requeue ? 'requeue.refusedTitle' : 'refused.title', { pr: name })}</b> {headline}{' '}
      <span className="text-(--el-text-secondary)">{nextAction}</span>
      {/* The host's own words, when it gave any (Bug MOTIR-6735) — the only thing that
          says WHICH setting refused the merge. */}
      {refusal.tag === 'MERGE_BRANCH_PROTECTED' && refusal.reason ? (
        <span className="block break-words text-(--el-text-secondary)" data-merge-refusal-reason>
          {t('setting.hostReason', { reason: refusal.reason })}
        </span>
      ) : null}
    </span>
  );
}

export function DevelopmentGateFrame({
  read,
  itemIdentifier,
  runLabel,
  currentHeads = [],
  rowStates = [],
  terminal = false,
  actions,
  layout = 'flush',
  onShowCurrentVersion,
  gateKey = 0,
  decision = null,
  notice,
  verbsDisabled = false,
  handOver,
  canReplan = false,
  designRefusal,
  agentReview = null,
  reviewAgain = reviewAgainRequest,
  children,
}: {
  read: DevelopmentGateRead;
  /** The card's `MOTIR-<n>` — named by the consequence line and the confirm step, and the
   *  page the actions revalidate. */
  itemIdentifier: string;
  /** Band 1's meta — the run that delivered the pull requests, when known. */
  runLabel: string | null;
  currentHeads?: CurrentHead[];
  /** Each row's derived state (MOTIR-5884) — read only by a withdrawn merge gate. */
  rowStates?: RowState[];
  /** The card sits in a DONE-category status: a withdrawn question promises no re-ask. */
  terminal?: boolean;
  actions?: DevelopmentGateActions;
  /**
   * WHICH BOX the frame sits in (Story MOTIR-5437 · Subtask MOTIR-5440;
   * `design/workbench/design-notes.md` § 24, *FILL, not FLUSH*).
   *
   * `flush` (the default) is the ITEM PAGE: the Development section card is the
   * container, so the frame drops its own chrome and steps out of the card body's
   * padding, and the port keeps its floor, its 34rem ceiling and Expand.
   * `fill` is the APPROVAL OVERLAY: the dialog is the container and the VIEWPORT is
   * the box, so the port drops that floor, that ceiling and Expand, and band 3 sits
   * on the bottom edge. Both are `ApprovalGateControl`'s own shipped layouts — the
   * only thing that differs is the box, and this input picks it. Every band, verb,
   * state, outcome and refusal below is identical in the two.
   */
  layout?: 'flush' | 'fill';
  /**
   * *Show the current version* — re-run the read this frame was rendered from
   * (MOTIR-5235). The approval overlay passes its own fetch. Omitted — the item page —
   * it is `router.refresh()`, because there the block is SERVER-rendered and that is
   * the read it came from (the page-state contract's case 2).
   */
  onShowCurrentVersion?: () => void;
  /** Bumped by a host whose re-read does not change `read.stamp`'s identity on its own. */
  gateKey?: number;
  /** The decision port's facts — read only when the gate asked is `decision_approval`. */
  decision?: DecisionPortFacts | null;
  /**
   * A HOST's notice, drawn in the alert band between the port and band 3 — the approval
   * overlay's *this question was withdrawn* (Subtask MOTIR-5917; § 30 Panel 4a). A member
   * refusal from this frame's own press outranks it: that is the newer news.
   */
  notice?: ReactNode;
  /**
   * DISABLE both verbs, keeping them drawn so band 3 does not reflow (§ 30 Panel 4a — the
   * one recorded departure from § 26, where a moved stamp keeps them live). Only honest with
   * the reason said in words beside them, which is what `notice` is for; the server still
   * refuses a press, so this claims no guarantee.
   */
  verbsDisabled?: boolean;
  /**
   * THE ITEM PAGE (MOTIR-6323): while the gate awaits a reader who may decide it, draw the
   * block unframed and close it with the call-to-action band into the approval overlay.
   * `routedToViewer` says whether the question is routed to this reader, which the band's
   * sentence names. Every other state keeps the frame, without verbs.
   */
  handOver?: { routedToViewer: boolean };
  /**
   * THE RE-PLAN WITH AI DOOR (Story MOTIR-6068 · MOTIR-6211) — `WorkItemPlanEntrance`'s
   * condition for this reader on this card (may plan, not archived). A `decision_approval`
   * sent back offers the seeded planner from its record; false or omitted, it offers none.
   */
  canReplan?: boolean;
  /**
   * A DESIGN SENT BACK IS A VERDICT (Story MOTIR-6070 · MOTIR-6427) — for a frame a
   * `design_result` gate LEADS (Workflow B): where its Re-plan opens, the design card's
   * PARENT (§10h), and the label of the status either verdict returns it to. Absent, the
   * ask names the card itself and the tiles name no status.
   */
  designRefusal?: DesignRefusalFacts;
  /**
   * THE RUN TARGET'S LATEST AGENT REVIEW (Story MOTIR-1626 · MOTIR-6825; design
   * `design/github` § 30). When it is the gate `read` leads with (`agent_review`), the frame
   * draws its own states — Reviewing, Sent back, Could not run — with its band, verbs and
   * record; when the approve-and-merge gate leads over the SAME version it passed or was
   * continued without, the frame draws that record as the band above the port. Absent, the
   * frame is exactly what it was before the review agent existed.
   */
  agentReview?: AgentReviewViewDto | null;
  /** *Review again* — the start card's route (MOTIR-6820). Injected by tests. */
  reviewAgain?: (gateId: string) => Promise<ReviewAgainResult>;
  children: ReactNode;
}) {
  const t = useTranslations('approvalGate.pullRequestApproval');
  const locale = useLocale();
  const tGate = useTranslations('approvalGate');
  // A refusal SAYS WHY (MOTIR-6075; design `approval-control--refusal-reason.mock.html` Panel 2).
  const refusalVerb = useRefusalVerb();
  const tDesign = useTranslations('approvalGate.designResult');
  const tAcceptance = useTranslations('approvalGate.acceptanceResult');
  const tDecision = useTranslations('approvalGate.decision');
  const tReview = useTranslations('approvalGate.agentReview');
  const router = useRouter();
  // The in-browser path to the status rail (Bug MOTIR-5212) — a no-op outside the item page.
  const { applyOptimisticStatus, clearOptimisticStatus } = useOptimisticStatusWriter();

  // The gate as this frame knows it: the server's, until this reader decides — then the row
  // the response returned. A DIFFERENT gate from the server (a withdrawal and a fresh raise
  // arrived on a refresh) replaces it, because it is a different question.
  const [decided, setDecided] = useState<ApprovalGateDTO | null>(null);
  // The reader asked for the current version (MOTIR-5235): the frame that mounts from the
  // re-read focuses its port, and no ordinary render ever does.
  const [rereadAsked, setRereadAsked] = useState(false);
  // A decision the OVERLAY announced for this gate (MOTIR-6323): the page underneath drops its
  // band in the same reconcile, rather than offering *Review & approve* over a decided question
  // until the server render lands — the `DesignResultSection` rule. Read only by the page
  // (`handOver`): the overlay's own frame IS the announcer, and holds the decision itself.
  const announced = useDecidedGate(read.gate.id);
  const gate =
    decided && decided.id === read.gate.id
      ? decided
      : handOver && read.gate.state === 'awaiting' && announced
        ? announced.gate
        : read.gate;
  // ── THE AGENT REVIEW (MOTIR-6825; § 30) ─────────────────────────────────────────
  const isAgentReview = gate.kind === 'agent_review';
  // *Review again* was pressed here over the run then latest: until the re-read shows a NEWER
  // run, the reason it cleared is not drawn, and the frame reads *Reviewing* (Panel 4a's note).
  const [reviewRequestedOver, setReviewRequestedOver] = useState<string | null>(null);
  const reviewReason =
    isAgentReview &&
    gate.state === 'awaiting' &&
    !(reviewRequestedOver !== null && reviewRequestedOver === (agentReview?.run?.id ?? ''))
      ? (agentReview?.reviewUnavailableReason ?? null)
      : null;
  const [pressing, setPressing] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, PressOutcome>>(new Map());
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  // Members whose latest press was *Queue again* rather than *Retry merge* (MOTIR-5635) —
  // what words their progress line and a refusal's title.
  const [requeued, setRequeued] = useState<ReadonlySet<string>>(new Set());
  // THE ASK (MOTIR-6211; design panel 0): the refusal THIS reader just pressed here, by
  // gate id. Transient and never stored — a reload shows the record's door, never the ask.
  const [replanAsk, setReplanAsk] = useState<string | null>(null);
  // ⚠️ A ROW VERB ON THE RE-ASKED GATE TAKES THE FRAME'S CONFIRM (Story MOTIR-5799 ·
  // MOTIR-5806; § 28 panel 8a). The press IS a new approval, so it is asked for the same
  // way the frame's own Approve is — one band, one list of consequences, one pending and
  // one refusal — rather than acting the instant a row button is clicked. On the DECIDED
  // gate a row's *Retry merge* carries out a decision already made and still presses
  // straight through: there is nothing new to agree to.
  const [rowPress, setRowPress] = useState<{
    subjectVersion: string;
    pullRequestId: string;
    label: string;
    queueAgain: { failure: boolean } | null;
  } | null>(null);
  // THE DECISION DOORS — the overlay's alone (MOTIR-6323). Without both, nothing here decides.
  const decideActions =
    actions?.decide && actions.approveAndMerge
      ? { decide: actions.decide, approveAndMerge: actions.approveAndMerge }
      : null;

  const members = membersOf(read.mergeSubjectVersion ?? gate.subjectVersion);
  const count = members.length;
  const nameOf = (member: Pick<MemberVersion, 'repo' | 'number'>) =>
    `${member.repo} · #${member.number}`;
  const nameList = (names: string[]): string =>
    names.length < 2
      ? (names[0] ?? '')
      : t('list.pair', {
          a: names.slice(0, -1).join(t('list.separator')),
          b: names[names.length - 1]!,
        });

  async function retryMember(
    subjectVersion: string,
    pullRequestId: string,
    queueAgain: { failure: boolean } | null = null,
    /** The press came through the frame's confirm band, which reports the refusal itself
     *  (§ 28 panel 8a) — so the row is left as the reload reads it. */
    throughConfirm = false,
  ): Promise<GateRefusal | null> {
    if (!actions) return null;
    setRetrying((prev) => new Set(prev).add(subjectVersion));
    setRequeued((prev) => {
      const next = new Set(prev);
      if (queueAgain) next.add(subjectVersion);
      else next.delete(subjectVersion);
      return next;
    });
    // *Queue again* after a FAILURE returns the card to Approved through the decided gate's
    // own write (decision 5): the rail says so now, and a refusal takes it back. A neutral
    // removal never moved the card, so there is nothing to predict.
    if (queueAgain?.failure) applyOptimisticStatus('approved');
    try {
      const result = await actions.retryMember({
        approvalGateId: gate.id,
        pullRequestId,
        identifier: itemIdentifier,
        // On the RE-ASKED gate this press IS the approval (MOTIR-5802), so it carries the
        // stamp THIS read handed over — what is on screen, never refetched (MOTIR-5235).
        stamp: read.stamp ?? '',
      });
      if (queueAgain?.failure && !result.ok) clearOptimisticStatus();
      // ONLY THAT ROW: a retry reports one member, and the others keep what they showed.
      if (result.ok || !throughConfirm) {
        setOutcomes((prev) =>
          new Map(prev).set(
            subjectVersion,
            result.ok
              ? pressOutcomeOf(result.member)
              : { outcome: 'refused', refusal: result.refusal, pullRequestId },
          ),
        );
      }
      if (result.ok) router.refresh();
      return result.ok ? null : result.refusal;
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(subjectVersion);
        return next;
      });
    }
  }

  const factOf = (member: MemberVersion) =>
    read.members?.find((m) => m.subjectVersion === member.subjectVersion) ?? null;

  /**
   * What a row verb's press DOES. On the RE-ASKED gate it is a new approval, so it opens
   * the frame's confirm band and nothing happens until the reader proceeds (§ 28 panel
   * 8a); on the decided gate it carries out a decision already made and runs at once.
   */
  function pressRow(
    member: MemberVersion,
    pullRequestId: string,
    label: string,
    queueAgain: { failure: boolean } | null,
  ) {
    if (gate.state === 'awaiting') {
      setRowPress({ subjectVersion: member.subjectVersion, pullRequestId, label, queueAgain });
      return;
    }
    void retryMember(member.subjectVersion, pullRequestId, queueAgain);
  }

  // A row press on an AWAITING gate is an approval, so only a host holding the decision doors
  // offers it (MOTIR-6323); on a decided gate it carries out the decision already made.
  const rowPressable = read.canDecide && actions && (gate.state !== 'awaiting' || decideActions);

  function retryFor(member: MemberVersion, pullRequestId: string | null) {
    return {
      onRetry:
        rowPressable && pullRequestId
          ? () => pressRow(member, pullRequestId, t('outcome.retry'), null)
          : null,
      retrying: retrying.has(member.subjectVersion),
    };
  }

  function queueAgainFor(member: MemberVersion, fact: PullRequestApprovalMemberDTO) {
    const failure = fact.exit?.disposition === 'failure';
    return {
      onQueueAgain:
        rowPressable && fact.pullRequestId
          ? () => pressRow(member, fact.pullRequestId!, t('outcome.queueAgain'), { failure })
          : null,
      queueing: retrying.has(member.subjectVersion),
    };
  }

  // TOTAL over what a reload knows (MOTIR-5635): a new `PersistedRowOutcome` does not compile
  // until the frame draws it — with its verb, which the quick view's reading has not.
  const rowForState: Record<
    PersistedRowOutcome,
    (member: MemberVersion, fact: PullRequestApprovalMemberDTO) => RowMergeOutcome | null
  > = {
    queued: () => ({ kind: 'queued' }),
    leftQueue: (member, fact) => ({ kind: 'leftQueue', ...queueAgainFor(member, fact) }),
    removedFromQueue: (member, fact) => ({
      kind: 'removedFromQueue',
      ...queueAgainFor(member, fact),
    }),
    newCommits: () => ({ kind: 'newCommits' }),
    // MOTIR-5613: a retry is offered by the pull request under the card's own gate — there
    // is no second gate to press. The row's copy is MOTIR-5615's.
    notMergedYet: (member, fact) => ({
      kind: 'notMergedYet',
      ...retryFor(member, fact.pullRequestId),
    }),
    // THE HOST REFUSED (MOTIR-5833 · MOTIR-5834; § 28 panels 3 and 4). A setting somebody
    // can change offers *Retry merge*, which DECIDES the re-asked gate, and the record
    // band names the setting; a conflict offers nothing, because no approval can land
    // those commits.
    refusedSetting: (member, fact) => ({
      kind: 'refusedSetting',
      ...retryFor(member, fact.requeueable ? fact.pullRequestId : null),
    }),
    cannotLand: () => ({ kind: 'cannotLand' }),
    // § 31 panel 1 (MOTIR-6596): a queue FAILURE held at Implemented offers nothing either.
    failedHeld: () => ({ kind: 'failedHeld' }),
  };

  function outcomeFor(member: MemberVersion): RowMergeOutcome | null {
    if (pressing) return { kind: 'merging' };
    const pressed = outcomes.get(member.subjectVersion);
    // A refused *Queue again* leaves the row as the reload reads it — still out of the
    // queue, still offering the press (E7); the refusal is named in the alert band.
    const requeueRefused = pressed?.outcome === 'refused' && requeued.has(member.subjectVersion);
    if (pressed && !requeueRefused) {
      switch (pressed.outcome) {
        case 'merged':
          return { kind: 'merged' };
        case 'enqueued':
          return { kind: 'queued' };
        case 'refused':
          return { kind: 'refused', ...retryFor(member, pressed.pullRequestId) };
        case 'no_merge_gate':
          // Nothing was pressed for it, so there is nothing to report and the row is unchanged.
          return null;
      }
    }
    // ⚠️ AN UN-LANDED OUTCOME OUTLIVES THE APPROVAL THAT SPENT IT (MOTIR-5802): the
    // approval that authorized the action is gone the moment it did not land, and a
    // RE-ASKED gate stands in its place — so the row draws its reason under `awaiting`
    // exactly as it did under `approved`. Anything later (a push, a withdrawal) is a
    // different subject, and its facts are not about these commits.
    if (gate.state !== 'approved' && gate.state !== 'awaiting') return null;
    const fact = factOf(member);
    if (!fact) return null;
    // The same reading the quick view applies (`persistedRowOutcome`, Bug MOTIR-5650).
    const kind = persistedRowOutcome(fact);
    return kind ? rowForState[kind](member, fact) : null;
  }

  const rowOutcomes = new Map<string, RowMergeOutcome>();
  for (const member of members) {
    const outcome = outcomeFor(member);
    if (outcome) rowOutcomes.set(rowKey(member.repo, member.number), outcome);
  }
  const membersIn = (kind: RowMergeOutcome['kind']) =>
    members.filter((member) => rowOutcomes.get(rowKey(member.repo, member.number))?.kind === kind);

  async function onDecide(
    decision: GateDecision,
    _optionId?: string,
    noteMd?: string,
    refusalVerdict?: ApprovalGateRefusalVerdictDTO,
  ): Promise<GateRefusal | null> {
    if (!decideActions) return null;
    // *Continue without the review* (§12.3): the routed person APPROVES the agent review
    // with a required reason, through the one decide door, as the pressing person — in the
    // APPROVAL OVERLAY, the only host holding the door (MOTIR-6323; the item page hands the
    // press over). The door then raises the ordinary approve-and-merge gate for the same
    // version; the re-read brings it in, with this override as its record band (Panel 5).
    if (gate.kind === 'agent_review') {
      const result = await decideActions.decide({
        gateId: gate.id,
        decision,
        identifier: itemIdentifier,
        stamp: read.stamp ?? '',
        noteMd,
      });
      if (!result.ok) return result.refusal;
      setDecided(result.gate);
      announceGateDecided({ gate: result.gate, filesKept: null });
      router.refresh();
      return null;
    }
    if (decision === 'approve') {
      setPressing(true);
      let result: Awaited<ReturnType<typeof decideActions.approveAndMerge>>;
      try {
        // The stamp THIS read handed over — what is on screen, never refetched (MOTIR-5235).
        result = await decideActions.approveAndMerge({
          gateId: gate.id,
          identifier: itemIdentifier,
          stamp: read.stamp ?? '',
        });
      } finally {
        setPressing(false);
      }
      // A refusal of the APPROVAL applies nothing: no merge was attempted.
      if (!result.ok) return result.refusal;
      setDecided(result.gate);
      setOutcomes(new Map(result.members.map((m) => [m.subjectVersion, pressOutcomeOf(m)])));
      // The rail, in the browser, from the status the decision RECORDED writing (MOTIR-5212).
      applyOptimisticStatus(result.gate.outcomeRef);
      // ⚠️ AND EVERY OTHER SURFACE WATCHING THIS GATE (MOTIR-5570, MOTIR-5440). Pressed
      // from the approval OVERLAY, the To-approve row underneath is a client island this
      // component cannot reach and `router.refresh()` does not re-seed — so the row settles
      // in the SAME reconcile only because the decision is announced. `filesKept` is the
      // design kind's field and is null here: this gate keeps no files.
      announceGateDecided({ gate: result.gate, filesKept: null });
      router.refresh();
      return null;
    }
    const result = await decideActions.decide({
      gateId: gate.id,
      decision,
      identifier: itemIdentifier,
      stamp: read.stamp ?? '',
      // The refusal's REQUIRED reason (ADR §10a). This path is only ever a refusal —
      // an approval goes through `approveAndMerge` above — so the note always travels.
      noteMd,
      // …and a design's REQUIRED verdict (MOTIR-6427) — only the design band draws one.
      ...(refusalVerdict ? { refusalVerdict } : {}),
    });
    if (!result.ok) return result.refusal;
    setDecided(result.gate);
    // ⚠️ AN ACCEPTANCE SENT BACK WRITES NO STATUS (MOTIR-6506; `acceptance-refusal-verdict.md`
    // §2), so the rail is never repainted for one — whatever the row's `outcomeRef` holds.
    if (gate.kind !== 'acceptance_result') applyOptimisticStatus(result.gate.outcomeRef);
    announceGateDecided({ gate: result.gate, filesKept: null });
    // A DECISION sent back offers the seeded planner (§10h) — it ASKS first, in the band
    // the record now draws. Commits sent back (`pull_request_approval`) offer nothing yet.
    // An ACCEPTANCE asks after a Re-plan (never after a Re-run, which `motir fix` serves).
    // `router.refresh()` below re-reads the page: the withdrawn merge band and the repair
    // part are the server's (the overlay host re-reads its own rows).
    if (asksAfterPress(result.gate)) setReplanAsk(result.gate.id);
    router.refresh();
    return null;
  }

  // ── Band 1 ────────────────────────────────────────────────────────────────────
  const moved = members.filter((member) => {
    const head = currentHeads.find(
      (h) => rowKey(h.repo, h.number) === rowKey(member.repo, member.number),
    );
    return head !== undefined && head.headSha !== member.headSha;
  });
  const decidedByThisReader = decided !== null && decided.id === read.gate.id;
  // STATE `G` OF THE MERGE GATE (Bug MOTIR-5884; § 29): band 1's meta, the sentence and the
  // cite all follow `supersededCause`, and `member_closed` is read off the ROWS as merged or
  // closed. Only the merge kind — a decision gate's withdrawal is §27's and is not redrawn.
  const withdrawnMerge =
    gate.state === 'superseded' && gate.kind === 'pull_request_approval'
      ? withdrawnMergeCopy({
          cause: gate.supersededCause,
          members: members.map((member) => {
            const row = rowStates.find(
              (candidate) =>
                rowKey(candidate.repo, candidate.number) === rowKey(member.repo, member.number),
            );
            return {
              name: nameOf(member),
              state: row?.state ?? null,
              // What names the member in a `conflict` withdrawal (MOTIR-5916): read off
              // the ROW, the same stored reading its *Conflicts with* pill draws.
              conflicted: row?.conflicted ?? false,
              baseRef: row?.baseRef ?? null,
              leftQueue: row?.leftQueue ?? false,
            };
          }),
          moved: moved.map(nameOf),
          terminal,
          itemIdentifier,
          host: t('host'),
          nameList,
        })
      : null;
  const say = (message: WithdrawnMessage): string =>
    message.scope === 'pra' ? t(message.key, message.values) : tGate(message.key, message.values);
  // THE RE-ASKED GATE (Story MOTIR-5799 · MOTIR-5806; § 4 FOURTH AMENDMENT, point 4): a
  // question still awaiting, standing over commits an earlier press did not land. The
  // member facts are what say so — an exit nobody put back, or a refusal the host gave —
  // and three bands read differently for it: the meta, the record band and the
  // consequence line.
  // ⚠️ THE MERGE GATE'S OWN KIND IS PART OF THE TEST (MOTIR-5787's acceptance primary
  // made this reachable): a design, decision or acceptance gate awaiting over a card
  // whose members carry a standing exit is NOT a re-asked merge question — the primary
  // LEADS the frame, and the merge rides on it. Without the kind check this frame would
  // answer a receipt's question with the merge queue's words.
  const reasked =
    gate.kind === 'pull_request_approval' &&
    gate.state === 'awaiting' &&
    (read.members ?? []).some((fact) => fact.exit !== null || fact.refusal !== null);
  const subjectMeta =
    count === 0
      ? runLabel
      : // ⚠️ A RE-ASKED GATE SAYS SO IN BAND 1 (MOTIR-5806; § 28 panel 1). *Delivered by
        // run N* is true of a first ask and misleading of this one: nothing was delivered
        // just now — a press did not land, and the question came back.
        reasked
        ? t('reasked.meta', { count })
        : withdrawnMerge
          ? say(withdrawnMerge.meta)
          : gate.state === 'superseded'
            ? moved.length > 0
              ? t('meta.withdrawn', { count, pr: nameList(moved.map(nameOf)) })
              : t('meta.withdrawnSet', { count })
            : gate.state === 'approved'
              ? decidedByThisReader
                ? t('meta.approvedByYou', { count })
                : gate.decidedByLabel
                  ? // The same fact, said where it happened (MOTIR-5599; design § 23).
                    gate.decisionSource === 'github'
                    ? t('github.meta.approved', { name: gate.decidedByLabel, count })
                    : t('meta.approved', { name: gate.decidedByLabel, count })
                  : t('meta.count', { count })
              : gate.state === 'awaiting' && runLabel
                ? t('meta.delivered', { count, run: runLabel })
                : t('meta.count', { count });

  // ── THE DECISION PORT (MOTIR-5678; design §27) ──────────────────────────────────
  // A decision gate LEADS the frame the way a design gate does, and every band says so in
  // its own words: band 1 names the document, band 3 what accepting it merges — or, when
  // there is no one document to accept, why Approve is disabled.
  const isDecision = gate.kind === 'decision_approval';
  const decisionDoc = decision?.document ?? null;
  const decisionPrs = decision?.openPullRequests ?? [];
  const decisionShown = decisionDocumentShown(decisionDoc);
  const b = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;
  const monoSpan = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;
  function decisionMeta(): string {
    const prCount = decisionPrs.length;
    const withRun = <K extends string>(key: K) => (runLabel ? key : (`${key}NoRun` as const));
    // A PAGE subject (MOTIR-7436, delta 1): the frame says there is no pull request in its
    // first line.
    if (decisionDoc?.outcome === 'page') {
      const number = decisionDoc.versionNumber;
      if (gate.state === 'superseded') return tDecision('headMeta.pageWithdrawn', { number });
      return runLabel
        ? tDecision('headMeta.page', { number, run: runLabel })
        : tDecision('headMeta.pageNoRun', { number });
    }
    if (gate.state === 'superseded') {
      const asked = parseDecisionVersion(gate.subjectVersion);
      return asked
        ? tDecision('headMeta.withdrawn', { path: asked.path, blob: asked.blob.slice(0, 7) })
        : t('meta.withdrawnSet', { count: prCount });
    }
    const run = runLabel ?? '';
    if (
      decisionDoc?.outcome === 'resolved' ||
      (decisionDoc?.outcome === 'unresolvable' && decisionDoc.path)
    ) {
      const path = decisionDoc.outcome === 'resolved' ? decisionDoc.path : decisionDoc.path!;
      return tDecision(`headMeta.${withRun('one')}`, { path, count: prCount, run });
    }
    if (decisionDoc?.outcome === 'unresolvable' && decisionDoc.reason === 'none') {
      return tDecision(`headMeta.${withRun('none')}`, { count: prCount, run });
    }
    if (decisionDoc?.outcome === 'unresolvable' && decisionDoc.reason === 'several') {
      return tDecision(`headMeta.${withRun('several')}`, {
        docs: decisionDoc.paths.length,
        count: prCount,
        run,
      });
    }
    return runLabel
      ? t('meta.delivered', { count: prCount, run: runLabel })
      : t('meta.count', { count: prCount });
  }

  // ⚠️ A STORY RUN'S ACCEPTANCE LEADS WITH ITS OWN WORDS (Story MOTIR-4949 · Subtask
  // MOTIR-5790; `acceptance-panel--approve-and-merge.mock.html` panel A). The press accepts
  // the story AND merges its code, and the sentence says in words that the video is NOT
  // merged — it is an uploaded receipt, never a file in any of these pull requests.
  const acceptanceLeads = gate.kind === 'acceptance_result';

  // ── THE AGENT REVIEW'S BANDS AND VERBS (MOTIR-6825; § 30) ───────────────────────
  /** *Review again* (§12.6): ONE new review run for the same gate and version. */
  async function pressReviewAgain(): Promise<GateRefusal | null> {
    const result = await reviewAgain(gate.id);
    if (!result.ok) return result.refusal;
    setReviewRequestedOver(agentReview?.run?.id ?? '');
    // The block is SERVER-rendered: the re-read brings the new run (case 2).
    router.refresh();
    return null;
  }
  // *Continue without the review* is a DECISION, and every decision a person makes is made
  // in the APPROVAL OVERLAY (MOTIR-5229, MOTIR-6323). On the item page the button HANDS OVER
  // to it — the overlay opened on this card's `agent_review` gate, the address the frame's
  // other hand-overs write (`lib/approvals/overlayAddress.ts`) — and nothing here decides.
  // `shallowPush`, never `router.push`: the page is already on screen and the overlay reads
  // its address client-side.
  async function openOverrideInOverlay(): Promise<GateRefusal | null> {
    const { pathname, search } = window.location;
    shallowPush(
      withApprovalOverlay(`${pathname}${search}`, {
        itemKey: itemIdentifier,
        kind: 'agent_review',
      }),
    );
    return null;
  }
  const continueWithoutLabel = tReview('verb.continueWithout');
  // Panel 4a: *Continue without the review* (secondary) then *Review again* (primary), only
  // while the review could not run; Reviewing and Sent back draw no verbs at all.
  // - IN THE OVERLAY (the decide doors are held): exactly ONE verb — the approve, with the
  //   frame's note-required confirm (MOTIR-5960) and the line that it is recorded under the
  //   presser's name. A person has no refusal verb on this kind (§12.3), and *Review again*
  //   is the card's, not a decision.
  // - ON THE ITEM PAGE (`handOver`): *Continue without the review* opens the overlay, and
  //   *Review again* is the start card's route (§12.6) — a new run, not a gate decision.
  const reviewVerbs: GateVerb[] =
    isAgentReview && reviewReason !== null
      ? decideActions
        ? [
            {
              id: 'continue-without-review',
              decision: 'approve',
              label: continueWithoutLabel,
              variant: 'primary',
              confirms: true,
              disabled: verbsDisabled,
              note: {
                label: tReview('override.label'),
                helper: tReview('override.helper'),
                required: tReview('override.required'),
              },
              confirm: {
                title: tReview('override.title'),
                consequences: [tReview('override.records'), tReview('override.asks')],
                proceedLabel: tReview('override.proceed'),
              },
            },
          ]
        : handOver
          ? [
              {
                id: 'continue-without-review',
                decision: 'approve',
                label: continueWithoutLabel,
                variant: 'secondary',
                confirms: false,
                perform: openOverrideInOverlay,
              },
              {
                id: 'review-again',
                decision: 'approve',
                label: tReview('verb.reviewAgain'),
                variant: 'primary',
                confirms: false,
                perform: pressReviewAgain,
              },
            ]
          : []
      : [];
  const reviewCount = count;
  // THE BAND ABOVE THE PORT: the agent review's own state when it leads, or — on the
  // approve-and-merge gate it handed its version to — the pass or the override (Panels 2, 5).
  const reviewBehindMerge =
    !isAgentReview &&
    gate.kind === 'pull_request_approval' &&
    gate.state !== 'superseded' &&
    agentReview?.gate.state === 'approved' &&
    agentReview.gate.subjectVersion !== null &&
    agentReview.gate.subjectVersion === gate.subjectVersion
      ? agentReview
      : null;
  const reviewBand: ReactNode = isAgentReview ? (
    gate.state === 'awaiting' ? (
      reviewReason !== null ? (
        <CouldNotRunBand reason={reviewReason} run={agentReview?.run ?? null} />
      ) : (
        <ReviewingBand
          // A press of *Review again* here has not seen its run yet: no stale link.
          run={reviewRequestedOver !== null ? null : (agentReview?.run ?? null)}
          count={reviewCount}
        />
      )
    ) : gate.state === 'changes_requested' ? (
      <SentBackBand
        findingsMd={gate.noteMd}
        // The frame's gate IS the latest agent review here, so its findings' links are
        // the view's (MOTIR-10023).
        findingsRefs={agentReview?.findingsRefs ?? {}}
        run={agentReview?.run ?? null}
        decidedAt={gate.decidedAt}
        count={reviewCount}
      />
    ) : gate.state === 'approved' && gate.decidedUnderAuthority !== 'review_agent' ? (
      // The override, as the overlay draws it right after the press (Panel 5): a person
      // continued without the review — never *Passed*.
      <OverrideBand
        name={gate.decidedByLabel}
        decidedAt={gate.decidedAt}
        noteMd={gate.noteMd}
        count={reviewCount}
      />
    ) : null
  ) : reviewBehindMerge ? (
    reviewBehindMerge.gate.decidedUnderAuthority === 'review_agent' ? (
      <PassedBand
        findingsMd={reviewBehindMerge.gate.noteMd}
        findingsRefs={reviewBehindMerge.findingsRefs}
        run={reviewBehindMerge.run}
        decidedAt={reviewBehindMerge.gate.decidedAt}
        count={membersOf(reviewBehindMerge.gate.subjectVersion).length}
      />
    ) : (
      <OverrideBand
        name={reviewBehindMerge.gate.decidedByLabel}
        decidedAt={reviewBehindMerge.gate.decidedAt}
        noteMd={reviewBehindMerge.gate.noteMd}
        count={membersOf(reviewBehindMerge.gate.subjectVersion).length}
      />
    )
  ) : null;
  // Band 1's pill in the review's own words while it awaits (Panels 1 and 4a). A reader the
  // could-not-run question is not routed to sees the shipped neutral *Awaiting* (Panel 4d).
  const reviewStateOverride: { label: ReactNode; pill: PillProps } | null =
    isAgentReview && gate.state === 'awaiting'
      ? reviewReason === null
        ? {
            label: (
              <>
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                {tReview('state.reviewing')}
              </>
            ),
            pill: { severity: 'info' },
          }
        : read.canDecide
          ? { label: tReview('state.couldNotRun'), pill: { severity: 'warning' } }
          : null
      : null;

  // ── Band 3 ────────────────────────────────────────────────────────────────────
  const verbs: GateVerb[] = isAgentReview
    ? reviewVerbs
    : decideActions
      ? [
          // Sending the work back moves nothing, and now CONFIRMS: the confirm band is where
          // the REQUIRED reason is written (ADR §10a) — the press asks why, not "are you sure".
          // A DESIGN that leads the frame is sent back WITH A VERDICT (MOTIR-6427) — the
          // design band, not the commits' one: the door requires it on a design refusal.
          // An ACCEPTANCE that leads it asks by RUN SHAPE (MOTIR-6506): the Re-run / Re-plan
          // pair when the gate offers a verdict — read off the DTO, never re-derived — and
          // never the borrowed `commits` lines (design choice 2).
          refusalVerb(
            isDecision
              ? 'decision'
              : gate.kind === 'design_result'
                ? 'design'
                : acceptanceLeads
                  ? 'acceptance'
                  : 'commits',
            itemIdentifier,
            { disabled: verbsDisabled },
            designRefusal,
            acceptanceLeads
              ? { offersVerdict: gate.offersRefusalVerdict, pullRequestCount: Math.max(count, 1) }
              : undefined,
          ),
          {
            decision: 'approve',
            // A PAGE subject merges nothing (MOTIR-7436, delta 1): its verb is Approve.
            label:
              isDecision && decisionDoc?.outcome === 'page'
                ? tGate('verb.approve')
                : t('verb.approveAndMerge'),
            variant: 'primary',
            // Merging is not reversible from here, which is what the confirm step says aloud.
            confirms: true,
            // A decision with no one document on screen cannot be accepted (§27 Panels 3a–3d):
            // Approve stays drawn and disabled, with the reason as band 3's line.
            disabled: verbsDisabled || (isDecision && !decisionShown),
          },
        ]
      : [];
  // The members this re-asked question is actually about, and whether a SETTING is what is
  // in the way — which changes what approving promises (a merge, not a queue).
  const unlandedNames = [
    ...membersIn('leftQueue'),
    ...membersIn('removedFromQueue'),
    ...membersIn('refusedSetting'),
  ].map(nameOf);
  const settingHeld = membersIn('refusedSetting').length > 0;
  // One or two pull requests are NAMED; three or more are COUNTED, because band 3 is one line
  // and an unbounded list pushes the verbs off the frame. The confirm step names every one.
  const prsNamed = nameList(members.map(nameOf));
  const consequence = isAgentReview
    ? gate.state === 'awaiting'
      ? tReview(reviewReason !== null ? 'couldNotRun.why' : 'reviewing.why')
      : null
    : isDecision
      ? decideActions
        ? decisionShown
          ? decisionDoc?.outcome === 'page'
            ? tDecision.rich('consequencePage', {
                number: decisionDoc.versionNumber,
                key: itemIdentifier,
                b,
              })
            : decisionPrs.length > 0
              ? tDecision.rich('consequence', {
                  prs: nameList(decisionPrs),
                  key: itemIdentifier,
                  b,
                })
              : tDecision.rich('consequenceNoPrs', { key: itemIdentifier, b })
          : tDecision('blocked')
        : null
      : // ⚠️ THE RE-ASKED GATE PROMISES SOMETHING NARROWER (§ 28 panel 1's `af-why`): the
        // members that did not land go back where they came from — a merge queue, or the
        // host once a setting allows it — rather than the whole set being sent for the first
        // time. The general line is still right for every other awaiting gate.
        decideActions && reasked && unlandedNames.length > 0
        ? t(settingHeld ? 'reasked.whySetting' : 'reasked.why', {
            pr: nameList(unlandedNames),
            key: itemIdentifier,
          })
        : decideActions && count > 0
          ? acceptanceLeads
            ? tAcceptance('consequenceMerges', { key: itemIdentifier, prs: prsNamed })
            : count <= 2
              ? t('consequence.named', { prs: prsNamed, key: itemIdentifier })
              : t('consequence.counted', { count, key: itemIdentifier })
          : null;
  const rowPressMember = rowPress
    ? (members.find((member) => member.subjectVersion === rowPress.subjectVersion) ?? null)
    : null;
  const confirmConsequences =
    isDecision && decisionDoc?.outcome === 'page'
      ? [
          tDecision('confirm.records'),
          tDecision('confirm.freezesPage', { number: decisionDoc.versionNumber }),
          tDecision('confirm.movesDone', { key: itemIdentifier }),
        ]
      : isDecision
        ? [
            tDecision('confirm.records'),
            ...decisionPrs.map((pr) => t('confirm.mergeOrQueue', { pr })),
            tDecision('confirm.moves', { key: itemIdentifier }),
          ]
        : // ⚠️ A ROW PRESS AGREES TO ITS OWN TWO THINGS (§ 28 panel 8a). The set's list would
          // name pull requests this press does not touch, and — the point of the whole
          // amendment — it must say ALOUD that this is a NEW approval, not the spent one.
          rowPress && rowPressMember
          ? [
              t('reasked.confirm.newApproval', { count }),
              rowPress.queueAgain
                ? t('reasked.confirm.requeue', { pr: nameOf(rowPressMember) })
                : t('reasked.confirm.merge', { pr: nameOf(rowPressMember) }),
              t('confirm.movesToApproved', { key: itemIdentifier }),
            ]
          : decideActions
            ? acceptanceLeads
              ? [
                  tAcceptance('confirm.records'),
                  tAcceptance('confirm.freezes'),
                  tAcceptance('confirm.merges', { prs: prsNamed }),
                ]
              : [
                  t('confirm.records', { count }),
                  ...members.map((member) => t('confirm.mergeOrQueue', { pr: nameOf(member) })),
                  t('confirm.movesToApproved', { key: itemIdentifier }),
                ]
            : [];

  /** The row verb, as a frame verb: the band opens for it, and proceeding runs its act. */
  const requestedVerb: GateVerb | null =
    rowPress && rowPressMember
      ? {
          decision: 'approve',
          label: rowPress.label,
          variant: 'primary',
          confirms: true,
          perform: () =>
            retryMember(rowPress.subjectVersion, rowPress.pullRequestId, rowPress.queueAgain, true),
        }
      : null;

  // State `H` for a MEMBER: the approval stands, and the refusal is named in place.
  const refused = members.flatMap((member) => {
    const pressed = outcomes.get(member.subjectVersion);
    return !pressing && pressed?.outcome === 'refused'
      ? [{ member, refusal: pressed.refusal, requeue: requeued.has(member.subjectVersion) }]
      : [];
  });
  const mergedNames = membersIn('merged').map(nameOf);
  const alert =
    refused.length > 0 ? (
      <div
        role="alert"
        className="flex gap-2.5 border-t border-(--el-border-soft) bg-(--el-tint-peach) px-4 py-3"
      >
        <AlertTriangle
          className="mt-0.5 h-4 w-4 flex-none text-(--el-danger-on-surface)"
          aria-hidden
        />
        <p className="text-[13px] leading-snug text-(--el-text-strong)">
          {refused.map(({ member, refusal, requeue }) => (
            <RefusedMemberLine
              key={member.subjectVersion}
              name={nameOf(member)}
              refusal={refusal}
              requeue={requeue}
            />
          ))}
          {/* ⚠️ *YOUR APPROVAL STANDS* IS GONE, AND ITS ABSENCE IS THE POINT (MOTIR-5834;
              §4 FOURTH AMENDMENT, point 1). A press that did not land SPENT the approval,
              whatever the reason class, so the only true thing left to say here is what
              DID merge — and when nothing did, nothing. Each member's own line already
              says what to do next. */}
          {mergedNames.length > 0 ? (
            <span className="block text-(--el-text-secondary)">
              {t('refused.stands', { other: nameList(mergedNames) })}
            </span>
          ) : null}
        </p>
      </div>
    ) : null;

  // The decided record's own facts: how many commits the approval covered, and the ONE thing
  // the merges are still waiting on — a member with no merge yet, a queue, or the host.
  const notYet = membersIn('notMergedYet');
  const queued = membersIn('queued');
  const why =
    notYet.length > 0
      ? t('notMergedYet.why', { pr: nameList(notYet.map(nameOf)), host: t('host') })
      : queued.length > 0
        ? t('queued.why', { key: itemIdentifier, pr: nameList(queued.map(nameOf)) })
        : count > 0 && membersIn('merged').length === count
          ? t('merged.why', { key: itemIdentifier, host: t('host') })
          : null;
  // THE EXITS (MOTIR-5635; § 22): every member the queue removed and nobody has put back,
  // in words, with its failing check — or, while its *Queue again* is in flight, what is
  // happening instead (E2).
  const bold = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;
  /**
   * THE SENTENCE UNDER AN UN-LANDED OUTCOME, by class and by where the gate stands
   * (MOTIR-5806; § 28 panels 1–4).
   *
   * ⚠️ ON THE RE-ASKED GATE IT SAYS THE APPROVAL WAS SPENT. That is the whole of what
   * changed for a reader: the pill and the verb look much as they did, and only this line
   * says the press ahead of them is a NEW approval rather than the old one still working.
   */
  function unlandedSub(kind: RowMergeOutcome['kind'], neutral: boolean, hung = false): ReactNode {
    if (kind === 'newCommits') return t('exit.newCommits');
    if (kind === 'cannotLand') return t.rich('exit.cannotLand', { b: bold });
    if (kind === 'failedHeld') return t.rich('exit.failed.held', { key: itemIdentifier, b: bold });
    if (kind === 'refusedSetting') return t.rich('setting.reasked', { b: bold });
    if (!reasked) return t.rich('exit.unchanged', { b: bold });
    // A check that HUNG gets its own first clause (design § 32): the approval is spent
    // because the check stopped, not because anything failed.
    if (hung) return t.rich('exit.hung.reasked', { b: bold });
    return t.rich(neutral ? 'exit.neutral.reasked' : 'exit.reasked.failure', { b: bold });
  }
  const exitParts = members.flatMap((member) => {
    const kind = rowOutcomes.get(rowKey(member.repo, member.number))?.kind;
    // ⚠️ `cannotLand` AND `refusedSetting` ARE IN THE LIST (MOTIR-5806; § 28 panels 3 and
    // 4). The first offers no verb at all, which is exactly why the band still has to SAY
    // WHY; the second's verb cannot explain which setting is in the way.
    if (
      kind !== 'leftQueue' &&
      kind !== 'removedFromQueue' &&
      kind !== 'newCommits' &&
      kind !== 'cannotLand' &&
      kind !== 'failedHeld' &&
      kind !== 'refusedSetting'
    ) {
      return [];
    }
    const fact = factOf(member);
    // A HOST REFUSAL HAS NO EXIT ROW (MOTIR-5833): the queue never saw these commits, so
    // the line is the refusal's own, and the failing check it has no notion of is absent.
    if (fact && !fact.exit && fact.refusal) {
      if (retrying.has(member.subjectVersion)) {
        return [
          <span key={member.subjectVersion} className="inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t('requeue.progress', { pr: nameOf(member) })}
          </span>,
        ];
      }
      return [
        <span
          key={member.subjectVersion}
          className="flex w-full min-w-0 basis-full flex-col gap-1"
          data-merge-refusal
        >
          <span className="flex items-start gap-2 leading-snug">
            <CircleX
              className="mt-0.5 h-3.5 w-3.5 flex-none text-(--el-danger-on-surface)"
              aria-hidden
            />
            <span>
              {fact.refusal.permission
                ? t.rich('setting.linePermission', {
                    pr: nameOf(member),
                    permission: fact.refusal.permission,
                    b: bold,
                  })
                : t.rich(kind === 'cannotLand' ? 'cannotLand.line' : 'setting.line', {
                    pr: nameOf(member),
                    b: bold,
                  })}
            </span>
          </span>
          {/* The HOST's own words (Bug MOTIR-6735): the line above can only say that a
              setting refused the merge, and this is what names which one. */}
          {fact.refusal.reason ? (
            <span
              className="ml-5.5 break-words text-(--el-text-secondary)"
              data-merge-refusal-reason
            >
              {t('setting.hostReason', { reason: fact.refusal.reason })}
            </span>
          ) : null}
          <span className="ml-5.5 text-(--el-text-secondary)">{unlandedSub(kind, false)}</span>
        </span>,
      ];
    }
    if (!fact?.exit) return [];
    if (kind !== 'newCommits' && retrying.has(member.subjectVersion)) {
      return [
        <span key={member.subjectVersion} className="inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {t('requeue.progress', { pr: nameOf(member) })}
        </span>,
      ];
    }
    return [
      <QueueExitLine
        key={member.subjectVersion}
        name={nameOf(member)}
        exit={fact.exit}
        held={kind === 'failedHeld'}
        sub={unlandedSub(
          kind,
          fact.exit.disposition !== 'failure',
          hungCheckSentenceKey(fact.exit) !== null,
        )}
      />,
    ];
  });
  // ⚠️ THE RE-ASKED GATE CARRIES A RECORD BAND, which no other awaiting gate does
  // (§ 28 panel 1). It is the one question with history behind it: the reader is being
  // asked again because a press of theirs did not land, and the reason has to be on screen
  // WHILE they decide rather than only after.
  // ⚠️ ITS FIRST LINE NAMES THE APPROVAL THAT WAS SPENT (Bug MOTIR-5863; panel 1's first
  // span) — the provenance that makes *that approval is spent* a statement about something
  // on screen. It comes from the read, never from `gate`: the re-asked gate is a fresh row
  // whose decider and decision time are null by construction.
  const earlier = reasked ? (read.earlierApproval ?? null) : null;
  const earlierLine = earlier ? (
    <span className="w-full basis-full" data-earlier-approval>
      {t.rich('reasked.earlier', {
        // An unattributable decider is SAID, never shown as nobody (§6b).
        name: earlier.decidedByLabel ?? tGate('record.unattributed'),
        date: new Date(earlier.decidedAt).toLocaleString(locale),
        count: earlier.commits,
        b: bold,
      })}
    </span>
  ) : null;
  const awaitingRecord =
    reasked && exitParts.length > 0 ? (
      <>
        {earlierLine}
        {exitParts}
      </>
    ) : null;
  const decisionAccepted = isDecision && gate.state === 'approved';
  // Request changes on a decision: the record's door back to the seeded planner, or the
  // ask in its place for the reader who just pressed it (MOTIR-6211).
  const { door: replanDoor, ask: replanAskBand } = useRefusalReplanSlots({
    gate,
    // A design's Re-plan opens on its PARENT (§10h; MOTIR-6427) — the key the ask names.
    itemKey:
      gate.kind === 'design_result' ? (designRefusal?.replanKey ?? itemIdentifier) : itemIdentifier,
    replan: {
      canReplan,
      asking: replanAsk === gate.id,
      onAskDone: () => setReplanAsk(null),
    },
    sectioned: false,
  });
  const acceptedBlob = decisionAccepted ? parseDecisionVersion(gate.subjectVersion)?.blob : null;
  const acceptedPage = decisionAccepted && decisionDoc?.outcome === 'page' ? decisionDoc : null;
  const recordDetail = acceptedPage ? (
    // Delta 3: approved over a PAGE — the version FROZEN, the card Done. Terminal: no pull
    // request will ever merge, so there is no foot and no verb.
    <>
      <span className="inline-flex items-center gap-1.5">
        <Snowflake className="h-3.5 w-3.5 flex-none text-(--el-text-strong)" aria-hidden />
        <span className="font-semibold text-(--el-text)">
          {tDecision('page.approvedVersion', { number: acceptedPage.versionNumber })}
        </span>
      </span>
      <span>
        {tDecision.rich('page.approvedTail', {
          key: itemIdentifier,
          number: acceptedPage.versionNumber,
          b,
        })}
      </span>
    </>
  ) : decisionAccepted ? (
    // Panels 4 and 6a: the accepted BLOB named, then — while a pull request is still open —
    // that it merges on its own once its checks pass. No verb: a second press would ask a
    // question whose answer is already on the record.
    <>
      {acceptedBlob ? (
        <span>
          {tDecision.rich('acceptedBlob', { blob: acceptedBlob.slice(0, 7), mono: monoSpan })}
        </span>
      ) : null}
      {decisionPrs.length > 0 ? <span>{tDecision('mergeHeld')}</span> : null}
      {why ? <span>{why}</span> : null}
    </>
  ) : gate.state === 'approved' && count > 0 ? (
    <>
      <span>{t('record.commits', { count })}</span>
      {why ? <span>{why}</span> : null}
      {exitParts}
    </>
  ) : (
    replanDoor
  );

  // ⚠️ THE KIND LABEL FOLLOWS THE GATE, not the block (Story MOTIR-5652 · Subtask MOTIR-5667;
  // `design-result.md` AMENDMENT 6 Q1). A design card with commits holds TWO gates and the
  // DESIGN one leads: the frame is its port, with the pull requests beneath it as what
  // approving will merge. Band 1 saying *Pull requests* over a design subject is the near
  // miss this level is about — a question that IS there, wearing the words of a different
  // one, which a reviewer would answer anyway.
  const kindLabel = isAgentReview
    ? tReview('kindLabel')
    : gate.kind === 'design_result'
      ? tDesign('kindLabel')
      : isDecision
        ? tDecision('kindLabel')
        : acceptanceLeads
          ? tAcceptance('kindLabel')
          : t('kindLabel');

  // ⚠️ THE ITEM PAGE HANDS THE DECISION OVER (Bug MOTIR-6323). The section card is the
  // container and *Development* its only label, so the block renders as it does with no gate
  // and the band closes it — no frame, no port, no verb. The band names the question's own
  // kind where it is not the pull requests' (a design, decision or acceptance leading them),
  // and it opens the overlay on that kind, which is the gate the one press answers.
  // ⚠️ NEVER AN AGENT REVIEW (§12.1): it is not on To approve, and its states — Reviewing,
  // Could not run, Sent back — are the card's to show, so the page draws its frame where the
  // card is. Its one decision still hands over: *Continue without the review* opens the
  // overlay on the `agent_review` gate (`openOverrideInOverlay`), which decides it.
  if (handOver && gate.state === 'awaiting' && read.canDecide && !isAgentReview) {
    const meta = isDecision ? decisionMeta() : (subjectMeta ?? t('meta.count', { count }));
    return (
      // The rows keep what a reload knows about each member — *Left the queue*, *Queued to
      // merge* — with no press: on an awaiting gate a row verb is an approval (`rowPressable`).
      <MergeOutcomeProvider value={rowOutcomes}>
        {/* The pass or the override this question follows (Panels 2 and 5), above the rows —
            flush to the section card, which is the one container (§ 20: no card in a card). */}
        {reviewBand ? (
          <div className="-mx-(--spacing-card-padding) mb-4 border-t border-(--el-border-soft)">
            {reviewBand}
          </div>
        ) : null}
        {children}
        <div className="mt-4">
          <GateCallToActionBand
            kind={gate.kind}
            subjectLabel={gate.kind === 'pull_request_approval' ? meta : `${kindLabel} · ${meta}`}
            askedAt={gate.createdAt}
            itemIdentifier={itemIdentifier}
            routedElsewhereName={handOver.routedToViewer ? null : read.routedToLabel}
            body={t(
              gate.kind === 'design_result'
                ? 'cta.bodyDesign'
                : isDecision
                  ? decisionDoc?.outcome === 'page'
                    ? 'cta.bodyDecisionPage'
                    : 'cta.bodyDecision'
                  : gate.kind === 'acceptance_result'
                    ? 'cta.bodyAcceptance'
                    : 'cta.body',
            )}
          />
        </div>
      </MergeOutcomeProvider>
    );
  }

  // The item page's frame steps out of its card's padding so the bands meet the
  // card's edges; the overlay HAS no card — the dialog is the container — so it
  // takes no wrapper at all (§ 24, *FILL, not FLUSH*).
  const inBox = (frame: ReactNode) =>
    layout === 'fill' ? (
      frame
    ) : (
      <div className="-mx-(--spacing-card-padding) -mb-(--spacing-card-padding) overflow-hidden rounded-b-(--radius-card) border-t border-(--el-border-soft)">
        {frame}
      </div>
    );

  return (
    <MergeOutcomeProvider value={rowOutcomes}>
      {inBox(
        <ApprovalGateControl
          // A fresh read is a fresh frame: the stale refusal clears and the verbs return.
          key={`${read.gate.id}:${read.stamp ?? ''}:${gateKey}`}
          layout={layout}
          // ⚠️ THE VERSION IS NOT HANDED TO THE RECORD STRIP. The frame prints the first eight
          // characters of `subjectVersion`, which names a design's commit — and would print
          // `moooon/m` for a set. The set is named in band 1 and counted in `recordDetail`;
          // the audit column itself is untouched.
          // ⚠️ AN AGENT REVIEW'S NOTE IS ITS FINDINGS, drawn in full in the review band — never
          // quoted a second time in the record strip (MOTIR-6825).
          gate={{ ...gate, subjectVersion: null, ...(isAgentReview ? { noteMd: null } : {}) }}
          canDecide={read.canDecide}
          // What a refusal names — § 30 Panels 5a / 5b say which card did not move, and on
          // which host the conflict was reported (MOTIR-5916).
          refusalContext={{ itemIdentifier, host: t('host') }}
          // Band 3 is deliberately UNCHANGED whatever the kind label says: the verb and the
          // consequence are the shipped approve-and-merge wording, because one press is
          // what merges the set (MOTIR-5664), and a second visual language for the same act
          // would be the duplication this level exists to remove.
          kindLabel={kindLabel}
          subjectMeta={isDecision ? decisionMeta() : subjectMeta}
          // `data-port` lifts the block's code surfaces to `--el-card` on the port's
          // `--el-surface` (§20 Decisions: the same fill would leave only the edge).
          port={
            <div data-port className="min-w-0">
              {children}
            </div>
          }
          verbs={verbs}
          consequence={consequence}
          confirmConsequences={confirmConsequences}
          routedToLabel={read.routedToLabel}
          alert={alert ?? notice}
          recordDetail={recordDetail}
          recordBand={replanAskBand}
          recordLead={
            isAgentReview && gate.state === 'changes_requested'
              ? tReview.rich('sentBack.record', {
                  when: gate.decidedAt ? new Date(gate.decidedAt).toLocaleString(locale) : '',
                  count,
                  b,
                })
              : decisionAccepted && gate.decidedByLabel && gate.decisionSource !== 'github'
                ? tDecision.rich('accepted', {
                    name: gate.decidedByLabel,
                    when: gate.decidedAt ? new Date(gate.decidedAt).toLocaleString(locale) : '',
                    b,
                  })
                : undefined
          }
          withdrawnPort={
            isDecision
              ? {
                  // A PER-KIND cause (§27): the shared `head_moved` line stays true for every
                  // other kind; the decision kind is withdrawn by a push only when the push
                  // changed the DOCUMENT, and says so.
                  port:
                    gate.supersededCause === 'head_moved'
                      ? tGate('withdrawn.causeByKind.decision_approval.head_moved')
                      : tGate(`withdrawn.cause.${gate.supersededCause ?? 'unknown'}`),
                  cite: tDecision('withdrawnNext'),
                }
              : withdrawnMerge
                ? {
                    port: say(withdrawnMerge.sentence),
                    cite: say(withdrawnMerge.cite),
                    // The pull requests are still on the card, merged, closed or moved: the
                    // withdrawal takes the verbs and keeps them (§ 29, Panel 1).
                    keepsRecord: true,
                  }
                : {
                    port:
                      moved.length > 0
                        ? t('withdrawn.port', { pr: nameList(moved.map(nameOf)) })
                        : t('withdrawn.portSet'),
                    cite: t('withdrawn.portCite'),
                  }
          }
          onDecide={onDecide}
          onShowCurrentVersion={() => {
            setRereadAsked(true);
            (onShowCurrentVersion ?? (() => router.refresh()))();
          }}
          focusPortOnMount={rereadAsked}
          requestedVerb={requestedVerb}
          onRequestedVerbDone={() => setRowPress(null)}
          awaitingRecord={awaitingRecord}
          leadBand={reviewBand}
          stateOverride={reviewStateOverride}
          waitingLine={
            isAgentReview && gate.state === 'awaiting'
              ? reviewReason !== null
                ? tReview('couldNotRun.whyNotYours', {
                    name: read.routedToLabel ?? tGate('theAssignee'),
                  })
                : tReview('reviewing.why')
              : undefined
          }
          settingsDoor={
            isAgentReview &&
            gate.state === 'awaiting' &&
            reviewReason === null &&
            agentReview?.settingsDoorHref
              ? { href: agentReview.settingsDoorHref, label: tGate('settingsDoor.reviewAgent') }
              : undefined
          }
          changesRequestedLine={
            isAgentReview && gate.state === 'changes_requested'
              ? tReview('sentBack.why')
              : undefined
          }
        />,
      )}
    </MergeOutcomeProvider>
  );
}
