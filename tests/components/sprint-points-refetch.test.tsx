// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { useSprintPoints } from '@/app/(authed)/backlog/_components/useSprintPoints';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { EstimationConfigDto } from '@/lib/dto/estimation';

// MOTIR-1495 — the planned-sprint committed-points badge went STALE after an item
// moved out of the sprint: `SprintPointsBadge` reads its figure from the ON-READ
// `/api/sprints/[id]/points` roll-up via `useSprintPoints`, a client island that
// fetched ONCE and never re-fetched on a membership change (the move path only
// updated the issue-COUNT badge). The fix threads a `sprintPointsRefreshKey` tick
// (bumped after a move / create / in-sprint point-edit COMMITS) into the hook's
// deps so the badge recomputes without a page reload — the CLAUDE.md client-island
// page-state contract. These tests reproduce the staleness and pin the fix.

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

const workflow = {
  statuses: [
    { id: 's1', key: 'todo', label: 'To do', category: 'todo', position: 'a0', color: null },
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ── The bug at the seam: the hook re-fetches when its refresh tick bumps ───────
describe('useSprintPoints — re-fetches its ON-READ roll-up on a refresh tick', () => {
  function Probe({ refreshKey }: { refreshKey: number }) {
    const points = useSprintPoints('sp1', true, refreshKey);
    return <div data-testid="committed">{points ? String(points.committed) : 'loading'}</div>;
  }

  it('reads the fresh committed value after the tick bumps (stale before the fix)', async () => {
    // The server roll-up drops 8 → 3 once the membership changed; each fetch
    // reads whatever the server currently returns.
    let committed = 8;
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ committed, completed: 0, remaining: committed }),
    }));
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const { rerender } = render(<Probe refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId('committed').textContent).toBe('8'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Membership changed server-side; the tick bumps → the hook MUST re-fetch.
    committed = 3;
    rerender(<Probe refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId('committed').textContent).toBe('3'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ── The reproduce the acceptance criteria names: move an item OUT of a planned
//    sprint and assert the committed-points badge drops (no page reload) ────────
describe('SprintPointsBadge — committed points refresh after a move (MOTIR-1495)', () => {
  interface Call {
    url: string;
    method: string;
    body: unknown;
  }

  function installFetch(data: {
    sprints: SprintDto[];
    sprintIssues: WorkItemSummaryDto[];
    committed: number;
  }): Call[] {
    const calls: Call[] = [];
    let committed = data.committed;
    const ok = (body: unknown, status = 200) =>
      Promise.resolve({ ok: true, status, json: () => Promise.resolve(body) } as Response);

    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== 'GET') calls.push({ url, method, body });

      // The move commits server-side → the sprint is now empty, so its ON-READ
      // committed roll-up is 0 on the NEXT `/points` read.
      if (url.includes('/api/backlog/bulk-move') && method === 'POST') {
        committed = 0;
        return ok({ items: [] });
      }

      // Reads
      if (url.includes('/points')) return ok({ committed, completed: 0, remaining: committed });
      if (url.includes('/issues')) {
        return ok({
          items: data.sprintIssues,
          nextCursor: null,
          totalCount: data.sprintIssues.length,
        });
      }
      if (url.startsWith('/api/sprints')) return ok({ sprints: data.sprints });
      if (url.startsWith('/api/backlog')) return ok({ items: [], nextCursor: null, totalCount: 0 });
      return ok({});
    }) as unknown as typeof fetch;

    return calls;
  }

  const ui = <BacklogContainer workflow={workflow} members={members} projectName="motir" />;

  it('drops the committed-points badge to "—" when the sprint is emptied by a move', async () => {
    const calls = installFetch({
      sprints: [sprint({ id: 'sp1', name: 'Sprint 25', state: 'planned', issueCount: 1 })],
      sprintIssues: [item({ id: 's1', key: 201 })],
      committed: 8,
    });
    renderWithIntl(<ToastProvider>{ui}</ToastProvider>);

    // The planned sprint's committed badge shows its 8 committed points.
    await waitFor(() => expect(screen.getByLabelText('Points: 8 committed')).toBeTruthy());

    // Move the only item out to the backlog.
    fireEvent.click(await screen.findByTestId('backlog-row-check-PROD-201'));
    fireEvent.click(screen.getByRole('button', { name: 'Move to backlog' }));

    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('/api/backlog/bulk-move'))).toHaveLength(1),
    );

    // The badge RE-FETCHES its roll-up and drops to the empty state — WITHOUT a
    // reload. Before the fix it stayed "Points: 8 committed" (the stale read).
    await waitFor(() =>
      expect(screen.getByLabelText('Sprint has no estimated points')).toBeTruthy(),
    );
    expect(screen.queryByLabelText('Points: 8 committed')).toBeNull();
  });
});

// ── The in-sprint point-edit trigger: an inline estimate edit signals the host
//    to refresh its derived roll-up (the sprint committed-points badge) ─────────
describe('EstimateBadge — signals onEstimateChanged after a committed point edit', () => {
  const STORY_POINTS_CONFIG: EstimationConfigDto = {
    estimationStatistic: 'story_points',
    pointScale: 'fibonacci',
    customScaleValues: [],
  };

  it('fires onEstimateChanged on a successful PATCH, and NOT on a failed one', async () => {
    const onChanged = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchSpy);

    renderWithIntl(
      <EstimationConfigProvider config={STORY_POINTS_CONFIG} canEdit>
        <EstimateBadge itemId="wi_1" storyPoints={5} onEstimateChanged={onChanged} />
      </EstimationConfigProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Story points: 5 — edit' }));
    fireEvent.click(await screen.findByRole('button', { name: '8 story points' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    // A rejected write must NOT signal a refresh (the roll-up did not change).
    onChanged.mockClear();
    fetchSpy.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'nope' }) });

    // WAIT FOR THE TRIGGER TO BE RE-ENABLED before re-opening the picker
    // (MOTIR-1839). `EstimateBadge` runs its write inside `startTransition` and
    // renders the trigger `disabled={isPending}`, but calls `onEstimateChanged`
    // INSIDE that transition — so the `onChanged` assertion above resolves while
    // the transition may still be pending. A `fireEvent.click` landing in that
    // window hits a DISABLED button and is silently dropped: the picker never
    // opens, and the `3 story points` option below is never mounted. Confirmed
    // by construction — clicking during a deliberately slow write reproduces the
    // CI failure exactly (`data-state="closed"`, `aria-expanded="false"`).
    // The pending window is sub-millisecond locally and only opens under a
    // loaded runner, which is why this passed for weeks before shard 1 got
    // heavier.
    const reopenTrigger = (): HTMLButtonElement =>
      screen.getByRole('button', { name: 'Story points: 8 — edit' }) as HTMLButtonElement;
    await waitFor(() => expect(reopenTrigger().disabled).toBe(false));
    fireEvent.click(reopenTrigger());
    fireEvent.click(await screen.findByRole('button', { name: '3 story points' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
