// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// BacklogContainer grooming actions (Subtask 4.2.5): multi-select + atomic bulk
// move + inline create + the `⋯` menu, driven through the real client
// orchestration with a mocked fetch (the 4.2.3 component-test idiom). Under
// happy-dom `useRowWindow` degrades to render-all, so every row is in the DOM and
// selection / bulk / create can be exercised end-to-end without a viewport.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/backlog',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue: vi.fn(),
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));

import { BacklogContainer } from '@/app/(authed)/backlog/_components/BacklogContainer';

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

const workflow = {
  statuses: [
    { id: 's1', key: 'todo', label: 'To do', category: 'todo', position: 'a0', color: null },
    {
      id: 's2',
      key: 'in_progress',
      label: 'In progress',
      category: 'in_progress',
      position: 'a1',
      color: null,
    },
    { id: 's3', key: 'done', label: 'Done', category: 'done', position: 'a2', color: null },
  ],
  transitions: [],
  policyMode: 'open',
} as unknown as WorkflowDto;

const members = [
  { userId: 'u1', name: 'Yue Zhu', email: 'yue@example.com' },
] as unknown as WorkspaceMemberDTO[];

function sprint(over: Partial<SprintDto> & { id: string; name: string }): SprintDto {
  return {
    goal: null,
    state: 'planned',
    startDate: null,
    endDate: null,
    completedAt: null,
    sequence: 1,
    issueCount: 0,
    committedPoints: null,
    committedIssueCount: null,
    ...over,
  };
}

function item(over: Partial<WorkItemSummaryDto> & { id: string; key: number }): WorkItemSummaryDto {
  return {
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Item ${over.key}`,
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
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface FetchOpts {
  /** Force a non-ok response for these URL substrings (snap-back tests). */
  failOn?: string[];
}

function installFetch(
  data: {
    sprints: SprintDto[];
    backlog: WorkItemSummaryDto[];
    sprintIssues: WorkItemSummaryDto[];
  },
  opts: FetchOpts = {},
): Call[] {
  const calls: Call[] = [];
  const ok = (body: unknown, status = 200) =>
    Promise.resolve({ ok: true, status, json: () => Promise.resolve(body) } as Response);
  const fail = (status = 500) =>
    Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) } as Response);

  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') calls.push({ url, method, body });
    if (opts.failOn?.some((s) => url.includes(s)) && method !== 'GET') return fail();

    // Writes
    if (url.includes('/issues/bulk') && method === 'POST') return ok({ items: [] });
    if (url.includes('/api/backlog/bulk-move') && method === 'POST') return ok({ items: [] });
    if (url.includes('/api/work-items/') && url.includes('/rank')) return ok({});
    if (url === '/api/backlog' && method === 'POST') {
      return ok(
        {
          id: 'new1',
          projectId: 'p1',
          parentId: null,
          kind: body?.kind ?? 'story',
          key: 999,
          identifier: 'PROD-999',
          title: body?.title ?? 'New',
          descriptionMd: null,
          status: 'todo',
          priority: 'medium',
          assigneeId: null,
          reporterId: 'u1',
          position: 'z0',
          estimateMinutes: null,
          storyPoints: null,
          sprintId: body?.sprintId ?? null,
          backlogRank: 'z0',
          archivedAt: null,
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
        },
        201,
      );
    }

    // Reads
    if (url.includes('/issues')) {
      return ok({
        items: data.sprintIssues,
        nextCursor: null,
        totalCount: data.sprintIssues.length,
      });
    }
    if (url.startsWith('/api/sprints')) return ok({ sprints: data.sprints });
    if (url.startsWith('/api/backlog')) {
      return ok({ items: data.backlog, nextCursor: null, totalCount: data.backlog.length });
    }
    return ok({});
  }) as unknown as typeof fetch;

  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

const ui = <BacklogContainer workflow={workflow} members={members} projectName="motir" />;

describe('Backlog selection model (4.2.5)', () => {
  it('click selects one; the checkbox toggles; the selection bar shows the count', async () => {
    installFetch({
      sprints: [],
      backlog: [item({ id: 'b1', key: 150 }), item({ id: 'b2', key: 151 })],
      sprintIssues: [],
    });
    render(ui);

    const row1 = await screen.findByTestId('backlog-row-PROD-150');
    fireEvent.click(row1);
    // Selection reads off the row's `data-selected` + the sibling checkbox's
    // `aria-checked` — NOT `aria-selected`, which MOTIR-2493 removed because it
    // is not an allowed attribute on the `listitem` the row now is. The checkbox
    // is the accessible channel, and it was always the one carrying the state.
    expect(row1.getAttribute('data-selected')).toBe('true');
    expect(row1.getAttribute('aria-selected')).toBeNull();
    expect(screen.getByTestId('backlog-row-check-PROD-150').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByTestId('backlog-selection-count').textContent).toContain('1');

    // ⌘-click a second row adds it (toggle); the bar shows 2.
    fireEvent.click(screen.getByTestId('backlog-row-PROD-151'), { metaKey: true });
    expect(screen.getByTestId('backlog-selection-count').textContent).toContain('2');

    // The checkbox deselects row 1 → back to 1.
    fireEvent.click(screen.getByTestId('backlog-row-check-PROD-150'));
    expect(screen.getByTestId('backlog-selection-count').textContent).toContain('1');
  });

  it('shift-click selects the contiguous range and survives a list append (keyed by id)', async () => {
    const state = {
      sprints: [] as SprintDto[],
      backlog: [
        item({ id: 'b1', key: 150 }),
        item({ id: 'b2', key: 151 }),
        item({ id: 'b3', key: 152 }),
      ],
      sprintIssues: [] as WorkItemSummaryDto[],
    };
    installFetch(state);
    const { rerender } = render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-PROD-150')); // anchor
    fireEvent.click(screen.getByTestId('backlog-row-PROD-152'), { shiftKey: true }); // range
    expect(screen.getByTestId('backlog-selection-count').textContent).toContain('3');

    // A later-loaded row does not clear the id-keyed selection.
    rerender(<ToastProvider>{ui}</ToastProvider>);
    expect(screen.getByTestId('backlog-row-check-PROD-151').getAttribute('aria-checked')).toBe(
      'true',
    );
  });
});

describe('Backlog atomic bulk move (4.2.5 → 4.2.2)', () => {
  it('moves a multi-selection to the backlog in ONE request and clears the selection', async () => {
    const calls = installFetch({
      sprints: [sprint({ id: 'sp1', name: 'Sprint 25', state: 'planned', issueCount: 2 })],
      backlog: [],
      sprintIssues: [item({ id: 's1', key: 201 }), item({ id: 's2', key: 202 })],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-check-PROD-201'));
    fireEvent.click(screen.getByTestId('backlog-row-check-PROD-202'));
    expect(screen.getByTestId('backlog-selection-count').textContent).toContain('2');

    fireEvent.click(screen.getByRole('button', { name: 'Move to backlog' }));

    await waitFor(() => {
      const bulk = calls.filter((c) => c.url.includes('/api/backlog/bulk-move'));
      expect(bulk).toHaveLength(1);
      expect((bulk[0]!.body as { itemIds: string[] }).itemIds.sort()).toEqual(['s1', 's2']);
    });
    // Selection cleared on dispatch (the bar is gone); the sprint count dropped.
    expect(screen.queryByTestId('backlog-selection-bar')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('sprint-count-sp1').textContent).toBe('0'));
  });

  it('snaps back the sprint count when the bulk move is rejected', async () => {
    const calls = installFetch(
      {
        sprints: [sprint({ id: 'sp1', name: 'Sprint 25', state: 'planned', issueCount: 2 })],
        backlog: [],
        sprintIssues: [item({ id: 's1', key: 201 }), item({ id: 's2', key: 202 })],
      },
      { failOn: ['/api/backlog/bulk-move'] },
    );
    render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-check-PROD-201'));
    fireEvent.click(screen.getByTestId('backlog-row-check-PROD-202'));
    fireEvent.click(screen.getByRole('button', { name: 'Move to backlog' }));

    // Exactly one (atomic) request fired; the count reverts to its pre-move value.
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('/api/backlog/bulk-move'))).toHaveLength(1),
    );
    await waitFor(() => expect(screen.getByTestId('sprint-count-sp1').textContent).toBe('2'));
  });
});

describe('Backlog inline create (4.2.5 → 4.2.2)', () => {
  it('creates into the backlog in one action and shows the new row in place', async () => {
    const calls = installFetch({
      sprints: [],
      backlog: [item({ id: 'b1', key: 150 })],
      sprintIssues: [],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('create-issue-backlog'));
    const input = screen.getByTestId('create-issue-input');
    fireEvent.change(input, { target: { value: 'Groom the icebox' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const create = calls.filter((c) => c.url === '/api/backlog' && c.method === 'POST');
      expect(create).toHaveLength(1);
      expect(create[0]!.body).toMatchObject({
        title: 'Groom the icebox',
        kind: 'story',
        sprintId: null,
      });
    });
    expect(await screen.findByTestId('backlog-row-PROD-999')).toBeTruthy();
  });

  // MOTIR-6174 — the rest of the form's paths, now the create row carries a
  // permission branch of its own (drawn disabled without `work_item:edit`).
  it('picks the type from its menu, and Escape / Cancel close the form without a write', async () => {
    const calls = installFetch({
      sprints: [],
      backlog: [item({ id: 'b1', key: 150 })],
      sprintIssues: [],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('create-issue-backlog'));
    fireEvent.click(screen.getByTestId('create-issue-type'));
    const menu = screen.getByRole('menu', { name: 'Choose work item type' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Task/ }));
    fireEvent.change(screen.getByTestId('create-issue-input'), { target: { value: 'Typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url === '/api/backlog' && c.method === 'POST')[0]?.body,
      ).toMatchObject({ title: 'Typed', kind: 'task' }),
    );

    fireEvent.keyDown(screen.getByTestId('create-issue-input'), { key: 'Escape' });
    expect(screen.queryByTestId('create-issue-input')).toBeNull();

    fireEvent.click(screen.getByTestId('create-issue-backlog'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('create-issue-input')).toBeNull();
    // An empty title never writes, and an ordinary keystroke is just typing.
    fireEvent.click(screen.getByTestId('create-issue-backlog'));
    const field = screen.getByTestId('create-issue-input');
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'a' });
    expect(calls.filter((c) => c.url === '/api/backlog' && c.method === 'POST')).toHaveLength(1);

    // A second Enter while the first create is in flight writes nothing more.
    fireEvent.change(field, { target: { value: 'Once' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/backlog' && c.method === 'POST')).toHaveLength(2),
    );
  });
});

describe('Backlog selection bar → a sprint (4.2.5)', () => {
  it('moves a backlog selection INTO a picked sprint in one request', async () => {
    const calls = installFetch({
      sprints: [sprint({ id: 'sp1', name: 'Sprint 25', state: 'planned', issueCount: 0 })],
      backlog: [item({ id: 'b1', key: 150 })],
      sprintIssues: [],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-check-PROD-150'));
    const bar = screen.getByTestId('backlog-selection-bar');
    fireEvent.click(within(bar).getByRole('button', { name: /Move to sprint/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sprint 25/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(screen.queryByTestId('backlog-selection-bar')).toBeNull();
  });
});

describe('Backlog row ⋯ menu (4.2.5)', () => {
  it('“Move to top of backlog” ranks the row via the 4.1.4 rank route', async () => {
    const calls = installFetch({
      sprints: [],
      backlog: [item({ id: 'b1', key: 150 }), item({ id: 'b2', key: 151 })],
      sprintIssues: [],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-actions-PROD-151'));
    const moveTop = await screen.findByTestId('row-move-top-PROD-151');
    fireEvent.click(moveTop);

    await waitFor(() => {
      const rank = calls.filter((c) => c.url === '/api/work-items/b2/rank');
      expect(rank).toHaveLength(1);
      // Top → rank BEFORE the current first row (afterId = b1).
      expect(rank[0]!.body).toMatchObject({ afterId: 'b1' });
    });
  });

  it('a sprint row’s ⋯ offers “Move to backlog” (the bulk path)', async () => {
    const calls = installFetch({
      sprints: [sprint({ id: 'sp1', name: 'Sprint 25', state: 'planned', issueCount: 1 })],
      backlog: [],
      sprintIssues: [item({ id: 's1', key: 201 })],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-actions-PROD-201'));
    const back = await screen.findByTestId('row-move-to-backlog-PROD-201');
    fireEvent.click(within(back).getByText('Move to backlog') ?? back);

    await waitFor(() => {
      const bulk = calls.filter((c) => c.url.includes('/api/backlog/bulk-move'));
      expect(bulk).toHaveLength(1);
      expect((bulk[0]!.body as { itemIds: string[] }).itemIds).toEqual(['s1']);
    });
  });
});

// The selection bar gates each bulk-move button to where the selection currently
// lives (bug-backlog-selection-bar-move-to-backlog-always-shown): a no-op move is
// never offered. The mirror of the row ⋯ menu, which already only offers "Move to
// backlog" for a sprint row.
describe('Backlog selection-bar contextual gating (bug-move-to-backlog-always-shown)', () => {
  it('hides “Move to backlog” when every selected item is already in the backlog', async () => {
    installFetch({
      sprints: [sprint({ id: 'sp1', name: 'Sprint 25', state: 'planned', issueCount: 0 })],
      backlog: [item({ id: 'b1', key: 150 }), item({ id: 'b2', key: 151 })],
      sprintIssues: [],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-check-PROD-150'));
    fireEvent.click(screen.getByTestId('backlog-row-check-PROD-151'));
    expect(screen.getByTestId('backlog-selection-count').textContent).toContain('2');

    // All-backlog selection → the no-op "Move to backlog" is gone; "Move to
    // sprint" stays (you can still send them to a sprint).
    expect(screen.queryByRole('button', { name: 'Move to backlog' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move to sprint' })).toBeTruthy();
  });

  it('shows both buttons for a mixed selection (≥1 sprint item + ≥1 backlog item)', async () => {
    installFetch({
      sprints: [sprint({ id: 'sp1', name: 'Sprint 25', state: 'planned', issueCount: 1 })],
      backlog: [item({ id: 'b1', key: 150 })],
      sprintIssues: [item({ id: 's1', key: 201 })],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-check-PROD-150')); // backlog
    fireEvent.click(screen.getByTestId('backlog-row-check-PROD-201')); // sprint
    expect(screen.getByTestId('backlog-selection-count').textContent).toContain('2');

    // Mixed → both moves are meaningful, so both buttons render.
    expect(screen.getByRole('button', { name: 'Move to backlog' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move to sprint' })).toBeTruthy();
  });

  it('hides “Move to sprint ▸” when every selected item is already in the SAME sprint', async () => {
    installFetch({
      sprints: [sprint({ id: 'sp1', name: 'Sprint 25', state: 'planned', issueCount: 2 })],
      backlog: [],
      sprintIssues: [item({ id: 's1', key: 201 }), item({ id: 's2', key: 202 })],
    });
    render(ui);

    fireEvent.click(await screen.findByTestId('backlog-row-check-PROD-201'));
    fireEvent.click(screen.getByTestId('backlog-row-check-PROD-202'));
    expect(screen.getByTestId('backlog-selection-count').textContent).toContain('2');

    // Same-sprint selection → re-picking that sprint is a no-op; "Move to sprint"
    // is gone. "Move to backlog" stays (you can still send them back).
    expect(screen.queryByRole('button', { name: 'Move to sprint' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move to backlog' })).toBeTruthy();
  });
});
