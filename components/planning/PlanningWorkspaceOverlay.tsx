'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';
import { PlanHistoryProvider } from '@/components/planning/PlanHistorySection';
import { PlanningWorkspaceSkeleton } from '@/components/planning/PlanningWorkspaceSkeleton';
import { PlanningReadingState } from '@/components/planning/PlanningReadingState';
import { PlanningHandOff } from '@/components/planning/PlanningHandOff';
import {
  PlanningIndexingWait,
  type IndexingWaitPhase,
} from '@/components/planning/PlanningIndexingWait';
import { useProjectAccess } from '@/app/(authed)/_components/ProjectAccessProvider';
import {
  parsePlanningOverlay,
  withoutPlanningOverlay,
  withPlanningOverlay,
  OVERLAY_PARAM_NAMES,
  PLANNING_RETURN_PARAM,
  type PlanningLaunch,
  type PlanningLaunchContext,
} from '@/lib/planning/launcher';
import { resolvePlanningHostGate } from '@/lib/planning/workspaceHost';
import { fetchPlanningAnchor } from '@/lib/planning/planningAnchorClient';
import { fetchPlanningSeed } from '@/lib/planning/planningSeedClient';
import { useGuideOfferSeed } from '@/components/planning/useGuideOfferSeed';
import { GUIDE_AUTO_SEND_PREFIX, guideWorkspaceLaunch } from '@/lib/planning/guideOfferLaunch';
import type { PlanningSeedPickDTO } from '@/lib/dto/planningSeed';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { useCoordinatedRefresh } from '@/lib/navigation/coordinatedRefresh';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { surfaceArrivalTrail } from '@/lib/planning/surfaceArrival';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import type { OnboardingSubstrate } from '@/lib/dto/onboardingSubstrate';
import {
  ONBOARDING_ROUTING_REFUSAL,
  type OnboardingRoutingVerdict,
} from '@/lib/dto/onboardingRouting';
import { resolveOnboardingRouting } from '@/lib/planning/onboardingRoutingClient';
import { handoffDestination } from '@/lib/planning/onboardingHandoff';
import {
  anyRepositoryIndexed,
  fetchPlanningSubstrate,
  SUBSTRATE_POLL_CEILING_MS,
  SUBSTRATE_POLL_INTERVAL_MS,
} from '@/lib/planning/substratePoll';

// THE PLANNING WORKSPACE OVERLAY (MOTIR-4729, under story MOTIR-4725) — the
// workspace as a full-screen layer over whatever authed page is open, which is
// what `design/ai-chat/design-notes.md` § *Opening & exiting — a full-screen
// overlay ON TOP of the app (sheet 6)* has specified since MOTIR-1193 and what
// the `(planning)` ROUTE could not be.
//
// ⚠️ THE OPEN STATE IS THE ADDRESS, AND IS HELD NOWHERE ELSE. It is open when
// `parsePlanningOverlay` finds the overlay's four namespaced parameters in the
// query (MOTIR-4728), and it closes by writing them away. `RunsIndex.tsx`
// derives `openRunId` the same way, and the property is what buys the two things
// this story promises for free: **browser Back closes it** (a `popstate` changes
// what `useSearchParams` reports, and no code has to notice), and no second
// source of truth can ever disagree with the address bar.
//
// ⚠️ IT IS THE SHIPPED `Modal`, NOT A HAND-ROLLED OVERLAY. Focus trapping, the
// Escape key and focus RETURN are the parts of an overlay that go wrong quietly,
// and the product has paid to get them right once. `size="full"` +
// `rounded-none border-0 p-0` is the EDGE-TO-EDGE composition the design
// measured and chose over an inset (it would cost the canvas 48px in each axis
// at every viewport, on the surface with the most canvas need); `hideClose`
// suppresses the dialog's own corner ✕, because the host renders its Close
// top-left and two Closes in one dialog is a question the reader should never be
// asked.
//
// ⚠️ THE ORB SITS BEHIND THE SCRIM, and it needs no code. `PlanWithAIFab` is
// `fixed … z-40`; `Dialog.Overlay` is `fixed inset-0 z-40` and is PORTALLED, so
// it comes later in the document and wins the tie — the orb is dimmed and inert
// with the rest of the app, which is what "the app stays mounted, dimmed +
// inert, behind it" means. `Dialog.Content` is `z-50`, above both. The run modal
// lands in exactly the same place for the same reason.
//
// ⚠️ EVERY CLOSE GOES THROUGH `requestClose()`. Close, Escape, the scrim and the
// history pop all land on that one function, because the close-with-pending
// guard (MOTIR-4731) intercepts exactly it. The seam is the deliverable; the
// behaviour behind it is that card's.
//
// ── What the ROUTE did on the server, this does in the browser ──────────────
//
//   session + 2FA + re-consent  → inherited: `app/(authed)/layout.tsx` runs both
//                                 ahead of `children`, and this is a child.
//   the active project           → props, from the layout that already has it.
//   canBrowse / the admin gate   → `useProjectAccess()`. The provider IS mounted
//                                 in `(authed)`, which is the whole reason the
//                                 page had to pass `canManage` by prop.
//   `resolvePlanningHostGate`    → reused as-is (it is pure).
//   the anchor + its ancestors   → `fetchPlanningAnchor` over HTTP (MOTIR-4727),
//                                 because a client island may not reach a service.
//
// ── PAGE STATE AFTER A MUTATION (`motir-core/CLAUDE.md`) ────────────────────
// An approve commits work items, so the page BEHIND the overlay is stale the
// moment the reader closes it. The host brings its own surfaces current without a
// route refresh — a `treeVersion` tick for the canvas, which is a client island
// seeded once, and a Workbench reread for the Workbench behind (MOTIR-8576). The host page
// underneath gets the SAME split and it is not this component's to bump: a
// backlog's `IssueTreeTable` and a board's `BoardContainer` are islands that
// watch `CreateIssueProvider.issuesChangedAt`, so a story that has the overlay
// commit work items behind an open board owes that tick. Nothing here seeds them,
// and `router.refresh()` alone will not reach them.

export interface PlanningWorkspaceOverlayProps {
  /** The active project's `MOTIR`-style key. */
  projectKey: string;
  projectName: string;
  /**
   * WHAT THIS PROJECT ALREADY HAS, resolved once by the layout (MOTIR-4768) —
   * the values the READING state names on screen.
   *
   * ⚠️ `null` MEANS ESTABLISHED, AND IT IS NOT A GATE. A project whose first
   * plan has been approved has no reading state to show, and pays for no read
   * either — the layout does not ask. A never-onboarded project opens this
   * workspace exactly as an established one does (MOTIR-4765); this prop only
   * decides what it SAYS while it opens.
   *
   * ⚠️ IT ARRIVES AS A PROP RATHER THAN A FETCH. This component is a client
   * island and may not reach a service; more to the point, it must add no
   * request to its own open — the layout already had the project in hand.
   */
  substrate: OnboardingSubstrate | null;
}

// ⚠️ THERE IS NO `onboardingRanAt` PROP, AND THAT IS THE DELIBERATE SHAPE
// (MOTIR-4765). It used to arrive from `app/(authed)/layout.tsx` for one reason:
// to feed `resolvePlanningHostGate`, which answered `'onboarding'` and made this
// component `router.push` the reader out of the window they had just opened. The
// marker says *"has never had a plan APPROVED"* — not *"has never planned"* — so
// that ejected established, code-bearing projects. Whether this project can be
// planned is the planner's judgement now (MOTIR-4767), made INSIDE the session
// this component hosts, and the surface that acts on it is MOTIR-4769's. The
// prop is gone rather than unused so nothing can quietly re-derive a wall from
// it.

/**
 * What the anchor read SETTLED on, and for which key.
 *
 * There is no `loading` member on purpose: the pending state is DERIVED at
 * render (`settled.key !== anchorKey`), never written in the effect. That is the
 * quick view's own shape and it is what keeps this out of
 * `react-hooks/set-state-in-effect` — a synchronous `setState` in an effect body
 * is a cascading render, and here it would also mean the previous item's chip
 * could flash under the new item's address.
 */
interface AnchorLoad {
  key: string;
  target: PlanningTarget | null;
  trail: CanvasCrumb[];
}

/**
 * What the REFUSAL SEED read settled on, and for which gate (story MOTIR-6068 ·
 * MOTIR-6210). Pending is DERIVED (`seed.gateId !== gateId`), exactly as the
 * anchor read's is, so nothing is written synchronously in the effect.
 *
 *  · `seeded`   — a gate the viewer may read, with no recent seeded session. A
 *                 REFUSAL (`intent: 'replan'`) opens a `work-item` re-plan on its
 *                 card with the turn pre-filled and unsent; a PICK (`intent:
 *                 'plan'`, MOTIR-6435) opens forward on its anchor — the
 *                 project when `anchorKey` is null — and its turn is SENT once
 *                 for the person (`picked-option-planning-starts.md`);
 *  · `resume`   — the viewer's own recent seeded session: that conversation,
 *                 resumed, with nothing drafted and nothing sent (design MOTIR-6206
 *                 sheet 7);
 *  · `fallback` — a 404 or any failure: a plain `project` launch, silently.
 *
 * `pick` rides both seeded kinds of a pick: the rail's follow-up framing.
 */
type SeedLoad =
  | {
      gateId: string;
      kind: 'seeded';
      intent: 'plan' | 'replan';
      anchorKey: string | null;
      firstTurn: string;
      pick: PlanningSeedPickDTO | null;
    }
  | {
      gateId: string;
      kind: 'resume';
      intent: 'plan' | 'replan';
      anchorKey: string | null;
      sessionId: string;
      pick: PlanningSeedPickDTO | null;
    }
  | { gateId: string; kind: 'fallback' };

/** The unseeded fall-back — exactly what *Plan with AI* on the project opens. */
const PROJECT_LAUNCH: PlanningLaunch = {
  mode: 'project',
  from: 'project',
  itemKey: null,
};

export function PlanningWorkspaceOverlay({
  projectKey,
  projectName,
  substrate,
}: PlanningWorkspaceOverlayProps) {
  const t = useTranslations('planningWorkspace');
  const ta = useTranslations('projectAccess');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { can } = useProjectAccess();
  const router = useRouter();
  const tr = useTranslations('planningWorkspace.routing');

  // The host's veto (MOTIR-4731) — see `requestClose`.
  const closeGuardRef = useRef<(() => boolean) | null>(null);

  // ⚠️ BROWSER BACK IS THE VECTOR THAT HAS ALREADY HAPPENED. Every other close
  // can be intercepted BEFORE anything changes; a history pop cannot — by the
  // time the overlay notices, the address no longer carries the workspace. So
  // when a pop takes the overlay out of the address while the host vetoes, the
  // launch is HELD: the dialog stays mounted with the guard up, over an address
  // that already says closed, and *Keep planning* re-pushes it.
  // (`design/ai-chat/design-notes.md` § *Opening & exiting* → the guard's vector
  // table.) *Discard* and *Confirm & add* let the pop stand.
  const [heldLaunch, setHeldLaunch] = useState<PlanningLaunch | null>(null);

  const addressLaunch = useMemo(() => parsePlanningOverlay(searchParams), [searchParams]);
  // The address decides, EXCEPT while a vetoed history pop is being answered.
  const launch = addressLaunch ?? heldLaunch;
  const open = launch !== null;

  // ── THE REFUSAL SEED (story MOTIR-6068 · MOTIR-6210) ─────────────────────────
  //
  // A `refused-gate` launch carries the gate's id and nothing else, so before the
  // workspace can mount it has to learn WHICH card it is about and WHAT the first
  // turn says — both from the server (`approval-gates.md` §10f: the reason never
  // rides the URL). The read runs first, the anchor read second, and both sit in
  // the ONE `PlanningWorkspaceSkeleton` window a `work-item` launch already shows
  // (design MOTIR-6206 sheet 6): no composer exists yet, so the empty re-plan
  // placeholder cannot flash, and the host mounts once with the draft in its
  // first render.
  const gateId = launch?.from === 'refused-gate' ? (launch.gateId ?? null) : null;
  const [seed, setSeed] = useState<SeedLoad | null>(null);
  // A CLOSE forgets the seed, so the next open of the same gate reads it again —
  // a send in between made a seeded session the door must now return to. Adjusted
  // during render (the state is this component's own), never in an effect.
  if (!open && seed !== null) setSeed(null);
  useEffect(() => {
    if (!open || gateId === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const found = await fetchPlanningSeed(gateId, controller.signal);
        if (controller.signal.aborted) return;
        // A REFUSAL always anchors on its own card; a null anchor on one is a
        // seed this overlay cannot place, so it falls back silently. A PICK may
        // anchor at the project (`anchorKey: null`, MOTIR-6433) and opens there.
        const placeable = found !== null && (found.intent === 'plan' || found.anchorKey !== null);
        const pick = found?.intent === 'plan' ? (found.pick ?? null) : null;
        setSeed(
          !placeable
            ? { gateId, kind: 'fallback' }
            : found.seededSessionId
              ? {
                  gateId,
                  kind: 'resume',
                  intent: found.intent,
                  anchorKey: found.anchorKey,
                  sessionId: found.seededSessionId,
                  pick,
                }
              : {
                  gateId,
                  kind: 'seeded',
                  intent: found.intent,
                  anchorKey: found.anchorKey,
                  firstTurn: found.firstTurn,
                  pick,
                },
        );
      } catch {
        if (controller.signal.aborted) return;
        // ⚠️ SILENT, like the 404 (design MOTIR-6206 sheet 8). An outage is not a
        // finding about the gate, and saying *"that refusal is not available"*
        // would confirm to someone who cannot see it that it exists.
        setSeed({ gateId, kind: 'fallback' });
      }
    })();
    return () => controller.abort();
  }, [open, gateId]);
  const settledSeed = seed !== null && seed.gateId === gateId ? seed : null;
  // ── THE GUIDE-OFFER SEED (Story MOTIR-8684 · MOTIR-8693) ─────────────────────
  // The same window, addressed by the offer's turn id: read while the skeleton shows,
  // `null` while pending, and a silent project fall-back for any seed it cannot place.
  const offerId = launch?.from === 'guide-offer' ? (launch.guideTurnId ?? null) : null;
  const guideSeed = useGuideOfferSeed(open, offerId);
  const waitingForSeed =
    (gateId !== null && settledSeed === null) || (offerId !== null && guideSeed === null);

  // The launch the WORKSPACE sees. A seeded one is resolved to the `work-item`
  // re-plan it is, on the refused card, so it goes through the SAME anchor read
  // and the SAME host mount — and arrives where any item launch arrives. The
  // gate's id is never part of it: nothing below the overlay can show one.
  const workspaceLaunch = useMemo<PlanningLaunch | null>(() => {
    if (launch?.from === 'guide-offer') return guideWorkspaceLaunch(guideSeed);
    if (launch === null || launch.from !== 'refused-gate') return launch;
    if (settledSeed === null || settledSeed.kind === 'fallback') return PROJECT_LAUNCH;
    const resumed = settledSeed.kind === 'resume' ? { sessionId: settledSeed.sessionId } : {};
    // A PICK plans FORWARD (MOTIR-6435): on its anchor as an ordinary item
    // launch, or on the project — never the re-plan posture.
    if (settledSeed.intent === 'plan') {
      return settledSeed.anchorKey === null
        ? { ...PROJECT_LAUNCH, ...resumed }
        : {
            mode: 'contextual',
            from: 'work-item',
            itemKey: settledSeed.anchorKey,
            ...resumed,
          };
    }
    return {
      mode: 'replan',
      from: 'work-item',
      itemKey: settledSeed.anchorKey,
      ...resumed,
    };
  }, [launch, settledSeed, guideSeed]);
  const anchorKey = workspaceLaunch?.itemKey ?? null;

  // The current address, as the reader's browser has it — the thing Close writes
  // back minus four parameters. Composed from the two hooks rather than read off
  // `window.location`, so it is stable across a render and safe on the server.
  const currentHref = useMemo(() => {
    const qs = searchParams.toString();
    return `${pathname}${qs ? `?${qs}` : ''}`;
  }, [pathname, searchParams]);

  // ⚠️ A GUIDE'S CLOSE RE-READS THE CARD'S PAGE — ONCE, FROM HERE (Story MOTIR-8539
  // · MOTIR-8576). A guide walks the card the reader opened it from, and its turns
  // write that card; the page underneath (the item page, server-rendered) shows
  // what the walk did only after it is read again. That re-read used to be the
  // guide host's own refresh on unmount. It belongs to the CLOSE instead — the
  // reader's own act, and this component owns every vector of it (Close, Esc, the
  // scrim, Back) — so it fires on the guide's open → closed transition and nowhere
  // else. It is the shell's COORDINATED refresh, held to one in flight (MOTIR-6640).
  // A planning workspace's close re-reads nothing: its surfaces re-read themselves.
  const refreshPage = useCoordinatedRefresh();
  const guideOpenRef = useRef(false);
  useEffect(() => {
    if (guideOpenRef.current && !open) refreshPage();
    guideOpenRef.current = open && launch?.mode === 'guide';
  }, [open, launch, refreshPage]);

  // ⚠️ FOCUS RETURN, and why it is not free here. Radix restores focus to the
  // element that had it when the dialog opened — but only when the dialog is
  // opened by its own `Trigger`. This one is opened by a URL write from a door
  // that may itself be unmounting (⌘K closes its palette; a menu row closes its
  // popover), so the element to come back to is recorded at the moment the
  // address changes and restored by hand.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (!open && wasOpenRef.current) {
      const opener = openerRef.current;
      openerRef.current = null;
      // `isConnected` because the door may have gone away with its own menu.
      if (opener?.isConnected) opener.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  /**
   * THE ONE CLOSE. Every vector routes here, and the pending guard (MOTIR-4731)
   * wraps exactly this function.
   *
   * `shallowPush`, never `router.push`: the destination body is already in the
   * browser — it is the page that never unmounted — so a server round trip would
   * re-render a page to show what is already on screen, and would throw away the
   * scroll position and the client islands this story exists to preserve
   * (`CLAUDE.md` § *URL state the CLIENT reads is written with `shallowPush`*).
   */
  // A History open the close guard held (MOTIR-9308) — see `openSession`.
  const pendingSwitchRef = useRef<PlanningLaunchContext | null>(null);
  const requestClose = useCallback(() => {
    // ⚠️ THE HOST MAY VETO (MOTIR-4731). It writes a predicate into this ref: a
    // `false` means it has raised the close-with-pending guard and the workspace
    // must stay. Every vector runs through here, so the guard is asked exactly
    // once per close attempt and there is no vector it can miss.
    if (closeGuardRef.current && !closeGuardRef.current()) return;
    setHeldLaunch(null);
    // A HISTORY OPEN the guard held (MOTIR-9308): the guard's own answer closes
    // through here, and what was asked for was the other conversation, not a close.
    const switchTo = pendingSwitchRef.current;
    pendingSwitchRef.current = null;
    shallowPush(
      switchTo ? withPlanningOverlay(currentHref, switchTo) : withoutPlanningOverlay(currentHref),
    );
  }, [currentHref]);

  /**
   * OPEN A PAST CONVERSATION from the rail's History (Story MOTIR-9218 · MOTIR-9308)
   * — the shipped named reopen, `planSession=<id>`, written the way Close writes:
   * one `shallowPush`, so the overlay stays mounted and Back returns to the
   * conversation it came from. An anchored session opens on its first key (the two
   * origins that carry `planSession` are `work-item` and `project`), and no
   * `planVia` is written: the reopened line's default.
   *
   * It leaves the conversation on screen, so it asks the SAME guard a close asks.
   * A veto parks the switch; the guard's Discard or Confirm then completes it
   * through `requestClose`, and Keep planning drops it.
   */
  const openSession = useCallback(
    (sessionId: string, targetKeys: readonly string[]) => {
      const itemKey = targetKeys[0];
      const target: PlanningLaunchContext = itemKey
        ? { kind: 'work-item', itemKey, sessionId }
        : { kind: 'project', sessionId };
      if (closeGuardRef.current && !closeGuardRef.current()) {
        pendingSwitchRef.current = target;
        return;
      }
      pendingSwitchRef.current = null;
      shallowPush(withPlanningOverlay(currentHref, target));
    },
    [currentHref],
  );

  // ⚠️ THE POP HOLD. `popstate` fires AFTER the browser has already navigated,
  // so this reads the address as it now stands: if the overlay has left it and
  // the host vetoes, the launch is held and the guard asks over a workspace
  // whose address already says closed. Registered as a real listener rather than
  // derived, because a pop is an EVENT and setting state from an event handler
  // is exactly what React allows (deriving it in an effect body is the
  // cascading render `react-hooks/set-state-in-effect` forbids).
  const launchRef = useRef<PlanningLaunch | null>(null);
  useEffect(() => {
    launchRef.current = launch;
  }, [launch]);
  useEffect(() => {
    function onPopState() {
      if (new URLSearchParams(window.location.search).has(OVERLAY_PARAM_NAMES.mode)) return;
      const leaving = launchRef.current;
      if (!leaving) return;
      if (!closeGuardRef.current || closeGuardRef.current()) return;
      setHeldLaunch(leaving);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  /**
   * *Keep planning*, after a Back. The pop has happened, so the workspace is only
   * on screen because it is HELD — put its address back with ONE `shallowPush`
   * so Back means what it says again, and release the hold.
   */
  const keepPlanningAfterBack = useCallback(() => {
    // *Keep planning* also answers a guard a History open raised: nothing switches.
    pendingSwitchRef.current = null;
    const held = heldLaunch;
    if (!held) return;
    setHeldLaunch(null);
    shallowPush(withPlanningOverlay(currentHref, launchContext(held)));
  }, [heldLaunch, currentHref]);

  // ── THE GATE ───────────────────────────────────────────────────────────────
  // `no-project` cannot occur: the mount itself is behind `Boolean(activeProject)`
  // in the layout, the same gate the orb is behind. So the only verdict this
  // component actually branches on is `no-access`.
  //
  // ⚠️ AND THERE IS NO NAVIGATION HERE — not on mount, not in an effect, not for
  // any project (MOTIR-4765). The gate has no `onboarding` verdict left to fire
  // one, and a never-onboarded project OPENS the workspace exactly as an
  // established one does. A move to onboarding is something the SESSION asks for
  // once it has read the project (MOTIR-4767's verdict, honoured by MOTIR-4769),
  // shown to the reader before it happens; it is never something this component
  // does to somebody for arriving.
  const gate = resolvePlanningHostGate({
    hasActiveProject: true,
    canBrowse: can('project:browse'),
  });

  // ── THE ROUTING RUN (MOTIR-4769) ───────────────────────────────────────────
  //
  // The window has opened on a project whose first plan has never been approved
  // (that is what a non-null `substrate` means). Ask the planner ONE question —
  // can this be planned, and if not where does the user go — and hold the
  // reading state until it answers.
  //
  // ⚠️ ONE DISPATCH PER OPEN, guarded by a ref rather than by an effect
  // dependency list. A verdict acted on twice is a user moved twice, and a
  // re-render is not a new question. Returning to this surface does not re-fire
  // it either: the effect keys on `open`, and a project that has been onboarded
  // arrives with no substrate at all.
  //
  // ⚠️ AND EVERY FAILURE OPENS THE WORKSPACE. A failed job, a dead request, a
  // timeout — none of those is a finding about the project, and turning one into
  // a hand-off would move a user on the strength of a network error. The client
  // collapses all of them to `none` and this branch treats `none` as *carry on*.
  const [routed, setRouted] = useState<OnboardingRoutingVerdict | 'clear' | null>(null);
  const routingAskedRef = useRef(false);
  /**
   * ASK AGAIN — a monotonic counter, bumped by the two things that legitimately
   * re-open the question (MOTIR-4829): the index landing, and *Try again*.
   *
   * ⚠️ A REF ALONE CANNOT DO THIS, and that is why the counter exists. Clearing
   * `routingAskedRef` does not re-run the effect — a ref is not a dependency —
   * so the guard would be released and nothing would fire. This is the provider
   * TICK shape (`CLAUDE.md` § page state after a mutation, case 3) at component
   * scope: a value the effect WATCHES, bumped by whatever has new information.
   */
  const [routingAttempt, setRoutingAttempt] = useState(0);
  // ⚠️ AND NOT ON THE WAY BACK (MOTIR-4770). A user returning from onboarding was
  // routed thirty seconds ago and has just done what they were sent to do;
  // reading them again and possibly routing them again is the loop this marker
  // exists to prevent. It rides the address onboarding returns to and is
  // stripped by Close with the overlay's own parameters, so it cannot linger.
  const justReturned = searchParams.get(PLANNING_RETURN_PARAM) !== null;
  useEffect(() => {
    if (!open || substrate === null || justReturned || routingAskedRef.current) return;
    routingAskedRef.current = true;
    const controller = new AbortController();
    let answered = false;
    void (async () => {
      const resolution = await resolveOnboardingRouting({ signal: controller.signal });
      if (controller.signal.aborted) return;
      answered = true;
      if (resolution.kind === 'none') return setRouted('clear');
      if (!resolution.read.ok) {
        // A MALFORMED verdict is declined, not guessed at: the safe route is the
        // one outcome with no precondition, and it is taken with Motir's own
        // copy rather than in the planner's voice about a project it did not
        // read. `motir-ai` carries the same discipline for its own refusals.
        return setRouted({
          outcome: ONBOARDING_ROUTING_REFUSAL,
          message: tr('refusalMessage'),
        });
      }
      const { verdict } = resolution.read;
      // `continue` — the substrate answers what planning needs. Nothing was
      // planned and nothing should be: the window becomes an ordinary planning
      // session and the planner asks (Yue, 2026-09-07).
      setRouted(verdict.outcome === 'continue' ? 'clear' : verdict);
    })();
    return () => {
      controller.abort();
      // ⚠️ AN ASK ABORTED BEFORE IT ANSWERED WAS NEVER ASKED (MOTIR-9414). The
      // cleanup runs on ANY dependency change — a route refresh hands `substrate`
      // a new identity — and the run that follows it must be free to ask again,
      // or the window holds the reading state for good. An answered ask keeps the
      // guard: that is the one-dispatch-per-open rule above.
      if (!answered) routingAskedRef.current = false;
    };
  }, [open, substrate, justReturned, tr, routingAttempt]);

  // ── THE WAIT (MOTIR-4829) ──────────────────────────────────────────────────
  //
  // `wait_for_index` is the one outcome with nowhere to send anybody: the
  // repository is connected, its graph does not exist yet, Motir has started
  // building it, and the person plans when it lands. So the window HOLDS them,
  // says what is happening, and moves on by itself.
  //
  // ⚠️ THE FINISH NEEDS A POLL, AND THE CHOICE IS EXPLAINED RATHER THAN
  // DEFAULTED. This overlay is a `'use client'` island seeded from server props;
  // `router.refresh()` re-runs the server read and the island never sees it
  // (`CLAUDE.md` § page state after a mutation, case 3). The two instruments
  // that DO reach an island are a provider TICK and a refetch — and a tick needs
  // something in this browser to bump it, while the event being waited on
  // happens in a background job on another machine. So the island asks.
  // The verdict itself when it is the wait, narrowed ONCE so the JSX below reads
  // a value rather than re-deriving the same three conditions.
  const waitVerdict =
    routed !== null && routed !== 'clear' && routed.outcome === 'wait_for_index' ? routed : null;
  const waiting = waitVerdict !== null;
  const [waitPhase, setWaitPhase] = useState<IndexingWaitPhase>('queued');
  const [waitCleared, setWaitCleared] = useState(false);
  useEffect(() => {
    if (!waiting || waitCleared) return;
    let cancelled = false;
    const controller = new AbortController();
    const startedAt = Date.now();
    // The first tick is what turns `queued` into `running`: the wait is real by
    // then, and the two wordings differ so somebody who came back can tell
    // whether anything has moved.
    const tick = async (): Promise<void> => {
      const fresh = await fetchPlanningSubstrate({ signal: controller.signal });
      if (cancelled) return;
      if (anyRepositoryIndexed(fresh)) {
        // ⚠️ THE WAIT ENDED — SO ASK AGAIN, rather than deciding here. The graph
        // exists now; whether it is ENOUGH is the same judgement as before and
        // it is still the planner's (MOTIR-4828). Clearing the guard and the
        // verdict re-fires the routing effect above with the project as it now
        // stands.
        setWaitCleared(true);
        routingAskedRef.current = false;
        setRouted(null);
        setRoutingAttempt((n) => n + 1);
        return;
      }
      // ⚠️ A CEILING ON THE PROMISE, NOT ON THE INDEX. The job keeps running
      // whatever this says; what expires is the window's claim that it is about
      // to finish, because a spinner that has spun for ten minutes has stopped
      // being information.
      setWaitPhase(Date.now() - startedAt > SUBSTRATE_POLL_CEILING_MS ? 'failed' : 'running');
    };
    const id = setInterval(() => void tick(), SUBSTRATE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [waiting, waitCleared]);

  /** What Motir read, already named — the hand-off's FOUND block. */
  const readSources = useMemo(() => {
    if (substrate === null) return [];
    const named = substrate.repositories.map((r) => r.ref);
    if (substrate.itemCount > 0) {
      named.push(
        substrate.itemCountTruncated
          ? tr('sourceItemsCapped', { count: substrate.itemCount })
          : tr('sourceItems', { count: substrate.itemCount }),
      );
    }
    return named;
  }, [substrate, tr]);

  // ── THE ANCHOR READ ────────────────────────────────────────────────────────
  // Only a `work-item` launch has one. The dialog frame is up while it is in
  // flight — the skeleton renders INSIDE the dialog, which is what
  // `app/(planning)/loading.tsx` used to do for the navigation.
  const [anchor, setAnchor] = useState<AnchorLoad | null>(null);
  useEffect(() => {
    if (!open || anchorKey === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const found = await fetchPlanningAnchor(anchorKey, controller.signal);
        if (controller.signal.aborted) return;
        setAnchor({
          key: anchorKey,
          // A `null` is the no-existence-leak answer for a stale, deleted,
          // foreign or forbidden key alike — it degrades to the project
          // conversation at the root, never a dead workspace and never an error
          // surface. This is the page's own silent `catch`, one hop over.
          target: found && {
            id: found.anchor.id,
            identifier: found.anchor.identifier,
            title: found.anchor.title,
            kind: found.anchor.kind,
          },
          // INSIDE THE TARGET (MOTIR-6160, Story MOTIR-6154) — the LAST crumb is
          // the level the canvas loads, and for a container anchor that is the
          // anchor ITSELF, so the workspace opens on the anchor's CHILDREN: the
          // work the conversation is about, and where the plan's proposals land.
          //
          // ⚠️ THIS REVERSES MOTIR-2070, WHICH CHOSE THE ANCESTORS-ONLY TRAIL ON
          // PURPOSE. Its reason was real — "Opening on the anchor's CHILDREN
          // would hide the item the conversation is about" — and the answer is
          // not to dismiss it but to move the target's mark to where the target
          // now is: the LAST CRUMB, the level you are standing in, rather than a
          // ring on a node that is no longer on screen. An anchor with NO
          // children — a subtask, or a story, task or bug not yet broken down —
          // has no inside to open (MOTIR-7621), so it keeps MOTIR-2070's arrival
          // and its ring.
          //
          // The rule itself is `lib/planning/surfaceArrival.ts`, because the same
          // three entrances share it (Plan with AI, a Plans row, a To-approve
          // row) and the follow-move card calls it for a target that becomes
          // known later.
          trail: surfaceArrivalTrail({
            anchor: found?.anchor ?? null,
            ancestors: found?.ancestors ?? [],
            hasChildren: found?.hasChildren ?? false,
          }),
        });
      } catch {
        if (controller.signal.aborted) return;
        // A real failure is the same degradation as a 404. The workspace opens;
        // it is simply not scoped to the item, which is strictly better than an
        // error panel inside a planning surface.
        setAnchor({ key: anchorKey, target: null, trail: [] });
      }
    })();
    return () => controller.abort();
  }, [open, anchorKey]);

  if (!open) return null;

  // The anchor's result is only usable while it is still the key in the address:
  // a re-target swaps `anchorKey` before the new read lands, and the previous
  // item's chip must not appear under the new one's address.
  const settled = anchor !== null && anchor.key === anchorKey ? anchor : null;
  const waitingForAnchor = anchorKey !== null && settled === null;
  // The seed reaches the host only once its card RESOLVED for this viewer: a card
  // the anchor read cannot see degrades to the project conversation, and a draft
  // about it there would be a turn about nothing on screen.
  // A pick at the PROJECT has no card to resolve, so its seed reaches the host as
  // soon as the seed read settles.
  const seededFirst =
    settledSeed?.kind === 'seeded' && (settledSeed.anchorKey === null || settled?.target)
      ? settledSeed
      : null;
  // A REFUSAL pre-fills its turn, unsent; a PICK's turn is SENT once for the person.
  const seededDraft = seededFirst?.intent === 'replan' ? seededFirst : null;
  const seededSend = seededFirst?.intent === 'plan' ? seededFirst : null;
  const resumedSeed = settledSeed?.kind === 'resume';
  // EXPAND STARTS THE CONVERSATION (MOTIR-7973; design MOTIR-7875). A `planStart`
  // launch sends `Plan <KEY>` once, for the person — only once its anchor RESOLVED
  // for this viewer, because a start turn about a card the workspace degraded away
  // from would be a turn about nothing on screen. The claim key is the anchor's,
  // so a remount or a second open on this page cannot send it twice; the rail
  // sends only into a thread with no user turn, so a resumed one sends nothing.
  const startSend =
    workspaceLaunch?.startTurn && settled?.target
      ? {
          turn: t('startTurn.plan', { key: settled.target.identifier }),
          key: `start:${settled.target.identifier}`,
        }
      : null;
  // A GUIDE OFFER's request is SENT once for the person, exactly as a pick's is — and
  // only once its target RESOLVED for this viewer. A seed with a session is a named
  // reopen: it sends nothing, and the *from a guide* framing still shows.
  const guideSend = guideSeed?.kind === 'seeded' && settled?.target ? guideSeed : null;
  const guideResume = guideSeed?.kind === 'resume' ? guideSeed : null;
  // The offer was confirmed elsewhere (the server's `409 GUIDE_REPLAN_OFFER_CONFIRMED`):
  // return to the session it started — the shipped named-reopen address.
  const reopenConfirmedOffer = (sessionId: string) => {
    if (anchorKey === null) return;
    shallowPush(
      withPlanningOverlay(currentHref, { kind: 'work-item', itemKey: anchorKey, sessionId }),
    );
  };
  // The follow-up framing rides a pick's first open AND its resume.
  const followUp =
    settledSeed !== null && settledSeed.kind !== 'fallback' && settledSeed.intent === 'plan'
      ? settledSeed.pick
      : null;

  return (
    // History's expanded flag and rows outlive a host remount (MOTIR-9308).
    <PlanHistoryProvider>
      <Modal
        open
        onOpenChange={(next) => {
          // Escape and the scrim both arrive here. Radix has not closed anything
          // yet — the dialog is controlled — so this IS the interception point.
          if (!next) requestClose();
        }}
        size="full"
        srTitle={t('canvasAria', { project: projectName })}
        // At full size the dialog IS the surface, so the panel chrome comes off —
        // the run modal's line, and the design's measured decision: edge to edge,
        // 0px radius, 0px border.
        className="flex flex-col rounded-none border-0 p-0"
        // The workspace carries its own Close, top-left. See the header note.
        hideClose
      >
        {/* modal-scroll-container: measured 1280x700, tallest = the HOST with a full conversation in the rail and a drilled canvas; the full-size panel IS the viewport and the canvas, the rail and the host's exit bar each own their scroll (min-h-0 flex-1 overflow-auto), panel 700px */}
        {gate === 'no-access' ? (
          // The run modal's `missing` shape: say so, and get out of the way. Never
          // a 404 — there is no route to 404, and the page underneath is still
          // perfectly usable.
          <div className="flex flex-1 items-center justify-center p-(--spacing-card-padding)">
            <NoAccessState
              title={ta('noAccessTitle')}
              description={ta('noAccessDescription')}
              backHref="/dashboard"
              backLabel={ta('backToProjects')}
            />
          </div>
        ) : substrate !== null && waiting ? (
          // THE WAIT (MOTIR-4829) — the repository is connected and its code graph
          // is being built. TWO ELEMENTS, and they are not the same sentence twice
          // (Yue: *"with the banner and say it"*): the BANNER carries the durable
          // state, the TURN carries the planner's own reason. This branch sits
          // BEFORE the hand-off's, because `wait_for_index` has no destination and
          // `handoffDestination` refuses it outright rather than defaulting.
          <PlanningIndexingWait
            repositories={substrate.repositories.filter((r) => !r.indexed).map((r) => r.ref)}
            message={waitVerdict?.message ?? ''}
            phase={waitPhase}
            // ⚠️ RE-ENQUEUE BY RE-ASKING. The routing dispatch is what triggers a
            // first index (MOTIR-4826), so *Try again* is the same call this
            // window already makes — no second door, and no client-side opinion
            // about whether an index is warranted.
            onRetry={() => {
              setWaitPhase('queued');
              routingAskedRef.current = false;
              setRouted(null);
              setRoutingAttempt((n) => n + 1);
            }}
            // ⚠️ PLAN ANYWAY OPENS THE WORKSPACE, and that is the honest meaning of
            // the button: the person has said they would rather plan without the
            // code than keep waiting. The session is an ordinary one from here.
            onPlanAnyway={() => {
              setWaitCleared(true);
              setRouted('clear');
            }}
          />
        ) : substrate !== null && routed !== 'clear' && routed !== null ? (
          // THE HAND-OFF (MOTIR-4769) — SHOWN before the move happens, never a
          // silent redirect out from under somebody who pressed *Plan with AI*.
          <PlanningHandOff
            verdict={routed}
            sources={readSources}
            onGo={() => router.push(handoffDestination(routed, launchContext(launch)))}
            onDismiss={requestClose}
          />
        ) : substrate !== null && routed === null && !justReturned ? (
          // ⚠️ BEFORE THE ANCHOR READ, DELIBERATELY (MOTIR-4768). A never-onboarded
          // project has no plan to anchor to and nothing on the canvas to scope,
          // so waiting on `fetchPlanningAnchor` to draw the reading state would
          // put a skeleton in front of the one moment the user most needs a
          // sentence. What Motir is reading does not depend on which card the
          // reader launched from.
          //
          // It comes down when the verdict lands, above: either the user is being
          // moved, or `routed === 'clear'` and this is an ordinary workspace.
          <PlanningReadingState substrate={substrate} />
        ) : waitingForSeed || waitingForAnchor ? (
          <PlanningWorkspaceSkeleton />
        ) : (
          <PlanningWorkspaceHost
            // A DIFFERENT ANCHOR IS A DIFFERENT WORKSPACE — so remount on it. The
            // host seeds three things from its props ONCE, in `useState`
            // initializers: the canvas's arrival level, the pre-filled
            // `@`-mention target set, and the conversation the anchor scopes.
            //
            // Keyed on the anchor ALONE, deliberately: the seeds derive from
            // nothing else, so an approve's `router.refresh()` — same anchor —
            // must NOT remount and throw away the conversation and the canvas's
            // drill state. The workspace contains a door back into itself (the
            // canvas's own quick-view carries the per-item Plan / Re-plan
            // entrance), so a re-target is a same-address change that React would
            // otherwise reconcile in place, leaving the chrome saying one item
            // while the canvas sat on the level it happened to be on.
            // A GUIDE on a card is a different room from planning on it
            // (MOTIR-7466), so the mode joins the key there and only there.
            key={`${workspaceLaunch?.mode === 'guide' ? 'guide:' : ''}${anchorKey ?? 'project'}`}
            projectKey={projectKey}
            projectName={projectName}
            launch={workspaceLaunch ?? launch}
            anchorId={settled?.target?.id ?? null}
            onClose={requestClose}
            closeGuardRef={closeGuardRef}
            onOpenSession={openSession}
            onKeepPlanningAfterBack={keepPlanningAfterBack}
            // Named by the permission its own server gate asserts, not by a rank:
            // `auditCoverageService.getCoverage` asserts `ai:configure`, so that is
            // what decides whether the banner is an invitation or a 403.
            canManage={can('ai:configure')}
            initialTarget={settled?.target ?? null}
            {...(justReturned ? { justReturnedFromOnboarding: true } : {})}
            {...(seededDraft
              ? { initialDraft: seededDraft.firstTurn, seedGateId: seededDraft.gateId }
              : {})}
            {...(seededSend
              ? { autoSendTurn: seededSend.firstTurn, seedGateId: seededSend.gateId }
              : {})}
            {...(startSend ? { autoSendTurn: startSend.turn, autoSendKey: startSend.key } : {})}
            {...(guideSend
              ? {
                  autoSendTurn: guideSend.firstTurn,
                  autoSendKey: `${GUIDE_AUTO_SEND_PREFIX}${guideSend.offerId}`,
                  seedGuideTurnId: guideSend.offerId,
                  guideOrigin: guideSend.guide,
                  extraInitialTargets: guideSend.extraTargets,
                  onGuideOfferConfirmed: reopenConfirmedOffer,
                }
              : {})}
            {...(guideResume ? { guideOrigin: guideResume.guide } : {})}
            {...(followUp ? { followUp } : {})}
            {...(resumedSeed || guideResume ? { sessionIsResume: true } : {})}
            initialCanvasTrail={settled?.trail}
          />
        )}
      </Modal>
    </PlanHistoryProvider>
  );
}

/**
 * A parsed launch back as the CONTEXT that produced it — what
 * `withPlanningOverlay` needs to re-write the address after a vetoed Back.
 *
 * The mode is not carried: it is DERIVED from the context by
 * `resolvePlanningMode`, and a launch that came from a door round-trips exactly.
 * The one lossy case is `hasPlan`, which the address never carried either — a
 * `replan` launch re-pushes as its coarse origin, and the workspace it re-opens
 * is the one already on screen, so nothing the reader can see changes.
 */
function launchContext(launch: PlanningLaunch): PlanningLaunchContext {
  // A guide round-trips as itself: the card it walks is its whole context.
  if (launch.mode === 'guide' && launch.itemKey) return { kind: 'guide', itemKey: launch.itemKey };
  if (launch.from === 'work-item' && launch.itemKey) {
    return {
      kind: 'work-item',
      itemKey: launch.itemKey,
      hasPlan: launch.mode === 'replan',
      ...(launch.startTurn ? { startTurn: true } : {}),
    };
  }
  if (launch.from === 'roadmap') return { kind: 'roadmap' };
  // The address a refusal wrote round-trips as itself — the gate's id, not the
  // card it resolved to — so a reload keeps seeding (or resuming) from the gate.
  if (launch.from === 'refused-gate' && launch.gateId) {
    return { kind: 'refused-gate', gateId: launch.gateId };
  }
  // …and so does a guide offer's: the turn id, never the card it resolved to, so a
  // vetoed Back and a reload re-read the seed rather than a resolved card.
  if (launch.from === 'guide-offer' && launch.guideTurnId) {
    return { kind: 'guide-offer', guideTurnId: launch.guideTurnId };
  }
  return { kind: 'project', hasPlan: launch.mode === 'replan' ? true : undefined };
}
