// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR-6025 — the Plans session list's two SERVER halves beside the page: the
// row view-model builder, and the load-more action that re-gates browse on every
// streamed page.

const { getActiveProject, getCapabilities, listSessions, resolveActionReadActor } = vi.hoisted(
  () => ({
    getActiveProject: vi.fn(),
    getCapabilities: vi.fn(),
    listSessions: vi.fn(),
    resolveActionReadActor: vi.fn(),
  }),
);

vi.mock('next-intl/server', () => ({
  getFormatter: async () => ({
    relativeTime: (d: Date) => `at ${d.toISOString()}`,
    dateTime: (d: Date, o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-US', { ...o, timeZone: 'UTC' }).format(d),
  }),
}));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getCapabilities },
}));
vi.mock('@/lib/services/planSessionsService', () => ({
  planSessionsService: { listSessions },
}));
vi.mock('@/lib/visitor/readActor', () => ({ resolveActionReadActor }));

import { buildSessionRowViews } from '@/app/(authed)/plans/sessionRowView';
import { loadMoreSessionsAction } from '@/app/(authed)/plans/_actions';
import type { PlanSessionRowDto } from '@/lib/dto/planSessions';

function dto(over: Partial<PlanSessionRowDto> = {}): PlanSessionRowDto {
  return {
    id: 's_1',
    origin: 'conversation',
    targetKeys: ['ACME-1'],
    lastActivityAt: '2026-09-23T00:00:00.000Z',
    startedBy: { id: 'u1', name: 'Mara' },
    firstTurn: 'What was asked',
    latestPlan: { id: 'p_1', status: 'planned', title: 'The plan' },
    planCount: 1,
    seed: null,
    state: 'planned',
    endedAt: null,
    endReason: null,
    endedBy: null,
    copiedFrom: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProject.mockResolvedValue({ userId: 'u1', workspaceId: 'ws1', projectId: 'p1' });
  getCapabilities.mockResolvedValue({ canBrowse: true });
  resolveActionReadActor.mockResolvedValue({ kind: 'none' });
});

describe('buildSessionRowViews', () => {
  it('titles a row by its first turn, formats its activity, and keeps its plan', async () => {
    const [view] = await buildSessionRowViews([dto()], 'u1');
    expect(view).toEqual({
      id: 's_1',
      origin: 'conversation',
      title: 'What was asked',
      targetKeys: ['ACME-1'],
      activeLabel: 'at 2026-09-23T00:00:00.000Z',
      startedByName: 'Mara',
      latestPlan: { id: 'p_1', status: 'planned' },
      planCount: 1,
      state: 'planned',
      failure: null,
      end: null,
      copiedFrom: null,
      seed: null,
    });
  });

  it('builds the STOP LINE of a failed attempt — a walk on a `waiting` row, a change on a plan’s (MOTIR-7921 / 7944)', async () => {
    const failure = {
      failedAt: '2026-09-22T23:55:00.000Z',
      reason: 'rate_limited',
      stopPhase: 'author' as const,
      stopTitle: 'Export a report',
    };
    const [walk, change] = await buildSessionRowViews(
      [dto({ state: 'waiting', failure }), dto({ id: 's_2', state: 'planned', failure })],
      'u1',
    );
    expect(walk!.failure).toMatchObject({
      kind: 'walk',
      reason: 'rate_limited',
      stopPhase: 'author',
      stopTitle: 'Export a report',
    });
    expect(change!.failure).toMatchObject({ kind: 'change', reason: 'rate_limited' });
    expect(walk!.failure!.timeLabel).toBe('at 2026-09-22T23:55:00.000Z');
  });

  it('carries the halted walk’s not-planned-yet lines in order, and none as an empty list (MOTIR-10209)', async () => {
    const failure = {
      failedAt: '2026-09-22T23:55:00.000Z',
      reason: 'job_failed',
      stopPhase: 'author' as const,
      stopTitle: 'Export a report',
    };
    const lines = [
      '"D" is not planned yet: plan "B" first, then plan "D".',
      'Not written yet: "T".',
    ];
    const [withLines, without] = await buildSessionRowViews(
      [
        dto({ state: 'waiting', failure: { ...failure, notPlannedYet: lines } }),
        dto({ id: 's_2', state: 'waiting', failure }),
      ],
      'u1',
    );
    expect(withLines!.failure!.notPlannedYet).toEqual(lines);
    expect(without!.failure!.notPlannedYet).toEqual([]);
  });

  it('passes the seed through untouched (MOTIR-6209)', async () => {
    const seed = {
      cardKey: 'ACME-44',
      gateKind: 'decision_choice',
      origin: 'refusal',
      chosenLabel: null,
    } as const;
    const [view] = await buildSessionRowViews([dto({ seed })], 'u1');
    expect(view!.seed).toEqual(seed);
  });

  it('falls back to the latest plan’s title, then to nothing', async () => {
    const [byPlan, bare] = await buildSessionRowViews(
      [
        dto({ firstTurn: null, startedBy: null }),
        dto({ firstTurn: null, latestPlan: null, planCount: 0 }),
      ],
      'u1',
    );
    expect(byPlan!.title).toBe('The plan');
    expect(byPlan!.startedByName).toBeNull();
    expect(bare!.title).toBe('');
    expect(bare!.latestPlan).toBeNull();
  });
});

describe('buildSessionRowViews — the END (MOTIR-7642)', () => {
  it('an ended session carries its reason, its end time and who ended it', async () => {
    const [view] = await buildSessionRowViews(
      [
        dto({
          state: 'closed',
          endedAt: '2026-10-03T18:34:00.000Z',
          endReason: 'restarted',
          endedBy: { id: 'u1', name: 'Mara' },
        }),
      ],
      'u1',
    );
    expect(view!.state).toBe('closed');
    expect(view!.end).toEqual({
      reason: 'restarted',
      // Not today, so the short DATE; the full date-time rides `title`.
      timeLabel: 'Oct 3',
      fullLabel: expect.stringContaining('2026'),
      endedByName: 'Mara',
      endedByViewer: true,
    });
  });

  it('ended TODAY reads the short time, and another reader is not "you"', async () => {
    const endedAt = new Date();
    endedAt.setUTCHours(12, 5, 0, 0);
    const [view] = await buildSessionRowViews(
      [
        dto({
          state: 'declined',
          endedAt: endedAt.toISOString(),
          endReason: 'declined',
          endedBy: { id: 'u1', name: 'Mara' },
        }),
      ],
      'u2',
    );
    expect(view!.end).toMatchObject({ timeLabel: '12:05 PM', endedByViewer: false });
  });

  it('an open session has no end; a copy names its source by its end time', async () => {
    const [open, copy, orphan] = await buildSessionRowViews(
      [
        dto(),
        dto({ copiedFrom: { id: 's_0', endedAt: '2026-10-03T18:34:00.000Z' } }),
        dto({ copiedFrom: { id: 's_0', endedAt: null } }),
      ],
      null,
    );
    expect(open!.end).toBeNull();
    expect(copy!.copiedFrom).toEqual({ id: 's_0', whenLabel: 'Oct 3' });
    expect(orphan!.copiedFrom).toBeNull();
  });
});

describe('loadMoreSessionsAction', () => {
  it('streams the next page of the SAME filter and view, as row views', async () => {
    listSessions.mockResolvedValue({ sessions: [dto()], nextCursor: 'cur_2', scope: 'mine' });

    const out = await loadMoreSessionsAction('cur_1', 'none', 'mine');

    expect(listSessions).toHaveBeenCalledWith(
      'p1',
      { userId: 'u1', workspaceId: 'ws1' },
      { cursor: 'cur_1', planState: 'none', view: 'mine' },
    );
    expect(out).toEqual({
      views: [expect.objectContaining({ id: 's_1' })],
      nextCursor: 'cur_2',
    });
  });

  it('streams nothing once signed out', async () => {
    getActiveProject.mockResolvedValue(null);
    expect(await loadMoreSessionsAction('cur_1', null, 'project')).toEqual({
      views: [],
      nextCursor: null,
    });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('re-gates browse — access lost mid-scroll streams nothing', async () => {
    getCapabilities.mockResolvedValue({ canBrowse: false });
    expect(await loadMoreSessionsAction('cur_1', null, 'project')).toEqual({
      views: [],
      nextCursor: null,
    });
    expect(listSessions).not.toHaveBeenCalled();
  });

  // MOTIR-6890 — a Visitor's list streams the public project the cookie names.
  it('a Visitor streams the VIEWED project in the Project view, not their active one', async () => {
    const visitorCtx = { project: { id: 'pub' }, actorUserId: 'v1' };
    resolveActionReadActor.mockResolvedValue({ kind: 'visitor', ctx: visitorCtx });
    listSessions.mockResolvedValue({ sessions: [dto()], nextCursor: null, scope: 'project' });

    const out = await loadMoreSessionsAction('cur_1', null, 'mine');

    expect(listSessions).toHaveBeenCalledWith('pub', visitorCtx, {
      cursor: 'cur_1',
      planState: null,
      view: 'project',
    });
    expect(getActiveProject).not.toHaveBeenCalled();
    expect(out).toEqual({ views: [expect.objectContaining({ id: 's_1' })], nextCursor: null });
  });

  it('a Visitor past the read budget gets the rate-limited answer', async () => {
    resolveActionReadActor.mockResolvedValue({ kind: 'limited', response: new Response() });
    expect(await loadMoreSessionsAction('cur_1', null, 'project')).toEqual({
      ok: false,
      error: 'rate_limited',
    });
    expect(listSessions).not.toHaveBeenCalled();
  });
});
