// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { planReview, planReviewItem } from '../helpers/planReview';
import en from '@/messages/en.json';

// BUG MOTIR-9006 — RE-OPENING A PLAN THAT IS BEING APPROVED. A reader pressed Approve on a
// large plan and closed the overlay while it materialized; re-opening it rebuilt the whole
// review — Approve, Decline, edit and the composer all live on a plan halfway through being
// written. The plan now reads `approving` while that runs, and the overlay must draw the
// approve IN PROGRESS with no verb, and move to the approved state when it commits.
//
// The REAL `usePlanChangeConversation` drives the REAL `PlanningWorkspaceHost`, as in
// `planning-generating-session-open.test.tsx`: the defect lives in the seam between the
// hook's phase and the host's bar. Only the transport is stubbed (the session read and the
// plan read), and the proposed pane is a marker.

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
vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: () => <div data-testid="roadmap-stub" />,
}));
vi.mock('@/components/planning/PlanProposalViews', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/planning/PlanProposalViews')>();
  return { ...real, PlanProposalViews: () => <div data-testid="plan-views-stub" /> };
});

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';
import { APPROVING_POLL_MS } from '@/lib/hooks/usePlanChangeConversation';

const SESSION: PlanChangeSessionDto = {
  id: 's9',
  projectId: 'p1',
  targetKeys: [],
  turnCount: 0,
  lastJobId: null,
  lastSubmittedAt: null,
  lastActivityAt: '2026-11-10T10:00:00.000Z',
  origin: 'conversation',
  createdAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  turns: [],
  workItemRefs: {},
  startedBy: { id: 'u1', name: 'Mara Lind' },
  startedByViewer: true,
  viewerCanPlan: true,
  pendingPlanId: 'plan_7',
};

const ITEMS = [
  planReviewItem({ planItemId: 'pi_1', nodeId: 'pi_1', title: 'One' }),
  planReviewItem({ planItemId: 'pi_2', nodeId: 'pi_2', title: 'Two' }),
];
const GATE = {
  id: 'gate-reopen',
  state: 'awaiting' as const,
  stamp: 's',
  held: null,
  canDecide: true,
};
const read = (over: Partial<PlanReviewDto>) =>
  planReview(ITEMS, { id: 'plan_7', gate: GATE, ...over });
const WATCH = { timeout: APPROVING_POLL_MS * 4 };
const progress = en.planReview.approveProgress.creating.replace(
  '{n, plural, one {# item} other {# items}}',
  '2 items',
);

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
  getNamed.mockReset().mockResolvedValue(SESSION);
  fetchReview.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('re-opening a plan that is BEING APPROVED (MOTIR-9006 AC 2)', () => {
  it('⭐ draws the plan with the approve in progress and NO verb, then lands on approved', async () => {
    fetchReview
      .mockResolvedValueOnce(read({ status: 'approving' }))
      .mockResolvedValueOnce(read({ status: 'approving' }))
      .mockResolvedValue(read({ status: 'approved' }));
    mount();

    // The plan, not the roadmap — and the bar's contents are the progress.
    await waitFor(() => expect(screen.getByTestId('plan-views-stub')).toBeTruthy());
    expect(screen.queryByTestId('roadmap-stub')).toBeNull();
    const bar = screen.getByTestId('plan-change-confirm-bar');
    expect(within(bar).getByText(progress)).toBeTruthy();
    // Approve and Decline are gone from the bar: nothing is left to press twice.
    expect(within(bar).queryByRole('button', { name: /approve/i })).toBeNull();
    expect(within(bar).queryByRole('button', { name: /decline/i })).toBeNull();

    // The watch reads the plan until the approval commits; the bar then leaves.
    await waitFor(() => expect(screen.queryByTestId('plan-change-confirm-bar')).toBeNull(), WATCH);
    expect(fetchReview.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('an approval that failed while away gives the bar its verbs back', async () => {
    fetchReview
      .mockResolvedValueOnce(read({ status: 'approving' }))
      .mockResolvedValue(read({ status: 'planned' }));
    mount();

    await waitFor(() => expect(screen.getByTestId('plan-change-confirm-bar')).toBeTruthy());
    expect(within(screen.getByTestId('plan-change-confirm-bar')).getByText(progress)).toBeTruthy();
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId('plan-change-confirm-bar')).queryByText(progress),
        ).toBeNull(),
      WATCH,
    );
    expect(
      within(screen.getByTestId('plan-change-confirm-bar')).getAllByRole('button').length,
    ).toBeGreaterThan(0);
  });
});
