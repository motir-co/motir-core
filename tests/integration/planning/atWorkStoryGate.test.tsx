// @vitest-environment happy-dom
//
// THE AT-WORK STORY GATE — the SEAM (Story MOTIR-8413 · Subtask MOTIR-8418).
//
// ONE progress snapshot feeds two at-work renders: the drafted card's cue on the
// canvas (MOTIR-8416) and the Motir mark in the rail header (MOTIR-8417). Each
// half has its own unit suite, and each is right on its own terms in exactly the
// failure this file exists to catch — the cue moving while the mark is still, or
// the chip vanishing where the honesty bound only asked the MOTION to stop.
//
// What is real: the clock (`usePlanProgressReading`), the derivation
// (`readPlanAtWork`), `PlanProposalViews` → `PlanReviewCanvas` →
// `ProjectRoadmapCanvas` → `PlanningCanvas`, and `PlanAtWorkMark` (the rail
// mounts it once, fed the same `liveReview.progress` / `liveFailing`).
// What is mocked: the POLL — its snapshot is handed in as the prop the poll
// would deliver — and the roadmap level read (`fetch`). The two lib modules are
// WRAPPED, never replaced, so a spy can count calls into the real functions.
//
// ⚠️ THE STALLED ROW FOLLOWS THE APPROVED DESIGN, NOT THE CARD'S BODY. The card
// was written before the design review and says a stalled plan claims no cue; the
// approved design's States table (§ _Motir at work_) holds the last-named card's
// cue STATIC, and MOTIR-8416 built that hold. This file asserts what shipped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../../helpers/renderWithIntl';
import { PlanProposalViews } from '@/components/planning/PlanProposalViews';
import { PlanAtWorkMark } from '@/components/planning/PlanAtWorkMark';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import {
  PLAN_STALLED_AFTER_MS,
  type PlanProgressSnapshot,
  type PlanProgressStep,
} from '@/lib/plans/planProgress';

const spies = vi.hoisted(() => ({ atWork: 0, clock: 0 }));
vi.mock('@/lib/plans/planProgress', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/plans/planProgress')>();
  return {
    ...real,
    readPlanAtWork: (...args: Parameters<typeof real.readPlanAtWork>) => {
      spies.atWork += 1;
      return real.readPlanAtWork(...args);
    },
  };
});
vi.mock('@/lib/hooks/usePlanProgressReading', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/hooks/usePlanProgressReading')>();
  return {
    ...real,
    usePlanProgressReading: (...args: Parameters<typeof real.usePlanProgressReading>) => {
      spies.clock += 1;
      return real.usePlanProgressReading(...args);
    },
  };
});

const EPIC_ID = 'wi_epic';
const LOGIN_ID = 'wi_login';
const RESET_ID = 'wi_reset';

function wireNode(over: Record<string, unknown>) {
  return {
    parentId: null,
    kind: 'story',
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

const WIRE_LEVELS: Record<string, unknown> = {
  __root__: {
    nodes: [
      wireNode({
        id: EPIC_ID,
        kind: 'epic',
        identifier: 'ARP-1',
        title: 'Authentication',
        hasChildren: true,
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [EPIC_ID]: {
    nodes: [
      wireNode({
        id: LOGIN_ID,
        parentId: EPIC_ID,
        identifier: 'ARP-2',
        title: 'Login UI',
        hasChildren: true,
      }),
      wireNode({ id: RESET_ID, parentId: EPIC_ID, identifier: 'ARP-3', title: 'Password Reset' }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
  [LOGIN_ID]: { nodes: [], edges: [], offLevelBlockers: [] },
};

function stubRoadmap() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const parentId = url.searchParams.get('parentId') ?? '__root__';
    const body = WIRE_LEVELS[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const EPIC_TRAIL = [{ id: EPIC_ID, identifier: 'ARP-1', title: 'Authentication' }];

function proposal(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return {
    planItemId: 'pi_add',
    op: 'add',
    nodeId: 'pi_add',
    parentNodeId: EPIC_ID,
    parentIdentifier: 'ARP-1',
    parentTitle: 'Authentication',
    parentKind: 'epic',
    parentTrail: EPIC_TRAIL,
    folderId: null,
    folderPath: null,
    folderMissing: false,
    folderTrail: [],
    blockedByNodeIds: [],
    blockedByRemovedNodeIds: [],
    committedBlockedBy: [],
    blockerStubs: [],
    identifier: null,
    title: 'Account recovery',
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
    ...over,
  };
}

const LOGIN_TRAIL = [
  { id: EPIC_ID, identifier: 'ARP-1', title: 'Authentication' },
  { id: LOGIN_ID, identifier: 'ARP-2', title: 'Login UI' },
];
const ITEMS: PlanReviewItemDto[] = [
  proposal({ planItemId: 'pi_a', nodeId: 'pi_a', title: 'Account recovery' }),
  proposal({ planItemId: 'pi_b', nodeId: 'pi_b', title: 'Session timeout' }),
  proposal({
    planItemId: 'pi_c',
    nodeId: 'pi_c',
    title: 'Remember me',
    parentNodeId: LOGIN_ID,
    parentIdentifier: 'ARP-2',
    parentTitle: 'Login UI',
    parentKind: 'story',
    parentTrail: LOGIN_TRAIL,
    kind: 'subtask',
  }),
  proposal({
    planItemId: 'pi_d',
    nodeId: 'pi_d',
    title: 'Reset email',
    parentNodeId: RESET_ID,
    parentIdentifier: 'ARP-3',
    parentTitle: 'Password Reset',
    parentKind: 'story',
    parentTrail: [
      { id: EPIC_ID, identifier: 'ARP-1', title: 'Authentication' },
      { id: RESET_ID, identifier: 'ARP-3', title: 'Password Reset' },
    ],
    kind: 'subtask',
  }),
];

const INSIDE_EPIC: CanvasCrumb[] = [{ id: EPIC_ID, label: 'ARP-1 · Authentication' }];

const T0 = Date.parse('2026-10-08T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function step(kind: PlanProgressStep['kind'], targetNodeId: string | null, sessionKey = 's1') {
  return {
    sessionKey,
    kind,
    phrase:
      kind === 'settle'
        ? 'settling'
        : kind === 'lay'
          ? 'layingChildrenOf'
          : targetNodeId
            ? 'authoring'
            : 'draftingNew',
    targetRef: targetNodeId,
    targetNodeId,
    targetTitle: targetNodeId ? `title ${targetNodeId}` : null,
    startedAt: iso(T0 - 30_000),
    providerWait: null,
  } satisfies PlanProgressStep;
}

function snap(steps: PlanProgressStep[], over: Partial<PlanProgressSnapshot> = {}) {
  return {
    startedAt: iso(T0 - 5 * 60_000),
    lastActivityAt: iso(T0 - 10_000),
    observedAt: iso(T0),
    authored: 2,
    proposed: 4,
    autoResume: null,
    steps,
    ...over,
  } satisfies PlanProgressSnapshot;
}

type Host = 'overlay' | 'plan-page';

/** The pane as each host mounts it, plus the rail's one mark off the same datum. */
function surface(host: Host, progress: PlanProgressSnapshot | null, failing = false) {
  return (
    <>
      <PlanProposalViews
        items={ITEMS}
        outcome={null}
        projectKey="ARP"
        version={0}
        ariaLabel="Proposed plan"
        view="canvas"
        onViewChange={() => {}}
        live={host === 'overlay'}
        liveFailing={failing}
        canvasHeldTrail={INSIDE_EPIC}
        progress={progress}
        progressFailing={failing}
      />
      <PlanAtWorkMark progress={progress} failing={failing} />
    </>
  );
}

function mount(host: Host, progress: PlanProgressSnapshot | null, failing = false) {
  const r = render(surface(host, progress, failing));
  return (next: PlanProgressSnapshot | null, nextFailing = failing) =>
    r.rerender(surface(host, next, nextFailing));
}

const box = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const cueOf = (id: string) => box(id)?.getAttribute('data-cue') ?? null;
const motionOf = (id: string) => box(id)?.getAttribute('data-cue-motion') ?? null;
const moving = () =>
  [...document.querySelectorAll('[data-cue-motion="at-work"]')].map((el) =>
    el.getAttribute('data-node-id'),
  );
const mark = () => document.querySelectorAll<HTMLElement>('[data-testid="plan-at-work-mark"]');
const markForm = () => mark()[0]!.getAttribute('data-at-work');
const loaded = () => screen.findByText('Account recovery');

beforeEach(() => {
  stubRoadmap();
  spies.atWork = 0;
  spies.clock = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('one snapshot, the cue and the mark', () => {
  it('a step naming X: X is cued AND moving, its chip names it, no other box moves, the mark breathes', async () => {
    mount('overlay', snap([step('author', 'pi_a')]));
    await loaded();
    expect(cueOf('pi_a')).toBe('drafting');
    expect(motionOf('pi_a')).toBe('at-work');
    expect(box('pi_a')!.querySelector('.canvas-cue-chip')!.textContent).toBe('Drafting');
    expect(moving()).toEqual(['pi_a']);
    expect(mark()).toHaveLength(1);
    expect(markForm()).toBe('true');
  });

  it('two steps naming X and Y: each box moves on its own, and the off-level count stays true', async () => {
    mount(
      'overlay',
      snap([
        step('author', 'pi_a', 's1'),
        step('author', 'pi_b', 's2'),
        step('author', 'pi_c', 's3'),
      ]),
    );
    await loaded();
    expect(moving().sort()).toEqual(['pi_a', 'pi_b']);
    // pi_c sits one level down (under LOGIN): it is counted in the arrivals slot,
    // as shipped, and moves nothing on this level.
    expect(screen.getByTestId('canvas-arrivals-offer').textContent).toMatch(/1/);
    expect(mark()).toHaveLength(1);
  });

  it('⭐ failing + held non-empty steps: the cue and its chip STAY, nothing moves, the mark is still', async () => {
    const update = mount('overlay', snap([step('author', 'pi_a')]));
    await loaded();
    expect(motionOf('pi_a')).toBe('at-work');
    update(snap([step('author', 'pi_a')]), true);
    expect(cueOf('pi_a')).toBe('drafting');
    expect(box('pi_a')!.querySelector('.canvas-cue-chip')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Being drafted now' })).toBeTruthy();
    expect(motionOf('pi_a')).toBeNull();
    expect(moving()).toEqual([]);
    expect(markForm()).toBe('false');
  });

  it('a null snapshot (the plan left generating): nothing moves, the mark is still, nothing throws', async () => {
    const update = mount('overlay', snap([step('author', 'pi_a')]));
    await loaded();
    update(null);
    expect(moving()).toEqual([]);
    expect(markForm()).toBe('false');
  });

  it('stalled: nothing moves and the mark is still — the last card keeps its cue, static (the approved hold)', async () => {
    mount('overlay', snap([step('author', 'pi_a')]));
    await loaded();
    act(() => {
      vi.advanceTimersByTime(PLAN_STALLED_AFTER_MS);
    });
    expect(moving()).toEqual([]);
    expect(motionOf('pi_a')).not.toBe('at-work');
    expect(cueOf('pi_a')).toBe('drafting');
    expect(markForm()).toBe('false');
  });

  it('starting (no step named): the mark breathes and nothing is cued', async () => {
    mount('overlay', snap([], { proposed: 0, authored: 0 }));
    await loaded();
    expect(markForm()).toBe('true');
    expect(document.querySelectorAll('[data-cue]')).toHaveLength(0);
    expect(moving()).toEqual([]);
  });

  it('a laying cue never moves, whatever the at-work steps hold', async () => {
    mount('overlay', snap([step('lay', LOGIN_ID)]));
    await loaded();
    expect(cueOf(LOGIN_ID)).toBe('laying');
    expect(motionOf(LOGIN_ID)).toBeNull();
    expect(markForm()).toBe('true');
  });

  it('readPlanAtWork is read ONCE per clock read, in the components that own a clock', async () => {
    const update = mount('overlay', snap([step('author', 'pi_a')]));
    await loaded();
    update(snap([step('author', 'pi_b')]));
    update(snap([step('author', 'pi_b')]), true);
    expect(spies.clock).toBeGreaterThan(0);
    expect(spies.atWork).toBe(spies.clock);
  });
});

describe('host parity — the overlay and the plan page, handed the same snapshot', () => {
  const readOut = async (host: Host, progress: PlanProgressSnapshot | null, failing = false) => {
    stubRoadmap();
    mount(host, progress, failing);
    await loaded();
    const out = {
      cues: [...document.querySelectorAll('[data-cue]')].map(
        (el) =>
          `${el.getAttribute('data-node-id')}:${el.getAttribute('data-cue')}:${el.getAttribute('data-cue-motion') ?? '-'}`,
      ),
      mark: markForm(),
    };
    cleanup();
    return out;
  };

  it.each([
    [
      'working',
      (): PlanProgressSnapshot | null =>
        snap([step('author', 'pi_a'), step('lay', LOGIN_ID, 's2')]),
      false,
    ],
    ['failing', (): PlanProgressSnapshot | null => snap([step('author', 'pi_a')]), true],
    ['settled', (): PlanProgressSnapshot | null => null, false],
  ] as const)('%s: the same cue forms and the same mark form', async (_, make, failing) => {
    const overlay = await readOut('overlay', make(), failing);
    const page = await readOut('plan-page', make(), failing);
    expect(page).toEqual(overlay);
  });

  it('the plan page draws the cue with motion OFF on the canvas', async () => {
    mount('plan-page', snap([step('author', 'pi_a')]));
    await loaded();
    expect(cueOf('pi_a')).toBe('drafting');
    expect(box('pi_a')!.hasAttribute('data-motion')).toBe(false);
  });
});

describe('reduced motion — the JS half vitest can hold', () => {
  it('under reduce a finished card keeps no leaving cue: it goes at once', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('reduce'),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    const update = mount('overlay', snap([step('author', 'pi_a')]));
    await loaded();
    update(snap([step('author', 'pi_b')]));
    expect(cueOf('pi_a')).toBeNull();
    expect(motionOf('pi_a')).toBeNull();
    vi.restoreAllMocks();
  });

  it('without reduce the same move leaves pi_a in its leaving form', async () => {
    const update = mount('overlay', snap([step('author', 'pi_a')]));
    await loaded();
    update(snap([step('author', 'pi_b')]));
    expect(motionOf('pi_a')).toBe('leaving');
    expect(motionOf('pi_b')).toBe('at-work');
  });
});
