// @vitest-environment happy-dom
import { useEffect, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanProgressSnapshot, PlanProgressStep } from '@/lib/plans/planProgress';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { planReview, planReviewItem } from '../helpers/planReview';

// FOLLOW THE PLANNER (Story MOTIR-8590 · Subtask MOTIR-8594;
// `design/ai-planning/design-notes.md` Part XXVIII). While the overlay's pane is
// LIVE the host drives the canvas from the planner's own step: following starts ON,
// the person's navigation turns it OFF, *Follow the planner* turns it back ON, and
// all of it ends when the plan leaves `generating`.
//
// The same harness as `planning-workspace-live-pane.test.tsx`: everything below the
// host is real, the roadmap read is stubbed, and the conversation hook is a
// controlled state carrying a progress snapshot with live steps.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
const { fetchPlanningAnchor } = vi.hoisted(() => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor }));

// The no-plan roadmap is not this card's; it is stubbed to a marker.
vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: () => <div data-testid="roadmap-stub" />,
}));

// ⭐ THE MOUNT COUNTER — the proof that the hand-over is not a remount. The real
// component, wrapped: every MOUNT of it bumps the count, a re-render does not.
const { mounts } = vi.hoisted(() => ({ mounts: { count: 0 } }));
vi.mock('@/components/planning/PlanProposalViews', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/planning/PlanProposalViews')>();
  function Counted(props: ComponentProps<typeof real.PlanProposalViews>) {
    useEffect(() => {
      mounts.count += 1;
    }, []);
    return <real.PlanProposalViews {...props} />;
  }
  return { ...real, PlanProposalViews: Counted };
});

const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as PlanChangeConversationState | null,
    send: vi.fn(),
    retry: vi.fn(),
    correctTurn: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    stop: vi.fn(),
    dismissError: vi.fn(),
  },
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => conversation,
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';

// ── The committed tree the roadmap read serves ───────────────────────────────
//   root → MOTIR-2200 (epic) → MOTIR-3070 (bug) → { MOTIR-7 (story), MOTIR-9 }
const EPIC_ID = 'wi_epic';
const BUG_ID = 'wi_bug';
const STORY_ID = 'wi_story';
const SUB_ID = 'wi_sub';

function wireNode(over: Record<string, unknown>) {
  return {
    parentId: null,
    kind: 'subtask',
    type: null,
    executor: null,
    status: 'todo',
    statusLabel: null,
    statusCategory: null,
    isDone: false,
    hasChildren: false,
    progress: null,
    ready: false,
    ...over,
  };
}
const LEVELS: Record<string, unknown> = {
  __root__: {
    nodes: [
      wireNode({
        id: EPIC_ID,
        kind: 'epic',
        identifier: 'MOTIR-2200',
        title: 'The agent loop',
        hasChildren: true,
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [EPIC_ID]: {
    nodes: [
      wireNode({
        id: BUG_ID,
        parentId: EPIC_ID,
        kind: 'bug',
        identifier: 'MOTIR-3070',
        title: 'The review surface',
        hasChildren: true,
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [BUG_ID]: {
    nodes: [
      wireNode({
        id: STORY_ID,
        parentId: BUG_ID,
        kind: 'story',
        identifier: 'MOTIR-7',
        title: 'Planning layer',
        hasChildren: true,
      }),
      wireNode({ id: SUB_ID, parentId: BUG_ID, identifier: 'MOTIR-9', title: 'The template' }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
};

let reduced = false;
beforeEach(() => {
  mounts.count = 0;
  reduced = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const parentId = url.searchParams.get('parentId') ?? '__root__';
      const body = LEVELS[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }),
  );
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('reduce') ? reduced : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  conversation.state = null;
});

// ── Proposals ────────────────────────────────────────────────────────────────
const UNDER_BUG = {
  parentNodeId: BUG_ID,
  parentIdentifier: 'MOTIR-3070',
  parentTitle: 'The review surface',
  parentKind: 'bug',
  parentTrail: [
    { id: EPIC_ID, identifier: 'MOTIR-2200', title: 'The agent loop' },
    { id: BUG_ID, identifier: 'MOTIR-3070', title: 'The review surface' },
  ],
};
const UNDER_STORY = {
  parentNodeId: STORY_ID,
  parentIdentifier: 'MOTIR-7',
  parentTitle: 'Planning layer',
  parentKind: 'story',
  parentTrail: [
    ...UNDER_BUG.parentTrail,
    { id: STORY_ID, identifier: 'MOTIR-7', title: 'Planning layer' },
  ],
};
const add = (id: string, title: string, over: Partial<PlanReviewItemDto> = {}) =>
  planReviewItem({ planItemId: id, nodeId: id, title, kind: 'subtask', ...UNDER_BUG, ...over });

const P1 = add('pi_1', 'First card');
const P3 = add('pi_3', 'Deep card', UNDER_STORY);

const PLAN_ID = 'plan_live';
const writing = (items: PlanReviewItemDto[]): PlanReviewDto =>
  planReview(items, { id: PLAN_ID, status: 'generating', plannedAt: null });
const proposed = (items: PlanReviewItemDto[]): PlanReviewDto =>
  planReview(items, { id: PLAN_ID, status: 'planned' });

const BASE: PlanChangeConversationState = {
  phase: 'streaming',
  session: {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: 1,
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
  jobId: 'job_1',
  planId: PLAN_ID,
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

let version = 0;
const live = (items: PlanReviewItemDto[], over: Partial<PlanChangeConversationState> = {}) => ({
  ...BASE,
  liveReview: writing(items),
  liveVersion: (version += 1),
  ...over,
});

type Crumbs = readonly { id: string; label: string }[];
/** A launch that already HAD a target: MOTIR-6161's plan-follow is not armed. */
const TARGETED: PlanningTarget = {
  id: 'wi_other',
  identifier: 'MOTIR-1',
  title: 'Elsewhere',
  kind: 'story',
};

function host(initialCanvasTrail?: Crumbs, targeted = false) {
  return (
    <PlanningWorkspaceHost
      projectKey="MOTIR"
      projectName="Motir"
      launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
      onClose={() => {}}
      initialTarget={targeted ? TARGETED : null}
      {...(initialCanvasTrail ? { initialCanvasTrail } : {})}
    />
  );
}

/** Render the host on one conversation state, and a function to move it to the next. */
function mountHost(
  state: PlanChangeConversationState,
  initialCanvasTrail?: Crumbs,
  targeted = false,
) {
  conversation.state = state;
  const r = renderWithIntl(host(initialCanvasTrail, targeted));
  return (next: PlanChangeConversationState) => {
    conversation.state = next;
    r.rerender(host(initialCanvasTrail, targeted));
  };
}

const node = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const activeCrumb = () =>
  screen.getByRole('navigation', { name: /breadcrumb/i }).querySelector('[aria-current="page"]')
    ?.textContent ?? null;

// ── Progress snapshots ───────────────────────────────────────────────────────
const NOW = () => new Date().toISOString();
// One start instant for every step: a step's identity includes when it started.
const T0 = NOW();
const STALE = new Date(Date.now() - 3_600_000).toISOString();
function authoring(nodeId: string, sessionKey = 'sess_1'): PlanProgressStep {
  return {
    sessionKey,
    kind: 'author',
    phrase: 'authoring',
    targetRef: `planItem:${nodeId}`,
    targetNodeId: nodeId,
    targetTitle: nodeId,
    startedAt: T0,
  } as PlanProgressStep;
}
function progressOf(steps: PlanProgressStep[], over: Partial<PlanProgressSnapshot> = {}) {
  const now = NOW();
  return {
    startedAt: now,
    lastActivityAt: now,
    observedAt: now,
    authored: 0,
    proposed: 1,
    steps,
    autoResume: null,
    ...over,
  } satisfies PlanProgressSnapshot;
}
const driving = (
  items: PlanReviewItemDto[],
  steps: PlanProgressStep[],
  over: Partial<PlanProgressSnapshot> = {},
) => {
  const s = live(items);
  return { ...s, liveReview: { ...s.liveReview!, progress: progressOf(steps, over) } };
};

/** Mount on an empty live plan (so the pane seeds the Canvas view), then drive it. */
async function startDriven(steps: PlanProgressStep[] = [authoring('pi_3')]) {
  const next = mountHost(live([]), undefined, true);
  await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
  next(driving([P1, P3], steps));
  return next;
}

const followState = () => screen.queryByTestId('canvas-follow-state');
const followButton = () => screen.queryByTestId('canvas-follow-planner');
const liveRegion = () => screen.getByTestId('canvas-follow-live').textContent;

describe('follow the planner — the driven canvas while the plan is written', () => {
  it('starts ON and moves to the level the planner is drafting in, announcing it', async () => {
    const next = mountHost(live([]), undefined, true);
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    expect(followState()?.getAttribute('data-follow')).toBe('on');
    expect(followState()?.textContent).toBe('Following the planner');

    next(driving([P1, P3], [authoring('pi_3')]));
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    await waitFor(() => expect(node('pi_3')).not.toBeNull());
    expect(liveRegion()).toBe('Showing work inside MOTIR-7 · Planning layer');
    // The pill counts only the OTHER level's arrival — never the driven one.
    expect(screen.getByTestId('canvas-arrivals-offer').textContent).toContain('MOTIR-3070');
    expect(screen.getByTestId('canvas-bar-trips').lastElementChild).toBe(followState());

    // The planner moves on to a card on another level: the canvas follows.
    next(driving([P1, P3], [authoring('pi_1', 'sess_2')]));
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-3070 · The review surface'));
    expect(followState()).not.toBeNull();
  });

  it('holds the step it follows while it is live, even when another one starts', async () => {
    const next = await startDriven();
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    next(driving([P1, P3], [authoring('pi_1', 'sess_0'), authoring('pi_3')]));
    await act(async () => {});
    expect(activeCrumb()).toBe('MOTIR-7 · Planning layer');
  });

  it('the person navigating turns following OFF; the canvas then stays where they put it', async () => {
    const next = await startDriven();
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));

    // A crumb is the person's own act.
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    fireEvent.click(within(crumbs).getByRole('button', { name: 'MOTIR-2200 · The agent loop' }));
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-2200 · The agent loop'));
    expect(followState()).toBeNull();
    const button = followButton()!;
    expect(button.getAttribute('data-follow')).toBe('off');
    expect(button.getAttribute('aria-label')).toBe('Follow the planner');
    expect(button.getAttribute('title')).toBe('Follow the planner');

    // A new step elsewhere moves nothing, and the declined offer is never armed.
    next(driving([P1, P3], [authoring('pi_1', 'sess_2')]));
    await act(async () => {});
    expect(activeCrumb()).toBe('MOTIR-2200 · The agent loop');
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
    // The pill would land where Follow the planner goes, so it is hidden.
    expect(screen.queryByTestId('canvas-arrivals-offer')).toBeNull();
  });

  it('Follow the planner moves back to the driven level, turns following ON and focuses the canvas', async () => {
    await startDriven();
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    fireEvent.click(within(crumbs).getByRole('button', { name: 'MOTIR-2200 · The agent loop' }));
    await waitFor(() => expect(followButton()).not.toBeNull());

    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    expect(followState()?.getAttribute('data-follow')).toBe('on');
    // Focus lands once the driven level is drawn (it remounts per level).
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('application'));
    expect(screen.getByTestId('roadmap-canvas').contains(document.activeElement)).toBe(true);
    expect(liveRegion()).toBe('Showing work inside MOTIR-7 · Planning layer');
  });

  it('a press that moves nothing says "Following the planner again"', async () => {
    await startDriven();
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    // Navigate away and back by hand: following is off, the canvas on the driven level.
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    fireEvent.click(
      within(crumbs).getByRole('button', { name: 'MOTIR-3070 · The review surface' }),
    );
    await waitFor(() => expect(followButton()).not.toBeNull());
    fireEvent.keyDown(node(STORY_ID)!, { key: 'Enter' });
    fireEvent.click(within(node(STORY_ID)!).getByTestId('drill-button'));
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));

    fireEvent.click(followButton()!);
    await waitFor(() => expect(followState()).not.toBeNull());
    expect(activeCrumb()).toBe('MOTIR-7 · Planning layer');
    expect(liveRegion()).toBe('Following the planner again');
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('application'));
  });

  it('stalled or reconnecting: armed but idle — the glyph drops to faint and nothing moves', async () => {
    const next = await startDriven();
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    expect(followState()?.hasAttribute('data-idle')).toBe(false);

    next({ ...conversation.state!, liveFailing: true });
    await waitFor(() => expect(followState()?.getAttribute('data-idle')).toBe('true'));
    expect(activeCrumb()).toBe('MOTIR-7 · Planning layer');

    next(driving([P1, P3], [], { lastActivityAt: STALE }));
    await waitFor(() => expect(followState()?.getAttribute('data-idle')).toBe('true'));
    expect(activeCrumb()).toBe('MOTIR-7 · Planning layer');
  });

  it('when the plan leaves generating the control fades out and the canvas never moves again', async () => {
    const next = await startDriven();
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));

    next({ ...BASE, phase: 'review', liveReview: null, review: proposed([P1, P3]) });
    const leaving = followState()!;
    expect(leaving.getAttribute('data-leaving')).toBe('true');
    expect(leaving.className).toContain('canvas-fade-out');
    expect(leaving.className).toContain('motion-reduce:hidden');
    fireEvent.animationEnd(leaving);
    await waitFor(() => expect(followState()).toBeNull());
    expect(screen.queryByTestId('canvas-bar-trips')).toBeNull();
    expect(activeCrumb()).toBe('MOTIR-7 · Planning layer');
    expect(mounts.count).toBe(1);
  });

  it('the compact form: the label goes sr-only below a 32rem pane, never truncated', async () => {
    await startDriven();
    await waitFor(() => expect(followState()).not.toBeNull());
    const label = within(followState()!).getByText('Following the planner');
    expect(label.className).toContain('@max-[32rem]/plan-pane:sr-only');
    expect(
      screen.getByTestId('roadmap-canvas').closest('.\\@container\\/plan-pane'),
    ).not.toBeNull();
  });

  it('a plan first seen PROPOSED is never driven and shows no follow control', async () => {
    mountHost({ ...BASE, phase: 'review', review: proposed([P1, P3]) }, undefined, true);
    expect(screen.getByTestId('plan-proposal-views')).toBeTruthy();
    await act(async () => {});
    expect(followState()).toBeNull();
    expect(followButton()).toBeNull();
  });
});

// ── A PRESS ALWAYS MOVES THE CANVAS (MOTIR-10740) ────────────────────────────
// With no live step the press used to ask the canvas for nothing. It now falls
// back to the planner's last step, its last written proposal, the target's
// arrival, and finally the root (`followDestination`).
describe('follow the planner — a press with no live step still takes the person somewhere', () => {
  beforeEach(() => {
    fetchPlanningAnchor.mockReset();
  });
  /** Drill into the epic by hand: the person's own act, so following turns OFF. */
  async function drillIntoEpic() {
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    fireEvent.keyDown(node(EPIC_ID)!, { key: 'Enter' });
    fireEvent.click(within(node(EPIC_ID)!).getByTestId('drill-button'));
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-2200 · The agent loop'));
    await waitFor(() => expect(followButton()).not.toBeNull());
  }
  const BUG_ANCHOR = {
    anchor: { id: BUG_ID, identifier: 'MOTIR-3070', title: 'The review surface', kind: 'bug' },
    ancestors: [{ id: EPIC_ID, identifier: 'MOTIR-2200', title: 'The agent loop' }],
    hasChildren: true,
  };

  it('no live step, a step held earlier: the press goes back to the held step’s level', async () => {
    const next = await startDriven();
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    // Between steps: the snapshot names nothing live any more.
    next(driving([P1, P3], []));
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    fireEvent.click(within(crumbs).getByRole('button', { name: 'MOTIR-2200 · The agent loop' }));
    await waitFor(() => expect(followButton()).not.toBeNull());

    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    expect(followState()?.getAttribute('data-follow')).toBe('on');
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('application'));
  });

  it('a freshly mounted live plan with no live step: the press goes to the last written proposal', async () => {
    const next = mountHost(live([]), undefined, true);
    next(driving([P3, P1], []));
    await drillIntoEpic();

    fireEvent.click(followButton()!);
    // P1 is the LAST add in append order — it sits under MOTIR-3070.
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-3070 · The review surface'));
    expect(followState()?.getAttribute('data-follow')).toBe('on');
    expect(liveRegion()).toBe('Showing work inside MOTIR-3070 · The review surface');
  });

  it('no steps and no proposals: the press goes to the FIRST target’s arrival level', async () => {
    fetchPlanningAnchor.mockResolvedValue(BUG_ANCHOR);
    conversation.state = live([]);
    renderWithIntl(
      <PlanningWorkspaceHost
        projectKey="MOTIR"
        projectName="Motir"
        launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
        onClose={() => {}}
        initialTarget={TARGETED}
        extraInitialTargets={[
          { id: 'wi_second', identifier: 'MOTIR-2', title: 'Second', kind: 'story' },
        ]}
      />,
    );
    await drillIntoEpic();
    await waitFor(() => expect(fetchPlanningAnchor).toHaveBeenCalled());
    expect(fetchPlanningAnchor.mock.calls.map((c) => c[0])).toEqual(['MOTIR-1']);

    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-3070 · The review surface'));
    expect(followState()?.getAttribute('data-follow')).toBe('on');
  });

  it('the trail the pane arrived on is the target’s arrival, with no anchor read', async () => {
    const arrived = [
      { id: EPIC_ID, label: 'MOTIR-2200 · The agent loop' },
      { id: BUG_ID, label: 'MOTIR-3070 · The review surface' },
    ];
    mountHost(live([]), arrived, true);
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-3070 · The review surface'));
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    fireEvent.click(within(crumbs).getByRole('button', { name: 'MOTIR-2200 · The agent loop' }));
    await waitFor(() => expect(followButton()).not.toBeNull());

    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-3070 · The review surface'));
    expect(fetchPlanningAnchor).not.toHaveBeenCalled();
  });

  it('no target at all: the press goes to the root', async () => {
    const next = mountHost(live([]));
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    const root = activeCrumb();
    await drillIntoEpic();

    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).toBe(root));
    expect(node(EPIC_ID)).not.toBeNull();
    expect(followState()?.getAttribute('data-follow')).toBe('on');

    // The root the press held is a fallback, not a step: once proposals land, the
    // next press goes to the last one instead of the root again.
    next(driving([P3, P1], []));
    await drillIntoEpic();
    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-3070 · The review surface'));
  });

  it('a target the viewer cannot read degrades to the root', async () => {
    fetchPlanningAnchor.mockResolvedValue(null);
    mountHost(live([]), undefined, true);
    await drillIntoEpic();
    await waitFor(() =>
      expect(fetchPlanningAnchor).toHaveBeenCalledWith('MOTIR-1', expect.anything()),
    );

    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).not.toBe('MOTIR-2200 · The agent loop'));
    expect(node(EPIC_ID)).not.toBeNull();
    expect(followState()?.getAttribute('data-follow')).toBe('on');
  });

  it('an anchor read that fails leaves the press on the root fallback', async () => {
    fetchPlanningAnchor.mockRejectedValue(new Error('down'));
    mountHost(live([]), undefined, true);
    await drillIntoEpic();
    await waitFor(() => expect(fetchPlanningAnchor).toHaveBeenCalled());

    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).not.toBe('MOTIR-2200 · The agent loop'));
    expect(node(EPIC_ID)).not.toBeNull();
  });

  it('a stalled plan (idle control) still moves on press, and the next live step drives again', async () => {
    const next = mountHost(live([]), undefined, true);
    // Stalled from the start: no live step, nothing held — only the snapshot's last step.
    next(driving([P1, P3], [authoring('pi_3')], { lastActivityAt: STALE }));
    await drillIntoEpic();
    expect(followButton()?.getAttribute('data-idle')).toBe('true');

    fireEvent.click(followButton()!);
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    expect(followState()?.getAttribute('data-follow')).toBe('on');

    // The planner comes back and starts a step elsewhere: following is still on.
    next(driving([P1, P3], [authoring('pi_1', 'sess_back')]));
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-3070 · The review surface'));
  });
});
