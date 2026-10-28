import type * as React from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { ContentSectionCard } from './ContentSectionCard';
import { DEVELOPMENT_SECTION_ID, LATE_FALLBACK_ATTR } from './decisionAnchor';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';
import { AcceptancePanel } from './AcceptancePanel';
import { DesignResultSection } from './DesignResultSection';
import { ChoiceSection } from './ChoiceSection';
import { DecisionConfirmSection } from './DecisionConfirmSection';
import { DecidedGateStatusBridge } from './DecidedGateStatusBridge';
import { queueAgainAutoAction, retryApproveAndMergeMemberAction } from '../approvalGateActions';
import { membersOf } from '@/lib/approvalGates/memberVersion';
import { AttachmentsPanel } from './AttachmentsPanel';
import { PagesSection } from './PagesSection';
import { ActivitySection } from './ActivitySection';
import { DevelopmentSectionBody, hasOpenPullRequest } from '@/components/github/DevelopmentSection';
import { AcceptanceDevelopmentSlot } from '@/components/acceptance/AcceptanceDevelopmentSlot';
import type { DevelopmentGateRead } from '@/components/github/DevelopmentGateFrame';
import { DesignResultPanel } from './DesignResultPanel';
import { RunSection } from './RunSection';
import { HostedRunProvider } from './HostedRunProvider';
import { GuideMeThroughSection, type GuideMeThroughProgress } from './GuideMeThroughSection';
import { ContinueHostedDoor, ContinueHostedNotice } from './ContinueHostedDoor';
import { FixHostedDoor } from './FixHostedDoor';
import { FixInMyAgentDoor } from './FixInMyAgentDoor';
import { RunHostedButton } from './RunHostedButton';
import { ContinuePart } from '@/components/github/ContinuePart';
import { formatRunTimes } from './runTimes';
import { formatRunInstant } from '@/lib/runs/runClock';
import {
  DevelopmentLinkProvider,
  LinkPullRequestDoor,
  LinkPullRequestForm,
  RemovePullRequestLinkButton,
} from './DevelopmentLinkControl';
import { HowToTestWriteProvider } from '@/components/howToTest/HowToTestWrite';
import {
  loadHowToTestDraftAction,
  saveHowToTestAction,
  unlinkMonitorIssueAction,
} from '../actions';
import { MonitorErrorsCard } from './MonitorErrorsCard';
import { RUN_HISTORY_PAGE, type LateReads } from './lateReads';

// The item page's LATE STACK (Subtask MOTIR-3436), allocated by
// `design/work-items/design-notes.md` § *The item page at ARRIVAL, and while it
// STREAMS* — the tier table's third tier: Run, Development, Acceptance, Design
// result, Attachments and Activity.
//
// ⚠️ RUN SITS ABOVE DEVELOPMENT, and the order is CAUSAL rather than merely
// adjacent (Yue, 2026-08-29; `design/runs/design-notes.md` § Placement). The run
// is what PRODUCES the pull request, so a reader meets *an agent worked this
// card* and then *and here is what it shipped* — the order the events happened
// in, and the order the run's own timeline ends in, since *pull request linked*
// is its second-to-last step. Reversed, the page shows the artefact above the
// act that made it.
//
// ── ONE SETTLE, DELIVERED BY TWO BOUNDARIES ────────────────────────────────
// The design decides the page settles TWICE — once when the first content
// replaces the frame, once when the late stack fills — and therefore that the
// five late sections share ONE boundary rather than one each. Five independent
// boundaries would let the page arrive five times in whatever order the reads
// finish, and a reader watching blocks pop in at random reads instability, not
// speed.
//
// ⚠️ "ONE settle" is about TIME, not about JSX elements, and on this page it
// cannot be one element: `ChildPanel` is TIER TWO (it renders from the
// already-read `detail.children`) and the shipped page puts it BETWEEN Design
// result and Attachments. Wrapping it would make first-tier content late;
// moving it would reorder a page no card in this story is authorised to
// reorder. So the stack is two `<Suspense>` boundaries around a tier-2 section
// — both awaiting THE SAME `lateReads` promise, so they resolve in the same
// tick and flush together. The reader sees one settle; React sees two
// boundaries. (`MOTIR-3465` corrects the asset, whose settled frame drew
// Children second and so made a single contiguous span look possible.)
//
// ── WHAT DID NOT MOVE, AND WHY ─────────────────────────────────────────────
// The ROLL-UP BADGE stays server-resolved in the page's tier-2 group. The tier
// table calls it "late, IN PLACE" — a slot reserved at the settled width and
// filled where it stands — and `ParentRollupBadge` does ship a lazy path
// (`initialTotal: undefined` → a client fetch). But that path renders NOTHING
// while pending, so the slot is not reserved and its neighbours shift when it
// fills, which is the one thing the design's in-place rule forbids. The page's
// concurrent group already has the figure at no marginal cost, so "late in
// place" is satisfied more cheaply by not being late at all. Reserving the slot
// properly is a change to that component's markup, which this card's boundary
// excludes.
//
// ── ERROR CONTAINMENT IS UNCHANGED ─────────────────────────────────────────
// The reads that were wrapped in `try/catch` still are — in `lateReads.ts`,
// where they resolve to `null` and the section renders its own ErrorState +
// retry. A boundary must not convert a caught failure into a thrown one, and
// there is deliberately no `error.tsx`: a section-level empty/error state is
// what the design specifies, and a route-level error page would replace the
// whole item with a failure the reader cannot act on.

/**
 * ⚠️ WHICH GATE THE DEVELOPMENT FRAME IS A PORT FOR (MOTIR-5667, MOTIR-5678). A PRIMARY
 * question that is still open — the DESIGN (AMENDMENT 6 Q1) or the DECISION (§8's FIFTH
 * AMENDMENT, clause 5) — leads, so the press addresses it and ONE press answers both
 * questions and merges the set. Pressing the merge gate there would leave the primary
 * awaiting after its own commits had merged.
 *
 * The MEMBERS stay the merge gate's: they are what the press will merge. Once the primary
 * is decided the merge gate leads ALONE while it still awaits (Q2; §27 Panel 5b) — the
 * reader is being asked about the commits, and the primary shows as decided. A DECISION
 * card with no merge question left keeps its own gate in the frame (§27 Panels 4, 5a, 6a,
 * 6b): its record is the frame's record.
 *
 * ⚠️ A WITHDRAWN MERGE QUESTION WITH NOTHING LEFT OPEN IS NO QUESTION AT ALL (Bug
 * MOTIR-5884; `design/github` § 29, Panel 2). A pull request merged with the host's own
 * button while the gate awaited supersedes it `member_closed`, and when no member is left
 * open nothing will ever re-raise it — yet it stayed the card's latest merge gate, so the
 * frame drew a withdrawn box over a done card, promising a re-ask that could not happen.
 * Nothing was decided and nothing is left to ask, which is what a frame is for, so there is
 * none: the block is the shipped ungated body, each row with its own pill. Any cause — a
 * gate withdrawn by a push whose pull request was then merged on GitHub lands here too.
 */
function frameGateFor(
  r: LateReads,
  acceptanceLeads: boolean,
  anyPullRequestOpen: boolean,
  acceptanceSentBack = false,
): DevelopmentGateRead | null {
  const primary = (read: {
    gate: DevelopmentGateRead['gate'] | null;
    canDecide: boolean;
    routedToLabel: string | null;
    stamp: string | null;
  }): DevelopmentGateRead | null =>
    read.gate
      ? {
          gate: read.gate,
          canDecide: read.canDecide,
          routedToLabel: read.routedToLabel,
          // The PRIMARY gate's stamp — it covers the pull requests beneath it too.
          stamp: read.stamp,
          members: r.mergeGate.members,
          // ⚠️ AND THE VERSION THOSE MEMBERS ARE COUNTED OUT OF (Bug MOTIR-6080). No primary's
          // own version is a delivery set — a design's is its published commit, a decision's
          // its document blob, an acceptance's its recording — so the frame names what one
          // press merges, and lands each member's outcome on its row, only through the merge
          // gate's. A card with no merge question hands none, and the frame reads its own.
          mergeSubjectVersion: r.mergeGate.gate?.subjectVersion,
          // The approval a re-asked merge gate replaced (MOTIR-5863) — the merge read's,
          // like `members`, whichever gate leads the frame.
          earlierApproval: r.mergeGate.earlierApproval,
        }
      : null;
  const merge = r.mergeGate.gate ? primary(r.mergeGate) : null;
  const decision = r.decisionGate.gate;
  if (decision) {
    if (decision.state === 'awaiting' || decision.state === 'superseded') {
      return primary(r.decisionGate);
    }
    // Only an ACCEPTED decision hands the lead to the merge question (Panel 5b). One sent
    // back keeps the frame — its commits cannot merge (`decisionHoldsMerge`), so an
    // *Approve and merge* over them would be a press the door refuses.
    return decision.state === 'approved' && r.mergeGate.gate?.state === 'awaiting'
      ? merge
      : primary(r.decisionGate);
  }
  // THE STORY RUN'S PRIMARY (Story MOTIR-4949 · Subtask MOTIR-5790): the acceptance gate
  // is what the frame names and the press addresses while it awaits — its stamp covers
  // the pull requests beneath it, and the MEMBERS (and their version) are the merge gate's.
  if (acceptanceLeads && r.mergeGate.gate && r.acceptanceGate.gate) {
    return primary(r.acceptanceGate);
  }
  // ⚠️ ONE SENT BACK KEEPS THE FRAME (Story MOTIR-6071 · MOTIR-6506; design
  // `approval-control--acceptance-verdict.mock.html` choice 4). A story run's acceptance
  // refusal withdrew the merge gate (`pulled_back`), and handing the frame to it would draw
  // *"The work was pulled back out of review…"* — false: the story never left review, and
  // only a NEWER receipt asks again. So while the latest acceptance over the CURRENT receipt
  // is `changes_requested`, the acceptance stays the frame's gate: its record, the
  // `motir fix` offer or the re-plan door, and no merge band.
  if (acceptanceSentBack) return primary(r.acceptanceGate);
  // ⚠️ THE AGENT REVIEW LEADS WHILE IT ASKS, AND WHILE ITS REFUSAL STANDS (Story MOTIR-1626 ·
  // MOTIR-6825; design `design/github` § 30). With the review agent on, a green set raises
  // `agent_review` IN PLACE OF the approve-and-merge gate (§12.2), so the frame is its port
  // — Reviewing, Could not run, Sent back — until a pass or a person's override raises the
  // ordinary gate for the same version, which then leads with the review's record above it.
  // A merge gate NEWER than the review is a later question and keeps the lead; a refusal
  // over commits a push has since moved is history, not the card's question.
  const review = r.agentReview?.gate ?? null;
  if (
    review &&
    (review.state === 'awaiting' ||
      (review.state === 'changes_requested' && reviewedHeadsCurrent(review.subjectVersion, r))) &&
    (!r.mergeGate.gate || r.mergeGate.gate.createdAt <= review.createdAt)
  ) {
    return {
      gate: review,
      canDecide: r.agentReview!.canDecide,
      routedToLabel: r.agentReview!.routedToLabel,
      stamp: r.agentReview!.stamp,
      members: [],
    };
  }
  if (r.designGate.gate?.state === 'awaiting' && r.mergeGate.gate) return primary(r.designGate);
  if (merge?.gate.state === 'superseded' && !anyPullRequestOpen) return null;
  return merge;
}

/** Every member the review names is still at the head it reviewed — read off the rows. */
function reviewedHeadsCurrent(version: string | null, r: LateReads): boolean {
  const members = membersOf(version);
  if (members.length === 0) return false;
  return members.every((member) => {
    const row = r.pullRequests.find(
      (pr) => pr.repo.toLowerCase() === member.repo.toLowerCase() && pr.number === member.number,
    );
    return !row?.headSha || row.headSha === member.headSha;
  });
}

/** One pulsing placeholder block. Fill + radius through tokens only. */
function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}

/**
 * A pending section card — the real `ContentSectionCard` chrome with its body on
 * pulse blocks, which is what the tier table names for Development, Acceptance
 * and Design result. Attachments and Activity name their own already-drawn
 * skeletons (tile-shaped and comment-row-shaped); those live with their panels
 * and are cited by the asset rather than redrawn, so the fallback here holds
 * only the CARD, and each panel draws its own body once it arrives.
 */
export function SectionCardSkeleton({
  rows = 2,
  lateStackFallback = false,
}: {
  rows?: number;
  /** Marks the upper late stack's first pending card as the place a header press
   *  scrolls to before the gate's section has streamed (MOTIR-5878). */
  lateStackFallback?: boolean;
}) {
  const widths = ['w-2/3', 'w-1/2', 'w-3/4', 'w-1/3'];
  return (
    <div
      className="rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding) shadow-(--shadow-card)"
      data-surface="card"
      aria-busy="true"
      {...(lateStackFallback ? { [LATE_FALLBACK_ATTR]: '' } : {})}
    >
      <div className="mb-(--spacing-md)" aria-hidden="true">
        <Block className="h-5 w-36" />
      </div>
      <div className="flex animate-pulse flex-col gap-2" aria-hidden="true">
        {widths.slice(0, rows).map((w) => (
          <Block key={w} className={`h-3 ${w}`} />
        ))}
      </div>
    </div>
  );
}

/** The fallback for the UPPER half — Development, Errors, Acceptance, Design
 *  result. UNCHANGED by the Errors section (§14 panel 10): most cards have no
 *  link, so reserving a skeleton for it would draw a card that then vanishes. */
export function LateUpperFallback() {
  return (
    <>
      <SectionCardSkeleton rows={3} lateStackFallback />
      <SectionCardSkeleton rows={2} />
    </>
  );
}

/** The fallback for the LOWER half — Pages, Attachments, Activity.
 *
 *  The Pages card (Story MOTIR-7565 · MOTIR-7575; design § *The Pages section*,
 *  panel 4) is reserved ONLY for a reader who will get the section — `page:view`
 *  and not a Visitor, which the page knows in tier two. A withheld reader never
 *  sees a skeleton that then disappears (the upper fallback's Errors reasoning). */
export function LateLowerFallback({ withPages = false }: { withPages?: boolean }) {
  return (
    <>
      {withPages ? <SectionCardSkeleton rows={2} /> : null}
      <SectionCardSkeleton rows={2} />
      <SectionCardSkeleton rows={4} />
    </>
  );
}

interface LateProps {
  reads: Promise<LateReads>;
  itemId: string;
  itemIdentifier: string;
  canEdit: boolean;
  /** Read in the page's TIER-TWO group — the rail's Repositories card needs it
   *  too, so it is read once there and passed down rather than read twice. */
  repoDelivery: React.ComponentProps<typeof DevelopmentSectionBody>['repoDelivery'];
  /** The card's DELIVERY SET (MOTIR-3660), read in the same TIER-TWO group and
   *  passed down for the same reason — the rail needs it too. */
  deliveries: React.ComponentProps<typeof DevelopmentSectionBody>['deliveries'];
}

/**
 * Development · Acceptance · Design result — the late sections that sit ABOVE
 * `ChildPanel` in the page's order.
 */
export async function LateUpperSections({
  reads,
  itemId,
  itemIdentifier,
  currentUserId,
  canEdit,
  repoDelivery,
  deliveries,
  statusCategory,
  statusLabel = null,
  canReplan = false,
  parentIdentifier = null,
  hostedDoor = null,
  manual = null,
}: LateProps & {
  /** A MANUAL card (`isManualReadyItem`; Story MOTIR-7459 · MOTIR-7467): the Run
   *  section's slot carries Guide me through instead, and `door` is null where the
   *  door is not shown (A2.7) — the slot is then empty. Null for every other card,
   *  which renders its Run section exactly as before. */
  manual?: { door: { progress: GuideMeThroughProgress | null } | null } | null;
  /** The Run hosted door's inputs (MOTIR-691) — the card's own readiness — or
   *  null where no door is drawn: a reader who may not run the card, an archived
   *  card, or one already in the done category. */
  hostedDoor?: {
    ready: boolean;
    openBlockers: number;
    /** Send to my agent (MOTIR-7028): the project's name, where the reader may
     *  also use agents on it (`instance:use`) — else null, and only Run shows. */
    agents?: { projectName: string } | null;
  } | null;
  /** The card's status, in words — the continue part's *nothing moved* line names it
   *  (MOTIR-6534). */
  statusLabel?: string | null;
  /** The session's user — only to say whether the design gate is ROUTED to the
   *  reader (the band's sentence, MOTIR-5229). Authority stays `canDecide`. */
  currentUserId: string;
  /** The card's status CATEGORY — a withdrawn merge question on a done-category card
   *  promises no re-ask (MOTIR-5884, § 29's cite table). */
  statusCategory?: string | null;
  /** `WorkItemPlanEntrance`'s condition for this reader on this card — may plan, and the
   *  card is not archived. A refused decision's record offers Re-plan with AI when true
   *  (Story MOTIR-6068 · MOTIR-6211). Omitted, no door. */
  canReplan?: boolean;
  /** The card's PARENT's key — where a design's Re-plan opens the planner (§10h;
   *  MOTIR-6427). Null for a parentless card, which anchors on itself. */
  parentIdentifier?: string | null;
}) {
  const r = await reads;
  const [tGithub, tAcceptance, tDesignResult, tRuns, tChoice, tConfirm, locale] = await Promise.all(
    [
      getTranslations('github'),
      getTranslations('acceptance'),
      getTranslations('designResult'),
      getTranslations('runs'),
      getTranslations('approvalGate.choice'),
      getTranslations('approvalGate.decisionConfirm'),
      getLocale(),
    ],
  );
  // ⚠️ A DESIGN RESULT ON A CARD WITH AN OPEN LINKED PULL REQUEST IS NOT A SECTION
  // (`design-result.md` AMENDMENT 4 Q8). Those pull requests carry the decision —
  // one approve-to-merge gate over all of them — so the result renders ONCE as
  // the Development block's slot, and the standalone section (and its
  // `design_result` frame) is not drawn. With no open pull request, or nothing
  // published yet, the section renders exactly as before.
  // ⚠️ RE-DERIVED FROM THE GATES, not from "a pull request exists" (Story
  // MOTIR-5652 · Subtask MOTIR-5667; AMENDMENT 6 Q1 reversing AMENDMENT 4 Q8).
  // The old rule keyed on an open pull request because one meant NO design gate at
  // all — the card had a merge question and nothing else, so the result was a slot
  // rather than a subject. Such a card raises a design gate again, and the design
  // gate LEADS: the result is the Development block's subject and the pull requests
  // sit beneath it as what approving will merge.
  const designInDevelopment =
    r.designEvidence !== null &&
    r.designGate.gate !== null &&
    hasOpenPullRequest(r.pullRequests, deliveries ?? []);
  const showDesignResult = !designInDevelopment && (r.designEvidence !== null || r.isDesignCard);
  // THE STORY RUN (Story MOTIR-4949 · Subtask MOTIR-5790; the MOTIR-5787 amendment, point
  // 2). A story holding an acceptance question AND an open pull request of its own was
  // run as a whole: the receipt LEADS the Development block exactly as a design does,
  // and the pull requests beneath it are what the one press merges. The standalone
  // Acceptance section is then not drawn — one question, one place. A story with no
  // pull request of its own (a single-card run) keeps the section, alone (point 3).
  //
  // ⚠️ AND ONLY WHEN THE BLOCK CAN CARRY THE QUESTION (Subtask MOTIR-5792). The frame is
  // the MERGE gate's — `DevelopmentSectionBody` draws no bands without one. Since Bug
  // MOTIR-5903 a story run's acceptance question is asked only once its set is GREEN, so a
  // story whose pull requests are open but not yet green holds NO acceptance question at
  // all — there is no "To approve" row to fall back on, and none should exist (the receipt
  // is evidence waiting for the one approve-to-merge question). An awaiting acceptance with
  // no merge gate beside it is now the `auto`-mode shape, where Motir raises no merge gate:
  // the standalone section stays its door. An ANSWERED acceptance stays here too: panels B
  // and C are lines about a decision already made, and the block is where they belong
  // beside the commits they cover.
  const acceptanceAwaiting = r.acceptanceGate.gate?.state === 'awaiting';
  const acceptanceInDevelopment =
    r.acceptanceEvidence !== null &&
    r.acceptanceGate.gate !== null &&
    hasOpenPullRequest(r.pullRequests, deliveries ?? []) &&
    (!acceptanceAwaiting || r.mergeGate.gate !== null);
  const acceptanceLeads = acceptanceInDevelopment && acceptanceAwaiting;
  // A story run's acceptance SENT BACK over the receipt that is still current (MOTIR-6506,
  // choice 4) — the merge is held until a newer receipt, so the acceptance keeps the frame.
  const acceptanceSentBack =
    acceptanceInDevelopment &&
    r.acceptanceGate.gate?.state === 'changes_requested' &&
    r.acceptanceGate.gate.subjectId === r.acceptanceEvidence?.id;

  // THE DECISION PORT (Story MOTIR-4907 · Subtask MOTIR-5678; design `design/github` §27).
  // A card that asks the decision question and holds a decision gate shows its document
  // FIRST in the Development block — the PRIMARY question, with the pull requests beneath
  // as what accepting it merges. `decisionGate` is read only for such a card.
  const decisionInDevelopment = r.decisionGate.gate !== null;
  const developmentFrame = frameGateFor(
    r,
    acceptanceLeads,
    hasOpenPullRequest(r.pullRequests, deliveries ?? []),
    acceptanceSentBack,
  );
  // THE HEADER MARKER'S DESTINATIONS (Story MOTIR-4908 · MOTIR-5878; design
  // § *The item header — where pressing it takes you*). Each section names the
  // gate kinds whose frame it draws, derived from the SAME flags that decide where
  // a frame goes above — so the marker lands wherever its gate is drawn today, and
  // follows it when a later change moves it. The Development block always holds
  // the merge frame and the decision port.
  const developmentAnchors: ApprovalGateKindDTO[] = [
    'pull_request_approval',
    'decision_approval',
    // The agent review's states are shown on the card, in this block (§12.1); the overlay
    // is where its one decision is made.
    'agent_review',
    ...(designInDevelopment ? (['design_result'] as const) : []),
    ...(acceptanceInDevelopment ? (['acceptance_result'] as const) : []),
  ];
  const runCard = (
    <ContentSectionCard
      title={tRuns('title')}
      subtitle={tRuns('gloss')}
      headerRight={hostedDoor ? <RunHostedButton /> : undefined}
    >
      <RunSection
        initialRuns={r.runs ?? []}
        initialCursor={
          r.runs && r.runs.length === RUN_HISTORY_PAGE ? (r.runs.at(-1)?.id ?? null) : null
        }
        itemKey={itemIdentifier}
        formattedTimes={formatRunTimes(r.runs ?? [], locale)}
        scopeRun={r.scopeRun}
        scopeRunTime={r.scopeRun ? formatRunInstant(r.scopeRun.startedAt, locale) : null}
        gated={r.gatedRun}
        viewerId={currentUserId}
      />
    </ContentSectionCard>
  );
  const withHostedDoor = (node: React.ReactNode) =>
    hostedDoor ? (
      <HostedRunProvider
        itemKey={itemIdentifier}
        ready={hostedDoor.ready}
        openBlockers={hostedDoor.openBlockers}
        continueView={r.continueView.state === 'error' ? null : r.continueView}
        viewerId={currentUserId}
        agents={hostedDoor.agents ?? null}
      >
        {node}
      </HostedRunProvider>
    ) : (
      node
    );
  return (
    <>
      {/* THE RUN — above Development, because the run is what produced it. It
          renders even with no runs: its empty state reads *nothing has run yet*,
          and an absent section would be a third thing for a reader to interpret.
          A container that was run as a SCOPE shows its scope block instead of that
          empty state (MOTIR-5363) — the time is formatted here, on the server, for
          the same first-paint reason `formatRunTimes` exists. */}
      {/* RUN HOSTED (MOTIR-691): the door rides the section header's
          `headerRight`, and what it answers is drawn in the body — one
          provider around both, since the header is a server-rendered slot. */}
      {/* CONTINUE HOSTED (Story MOTIR-6527 · MOTIR-6796): the same provider
          also wraps Development, whose continue part holds the second door — one
          model list, read once, for both. */}
      {withHostedDoor(
        <>
          {/* GUIDE ME THROUGH (MOTIR-7467): a manual card is never run, so its slot
              carries the guide door instead — or nothing, where the door is not
              shown — and never both. */}
          {manual ? (
            manual.door ? (
              <GuideMeThroughSection itemKey={itemIdentifier} progress={manual.door.progress} />
            ) : null
          ) : (
            runCard
          )}
          {/* THE HOW-TO-TEST WRITE DOORS (Story MOTIR-5450 · MOTIR-5455, design § 24).
          Mounted ONLY for an actor holding `work_item:edit` and ONLY here: the
          block asks for this context and draws no door without it, so the
          read-only peek and the approval overlay — which render the same block —
          have none by construction rather than by a flag each host remembers to
          pass (§ 24, decisions 10 and 11). Both actions assert the same key
          server-side, so the gate is not this line's alone. */}
          <HowToTestWrite canEdit={canEdit} itemId={itemId} itemIdentifier={itemIdentifier}>
            <DevelopmentLinkProvider currentItemId={itemId} identifier={itemIdentifier}>
              <ContentSectionCard
                title={tGithub('development.title')}
                subtitle={tGithub(
                  decisionInDevelopment
                    ? 'development.glossWithDecision'
                    : designInDevelopment
                      ? 'development.glossWithDesign'
                      : acceptanceInDevelopment
                        ? 'development.glossWithAcceptance'
                        : 'development.gloss',
                )}
                headerRight={canEdit ? <LinkPullRequestDoor /> : undefined}
                decisionAnchor={developmentAnchors}
                // The To fix banner's *See its pull requests* lands here (MOTIR-6611).
                id={DEVELOPMENT_SECTION_ID}
              >
                {canEdit ? <LinkPullRequestForm /> : null}
                {/* A DESIGN THAT LEADS THIS BLOCK (Workflow B) is decided in the overlay too, and
                its decision moves the status rail — To do when it is sent back (MOTIR-6427).
                The design section's own bridge is not mounted on such a card, so it is here. */}
                {designInDevelopment && r.designGate.gate ? (
                  <DecidedGateStatusBridge gateId={r.designGate.gate.id} />
                ) : null}
                <DevelopmentSectionBody
                  pullRequests={r.pullRequests}
                  itemIdentifier={itemIdentifier}
                  manualLinkable={canEdit}
                  // The per-row REMOVE control (Story MOTIR-4878 · MOTIR-5005,
                  // design Panels 5d–5f). Gated on the SAME `work_item:edit` the
                  // header door is — `PULL_REQUEST_LINK_PERMISSION`, which the service
                  // behind `unlinkPullRequestAction` and the MCP tool both assert
                  // (MOTIR-6318; until then only the tool did) — and passed only from THIS host: the read-only
                  // peek omits it, so its rows keep no trailing control at all rather
                  // than a disabled one (design Q1 / Q4).
                  rowAction={
                    canEdit
                      ? (pr) => (
                          <RemovePullRequestLinkButton
                            pullRequestId={pr.id}
                            target={`${pr.repo} · #${pr.number}`}
                          />
                        )
                      : undefined
                  }
                  // The item's repository set, VERBATIM (Story MOTIR-2725 ·
                  // MOTIR-2415) — which rows it earns is the section's derivation,
                  // not this page's. Pre-filtering here is what let this page and the
                  // quick view disagree (MOTIR-3036).
                  repoDelivery={repoDelivery}
                  deliveries={deliveries}
                  // THE DEVELOPMENT BLOCK (MOTIR-5336, design §20): How to test renders
                  // INSIDE this card, below the rows — never a second section in this
                  // stack — and an awaiting approve-to-merge gate makes the rows plus
                  // How to test the port of ONE frame, as Design result's gate does.
                  howToTest={r.howToTest}
                  // THE FIX PART (MOTIR-5466, design § 21): below the rows, above How to
                  // test — the copyable `motir fix`, a repair in progress, or a give-up.
                  repair={r.repair}
                  // FIX ON THE HOSTED AGENT (MOTIR-6930, design § 30 Panels 3–3e): the door
                  // for whoever may run the card hosted — the Run hosted door's own rule. The
                  // fix part draws it only for a card a REVIEW sent back, in the offer state.
                  repairHostedDoor={hostedDoor ? <FixHostedDoor /> : undefined}
                  // FIX IN MY AGENT (MOTIR-9053): for a viewer who may also use agents on the
                  // project — the Send to my agent rule. The fix part draws it for a `ci` offer.
                  repairMyAgentDoor={hostedDoor?.agents ? <FixInMyAgentDoor /> : undefined}
                  // THE CONTINUE PART (MOTIR-6534, design `design/runs` § Run died): a
                  // run that died, the copyable `motir continue`, or who is continuing.
                  continuePart={
                    <ContinuePart
                      view={r.continueView}
                      itemIdentifier={itemIdentifier}
                      statusLabel={statusLabel ?? ''}
                      hosted={
                        hostedDoor
                          ? { door: <ContinueHostedDoor />, notice: <ContinueHostedNotice /> }
                          : null
                      }
                    />
                  }
                  designResult={
                    designInDevelopment ? (
                      <DesignResultPanel
                        evidence={r.designEvidence}
                        isDesignCard={r.isDesignCard}
                        placement="development"
                      />
                    ) : acceptanceInDevelopment && r.acceptanceEvidence && r.acceptanceGate.gate ? (
                      <AcceptanceDevelopmentSlot
                        evidence={r.acceptanceEvidence}
                        accepted={
                          r.acceptanceGate.gate.state === 'approved'
                            ? {
                                name: r.acceptanceGate.gate.decidedByLabel ?? '',
                                at: r.acceptanceGate.gate.decidedAt ?? '',
                              }
                            : null
                        }
                        mergeAwaiting={r.mergeGate.gate?.state === 'awaiting'}
                      />
                    ) : undefined
                  }
                  // ⚠️ WHICH GATE THE FRAME IS A PORT FOR (MOTIR-5667). When the card's
                  // DESIGN question is still open it is the PRIMARY (AMENDMENT 6 Q1), so
                  // the frame names it, and the press addresses it — which is what makes
                  // ONE press answer both questions and merge the set (MOTIR-5664).
                  // Pressing the merge gate here would leave the design question awaiting
                  // after its own commits had merged.
                  //
                  // The MEMBERS stay the merge gate's: they are what the press will merge,
                  // and they are what band 1 counts beneath the subject. After the design
                  // is decided the merge gate leads ALONE (Q2) — the reader is being asked
                  // about the commits, and the design shows as decided rather than as a
                  // second thing to answer.
                  mergeGate={developmentFrame}
                  cardTerminal={statusCategory === 'done'}
                  decision={
                    decisionInDevelopment
                      ? { document: r.decisionGate.document, gate: r.decisionGate.gate }
                      : null
                  }
                  // ⚠️ THE PAGE HANDS THE DECISION OVER (Bug MOTIR-6323; design-notes § *The
                  // item page HANDS THE DECISION OVER*, planning flag 2). An awaiting gate this
                  // reader may decide becomes the block plus *Review & approve* into the approval
                  // overlay, which is the ONE place a `GateDecision` is submitted from — so this
                  // host passes neither `decide` nor `approveAndMerge`. `retryMember` stays: on a
                  // decided gate *Retry merge* / *Queue again* carry out the decision already made.
                  handOver={{ routedToViewer: developmentFrame?.gate.routedToId === currentUserId }}
                  // THE AGENT REVIEW (MOTIR-6825; § 30): its states when it leads, and its pass
                  // or override above the approve-and-merge gate. Its one decision, *Continue
                  // without the review*, HANDS OVER to the approval overlay like every other
                  // (MOTIR-6323) — no decide door is passed here. *Review again* is the start
                  // card's route (a new run, not a decision), pressed from the frame.
                  agentReview={r.agentReview}
                  canReplan={canReplan}
                  gateActions={{ retryMember: retryApproveAndMergeMemberAction }}
                  // An `auto` card's exits (MOTIR-5635): Queue again for a reader who may edit.
                  autoQueueExits={{
                    workItemId: itemId,
                    exits: r.mergeGate.autoQueueExits,
                    canEdit,
                    queueAgain: queueAgainAutoAction,
                  }}
                />
              </ContentSectionCard>
            </DevelopmentLinkProvider>
          </HowToTestWrite>
        </>,
      )}
      {/* ERRORS — directly below Development (§14 access path): the same question,
          "what outside this tree does this card relate to", from a different source.
          The host draws NOTHING for a card with no link (the page is unchanged) unless
          the ⋯ menu's Link an error row asked for it (MOTIR-5744). */}
      <MonitorErrorsCard
        links={r.monitorIssueLinks}
        hasConnection={r.monitorHasConnection}
        // `work_item:edit` — the key every error-link action asserts (§14 Decision 5).
        canEdit={canEdit}
        workItemId={itemId}
        identifier={itemIdentifier}
        unlinkAction={unlinkMonitorIssueAction}
      />
      {r.acceptanceEligibility && r.showAcceptance && !acceptanceInDevelopment ? (
        <ContentSectionCard
          title={tAcceptance('title')}
          subtitle={tAcceptance('gloss')}
          decisionAnchor={['acceptance_result']}
        >
          <AcceptancePanel
            workItemId={itemId}
            itemIdentifier={itemIdentifier}
            projectId={r.projectId}
            eligibility={r.acceptanceEligibility}
            initialEvidence={r.acceptanceEvidence}
            gate={r.acceptanceGate.gate}
            canDecide={r.acceptanceGate.canDecide}
            routedElsewhereName={
              r.acceptanceGate.gate?.routedToId === currentUserId
                ? null
                : r.acceptanceGate.routedToLabel
            }
            // A finished story's refusal offers to plan a remedy from its record (MOTIR-6506).
            canReplan={canReplan}
          />
        </ContentSectionCard>
      ) : null}
      {r.choiceGate.body ? (
        // THE CHOICE (Story MOTIR-4914 · MOTIR-5896) — in the slot a design result takes,
        // and the destination the decision-waiting marker scrolls to for this kind.
        <ContentSectionCard title={tChoice('kindLabel')} decisionAnchor={['decision_choice']}>
          {/* A choice made in the overlay moves this page's status rail through here. */}
          {r.choiceGate.gate ? <DecidedGateStatusBridge gateId={r.choiceGate.gate.id} /> : null}
          <ChoiceSection
            body={r.choiceGate.body}
            workItemRefs={r.choiceGate.workItemRefs}
            gate={r.choiceGate.gate}
            canDecide={r.choiceGate.canDecide}
            routedToLabel={r.choiceGate.routedToLabel}
            routedToViewer={r.choiceGate.gate?.routedToId === currentUserId}
            itemIdentifier={itemIdentifier}
            canReplan={canReplan}
          />
        </ContentSectionCard>
      ) : null}
      {r.confirmGate.body ? (
        // THE DECISION (Story MOTIR-5871 · MOTIR-5960) — in the slot the choice takes, and
        // the destination the decision-waiting marker scrolls to for this kind.
        <ContentSectionCard
          title={tConfirm('sectionTitle')}
          decisionAnchor={['decision_confirmation']}
        >
          {/* A decision made in the overlay moves this page's status rail through here. */}
          {r.confirmGate.gate ? <DecidedGateStatusBridge gateId={r.confirmGate.gate.id} /> : null}
          <DecisionConfirmSection
            body={r.confirmGate.body}
            workItemRefs={r.confirmGate.workItemRefs}
            gate={r.confirmGate.gate}
            canDecide={r.confirmGate.canDecide}
            routedToLabel={r.confirmGate.routedToLabel}
            routedToViewer={r.confirmGate.gate?.routedToId === currentUserId}
            itemIdentifier={itemIdentifier}
            canReplan={canReplan}
            canEditRecord={canEdit}
          />
        </ContentSectionCard>
      ) : null}
      {showDesignResult ? (
        <ContentSectionCard
          title={tDesignResult('title')}
          subtitle={tDesignResult('gloss')}
          decisionAnchor={['design_result']}
        >
          {/* A decision made in the approval OVERLAY (mounted in the shell, outside
              this page's optimistic status provider) reaches the status rail
              through here — MOTIR-5570. */}
          {r.designGate.gate ? <DecidedGateStatusBridge gateId={r.designGate.gate.id} /> : null}
          <DesignResultSection
            evidence={r.designEvidence}
            isDesignCard={r.isDesignCard}
            gate={r.designGate.gate}
            canDecide={r.designGate.canDecide}
            routedToLabel={r.designGate.routedToLabel}
            routedToViewer={r.designGate.gate?.routedToId === currentUserId}
            subject={r.designGate.subject}
            itemIdentifier={itemIdentifier}
            // A design sent back with Re-plan keeps the door on its record, and the door
            // opens the planner on the card's PARENT (§10h; MOTIR-6427).
            canReplan={canReplan}
            replanKey={parentIdentifier ?? itemIdentifier}
          />
        </ContentSectionCard>
      ) : null}
    </>
  );
}

/**
 * Pages · Attachments · Activity — the late sections BELOW `ChildPanel` (and
 * Plans). Awaits the same promise as the upper half, so the two flush together
 * and the reader sees one settle.
 */
export async function LateLowerSections({
  reads,
  itemId,
  itemIdentifier,
  canViewPages,
  canEditWorkItem,
  currentUserId,
  currentUserName,
  workflowStatuses,
  mentionCandidates,
  activityTab,
}: {
  reads: Promise<LateReads>;
  itemId: string;
  /** The `PROD-N` key, for the Pages list's accessible name. */
  itemIdentifier: string;
  /** `page:view` on the item's project AND not a Visitor (MOTIR-7575): without
   *  it the Pages section is ABSENT — no card, no read — not disabled. */
  canViewPages: boolean;
  /** `work_item:edit` on the item (MOTIR-9199): the Pages section's Link page and
   *  Unlink controls follow it; a reader without it sees the rows and neither. */
  canEditWorkItem: boolean;
  currentUserId: string;
  currentUserName: string;
  workflowStatuses: React.ComponentProps<typeof ActivitySection>['workflowStatuses'];
  mentionCandidates: { id: string; name: string; email: string }[];
  activityTab: 'comments' | 'history' | 'all';
}) {
  const r = await reads;
  return (
    <>
      {canViewPages ? (
        <PagesSection
          key={itemId}
          workItemId={itemId}
          identifier={itemIdentifier}
          projectId={r.projectId}
          canEditWorkItem={canEditWorkItem}
        />
      ) : null}
      <AttachmentsPanel
        workItemId={itemId}
        canCreate={r.attachmentCaps.canCreate}
        canDeleteAll={r.attachmentCaps.canDeleteAll}
        currentUserId={currentUserId}
        initialPage={r.initialAttachments}
      />
      <ActivitySection
        workItemId={itemId}
        tab={activityTab}
        workflowStatuses={workflowStatuses}
        comments={{
          canComment: r.commentCaps.canComment,
          canModerate: r.commentCaps.canModerate,
          currentUserId,
          currentUserName,
          mentionCandidates,
        }}
        initialComments={r.initialComments}
        initialHistory={r.initialHistory}
        initialAll={r.initialAll}
      />
    </>
  );
}

/**
 * The write provider, or nothing — a reader without `work_item:edit` gets the
 * block's children with NO context, which is what makes "no door" structural
 * (MOTIR-5455). Split out so the mount reads as one element in the stack rather
 * than a ternary wrapped around half the section.
 */
function HowToTestWrite({
  canEdit,
  itemId,
  itemIdentifier,
  children,
}: {
  canEdit: boolean;
  itemId: string;
  itemIdentifier: string;
  children: React.ReactNode;
}) {
  if (!canEdit) return <>{children}</>;
  return (
    <HowToTestWriteProvider
      workItemId={itemId}
      identifier={itemIdentifier}
      loadDraft={loadHowToTestDraftAction}
      saveHowToTest={saveHowToTestAction}
    >
      {children}
    </HowToTestWriteProvider>
  );
}
