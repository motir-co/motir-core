// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// The plan-detail canvas at the `loadLevel` SEAM (bug MOTIR-3152).
//
// `tests/components/plan-item-node.test.tsx` covers `mergePlanLevel` against a
// hand-built, ALREADY-ADAPTED committed fixture and asserts `nodes.map(n => n.id)`.
// That is an identity assertion over a shape the production path never produced:
// `loadLevel` fetched the roadmap route and CAST its wire DTO to the canvas view
// model, so every committed node arrived with no `content`, no `drillable` and no
// `searchText` — invisible, undrillable, and fatal to search — while the id array
// it was checked by was perfectly correct.
//
// So every assertion here reads on RENDERED OUTPUT, driven from the REAL
// `ProjectRoadmapDto` wire payload through the real `loadLevel`. A canvas node is
// a rendering contract, and the only assertion that holds one asserts on what
// renders.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── The tree the stubbed roadmap route serves, four levels deep ──────────────
//   root  →  MOTIR-2200 (epic)
//            └─ MOTIR-3070 (bug)          ← the level the plan proposes into
//               ├─ MOTIR-7  (story, in review, has children)
//               └─ MOTIR-9  (subtask, todo)   ── MOTIR-9 blocks MOTIR-7
//                  MOTIR-7 └─ MOTIR-3083 (subtask, done)
// The shape mirrors `design/ai-planning/plans-surface.mock.html` panel E, whose
// breadcrumb reads `MOTIR-2200 · … › MOTIR-3070 · …`.
const EPIC_ID = 'wi_epic';
const BUG_ID = 'wi_bug';
const STORY_ID = 'wi_story';
const SUB_ID = 'wi_sub';
const LEAF_ID = 'wi_leaf';

/** A row in the REAL wire shape of `GET /api/projects/[key]/roadmap` (`RoadmapNodeDto`). */
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

const WIRE_LEVELS: Record<string, unknown> = {
  __root__: {
    nodes: [
      wireNode({
        id: EPIC_ID,
        kind: 'epic',
        identifier: 'MOTIR-2200',
        title: 'The Motir agent loop',
        status: 'in_progress',
        statusLabel: null,
        statusCategory: null,
        hasChildren: true,
        progress: { done: 2, total: 9 },
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
        title: 'The plan review surface is narrower',
        status: 'done',
        statusLabel: null,
        statusCategory: null,
        isDone: true,
        hasChildren: true,
        progress: { done: 3, total: 3 },
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
        title: 'AI planning layer',
        status: 'in_review',
        statusLabel: null,
        statusCategory: null,
        hasChildren: true,
        progress: { done: 1, total: 3 },
      }),
      wireNode({
        id: SUB_ID,
        parentId: BUG_ID,
        identifier: 'MOTIR-9',
        title: 'The starter template',
        type: 'code',
        executor: 'coding_agent',
        ready: true,
      }),
    ],
    // A committed `blocked_by` edge BETWEEN two nodes on this level.
    edges: [{ blockedId: STORY_ID, blockerId: SUB_ID }],
    offLevelBlockers: [],
  },
  [STORY_ID]: {
    nodes: [
      wireNode({
        id: LEAF_ID,
        parentId: STORY_ID,
        identifier: 'MOTIR-3083',
        title: 'The plan canvas renders the roadmap level',
        status: 'done',
        statusLabel: null,
        statusCategory: null,
        isDone: true,
      }),
    ],
    edges: [],
    offLevelBlockers: [],
  },
};

function stubRoadmap() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    // The quick-view peek shares this stub so the View door can be driven end to
    // end; it 404s, which the panel renders as its own not-found state.
    if (url.pathname === '/api/work-items/peek') {
      return Promise.resolve({ ok: false, status: 404 } as Response);
    }
    const parentId = url.searchParams.get('parentId') ?? '__root__';
    const body = WIRE_LEVELS[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function proposal(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: BUG_ID,
    parentIdentifier: 'MOTIR-3070',
    parentTitle: 'The plan review surface is narrower',
    parentKind: 'bug',
    parentTrail: [
      { id: EPIC_ID, identifier: 'MOTIR-2200', title: 'The Motir agent loop' },
      { id: BUG_ID, identifier: 'MOTIR-3070', title: 'The plan review surface is narrower' },
    ],
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
    title: 'A proposed subtask',
    kind: 'subtask',
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

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

/** Select a node the way a user does, so the canvas surfaces its action slot. */
function selectNode(id: string) {
  fireEvent.keyDown(el(id)!, { key: 'Enter' });
}

function mount(
  items: PlanReviewItemDto[] = [proposal()],
  outcome: 'accepted' | 'declined' | null = null,
) {
  return render(
    <PlanReviewCanvas items={items} projectKey="MOTIR" version={0} outcome={outcome} />,
  );
}

describe('PlanReviewCanvas — the committed level it draws', () => {
  beforeEach(() => {
    stubRoadmap();
  });

  it('RENDERS a committed sibling — its identifier and its title — from the real wire payload', async () => {
    mount();

    // The proposal is drawn (it always was — `mergePlanLevel` adapts it).
    expect(await screen.findByText('A proposed subtask')).toBeTruthy();
    // The committed siblings it lands beside are the whole point of the surface.
    expect(screen.getByText('MOTIR-7')).toBeTruthy();
    expect(screen.getByText('AI planning layer')).toBeTruthy();
    expect(screen.getByText('MOTIR-9')).toBeTruthy();
    expect(screen.getByText('The starter template')).toBeTruthy();
  });

  it('draws a committed sibling as its REAL card — status pill included', async () => {
    mount();
    await screen.findByText('MOTIR-7');
    // `labels.defaultStatus.in_review` — the shipped `WorkItemStatusPill`, not a
    // stand-in: the card is the roadmap's card because it is BUILT by the
    // roadmap's own adapter.
    expect(within(el(STORY_ID) as HTMLElement).getByText('In Review')).toBeTruthy();
    // The sibling the wire payload marks READY takes the shipped ready pill in the
    // same slot — the adapter carried `ready` too, not just the name fields.
    expect(within(el(SUB_ID) as HTMLElement).getByTestId('ready-pill')).toBeTruthy();
  });

  it('offers Open on a committed sibling with children, and DRILLS into its level', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    // A childless sibling is a leaf — no drill affordance.
    selectNode(SUB_ID);
    expect(within(el(SUB_ID) as HTMLElement).queryByTestId('drill-button')).toBeNull();

    selectNode(STORY_ID);
    const open = within(el(STORY_ID) as HTMLElement).getByTestId('drill-button');
    fireEvent.click(open);

    expect(await screen.findByText('MOTIR-3083')).toBeTruthy();
    expect(screen.getByText('The plan canvas renders the roadmap level')).toBeTruthy();
    expect(el(STORY_ID)).toBeNull(); // we left the level we drilled from
  });

  it('DRAWS a committed blocked_by edge between two nodes on the level', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    // One `<path>` per drawn edge (`PlanningCanvas` keeps its markers in a
    // separate <svg> precisely so this count is the edge count).
    const edges = screen.getByTestId('canvas-edges');
    expect(edges.querySelectorAll('path')).toHaveLength(1);
    // …and the legend, which only appears when the level HAS dependency edges.
    expect(screen.getByTestId('edge-legend')).toBeTruthy();
  });

  it('SEARCHES a level holding committed nodes without throwing, and locates one by identifier', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    // Before the fix `searchText` was undefined on every committed node and
    // `searchMatches` threw on the first keystroke.
    //
    // ⚠️ The placeholder MOVED (MOTIR-4021): this box is on a PLAN, and it used
    // to offer to search the roadmap because the foundation owned the string.
    // The consumer owns it now, so this assertion names the plan-review label —
    // and it is addressed by ACCESSIBLE NAME, which is what a reader hears and
    // what the E2E leg asserts.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this plan' }), {
      target: { value: 'MOTIR-9' },
    });

    expect(el(SUB_ID)!.querySelector('[data-highlighted]')).toBeTruthy();
    expect(el(STORY_ID)!.querySelector('[data-highlighted]')).toBeNull();
  });

  it('opens on the committed ANCESTOR CHAIN, not one synthesised crumb', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('MOTIR-2200 · The Motir agent loop')).toBeTruthy();
    expect(within(nav).getByText('MOTIR-3070 · The plan review surface is narrower')).toBeTruthy();
    // The root crumb goes to the project roadmap root, so it is NOT labelled
    // "Plan" — that named a destination it does not have.
    expect(within(nav).queryByText('Plan')).toBeNull();
    expect(within(nav).getByText('Roadmap')).toBeTruthy();
  });

  it('leaves a working control on screen at EVERY crumb up to and including the root', async () => {
    mount();
    await screen.findByText('MOTIR-7');

    const nav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

    // One step up: the ancestor's own level, with the level we came from on it.
    fireEvent.click(within(nav()).getByText('MOTIR-2200 · The Motir agent loop'));
    expect(await screen.findByText('MOTIR-3070')).toBeTruthy();
    selectNode(BUG_ID);
    expect(within(el(BUG_ID) as HTMLElement).getByTestId('drill-button')).toBeTruthy();

    // The ROOT crumb. The breadcrumb legitimately unmounts here (there is
    // nothing left to walk) — what must NOT happen is the level below it going
    // blank, which is exactly what stranded the reporter.
    fireEvent.click(within(nav()).getByText('Roadmap'));
    expect(await screen.findByText('MOTIR-2200')).toBeTruthy();
    selectNode(EPIC_ID);
    expect(within(el(EPIC_ID) as HTMLElement).getByTestId('drill-button')).toBeTruthy();
  });

  it('peeks a committed sibling by its IDENTIFIER, not by its canvas node id', async () => {
    // A committed node is `viewable` now, so its View button is reachable for the
    // first time — and the peek reads `?key=MOTIR-<n>` while the canvas hands the
    // handler a cuid. Without the id → identifier mapping this asks for a key no
    // work item has.
    const fetchMock = stubRoadmap();
    mount();
    await screen.findByText('MOTIR-7');

    selectNode(STORY_ID);
    fireEvent.click(within(el(STORY_ID) as HTMLElement).getByTestId('view-button'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('/api/work-items/peek?key=MOTIR-7')),
      ).toBe(true),
    );

    // ⚠️ AND NO PROPOSAL CHROME (MOTIR-4185 AC 3) — the arm the routing change
    // could silently break. The canvas draws committed neighbours BESIDE
    // proposals, and those neighbours are ordinary work items this plan says
    // nothing about. Routing *everything on the plan canvas* through proposal
    // mode would satisfy every criterion about proposals and quietly tell a
    // reviewer that a work item is being changed when it is not — the same class
    // of false statement as the defect being fixed, pointed the other way.
    expect(screen.queryByTestId('proposal-peek')).toBeNull();
    expect(screen.queryByTestId('quick-view-op')).toBeNull();
  });

  // ── The PROPOSED half of the same contract ────────────────────────────────
  // `viewable` is what surfaces the View pill, and `mergePlanLevel` pushed every
  // proposal without it. So MOTIR-3084's proposal peek — the whole read view for
  // a proposed card — was unreachable from the canvas it was built for: the
  // handler existed, the modal existed, and no affordance opened either. Same
  // missing flag as the committed nodes above, other half of the merge.
  it('offers View on a selected PROPOSAL and opens its peek — no work item needed', async () => {
    const fetchMock = stubRoadmap();
    mount();
    await screen.findByText('A proposed subtask');

    selectNode('pi_1');
    fireEvent.click(within(el('pi_1') as HTMLElement).getByTestId('view-button'));

    // The PROPOSAL peek, not the work-item one: an `add` has no work item, so
    // nothing may be asked of `/api/work-items/peek` on its behalf.
    const peek = await screen.findByTestId('proposal-peek');
    expect(within(peek).getByText('A proposed subtask')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/work-items/peek'))).toBe(
      false,
    );
  });

  it('peeks a DRIFTED modify as a PROPOSAL, over the live target it names', async () => {
    // ⚠️ REWRITTEN by MOTIR-4185, and the previous assertion is the defect.
    //
    // This read: *"it names a real work item, so View opens the SHIPPED
    // work-item peek keyed by that identifier"* — which is true of the KEY and
    // wrong about the SURFACE. The shipped work-item peek shows the target's
    // CURRENT values with no sign a plan is about to change them, on the surface
    // a person approves from. That is half of what story MOTIR-4181 exists to
    // close (the other half was the list door opening a different component).
    //
    // The NEW contract keeps both halves of the old one and fixes the surface: a
    // `modify` still names its target and the peek still FETCHES that target's
    // payload by key — it is the base the proposal is overlaid on — but what
    // renders is the shipped peek in PROPOSAL MODE.
    const fetchMock = stubRoadmap();
    mount([
      proposal({
        planItemId: 'pi_mod',
        nodeId: 'pi_mod',
        op: 'modify',
        identifier: 'MOTIR-3083',
        title: 'A drifted modify',
        changes: [],
        todos: null,
        proposal: {
          op: 'modify',
          identifier: 'MOTIR-3083',
          changedFields: [],
          settableRailFields: [],
          todos: null,
        },
      }),
    ]);
    await screen.findByText('A drifted modify');

    selectNode('pi_mod');
    fireEvent.click(within(el('pi_mod') as HTMLElement).getByTestId('view-button'));

    // The TARGET is still fetched by key — unchanged, and it is what the
    // proposal's own values are laid over.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes('/api/work-items/peek?key=MOTIR-3083'),
        ),
      ).toBe(true),
    );
    // …and the surface is the PROPOSAL's, which is what changed. This harness
    // 404s `/api/work-items/peek` (see `stubRoadmap`), and a 404 on a `modify`'s
    // target is the DOCUMENTED case — the live target is archived or
    // hard-deleted, which the review model also reports as `targetMissing`. Part
    // XIV §8 says that shows the peek's shipped NOT-FOUND panel rather than an
    // empty proposal, so THAT is what a drifted modify lands on here.
    expect(await screen.findByTestId('proposal-peek-missing')).toBeTruthy();
  });

  // ── MOTIR-3161 (bug MOTIR-3154) — the DOOR must open what the label claims ──
  //
  // The routing was on `op` ALONE: `op === 'add'` opened `ProposalQuickView`.
  // That is right for a proposal and wrong for one that has been APPROVED — with
  // MOTIR-3160's keying an accepted card displays a real `MOTIR-<n>` and would
  // still open the PRE-APPROVAL proposal view of a card that now exists. An
  // accepted treatment whose View opens the proposal is a label that lies about
  // what clicking it does.

  it('peeks an APPROVED add as the WORK ITEM it became, not as a proposal', async () => {
    const fetchMock = stubRoadmap();
    mount(
      [
        proposal({
          planItemId: 'pi_1',
          // Keyed by the work item it became — the whole point of MOTIR-3160.
          nodeId: 'wi_accepted',
          op: 'add',
          identifier: 'MOTIR-3166',
          title: 'An accepted card',
          status: 'todo',
        }),
      ],
      'accepted',
    );
    await screen.findByText('An accepted card');

    selectNode('wi_accepted');
    fireEvent.click(within(el('wi_accepted') as HTMLElement).getByTestId('view-button'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes('/api/work-items/peek?key=MOTIR-3166'),
        ),
      ).toBe(true),
    );
    expect(screen.queryByTestId('proposal-peek')).toBeNull();
  });

  it('still peeks an UN-materialized add as a proposal — the other direction', async () => {
    const fetchMock = stubRoadmap();
    // A declined plan's `add` never became anything: no identifier, so the
    // proposal peek is still the honest thing to open.
    mount([proposal({ title: 'A refused proposal' })], 'declined');
    await screen.findByText('A refused proposal');

    selectNode('pi_1');
    fireEvent.click(within(el('pi_1') as HTMLElement).getByTestId('view-button'));

    const peek = await screen.findByTestId('proposal-peek');
    expect(within(peek).getByText('A refused proposal')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/work-items/peek'))).toBe(
      false,
    );
  });

  it('draws the decided outcome on the plan own nodes and on no committed neighbour', async () => {
    stubRoadmap();
    mount([proposal({ title: 'An accepted proposal' })], 'accepted');
    await screen.findByText('An accepted proposal');

    // The plan's node carries the word; the committed sibling MOTIR-9 does not —
    // the plan decided nothing about it.
    expect(within(el('pi_1') as HTMLElement).getByText('accepted')).toBeTruthy();
    expect(within(el(SUB_ID) as HTMLElement).queryByText('accepted')).toBeNull();
  });

  it('degrades to the proposals alone when there is no project to read a level from', async () => {
    const fetchMock = stubRoadmap();
    render(<PlanReviewCanvas items={[proposal()]} projectKey="" version={0} />);

    expect(await screen.findByText('A proposed subtask')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades to the proposals alone when the level read FAILS', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    // A root proposal, so the canvas opens at the top level.
    mount([proposal({ parentNodeId: null, parentIdentifier: null, parentTrail: [] })]);

    expect(await screen.findByText('A proposed subtask')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('MOTIR-7')).toBeNull());
  });
});

// ── bug MOTIR-3366 — a PROPOSED dependency edge is drawn, not only counted ────
//
// A plan states a `blocked_by` edge in one of two carriers, chosen by the op: an
// `add` in its own `blockedByRefs`, a `modify` in `patch.blockedByAdd`. The
// review model resolved only the first, so the correction shape every mid-run
// re-plan produces — `add` the prerequisite, `modify` the in-flight card to be
// blocked by it — reached this canvas with an empty edge set. The added card
// drew beside the card it blocks with no line between them, while the list view
// showed the same edge as the words "+1 blocker".
//
// `planReviewService` is where the fix lives and where the service test asserts
// it; this asserts the OTHER end — that a resolved edge becomes an actual arrow
// on the level both ends share. It is written as a DELTA against the identical
// level with no proposed edge, because a raw path count is also satisfied by the
// committed edge that was always there.
describe('PlanReviewCanvas — a proposed dependency edge (bug MOTIR-3366)', () => {
  beforeEach(() => {
    stubRoadmap();
  });

  /**
   * The plan the guard contract produces: an `add` at the level, plus a `modify`
   * on a committed sibling that the add now blocks. A `modify` keys by its
   * TARGET's node id (MOTIR-3160), which is what lands the arrow ON the real
   * card instead of beside it.
   */
  function correction(blockedByNodeIds: string[]): PlanReviewItemDto[] {
    return [
      proposal(),
      proposal({
        planItemId: 'pi_2',
        nodeId: STORY_ID,
        op: 'modify',
        identifier: 'MOTIR-7',
        title: 'AI planning layer',
        blockedByNodeIds,
        changes: [{ field: 'links', from: null, to: '+1 blocker' }],
      }),
    ];
  }

  function drawnEdges() {
    return [...screen.getByTestId('canvas-edges').querySelectorAll('path')];
  }

  /** The dashed, not-yet-firm edges — the `pending` language, on this level. */
  function pendingEdges() {
    return drawnEdges().filter((p) => p.getAttribute('stroke-dasharray') !== null);
  }

  it('DRAWS the arrow from the added card to the card it will block', async () => {
    mount(correction([]));
    await screen.findByText('A proposed subtask');
    // The level's own committed edge (MOTIR-9 blocks MOTIR-7) and nothing else —
    // this is exactly what the surface showed before the fix. That edge is itself
    // DASHED, because MOTIR-9 is not done: `pending` is the shipped language for
    // any not-yet-firm dependency, committed or proposed, which is why the
    // assertion below is a DELTA rather than a search for a dashed path.
    expect(drawnEdges()).toHaveLength(1);
    expect(pendingEdges()).toHaveLength(1);

    cleanup();
    mount(correction(['pi_1']));
    await screen.findByText('A proposed subtask');

    // …and with the proposal's edge resolved, one MORE path: the delta is the
    // arrow, not the level. It arrives in the same pending language — nothing new
    // is introduced (`design/ai-planning/design-notes.md` Part V: *"same-level
    // `blocked_by` edges, in the shipped edge language, unchanged"*).
    expect(drawnEdges()).toHaveLength(2);
    expect(pendingEdges()).toHaveLength(2);
    for (const path of pendingEdges()) {
      expect(path.getAttribute('class')).toContain('stroke-(--el-canvas-edge-pending)');
    }

    // The legend appears for either edge, so it is not what proves the arrow —
    // asserted so a future change that drops the proposed edge cannot pass by
    // leaving the legend behind.
    expect(screen.getByTestId('edge-legend')).toBeTruthy();
  });

  it('does not double-draw an edge the committed level already has', async () => {
    // A plan may propose an edge that is already wired. `mergePlanLevel` keeps
    // the committed edge and adds nothing — one dependency, one arrow.
    mount(correction([SUB_ID]));
    await screen.findByText('A proposed subtask');

    expect(drawnEdges()).toHaveLength(1);
  });

  it('draws nothing when only ONE end of the proposed edge is on the level', async () => {
    // The control: an off-level blocker the review model could not NAME has no
    // node here and no stub to mint an anchor from, so its edge is dropped rather
    // than drawn to nowhere. One that CAN be named takes the off-level treatment
    // (bug MOTIR-5387, at the bottom of this file).
    mount(correction(['wi_somewhere_else']));
    await screen.findByText('A proposed subtask');

    expect(drawnEdges()).toHaveLength(1);
  });
});

// ── bug MOTIR-3439 — APPROVE re-keys the level the reviewer is standing on ────
//
// `materialize` re-keys every `add` to the work item it became
// (`planReviewService`: `nodeId: item.workItemId ?? item.id`, MOTIR-3160), and
// resolves each intra-plan `planItem:` ref through the same map — so a proposed
// container's children stop pointing at its PlanItem id and start pointing at
// its new cuid. Meanwhile `ProjectRoadmapCanvas` holds its drilled `focusId` and
// its crumbs in mount-time state, deliberately (`initialTrail` is a seed, not a
// controlled level), and `PlanDetail`'s approve is a `setState` re-render with no
// `key` on the canvas.
//
// So the canvas was left focused on an id that names nothing: the roadmap read
// returned an empty level, `proposalsAtLevel` matched nothing, and the reviewer
// got `emptyDrilled` — "No items at this level" — in the same breath the rail
// said the plan was approved.
//
// ⚠️ EVERY CASE HERE RE-RENDERS A MOUNTED CANVAS. A fresh mount on the approved
// model already worked before the fix (`arrivalLevel` resolves the materialized
// container), so a test that mounts twice passes on the broken code and proves
// nothing. The bug lives in the transition, and so do these.
describe('PlanReviewCanvas — the level survives APPROVE (bug MOTIR-3439)', () => {
  const PARENT_ID = 'wi_parent';
  const NEW_STORY_ID = 'wi_new_story';
  const CHILD_A = 'wi_child_a';
  const CHILD_B = 'wi_child_b';

  /** Has the plan been approved? The roadmap read genuinely changes at approve. */
  let materialized = false;

  function approveStub() {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/work-items/peek') {
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }
      const parentId = url.searchParams.get('parentId') ?? '__root__';
      const levels: Record<string, unknown> = {
        __root__: {
          nodes: [
            wireNode({
              id: PARENT_ID,
              kind: 'epic',
              identifier: 'MOTIR-2200',
              title: 'The Motir agent loop',
              hasChildren: true,
            }),
          ],
          edges: [],
          offLevelBlockers: [],
        },
        // The container the plan proposes into — it gains the new story only
        // once the plan is approved.
        [PARENT_ID]: {
          nodes: materialized
            ? [
                wireNode({
                  id: NEW_STORY_ID,
                  parentId: PARENT_ID,
                  kind: 'story',
                  identifier: 'MOTIR-500',
                  title: 'The new story',
                  hasChildren: true,
                }),
              ]
            : [],
          edges: [],
          offLevelBlockers: [],
        },
        // The story's own level — it does not exist at all until approve.
        ...(materialized
          ? {
              [NEW_STORY_ID]: {
                nodes: [
                  wireNode({
                    id: CHILD_A,
                    parentId: NEW_STORY_ID,
                    identifier: 'MOTIR-501',
                    title: 'The first subtask',
                  }),
                  wireNode({
                    id: CHILD_B,
                    parentId: NEW_STORY_ID,
                    identifier: 'MOTIR-502',
                    title: 'The second subtask',
                  }),
                ],
                edges: [],
                offLevelBlockers: [],
              },
            }
          : {}),
      };
      const body = levels[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** A proposal under the committed container, carrying its trail. */
  function under(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
    return proposal({
      parentNodeId: PARENT_ID,
      parentIdentifier: 'MOTIR-2200',
      parentTitle: 'The Motir agent loop',
      parentKind: 'epic',
      parentTrail: [{ id: PARENT_ID, identifier: 'MOTIR-2200', title: 'The Motir agent loop' }],
      ...over,
    });
  }

  /** The plan as REVIEWED: one story under the epic, two subtasks under it. */
  const PENDING: PlanReviewItemDto[] = [
    under({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      kind: 'story',
      title: 'The new story',
      hasChildren: true,
    }),
    under({
      planItemId: 'pi_a',
      nodeId: 'pi_a',
      parentNodeId: 'pi_story',
      title: 'The first subtask',
    }),
    under({
      planItemId: 'pi_b',
      nodeId: 'pi_b',
      parentNodeId: 'pi_story',
      title: 'The second subtask',
    }),
  ];

  /** …and as APPROVED: every `add` re-keyed to the work item it became. */
  const APPROVED: PlanReviewItemDto[] = [
    under({
      planItemId: 'pi_story',
      nodeId: NEW_STORY_ID,
      identifier: 'MOTIR-500',
      kind: 'story',
      title: 'The new story',
      hasChildren: true,
      status: 'todo',
    }),
    under({
      planItemId: 'pi_a',
      nodeId: CHILD_A,
      identifier: 'MOTIR-501',
      parentNodeId: NEW_STORY_ID,
      title: 'The first subtask',
      status: 'todo',
    }),
    under({
      planItemId: 'pi_b',
      nodeId: CHILD_B,
      identifier: 'MOTIR-502',
      parentNodeId: NEW_STORY_ID,
      title: 'The second subtask',
      status: 'todo',
    }),
  ];

  function mountPending() {
    return render(
      <PlanReviewCanvas items={PENDING} projectKey="MOTIR" version={0} outcome={null} />,
    );
  }

  /** What `PlanDetail` does on approve: refetch → new items + a version bump.
   *  A RE-RENDER of the mounted canvas — never a remount, which is the whole
   *  point (`PlanDetail` mounts `PlanReviewCanvas` with no `key`). */
  function approve(view: ReturnType<typeof mountPending>) {
    materialized = true;
    view.rerender(
      <PlanReviewCanvas items={APPROVED} projectKey="MOTIR" version={1} outcome="accepted" />,
    );
  }

  beforeEach(() => {
    materialized = false;
    approveStub();
  });

  it('draws the MATERIALIZED children on the level the reviewer was already on', async () => {
    const view = mountPending();
    // Arrival: drilled into the proposed story, its proposed subtasks on screen.
    expect(await screen.findByText('The first subtask')).toBeTruthy();
    expect(screen.getByText('The second subtask')).toBeTruthy();

    approve(view);

    // The same level, now holding the real cards — the RECORD Part VI says this
    // pane becomes after a decision, not an empty room.
    expect(await screen.findByText('MOTIR-501')).toBeTruthy();
    expect(screen.getByText('MOTIR-502')).toBeTruthy();
    expect(screen.queryByText('No items at this level')).toBeNull();
  });

  it('re-labels the proposed crumb with the KEY the container now has', async () => {
    const view = mountPending();
    const nav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
    // `New · <title>` is right ONLY while the container has no key — a
    // placeholder would assert a work item that does not exist (Part IX §1.3).
    expect(within(nav()).getByText('New · The new story')).toBeTruthy();

    approve(view);

    // It has one now, so the crumb reads like every other committed crumb.
    await screen.findByText('MOTIR-501');
    expect(within(nav()).getByText('MOTIR-500 · The new story')).toBeTruthy();
    expect(within(nav()).queryByText('New · The new story')).toBeNull();
  });

  it('leaves every crumb NAVIGABLE — a crumb click loads a level, not a dead id', async () => {
    const view = mountPending();
    await screen.findByText('The first subtask');
    approve(view);
    await screen.findByText('MOTIR-501');

    const nav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
    // Up to the committed parent, which now holds the story that was created…
    fireEvent.click(within(nav()).getByText('MOTIR-2200 · The Motir agent loop'));
    expect(await screen.findByText('MOTIR-500')).toBeTruthy();

    // …and back down into it, by the ordinary drill. A crumb still carrying the
    // PlanItem id would have re-loaded the same empty level instead.
    selectNode(NEW_STORY_ID);
    fireEvent.click(within(el(NEW_STORY_ID) as HTMLElement).getByTestId('drill-button'));
    expect(await screen.findByText('MOTIR-501')).toBeTruthy();
  });

  it('does NOT move a reviewer who climbed AWAY from the arrival level before approving', async () => {
    // The control that rules out "remount the canvas at approve": re-arriving
    // would yank this reviewer back down to the story's level, and where the
    // canvas sits is the user's, not the plan's (`initialTrail` is a seed).
    const view = mountPending();
    await screen.findByText('The first subtask');

    const nav = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
    fireEvent.click(within(nav()).getByText('MOTIR-2200 · The Motir agent loop'));
    await waitFor(() => expect(screen.queryByText('The first subtask')).toBeNull());

    approve(view);

    // Still on the parent's level: the story it gained is here, its subtasks are
    // one drill away, and the breadcrumb has not regrown a crumb below this one.
    expect(await screen.findByText('MOTIR-500')).toBeTruthy();
    expect(screen.queryByText('MOTIR-501')).toBeNull();
    expect(within(nav()).queryByText('MOTIR-500 · The new story')).toBeNull();
  });
});

// ── The LEVEL CAPTION — Part IX §1.4, on the one level that needs it (MOTIR-3453) ─
//
// Drilling into a proposed container asks the roadmap for the children of an id
// no work item has; the read resolves empty and the proposals render alone. That
// is correct, and it looks like nothing else on this surface — so the caption
// says why, or an empty-looking canvas reads as a failed load. The behaviour
// shipped with MOTIR-3260; the sentence explaining it did not.
describe('PlanReviewCanvas — the caption on an ENTIRELY proposed level (bug MOTIR-3453)', () => {
  const CAPTION = "Nothing committed here yet — every item on this level is this plan's";

  beforeEach(() => {
    stubRoadmap();
  });

  /** A story proposed under the committed bug, with two subtasks under IT. */
  function planWithProposedContainer(): PlanReviewItemDto[] {
    return [
      proposal({
        planItemId: 'pi_story',
        nodeId: 'pi_story',
        kind: 'story',
        title: 'A proposed story',
        hasChildren: true,
      }),
      proposal({
        planItemId: 'pi_a',
        nodeId: 'pi_a',
        parentNodeId: 'pi_story',
        title: 'Proposed child one',
      }),
      proposal({
        planItemId: 'pi_b',
        nodeId: 'pi_b',
        parentNodeId: 'pi_story',
        title: 'Proposed child two',
      }),
    ];
  }

  it('CAPTIONS the level when every card on it is the plan’s', async () => {
    // `arrivalLevel` opens on the proposed story — the level it most fills — so
    // this is the arrival, not a hand-drilled corner case.
    mount(planWithProposedContainer());
    await screen.findByText('Proposed child one');

    expect(screen.getByTestId('level-caption').textContent).toBe(CAPTION);
  });

  it('says NOTHING on a level that also holds committed cards', async () => {
    // The default fixture: one proposal beside MOTIR-7 and MOTIR-9. The level is
    // not "all this plan's", and the sentence would be false.
    mount();
    await screen.findByText('A proposed subtask');
    expect(screen.getByText('MOTIR-7')).toBeTruthy();

    expect(screen.queryByTestId('level-caption')).toBeNull();
  });

  it('says NOTHING on a purely committed level the reviewer drills to', async () => {
    mount();
    await screen.findByText('MOTIR-7');
    selectNode(STORY_ID);
    fireEvent.click(within(el(STORY_ID) as HTMLElement).getByTestId('drill-button'));
    await screen.findByText('MOTIR-3083');

    expect(screen.queryByTestId('level-caption')).toBeNull();
  });

  it('is NOT the empty state — the caption and "No items at this level" never coexist', async () => {
    // The two must not be confused. `emptyDrilled` speaks for a level with
    // NOTHING on it; the caption speaks for a level that HAS cards and needs
    // them explained. On the level this card is about, exactly one of them is on
    // screen — and it is the one whose statement is true.
    mount(planWithProposedContainer());
    await screen.findByText('Proposed child one');

    expect(screen.getByTestId('level-caption')).toBeTruthy();
    expect(screen.queryByText('No items at this level')).toBeNull();
  });

  it('STOPS captioning once the plan is approved — the cards are committed now', async () => {
    // No second rule does this: the roadmap read returns the materialized cards,
    // so the level is no longer all-proposed and the sentence stops being true at
    // the same moment it stops being sayable.
    const view = mount(planWithProposedContainer());
    await screen.findByText('Proposed child one');
    expect(screen.getByTestId('level-caption')).toBeTruthy();

    // Approve: the story became MOTIR-7's committed neighbour STORY_ID, whose
    // level the stub already serves (one committed child, MOTIR-3083).
    view.rerender(
      <PlanReviewCanvas
        items={[
          proposal({
            planItemId: 'pi_story',
            nodeId: STORY_ID,
            identifier: 'MOTIR-7',
            kind: 'story',
            title: 'A proposed story',
            hasChildren: true,
          }),
          proposal({
            planItemId: 'pi_a',
            nodeId: LEAF_ID,
            identifier: 'MOTIR-3083',
            parentNodeId: STORY_ID,
            title: 'Proposed child one',
          }),
        ]}
        projectKey="MOTIR"
        version={1}
        outcome="accepted"
      />,
    );

    expect(await screen.findByText('MOTIR-3083')).toBeTruthy();
    expect(screen.queryByTestId('level-caption')).toBeNull();
  });
});

// ── bug MOTIR-4952 — a blocker the plan MOVES ONTO the level ─────────────────
//
// The CONSUMER half. `plan-item-node.test.tsx` holds the builder's own contract;
// this asserts the wiring, because the option is inert until `PlanReviewCanvas`
// answers the question — and an unwired option is a green unit suite over a
// surface that still draws the tangle.
//
// The committed level's read says the blocker is somewhere else, because at read
// time it is: the plan has not been approved. So the level arrived with the whole
// cross-story treatment — the red flag over the arrow's midpoint, the dependent's
// "blocked elsewhere" ring, and a ghost anchor — asserting a tangle about the one
// plan whose purpose is to remove it.
describe('PlanReviewCanvas — a blocker the plan RELOCATES onto the level (bug MOTIR-4952)', () => {
  const OFF_ID = 'wi_off_level';

  /** The same tree, with MOTIR-7 blocked by a card that lives on another level. */
  function stubWithOffLevelBlocker() {
    const levels: Record<string, unknown> = {
      ...WIRE_LEVELS,
      [BUG_ID]: {
        nodes: [
          wireNode({
            id: STORY_ID,
            parentId: BUG_ID,
            kind: 'story',
            identifier: 'MOTIR-7',
            title: 'AI planning layer',
            status: 'in_review',
            hasChildren: true,
          }),
        ],
        edges: [{ blockedId: STORY_ID, blockerId: OFF_ID }],
        offLevelBlockers: [
          {
            id: OFF_ID,
            identifier: 'MOTIR-99',
            title: 'The blocker the plan moves in',
            parentTitle: 'Another story',
            isDone: false,
          },
        ],
      },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/work-items/peek') {
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }
      const parentId = url.searchParams.get('parentId') ?? '__root__';
      const body = levels[parentId] ?? { nodes: [], edges: [], offLevelBlockers: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /** The `modify` that re-parents the off-level blocker onto this level. */
  function relocation(): PlanReviewItemDto {
    return proposal({
      planItemId: 'pi_reloc',
      nodeId: OFF_ID,
      op: 'modify',
      identifier: 'MOTIR-99',
      title: 'The blocker the plan moves in',
      parentNodeId: BUG_ID,
      status: 'todo',
      proposal: {
        op: 'modify',
        identifier: 'MOTIR-99',
        changedFields: [],
        settableRailFields: [],
        todos: null,
      },
    });
  }

  beforeEach(() => {
    stubWithOffLevelBlocker();
  });

  it('draws no tangle about a card it puts right beside the dependent', async () => {
    render(
      <PlanReviewCanvas items={[relocation()]} projectKey="MOTIR" version={0} outcome={null} />,
    );
    await screen.findByText('The blocker the plan moves in');

    // Both cards on the level, and the arrow between them in the ordinary
    // within-level language — no red flag at its midpoint.
    expect(el(STORY_ID)).toBeTruthy();
    expect(el(OFF_ID)).toBeTruthy();
    expect(screen.queryAllByTestId('cross-flag')).toHaveLength(0);
    // …and the dependent is not wearing the off-level ring either.
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();
  });

  it('still draws it for a blocker the plan leaves where it is', async () => {
    // The control: the same level, the same committed edge, a plan that proposes
    // something else entirely. Nothing about the cross-story treatment changes —
    // the narrowing is keyed on the blocker being a proposal AT THIS LEVEL.
    render(<PlanReviewCanvas items={[proposal()]} projectKey="MOTIR" version={0} outcome={null} />);
    await screen.findByText('A proposed subtask');

    expect(screen.queryAllByTestId('cross-flag')).toHaveLength(1);
    expect(screen.getByTestId('cross-blocked-flag')).toBeTruthy();
  });
});

// ── bug MOTIR-5387 — a proposal blocked by a card OFF the level ──────────────
//
// The CONSUMER half: `plan-item-node.test.tsx` holds the merge's contract, and
// this asserts what reaches the screen through the real `loadLevel` — the red
// flag at the arrow, the dependent's chip, and an anchor whose View opens the
// blocker BY ITS KEY. That last one only works because the canvas learns the key
// from the review model: no level read carries a blocker a proposal names.
describe('PlanReviewCanvas — a proposal blocked by a card OFF the level (bug MOTIR-5387)', () => {
  const OFF_ID = 'wi_other_story_card';

  function blockedElsewhere(): PlanReviewItemDto {
    return proposal({
      blockedByNodeIds: [OFF_ID],
      blockerStubs: [
        {
          nodeId: OFF_ID,
          identifier: 'MOTIR-99',
          title: 'A card under another story',
          isDone: false,
          parentNodeId: 'wi_another_story',
        },
      ],
    });
  }

  it('draws the off-level treatment BEFORE approve — flag, chip and a named anchor', async () => {
    stubRoadmap();
    mount([blockedElsewhere()]);
    await screen.findByText('A proposed subtask');

    expect(screen.queryAllByTestId('cross-flag')).toHaveLength(1);
    expect(within(el('pi_1') as HTMLElement).getByTestId('cross-blocked-flag')).toBeTruthy();
    expect(within(el(OFF_ID) as HTMLElement).getByText('MOTIR-99')).toBeTruthy();
    expect(within(el(OFF_ID) as HTMLElement).getByText('A card under another story')).toBeTruthy();
  });

  it('peeks the anchor by the blocker’s KEY, not by its canvas node id', async () => {
    const fetchMock = stubRoadmap();
    mount([blockedElsewhere()]);
    await screen.findByText('MOTIR-99');

    selectNode(OFF_ID);
    fireEvent.click(within(el(OFF_ID) as HTMLElement).getByTestId('view-button'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('/api/work-items/peek?key=MOTIR-99')),
      ).toBe(true),
    );
  });

  it('draws none of it for a blocker ON the level', async () => {
    stubRoadmap();
    mount([
      proposal({
        blockedByNodeIds: [SUB_ID],
        blockerStubs: [
          {
            nodeId: SUB_ID,
            identifier: 'MOTIR-9',
            title: 'The starter template',
            isDone: false,
            parentNodeId: BUG_ID,
          },
        ],
      }),
    ]);
    await screen.findByText('A proposed subtask');

    expect(screen.queryAllByTestId('cross-flag')).toHaveLength(0);
    expect(screen.queryByTestId('cross-blocked-flag')).toBeNull();
  });
});
