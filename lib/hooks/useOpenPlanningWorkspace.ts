'use client';

import { useCallback, useMemo, type MouseEvent } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { withPlanningOverlay, type PlanningLaunchContext } from '@/lib/planning/launcher';
import { shallowPush } from '@/lib/navigation/shallowUrl';

// THE ONE OPENER (MOTIR-4730, under story MOTIR-4725).
//
// The doors already shared ONE resolver — `WorkItemPlanEntrance`'s own header
// states it as a principle: *"exactly one entry path into the workspace and one
// place that decides the mode."* That property is kept. What changes is what a
// door WRITES: the workspace is an overlay now (MOTIR-4729), so a door adds four
// query parameters to the page it sits on instead of navigating to `/planning`.
//
// ⚠️ THE DOOR STAYS A REAL `<Link>`, AND THAT IS THE POINT OF RETURNING AN
// `href` AT ALL. A ⌘-click, a middle-click and *Open link in new tab* must keep
// working, and they now do something BETTER than before: the full address opens
// the same page with the workspace over it — the cold deep link — rather than a
// separate route with no context behind it. So `open` intercepts only the plain
// primary click and lets every modified one through to the browser.
//
// ⚠️ `shallowPush`, NEVER `router.push` (`motir-core/CLAUDE.md` § *URL state the
// CLIENT reads is written with `shallowPush`*). The overlay's body is already in
// the browser and the page underneath must not re-render — re-rendering it is
// what would throw away the filter and the scroll position this whole story
// exists to preserve. The visual half of that rule applies too: **no pending
// affordance on a shallow switch** — no spinner on the pill, no disabled state,
// nothing to wait for.

/** What a door needs: the address to carry, and the click that opens in place. */
export interface OpenPlanningWorkspace {
  /**
   * The CURRENT address plus the overlay's parameters — the door's real `href`.
   * Every host parameter is preserved, so `/roadmap?item=MOTIR-12` keeps its
   * drilled level and `/items?peek=MOTIR-12` keeps its quick view open behind
   * the workspace (the dialog-over-dialog case the design decided).
   */
  href: string;
  /** The click handler. Pass it straight to the `<Link>`'s `onClick`. */
  open: (event?: MouseEvent<HTMLElement>) => void;
}

/**
 * A modified click belongs to the BROWSER. Meta / ctrl / shift / alt, and any
 * button that is not the primary one, all mean "open this somewhere else" — so
 * the handler must not `preventDefault` them.
 *
 * ⚠️ EXPORTED since MOTIR-6045, for the door that has TWO destinations. A Plans
 * row opens the overlay for an undecided plan and navigates to the plan page for
 * a decided one (`lib/planning/planDestination.ts`), so it cannot hand its whole
 * click to `open` below — but the rule about which clicks are ours is the same
 * rule, and a second copy of it is how one door starts swallowing ⌘-clicks.
 */
export function isPlainPrimaryClick(event: MouseEvent<HTMLElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

export function useOpenPlanningWorkspace(context: PlanningLaunchContext): OpenPlanningWorkspace {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // `context` is an object literal at nearly every call site, so its IDENTITY is
  // not a useful dependency — its VALUE is, and it is small and flat.
  const contextKey = contextValueKey(context);

  // Composed from the two hooks rather than read off `window.location`, so it is
  // stable across a render and safe wherever this component is rendered.
  const href = useMemo(() => {
    const qs = searchParams.toString();
    return withPlanningOverlay(`${pathname}${qs ? `?${qs}` : ''}`, context);
    // `contextKey` stands in for `context` here on purpose (see above); the
    // linter cannot see through that, and re-deriving the address on every
    // render of a top-nav pill is the cost this memo exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams, contextKey]);

  const open = useCallback(
    (event?: MouseEvent<HTMLElement>) => {
      if (event) {
        if (!isPlainPrimaryClick(event)) return;
        event.preventDefault();
      }
      shallowPush(href);
    },
    [href],
  );

  return { href, open };
}

/**
 * The same one opener for a door whose TARGET is decided at click time rather
 * than at render (MOTIR-10544): the canvas card's Plan button opens the overlay
 * only after its pre-check answers, and the can't-plan alert's per-line Plan
 * opens it on a BLOCKER the button never knew about. It returns `open(context)`,
 * which writes the launcher's address for that context onto the current page with
 * `shallowPush` — exactly what {@link useOpenPlanningWorkspace}'s `open` writes —
 * so a deferred open lands on the same overlay a direct one does. It is not a
 * link, so there is no `href` and no modified click to let through.
 */
export function useOpenPlanningWorkspaceLater(): (context: PlanningLaunchContext) => void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (context: PlanningLaunchContext) => {
      const qs = searchParams.toString();
      shallowPush(withPlanningOverlay(`${pathname}${qs ? `?${qs}` : ''}`, context));
    },
    [pathname, searchParams],
  );
}

/**
 * THE GUIDE ME THROUGH DOOR (Story MOTIR-7459 · MOTIR-7466) — `openGuide(itemKey)`.
 *
 * The same one opener, aimed at the guide mode: it writes
 * `plan=guide&planFrom=guide&planItem=<KEY>` onto the page the door sits on
 * (design MOTIR-7462 panel 1), so the overlay opens over the card's own page and
 * Close returns to it. A thin name over {@link useOpenPlanningWorkspace} rather
 * than a second resolver: the address is the launcher's, decided in one place.
 */
export function useOpenGuide(itemKey: string): OpenPlanningWorkspace & {
  openGuide: (event?: MouseEvent<HTMLElement>) => void;
} {
  const door = useOpenPlanningWorkspace({ kind: 'guide', itemKey });
  return { ...door, openGuide: door.open };
}

/**
 * The whole context as a dependency-safe scalar. `hasPlan` is included because
 * it changes the MODE, which changes the address.
 */
function contextValueKey(context: PlanningLaunchContext): string {
  const target = context.kind === 'work-item' || context.kind === 'guide' ? context.itemKey : '';
  const hasPlan = 'hasPlan' in context ? String(context.hasPlan) : '';
  // `sessionId` changes the address too — `planSession=<id>` (MOTIR-6024).
  const session = 'sessionId' in context ? (context.sessionId ?? '') : '';
  // …and so does the entrance it was reopened from — `planVia` (MOTIR-6037).
  const via = 'via' in context ? (context.via ?? '') : '';
  // …and so does a refused gate's id — `planGate` (MOTIR-6210).
  const gate = context.kind === 'refused-gate' ? context.gateId : '';
  // …and so does the start prompt's ask — `planAsk` (MOTIR-10624).
  const ask = context.kind === 'work-item' && context.confirmStart ? '1' : '';
  return `${context.kind}|${target}|${hasPlan}|${session}|${via}|${gate}|${ask}`;
}
