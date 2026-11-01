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
    <div className="flex flex-col gap-3">
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
      {/* The pane: the page height below the switch, its OWN scroll container —
          `useRowWindow` windows against it as the nearest scrolling ancestor. */}
      <div
        data-testid="ready-lane-pane"
        className="h-[calc(100dvh_-_16rem_-_var(--shell-bottom-clearance,1.5rem))] min-h-80 overflow-y-auto pr-1"
      >
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
