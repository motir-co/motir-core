'use client';

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReadyItemDto } from '@/lib/dto/ready';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { Segmented } from '@/components/ui/Segmented';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { ReadyList } from './ReadyList';

// The /ready LANE SWITCH (Story MOTIR-6829 · MOTIR-6834, `design/ready/
// ready--lanes.mock.html` panels 1 and 3): a Segmented control — Ready to run
// {n} · Bugs {n} — over ONE full-height pane that scrolls on its own.
//
// Both lanes' first pages are server-rendered with the page, so switching needs
// no server: the choice is URL state the CLIENT reads (`?lane=bugs`, absent for
// Ready to run), written with `shallowPush` (CLAUDE.md § *URL state the CLIENT
// reads*) — a reload or a shared link lands on the same lane, Back undoes a
// switch, and nothing pends. BOTH lists stay mounted, the hidden one `hidden`,
// so a lane keeps its loaded pages and its expanded containers across a switch.

type Lane = 'main' | 'bugs';

/** A lane's first page, with its instructions' card links (MOTIR-10023). */
type ReadyLanePage = {
  items: ReadyItemDto[];
  nextCursor: string | null;
  workItemRefs: WorkItemRefMap;
};

export interface ReadyLanesProps {
  leaves: ReadyLanePage;
  bugs: ReadyLanePage;
  counts: { leaves: number; bugs: number };
}

export function ReadyLanes({ leaves, bugs, counts }: ReadyLanesProps) {
  const t = useTranslations('ready');
  const params = useSearchParams();
  const lane: Lane = params.get('lane') === 'bugs' ? 'bugs' : 'main';

  const select = (next: Lane) => {
    const url = new URL(window.location.href);
    if (next === 'bugs') url.searchParams.set('lane', 'bugs');
    else url.searchParams.delete('lane');
    shallowPush(`${url.pathname}${url.search}${url.hash}`);
  };

  return (
    // `flex-1` in the page's viewport-height column: the lanes fill the height
    // the content above them leaves (MOTIR-10974). `min-h-0` is load-bearing: a
    // flex item's automatic minimum is its content, so without it the pane's
    // rows would stretch this block (and the pane) to the full list height.
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Segmented<Lane>
        label={t('lanes.switchAria')}
        value={lane}
        onChange={select}
        className="self-start"
        options={[
          {
            value: 'main',
            label: t('lanes.main.heading'),
            trailing: <span className="text-xs tabular-nums">{counts.leaves}</span>,
          },
          {
            value: 'bugs',
            label: t('lanes.bugs.heading'),
            trailing: <span className="text-xs tabular-nums">{counts.bugs}</span>,
          },
        ]}
      />
      {/* The pane: the height left below the switch, sized by the layout rather
          than a guessed offset (MOTIR-10974), and its OWN scroll container —
          `useRowWindow` windows against it as the nearest scrolling ancestor.
          `flex-1`'s zero basis keeps its rows from inflating it; `min-h-80` is the
          floor on a short viewport, where the shell's `<main>` scrolls the rest. */}
      <div data-testid="ready-lane-pane" className="min-h-80 flex-1 overflow-y-auto pr-1">
        <div hidden={lane !== 'main'} data-testid="ready-lane-main">
          <ReadyList
            initialItems={leaves.items}
            initialCursor={leaves.nextCursor}
            initialWorkItemRefs={leaves.workItemRefs}
            lane="leaf"
          />
        </div>
        <div hidden={lane !== 'bugs'} data-testid="ready-lane-bugs">
          <ReadyList
            initialItems={bugs.items}
            initialCursor={bugs.nextCursor}
            initialWorkItemRefs={bugs.workItemRefs}
            lane="bug"
          />
        </div>
      </div>
    </div>
  );
}
