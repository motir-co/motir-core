// @vitest-environment happy-dom
import { useEffect, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import { planReview, planReviewItem } from '../helpers/planReview';

// THE GENERATING PANE GOES LIVE (MOTIR-6300; `design/ai-planning/design-notes.md`
// Part XXIII). While the session's plan is being written, the planning surface's
// left pane is the SAME `PlanProposalViews` a proposed plan gets, fed the live
// snapshot — and when the plan is proposed, that same instance shows it.
//
// Everything below the host is REAL — `PlanProposalViews`, `PlanReviewCanvas`,
// `ProjectRoadmapCanvas`, `PlanningCanvas` with its motion, `PlanProposalList` —
// and only the network is stubbed: the per-level roadmap read, exactly as
// `plan-review-canvas.test.tsx` stubs it. The conversation hook is a controlled
// state, because what is under test is what the pane DOES with each snapshot the
// poll (MOTIR-6295, its own suite) hands it.

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
const P2 = add('pi_2', 'Second card', { blockedByNodeIds: ['pi_1'] });
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
const motionOf = (id: string) => node(id)?.getAttribute('data-motion') ?? null;
const edgePaths = () => [...screen.getByTestId('canvas-edges').querySelectorAll('path')];
const activeCrumb = () =>
  screen.getByRole('navigation', { name: /breadcrumb/i }).querySelector('[aria-current="page"]')
    ?.textContent ?? null;
const bar = () => screen.queryByTestId('plan-change-confirm-bar');

describe('the generating pane — the shared List | Canvas, fed the live review', () => {
  it('mounts PlanProposalViews LIVE from the first read — zero proposals included — with an empty foot', async () => {
    mountHost(live([]));

    expect(screen.getByTestId('plan-proposal-views')).toBeTruthy();
    expect(screen.queryByTestId('roadmap-stub')).toBeNull();
    // The live marker, in the header's right end (§23.1).
    const marker = screen.getByTestId('plan-live-state');
    expect(marker.textContent).toBe('Being written');
    expect(marker.getAttribute('role')).toBe('status');
    // The switch shows from the first read (§23.2).
    expect(screen.getByRole('button', { name: /List/ })).toBeTruthy();
    // No decide bar — a plan being written has nothing to decide.
    expect(bar()).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve changes/ })).toBeNull();

    // The List says it in the present tense (§23.9).
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    expect(screen.getByText('Nothing proposed yet')).toBeTruthy();
    expect(screen.getByText('Items appear here as the plan is written.')).toBeTruthy();
    expect(screen.queryByText(/Declining ends it/)).toBeNull();
    await act(async () => {});
  });

  it('opens where the surface stood, not at the root, while nothing is proposed (§23.2)', async () => {
    mountHost(live([]), [
      { id: EPIC_ID, label: 'MOTIR-2200 · The agent loop' },
      { id: BUG_ID, label: 'MOTIR-3070 · The review surface' },
    ]);
    await waitFor(() => expect(node(STORY_ID)).not.toBeNull());
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');
  });

  it('draws each snapshot’s change: an arrival WITH its arrow, an off-level count, a deepen, an exit', async () => {
    const next = mountHost(live([P1]));
    await waitFor(() => expect(node('pi_1')).not.toBeNull());
    // The first read plays nothing (§23.4).
    expect(motionOf('pi_1')).toBeNull();
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');
    const edgesBefore = edgePaths().length;

    // ── ARRIVAL, with its `blocked_by` edge to a card already drawn ──
    next(live([P1, P2]));
    await waitFor(() => expect(node('pi_2')).not.toBeNull());
    expect(motionOf('pi_2')).toBe('enter');
    // The card already drawn may GLIDE to make room (§23.3) — it never re-enters.
    expect(motionOf('pi_1')).not.toBe('enter');
    expect(edgePaths()).toHaveLength(edgesBefore + 1);
    expect(edgePaths().some((p) => p.getAttribute('data-motion') === 'enter')).toBe(true);
    // Announced ONCE for the batch (§23.15).
    expect(screen.getByTestId('plan-live-announce').textContent).toBe('1 item added to the plan');
    await waitFor(() => expect(motionOf('pi_2')).toBeNull());

    // ── OFF-LEVEL: counted on the indicator, never jumped to (§23.7) ──
    next(live([P1, P2, P3]));
    const pill = await screen.findByTestId('canvas-arrivals-offer');
    expect(pill.textContent).toBe('1 new in MOTIR-7 · Go there');
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');
    expect(node('pi_3')).toBeNull();
    expect(node('pi_1')).not.toBeNull();

    // ── DEEPEN: a title filled in cues the card and does not re-enter it ──
    const p1Before = node('pi_1');
    next(live([{ ...P1, title: 'First card, deepened' }, P2, P3]));
    await waitFor(() => expect(motionOf('pi_1')).toBe('cue'));
    expect(node('pi_1')).toBe(p1Before);
    expect(within(node('pi_1')!).getByText('First card, deepened')).toBeTruthy();

    // ── EXIT: a withdrawn proposal leaves, then is gone ──
    next(live([{ ...P1, title: 'First card, deepened' }, P3]));
    await waitFor(() => expect(motionOf('pi_2')).toBe('exit'));
    // The retained box draws the card that is LEAVING, not an empty box (bug
    // MOTIR-6345): the id has left the level, so a lookup in the current level
    // alone drew nothing and the card vanished instead of fading (§23.3).
    expect(within(node('pi_2')!).getByText(P2.title)).toBeTruthy();
    await waitFor(() => expect(node('pi_2')).toBeNull());
    // The count still stands, and the level never moved.
    expect(screen.getByTestId('canvas-arrivals-offer')).toBeTruthy();
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');

    // ── GO THERE is the reader's own act — the one move an arrival allows ──
    fireEvent.click(screen.getByTestId('canvas-arrivals-offer'));
    await waitFor(() => expect(node('pi_3')).not.toBeNull());
    expect(activeCrumb()).toBe('MOTIR-7 · Planning layer');
    expect(screen.queryByTestId('canvas-arrivals-offer')).toBeNull();
    expect(mounts.count).toBe(1);
  });

  it('with `failing`, says it is reconnecting and keeps the last snapshot drawn (§23.10)', async () => {
    const next = mountHost(live([P1]));
    await waitFor(() => expect(node('pi_1')).not.toBeNull());
    next({ ...conversation.state!, liveFailing: true });
    expect(screen.getByTestId('plan-live-state').textContent).toBe(
      'Reconnecting — showing the last update',
    );
    expect(node('pi_1')).not.toBeNull();
  });
});

describe('the HAND-OVER — the same instance shows the proposed plan (§23.13)', () => {
  it('keeps the element, the level and the canvas; only the bar arrives and the marker leaves', async () => {
    const next = mountHost(live([P1, P2]));
    await waitFor(() => expect(node('pi_2')).not.toBeNull());
    const views = screen.getByTestId('plan-proposal-views');
    const card = node('pi_1');
    const canvas = screen.getByTestId('roadmap-canvas');
    expect(bar()).toBeNull();

    next({ ...BASE, phase: 'review', liveReview: null, review: proposed([P1, P2]) });

    expect(screen.getByTestId('plan-proposal-views')).toBe(views);
    expect(screen.getByTestId('roadmap-canvas')).toBe(canvas);
    expect(node('pi_1')).toBe(card);
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');
    expect(screen.queryByTestId('plan-live-state')).toBeNull();
    expect(bar()).not.toBeNull();
    expect(screen.getAllByRole('button', { name: /Approve changes/ }).length).toBeGreaterThan(0);
    // ⭐ ONE mount across the hand-over.
    expect(mounts.count).toBe(1);
    // And the proposed plan draws without motion — the surface's motion is live-only.
    await act(async () => {});
    expect(document.querySelectorAll('[data-motion]')).toHaveLength(0);
  });

  it('keeps the List | Canvas view the reader chose', async () => {
    const next = mountHost(live([P1]));
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    expect(screen.getByText('First card')).toBeTruthy();
    next({ ...BASE, phase: 'review', liveReview: null, review: proposed([P1]) });
    expect(screen.getByRole('button', { name: /List/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('First card')).toBeTruthy();
    expect(mounts.count).toBe(1);
    await act(async () => {});
  });

  it('a plan DISCARDED while written keeps the pane, with the plan page’s band and no bar (§23.12)', async () => {
    const next = mountHost(live([]));
    const views = screen.getByTestId('plan-proposal-views');
    next({
      ...BASE,
      phase: 'idle',
      liveReview: null,
      discardedReview: planReview([], {
        id: PLAN_ID,
        status: 'declined',
        decisionReason: 'discarded',
      }),
    });
    expect(screen.getByTestId('plan-proposal-views')).toBe(views);
    expect(screen.getByTestId('plan-live-discarded').textContent).toBe(
      'Plan discarded before it finished — your work items are unchanged',
    );
    expect(screen.queryByTestId('plan-live-state')).toBeNull();
    expect(bar()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    expect(screen.getByText('No proposals')).toBeTruthy();
    expect(screen.queryByText(/Declining ends it/)).toBeNull();
    expect(mounts.count).toBe(1);
    await act(async () => {});
  });
});

describe('an EMPTY level filling in front of the reader (§23.4)', () => {
  const STORY_TRAIL = [
    { id: EPIC_ID, label: 'MOTIR-2200 · The agent loop' },
    { id: BUG_ID, label: 'MOTIR-3070 · The review surface' },
    { id: STORY_ID, label: 'MOTIR-7 · Planning layer' },
  ];

  it('the first cards on a level the reader WATCHED empty enter — staggered — instead of mounting settled', async () => {
    // The story has no committed children: the pane opens on its empty level.
    const next = mountHost(live([]), STORY_TRAIL, true);
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    await waitFor(() => expect(screen.getByText('No items at this level')).toBeTruthy());
    expect(node('pi_a')).toBeNull();

    next(live([add('pi_a', 'Alpha', UNDER_STORY), add('pi_b', 'Beta', UNDER_STORY)]));
    await waitFor(() => expect(node('pi_b')).not.toBeNull());
    expect(motionOf('pi_a')).toBe('enter');
    expect(motionOf('pi_b')).toBe('enter');
    expect(node('pi_a')!.style.animationDelay).toBe('0ms');
    expect(node('pi_b')!.style.animationDelay).toBe('40ms');
    await waitFor(() => expect(document.querySelectorAll('[data-motion]')).toHaveLength(0));
  });

  it('a pane that OPENS on an already-populated level plays nothing', async () => {
    mountHost(live([P1, P2]));
    await waitFor(() => expect(node('pi_2')).not.toBeNull());
    expect(node(STORY_ID)).not.toBeNull();
    expect(document.querySelectorAll('[data-motion]')).toHaveLength(0);
    await act(async () => {});
    expect(document.querySelectorAll('[data-motion]')).toHaveLength(0);
  });
});

describe('the arrivals count — its root form and its several-levels form (§23.7)', () => {
  it('at the ROOT the row renders the root crumb and the pill only — no Back', async () => {
    const next = mountHost(live([]), undefined, true);
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    // The row is up at the root from the first read because the follow status
    // lives in it (MOTIR-8594; Part XXVIII §28.3) — and it holds nothing else.
    const atRoot = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(atRoot).queryByRole('button', { name: /back/i })).toBeNull();
    expect(screen.getByTestId('canvas-follow-state').getAttribute('data-follow')).toBe('on');
    expect(screen.queryByTestId('canvas-arrivals-offer')).toBeNull();

    next(live([P1]));
    const pill = await screen.findByTestId('canvas-arrivals-offer');
    expect(pill.textContent).toBe('1 new in MOTIR-3070 · Go there');
    const row = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(row).queryByRole('button', { name: /back/i })).toBeNull();
    expect(node(EPIC_ID)).not.toBeNull(); // the canvas did not move

    next(live([P1, P3]));
    await waitFor(() =>
      expect(screen.getByTestId('canvas-arrivals-offer').textContent).toBe(
        '2 new elsewhere · latest in MOTIR-7 · Go there',
      ),
    );
    // A withdrawn arrival stops counting.
    next(live([P1]));
    await waitFor(() =>
      expect(screen.getByTestId('canvas-arrivals-offer').textContent).toBe(
        '1 new in MOTIR-3070 · Go there',
      ),
    );
  });
});

describe('follow-once vs never-jump (§23.8)', () => {
  it('before any navigation, the first proposal carries the canvas inside its level ONCE', async () => {
    const next = mountHost(live([]));
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    next(live([P1]));
    await waitFor(() => expect(node('pi_1')).not.toBeNull());
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');

    // The plan grows elsewhere: its fullest level moves, and the canvas does not.
    next(live([P1, P3, add('pi_4', 'Deep two', UNDER_STORY)]));
    await screen.findByTestId('canvas-arrivals-offer');
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
  });

  // ⚠️ SUPERSEDED while generating by Part XXVIII §28.2 (MOTIR-8594): the reader's
  // navigation turns FOLLOWING off, the declined-follow offer is not armed, and
  // *Follow the planner* is the trip back. The pill keeps counting as shipped.
  it('after the reader has navigated, following is OFF: no declined offer, the Follow the planner button, the pill', async () => {
    const next = mountHost(live([]));
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    fireEvent.keyDown(node(EPIC_ID)!, { key: 'Enter' });
    fireEvent.click(within(node(EPIC_ID)!).getByTestId('drill-button'));
    await waitFor(() => expect(node(BUG_ID)).not.toBeNull());
    expect(activeCrumb()).toBe('MOTIR-2200 · The agent loop');

    expect(screen.getByTestId('canvas-follow-planner').getAttribute('data-follow')).toBe('off');

    next(live([P1]));
    const pill = await screen.findByTestId('canvas-arrivals-offer');
    expect(pill.textContent).toContain('MOTIR-3070');
    expect(activeCrumb()).toBe('MOTIR-2200 · The agent loop');
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
    // The follow control is the rightmost member of the trips group.
    const trips = screen.getByTestId('canvas-bar-trips');
    expect(trips.lastElementChild?.getAttribute('data-testid')).toBe('canvas-follow-planner');
  });
});

describe('the live List (§23.9)', () => {
  it('a row that arrives enters; a withdrawn row leaves, then is gone', async () => {
    const next = mountHost(live([P1]));
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    const first = screen.getByText('First card').closest('li')!;
    expect(first.getAttribute('data-motion')).toBeNull();

    next(live([P1, P2]));
    const second = screen.getByText('Second card').closest('li')!;
    expect(second.getAttribute('data-motion')).toBe('enter');
    expect(second.className).toContain('plan-list-row--enter');

    next(live([P2]));
    const leaving = screen.getByText('First card').closest('li')!;
    expect(leaving.getAttribute('data-motion')).toBe('exit');
    await waitFor(() => expect(screen.queryByText('First card')).toBeNull());
  });

  it('under reduced motion rows simply are or are not there', async () => {
    reduced = true;
    const next = mountHost(live([P1]));
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    next(live([P2]));
    expect(screen.queryByText('First card')).toBeNull();
    expect(screen.getByText('Second card').closest('li')!.getAttribute('data-motion')).toBeNull();
    await act(async () => {});
  });
});

// THE PANE OPENS ON THE CANVAS, AT THE TARGET (MOTIR-10739). A plan's first live read
// has no proposals, and its review used to count the PROJECT ROOT as its arrival
// level — so on a large project the pin seeded the List ("Nothing proposed yet") for
// the whole session. These reads say exactly that: a root far past both size arms.
describe('a fresh plan opens on the CANVAS at its target, not on an empty List (MOTIR-10739)', () => {
  const PAST_BOTH_ARMS = { arrivalLevelSize: 200, arrivalLevelTotal: 640 };
  const fresh = (over: Partial<PlanChangeConversationState> = {}) => ({
    ...BASE,
    liveReview: planReview([], {
      id: PLAN_ID,
      status: 'generating',
      plannedAt: null,
      ...PAST_BOTH_ARMS,
    }),
    liveVersion: (version += 1),
    ...over,
  });
  const listButton = () => screen.getByRole('button', { name: /List/ });
  const STORY_ANCHOR = {
    anchor: { id: STORY_ID, identifier: 'MOTIR-7', title: 'Planning layer', kind: 'story' },
    ancestors: [
      { id: EPIC_ID, identifier: 'MOTIR-2200', title: 'The agent loop' },
      { id: BUG_ID, identifier: 'MOTIR-3070', title: 'The review surface' },
    ],
    hasChildren: true,
  };
  beforeEach(() => {
    fetchPlanningAnchor.mockReset().mockResolvedValue(STORY_ANCHOR);
  });

  it('shows the canvas, not PlanProposalList, on a first read with no items — and the List is one click away', async () => {
    mountHost(fresh());
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    expect(screen.getByTestId('roadmap-canvas')).toBeTruthy();
    expect(listButton().getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Nothing proposed yet')).toBeNull();

    fireEvent.click(listButton());
    expect(listButton().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Nothing proposed yet')).toBeTruthy();
  });

  it('keeps the seeded view pinned: the reader’s List survives the plan’s next reads', async () => {
    const next = mountHost(fresh());
    fireEvent.click(listButton());
    next(live([P1]));
    next(live([P1, P2]));
    expect(listButton().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('First card')).toBeTruthy();
    await act(async () => {});
  });

  it('a PROJECT-launched session moves the canvas inside the target the planner settles', async () => {
    const next = mountHost(fresh());
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    expect(fetchPlanningAnchor).not.toHaveBeenCalled();

    next(fresh({ settledTargetKey: 'MOTIR-7' }));
    await waitFor(() => expect(activeCrumb()).toBe('MOTIR-7 · Planning layer'));
    expect(fetchPlanningAnchor).toHaveBeenCalledTimes(1);
    expect(fetchPlanningAnchor.mock.calls[0]![0]).toBe('MOTIR-7');
    expect(listButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('a reader who has already navigated stays where they are when the target settles', async () => {
    const next = mountHost(fresh());
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    fireEvent.keyDown(node(EPIC_ID)!, { key: 'Enter' });
    fireEvent.click(within(node(EPIC_ID)!).getByTestId('drill-button'));
    await waitFor(() => expect(node(BUG_ID)).not.toBeNull());
    expect(activeCrumb()).toBe('MOTIR-2200 · The agent loop');

    next(fresh({ settledTargetKey: 'MOTIR-7' }));
    await waitFor(() => expect(fetchPlanningAnchor).toHaveBeenCalled());
    await act(async () => {});
    expect(activeCrumb()).toBe('MOTIR-2200 · The agent loop');
  });

  it('a target the viewer cannot see moves nothing and says nothing', async () => {
    fetchPlanningAnchor.mockResolvedValue(null);
    const next = mountHost(fresh());
    await waitFor(() => expect(node(EPIC_ID)).not.toBeNull());
    next(fresh({ settledTargetKey: 'MOTIR-404' }));
    await waitFor(() => expect(fetchPlanningAnchor).toHaveBeenCalled());
    await act(async () => {});
    expect(node(EPIC_ID)).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a WORK-ITEM-launched session opens the canvas at that item’s arrival trail', async () => {
    const next = mountHost(
      fresh(),
      [
        { id: EPIC_ID, label: 'MOTIR-2200 · The agent loop' },
        { id: BUG_ID, label: 'MOTIR-3070 · The review surface' },
      ],
      true,
    );
    await waitFor(() => expect(node(STORY_ID)).not.toBeNull());
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');
    expect(listButton().getAttribute('aria-pressed')).toBe('false');

    // It arrived inside its own target, so the planner's key does not move it.
    next(fresh({ settledTargetKey: 'MOTIR-7' }));
    await act(async () => {});
    expect(fetchPlanningAnchor).not.toHaveBeenCalled();
    expect(activeCrumb()).toBe('MOTIR-3070 · The review surface');
  });
});
