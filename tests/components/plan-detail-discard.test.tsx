// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';

// MOTIR-3240 — the ISLAND half of the discard door: a `generating` plan reaches
// `declinePlanRequest` through a CONFIRM, and a 409 lands the reviewer on the
// plan's real state rather than on an error.
//
// The rail's own four-status behaviour is `plan-review-rail-discard.test.tsx`.
// What is pinned HERE is what only the island can own: that the confirm exists at
// all (ending a plan still being written is irreversible from this surface), that
// it names the proposals already appended, that CANCELLING sends nothing, and
// that the 409 arm — a producer that finished, or a second decider, between
// render and click — refetches instead of surfacing an error.
//
// The heavy canvas and the establish step are stubbed, exactly as the sibling
// island test stubs them: this is a test about which request each action fires.

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  approvePlanRequest: vi.fn(async () => ({})),
  declinePlanRequest: vi.fn(async () => ({})),
  fetchPlanReview: vi.fn(),
}));

// `PlanDetail` reads the URL for its view (MOTIR-3239), so the navigation stub
// covers the three hooks it uses. `useSearchParams` returns an EMPTY set, which
// is the default-view path — the view switcher's own behaviour is
// `plan-detail-view-switch.test.tsx`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
  usePathname: () => '/plans/plan_1',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return {
    ...actual,
    approvePlanRequest: mocks.approvePlanRequest,
    declinePlanRequest: mocks.declinePlanRequest,
    fetchPlanReview: mocks.fetchPlanReview,
  };
});

vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: ({ onEditAdd }: { onEditAdd?: (id: string) => void }) => (
    <div data-testid="plan-review-canvas">
      {onEditAdd ? (
        <button type="button" onClick={() => onEditAdd('item-1')}>
          edit proposal
        </button>
      ) : null}
    </div>
  ),
}));

// The step is stubbed so it reports NOTHING unless a test asks it to — which is
// what lets the rail's code line be attributed to the refreshed prop rather than
// to the step's own mount-time report.
vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: ({ onOutcomeChange }: { onOutcomeChange?: (o: 'ready') => void }) => (
    <div data-testid="repository-set-step">
      <button type="button" onClick={() => onOutcomeChange?.('ready')}>
        report ready
      </button>
    </div>
  ),
}));

vi.mock('@/components/planning/ProposalEditModal', () => ({
  ProposalEditModal: ({
    item,
    onSubmit,
  }: {
    item: { planItemId: string } | null;
    onSubmit: (id: string, input: { title: string }) => void;
  }) =>
    item ? (
      <button type="button" onClick={() => onSubmit(item.planItemId, { title: 'Renamed' })}>
        save proposal
      </button>
    ) : null,
}));

import { PlanDetail } from '@/components/planning/PlanDetail';
import { PlanRequestError } from '@/lib/planning/planReviewClient';

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned' as PlanStatusDto,
    title: 'My plan',
    summary: null,
    itemCount: 2,
    createdAt: '2026-07-31T00:00:00.000Z',
    plannedAt: '2026-07-31T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    // The three-party attribution (MOTIR-2991). The default is the UNATTRIBUTED
    // state, so every pre-existing case keeps asserting a header without one and
    // each attribution state opts in explicitly.
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [
      {
        planItemId: 'item-1',
        op: 'add',
        nodeId: 'item-1',
        parentNodeId: null,
        parentIdentifier: null,
        parentTitle: null,
        parentKind: null,
        parentTrail: [],
        // The FOLDER placement (MOTIR-5415) — none by default.
        folderId: null,
        folderPath: null,
        folderMissing: false,
        folderTrail: [],
        blockedByNodeIds: [],
        blockedByRemovedNodeIds: [],
        committedBlockedBy: [],
        blockerStubs: [],
        identifier: null,
        title: 'A proposed story',
        kind: 'story',
        priority: null,
        type: null,
        descriptionMd: null,
        explanationMd: null,
        explanationSource: null,
        storyPoints: null,
        estimateMinutes: null,
        difficulty: null,
        targetRepo: null,
        targetRepos: [],
        targetRepositories: null,
        targetRepositoryRef: null,
        targetRepoRole: null,
        executor: null,
        planningProvenance: null,
        subject: null,
        initRepositoryName: null,
        status: null,
        statusLabel: null,
        statusCategory: null,
        hasChildren: false,
        changes: [],
        stale: false,
        staleReasons: [],
        revised: false,
        targetMissing: false,
        removeReason: null,
        todos: null,
        proposal: {
          op: 'add',
          identifier: null,
          changedFields: [],
          settableRailFields: [],
          todos: null,
        },
      },
    ],
    stale: false,
    staleCount: 0,
    // A small level, so the derived default is the CANVAS unless a case says
    // otherwise (MOTIR-4024).
    arrivalLevelSize: 1,
    arrivalLevelTotal: 1,
    revision: null,
    ...over,
  };
}

/** An UNESTABLISHED set — one proposed row, which is what the page hands down the
 *  moment a plan is approved and its repositories are derived. */
const generating = () =>
  review({ status: 'generating' as PlanStatusDto, plannedAt: null, itemCount: 3 });

const discarded = () =>
  review({
    status: 'declined' as PlanStatusDto,
    decidedAt: '2026-07-31',
    decisionReason: 'discarded',
  });

beforeEach(() => {
  mocks.fetchPlanReview.mockResolvedValue(discarded());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('discarding a GENERATING plan (MOTIR-3240)', () => {
  it('CONFIRMS before ending it, and the confirm names the proposals so far', async () => {
    renderWithIntl(<PlanDetail initialReview={generating()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: 'Discard this plan' }));

    // The count is the one fact that says what is being thrown away, and the
    // second half is the reassurance the substrate rests on: nothing was ever
    // created, so nothing is lost from the tree.
    expect(screen.getByText('Discard this plan?')).toBeTruthy();
    expect(screen.getByText(/3 proposals so far/)).toBeTruthy();
    expect(screen.getByText(/keeps the proposals as a record/)).toBeTruthy();
    // Nothing has been sent yet.
    expect(mocks.declinePlanRequest).not.toHaveBeenCalled();
  });

  it('CANCELLING sends nothing and leaves the plan generating', async () => {
    renderWithIntl(<PlanDetail initialReview={generating()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: 'Discard this plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep generating' }));

    await waitFor(() => expect(screen.queryByText('Discard this plan?')).toBeNull());
    expect(mocks.declinePlanRequest).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Discard this plan' })).toBeTruthy();
  });

  it('CONFIRMING calls declinePlanRequest, refetches, and lands on the DISCARDED outcome', async () => {
    renderWithIntl(<PlanDetail initialReview={generating()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: 'Discard this plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard plan' }));

    await waitFor(() => expect(mocks.declinePlanRequest).toHaveBeenCalledWith('plan_1', null));
    // The reason-specific line, not the generic declined one — rendering all
    // three endings identically is the defect MOTIR-3189 fixed one layer down.
    await waitFor(() => expect(screen.getByText(/Plan discarded before it finished/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Discard this plan' })).toBeNull();
  });

  it('does NOT refresh server surfaces — a discard reveals none', async () => {
    renderWithIntl(<PlanDetail initialReview={generating()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: 'Discard this plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard plan' }));

    await waitFor(() => expect(mocks.declinePlanRequest).toHaveBeenCalled());
    // Approve reveals the establish step and so refreshes (MOTIR-1947). A
    // discard reveals nothing the server renders, and surface kind 1 must not
    // refresh — the page-state contract.
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('a 409 refetches and shows the plan’s REAL state, with no error line', async () => {
    // The producer finished, or somebody else decided, between render and click.
    // That is a normal outcome on this surface rather than a failure.
    mocks.declinePlanRequest.mockRejectedValueOnce(new PlanRequestError(409, 'CONFLICT'));
    mocks.fetchPlanReview.mockResolvedValue(
      review({ status: 'planned' as PlanStatusDto, itemCount: 3 }),
    );

    renderWithIntl(<PlanDetail initialReview={generating()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: 'Discard this plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard plan' }));

    await waitFor(() => expect(mocks.fetchPlanReview).toHaveBeenCalled());
    // The rail is now the PLANNED one: Approve live, Decline live, no discard.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Discard this plan' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // And the dialog closed rather than asking again for a decision already made.
    expect(screen.queryByText('Discard this plan?')).toBeNull();
  });

  it('a PLANNED plan declines WITHOUT a confirm — that path is unchanged', async () => {
    renderWithIntl(<PlanDetail initialReview={review()} projectKey="MOTIR" />);

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => expect(mocks.declinePlanRequest).toHaveBeenCalledWith('plan_1', null));
    expect(screen.queryByText('Discard this plan?')).toBeNull();
  });
});
