// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { CHANGED_HIGHLIGHT_MS } from '@/lib/planning/livePane';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';

// THE CHANGED HIGHLIGHT on the plan's canvas (MOTIR-11185). While the plan is
// written (`live`), each poll's items carry `lastEditedAt`; a card whose edit time
// moves past the one the canvas last saw is lit where it is drawn, and counted in
// the arrivals slot when it sits on another level. The fixtures are the cue
// suite's (`plan-review-canvas-cues.test.tsx`): a stubbed roadmap read, the real
// `loadLevel`, the reader standing inside the epic.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

//   root  →  EPIC (ARP-1)
//            ├─ LOGIN (ARP-2)  ← pi_c proposed beneath it
//            ├─ RESET (ARP-3)
//            ├─ pi_a (proposed)
//            └─ pi_b (proposed)
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

const T1 = '2026-11-13T11:08:00.000Z';
const T2 = '2026-11-13T11:09:00.000Z';
const T3 = '2026-11-13T11:10:00.000Z';

/** The fixture items with the given edit times (by plan item id) and overrides. */
function itemsAt(
  edited: Record<string, string | null>,
  over: Record<string, Partial<PlanReviewItemDto>> = {},
): PlanReviewItemDto[] {
  return ITEMS.map((i) => ({
    ...i,
    lastEditedAt: edited[i.planItemId] ?? null,
    ...over[i.planItemId],
  }));
}

function mount(first: PlanReviewItemDto[], live = true) {
  const el = (items: PlanReviewItemDto[], isLive: boolean) => (
    <PlanReviewCanvas
      items={items}
      projectKey="ARP"
      version={0}
      outcome={null}
      heldTrail={INSIDE_EPIC}
      followTo={null}
      live={isLive}
    />
  );
  const r = render(el(first, live));
  return (next: PlanReviewItemDto[], isLive = live) => r.rerender(el(next, isLive));
}

const box = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const ring = (id: string) => box(id)?.querySelector('[data-testid="canvas-changed-ring"]') ?? null;
const lit = (id: string) => box(id)?.hasAttribute('data-changed') ?? false;
const pill = () => screen.queryByTestId('canvas-arrivals-offer');
const breadcrumb = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
const loaded = () => screen.findByText('Account recovery');

describe('PlanReviewCanvas — the changed highlight (MOTIR-11185)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubRoadmap();
  });

  it('edits present at mount highlight nothing; a newer edit lights the drawn card, then clears', async () => {
    const update = mount(itemsAt({ pi_a: T1 }));
    await loaded();
    expect(lit('pi_a')).toBe(false);
    expect(document.querySelector('[data-changed]')).toBeNull();

    update(itemsAt({ pi_a: T2 }));
    expect(lit('pi_a')).toBe(true);
    expect(box('pi_a')!.className).toContain('canvas-node--changed');
    expect(ring('pi_a')).not.toBeNull();
    expect((ring('pi_a') as HTMLElement).style.animationDuration).toBe(`${CHANGED_HIGHLIGHT_MS}ms`);
    // Named for assistive tech through the box's description, not drawn as text.
    const describedBy = box('pi_a')!.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('Just changed');
    expect(lit('pi_b')).toBe(false);
    expect(pill()).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(CHANGED_HIGHLIGHT_MS);
    });
    expect(lit('pi_a')).toBe(false);
    expect(ring('pi_a')).toBeNull();
    expect(box('pi_a')!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('a second edit RESTARTS the one highlight instead of stacking a second', async () => {
    const update = mount(itemsAt({ pi_a: T1 }));
    await loaded();
    update(itemsAt({ pi_a: T2 }));
    const first = ring('pi_a');
    await act(async () => {
      vi.advanceTimersByTime(CHANGED_HIGHLIGHT_MS - 1000);
    });
    update(itemsAt({ pi_a: T3 }));
    expect(box('pi_a')!.querySelectorAll('[data-testid="canvas-changed-ring"]')).toHaveLength(1);
    expect(ring('pi_a')).not.toBe(first);
    // Past the FIRST highlight's end, the restarted one still stands…
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(lit('pi_a')).toBe(true);
    // …and ends on its own timer.
    await act(async () => {
      vi.advanceTimersByTime(CHANGED_HIGHLIGHT_MS);
    });
    expect(lit('pi_a')).toBe(false);
  });

  it('a change on ANOTHER level is counted as changed, and Go there lands on it lit', async () => {
    const update = mount(itemsAt({ pi_c: T1 }));
    await loaded();
    update(itemsAt({ pi_c: T2 }));
    const offer = await waitFor(() => {
      expect(pill()).not.toBeNull();
      return pill()!;
    });
    expect(offer.textContent).toBe('1 changed in ARP-2 · Go there');
    expect(box('pi_c')).toBeNull();

    await act(async () => {
      fireEvent.click(offer);
    });
    await screen.findByText('Remember me');
    expect(within(breadcrumb()).getByRole('button', { current: 'page' }).textContent).toContain(
      'ARP-2',
    );
    expect(lit('pi_c')).toBe(true);
    expect(pill()).toBeNull();
  });

  it('two cards lit at once each keep their own timer, and unmounting clears them', async () => {
    const update = mount(itemsAt({ pi_a: T1, pi_b: T1 }));
    await loaded();
    update(itemsAt({ pi_a: T2, pi_b: T1 }));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    update(itemsAt({ pi_a: T2, pi_b: T2 }));
    expect(lit('pi_a')).toBe(true);
    expect(lit('pi_b')).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(CHANGED_HIGHLIGHT_MS - 1000);
    });
    expect(lit('pi_a')).toBe(false);
    expect(lit('pi_b')).toBe(true);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new card and a changed card on ONE other level read as one sentence', async () => {
    const update = mount(itemsAt({ pi_c: T1 }));
    await loaded();
    const added = proposal({
      planItemId: 'pi_e',
      nodeId: 'pi_e',
      title: 'Magic link',
      parentNodeId: LOGIN_ID,
      parentIdentifier: 'ARP-2',
      parentTitle: 'Login UI',
      parentKind: 'story',
      parentTrail: ITEMS[2]!.parentTrail,
      kind: 'subtask',
    });
    update([...itemsAt({ pi_c: T2 }), added]);
    const offer = await waitFor(() => {
      expect(pill()).not.toBeNull();
      return pill()!;
    });
    expect(offer.textContent).toBe('1 new · 1 changed in ARP-2 · Go there');
  });

  it('a remove highlights nothing, and a canvas no longer live lights nothing', async () => {
    const update = mount(itemsAt({ pi_a: T1, pi_b: T1 }));
    await loaded();
    update(
      itemsAt(
        { pi_a: T2, pi_b: T1 },
        { pi_a: { op: 'remove', proposal: { ...ITEMS[0]!.proposal, op: 'remove' } } },
      ),
    );
    expect(document.querySelector('[data-changed]')).toBeNull();

    // The plan is decided: the canvas stops being live, and an edit then lights nothing.
    update(itemsAt({ pi_a: T2, pi_b: T3 }), false);
    expect(document.querySelector('[data-changed]')).toBeNull();
  });

  it('a plan that was never live lights nothing', async () => {
    const update = mount(itemsAt({ pi_a: T1 }), false);
    await loaded();
    update(itemsAt({ pi_a: T2 }), false);
    expect(document.querySelector('[data-changed]')).toBeNull();
  });
});
