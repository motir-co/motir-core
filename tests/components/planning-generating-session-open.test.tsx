// @vitest-environment happy-dom
import { type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { planReview, planReviewItem } from '../helpers/planReview';

// MOTIR-6346 — opening a NAMED session whose plan is still GENERATING (an MCP agent
// is writing it; a Plans row opens it) must not flash the roadmap before the live
// pane. The pending-proposal read is null for a `generating` plan by design, so the
// conversation falls back to the generating poll (MOTIR-6295) — and the pane has
// nothing to draw until that poll's FIRST read lands. MOTIR-6289 kept the skeleton
// up while the pending read was in flight; this is the same interval one read later.
//
// Unlike `planning-workspace-host.test.tsx` and `planning-session-open.test.tsx`,
// NEITHER half is mocked here: the REAL `usePlanChangeConversation` drives the REAL
// `PlanningWorkspaceHost`, because the defect lives in the seam between them — the
// hook's phase and the host's pane choice. Only the transport is stubbed (the
// session read and the plan read), and the two panes are markers that record every
// render, so "the roadmap was drawn in between" is a log entry rather than a race.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, tooShort: true }),
}));

const { getNamed, fetchReview } = vi.hoisted(() => ({
  getNamed: vi.fn(),
  fetchReview: vi.fn(),
}));
vi.mock('@/lib/planning/planChangeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/planChangeClient')>()),
  getPlanChangeSession: getNamed,
}));
vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/planReviewClient')>()),
  fetchPlanReview: fetchReview,
}));

// ⭐ THE PANE LOG — every render of either pane, in order.
const { panes } = vi.hoisted(() => ({ panes: [] as string[] }));
vi.mock('@/components/planning/PlanProposalViews', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/planning/PlanProposalViews')>();
  function Logged(props: ComponentProps<typeof real.PlanProposalViews>) {
    // Before a plan the pane is the roadmap (`prePlan`, MOTIR-11513).
    if (props.prePlan) {
      panes.push('roadmap');
      return <div data-testid="roadmap-stub" />;
    }
    panes.push(props.live ? 'live' : 'proposed');
    return <div data-testid="plan-views-stub" data-live={String(props.live === true)} />;
  }
  return { ...real, PlanProposalViews: Logged };
});

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';

const SESSION: PlanChangeSessionDto = {
  id: 's9',
  projectId: 'p1',
  targetKeys: [],
  turnCount: 0,
  lastJobId: null,
  lastSubmittedAt: null,
  lastActivityAt: '2026-09-25T10:00:00.000Z',
  origin: 'conversation',
  createdAt: '2026-09-25T09:00:00.000Z',
  updatedAt: '2026-09-25T10:00:00.000Z',
  turns: [],
  workItemRefs: {},
  startedBy: { id: 'u1', name: 'Mara Lind' },
  startedByViewer: true,
  viewerCanPlan: true,
  pendingPlanId: 'plan_7',
};

const generating = (items = [planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1' })]) =>
  planReview(items, { id: 'plan_7', status: 'generating', plannedAt: null });

/** A plan read the test answers when it chooses. */
function heldRead() {
  let release!: { resolve: (r: PlanReviewDto) => void; reject: (e: unknown) => void };
  const read = new Promise<PlanReviewDto>((resolve, reject) => (release = { resolve, reject }));
  return { read, release };
}

function mount() {
  return renderWithIntl(
    <PlanningWorkspaceHost
      projectKey="ACME"
      projectName="Acme"
      launch={{ ...parsePlanningLaunch({ mode: 'replan', from: 'project' }), sessionId: 's9' }}
      onClose={() => {}}
      initialTarget={null}
    />,
  );
}

beforeEach(() => {
  panes.length = 0;
  getNamed.mockReset().mockResolvedValue(SESSION);
  fetchReview.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('opening a GENERATING named session — skeleton, then the live pane, never the roadmap', () => {
  it('⭐ the skeleton stands while the poll’s first read is in flight, and the first pane drawn is the LIVE one', async () => {
    // Read 1 is the mount's pending-proposal read: the plan is `generating`, so it is
    // null by design. Read 2 is the generating poll's FIRST read — held open, the
    // way a slow network holds it.
    const pollRead = heldRead();
    fetchReview.mockResolvedValueOnce(generating()).mockReturnValueOnce(pollRead.read);
    mount();

    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    // Between the two reads the pane is the skeleton — no roadmap, no plan.
    expect(screen.getByTestId('planning-pane-opening')).toBeTruthy();
    expect(screen.queryByTestId('roadmap-stub')).toBeNull();
    expect(panes).toEqual([]);

    await act(async () => pollRead.release.resolve(generating()));
    await waitFor(() => expect(screen.getByTestId('plan-views-stub')).toBeTruthy());
    expect(screen.getByTestId('plan-views-stub').getAttribute('data-live')).toBe('true');
    expect(screen.queryByTestId('planning-pane-opening')).toBeNull();
    // The whole sequence, in order: nothing but the live pane was ever drawn.
    expect(panes.length).toBeGreaterThan(0);
    expect(new Set(panes)).toEqual(new Set(['live']));
  });

  it('a plan the poll finds already OUT of `generating` settles on the roadmap — the no-plan state, as before', async () => {
    const pollRead = heldRead();
    fetchReview.mockResolvedValueOnce(generating()).mockReturnValueOnce(pollRead.read);
    mount();

    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('planning-pane-opening')).toBeTruthy();

    // Decided between the two reads: there is no plan to show, and no live pane.
    await act(async () =>
      pollRead.release.resolve(
        planReview([planReviewItem()], { id: 'plan_7', status: 'approved' }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('roadmap-stub')).toBeTruthy());
    expect(screen.queryByTestId('planning-pane-opening')).toBeNull();
    expect(new Set(panes)).toEqual(new Set(['roadmap']));
  });

  it('a poll that keeps FAILING does not hold the skeleton forever — it settles on the roadmap once the poll reports failing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fetchReview
      .mockResolvedValueOnce(generating())
      .mockRejectedValue(new TypeError('Failed to fetch'));
    mount();

    await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('planning-pane-opening')).toBeTruthy();

    // Two more failed ticks: the poll's `failing` threshold (FAILING_AFTER = 3).
    for (const calls of [3, 4]) {
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      await waitFor(() => expect(fetchReview).toHaveBeenCalledTimes(calls));
    }
    await waitFor(() => expect(screen.getByTestId('roadmap-stub')).toBeTruthy());
    expect(screen.queryByTestId('planning-pane-opening')).toBeNull();
  });
});
