'use client';

import type { CardNextActionsOption } from '@/components/planning/WorkItemNode';
import {
  SurfaceShowOriginalSwitch,
  SurfaceTitlesNotice,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { Goal, LayoutGrid, RefreshCw, Target } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';
import { folderIdFromNodeId, folderNodeId } from '@/components/planning/workItemLevel';
import type { RoadmapScope } from '@/lib/planning/roadmapClient';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';

// The roadmap page's CLIENT shell (Subtask MOTIR-1382 / Story MOTIR-1379) — it owns
// the SCOPE state and renders the header scope toggle, because the page is a Server
// Component but the toggle + the canvas are a client island. It composes the shipped
// `Segmented` control (design `design/roadmap/scope-toggle.*`, MOTIR-1380) in the
// header and feeds the chosen scope to `WorkItemRoadmap`, which threads it to every
// per-level fetch (`&scope=sprint`, the scoped read MOTIR-1381).
//
// Scope is URL-addressable (MOTIR-1541) AND a client-island interaction, with the URL
// as the SINGLE SOURCE OF TRUTH (MOTIR-1549): `scope` is DERIVED from
// `useSearchParams()` (`?scope=sprint` → sprint, anything else → the default project
// scope) — never a one-shot `useState`. Switching scope writes the URL with
// `shallowPush` (MOTIR-3434), which stacks a genuine browser-history entry AND
// re-renders this island with the new `?scope=` — so a deep-link, a reload, AND
// browser Back/forward all resolve the right scope (Back after a toggle returns to the
// previous scope's URL and view). It was `router.push` until MOTIR-3434: the scope
// change drives the refetch by REMOUNTING the canvas (its React `key={scope}`), NOT by
// the navigation, so re-running the page's server reads produced nothing this body
// uses — a round trip the reader waited on for no result. `history.pushState` writes
// the same URL without it, and Next keeps `useSearchParams` in sync with it, so every
// derivation below is untouched. It is NEVER a `router.refresh()` either (the
// page-state contract: the canvas is a client island seeded from its own fetch; the
// URL change only moves the URL, the `key` drives the refetch). A PUSH and not a
// replace, deliberately: each toggle is a distinct history entry so Back works — the
// standard behaviour for URL-addressable view state, and the MOTIR-1549 fix, which
// exists precisely because this toggle once used a replace. With
// no active sprint, the Active-sprint option renders the design's "No active sprint"
// empty state in place; the toggle stays available and the default scope is unaffected.

export interface RoadmapViewProps {
  /** The project's `PROD`/`MOTIR` key — the per-level roadmap read source. */
  projectKey: string;
  /** The project's display name (the whole-project subtitle). */
  projectName: string;
  /** The canvas `aria-label`. */
  ariaLabel: string;
  /** Whether the project has an active sprint (server-resolved via getActiveSprint). */
  hasActiveSprint: boolean;
  /** The active sprint's name + goal, for the sprint-scope subtitle (null when none). */
  sprintName: string | null;
  sprintGoal: string | null;
  /** Pin the planning-origin cluster at the root (MOTIR-1013) — gated on the
   *  project's onboarding-ran marker (MOTIR-1264); forwarded to the canvas, which
   *  draws it in the WHOLE-PROJECT scope only (it is the project road's origin). */
  showPlanningOrigin: boolean;
  /** The canvas card's next-action button (MOTIR-10509) — forwarded to the canvas.
   *  `null` (a Visitor) draws no button. */
  nextActions?: CardNextActionsOption | null;
  /**
   * The ARRIVAL LEVEL, resolved from `?item=` by the server page (MOTIR-3836) —
   * `ancestors ++ [the item]`, so its LAST crumb is the level the canvas opens on.
   * `[]` (the default shape) is the project root, which is also what an
   * unresolvable `?item=` produces.
   */
  initialTrail?: readonly CanvasCrumb[];
}

/**
 * The session-cache key of the level a trail ends on (MOTIR-3836, extended by Bug
 * MOTIR-5710 · MOTIR-5742): a work item's `crumbKey`, or — for a FOLDER's level,
 * which has no work-item key — its `folder:<id>` crumb id. Both spellings are the
 * ones `onPopState` re-derives from the address bar, so a Back lands on the level
 * it left.
 */
function levelAddressKey(trail: readonly CanvasCrumb[]): string | null {
  const last = trail[trail.length - 1];
  if (!last) return null;
  if (folderIdFromNodeId(last.id) !== null) return last.id;
  return last.crumbKey ?? null;
}

export function RoadmapView({
  projectKey,
  projectName,
  ariaLabel,
  hasActiveSprint,
  sprintName,
  sprintGoal,
  showPlanningOrigin,
  nextActions = null,
  initialTrail = [],
}: RoadmapViewProps) {
  const t = useTranslations('roadmap');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The URL is the single source of truth for scope (MOTIR-1549): derive it from
  // `?scope=` on every render, so a deep-link, reload, AND browser Back/forward all
  // resolve the right scope. `?scope=sprint` → sprint; anything else (absent /
  // `scope=project` / garbage) → the default whole-project scope — the same rule the
  // server page applies, so first-paint SSR and client hydration agree.
  const scope: RoadmapScope = searchParams.get('scope') === 'sprint' ? 'sprint' : 'project';

  // Mirror the chosen scope into the URL so the sprint roadmap is addressable:
  // `?scope=sprint` for the sprint scope, a clean `/roadmap` (no param) for the
  // default project scope. A `shallowPush` — pushing a distinct history entry is
  // what makes Back/forward restore the prior scope (MOTIR-1549); the resulting
  // `?scope=` re-render both re-derives `scope` and (via the `key={scope}` remount
  // below) drives the canvas refetch, not any navigation.
  // A MANUAL REFRESH (MOTIR-1542): the header refresh control bumps `refreshSignal`,
  // which `WorkItemRoadmap` watches to drop its level cache and re-run the canvas's
  // per-level load IN PLACE (drill / breadcrumb / zoom preserved) — never the
  // `key={scope}` remount. `refreshing` drives the control's loading state and clears
  // on the real fetch-completion signal (`onRefreshSettled`), not a timer.
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // ── THE LEVEL IS THE URL (MOTIR-3836) ──────────────────────────────────────
  //
  // The level has TWO movers, and the whole problem is telling them apart. The
  // CANVAS moves itself (a drill, Back, a crumb click) and reports; the BROWSER
  // moves the URL under us (Back/forward). One piece of state holds where this
  // view believes the canvas is, and it is what the canvas is handed back.
  //
  // ⚠️ THE DISCRIMINATOR IS THE `popstate` EVENT, NOT A COMPARISON. Deriving the
  // level from `?item=` on every render — the shape `scope` uses one block above,
  // and the obvious thing to copy — is WRONG here, and wrong in a way that only
  // shows up under timing: a shallow write does not update `useSearchParams`
  // synchronously, so between the canvas reporting a drill and Next syncing the
  // param there is at least one render in which the URL still names the OLD
  // level. A render-time comparison reads that as "the URL moved" and yanks the
  // reader straight back out of the level they just opened. A stale URL and a
  // genuine Back are indistinguishable from the params alone — they differ only
  // in the EVENT — so this listens for the event.
  //
  // The TRAIL for a key comes from a session cache rather than a fetch, because
  // every entry Back can reach within this mount is one this view itself pushed:
  // the cache is seeded with the server-resolved arrival and written on every
  // level change. A key it does not know — reachable only by hand-editing the
  // address bar without a reload — falls back to the ROOT level and does NOT
  // fetch, the same silent fallback the server applies to an unresolvable
  // `?item=`.
  const seededKey = levelAddressKey(initialTrail);
  const trailCacheRef = useRef<Map<string, readonly CanvasCrumb[]>>(
    new Map(seededKey === null ? [] : [[seededKey, initialTrail]]),
  );
  const [levelTrail, setLevelTrail] = useState<readonly CanvasCrumb[]>(initialTrail);

  // A level the READER moved to. The canvas has already moved, so this records it
  // and writes the address: `shallowPush` (MOTIR-3434), a real history entry so
  // browser Back steps back through the levels (MOTIR-1549 is why it is a push and
  // not a replace), and never `router.push` / `router.refresh`, which would re-run
  // the page's server reads to produce nothing this body uses. `?scope=` is carried
  // across the write — the two params are independent view state on one route.
  const handleLevelChange = useCallback(
    (trail: readonly CanvasCrumb[]) => {
      const key = levelAddressKey(trail);
      if (key !== null) trailCacheRef.current.set(key, trail);
      setLevelTrail(trail);
      const next = new URLSearchParams(searchParams.toString());
      // A FOLDER level is addressed by `?folder=` (Bug MOTIR-5710 · MOTIR-5742), a
      // work item's by `?item=` — never both, so each write clears the other.
      next.delete('item');
      next.delete('folder');
      const last = trail[trail.length - 1];
      const folderId = last ? folderIdFromNodeId(last.id) : null;
      if (folderId !== null) next.set('folder', folderId);
      else if (last?.crumbKey) next.set('item', last.crumbKey);
      const qs = next.toString();
      shallowPush(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, searchParams],
  );

  // BROWSER BACK / FORWARD. The effect only SUBSCRIBES; the state write happens in
  // the event handler, so this is not a `setState` in an effect. It reads
  // `window.location` rather than `useSearchParams`, because the event is the
  // authority for what the address bar now says and the hook may not have caught
  // up yet — the same reason this is an event listener at all.
  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(window.location.search);
      const folder = params.get('folder');
      const key = folder !== null ? folderNodeId(folder) : params.get('item');
      setLevelTrail(key === null ? [] : (trailCacheRef.current.get(key) ?? []));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const changeScope = (next: RoadmapScope) => {
    // A scope switch remounts the canvas and supersedes any in-flight refresh, so
    // clear the loading state (the remounted canvas won't fire onRefreshSettled).
    setRefreshing(false);
    // SHALLOW (MOTIR-3434). The canvas refetches on its `key={scope}` remount —
    // the comment at the top of this file already said the navigation is not
    // what drives it — so `router.push` was re-running the page's server reads
    // to produce nothing the body uses. `shallowPush` writes the same URL
    // without the round trip, and does not scroll (what the old `scroll: false`
    // was asking for).
    //
    // Push (not replace) so the toggle is a distinct history entry — Back/forward
    // then restores the prior scope (MOTIR-1549, which exists precisely because
    // this toggle once used a replace). The new `?scope=` re-derives `scope`; no
    // local state to set (the URL is the source of truth, and Next keeps
    // `useSearchParams` in sync with `history.pushState`).
    //
    // ⚠️ A SCOPE SWITCH DROPS `?item=` (MOTIR-3836), always. The canvas REMOUNTS on
    // its `key={scope}` and lands at the new scope's own root, so carrying the old
    // level across would name a level the reader is not on. Keeping it would need
    // to know whether that level exists in the new scope, which is a read this
    // surface deliberately does not make — the sprint slice re-roots at the topmost
    // in-sprint members (MOTIR-1381), so the question is not answerable from the
    // client. Dropping it is the honest answer and it matches what the reader sees.
    setLevelTrail([]);
    shallowPush(next === 'sprint' ? `${pathname}?scope=sprint` : pathname);
  };

  const handleRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshSignal((n) => n + 1);
  };
  const handleRefreshSettled = useCallback(() => setRefreshing(false), []);

  const sprintScopeActive = scope === 'sprint' && hasActiveSprint;
  const noActiveSprint = scope === 'sprint' && !hasActiveSprint;
  const subtitle = sprintScopeActive
    ? sprintGoal
      ? `${sprintName} · ${sprintGoal}`
      : (sprintName ?? t('subtitle', { project: projectName }))
    : t('subtitle', { project: projectName });

  const options: SegmentedOption<RoadmapScope>[] = [
    {
      value: 'project',
      label: t('scopeWholeProject'),
      icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden />,
    },
    {
      value: 'sprint',
      label: t('scopeActiveSprint'),
      icon: <Target className="h-3.5 w-3.5" aria-hidden />,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="flex items-center gap-2 text-sm text-(--el-text-muted)">
            <span className="truncate">{subtitle}</span>
            {sprintScopeActive ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
                <Target className="h-3 w-3 text-(--el-accent-on-surface)" aria-hidden />
                {t('scopeChip')}
              </span>
            ) : null}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <SurfaceShowOriginalSwitch />
          <Segmented<RoadmapScope>
            options={options}
            value={scope}
            onChange={changeScope}
            label={t('scopeAriaLabel')}
          />
          {/* Manual refresh (MOTIR-1542): re-fetches the roadmap in place, no full
              page reload. Icon-only Button (secondary) — its own `loading` shows the
              Spinner + disables + aria-busy. Disabled when no canvas is mounted (the
              no-active-sprint empty state), so a click can't hang the spinner. */}
          <Button
            variant="secondary"
            size="md"
            className="w-(--height-btn-md) gap-0 px-0"
            aria-label={t('refresh')}
            title={t('refresh')}
            loading={refreshing}
            disabled={noActiveSprint}
            leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}
            onClick={handleRefresh}
          />
        </div>
      </header>

      <SurfaceTitlesNotice />

      {/* THE CANVAS FILLS THE FOLD (MOTIR-3839).
          
          The chrome above this box is 10rem, MEASURED rather than derived: the top
          nav `h-14` (56) + the shell's `pt-6` (24) + this page's header (56 — the
          `font-serif text-2xl` h1 at 32, `gap-1` 4, the `text-sm` subtitle 20) +
          this stack's `gap-6` (24). The shipped value was `11.5rem`, 24px MORE
          than the chrome actually costs, and it then subtracted
          `--shell-bottom-clearance` a SECOND time — the shell has already spent
          that band as `pb-(--shell-bottom-clearance)` (`app/(authed)/layout.tsx`).
          Net dead band below the canvas at 1440x900: 120px, on the one surface
          whose whole job is drawing a graph. At 1366x768 it was worse than dead:
          `min-h-[28rem]` exceeded the computed height, so the page SCROLLED.

          The negative bottom margin is how the canvas SPENDS the shell's band
          without making `<main>` scroll — done locally here rather than by
          touching the shell, so no other route's layout moves. `min-h-[28rem]`
          stays and no longer binds (488px at 1366x768).

          `--canvas-fold-inset` is the other half, and it is why this is safe: the
          band exists because the floating Plan-with-AI orb reaches 76px up from
          the window's bottom-right (MOTIR-2763). The canvas may have an orb over
          blank board; its bottom-RIGHT chrome may not sit under it. Declaring the
          inset HERE — on the box that takes the band — lets the canvas's own
          bottom-right control lift by exactly that much, while every other mount
          of the same canvas (the item page's Children panel, the two plan
          canvases) inherits nothing and is untouched. */}
      <div
        style={{ '--canvas-fold-inset': 'var(--shell-bottom-clearance, 1.5rem)' } as CSSProperties}
        className="mb-[calc(-1*var(--shell-bottom-clearance,1.5rem))] h-[calc(100dvh_-_10rem)] min-h-[28rem] overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-canvas)"
      >
        {noActiveSprint ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={<Goal className="h-12 w-12" aria-hidden />}
              title={t('noActiveSprintTitle')}
              description={t('noActiveSprintDescription')}
            />
          </div>
        ) : (
          // Remount on scope change (key) so the canvas re-loads the ROOT in the new
          // scope — the client-island refetch, not router.refresh (page-state contract).
          <WorkItemRoadmap
            key={scope}
            projectKey={projectKey}
            scope={scope}
            showPlanningOrigin={showPlanningOrigin}
            nextActions={nextActions}
            ariaLabel={ariaLabel}
            refreshSignal={refreshSignal}
            onRefreshSettled={handleRefreshSettled}
            // THE LEVEL SEAM (MOTIR-3835), consumed here and nowhere else. The seed
            // decides where the canvas OPENS — so a cold arrival costs no adoption —
            // and the controlled trail moves it afterwards, which is what makes
            // browser Back land in place instead of remounting the canvas.
            initialTrail={initialTrail}
            controlledTrail={levelTrail}
            onLevelChange={handleLevelChange}
          />
        )}
      </div>
    </div>
  );
}
