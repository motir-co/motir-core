// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto } from '@/lib/dto/plans';
import type { ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';

// MOTIR-1947 — APPROVING a plan must reveal the establish step in the SAME page
// view. The step is rendered from the project's repository-set view, which the
// page reads only for a plan that was already approved (`repositorySet`), while
// the review itself lives in this client island's `useState`. MOTIR-1947 made
// approve do both: the island's refetch AND a route refresh to re-run the page's
// read. Story MOTIR-8539 · MOTIR-8576 RETIRED THE REFRESH: the island now reads
// the same view itself (`fetchRepositorySet`, the step's own poll), so the step
// still appears in the same page view and nothing re-renders the page under the
// reader.
//
// What is pinned here is the ROUTING of each surface to its mechanism, so the
// bug cannot come back quietly: approve refetches the review and reads the step,
// decline does neither and refreshes nothing, and the rail's code line follows
// the view — not a seed that only ever ran at mount.
//
// The heavy canvas and the establish step are stubbed: this is a test about which
// update mechanism each action fires, and the step's own screen is covered by
// `RepositorySetStep.test.tsx` plus the Story's acceptance E2E.

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  approvePlanRequest: vi.fn(async () => ({})),
  declinePlanRequest: vi.fn(async () => ({})),
  fetchPlanReview: vi.fn(),
  fetchRepositorySet: vi.fn(),
  reread: vi.fn(),
}));

vi.mock('@/lib/planning/repositorySetClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/repositorySetClient')>()),
  fetchRepositorySet: mocks.fetchRepositorySet,
}));
vi.mock('@/lib/workbench/workbenchReread', () => ({
  useRequestWorkbenchReread: () => mocks.reread,
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
function repositorySet(): { projectKey: string; view: ProjectRepoEstablishViewDto } {
  return {
    projectKey: 'MOTIR',
    view: {
      set: {
        projectId: 'proj_1',
        rows: [
          {
            id: 'repo-1',
            projectId: 'proj_1',
            role: 'web',
            name: 'motir-web',
            label: null,
            state: 'proposed',
            hostingTarget: null,
            hostingUseCase: null,
            hostingSize: null,
            position: 'a0',
            seedSource: 'nextjs-prisma-vercel-starter',
            failureReason: null,
            proposalSignal: null,
            seedMatch: null,
            realizedRepo: null,
            established: false,
            takeover: null,
            access: { state: 'not_invited', login: null, invitationUrl: null },
            createdAt: '2026-07-31T00:00:00.000Z',
            updatedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
        ownership: null,
        targetAccount: null,
      },
      hostOwner: 'motir-projects',
      githubLogin: null,
      githubAvatarUrl: null,
      hasInstallation: false,
      connectCandidates: [],
    },
  };
}

const approved = () =>
  review({ status: 'approved' as PlanStatusDto, decidedByName: 'Yue', decidedAt: '2026-07-31' });

beforeEach(() => {
  mocks.fetchPlanReview.mockResolvedValue(approved());
  mocks.fetchRepositorySet.mockResolvedValue(repositorySet().view);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlanDetail — approving reveals the establish step with NO route refresh (MOTIR-1947 · MOTIR-8576)', () => {
  it('approve refetches the review ONCE, reads the step’s view, asks a Workbench reread, and never refreshes', async () => {
    renderWithIntl(<PlanDetail projectKey="PRJ" initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    await waitFor(() => expect(mocks.approvePlanRequest).toHaveBeenCalledWith('plan_1', null));
    await waitFor(() => expect(mocks.fetchRepositorySet).toHaveBeenCalledWith('PRJ'));
    expect(mocks.fetchPlanReview).toHaveBeenCalledTimes(1);
    expect(mocks.reread).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('still updates the review itself — the refresh does not replace the client refetch', async () => {
    renderWithIntl(<PlanDetail projectKey="PRJ" initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    // The rail's decided outcome comes from the island's own state, which only the
    // refetch can move.
    expect(await screen.findByText('Added 2 items to your backlog')).toBeTruthy();
  });

  it('shows the step and its rail line in the SAME page view after approve — with no remount, no refresh', async () => {
    renderWithIntl(<PlanDetail projectKey="PRJ" initialReview={review()} repositorySet={null} />);
    const canvas = screen.getByTestId('plan-review-canvas');

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    // The establish step — the surface the route refresh used to deliver — arrives
    // from the island's own read of the repository set.
    expect(await screen.findByTestId('repository-set-step')).toBeTruthy();
    expect(screen.getByTestId('plan-code-outcome').textContent).toContain(
      'Finish setting up repositories',
    );
    expect(mocks.refresh).not.toHaveBeenCalled();

    // ⚠️ AMENDED by MOTIR-3161 (bug MOTIR-3154). This asserted
    // `plan-review-canvas` was GONE — the rule Story MOTIR-1775 / MOTIR-1782
    // shipped, that the step REPLACES the canvas. `design/ai-planning/design-notes.md`
    // Part VI §4 re-decides it: after MOTIR-3160 the pane holds the RECORD of the
    // decision rather than the spent proposals, so the step now STACKS above the
    // canvas instead of taking its place.
    //
    // What this case is ACTUALLY about is unchanged and is what still matters
    // here: the step reaches a LIVE island and appears with no remount. Both
    // halves are asserted — the canvas is the SAME node it was before the press.
    expect(screen.getByTestId('plan-review-canvas')).toBe(canvas);
  });

  it('a failed read of the step’s view degrades to no step, still with no refresh', async () => {
    mocks.fetchRepositorySet.mockRejectedValueOnce(new Error('offline'));
    renderWithIntl(<PlanDetail projectKey="PRJ" initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    await waitFor(() => expect(mocks.fetchRepositorySet).toHaveBeenCalled());
    expect(await screen.findByText('Added 2 items to your backlog')).toBeTruthy();
    expect(screen.queryByTestId('repository-set-step')).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('does not read the view again when the page already handed it down', async () => {
    renderWithIntl(
      <PlanDetail projectKey="PRJ" initialReview={review()} repositorySet={repositorySet()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    await waitFor(() => expect(mocks.reread).toHaveBeenCalledTimes(1));
    expect(mocks.fetchRepositorySet).not.toHaveBeenCalled();
  });

  it('carries the rail code line from a prop delivered AFTER mount — not a mount-time seed', () => {
    // A prop that changes on a LIVE island (a navigation back onto the page): same
    // instance, new props. A
    // `useState(() => …)` seed runs once and would leave the approved outcome
    // with no code line at all, which is the second half of the reported defect.
    const { rerender } = renderWithIntl(
      <PlanDetail projectKey="PRJ" initialReview={approved()} repositorySet={null} />,
    );
    expect(screen.queryByTestId('plan-code-outcome')).toBeNull();

    rerender(
      <PlanDetail projectKey="PRJ" initialReview={approved()} repositorySet={repositorySet()} />,
    );

    expect(screen.getByTestId('plan-code-outcome').textContent).toContain(
      'Finish setting up repositories',
    );
  });

  it('lets the step OVERRIDE the derived outcome once it reports its own', async () => {
    renderWithIntl(
      <PlanDetail projectKey="PRJ" initialReview={approved()} repositorySet={repositorySet()} />,
    );

    expect(screen.getByTestId('plan-code-outcome').textContent).toContain(
      'Finish setting up repositories',
    );

    fireEvent.click(screen.getByRole('button', { name: 'report ready' }));

    expect(screen.getByTestId('plan-code-outcome').textContent).toContain('Your code is ready');
  });

  it('on a 409 too — a concurrent reviewer approved — it reads the review once and the step, with no refresh', async () => {
    mocks.approvePlanRequest.mockRejectedValueOnce(new PlanRequestError(409, 'ALREADY_DECIDED'));

    renderWithIntl(<PlanDetail projectKey="PRJ" initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/i }));

    expect(await screen.findByTestId('repository-set-step')).toBeTruthy();
    expect(mocks.fetchPlanReview).toHaveBeenCalledTimes(1);
    expect(mocks.reread).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('DECLINE does not refresh, read the step or ask a reread — it decides nothing that moves', async () => {
    mocks.fetchPlanReview.mockResolvedValue(review({ status: 'declined' as PlanStatusDto }));

    renderWithIntl(<PlanDetail projectKey="PRJ" initialReview={review()} repositorySet={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Decline/i }));

    await waitFor(() => expect(mocks.declinePlanRequest).toHaveBeenCalledWith('plan_1', null));
    await waitFor(() => expect(mocks.fetchPlanReview).toHaveBeenCalled());
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.fetchRepositorySet).not.toHaveBeenCalled();
    expect(mocks.reread).not.toHaveBeenCalled();
  });

  // The proposal INLINE EDIT test was REMOVED with the feature (MOTIR-3084):
  // MOTIR-1370's edit modal is gone, so there is no longer an inline-edit
  // surface to assert the no-refresh contract on. That contract is unchanged and
  // still covered here by the approve / decline cases above, which are the other
  // mutations this island makes.
});
