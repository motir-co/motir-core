// @vitest-environment happy-dom
//
// THE SURFACE-ARRIVAL INTEGRATION GATE (MOTIR-6162, Story MOTIR-6154).
//
// ── The tier, and why the story needs one ──────────────────────────────────
// The two code cards each shipped units: `surfaceArrivalTrail` is ruled on
// directly (`tests/planning/surfaceArrival.test.ts`), and so is the canvas's
// `followTo` contract (`tests/components/ProjectRoadmapCanvas.test.tsx`). Neither
// can see the thing this story actually fixes, which lives BETWEEN them: the
// overlay's anchor read, the host's target set and the canvas's first level are
// three components, and a unit of any one of them mocks the other two.
//
// So this spec mounts the REAL chain — `PlanningWorkspaceOverlay` →
// `PlanningWorkspaceHost` → `PlanProposalViews` → `PlanReviewCanvas` →
// `ProjectRoadmapCanvas` — and
// stubs only what is genuinely outside it: the two network reads and the
// conversation transport. The canvas is NOT mocked, which is the whole point.
//
// ⚠️ It needs no database, and it is in `tests/integration/` anyway because the
// TIER is what the directory names, not the datastore. The root Vitest config
// provisions a Postgres per worker for every file it runs, so this one gets one
// it never opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { renderWithIntl as render } from '../../helpers/renderWithIntl';
import { planReview, planReviewItem } from '../../helpers/planReview';
import { surfaceArrivalTrail } from '@/lib/planning/surfaceArrival';
import { arrivalLevel } from '@/lib/planning/planArrival';

// ── The seams OUTSIDE the chain under test ─────────────────────────────────
let params = new URLSearchParams();
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/backlog',
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));

const { fetchRoadmapLevel } = vi.hoisted(() => ({ fetchRoadmapLevel: vi.fn() }));
vi.mock('@/lib/planning/roadmapClient', () => ({ fetchRoadmapLevel }));

const { resolveOnboardingRouting } = vi.hoisted(() => ({ resolveOnboardingRouting: vi.fn() }));
vi.mock('@/lib/planning/onboardingRoutingClient', () => ({ resolveOnboardingRouting }));

const { fetchPlanningSubstrate } = vi.hoisted(() => ({ fetchPlanningSubstrate: vi.fn() }));
vi.mock('@/lib/planning/substratePoll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/substratePoll')>()),
  fetchPlanningSubstrate: (...a: unknown[]) => fetchPlanningSubstrate(...a),
}));

// The actor's permission set — the shell's provider. Stubbed because it reaches
// the server, not because this spec has an opinion about permissions.
vi.mock('@/app/(authed)/_components/ProjectAccessProvider', () => ({
  useProjectAccess: () => ({ can: () => true }),
}));

// The composer's target search is a network read of its own, and nothing here
// types into the composer.
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, error: null }),
}));

// The peek PANEL is an app-level component that reaches the server (and through
// it `lib/db`). Nothing here opens a peek; the canvas's own quick-view hook stays
// real so the canvas is not mocked, which is this tier's whole point.
vi.mock('@/app/(authed)/items/_components/IssueQuickViewPanel', () => ({
  IssueQuickViewPanel: () => null,
}));

const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as unknown,
    send: vi.fn(),
    retry: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
  },
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => conversation,
}));

// ── The tree the canvas reads, one level at a time (MOTIR-1010) ────────────
//
//   root ─ E1 "Refine AI planning" ─ S1 "The story" ─ T1, T2
//        └ E2 "Reporting"                          └ S2 "A sibling story"
const ITEM = (
  id: string,
  identifier: string,
  title: string,
  kind: string,
  hasChildren = false,
) => ({
  id,
  identifier,
  title,
  kind,
  status: 'todo',
  statusLabel: 'To Do',
  statusCategory: 'todo',
  hasChildren,
  type: null,
  executor: null,
  assigneeName: null,
  ready: false,
  progress: null,
});

const LEVELS: Record<string, { items: unknown[]; edges: unknown[]; offLevelBlockers: unknown[] }> =
  {
    __root__: {
      items: [
        ITEM('wi_e1', 'MOTIR-1', 'Refine AI planning', 'epic', true),
        ITEM('wi_e2', 'MOTIR-5', 'Reporting', 'epic'),
      ],
      edges: [],
      offLevelBlockers: [],
    },
    wi_e1: {
      items: [
        ITEM('wi_s1', 'MOTIR-3', 'The story', 'story', true),
        ITEM('wi_s2', 'MOTIR-4', 'A sibling story', 'story'),
      ],
      edges: [],
      offLevelBlockers: [],
    },
    wi_s1: {
      items: [
        ITEM('wi_t1', 'MOTIR-9', 'The subtask', 'subtask'),
        ITEM('wi_t2', 'MOTIR-10', 'Another subtask', 'subtask'),
      ],
      edges: [],
      offLevelBlockers: [],
    },
  };

const EPIC_ANCESTOR = { id: 'wi_e1', identifier: 'MOTIR-1', title: 'Refine AI planning' };
const STORY_ANCHOR = {
  id: 'wi_s1',
  identifier: 'MOTIR-3',
  title: 'The story',
  kind: 'story' as const,
};
const SUBTASK_ANCHOR = {
  id: 'wi_t1',
  identifier: 'MOTIR-9',
  title: 'The subtask',
  kind: 'subtask' as const,
};

// The conversation's IDLE state, in the shape the rail really reads — copied from
// `tests/components/planning-workspace-host.test.tsx`, because a partial stub
// crashes the rail rather than failing an assertion, which is a worse signal.
const IDLE = {
  phase: 'idle',
  session: {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 0,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    origin: 'conversation',
    createdAt: '',
    updatedAt: '',
    turns: [],
    workItemRefs: {},
  },
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
  acts: [],
};

beforeEach(() => {
  params = new URLSearchParams();
  vi.clearAllMocks();
  conversation.state = { ...IDLE };
  resolveOnboardingRouting.mockResolvedValue({ decision: 'continue' });
  fetchRoadmapLevel.mockImplementation((_project: string, parentId: string | null) =>
    Promise.resolve(
      LEVELS[parentId ?? '__root__'] ?? { items: [], edges: [], offLevelBlockers: [] },
    ),
  );
});
afterEach(() => cleanup());

const { PlanningWorkspaceOverlay } = await import('@/components/planning/PlanningWorkspaceOverlay');

function openAt(query: string) {
  params = new URLSearchParams(query);
}

async function mountSurface() {
  const view = render(
    <PlanningWorkspaceOverlay projectKey="MOTIR" projectName="Motir" substrate={null} />,
  );
  await act(async () => {});
  return view;
}

function titlesOnLevel(): string[] {
  const nodes = Array.from(document.querySelectorAll('[data-node-id]'));
  return nodes.map((n) => n.textContent ?? '').filter(Boolean);
}
function onLevel(title: string): boolean {
  return titlesOnLevel().some((t) => t.includes(title));
}
function breadcrumb() {
  return screen.queryByRole('navigation', { name: 'Breadcrumb' });
}

describe('ONE ARRIVAL RULE, EVERY ENTRANCE', () => {
  // ⚠️ The point of driving all three rather than writing three look-alike unit
  // tests: they differ ONLY in the address, and the claim is that the address is
  // the only thing that differs. A unit test per entrance would assert that by
  // construction instead of measuring it.
  const ENTRANCES: Array<[string, string]> = [
    ['Plan with AI on a work item', 'plan=contextual&planFrom=work-item&planItem=MOTIR-3'],
    [
      'a Plans row reopening a session whose target is that story',
      'plan=contextual&planFrom=work-item&planItem=MOTIR-3&planSession=sess_1&planVia=plans',
    ],
    [
      'a To-approve row',
      'plan=contextual&planFrom=work-item&planItem=MOTIR-3&planSession=sess_1&planVia=approvals',
    ],
  ];

  it.each(ENTRANCES)('%s arrives INSIDE the story', async (_name, query) => {
    fetchPlanningAnchor.mockResolvedValue({
      anchor: STORY_ANCHOR,
      ancestors: [EPIC_ANCESTOR],
      hasChildren: true,
    });
    openAt(query);
    await mountSurface();

    // The story's CHILDREN are on the level…
    await waitFor(() => expect(onLevel('The subtask')).toBe(true));
    expect(onLevel('Another subtask')).toBe(true);
    // …and its SIBLING is not, which is what the old ancestors-only trail drew.
    expect(onLevel('A sibling story')).toBe(false);

    // …and it is EXACTLY the level the one rule names for this anchor.
    const expected = surfaceArrivalTrail({
      anchor: STORY_ANCHOR,
      ancestors: [EPIC_ANCESTOR],
      hasChildren: true,
    });
    const crumb = breadcrumb()!;
    for (const c of expected) {
      expect(within(crumb).getByText(c.label)).toBeTruthy();
    }
    // The last crumb IS the target, and it is marked as one.
    expect(within(crumb).getByRole('button', { current: 'page' }).textContent).toContain(
      'MOTIR-3 · The story',
    );
    expect(within(crumb).getByText('Planning target:')).toBeTruthy();
  });
});

describe('THE KINDS', () => {
  it('a `subtask` anchor opens on its OWN level, ringed — not inside it', async () => {
    fetchPlanningAnchor.mockResolvedValue({
      anchor: SUBTASK_ANCHOR,
      ancestors: [EPIC_ANCESTOR, { id: 'wi_s1', identifier: 'MOTIR-3', title: 'The story' }],
      hasChildren: false,
    });
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-9');
    await mountSurface();

    // The story's children — the anchor AND its sibling, which is the containing
    // level rather than the anchor's own (a subtask has none).
    await waitFor(() => expect(onLevel('The subtask')).toBe(true));
    expect(onLevel('Another subtask')).toBe(true);
    // The crumb ends at the PARENT, and carries no target mark: the target is a
    // NODE here, so the ring holds it. Exactly one of the two is ever marked.
    const crumb = breadcrumb()!;
    expect(within(crumb).getByRole('button', { current: 'page' }).textContent).toContain(
      'MOTIR-3 · The story',
    );
    expect(within(crumb).queryByText('Planning target:')).toBeNull();
  });

  it('a CHILDLESS story opens on its OWN level, beside its siblings (MOTIR-7621)', async () => {
    // A story not yet broken down has no inside: opening inside it drew an empty
    // level with the item the conversation is about nowhere on screen.
    fetchPlanningAnchor.mockResolvedValue({
      anchor: { id: 'wi_s2', identifier: 'MOTIR-4', title: 'A sibling story', kind: 'story' },
      ancestors: [EPIC_ANCESTOR],
      hasChildren: false,
    });
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-4');
    await mountSurface();

    // The epic's children — the anchor itself AND its sibling.
    await waitFor(() => expect(onLevel('A sibling story')).toBe(true));
    expect(onLevel('The story')).toBe(true);
    // The crumb ends at the PARENT with no target mark; the node ring holds it.
    const crumb = breadcrumb()!;
    expect(within(crumb).getByRole('button', { current: 'page' }).textContent).toContain(
      'MOTIR-1 · Refine AI planning',
    );
    expect(within(crumb).queryByText('Planning target:')).toBeNull();
  });

  it('a 404 anchor opens the ROOT, with no error surface', async () => {
    // The no-existence-leak answer: stale, deleted, foreign and forbidden are one
    // answer, and it is indistinguishable from "no target was named".
    fetchPlanningAnchor.mockResolvedValue(null);
    openAt('plan=contextual&planFrom=work-item&planItem=MOTIR-99999');
    await mountSurface();

    await waitFor(() => expect(onLevel('Refine AI planning')).toBe(true));
    expect(onLevel('Reporting')).toBe(true);
    expect(breadcrumb()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('THE FOLLOW-MOVE, assembled', () => {
  it('a project launch stays at the ROOT until something settles', async () => {
    openAt('plan=project&planFrom=project');
    await mountSurface();

    await waitFor(() => expect(onLevel('Refine AI planning')).toBe(true));
    expect(breadcrumb()).toBeNull();
  });

  it('moves inside the level the PLAN lands in, once it is proposed', async () => {
    // ⚠️ THE ASSERTION THAT FAILS ON THE PRE-STORY CODE: before this story the
    // canvas stayed at the root while the plan's cards were proposed a level
    // below, and nothing told the reader to go down.
    openAt('plan=project&planFrom=project');
    const view = await mountSurface();
    await waitFor(() => expect(onLevel('Refine AI planning')).toBe(true));

    const review = planReview([
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: 'wi_e1',
        parentIdentifier: 'MOTIR-1',
        parentTitle: 'Refine AI planning',
        parentTrail: [{ id: 'wi_e1', identifier: 'MOTIR-1', title: 'Refine AI planning' }],
      }),
    ]);
    conversation.state = { ...IDLE, review };
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="MOTIR" projectName="Motir" substrate={null} />,
    );

    // …and it is the level `arrivalLevel` names, not a second opinion about it.
    const expected = arrivalLevel(review.items, 'New');
    expect(expected?.id).toBe('wi_e1');
    await waitFor(() => expect(onLevel('The story')).toBe(true));
    expect(onLevel('Refine AI planning')).toBe(false);
    // The reader is told where it went.
    expect(screen.getByTestId('canvas-follow-live').textContent).toContain('MOTIR-1');
  });

  it('does NOT move a reader who navigated first — and offers to take them instead', async () => {
    // ⚠️ THE OTHER ASSERTION THAT FAILS ON A NAIVE FOLLOW: it would yank the
    // reader out of the level they chose.
    openAt('plan=project&planFrom=project');
    const view = await mountSurface();
    await waitFor(() => expect(onLevel('Refine AI planning')).toBe(true));

    // the reader drills themselves
    const epic = Array.from(document.querySelectorAll('[data-node-id]')).find((n) =>
      (n.textContent ?? '').includes('Refine AI planning'),
    )!;
    fireEvent.keyDown(epic, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    await waitFor(() => expect(onLevel('The story')).toBe(true));

    // …and only then does the plan land somewhere else
    const review = planReview([
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: 'wi_s1',
        parentIdentifier: 'MOTIR-3',
        parentTitle: 'The story',
        parentTrail: [{ id: 'wi_s1', identifier: 'MOTIR-3', title: 'The story' }],
      }),
    ]);
    conversation.state = { ...IDLE, review };
    view.rerender(
      <PlanningWorkspaceOverlay projectKey="MOTIR" projectName="Motir" substrate={null} />,
    );
    await act(async () => {});

    // still where they put themselves
    expect(onLevel('The story')).toBe(true);
    expect(onLevel('The subtask')).toBe(false);
    // …and not stranded: the bar offers the trip they did not take.
    expect(await screen.findByTestId('canvas-follow-offer')).toBeTruthy();
  });
});

describe('ONE ENGINE', () => {
  it('the surface and the plan page ask the SAME function where a plan lands', async () => {
    // Not "they agree" measured twice — they are the same call. The import below
    // is the plan page's own, re-exported from the module it moved to.
    const fromLib = await import('@/lib/planning/planArrival');
    const fromPlanPage = await import('@/components/planning/PlanReviewCanvas');
    expect(fromPlanPage.arrivalLevel).toBe(fromLib.arrivalLevel);
  });

  it('NO SECOND COPY of the arrival computation exists outside `lib/planning/planArrival.ts`', () => {
    // The guard the card asks for, and the drift it exists to catch: the surface
    // and the plan page fell out of step in the first place because each decided
    // where a plan lands for itself.
    const hits = execFileSync(
      'git',
      [
        'grep',
        '-l',
        '-E',
        // ⚠️ Anchored so it cannot match `const arrivalLevelTotal =` in
        // `planReviewService`, which is the SIZE of the arrival level for the
        // view-default rule and delegates to the same `fullestContainer` — a
        // reader of that module, not a second copy of this one.
        String.raw`function arrivalLevel\(|const arrivalLevel =`,
        '--',
        'lib',
        'components',
        'app',
      ],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    expect(hits).toEqual(['lib/planning/planArrival.ts']);
    // …and the one re-export is a re-export, not a second definition.
    const planPage = readFileSync('components/planning/PlanReviewCanvas.tsx', 'utf8');
    expect(planPage).toContain("import { arrivalLevel } from '@/lib/planning/planArrival';");
  });
});
