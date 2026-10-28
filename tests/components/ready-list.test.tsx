// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { ReadyItemDto } from '@/lib/dto/ready';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// ReadyRow (Subtask 7.0.6) builds the per-row clipboard command. Bug 8.8.3: a
// container kind (epic / story) — which enters the ready set only while childless
// — is *planned/deepened*, so its copy button must dispatch `motir plan <key>`;
// executable leaves (task / subtask / bug) stay `motir run <key>`. The toast body
// and tooltip both interpolate that same command, so the copied string and the
// confirmation surface stay in lockstep. These cover both verb branches.

// No real router under happy-dom — the row's whole-card peek uses next/navigation.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/ready',
  // The lane switch derives its lane from the URL, as `shallowPush` leaves it.
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

// The cursor-driven "load more" Server Actions pull server-only deps; stub them
// to keep this test DB-free (the load-more case drives the leaves one).
const loadMoreLeaves = vi.fn();
vi.mock('@/app/(authed)/ready/_actions', () => ({
  loadMoreReadyLeavesAction: (...args: unknown[]) => loadMoreLeaves(...args),
  loadMoreReadyBugsAction: vi.fn(),
}));

import { ReadyList, laneDisplayRows } from '@/app/(authed)/ready/_components/ReadyList';
import { ReadyLanes } from '@/app/(authed)/ready/_components/ReadyLanes';
import type { ReadyContainerDto } from '@/lib/dto/ready';

function item(over: Partial<ReadyItemDto> & { key: string; kind: WorkItemKindDto }): ReadyItemDto {
  return {
    id: `id-${over.key}`,
    title: `Item ${over.key}`,
    priority: 'medium',
    status: { key: 'todo', category: 'todo' },
    assignee: null,
    descriptionExcerpt: null,
    inheritedSessionBranch: null,
    type: null,
    executor: null,
    difficulty: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    descriptionMd: null,
    ...over,
  };
}

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(cleanup);

function renderRows(items: ReadyItemDto[]) {
  return renderWithIntl(
    <ToastProvider>
      <ReadyList initialWorkItemRefs={{}} initialItems={items} initialCursor={null} />
    </ToastProvider>,
  );
}

describe('ReadyList copy command verb', () => {
  it.each([
    { kind: 'epic' as const, key: 'PROD-1', verb: 'plan' },
    { kind: 'story' as const, key: 'PROD-2', verb: 'plan' },
    { kind: 'task' as const, key: 'PROD-3', verb: 'run' },
    { kind: 'subtask' as const, key: 'PROD-4', verb: 'run' },
    { kind: 'bug' as const, key: 'PROD-5', verb: 'run' },
  ])('copies `motir $verb $key` for a $kind row', async ({ kind, key, verb }) => {
    renderRows([item({ kind, key })]);

    fireEvent.click(screen.getByRole('button', { name: `Copy run command for ${key}` }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`motir ${verb} ${key}`);

    // The clipboard write is async and its resolution raises the confirmation
    // toast. Await that authoritative signal so the toast's state update lands
    // INSIDE the test rather than after it.
    await screen.findByText(`Paste motir ${verb} ${key} into your terminal.`);
  });

  it('shows the actual copied command in the confirmation toast (plan branch)', async () => {
    renderRows([item({ kind: 'story', key: 'PROD-2' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Copy run command for PROD-2' }));

    // The success toast body interpolates the same command the clipboard got.
    await waitFor(() =>
      expect(screen.getByText('Paste motir plan PROD-2 into your terminal.')).toBeTruthy(),
    );
  });

  it('shows the actual copied command in the confirmation toast (run branch)', async () => {
    renderRows([item({ kind: 'task', key: 'PROD-3' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Copy run command for PROD-3' }));

    await waitFor(() =>
      expect(screen.getByText('Paste motir run PROD-3 into your terminal.')).toBeTruthy(),
    );
  });
});

describe('ReadyList work-type chip (8.8.10)', () => {
  it('renders the type chip when the row has a `type`', () => {
    renderRows([item({ kind: 'subtask', key: 'PROD-7', type: 'code', executor: 'coding_agent' })]);
    // The chip label is the i18n type gloss (`labels.workItemType.code`).
    expect(screen.getByText('Code')).toBeTruthy();
  });

  it('omits the chip when `type` is null (a childless story/epic in the set)', () => {
    renderRows([item({ kind: 'story', key: 'PROD-2', type: null })]);
    // No work-type gloss rendered for a null type — no placeholder filler.
    expect(screen.queryByText('Code')).toBeNull();
    expect(screen.queryByText('Manual')).toBeNull();
  });
});

describe('ReadyList manual *Show instruction* variant (8.8.10)', () => {
  const manual = (over: Partial<ReadyItemDto> = {}) =>
    item({
      kind: 'subtask',
      key: 'PROD-9',
      type: 'manual',
      executor: 'human',
      descriptionMd: 'Provision the **blob store** in the dashboard.',
      ...over,
    });

  it('swaps the copy button for *Show instruction* on a manual row', () => {
    renderRows([manual()]);
    // No agent copy affordance — a human task has no run command.
    expect(screen.queryByRole('button', { name: 'Copy run command for PROD-9' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show instruction for PROD-9' })).toBeTruthy();
  });

  it('treats a human-executor row with no `type` as manual', () => {
    renderRows([manual({ type: null, executor: 'human' })]);
    expect(screen.getByRole('button', { name: 'Show instruction for PROD-9' })).toBeTruthy();
  });

  it('opens the instruction modal rendering the item descriptionMd as Markdown', async () => {
    renderRows([manual()]);

    fireEvent.click(screen.getByRole('button', { name: 'Show instruction for PROD-9' }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const dialog = screen.getByRole('dialog');
    // Title = the item title; the body renders the Markdown (bold → <strong>).
    expect(within(dialog).getByText('Item PROD-9')).toBeTruthy();
    expect(within(dialog).getByText('blob store')).toBeTruthy();
    expect(within(dialog).getByText('Human task · unassigned')).toBeTruthy();
  });

  it("draws the instruction's card links from the lane's map (MOTIR-10023)", async () => {
    renderWithIntl(
      <ToastProvider>
        <ReadyList
          initialWorkItemRefs={{
            wi_live: {
              accessible: true,
              id: 'wi_live',
              identifier: 'PROD-2',
              title: 'Create the bucket',
              kind: 'task',
              archived: false,
              status: { key: 'done', label: 'Done', category: 'done' },
              type: null,
              assignee: null,
            },
          }}
          initialItems={[
            manual({ descriptionMd: 'After [PROD-2](motir:wi_live) and [PROD-3](motir:wi_gone).' }),
          ]}
          initialCursor={null}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show instruction for PROD-9' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const chips = Array.from(screen.getByRole('dialog').querySelectorAll('.wi-chip'));
    expect(chips).toHaveLength(2);
    expect(chips[0]!.classList.contains('is-deleted')).toBe(false);
    expect(chips[0]!.textContent).toContain('Create the bucket');
    expect(chips[1]!.classList.contains('is-deleted')).toBe(true);
  });

  it('shows the empty state when a manual row has no instruction body', async () => {
    renderRows([manual({ descriptionMd: null })]);

    fireEvent.click(screen.getByRole('button', { name: 'Show instruction for PROD-9' }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(within(screen.getByRole('dialog')).getByText('No instruction yet')).toBeTruthy();
  });
});

// ─── The ready LANES (Story MOTIR-6829 · MOTIR-6834) ──────────────────────────

function containerOf(key: string, over: Partial<ReadyContainerDto> = {}): ReadyContainerDto {
  return {
    id: `c-${key}`,
    key,
    kind: 'story',
    title: `Story ${key}`,
    priority: 'high',
    assignee: null,
    readyLeafCount: 3,
    childCount: 4,
    ...over,
  };
}

describe('ReadyList — a lane grouped by runnable container', () => {
  const S = containerOf('PROD-10');
  const leaves = [
    item({ key: 'PROD-11', kind: 'subtask', container: S }),
    item({ key: 'PROD-12', kind: 'subtask', container: S }),
    item({ key: 'PROD-13', kind: 'subtask', container: S }),
    item({ key: 'PROD-20', kind: 'task', container: null }),
  ];

  it('renders a container as ONE collapsed row with its hint, and a standalone row beside it', () => {
    renderRows(leaves);
    const list = screen.getByRole('list', { name: 'Ready work items' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('PROD-10');
    expect(rows[0]!.textContent).toContain('3 of 4 ready');
    expect(rows[1]!.textContent).toContain('PROD-20');
    expect(screen.queryByText('PROD-11')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Expand PROD-10' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expanding shows exactly its ready leaves, in order; collapsing hides them', () => {
    renderRows(leaves);
    fireEvent.click(screen.getByRole('button', { name: 'Expand PROD-10' }));
    const keys = within(screen.getByRole('list', { name: 'Ready work items' }))
      .getAllByRole('listitem')
      .map((r) => r.textContent?.match(/PROD-\d+/)?.[0]);
    expect(keys).toEqual(['PROD-10', 'PROD-11', 'PROD-12', 'PROD-13', 'PROD-20']);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse PROD-10' }));
    expect(screen.queryByText('PROD-11')).toBeNull();
  });

  it('the container row copies the PARENT run, motir run <KEY>', async () => {
    renderRows(leaves);
    fireEvent.click(screen.getByRole('button', { name: 'Copy parent-run command for PROD-10' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('motir run PROD-10'));
  });

  it('says so, in one line, when a lane is empty', () => {
    renderWithIntl(
      <ToastProvider>
        <ReadyList initialWorkItemRefs={{}} initialItems={[]} initialCursor={null} lane="bug" />
      </ToastProvider>,
    );
    expect(screen.getByText('No ready bugs.')).toBeTruthy();
    cleanup();
    renderRows([]);
    expect(screen.getByText('Nothing ready to run.')).toBeTruthy();
  });

  it('a group split by a page boundary is ONE row, and stays expanded after the load', async () => {
    let fire: (() => void) | null = null;
    class IO {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        fire = () => cb([{ isIntersecting: true }]);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', IO);
    loadMoreLeaves.mockResolvedValueOnce({
      items: [item({ key: 'PROD-13', kind: 'subtask', container: S }), leaves[3]!],
      nextCursor: null,
      workItemRefs: {},
    });
    renderWithIntl(
      <ToastProvider>
        <ReadyList
          initialWorkItemRefs={{}}
          initialItems={leaves.slice(0, 2)}
          initialCursor="c1"
          lane="leaf"
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand PROD-10' }));
    await act(async () => {
      fire?.();
    });
    await waitFor(() => expect(screen.getByText('PROD-13')).toBeTruthy());
    expect(loadMoreLeaves).toHaveBeenCalledWith('c1');
    expect(screen.getAllByTestId('ready-container-PROD-10')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Collapse PROD-10' })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('laneDisplayRows groups by container id over the whole list, not by adjacency', () => {
    const rows = laneDisplayRows([leaves[0]!, leaves[3]!, leaves[1]!], new Set([S.id]));
    expect(rows.map((r) => (r.type === 'container' ? r.container.key : r.item.key))).toEqual([
      'PROD-10',
      'PROD-11',
      'PROD-12',
      'PROD-20',
    ]);
  });
});

describe('ReadyLanes — the switch over one pane', () => {
  const lanes = {
    leaves: {
      items: [item({ key: 'PROD-30', kind: 'task', container: null })],
      nextCursor: null,
      workItemRefs: {},
    },
    bugs: {
      items: [item({ key: 'PROD-40', kind: 'bug', container: null })],
      nextCursor: null,
      workItemRefs: {},
    },
    counts: { leaves: 1, bugs: 1 },
  };
  afterEach(() => window.history.replaceState(null, '', '/ready'));

  it('opens on Ready to run, and the Bugs segment writes ?lane=bugs without a navigation', () => {
    window.history.replaceState(null, '', '/ready?peek=PROD-1');
    renderWithIntl(
      <ToastProvider>
        <ReadyLanes {...lanes} />
      </ToastProvider>,
    );
    expect(screen.getByTestId('ready-lane-main').hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('ready-lane-bugs').hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Bugs/ }));
    expect(window.location.search).toContain('lane=bugs');
    // The peek the URL already carried survives the switch.
    expect(window.location.search).toContain('peek=PROD-1');
  });

  it('?lane=bugs opens on the Bugs lane', () => {
    window.history.replaceState(null, '', '/ready?lane=bugs');
    renderWithIntl(
      <ToastProvider>
        <ReadyLanes {...lanes} />
      </ToastProvider>,
    );
    expect(screen.getByTestId('ready-lane-bugs').hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('ready-lane-main').hasAttribute('hidden')).toBe(true);
    expect(within(screen.getByTestId('ready-lane-bugs')).getByText('PROD-40')).toBeTruthy();
  });
});
