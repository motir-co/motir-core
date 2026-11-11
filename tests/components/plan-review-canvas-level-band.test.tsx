// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';

// A pending change to the LEVEL YOU ARE STANDING IN (bug MOTIR-6223; design
// MOTIR-6241, `design/ai-chat/planning-workspace--level-change.mock.html`).
//
// Since MOTIR-6154 the planning surface opens INSIDE its target, so the target is
// the LEVEL and not a card on it — and a level frames the nodes ON it. A plan that
// renames the epic you are standing in drew its `1 changed` nowhere on screen. The
// band is the second row of the breadcrumb bar that says so, and every assertion
// here reads on rendered output through the real `loadLevel`.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

//   root  →  EPIC (ARP-1 · Authentication)
//            ├─ LOGIN (ARP-2 · Login UI)
//            └─ RESET (ARP-3 · Password Reset)
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

/** The epic ITSELF, as a `modify` — keyed by its own id, sitting on the root. */
function epicModify(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return proposal({
    planItemId: 'pi_mod',
    op: 'modify',
    nodeId: EPIC_ID,
    parentNodeId: null,
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    parentTrail: [],
    identifier: 'ARP-1',
    title: 'Authentication & sessions',
    kind: 'epic',
    status: 'todo',
    statusCategory: 'todo',
    hasChildren: true,
    changes: [
      { field: 'title', from: 'Authentication', to: 'Authentication & sessions' },
      { field: 'status', from: 'In Progress', to: 'To Do' },
    ],
    ...over,
  });
}

const INSIDE_EPIC: CanvasCrumb[] = [{ id: EPIC_ID, label: 'ARP-1 · Authentication' }];

function mount(
  items: PlanReviewItemDto[],
  opts: {
    outcome?: 'accepted' | 'declined' | null;
    heldTrail?: CanvasCrumb[] | null;
    offerPlanElsewhere?: boolean;
    live?: boolean;
  } = {},
) {
  return render(
    <PlanReviewCanvas
      items={items}
      projectKey="ARP"
      version={0}
      outcome={opts.outcome ?? null}
      heldTrail={opts.heldTrail ?? INSIDE_EPIC}
      offerPlanElsewhere={opts.offerPlanElsewhere}
      live={opts.live}
    />,
  );
}

const band = () => screen.queryByTestId('canvas-level-band');
const breadcrumb = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

describe('PlanReviewCanvas — a pending change to the level you stand in (bug MOTIR-6223)', () => {
  beforeEach(() => {
    stubRoadmap();
  });

  it('REPRODUCTION: inside a renamed epic, the rename is on screen — in the bar, not on a card', async () => {
    mount([proposal(), epicModify()]);
    // The level loaded: the proposed add under the epic is on the canvas.
    await screen.findByText('Account recovery');
    // No card on this level carries the change — the epic IS the level.
    expect(document.querySelectorAll('[data-op="modify"]')).toHaveLength(0);

    const b = await waitFor(() => {
      const found = band();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(b.getAttribute('data-state')).toBe('changed');
    // Inside the breadcrumb bar — the one element that stands for the level.
    expect(breadcrumb().contains(b)).toBe(true);
    // The screen-reader prefix, the op word the card wears, the subject in words,
    // the proposed title, and the changed fields.
    expect(b.textContent).toContain('Pending change to this level:');
    expect(within(b).getByText('change')).toBeTruthy();
    expect(b.textContent).toContain('This level');
    expect(b.textContent).toContain('title → Authentication & sessions');
    expect(within(b).getByTestId('canvas-level-band-fields').textContent).toBe('Title · Status');
  });

  it('keeps the COMMITTED title on the crumb — the band carries the proposed one', async () => {
    mount([proposal(), epicModify()]);
    await waitFor(() => expect(band()).not.toBeNull());
    const current = within(breadcrumb()).getByRole('button', { current: 'page' });
    expect(current.textContent).toContain('ARP-1 · Authentication');
    expect(current.textContent).not.toContain('sessions');
  });

  it('names no proposed title when the title is not among the changes', async () => {
    mount([
      proposal(),
      epicModify({ changes: [{ field: 'priority', from: 'Medium', to: 'High' }] }),
    ]);
    const b = await waitFor(() => {
      expect(band()).not.toBeNull();
      return band()!;
    });
    expect(b.textContent).not.toContain('→');
    expect(within(b).getByTestId('canvas-level-band-fields').textContent).toBe('Priority');
  });

  it('says a REMOVED level goes on approve — and the crumb is not struck', async () => {
    mount([epicModify({ op: 'remove', changes: [], title: 'Authentication' })]);
    const b = await waitFor(() => {
      expect(band()).not.toBeNull();
      return band()!;
    });
    expect(b.getAttribute('data-state')).toBe('removed');
    expect(b.textContent).toContain('This level goes on approve');
    const current = within(breadcrumb()).getByRole('button', { current: 'page' });
    expect(current.className).not.toContain('line-through');
  });

  it('says a level that is ITSELF a proposed add holds nothing real yet', async () => {
    const container = proposal();
    const child = proposal({
      planItemId: 'pi_child',
      nodeId: 'pi_child',
      parentNodeId: 'pi_add',
      parentIdentifier: null,
      parentTitle: 'Account recovery',
      parentKind: 'story',
      title: 'Recovery codes',
      kind: 'subtask',
    });
    mount([container, child], {
      heldTrail: [...INSIDE_EPIC, { id: 'pi_add', label: 'New · Account recovery' }],
    });
    const b = await waitFor(() => {
      expect(band()).not.toBeNull();
      return band()!;
    });
    expect(b.getAttribute('data-state')).toBe('added');
    expect(b.textContent).toContain('This level is proposed — nothing here exists yet');
  });

  it('draws NO band on a level the plan does not change — the bar ships as it did', async () => {
    mount([proposal()]);
    await screen.findByText('Account recovery');
    expect(band()).toBeNull();
  });

  it('draws NO band for a LOCKED change — a finished level the plan cannot touch', async () => {
    mount([proposal(), epicModify({ statusCategory: 'done', status: 'done' })]);
    await screen.findByText('Account recovery');
    expect(band()).toBeNull();
  });

  it('fuses the DECISION onto the band once the plan is decided', async () => {
    mount([proposal(), epicModify()], { outcome: 'accepted' });
    const b = await waitFor(() => {
      expect(band()).not.toBeNull();
      return band()!;
    });
    expect(within(b).getByTestId('plan-item-outcome').textContent).toBe('accepted');
  });

  it('draws the band at every level the reader DRILLS to, not only the arrival', async () => {
    const loginModify = epicModify({
      planItemId: 'pi_login',
      nodeId: LOGIN_ID,
      parentNodeId: EPIC_ID,
      parentIdentifier: 'ARP-1',
      parentTitle: 'Authentication',
      parentKind: 'epic',
      parentTrail: EPIC_TRAIL,
      identifier: 'ARP-2',
      title: 'Sign-in UI',
      kind: 'story',
      changes: [{ field: 'title', from: 'Login UI', to: 'Sign-in UI' }],
    });
    mount([loginModify]);
    // Standing inside the epic: the login card carries its own frame, and the
    // epic is untouched, so there is no band.
    await waitFor(() => expect(document.querySelectorAll('[data-op="modify"]')).toHaveLength(1));
    expect(band()).toBeNull();
    // Drill into the changed story — now it is the level, and the band says so.
    fireEvent.keyDown(document.querySelector(`[data-node-id="${LOGIN_ID}"]`)!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    const b = await waitFor(() => {
      expect(band()).not.toBeNull();
      return band()!;
    });
    expect(b.textContent).toContain('title → Sign-in UI');
  });
});

describe('PlanReviewCanvas — the plan is BESIDE the reader (MOTIR-6223, second half)', () => {
  beforeEach(() => {
    stubRoadmap();
  });

  // Planning from `Login UI` while the run adds a sibling under `Authentication`:
  // nothing on the reader's level changes, so there is no band — the plan is one
  // crumb up, and MOTIR-6161's offer already says exactly that.
  const INSIDE_LOGIN: CanvasCrumb[] = [
    ...INSIDE_EPIC,
    { id: LOGIN_ID, label: 'ARP-2 · Login UI', crumbKey: 'ARP-2' },
  ];

  it('OFFERS the trip when the plan places nothing on the reader level and something elsewhere', async () => {
    mount([proposal()], { heldTrail: INSIDE_LOGIN, offerPlanElsewhere: true });
    const offer = await screen.findByTestId('canvas-follow-offer');
    expect(offer.textContent).toBe('Plan is in ARP-1 · Go there');
    // The offer shares the slot's compact form below a 32rem bar (MOTIR-8646):
    // its words stay its accessible name when the label goes sr-only.
    expect(offer.getAttribute('aria-label')).toBe('Plan is in ARP-1 · Go there');
    expect(offer.className).toContain('@max-[32rem]/canvas-bar:size-(--height-control)');
    expect(band()).toBeNull();
    fireEvent.click(offer);
    // Taking it moves the canvas to the plan's level, and the offer goes.
    await screen.findByText('Account recovery');
    await waitFor(() => expect(screen.queryByTestId('canvas-follow-offer')).toBeNull());
  });

  it('offers nothing when the plan is ON the reader level', async () => {
    mount([proposal()], { offerPlanElsewhere: true });
    await screen.findByText('Account recovery');
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
  });

  it('offers nothing when the plan changes the reader level ITSELF — the band says that', async () => {
    const loginModify = epicModify({
      planItemId: 'pi_login',
      nodeId: LOGIN_ID,
      parentNodeId: EPIC_ID,
      parentIdentifier: 'ARP-1',
      parentTitle: 'Authentication',
      parentKind: 'epic',
      parentTrail: EPIC_TRAIL,
      identifier: 'ARP-2',
      title: 'Sign-in UI',
      kind: 'story',
      changes: [{ field: 'title', from: 'Login UI', to: 'Sign-in UI' }],
    });
    mount([loginModify], { heldTrail: INSIDE_LOGIN, offerPlanElsewhere: true });
    await waitFor(() => expect(band()).not.toBeNull());
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
  });

  it('is OPT-IN — the plan page, which passes nothing, is unchanged', async () => {
    mount([proposal()], { heldTrail: INSIDE_LOGIN });
    await waitFor(() =>
      expect(within(breadcrumb()).getByRole('button', { current: 'page' }).textContent).toContain(
        'Login UI',
      ),
    );
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
  });

  it('stays out of the way while the plan is WRITTEN — the arrivals count owns that slot', async () => {
    mount([proposal()], { heldTrail: INSIDE_LOGIN, offerPlanElsewhere: true, live: true });
    await waitFor(() =>
      expect(within(breadcrumb()).getByRole('button', { current: 'page' }).textContent).toContain(
        'Login UI',
      ),
    );
    expect(screen.queryByTestId('canvas-follow-offer')).toBeNull();
  });
});
