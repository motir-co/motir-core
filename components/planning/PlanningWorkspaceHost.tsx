'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { useRequestWorkbenchReread } from '@/lib/workbench/workbenchReread';
import { shallowReplace } from '@/lib/navigation/shallowUrl';
import { OVERLAY_PARAM_NAMES } from '@/lib/planning/launcher';
import { useTranslations } from 'next-intl';
import { Map } from 'lucide-react';
import { OverlayExitButton } from '@/components/ui/OverlayExitButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { AuditCoverageBanner } from '@/components/planning/AuditCoverageBanner';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { PlanChangeCanvas } from '@/components/planning/PlanChangeCanvas';
import { PlanningCanvasSkeleton } from '@/components/planning/PlanningWorkspaceSkeleton';
import {
  PlanChangeConfirmBar,
  PLAN_CONFIRM_BAR_HEIGHT,
} from '@/components/planning/PlanChangeConfirmBar';
import type { PlanApproveProgressView } from '@/components/planning/PlanApproveProgress';
import { PlanProposalViews } from '@/components/planning/PlanProposalViews';
import { RequirementDocument, RequirementNotice } from '@/components/planning/RequirementDocument';
import { requirementPaneOf } from '@/lib/planning/requirementPane';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { FollowPlannerControl } from '@/components/planning/FollowPlannerControl';
import type { ProjectRoadmapCanvasProps } from '@/components/planning/ProjectRoadmapCanvas';
import { usePlanProgressReading } from '@/lib/hooks/usePlanProgressReading';
import { providerLimitView } from '@/lib/planChange/providerLimitView';
import { drivenFollowRequest, nextDrivenStep, type DrivenStep } from '@/lib/planning/plannerDrive';
import { GuideWorkspaceHost } from '@/components/planning/GuideWorkspaceHost';
import { PlanCloseGuard } from '@/components/planning/PlanCloseGuard';
import {
  usePlanChangeConversation,
  type PlanChangeConversationState,
} from '@/lib/hooks/usePlanChangeConversation';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import {
  closeLosesProposal,
  isProposalPending,
  pendingProposalCount,
} from '@/lib/planning/planPending';
import { planGateView, type PlanDecisionPlace } from '@/lib/planning/planGateView';
import { isProposedReview } from '@/lib/planning/planReview';
import { defaultPlanView, type PlanViewDto } from '@/lib/planning/planView';
import {
  addPlanningTarget,
  MAX_PLANNING_TARGETS,
  removePlanningTarget,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';
import type { PlanningLaunch } from '@/lib/planning/launcher';
import type { PlanningSeedGuideDTO, PlanningSeedPickDTO } from '@/lib/dto/planningSeed';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { fetchPlanningAnchor } from '@/lib/planning/planningAnchorClient';
import {
  debugAutoSendKey,
  peekSurfaceSeed,
  releaseSurfaceSeed,
  type SurfaceSeed,
} from '@/lib/planning/surfaceSeed';
import {
  followFromPlan,
  followFromTarget,
  followRequest,
  type FollowRequest,
} from '@/lib/planning/surfaceFollow';

// The client island of the established-project planning HOST (Subtask
// MOTIR-1729; design `plan-change-conversation.mock.html` panel 2). It COMPOSES
// the shipped pieces — `PlanningWorkspace` (the two-pane frame),
// `WorkItemRoadmap` → `ProjectRoadmapCanvas` (the canvas, seeded with the
// project's EXISTING tree) — and adds only what the host owns: the exit chrome
// and the mode/context wiring. It rebuilds none of them.
//
// ⚠️ THE ROUTE FRAMING IS RETIRED (MOTIR-4729, under story MOTIR-4725). This
// header used to end: *"The design's overlay keeps the origin screen mounted
// behind it; this host is a ROUTE (the card's deliverable), so 'returns you to
// where you launched from' is a navigation back to that route."* It is now the
// overlay the design always specified — `PlanningWorkspaceOverlay` composes this
// host inside the shipped `Modal size="full"` over whichever authed page the
// reader is on, and closing removes four query parameters without unmounting
// anything.
//
// Two consequences land HERE rather than in the overlay, and both are subtractions:
//
//   · The exit chrome is a `<button>` calling `onClose`, not a `<Link href>`.
//     There is nowhere to link to — the reader is already on the page they are
//     going back to. Its label is a plain `close`; the three `backTo*` keys are
//     deleted, because naming a destination is exactly what made the route wrong
//     (`design/ai-chat/design-notes.md` § *Opening & exiting* → *The Close
//     control's copy*).
//   · This component no longer listens for `Esc`. Radix's dialog owns the key —
//     ONE handler, not two — and it already yields to a focused text field. The
//     listener that stood here is the collision `design/runs/` warned about.
//
// The chat pane is `PlanChangeRail` — the multi-turn plan-change CONVERSATION
// (Subtask MOTIR-1730). The host owns the conversation STATE
// (`usePlanChangeConversation`) rather than the rail, because the proposal is
// reviewed on the CANVAS: the same delta drives the rail's summary, the canvas's
// in-place diff, and the confirm-to-persist bar between them.
//
// PAGE STATE AFTER A MUTATION (`motir-core/CLAUDE.md`): an approve commits work
// items. The canvas is a CLIENT ISLAND that seeds its level once, so it gets an
// explicit refetch trigger (`treeVersion`, folded into the canvas's diff key), and
// the plan review is re-read and merged by identity (`usePlanChangeConversation`).
// The Workbench behind this overlay — the surface whose counts move — re-reads
// its own window when asked (`useRequestWorkbenchReread`, Story MOTIR-8539 ·
// MOTIR-8576). NOTHING REFRESHES THE ROUTE, on the approve, the restart or the
// session end. That retires the coordinated refresh this host used to take (bug
// MOTIR-6640): it existed because the live stream's refresh and this one could
// overlap and make Next fall back to a full document load, which dropped the
// decided plan. Neither refresh exists any more, so there is nothing to overlap;
// the Workbench's reread goes through its one in-flight read, so a stream nudge
// and an approve's request collapse into one.
//
// OPENS BEFORE ITS DATA (Bug MOTIR-2069): the frame — back bar, project name,
// the two-pane split, the whole conversation rail — waits on NOTHING. The host
// used to take a `hasItems` boolean the page computed from a server root read,
// and awaiting that read is what held the entire workspace shut: nothing painted
// until the level had been fetched, so the surface loaded first and opened
// second. That prop is gone. The canvas reads its own root level anyway (the
// same level, over `fetchRoadmapLevel`), so it owns the loading and empty states
// itself — one read instead of two, and none of them between the click and the
// paint. (`app/(planning)/loading.tsx` covered the navigation ahead of this while
// the workspace was a route; the overlay has no navigation to cover — it renders
// `PlanningWorkspaceSkeleton` inside the dialog instead.)

export interface PlanningWorkspaceHostProps {
  /** The project's `MOTIR`-style key — the canvas's per-level read source. */
  projectKey: string;
  projectName: string;
  /** The launcher's context, parsed off the query by the page. */
  launch: PlanningLaunch;
  /**
   * The ANCHOR work item's database id, when the workspace was summoned from a
   * work item (MOTIR-910's Plan / Re-plan entrance) and that item resolved. The
   * page resolves `launch.itemKey` → id server-side, so no client component
   * touches the service layer; the conversation then rides the item-scoped
   * MOTIR-909 endpoints instead of the project-wide thread. `null` for every
   * project / roadmap launch — and for an item key that no longer resolves,
   * which degrades to the project conversation rather than a dead workspace.
   */
  anchorId?: string | null;
  /** May this viewer configure the project's AI? Gates the audit-coverage banner
   *  (MOTIR-2250) — `auditCoverageService.getCoverage` asserts `ai:configure`,
   *  so a banner shown to anyone else is an invitation to a 403.
   *
   *  ⚠️ Still passed EXPLICITLY rather than read from `useProjectAccess()` here,
   *  and the reason has changed. It used to be that the `/planning` ROUTE lived
   *  OUTSIDE `(authed)`, so the provider was not mounted and the hook returned
   *  its permissive default. That route is gone (MOTIR-4732) and the overlay
   *  mounts INSIDE `(authed)`, so the provider IS there — the OVERLAY reads it,
   *  with the permission's own name (`can('ai:configure')`), and passes the
   *  answer down. Kept as a prop because this host is presentational about
   *  access: it renders what it is told, and every gate is decided one level up
   *  where the provider is. */
  canManage?: boolean;
  /** Close the workspace. The overlay routes Close, `Esc`, the scrim and a
   *  browser Back through ONE `requestClose()`, which is the seam the pending
   *  guard (MOTIR-4731) intercepts — so this control must call it rather than
   *  navigate.
   *
   *  ⚠️ REQUIRED since MOTIR-4732. It was briefly optional, with a `backHref`
   *  fallback, for exactly one caller: the `(planning)` page, a SERVER Component
   *  that could not hand a function across the boundary. That page is deleted
   *  and the fallback went with it — there is nowhere to navigate BACK to,
   *  because the reader never left. */
  onClose: () => void;
  /**
   * A slot the OVERLAY hands down so this host can VETO a close (MOTIR-4731).
   *
   * The overlay routes Close, `Esc`, the scrim and Back's `popstate` through one
   * `requestClose()` — but the thing that decides whether closing is safe is the
   * conversation state, which lives HERE. So the host writes a predicate into
   * this ref: `true` means *go ahead*, `false` means *I have raised the guard,
   * do not close*. That keeps the seam in one place and the state in one place,
   * with a single function between them.
   *
   * Absent wherever a caller does not want the question asked — a test
   * rendering the host in isolation, for instance. No guard, no veto.
   */
  closeGuardRef?: RefObject<(() => boolean) | null>;
  /**
   * OPEN a past conversation from the rail's History (Story MOTIR-9218 · MOTIR-9308):
   * the overlay re-addresses itself to it, through the same close guard. Absent →
   * the rail draws no History.
   */
  onOpenSession?: (sessionId: string, targetKeys: readonly string[]) => void;
  /**
   * *Keep planning* was chosen after a browser BACK — the one vector that has
   * already happened by the time the guard can ask, so the address no longer
   * says *open*. The overlay puts it back; the host cannot, because it does not
   * know the launch context.
   */
  onKeepPlanningAfterBack?: () => void;
  /** The work item the Plan / Re-plan entrance opened on, resolved server-side
   *  (MOTIR-1491): it is the PRE-FILLED initial target. Null for a project-scoped
   *  launch — or when the `?item=` key no longer resolves. */
  initialTarget?: PlanningTarget | null;
  /**
   * The canvas's ARRIVAL LEVEL (MOTIR-2070) — the anchor's ancestor chain
   * (root→parent) as a breadcrumb trail, resolved server-side alongside the
   * anchor itself. The anchor used to reach only the CONVERSATION: the canvas
   * seeded itself at the project root, so a workspace summoned about a subtask
   * three levels down opened on the epics and drew the item's target ring on a
   * level the user was not on — invisible, and indistinguishable from no anchor
   * at all. Empty for a project launch, for an unresolvable `?item=`, AND for a
   * root-level anchor (an epic is already on the root level).
   */
  initialCanvasTrail?: readonly CanvasCrumb[];
  /**
   * The user has just come BACK from onboarding (MOTIR-4770) — the round trip
   * closed. Passed straight to the rail, because the acknowledgement belongs in
   * the conversation rather than anywhere this component draws.
   */
  justReturnedFromOnboarding?: boolean;
  /**
   * THE SEEDED FIRST TURN (story MOTIR-6068 · MOTIR-6210) — the refusal seed's
   * `firstTurn`, which the overlay resolved before this host mounted. It is the
   * composer's INITIAL draft, unsent: nothing is posted on mount, and the person
   * may send, edit or clear it (design MOTIR-6206 sheets 2–5).
   */
  initialDraft?: string;
  /** The seeding gate the first send carries, so the session it starts
   *  remembers it (MOTIR-6207's stamp). Paired with `initialDraft`, or with
   *  `autoSendTurn` for a pick. */
  seedGateId?: string | null;
  /** A PICK's first turn, SENT once for the person rather than pre-filled
   *  (MOTIR-6435; `picked-option-planning-starts.md`). Passed to the rail, which
   *  sends it the first moment the conversation is idle and empty. */
  autoSendTurn?: string;
  /** The page-level claim the one-time send is held under (`claimPickAutoSend`).
   *  Defaults to `seedGateId` — a pick's gate; a start turn (MOTIR-7973) passes
   *  `start:<KEY>`. */
  autoSendKey?: string | null;
  /** The choice a pick-seeded conversation follows up — the rail's follow-up
   *  framing (design MOTIR-6432). Set on a pick's first open AND its resume. */
  followUp?: PlanningSeedPickDTO | null;
  /** `launch.sessionId` is the seed's `seededSessionId` — a RESUME of the
   *  viewer's own recent seeded conversation, not a Plans-row reopen, so the rail
   *  draws no reopened line (design MOTIR-6206 sheet 7). */
  sessionIsResume?: boolean;
  /** The GUIDE OFFER the first send carries, so the session it starts remembers it and
   *  the offer is marked confirmed with it (Story MOTIR-8684 · MOTIR-8693). Paired with
   *  `autoSendTurn`; NEVER set beside `seedGateId` — the two seeds are exclusive. */
  seedGuideTurnId?: string | null;
  /** The *from a guide* framing (design MOTIR-8686 sheet 9): rides a guide offer's
   *  first open AND its resume. */
  guideOrigin?: PlanningSeedGuideDTO | null;
  /** Targets beside the anchor in the INITIAL set — the guided card, so the plan's
   *  card hold parks it at Planning with the target. */
  extraInitialTargets?: readonly PlanningTarget[];
  /** The send was answered `409 GUIDE_REPLAN_OFFER_CONFIRMED { sessionId }`: the offer
   *  already started a session elsewhere, so the overlay returns to it. */
  onGuideOfferConfirmed?: (sessionId: string) => void;
}

/**
 * The host, by MODE (MOTIR-7466). GUIDE is a different room on the same frame —
 * the card's to-do list on the canvas and the guide conversation in the rail —
 * so it is a different component rather than a branch inside the plan host's
 * hooks: none of the plan host's state (targets, the follow-move, the proposal,
 * the close guard) exists in a guide, and mounting it would open the project
 * conversation for nothing.
 *
 * A guide whose card did not resolve for this viewer has nothing to walk, so it
 * degrades to the project conversation — the same rule an unresolvable
 * `planItem` already follows.
 */
export function PlanningWorkspaceHost(props: PlanningWorkspaceHostProps) {
  const { launch, initialTarget } = props;
  if (launch.mode === 'guide') {
    if (initialTarget) {
      return (
        <GuideWorkspaceHost
          projectName={props.projectName}
          card={initialTarget}
          onClose={props.onClose}
        />
      );
    }
    return (
      <PlanWorkspaceHost
        {...props}
        launch={{ ...launch, mode: 'project', from: 'project', itemKey: null }}
        anchorId={null}
      />
    );
  }
  return <PlanWorkspaceHost {...props} />;
}

function PlanWorkspaceHost({
  canManage = false,
  projectKey,
  projectName,
  launch,
  anchorId = null,
  onClose,
  closeGuardRef,
  onOpenSession,
  onKeepPlanningAfterBack,
  initialTarget = null,
  initialCanvasTrail,
  justReturnedFromOnboarding,
  initialDraft,
  seedGateId = null,
  autoSendTurn,
  autoSendKey,
  followUp = null,
  sessionIsResume = false,
  seedGuideTurnId = null,
  guideOrigin = null,
  extraInitialTargets,
  onGuideOfferConfirmed,
}: PlanningWorkspaceHostProps) {
  // A session remembers ONE seed (`plan_change_session_one_seed`): a host handed both
  // is a caller bug, so it is refused here rather than at the server's check.
  if (seedGateId && seedGuideTurnId) {
    throw new Error('A planning workspace is seeded by a gate or a guide offer, never both.');
  }
  const t = useTranslations('planningWorkspace');
  const tPlanReview = useTranslations('planReview');
  const tFollow = useTranslations('planningWorkspace.follow');
  const requestWorkbenchReread = useRequestWorkbenchReread();

  // ── THE SURFACE SEED (MOTIR-7050) ───────────────────────────────────────────
  // What the door that opened this workspace handed it besides its address: the
  // orb's "Debug with Motir AI" template (a draft, unsent) or the report widget's
  // accept (the ONE seeded send, anchored on the triage bug just filed). Read once
  // — a pure PEEK in the initializer, so a double render reads the same seed — and
  // RELEASED on mount, so a second host (a re-target, a close and reopen) finds
  // nothing to take. Only on the PROJECT conversation: both doors open it, and an
  // item thread has no ask door to send a report through. A gate's own seed (a
  // refusal's draft, a pick's send) outranks it; the two never meet in practice.
  const [surfaceSeed] = useState<SurfaceSeed | null>(() =>
    launch.itemKey === null && anchorId === null && !initialDraft && !autoSendTurn
      ? peekSurfaceSeed()
      : null,
  );
  useEffect(() => {
    releaseSurfaceSeed(surfaceSeed);
  }, [surfaceSeed]);
  const seedDraft = surfaceSeed?.kind === 'draft' ? surfaceSeed : null;
  const seedSend = surfaceSeed?.kind === 'send' ? surfaceSeed : null;

  // The turn's TARGET SET (MOTIR-1491). It lives HERE, not in the rail, because
  // both panes read it: the composer collects it and the canvas rings it. The
  // entrance's item seeds it as the INITIAL target — not a locked one, so the
  // user can remove it (⨉) or add more (design panel 5).
  const [targets, setTargets] = useState<PlanningTarget[]>(
    initialTarget ? [initialTarget, ...(extraInitialTargets ?? [])] : [],
  );
  const addTarget = useCallback(
    (target: PlanningTarget) => setTargets((current) => addPlanningTarget(current, target)),
    [],
  );
  const removeTarget = useCallback(
    (identifier: string) => setTargets((current) => removePlanningTarget(current, identifier)),
    [],
  );

  // SET AS TARGET on the canvas (MOTIR-6898; design panel 6). The same set the
  // composer feeds, so the tray and the ring always agree. A target picked ON
  // the canvas is one the reader is already looking at, so it never arms the
  // follow-move below: that would move the canvas off the level the card was
  // just picked on (MOTIR-6161's never-after-navigation rule, read from the
  // reader's side). Recorded by key, and read only by the follow's trigger.
  const [pickedOnCanvas, setPickedOnCanvas] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCanvasTarget = useCallback(
    (target: PlanningTarget, isTarget: boolean) => {
      if (isTarget) {
        removeTarget(target.identifier);
        return;
      }
      setPickedOnCanvas((current) => new Set(current).add(target.identifier.toUpperCase()));
      addTarget(target);
    },
    [addTarget, removeTarget],
  );

  // ── THE FOLLOW-MOVE (MOTIR-6161, Story MOTIR-6154) ─────────────────────────
  //
  // A conversation that opened with NO target sits at the root while the plan
  // lands somewhere below it. This moves the canvas inside the target once it
  // becomes known — and the canvas may DECLINE, which is the point: a reader who
  // has navigated themselves is never pulled back.
  //
  // Armed only when the set was EMPTY AT OPEN. A surface launched from a work
  // item already arrived inside it, and a second target must not move the canvas
  // off the first (the story: with several targets, the canvas is inside the
  // FIRST one).
  // Read ONCE, at mount, and held as state rather than a ref because the render
  // below reads it — `react-hooks/refs` forbids reading a ref during render, and
  // a lazy `useState` is the idiom that gives "read once" without one.
  const [startedWithNoTarget] = useState(initialTarget === null);
  // Set from the async anchor read below. A `setState` inside an async callback
  // is not the shape the effect lint rule forbids — that one is a SYNCHRONOUS
  // write in an effect body, which this is not.
  const [followFromTheTarget, setFollowFromTheTarget] = useState<FollowRequest | null>(null);

  // TRIGGER 1 — the person added the first target. The trail needs the target's
  // ANCESTORS, which only the anchor read has, so this is a fetch rather than a
  // derivation from the chip.
  const firstTarget = targets[0] ?? null;
  const firstTargetKey =
    startedWithNoTarget &&
    firstTarget !== null &&
    !pickedOnCanvas.has(firstTarget.identifier.toUpperCase())
      ? firstTarget.identifier
      : null;
  useEffect(() => {
    if (firstTargetKey === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const found = await fetchPlanningAnchor(firstTargetKey, controller.signal);
        if (controller.signal.aborted) return;
        // A target the viewer cannot see degrades to nothing at all, never an
        // error and never a move — the same silent contract the arrival keeps.
        const next = followFromTarget(found);
        if (next !== null) setFollowFromTheTarget(next);
      } catch {
        // An outage is not a reason to move the canvas, or to say anything.
      }
    })();
    return () => controller.abort();
  }, [firstTargetKey]);

  // ── THE CLOSE, AND THE ONE QUESTION IT MAY ASK (MOTIR-4731) ───────────────
  //
  // `onClose` is the overlay's `requestClose` — the seam every close vector
  // converges on.
  const [guardOpen, setGuardOpen] = useState(false);
  // Set while a decision THE GUARD took is closing the workspace, so the veto
  // lets that close through. Without it the guard would answer its own question:
  // both decisions are server writes, so the proposal is still pending at the
  // moment *Discard* or *Confirm & add* asks to close.
  const bypassRef = useRef(false);

  const performClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const closeBypassingGuard = useCallback(() => {
    bypassRef.current = true;
    try {
      performClose();
    } finally {
      bypassRef.current = false;
    }
  }, [performClose]);

  const close = performClose;

  // Bumped on every approve: the committed tree is new data, so the canvas island
  // must refetch its level (and the Workbench behind is asked to re-read).
  const [treeVersion, setTreeVersion] = useState(0);
  // ⚠️ *Confirm & add* CLOSES FROM HERE, not from the `await` (MOTIR-4731). This
  // callback fires on a SUCCESSFUL approve and on nothing else, so it is the one
  // place that knows the write landed — reading `state.decided` after the await
  // would race the re-render that sets it. A FAILED approve simply never reaches
  // here, which leaves the guard up with the conversation's own error: the one
  // case where closing would lose the thing the reader was trying to save.
  const closeAfterApproveRef = useRef(false);
  const onApproved = useCallback(() => {
    setTreeVersion((v) => v + 1);
    requestWorkbenchReread();
    if (!closeAfterApproveRef.current) return;
    closeAfterApproveRef.current = false;
    setGuardOpen(false);
    closeBypassingGuard();
  }, [requestWorkbenchReread, closeBypassingGuard]);
  // PLAN SOMETHING NEW swapped the overlay onto a new session (MOTIR-7650): an
  // address that NAMED the old session now names the new one, so a reload opens
  // what is on screen. A REPLACE, not a push — Back should not return to a session
  // that no longer accepts a turn — and shallow, because the body is already here.
  // Answers whether it rewrote the address.
  const replaceSessionAddress = useCallback((sessionId: string): boolean => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(OVERLAY_PARAM_NAMES.session)) return false;
    url.searchParams.set(OVERLAY_PARAM_NAMES.session, sessionId);
    shallowReplace(`${url.pathname}${url.search}${url.hash}`);
    return true;
  }, []);
  // …and the ended session gave its cards back, so the canvas island re-reads them
  // at their prior status and the Workbench behind is asked to re-read — the end
  // effect below cannot see this end, because the session id changed with it.
  //
  // ⚠️ THE ADDRESS IS REWRITTEN WITH NOTHING BESIDE IT (MOTIR-8576). Bug MOTIR-8212
  // was a route refresh dispatched in the same tick as this `shallowReplace`: Next
  // turns the `history.replaceState` into a router navigation of its own, the two
  // overlapped, and under load Next hard-reloaded the page and aborted the carried
  // turn's submit. The fix then was to hold the refresh until the router committed
  // the address. The refresh is gone now, so the wait went with it: a Workbench
  // reread is a `fetch`, not a navigation, and cannot overlap one.
  const onRestarted = useCallback(
    (sessionId: string) => {
      setTreeVersion((v) => v + 1);
      replaceSessionAddress(sessionId);
      requestWorkbenchReread();
    },
    [replaceSessionAddress, requestWorkbenchReread],
  );
  const {
    state,
    send,
    retry,
    correctTurn,
    approve,
    discard,
    stop,
    startCopied,
    requestRestart,
    answerRestartConfirm,
    confirmPlanOffer,
    declinePlanOffer,
    answerRunPause,
    planAgain,
    resume,
    showEarlierNarration,
  } = usePlanChangeConversation({
    onApproved,
    anchorId,
    // A NAMED conversation (`planSession=`, a Plans row) reopens that one
    // (MOTIR-6024).
    sessionId: launch.sessionId ?? null,
    // A refusal's seeded re-plan (MOTIR-6210): the resumed return, or the seed
    // the first send carries.
    sessionIsResume,
    seedGateId,
    seedGuideTurnId,
    onGuideOfferConfirmed,
    onRestarted,
  });

  // THE START TURN HAS LANDED (MOTIR-7973): once the thread holds a user turn, the
  // address that asked to START it now names it instead — ONE replace, dropping
  // `planStart` and writing `planSession=<id>`, so a reload resumes the
  // conversation rather than asking to start it again. A replace, not a push:
  // Back should not return to an address that asks for a send already made.
  //
  // ⚠️ NOT WHILE THE OPEN IS STILL `loading`. A RESUMED thread already holds its
  // user turn when the open answers, but the open then reads the thread's pending
  // plan; rewriting the address mid-read re-runs the open effect, which aborts
  // that read and — the address now naming the thread on screen — does not start
  // another, so the plan never arrives and its confirm bar never draws.
  const startedSessionId =
    launch.startTurn &&
    state.phase !== 'loading' &&
    state.session &&
    state.session.turns.some((turn) => turn.role === 'user')
      ? state.session.id
      : null;
  useEffect(() => {
    if (startedSessionId === null) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(OVERLAY_PARAM_NAMES.start)) return;
    url.searchParams.delete(OVERLAY_PARAM_NAMES.start);
    url.searchParams.set(OVERLAY_PARAM_NAMES.session, startedSessionId);
    shallowReplace(`${url.pathname}${url.search}${url.hash}`);
  }, [startedSessionId]);

  // THE SESSION'S END (MOTIR-7643): an end releases the cards the session held at
  // Planning, so the canvas re-reads them at their prior status — the same refetch
  // a decline or an approve triggers. Fires on the transition only, never on a
  // session that mounted already ended.
  const endSessionId = state.session?.id ?? null;
  const endedAt = state.session?.endedAt ?? null;
  const seenEnd = useRef<{ id: string | null; endedAt: string | null } | null>(null);
  useEffect(() => {
    const before = seenEnd.current;
    seenEnd.current = { id: endSessionId, endedAt };
    if (!before || before.id === null || before.id !== endSessionId) return;
    if (before.endedAt !== null || endedAt === null) return;
    setTreeVersion((v) => v + 1);
    requestWorkbenchReread();
  }, [endSessionId, endedAt, requestWorkbenchReread]);

  // The rail sends TEXT; the anchors come from the set this host owns, so the
  // rail never has to know how a turn is scoped.
  const sendTargeted = useCallback((text: string) => void send(text, targets), [send, targets]);
  // The widget's seeded send goes through the ASK DOOR on the project thread
  // (an empty target set), carrying the triage bug as its anchor — the one
  // route on which the server reads a turn as a report (ADR AMENDMENT 1, A1.2).
  const seedAnchorKey = seedSend?.anchorKey ?? null;
  const sendSeeded = useCallback(
    (text: string) => void send(text, [], { anchorKey: seedAnchorKey }),
    [send, seedAnchorKey],
  );
  const targetIds = targets.map((target) => target.id);

  const index = useMemo(() => indexPlanReview(state.review), [state.review]);

  // TRIGGER 2 — the plan's proposals first show WHERE the plan lands, answered by
  // the plan page's own `arrivalLevel` (moved to `lib/planning/planArrival.ts` by
  // this card, so the two surfaces cannot disagree about it — the story's "reused,
  // not re-cut"). Today `state.review` arrives when the plan is PROPOSED; the
  // live-drawing story feeds the same seam its in-flight reads, and then it fires
  // on the first proposal instead. Nothing here changes for that.
  //
  // DERIVED, not stored: it is a pure function of the review, so computing it in
  // render is both cheaper and the shape the lint rule asks for — an effect that
  // only calls `setState` from props is the case `react-hooks/set-state-in-effect`
  // exists to remove.
  //
  // ⚠️ LATCHED PER PLAN (MOTIR-6300). The plan is now read WHILE it is written, and
  // "the level it most fills" moves as it grows — so a derivation per snapshot would
  // hand the canvas a new request on every batch, each one declined into the offer.
  // The first answer a plan gives is its answer (§23.8: the FIRST proposal may carry
  // the canvas once), and it is kept through the hand-over to the proposed plan.
  const proposedWord = tPlanReview('proposedCrumb');
  const planForFollow = state.liveReview ?? state.review ?? null;
  const followCandidate = useMemo(
    () => (startedWithNoTarget ? followFromPlan(planForFollow, proposedWord) : null),
    [startedWithNoTarget, planForFollow, proposedWord],
  );
  const [planFollow, setPlanFollow] = useState<{
    planId: string;
    follow: FollowRequest;
  } | null>(null);
  if (
    followCandidate !== null &&
    planForFollow !== null &&
    planFollow?.planId !== planForFollow.id
  ) {
    setPlanFollow({ planId: planForFollow.id, follow: followCandidate });
  }
  const followFromThePlan =
    planFollow !== null && planForFollow !== null && planFollow.planId === planForFollow.id
      ? planFollow.follow
      : followCandidate;

  // The FIRST trigger to fire wins: a target the person added is their own act,
  // and the plan's landing place is an inference about it. The canvas honours at
  // most one request per mount regardless, so this is belt and braces on purpose.
  const followTo = followRequest(followFromTheTarget, followFromThePlan);

  // ⭐ WHERE THE READER IS STANDING, carried ACROSS THE PANE SWAP (MOTIR-6155,
  // honouring MOTIR-6161's rule).
  //
  // `navigated` is per-mount state inside `ProjectRoadmapCanvas`, which is right
  // until a surface REPLACES its canvas — and this one does, the moment a plan is
  // proposed. Without this, the fresh `PlanReviewCanvas` mounted with
  // `navigated: false`, granted the pending `followTo`, and moved a reader off the
  // level they had chosen. That is the one thing MOTIR-6161 decided must not
  // happen, and its own gate catches it.
  //
  // ⚠️ `onLevelChange` IS THE READER'S SIGNAL, and that is not an accident of
  // naming: the foundation fires it from `applyDrill` and `navigate` — the two
  // movers the reader's own acts funnel through — and NOT from a granted follow,
  // which sets the crumbs directly. So "this fired" means "the reader moved", and
  // no second reporting prop is needed to know it.
  const [canvasHeldTrail, setCanvasHeldTrail] = useState<readonly CanvasCrumb[] | null>(null);
  const noteReaderLevel = useCallback((trail: readonly CanvasCrumb[]) => {
    setCanvasHeldTrail(trail);
  }, []);
  const readerHasNavigated = canvasHeldTrail !== null;
  // One key for "what the canvas is drawing": a new proposal, or a fresh commit.
  const diffKey = `${treeVersion}:${state.jobId ?? 'none'}:${state.decided ?? 'pending'}:${index.counts.added}-${index.counts.changed}-${index.counts.removed}`;

  // THE PREDICATE, from `lib/planning/planPending.ts` — the SAME expression that
  // used to sit inline in the footer slot below, moved into a module so the bar
  // and the guard cannot come to disagree about whether anything is at stake.
  const pending = isProposalPending(state, index);
  const pendingCount = pendingProposalCount(index);
  const deciding = state.phase === 'deciding';
  // ⚠️ THE GUARD'S OWN PREDICATE IS NARROWER THAN `pending` (MOTIR-6037; design Part XXII
  // §22.6, §22.11 flag 1): an ASKED plan and a plan being WRITTEN lose nothing on close —
  // the first waits in To approve, the second is a server job — so the guard, whose copy
  // says closing discards them, does not open for either. `pending` still chooses the
  // footer slot's content.
  const guarded = closeLosesProposal(state, index);

  // ── THE PLAN GATE'S DECISION, on this surface (Story MOTIR-6012 · MOTIR-6037) ──────
  // One derivation for the bar and the rail's review block, so the gate and its mirror
  // cannot disagree. A plan run streaming into the plan in hand holds its verbs before
  // the review read can say so.
  const gateView = planGateView({
    review: state.review,
    rewriting: state.phase === 'streaming' && state.planId !== null,
  });
  // ── THE CONVERSATION HAPPENED ELSEWHERE (MOTIR-6298; design Part XXIII §23.11) ─────
  //
  // An MCP agent plans in its own harness, so its session can reach this surface
  // holding NO turns (MOTIR-6157). The rail then names the harness. WHO WROTE the
  // plan is read off its own attribution — `authorSource` alone, as the plan page's
  // `ReviewAttribution` does, never inferred from `sourceJobId` — from the live
  // review while an agent is still writing it and from the proposed one after.
  //
  // ⚠️ KEYED ON THE SESSION, AND LATCHED. The note shows when the plan is read while
  // the session holds zero turns, and it STAYS once a turn is sent — it is still
  // true, and sending clears `review` for the new run, so a live derivation would
  // drop it the moment the person used the composer. An MCP session that ALREADY
  // had turns when its plan was read never latches, and renders as before.
  const conversationElsewhere = useConversationElsewhere(state);

  // ── THE PLAN PAGE'S OWN List | Canvas, ON THIS SURFACE (Subtask MOTIR-6186) ────────
  //
  // Once the conversation holds a PROPOSED plan, the left pane renders the very
  // component the plan page renders — `PlanProposalViews` — instead of the roadmap
  // with the proposal decorated over it. What that page shows, this shows, and a
  // change to one is a change to both: there is no second list, no second review
  // canvas and no second edge computation anywhere on this surface.
  //
  // `state.decided` keeps it mounted after the decision, in Part VI's decided
  // treatment (MOTIR-3162 keeps the review across approve and discard). A new turn
  // clears the review, and the pane falls back to `PlanChangeCanvas` — which is the
  // "no plan" state again, and correct.
  //
  // ── …AND WHILE THE PLAN IS BEING WRITTEN (MOTIR-6300; design Part XXIII) ─────────
  //
  // From the plan's FIRST live read (`state.liveReview`, the shared generating poll —
  // MOTIR-6295), the pane is that SAME component, fed the snapshot and opted into
  // `live`: the level plays each snapshot's change, arrivals elsewhere are counted,
  // the header says *Being written*, and the footer is EMPTY (§23.1 — a generating
  // plan has nothing to decide). Zero proposals included: the switch shows from the
  // first read (§23.2).
  //
  // ⚠️ THE HAND-OVER IS NOT A SWAP. `liveReview → review` for the same plan is one
  // state update (the hook sets both at once), the pane is the same element at the
  // same position under the same KEY — the plan's id — so React keeps the instance:
  // the view, the level, the zoom and pan, Show changes, every card and every arrow
  // are the ones already drawn, and only the bar arrives (§23.13). A plan DISCARDED
  // while it was written (`state.discardedReview`) keeps the pane too, with the plan
  // page's discarded sentence in its band slot (§23.12).
  const review = state.review;
  const liveReview = state.liveReview ?? null;
  const showsProposed = review !== null && (isProposedReview(review) || state.decided !== null);
  const paneReview = liveReview ?? (showsProposed ? review : null) ?? state.discardedReview ?? null;
  const paneLive = liveReview !== null;
  const paneDiscarded = !paneLive && !showsProposed && paneReview !== null;

  // ── FOLLOW THE PLANNER (Story MOTIR-8590 · Subtask MOTIR-8594; design Part XXVIII) ──
  //
  // While the pane is LIVE the canvas is DRIVEN by the planner: the host holds the
  // step it follows (`nextDrivenStep`, held across polls — `null` keeps the hold,
  // so a stalled or failing read leaves the canvas where it is), a FOLLOWING flag,
  // and an `epoch` the *Follow the planner* button bumps so the same level is asked
  // for again. Following starts ON the first time a plan is seen live, turns OFF on
  // the person's own navigation (`onReaderNavigated` — never `onLevelChange`, which
  // a driven move also fires), and the whole of it ends when the plan leaves
  // `generating`: the control plays its leaving fade, and a plan that was watched
  // live asks the canvas for nothing afterwards (§28.2 — the one-shot triggers keep
  // their meaning only for a plan that was never driven).
  //
  // ⚠️ FLAG 1 (§28.4) is NOT answered here: a sustained run of steps that each end
  // within one poll moves the canvas every poll. No dwell rule is invented; the
  // design leaves that call to whoever judges it at real size.
  //
  // ONE progress clock for the pane: the same reading drives the progress line, the
  // canvas cues and the driven step, so the canvas never follows a step the words
  // have stopped naming (Part XXVI §26.4).
  const paneReading = usePlanProgressReading(paneReview?.progress ?? null, {
    failing: state.liveFailing,
  });
  const paneId = paneReview?.id ?? null;
  // THE PROVIDER LIMIT (Story MOTIR-9540 · MOTIR-9622): the same reading carries the session's
  // provider-retry wait, so a mid-retry open or a reload shows the banner on first paint. A
  // stored failure wins over a wait; the rail words a `rate_limited` one inside its failed face.
  const railProviderLimit =
    providerLimitView(state.session?.failure ?? null, paneReading?.providerWait ?? null) ===
    'retrying'
      ? 'retrying'
      : null;
  const [drive, setDrive] = useState<{
    planId: string | null;
    /** The pane was LIVE when this plan was first seen — only then is it driven. */
    watchedLive: boolean;
    live: boolean;
    on: boolean;
    epoch: number;
    held: DrivenStep | null;
    /** The request the last press asked for: it alone carries the resumed words. */
    resumeKey: string | null;
    leaving: boolean;
  }>(() => ({
    planId: paneId,
    watchedLive: paneLive,
    live: paneLive,
    on: paneLive,
    epoch: 0,
    held: null,
    resumeKey: null,
    leaving: false,
  }));
  const drivenNow = useMemo(
    () =>
      paneLive && paneReview && paneReading && drive.planId === paneReview.id
        ? nextDrivenStep(drive.held, paneReading.liveSteps, paneReview.items, proposedWord)
        : null,
    [paneLive, paneReview, paneReading, drive.planId, drive.held, proposedWord],
  );
  // Derived state, folded in render (the paneTick shape above).
  if (drive.planId !== paneId) {
    setDrive({
      planId: paneId,
      watchedLive: paneLive,
      live: paneLive,
      on: paneLive,
      epoch: 0,
      held: null,
      resumeKey: null,
      leaving: false,
    });
  } else if (drive.live !== paneLive) {
    setDrive({ ...drive, live: paneLive, leaving: drive.watchedLive && !paneLive });
  } else if (
    drivenNow !== null &&
    (drivenNow.id !== drive.held?.id ||
      drivenNow.levelId !== drive.held?.levelId ||
      drivenNow.trail.length !== drive.held?.trail.length)
  ) {
    setDrive({ ...drive, held: drivenNow });
  }
  const drivenPane = drive.planId === paneId && drive.watchedLive;
  const drivenRequest = useMemo(() => {
    const request = drivenFollowRequest(drive.held, drive.epoch);
    if (request && request.key === drive.resumeKey) {
      return { ...request, announce: tFollow('resumedAnnouncement'), focus: true };
    }
    return request;
  }, [drive.held, drive.epoch, drive.resumeKey, tFollow]);
  // What the pane's canvas is asked for: the driven step while live and following
  // — until a step names a level, the shipped arrival (§23.8, one key, so granted
  // once); NOTHING once a plan watched live has left `generating`; else the one-shot.
  const paneFollowTo: ProjectRoadmapCanvasProps['followTo'] = drivenPane
    ? paneLive && drive.on
      ? (drivenRequest ?? followTo)
      : null
    : followTo;
  // THE REQUIREMENT LAYER (MOTIR-9437): while the live offer is a plan offer with no
  // target, its composed requirement covers the pane. Derived from the thread alone —
  // the one rule the rail reads — so a reopen shows it again and Decline, Confirm or a
  // newer answer drops it, with the pane underneath never unmounted (it keeps the
  // reader's level, view and zoom in instance state).
  const requirementPane = useMemo(
    () => requirementPaneOf(state.session?.turns ?? []),
    [state.session?.turns],
  );
  const paneRef = useRef<HTMLDivElement>(null);
  const layerUp = requirementPane !== null;
  // While the layer is up, what it covers is `inert` and hidden from assistive tech, so
  // keyboard focus and the canvas's own shortcuts stay out of it. Set on the pane's
  // direct children rather than a wrapper, so the pane's structure is unchanged; it
  // runs every render because the confirm bar can mount under it.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !layerUp) return;
    const covered = Array.from(pane.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.dataset['layer'] !== 'requirement',
    );
    covered.forEach((el) => {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    });
    return () => {
      covered.forEach((el) => {
        el.removeAttribute('inert');
        el.removeAttribute('aria-hidden');
      });
    };
  });
  const followReaderNavigated = useCallback(() => {
    setDrive((d) => (d.on ? { ...d, on: false } : d));
  }, []);
  const followPlanner = useCallback(() => {
    setDrive((d) => {
      const epoch = d.epoch + 1;
      return {
        ...d,
        on: true,
        epoch,
        resumeKey: drivenFollowRequest(d.held, epoch)?.key ?? null,
      };
    });
    // §28.7: the press hands focus to the canvas, which is where the result is.
    // With a driven step the canvas does it (`focus` on the request below), once
    // the level is drawn; with none nothing moves, so the canvas in view takes it.
    if (!drive.held) {
      paneRef.current?.querySelector<HTMLElement>('[role="application"]')?.focus();
    }
  }, [drive.held]);
  const followLeft = useCallback(() => {
    setDrive((d) => (d.leaving ? { ...d, leaving: false } : d));
  }, []);
  const followIdle = paneReading?.state === 'stalled' || state.liveFailing;
  const followControl =
    drivenPane && (paneLive || drive.leaving) ? (
      <FollowPlannerControl
        following={drive.on}
        idle={followIdle}
        leaving={!paneLive}
        onLeft={followLeft}
        onFollow={followPlanner}
      />
    ) : undefined;
  // ⚠️ A NAMED session is opened to show its plan (bug MOTIR-6289) — a To-approve row
  // or a Plans row writes `planSession`. Until the conversation has read whether a plan
  // is pending, the pane is its skeleton, NOT the roadmap: drawing `PlanChangeCanvas`
  // for that interval is what flashed the roadmap and then jumped to the plan. A launch
  // with no session has no plan to wait for, so it draws the roadmap at once, as before.
  const openingNamedSession = Boolean(launch.sessionId) && state.phase === 'loading';

  // ⚠️ THE VIEW IS LOCAL, AND IT IS NEVER WRITTEN TO THE URL (`design-notes.md`
  // Part XXI 21.4). The plan page keeps it in the URL and is right to; this is an
  // OVERLAY over whichever page the reader is on, so the address bar belongs to
  // that page — and `?view=` is not a free name, because the plan page itself uses
  // it. Back already means one thing here (the overlay routes Close, Esc, the scrim
  // and browser Back through one `requestClose()`, which the pending guard
  // intercepts); a view switch that pushed history would make it mean two.
  //
  // ⚠️ PINNED PER PLAN, exactly as `PlanDetail` pins its own seed (MOTIR-3262). The
  // default is DERIVED from the plan's shape, and a plan's item set can grow under a
  // re-read, so recomputing it per render would yank a reader between views while
  // they were reading. It is re-seeded when the plan in hand CHANGES — a new
  // `planId` — and by nothing else: not by a stale refusal, not by a revision, not
  // by a decision.
  const [view, setView] = useState<PlanViewDto>('canvas');
  const seededForPlanRef = useRef<string | null>(null);
  // Seeded from the pane's plan, so a plan watched as it is written takes its
  // default ONCE, at its first read, and neither a growing snapshot nor the
  // hand-over re-derives it (§23.13 — the view is kept).
  useEffect(() => {
    if (!paneReview || seededForPlanRef.current === paneReview.id) return;
    seededForPlanRef.current = paneReview.id;
    setView(defaultPlanView(paneReview));
  }, [paneReview]);

  // THE PANE'S REFETCH TICK. The review canvas re-reads its level on `version`
  // (`reloadKey`), and the host's `treeVersion` bumps only on an approve. While the
  // plan is written every snapshot is new data, and so is the hand-over's proposed
  // read, which may carry a batch the last tick missed — so a new item set bumps
  // the tick while the pane is live or leaving live. A proposed plan's own re-reads
  // are not counted, exactly as before.
  const paneItems = paneReview?.items ?? null;
  const [paneTick, setPaneTick] = useState<{
    items: typeof paneItems;
    live: boolean;
    tick: number;
  }>({ items: paneItems, live: paneLive, tick: 0 });
  if (paneItems !== paneTick.items || paneLive !== paneTick.live) {
    const bump = paneItems !== paneTick.items && (paneLive || paneTick.live);
    setPaneTick({ items: paneItems, live: paneLive, tick: paneTick.tick + (bump ? 1 : 0) });
  }

  // WHERE Decline's confirm band is up, and where the last press came from — the stale
  // refusal is said beside the verbs it refused (Panel 5). Local UI state: it describes
  // this surface, not the plan.
  const [declineFrom, setDeclineFrom] = useState<PlanDecisionPlace | null>(null);
  const [pressFrom, setPressFrom] = useState<PlanDecisionPlace>('bar');
  // WHICH decision is in flight: `deciding` covers both, and only an approve has a
  // progress surface to show (MOTIR-5249).
  const [decisionKind, setDecisionKind] = useState<'approve' | 'decline' | null>(null);
  const approveFrom = useCallback(
    (place: PlanDecisionPlace) => {
      setPressFrom(place);
      setDeclineFrom(null);
      setDecisionKind('approve');
      void approve();
    },
    [approve],
  );
  const discardNow = useCallback(() => {
    setDecisionKind('decline');
    void discard();
  }, [discard]);
  const confirmDecline = useCallback(
    (noteMd: string | null) => {
      setPressFrom(declineFrom ?? 'bar');
      setDecisionKind('decline');
      void (async () => {
        await discard(noteMd);
        setDeclineFrom(null);
      })();
    },
    [discard, declineFrom],
  );
  const staleRefusedAt = state.errorCode === 'stale' ? pressFrom : null;
  // A turn found the plan in hand OUT OF DATE (MOTIR-7932; design state 10): the bar
  // keeps its place without its verbs until Plan it again replaces the plan.
  const planIsStale =
    Boolean(state.stalePlan) &&
    !state.stalePlan?.outcome &&
    state.stalePlan?.planId === (state.review?.id ?? state.planId);

  // WHAT APPROVE SAYS WHILE IT RUNS (MOTIR-5249; design Part XXV), derived ONCE and
  // handed to both doors. Running: both doors show it, and only the pressed one is the
  // live region, so one press is read once (§25.10). Timed out: only the pressed door
  // shows the band, where the stale band would stand (§25.2). The count is the review's
  // own; the sentence says "changes" as soon as anything is not an add (§25.8).
  const approveRunning = deciding && decisionKind === 'approve';
  const approveTimedOut = state.errorCode === 'timedOut' && !deciding;
  const progressKind = index.counts.changed + index.counts.removed > 0 ? 'changes' : 'adds';
  const progressCount = state.review?.itemCount ?? 0;
  const approveProgressAt = (place: PlanDecisionPlace): PlanApproveProgressView | null =>
    approveRunning
      ? {
          state: 'running',
          count: progressCount,
          kind: progressKind,
          announce: pressFrom === place,
        }
      : approveTimedOut && pressFrom === place
        ? { state: 'timedOut', count: progressCount, kind: progressKind }
        : null;

  // The VETO the overlay consults. Writing it into a ref rather than passing a
  // boolean up keeps the decision here, next to the state it reads, and keeps
  // the overlay's `requestClose` a single function with a single caller shape.
  useEffect(() => {
    if (!closeGuardRef) return;
    closeGuardRef.current = () => {
      if (bypassRef.current) return true;
      if (!guarded) return true;
      setGuardOpen(true);
      return false;
    };
    return () => {
      closeGuardRef.current = null;
    };
  }, [closeGuardRef, guarded]);

  // ⚠️ TWO VECTORS ARE DELIBERATELY NOT GUARDED, and the design says why
  // (`design/ai-chat/design-notes.md` § *Opening & exiting* → *The
  // CLOSE-WITH-PENDING guard*, the vector table):
  //
  //   · A RELOAD or a TAB CLOSE gets no `beforeunload`. A browser's own "leave
  //     site?" dialog cannot carry these three actions, so it would be a strictly
  //     worse version of this one — and it fires on every reload whether or not
  //     there is anything to lose.
  //   · A STREAMING TURN is not guarded. The predicate needs a `review`, and a
  //     stream has none yet, so there is no proposal to lose; closing calls the
  //     conversation's `stop` and the turn is abandoned, which is exactly what
  //     navigating away from the route did.
  //
  // Both are the ABSENCE of code, which is why they are written down: an absence
  // reads as an oversight unless somebody says it was chosen.

  // ⚠️ *Keep planning* is also what `Esc` and the scrim mean ON THE GUARD: the
  // safe answer is the one that loses nothing. After a browser BACK the address
  // has already dropped the overlay, so the overlay puts it back.
  const keepPlanning = useCallback(() => {
    closeAfterApproveRef.current = false;
    setGuardOpen(false);
    onKeepPlanningAfterBack?.();
  }, [onKeepPlanningAfterBack]);

  const discardAndClose = useCallback(() => {
    void (async () => {
      await discard();
      setGuardOpen(false);
      closeBypassingGuard();
    })();
  }, [discard, closeBypassingGuard]);

  // Arms the close and starts the write. Never closes with the approve IN
  // FLIGHT: every action is disabled while `deciding`, and the close happens in
  // `onApproved` above — which fires on success and on nothing else.
  const confirmAndClose = useCallback(() => {
    closeAfterApproveRef.current = true;
    void approve();
  }, [approve]);

  // ⚠️ NO `Esc` LISTENER HERE. It was removed with the route (MOTIR-4729): the
  // dialog owns the key, and the handler that stood here — yielding to a focused
  // field, to `document.fullscreenElement` and to a `defaultPrevented` event —
  // was the second of the two the run modal's design warned about
  // (`design/runs/design-notes.md`: *"a full-screen canvas inside a dialog is
  // exactly where two `ESC` handlers collide. The dialog's must win"*).

  return (
    <PlanningWorkspace
      // ⚠️ THE CHROME-FITTED VARIANT (MOTIR-4729). `PlanningWorkspace`'s default
      // is `h-dvh w-full`, which is right for a component that IS the viewport.
      // Inside the dialog it is not: the panel is already `h-dvh`, and a second
      // `h-dvh` child of it overflows by whatever the panel's own box costs. The
      // variant its own docstring offers is exactly this case.
      className="h-full w-full"
      // THE RESIZABLE SPLIT (MOTIR-6250), opt-in — this host is its ONE consumer.
      // `state.review` is non-null exactly when a plan has been PROPOSED, which is
      // the transition the reset fires on; it is the workspace's own state rather
      // than a route change, so it covers a plan watched as it is written.
      resizable
      // The PANE's plan, so the reset fires when a plan first appears — its first
      // live read — and not again at the hand-over, where nothing resizes (§23.13).
      proposalPresent={paneReview !== null}
      canvas={
        <div className="flex h-full min-h-0 flex-col bg-(--el-canvas)">
          {/* The shell's own exit chrome + project crumb. The canvas keeps its
              own top-left breadcrumb and top-right search/zoom overlays, so this
              sits ABOVE the canvas rather than over them. */}
          <div className="flex items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2">
            <OverlayExitButton onClose={close} label={t('close')} escLabel={t('escKey')} />
            <span className="truncate text-sm font-semibold text-(--el-text)">{projectName}</span>
          </div>

          {/* The audit-coverage banner sits in the seam BETWEEN the top bar and
              the panes, full-bleed and unpadded (design/audit-coverage §1). It
              must not be wrapped in a padded container — the full bleed is the
              design. It renders nothing at all for a non-admin, or when every
              connected repo has a report, and reserves no gap when absent. */}
          {canManage ? <AuditCoverageBanner /> : null}

          {/* ⭐ THE BODY AND THE BAR — one box, and the bar FLOATS OVER IT
              (Subtask MOTIR-6186; `design/ai-planning/design-notes.md` Part XXI 21.8).
              ────────────────────────────────────────────────────────────────
              ⚠️ THIS REPLACES MOTIR-1815's FIX RATHER THAN REVERTING IT, and the
              distinction is the whole of this block. That bug was: the bar was a
              `shrink-0` SIBLING below this `min-h-0 flex-1` box, so a bar that
              mounted and unmounted grew and shrank the box by its full height on
              every proposal — and the canvas anchors three control clusters to the
              bottom of the box (the engine's zoom + fit at `bottom-4 left-4`, LOCATE
              at `bottom-4 left-[8.25rem]`, full-screen at `right-3 bottom-4`), so
              all three slid. The fix that shipped was to keep a RESTING FOOTER in the
              slot at all times, which held the box constant by always spending the
              space.

              The resting footer is gone: when there is nothing to show, the footer
              hides. So the box is held constant a better way — it is ALWAYS the full
              remainder of the pane, and the bar is absolutely positioned over its
              bottom edge. Nothing resizes, in either direction, and the space is only
              ever drawn into when there is something to draw.

              `--canvas-foot-inset` is what keeps the clusters off the bar. It is set
              UNCONDITIONALLY — not only while the bar is up — because a value that
              came and went would move them exactly as the old sibling did. The
              canvases read it with a `0px` fallback, so every other surface
              (`/roadmap`, the plan page) is untouched.

              The canvas itself still mounts UNCONDITIONALLY (MOTIR-2069): it reads its
              own root level, so it — not the page — knows whether there is anything to
              draw, and its skeleton and empty statement fill the same box as a drawn
              level. */}
          <div
            ref={paneRef}
            // The pane's width is what the follow control reads to go compact
            // (§28.3 A10: below 32rem the glyph alone).
            className="@container/plan-pane relative min-h-0 flex-1 overflow-hidden"
            style={{ '--canvas-foot-inset': PLAN_CONFIRM_BAR_HEIGHT } as CSSProperties}
          >
            {paneReview !== null ? (
              <PlanProposalViews
                // ONE key per PLAN: the instance mounted at the first live read is
                // the one that shows the proposed plan (§23.13).
                key={paneReview.id}
                items={paneReview.items}
                edgeCoverage={paneReview.edgeCoverage}
                outcome={paneLive ? null : state.decided}
                projectKey={projectKey}
                version={treeVersion + paneTick.tick}
                ariaLabel={t('canvasAria', { project: projectName })}
                view={view}
                onViewChange={setView}
                // The surface opts IN, and the plan page does not (21.7). A reader
                // who drills the canvas, reads the List and comes back is returned
                // to the level they were on.
                preserveCanvasLevel
                // The hand-off: open where the reader was, already marked as having
                // navigated, so the pending request is DECLINED into the bar's
                // offer rather than granted as a move.
                //
                // A pane that mounts LIVE opens where the roadmap stood (§23.2,
                // §23.8): the reader's own level, else the level the surface
                // arrived on — never the root because nothing is proposed yet. It
                // is a mount-time seed, so the value it takes later is ignored.
                canvasHeldTrail={
                  canvasHeldTrail ??
                  (paneLive && initialCanvasTrail && initialCanvasTrail.length > 0
                    ? initialCanvasTrail
                    : null)
                }
                followTo={paneFollowTo}
                // While live the canvas is driven (MOTIR-8594): every new key is
                // honoured, and the person's own navigation turns following off.
                followMode={drivenPane && paneLive ? 'whileOn' : undefined}
                onReaderNavigated={drivenPane && paneLive ? followReaderNavigated : undefined}
                followControl={followControl}
                followLevelId={
                  drivenPane && paneLive && drive.held ? drive.held.levelId : undefined
                }
                progressReading={paneReading}
                readerHasNavigated={readerHasNavigated}
                onCanvasLevelChange={noteReaderLevel}
                live={paneLive}
                liveFailing={state.liveFailing}
                // The progress line (MOTIR-7829) — on the review's own `progress`,
                // which is null once the plan leaves `generating` (the hand-over).
                progress={paneReview.progress ?? null}
                progressFailing={state.liveFailing}
                discarded={paneDiscarded}
                // The plan BESIDE the reader's level offers the trip (MOTIR-6223).
                offerPlanElsewhere
              />
            ) : openingNamedSession ? (
              <div className="h-full w-full" data-testid="planning-pane-opening" aria-busy>
                <PlanningCanvasSkeleton />
              </div>
            ) : (
              <PlanChangeCanvas
                projectKey={projectKey}
                diffKey={diffKey}
                targetIds={targetIds}
                // The canvas's Set as target / Remove target (MOTIR-6898) — on
                // here, and only here: the proposed-plan pane above draws no
                // target action (its cards are proposals, or committed cards seen
                // through a plan under review).
                onToggleTarget={toggleCanvasTarget}
                canAddTarget={targets.length < MAX_PLANNING_TARGETS}
                initialTrail={initialCanvasTrail}
                // MOTIR-6154/6161's follow-move. It stays on THIS branch of the
                // swap and is not passed to the component above: the follow moves
                // the roadmap canvas inside a target that settles while there is no
                // plan yet, and once a plan is PROPOSED the pane is the plan page's
                // component, which does its own arriving (`arrivalLevel`).
                followTo={followTo}
                onLevelChange={noteReaderLevel}
                ariaLabel={t('canvasAria', { project: projectName })}
                loadingFallback={<PlanningCanvasSkeleton />}
                emptyRoot={
                  <EmptyState
                    icon={<Map className="h-12 w-12" aria-hidden />}
                    title={t('emptyCanvasTitle')}
                    description={t('emptyCanvasDescription')}
                  />
                }
              />
            )}

            {/* THE GATE, over the body's bottom edge. Shown only while a proposal is
                PENDING (MOTIR-3162: a review survives its decision, so "there is a
                review" does not mean "there is a decision to take" — `state.decided`
                is what does). When there is nothing to decide there is NOTHING HERE:
                the footer hides, and the body runs to the pane's edge. */}
            {/* While the plan is WRITTEN the foot is empty (§23.1), even over a
                pending proposal a retry kept: the pane shows the plan being
                written, and its bar is not that plan's. */}
            {pending && !paneLive ? (
              <div className="absolute inset-x-0 bottom-0 z-20">
                <PlanChangeConfirmBar
                  index={index}
                  deciding={state.phase === 'deciding'}
                  onApprove={() => approveFrom('bar')}
                  onDiscard={discardNow}
                  view={gateView}
                  declining={declineFrom === 'bar'}
                  onRequestDecline={() => setDeclineFrom('bar')}
                  onCancelDecline={() => setDeclineFrom(null)}
                  onConfirmDecline={confirmDecline}
                  staleRefused={staleRefusedAt === 'bar'}
                  approveProgress={approveProgressAt('bar')}
                  stale={planIsStale}
                />
              </div>
            ) : null}

            {requirementPane ? (
              <div
                key={requirementPane.turnId}
                role="region"
                aria-label={t('requirementPane.label')}
                data-layer="requirement"
                data-testid="requirement-pane"
                className="absolute inset-0 z-30 overflow-y-auto bg-(--el-page-bg) px-8 py-6"
              >
                {requirementPane.requirement ? (
                  <RequirementDocument
                    requestMd={requirementPane.requestMd}
                    requirement={requirementPane.requirement}
                    workItemRefs={state.session?.workItemRefs ?? {}}
                  />
                ) : (
                  <RequirementNotice />
                )}
              </div>
            ) : null}
          </div>
        </div>
      }
      guard={
        // THE CLOSE-WITH-PENDING GUARD (MOTIR-4731), over the whole workspace.
        // Rendered HERE because the state it reads is here; raised by the VETO
        // above, which the overlay's one `requestClose()` consults.
        <PlanCloseGuard
          open={guardOpen}
          count={pendingCount}
          deciding={deciding}
          onKeepPlanning={keepPlanning}
          onDiscard={discardAndClose}
          onConfirm={confirmAndClose}
        />
      }
      chat={
        <PlanChangeRail
          launch={launch}
          projectName={projectName}
          {...(justReturnedFromOnboarding ? { justReturnedFromOnboarding: true } : {})}
          {...(initialDraft ? { initialDraft } : {})}
          {...(autoSendTurn
            ? { autoSendTurn, autoSendKey: autoSendKey !== undefined ? autoSendKey : seedGateId }
            : {})}
          {...(seedDraft
            ? { initialDraft: seedDraft.text, initialDraftCaret: seedDraft.caret }
            : {})}
          {...(seedSend
            ? {
                autoSendTurn: seedSend.body,
                autoSendKey: debugAutoSendKey(seedSend.anchorKey),
                autoSendIntoThread: true,
                onAutoSend: sendSeeded,
              }
            : {})}
          {...(followUp ? { followUp } : {})}
          {...(guideOrigin ? { guideOrigin } : {})}
          state={state}
          index={index}
          targets={targets}
          onAddTarget={addTarget}
          onRemoveTarget={removeTarget}
          onSend={sendTargeted}
          onRetry={retry}
          onCorrectTurn={correctTurn}
          onApprove={() => approveFrom('rail')}
          onDiscard={discardNow}
          onStop={stop}
          onStartNewSession={() => void startCopied()}
          onRequestRestart={() => void requestRestart()}
          onAnswerRestart={(answer) => void answerRestartConfirm(answer)}
          // THE PLAN OFFER on an answer turn (MOTIR-9294): the doors decide what a
          // press starts; the hook refetches and follows.
          onConfirmPlanOffer={(turnId) => void confirmPlanOffer(turnId)}
          onDeclinePlanOffer={(turnId) => void declinePlanOffer(turnId)}
          offerAnsweringTurnId={state.offerAnsweringTurnId ?? null}
          offerRefusal={state.offerRefusal ?? null}
          providerLimit={railProviderLimit}
          onAnswerRunPause={(choice) => void answerRunPause(choice)}
          // THE CARRY (MOTIR-7932): the hook routes an ended session's send to it, and
          // its swap re-keys the address through `onRestarted`, the restart's path.
          onCarrySend={sendTargeted}
          onPlanAgain={() => void planAgain()}
          // RESUME a failed attempt (MOTIR-7918): its starter or a project manager (panels 3b / 3c).
          // A session of the viewer's own, or one the server did not name a starter for, is theirs.
          onResume={() => void resume()}
          canResume={state.reopened?.mine !== false || canManage}
          onShowEarlierNarration={() => void showEarlierNarration()}
          {...(onOpenSession ? { onOpenSession } : {})}
          gateView={gateView}
          declining={declineFrom === 'rail'}
          onRequestDecline={() => setDeclineFrom('rail')}
          onCancelDecline={() => setDeclineFrom(null)}
          onConfirmDecline={confirmDecline}
          staleRefused={staleRefusedAt === 'rail'}
          approveProgress={approveProgressAt('rail')}
          conversationElsewhere={conversationElsewhere}
        />
      }
    />
  );
}

/**
 * The harness an MCP-authored plan's conversation happened in, for the session
 * that opened here with NO turns (MOTIR-6298; design §23.11) — latched per
 * session id so it survives the turns sent after it. `null` for a hosted plan
 * (`authorSource` other than `mcp`), a plan with no recorded harness, and a
 * session that already held turns when its plan was read.
 */
function useConversationElsewhere(state: PlanChangeConversationState): { harness: string } | null {
  const sessionId = state.session?.id ?? null;
  const plan = state.liveReview ?? state.review;
  const harness =
    sessionId !== null &&
    (state.session?.turns.length ?? 0) === 0 &&
    plan?.authorSource === 'mcp' &&
    plan.authorHarness
      ? plan.authorHarness
      : null;
  const [latched, setLatched] = useState<{ sessionId: string; harness: string } | null>(null);
  // Adjusting state while rendering (React's documented pattern for a value
  // derived from a transition): the latch is set in the same render that first
  // sees the zero-turn MCP plan, so the note never flashes in a frame late.
  if (
    harness !== null &&
    sessionId !== null &&
    (latched?.sessionId !== sessionId || latched.harness !== harness)
  ) {
    setLatched({ sessionId, harness });
  }
  if (harness !== null) return { harness };
  return latched !== null && latched.sessionId === sessionId ? { harness: latched.harness } : null;
}
