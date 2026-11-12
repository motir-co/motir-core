// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type {
  ReadinessVerdictDto,
  RelationshipLinkDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';

// The relationships surface (2.4.5 read + 2.4.9 edit). The panel now imports the
// client AddLinkControl / RemoveLinkButton, which import the detail-page Server
// Actions — stub that module so importing the panel doesn't pull in `db`. These
// tests render the panel READ-ONLY (editable unset), so the add/remove islands
// aren't instantiated; the interactive add control is tested in
// add-link-control.test.tsx.
vi.mock('@/app/(authed)/items/[key]/actions', () => ({
  createLinkAction: vi.fn(),
  removeLinkAction: vi.fn(),
  listLinkCandidatesAction: vi.fn(),
}));

// 8.8.31: the rows now render the client RelationshipPeekLink, which calls
// usePeekOpen (usePathname / useSearchParams). Stub next/navigation — happy-dom
// has no App Router context — and assert the shallow `?peek=` push.
let searchParamsString = '';
// MOTIR-4496: the panel itself is a client island now and owns the write, so
// it calls `useRouter().refresh()` as well as the peek's two hooks.
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/PROD-1',
  useSearchParams: () => new URLSearchParams(searchParamsString),
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { RelationshipsPanel } from '@/app/(authed)/items/[key]/_components/RelationshipsPanel';

// The peek opens via SHALLOW routing (window.history.pushState), so assert
// against a pushState spy — never a real navigation.
const historyPush = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

afterEach(() => {
  historyPush.mockClear();
  searchParamsString = '';
  cleanup();
});

function summary(overrides: Partial<WorkItemSummaryDto> = {}): WorkItemSummaryDto {
  return {
    id: 'wi',
    parentId: null,
    kind: 'task',
    key: 1,
    identifier: 'PROD-1',
    title: 'An item',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: null,
    archivedAt: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    subject: null,
    ...overrides,
  };
}

function link(overrides: Partial<WorkItemSummaryDto> = {}): RelationshipLinkDto {
  const item = summary(overrides);
  return { linkId: `link-${item.id}`, item };
}

const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
    {
      id: 's2',
      projectId: 'p1',
      key: 'done',
      label: 'Done',
      category: 'done',
      color: null,
      position: 'a1',
      isInitial: false,
    },
  ],
  transitions: [],
  policyMode: 'open',
};

const EMPTY: Omit<React.ComponentProps<typeof RelationshipsPanel>, 'readiness' | 'workflow'> = {
  blockedBy: [],
  blocks: [],
  relatesTo: [],
  duplicates: [],
  clones: [],
  supersedes: [],
  supersededBy: [],
  // The item itself is in the todo category, so the readiness banner shows —
  // the only gate is the category, not the blocker count (bug-ready-banner-no-deps).
  currentStatus: 'todo',
};
const READY: ReadinessVerdictDto = { ready: true, openBlockers: [], blockedByAncestor: null };

describe('ReadinessBadge (2.4.5)', () => {
  it('renders the state as TEXT (not colour alone) — "Ready to start" when ready', () => {
    render(<ReadinessBadge ready />);
    screen.getByText('Ready to start');
    screen.getByText('All blockers resolved');
  });

  it('names + links the open blockers when blocked', () => {
    render(
      <ReadinessBadge
        ready={false}
        blockers={[
          { identifier: 'PROD-3', href: '/items/PROD-3' },
          { identifier: 'PROD-12', href: '/items/PROD-12' },
        ]}
      />,
    );
    screen.getByText('Blocked');
    screen.getByText(/Waiting on 2 work items/);
    const lnk = screen.getByRole('link', { name: 'PROD-3' });
    expect(lnk.getAttribute('href')).toBe('/items/PROD-3');
    // Opt-in default: without `blockerLinksNewTab`, links stay same-tab (8.8.32).
    expect(lnk.getAttribute('target')).not.toBe('_blank');
  });

  it('singularizes "issue" for a single blocker', () => {
    render(
      <ReadinessBadge ready={false} blockers={[{ identifier: 'PROD-3', href: '/items/PROD-3' }]} />,
    );
    screen.getByText(/Waiting on 1 work item —/);
  });

  it('names the blocked ANCESTOR when there are no own blockers (cascade cause, 7.0.13)', () => {
    render(
      <ReadinessBadge
        ready={false}
        blockers={[]}
        blockedByAncestor={{ identifier: 'PROD-8', href: '/items/PROD-8', title: '7.19 Roadmap' }}
      />,
    );
    // The SOFT heading (MOTIR-6377) — the full soft variant is covered in
    // readiness-badge-soft.test.tsx.
    screen.getByText('Parent blocked');
    expect(screen.queryByText('Blocked')).toBeNull();
    screen.getByText(/Waiting on a parent item —/);
    const lnk = screen.getByRole('link', { name: 'PROD-8' });
    expect(lnk.getAttribute('href')).toBe('/items/PROD-8');
    screen.getByText(/· 7.19 Roadmap/);
  });

  it('own blockers take precedence over the ancestor line', () => {
    render(
      <ReadinessBadge
        ready={false}
        blockers={[{ identifier: 'PROD-3', href: '/items/PROD-3' }]}
        blockedByAncestor={{ identifier: 'PROD-8', href: '/items/PROD-8', title: '7.19 Roadmap' }}
      />,
    );
    screen.getByText(/Waiting on 1 work item —/);
    expect(screen.queryByText(/Waiting on a parent item/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'PROD-8' })).toBeNull();
  });

  it('opens the ancestor link in a new tab when blockerLinksNewTab is set (peek)', () => {
    render(
      <ReadinessBadge
        ready={false}
        blockers={[]}
        blockedByAncestor={{ identifier: 'PROD-8', href: '/items/PROD-8', title: '7.19' }}
        blockerLinksNewTab
      />,
    );
    const lnk = screen.getByRole('link', { name: 'PROD-8' });
    expect(lnk.getAttribute('target')).toBe('_blank');
    expect(lnk.getAttribute('rel')).toContain('noopener');
  });
});

describe('RelationshipsPanel (2.4.5 read-only)', () => {
  it('shows a muted empty state (not blank); read-only mode has no add control', () => {
    render(<RelationshipsPanel {...EMPTY} readiness={READY} workflow={workflow} />);
    screen.getByText('Relationships');
    screen.getByText('No linked work items yet.');
    // A todo item with no blockers is the most ready it can be — the "Ready to
    // start" banner shows above the empty links list (bug-ready-banner-no-deps).
    screen.getByText('Ready to start');
    // Not editable → no "+ Link issue" entry point.
    expect(screen.queryByRole('button', { name: /Link work item/ })).toBeNull();
  });

  it('shows "Ready to start" for a todo item with NO blockers (bug-ready-banner-no-deps)', () => {
    // The most ready an item can be: nothing depends on it. The banner reads off
    // the verdict (ready), not the blocker count.
    render(<RelationshipsPanel {...EMPTY} readiness={READY} workflow={workflow} />);
    screen.getByText('Ready to start');
    screen.getByText('All blockers resolved');
  });

  it('groups links by kind, each linked item a navigable row with its status', () => {
    render(
      <RelationshipsPanel
        blockedBy={[link({ id: 'b', identifier: 'PROD-3', title: 'Upstream', status: 'todo' })]}
        blocks={[link({ id: 'k', identifier: 'PROD-9', title: 'Downstream', status: 'done' })]}
        relatesTo={[link({ id: 'r', identifier: 'PROD-5', title: 'Related thing' })]}
        duplicates={[link({ id: 'd', identifier: 'PROD-7', title: 'Dup thing' })]}
        clones={[link({ id: 'c', identifier: 'PROD-8', title: 'Clone thing' })]}
        supersedes={[]}
        supersededBy={[]}
        readiness={{
          ready: false,
          openBlockers: [summary({ id: 'b', identifier: 'PROD-3' })],
          blockedByAncestor: null,
        }}
        currentStatus="todo"
        workflow={workflow}
      />,
    );

    screen.getByText('Blocked by');
    screen.getByText('Blocks');
    screen.getByText('Relates to');
    screen.getByText('Duplicates');
    screen.getByText('Clones');

    // The blocked-by ROW (named by its title — the banner also links PROD-3).
    const blocker = screen.getByRole('link', { name: /Upstream/ });
    expect(blocker.getAttribute('href')).toBe('/items/PROD-3');
    expect(blocker.textContent).toContain('PROD-3');
    expect(blocker.textContent).toContain('To Do');

    // The detail-page banner blocker link stays SAME-TAB (the opt-in default;
    // ReadinessBadge here gets no `blockerLinksNewTab`, unlike the 8.8.32 quick
    // modal): it navigates to /items/<KEY> with NO target=_blank.
    const bannerBlocker = screen.getByRole('link', { name: 'PROD-3' });
    expect(bannerBlocker.getAttribute('href')).toBe('/items/PROD-3');
    expect(bannerBlocker.getAttribute('target')).not.toBe('_blank');

    expect(screen.getByRole('link', { name: /Downstream/ }).textContent).toContain('Done');

    screen.getByText('Blocked');
    screen.getByText(/Waiting on 1 work item/);
  });

  // MOTIR-6675 — the supersedes pair, per relationships--supersedes.mock.html panel 3.
  it('lists Supersedes then Superseded by AFTER Clones, several superseders stacking as rows', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        clones={[link({ id: 'c', identifier: 'PROD-8', title: 'Clone thing' })]}
        supersedes={[
          link({ id: 'o', identifier: 'PROD-2', title: 'The v1 importer', status: 'done' }),
        ]}
        supersededBy={[
          link({ id: 'n1', identifier: 'PROD-11', title: 'Importer v2' }),
          link({ id: 'n2', identifier: 'PROD-12', title: 'Importer v3' }),
        ]}
        readiness={READY}
        workflow={workflow}
      />,
    );
    const order = [...document.querySelectorAll('[data-relationship-group]')].map((g) =>
      g.getAttribute('data-relationship-group'),
    );
    expect(order).toEqual(['clones', 'supersedes', 'superseded_by']);

    const older = document.querySelector<HTMLElement>('[data-relationship-group="supersedes"]')!;
    within(older).getByText('Supersedes');
    expect(
      within(older)
        .getByRole('link', { name: /The v1 importer/ })
        .getAttribute('href'),
    ).toBe('/items/PROD-2');
    const newer = document.querySelector<HTMLElement>('[data-relationship-group="superseded_by"]')!;
    within(newer).getByText('Superseded by');
    within(newer).getByText('2');
    expect(within(newer).getAllByRole('link')).toHaveLength(2);
  });

  it('draws neither supersedes group on a card with no supersedes links', () => {
    render(<RelationshipsPanel {...EMPTY} readiness={READY} workflow={workflow} />);
    expect(document.querySelector('[data-relationship-group="supersedes"]')).toBeNull();
    expect(document.querySelector('[data-relationship-group="superseded_by"]')).toBeNull();
  });

  it('labels the pair in zh', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        supersedes={[link({ id: 'o', identifier: 'PROD-2', title: 'Old' })]}
        supersededBy={[link({ id: 'n', identifier: 'PROD-11', title: 'New' })]}
        readiness={READY}
        workflow={workflow}
      />,
      { messages: zhMessages, locale: 'zh' },
    );
    within(
      document.querySelector<HTMLElement>('[data-relationship-group="supersedes"]')!,
    ).getByText('取代');
    within(
      document.querySelector<HTMLElement>('[data-relationship-group="superseded_by"]')!,
    ).getByText('被取代于');
  });

  it('shows "Ready to start" above the groups when blockers exist but are all resolved', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        blockedBy={[link({ id: 'b', identifier: 'PROD-3', status: 'done' })]}
        readiness={{ ready: true, openBlockers: [], blockedByAncestor: null }}
        workflow={workflow}
      />,
    );
    screen.getByText('Ready to start');
    within(screen.getByRole('link', { name: /PROD-3/ })).getByText('Done');
  });

  it('suppresses the readiness banner once the item leaves the todo category', () => {
    // Same blocked verdict as above, but the item itself is Done — "can I start
    // this?" is moot, so no banner (the blocked-by GROUP still renders).
    render(
      <RelationshipsPanel
        {...EMPTY}
        blockedBy={[link({ id: 'b', identifier: 'PROD-3', title: 'Upstream', status: 'todo' })]}
        readiness={{
          ready: false,
          openBlockers: [summary({ id: 'b', identifier: 'PROD-3' })],
          blockedByAncestor: null,
        }}
        currentStatus="done"
        workflow={workflow}
      />,
    );
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.queryByText(/Waiting on/)).toBeNull();
    // The dependency group itself is unaffected — only the banner is gated.
    screen.getByText('Blocked by');
    screen.getByRole('link', { name: /Upstream/ });
  });

  it('suppresses the readiness banner on an ARCHIVED item, todo status notwithstanding (MOTIR-2050)', () => {
    // The bug: archiving is a pure soft-delete — it leaves `status` at `todo` —
    // so the status-only gate lit the green "Ready to start" badge on the same
    // page as the "Archived" banner, promising work the ready set can never hand
    // out (every ready read filters `archivedAt IS NULL`).
    render(
      <RelationshipsPanel
        {...EMPTY}
        readiness={READY}
        currentStatus="todo"
        archived
        workflow={workflow}
      />,
    );
    expect(screen.queryByText('Ready to start')).toBeNull();
    expect(screen.queryByText('All blockers resolved')).toBeNull();
    // The panel itself still renders — only the readiness banner is gated.
    screen.getByText('Relationships');
  });

  it('suppresses the BLOCKED banner on an archived item too', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        blockedBy={[link({ id: 'b', identifier: 'PROD-3', title: 'Upstream', status: 'todo' })]}
        readiness={{
          ready: false,
          openBlockers: [summary({ id: 'b', identifier: 'PROD-3' })],
          blockedByAncestor: null,
        }}
        currentStatus="todo"
        archived
        workflow={workflow}
      />,
    );
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.queryByText(/Waiting on/)).toBeNull();
    // The dependency GROUP is unaffected — only the banner is gated.
    screen.getByText('Blocked by');
    screen.getByRole('link', { name: /Upstream/ });
  });

  it('falls back to the raw status key for a cross-project status the workflow does not classify', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        relatesTo={[link({ id: 'x', identifier: 'OTHER-2', status: 'mystery' })]}
        readiness={READY}
        workflow={workflow}
      />,
    );
    expect(screen.getByRole('link', { name: /OTHER-2/ }).textContent).toContain('mystery');
  });

  it('a PLAIN click on a relationship row opens the quick-view peek, not a navigation (8.8.31)', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        relatesTo={[link({ id: 'r', identifier: 'PROD-5', title: 'Related thing' })]}
        readiness={READY}
        workflow={workflow}
      />,
    );
    const row = screen.getByRole('link', { name: /Related thing/ });
    // The anchor keeps its detail-page href (shareable + ⌘/ctrl/middle-click →
    // new tab natively)…
    expect(row.getAttribute('href')).toBe('/items/PROD-5');
    // …but a plain primary click is intercepted (default prevented) and opens the
    // peek for PROD-5 via a shallow `?peek=` push on the current item's URL.
    const notPrevented = fireEvent.click(row, { button: 0 });
    expect(notPrevented).toBe(false); // preventDefault was called
    expect(historyPush).toHaveBeenCalledWith(null, '', '/items/PROD-1?peek=PROD-5');
  });

  it('a ⌘/ctrl-click on a relationship row does NOT open the peek — the browser opens the full page (8.8.31)', () => {
    render(
      <RelationshipsPanel
        {...EMPTY}
        relatesTo={[link({ id: 'r', identifier: 'PROD-5', title: 'Related thing' })]}
        readiness={READY}
        workflow={workflow}
      />,
    );
    const row = screen.getByRole('link', { name: /Related thing/ });
    fireEvent.click(row, { button: 0, metaKey: true });
    fireEvent.click(row, { button: 0, ctrlKey: true });
    expect(historyPush).not.toHaveBeenCalled();
  });
});
