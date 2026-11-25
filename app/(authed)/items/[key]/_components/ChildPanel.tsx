'use client';

import type { ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { List, Workflow } from 'lucide-react';
import { ContentSectionCard } from './ContentSectionCard';
import { Pill } from '@/components/ui/Pill';
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';
import type { CardNextActionsOption } from '@/lib/planning/canvasNextActions';

// The Children section on the work-item detail page (Story MOTIR-2284 /
// MOTIR-2288), drawn in `design/work-items/child-panel-graph.*`. It owns the
// section card — the shipped `ContentSectionCard` header, its count `Pill`, and
// now a `List` / `Graph` view switcher — and picks which body renders inside it.
//
// LIST is the default and is the SERVER-rendered `ChildList`, handed in as
// `children`: the rows keep rendering on the server, so first paint is exactly
// what it is today and `ChildList` never becomes a client component. Only the
// header needed to be interactive.
//
// GRAPH mounts the shipped `WorkItemRoadmap` ROOTED at this item (MOTIR-2287),
// so the canvas's first level is this item's own children with the `blocked_by`
// edges between them, and Back at that level returns to those children rather
// than to the project's epics.
//
// A leaf renders NOTHING — no header, no switcher, no scaffold — which is
// `ChildList`'s shipped rule, kept here because the header moved up.

export type ChildPanelView = 'list' | 'graph';

/** The query parameter that carries the chosen view. */
export const CHILD_VIEW_PARAM = 'children';

// The canvas box (design decision (a), `design/work-items/design-notes.md`): a
// FIXED 28rem block, not a viewport fill — a section card inside a scrolling
// content column must not be measured against the viewport. 28rem is the shipped
// roadmap view's own `min-h-[28rem]` floor, reused rather than invented; below it
// the fitted level collides with the canvas's bottom-left legend + zoom cluster,
// and above it the extra height is empty canvas (the fit is width-bound).
const CANVAS_BOX =
  'h-[28rem] overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-canvas)';

export interface ChildPanelProps {
  /** How many children the item has — the count `Pill`, and the leaf test. */
  count: number;
  /** This item's id: what the graph mode roots the canvas at. */
  itemId: string;
  /** This item's identifier (`MOTIR-1234`) — the breadcrumb's root crumb, so Back
   *  reads as "back to MOTIR-1234" (design decision (c)). */
  itemIdentifier: string;
  /** The project key the per-level roadmap read is addressed to. */
  projectKey: string;
  /** The server-rendered rows (`ChildList`), shown in list mode. */
  children: ReactNode;
  /** The graph cards' hover next-action button (MOTIR-12233) — Plan on a To plan
   *  child, copy `motir run` / `review` / `fix` / `guide` on the rest — resolved by
   *  the page through `canvasNextActionsFor`, the roadmap page's own gate. `null`
   *  (a Visitor) or absent draws no button. */
  nextActions?: CardNextActionsOption | null;
}

export function ChildPanel({
  count,
  itemId,
  itemIdentifier,
  projectKey,
  children,
  nextActions = null,
}: ChildPanelProps) {
  const t = useTranslations('issueViews');
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The URL is the single source of truth for the view (the story's baked-in
  // decision, and the convention `?scope=` on /roadmap and `?tab=` on this page
  // already follow): derive it on every render so a deep link, a reload and
  // browser Back/forward all agree. `?children=graph` → graph; anything else
  // (absent / `children=list` / garbage) → the default list.
  const view: ChildPanelView = searchParams.get(CHILD_VIEW_PARAM) === 'graph' ? 'graph' : 'list';

  // A leaf grows no chrome: the switcher lives inside the section, so an item with
  // no children renders no section at all (ChildList's shipped rule).
  if (count === 0) return null;

  const options: SegmentedOption<ChildPanelView>[] = [
    {
      value: 'list',
      label: t('viewList'),
      icon: <List className="h-3.5 w-3.5" aria-hidden />,
    },
    {
      value: 'graph',
      label: t('viewGraph'),
      icon: <Workflow className="h-3.5 w-3.5" aria-hidden />,
    },
  ];

  const changeView = (next: ChildPanelView) => {
    // SHALLOW (MOTIR-3434). The list body IS the already-rendered `children`
    // prop and the graph mounts a client canvas that fetches its own level, so
    // neither body needs anything from the server — and `router.push` here re-ran
    // the item page's twenty-nine awaits to render what was already on screen.
    // `shallowPush` writes the same URL without the round trip.
    //
    // PUSH (not replace) so the switch is its own history entry and Back undoes
    // it. Scrolling is unchanged: a `pushState` does not scroll, which is what
    // the old `scroll: false` was asking for. The default list mode writes a
    // CLEAN url (no param), so every existing link to this page is
    // byte-identical to what it is today. There is no local state to set — the
    // re-render re-derives `view` from the URL, which Next keeps in sync with
    // `history.pushState`. No `router.refresh()`: the rest of the detail page is
    // untouched by this.
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'graph') params.set(CHILD_VIEW_PARAM, 'graph');
    else params.delete(CHILD_VIEW_PARAM);
    const query = params.toString();
    shallowPush(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <ContentSectionCard
      title={t('childIssues')}
      headerExtra={<Pill tone="neutral">{count}</Pill>}
      headerRight={
        <Segmented<ChildPanelView>
          options={options}
          value={view}
          onChange={changeView}
          label={t('childrenViewLabel')}
        />
      }
    >
      {view === 'graph' ? (
        <div className={CANVAS_BOX} data-testid="child-panel-graph">
          <WorkItemRoadmap
            projectKey={projectKey}
            subtreeRootId={itemId}
            rootLabel={itemIdentifier}
            ariaLabel={t('childrenGraphAria')}
            // The design's opt-in verdicts (decision (b)) — copied, not chosen.
            // fullScreenable ON: the bounded panel fits a dependency chain at ~0.5x,
            // so full screen is where it becomes readable. searchable / locatable
            // OFF: a `/` overlay inside an embedded panel is a page-level key grab,
            // and a canvas already rooted at the item the reader is on has nothing
            // off-screen to locate. autoDescendSingleParent and the planning-origin
            // cluster are off by construction on a rooted mount (MOTIR-2287).
            fullScreenable
            searchable={false}
            locatable={false}
            // The cards' next-action button, gated exactly as on the roadmap
            // (MOTIR-12233): the Plan click opens the authed shell's planning
            // overlay over this page, the same overlay the roadmap opens.
            nextActions={nextActions}
            emptyRoot={
              // The ONLY reachable "nothing to draw" state: this section renders at
              // all only when the server read returned children, and
              // `fetchRoadmapLevel` never throws — it resolves to an EMPTY level on
              // any failure. So an empty FIRST level means the graph read did not
              // come back, while the count pill above still says N. The canvas
              // default ("Nothing on the roadmap yet") would contradict it.
              <div className="max-w-[24rem] text-center">
                <p className="text-sm font-semibold text-(--el-text)">
                  {t('childrenGraphUnavailableTitle')}
                </p>
                <p className="mt-1 text-sm text-(--el-text-muted)">
                  {t('childrenGraphUnavailableDescription')}
                </p>
              </div>
            }
          />
        </div>
      ) : (
        children
      )}
    </ContentSectionCard>
  );
}
