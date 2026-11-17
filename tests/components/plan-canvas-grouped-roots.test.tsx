// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { planReviewItem } from '../helpers/planReview';

// MOTIR-4771 — the "Not in an epic" group on the two planning canvases.
//
// MOTIR-3490 gave the ROOT level a grouped node and a truncation tile, and wired
// them in as an OPT-IN OPTION on the shared `buildWorkItemLevel`. Four of its
// five call sites never opted in, and the overlay — the surface a reader does
// their PLANNING on — was one of them: it kept drawing the pre-MOTIR-3490 level,
// with every parentless defect scattered through the loose band and no tile to
// say the 200-row cap had dropped the newest epics.
//
// `design/ai-planning/design-notes.md` Part XVI (MOTIR-4773) rules on the part
// the roadmap never had to answer — what a level does with a row the PENDING
// PROPOSAL touches — and its DECISION 2 is what these cases pin:
//
//     parentId === null && kind !== 'epic' && !touchedByThisProposal(id)
//
// The third conjunct is not a preference. Grouping takes rows OUT of the
// committed level before `mergePlanLevel` runs, and a MATERIALIZED `add` carries
// its committed work item's OWN id — so grouping that row stops the add landing
// on it, and the accepted card is appended a second time as a keyless ghost.
// That is bug MOTIR-3206, re-created by passing one boolean.
//
// ⚠️ WHICH STATE HOLDS WHICH HALF (MOTIR-6299 · MOTIR-11513). The surface's pane
// is `PlanReviewCanvas` (through `PlanProposalViews`) before a plan and after it.
// Its "no plan" state (`prePlan`) keeps DECISION 1 and the tile; with a plan,
// DECISION 2's cases — a row the plan touches stays on the road — apply, below.
// Until MOTIR-11513 the "no plan" state was a component of its own.

/** The overlay's canvas before a plan exists (MOTIR-11513). */
const NO_TARGETS = { targetIds: [] as readonly string[] };

const EPIC_ID = 'wi_epic';
const BUG_A = 'wi_bug_a';
const BUG_B = 'wi_bug_b';
const STORY_ROOT = 'wi_story_root';

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

const ROOT_ROWS = [
  wireNode({
    id: EPIC_ID,
    kind: 'epic',
    identifier: 'MOTIR-2200',
    title: 'The Motir agent loop',
    hasChildren: true,
  }),
  wireNode({ id: BUG_A, kind: 'bug', identifier: 'MOTIR-3490', title: 'The roadmap root level' }),
  wireNode({ id: BUG_B, kind: 'bug', identifier: 'MOTIR-4501', title: 'Show all is inert' }),
  wireNode({ id: STORY_ROOT, kind: 'story', identifier: 'MOTIR-4725', title: 'The overlay' }),
];

/** The `all` flags the component asked the read for, in call order. */
let allFlags: string[] = [];
/** What the ROOT read reports as the level's untruncated size, or undefined. */
let rootLevelTotal: number | undefined;

function stubRoadmap() {
  allFlags = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/work-items/peek') {
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }
      const parentId = url.searchParams.get('parentId') ?? '__root__';
      if (parentId === '__root__') allFlags.push(url.searchParams.get('all') ?? '-');
      const body =
        parentId === '__root__'
          ? {
              nodes: ROOT_ROWS,
              edges: [],
              offLevelBlockers: [],
              ...(rootLevelTotal === undefined ? {} : { levelTotal: rootLevelTotal }),
            }
          : { nodes: [], edges: [], offLevelBlockers: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }),
  );
}

function el(id: string) {
  return document.querySelector(`[data-node-id="${id}"]`);
}

function drill(id: string) {
  fireEvent.keyDown(el(id)!, { key: 'Enter' });
  fireEvent.click(within(el(id) as HTMLElement).getByTestId('drill-button'));
}

/** Every node the canvas currently draws, by its work-item / synthetic id. */
function drawnIds(): string[] {
  return [...document.querySelectorAll('[data-node-id]')].map(
    (n) => n.getAttribute('data-node-id') ?? '',
  );
}

function root(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
  return planReviewItem({ parentNodeId: null, kind: 'bug', ...over });
}

beforeEach(() => {
  rootLevelTotal = undefined;
  stubRoadmap();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the planning workspace overlay groups the roots that are in no epic', () => {
  it('draws the epics plus ONE grouped node — no bug / story / task beside them (DECISION 1)', async () => {
    render(<PlanReviewCanvas items={[]} projectKey="MOTIR" version={0} prePlan={NO_TARGETS} />);

    // The epic is on the road…
    await waitFor(() => expect(el(EPIC_ID)).not.toBeNull());
    // …and the three parentless non-epic rows are NOT.
    expect(el(BUG_A)).toBeNull();
    expect(el(BUG_B)).toBeNull();
    expect(el(STORY_ROOT)).toBeNull();

    const group = screen.getByTestId('level-group-node');
    expect(group.textContent).toContain('Not in an epic');
    expect(group.textContent).toContain('3 items');
  });

  it('the grouped node DRILLS IN from the overlay, drawn from the root’s rows (criterion 2)', async () => {
    render(<PlanReviewCanvas items={[]} projectKey="MOTIR" version={0} prePlan={NO_TARGETS} />);
    await waitFor(() => expect(screen.getByTestId('level-group-node')).toBeTruthy());

    drill('__not_in_an_epic__');

    await waitFor(() => expect(el(BUG_A)).not.toBeNull());
    expect(el(BUG_B)).not.toBeNull();
    expect(el(STORY_ROOT)).not.toBeNull();
    // The epic is not on the grouped level, and neither is a ghost anchor for it
    // (bug MOTIR-3557: the root's whole edge list handed over would redraw every
    // root epic as an anonymous "blocked elsewhere" node).
    expect(el(EPIC_ID)).toBeNull();
    // The group is the ROOT's rows, re-read (MOTIR-11513): the shared canvas keeps
    // no level cache, so the door reads the root again rather than reading one
    // back, at the same cap — the MOTIR-4426 property holds by construction.
    expect(allFlags).toEqual(['-', '-']);
  });

  it('draws the truncation tile, and Show all re-reads THIS level uncapped (criterion 4)', async () => {
    rootLevelTotal = 12;
    render(<PlanReviewCanvas items={[]} projectKey="MOTIR" version={0} prePlan={NO_TARGETS} />);

    const tile = await screen.findByTestId('level-truncation-tile');
    expect(tile.textContent).toContain('+ 8 more');
    expect(tile.textContent).toContain('Showing 4 of 12');

    fireEvent.keyDown(el('__level_more__')!, { key: 'Enter' });

    // The activation names the level the reader is STANDING ON (bug MOTIR-4501),
    // and that level is re-read with the ceiling raised.
    await waitFor(() => expect(allFlags).toEqual(['-', '1']));
  });
});

describe('the plan review canvas — a row the plan TOUCHES stays on the road (DECISION 2 / 5)', () => {
  it('groups the non-epic roots, and keeps the plan’s own target on the road', async () => {
    const items = [
      root({
        planItemId: 'pi_mod',
        op: 'modify',
        nodeId: BUG_B,
        identifier: 'MOTIR-4501',
        title: 'Show all is inert',
        changes: [{ field: 'priority', from: 'medium', to: 'high' }],
      }),
    ];

    render(<PlanReviewCanvas items={items} projectKey="MOTIR" version={1} />);

    // The plan's target stays where the reviewer can act on it. Grouping it would
    // not merely hide the frame: `mergePlanLevel` re-appends a proposal whose
    // target is not at this level as a standalone node, which reads as a DRIFTED
    // plan — a false statement about the plan, on the surface it is approved from.
    await waitFor(() => expect(el(BUG_B)).not.toBeNull());
    expect(el(EPIC_ID)).not.toBeNull();
    expect(el(BUG_A)).toBeNull();
    expect(el(STORY_ROOT)).toBeNull();
    expect(screen.getByTestId('level-group-node').textContent).toContain('2 items');
  });

  it('an ACCEPTED add is drawn ONCE, not twice — the MOTIR-3206 constraint', async () => {
    // A MATERIALIZED add: the plan was approved, the proposal became a card, and
    // its `nodeId` is now that card's own id. Group the committed row away and
    // `mergePlanLevel` cannot land the add on it, so it is appended as a second,
    // standalone node. The third conjunct is what stops it.
    const items = [
      root({
        planItemId: 'pi_add',
        op: 'add',
        nodeId: BUG_A,
        identifier: 'MOTIR-3490',
        title: 'The roadmap root level',
        status: 'todo',
      }),
    ];

    render(<PlanReviewCanvas items={items} projectKey="MOTIR" version={1} outcome="accepted" />);

    await waitFor(() => expect(el(BUG_A)).not.toBeNull());
    // ONE node for it, and it is the committed card.
    expect(drawnIds().filter((id) => id === BUG_A)).toHaveLength(1);
    expect(el(BUG_B)).toBeNull();
    expect(el(STORY_ROOT)).toBeNull();
    expect(screen.getByTestId('level-group-node').textContent).toContain('2 items');
  });

  it('keeps the anchor a pending add is parented on, on the road too', async () => {
    // The commonest contextual ask — "break this story into subtasks" — touches
    // its anchor through NOTHING but the parent ref its add carries. Group the
    // anchor away and the proposal is UNREACHABLE: it is drawn one level down,
    // under a row that has moved behind the group's door. That is the E2E
    // `cloud-contextual-plan-confirm` drills.
    const items = [
      planReviewItem({
        planItemId: 'pi_toasts',
        op: 'add',
        nodeId: 'pi_toasts',
        kind: 'subtask',
        title: 'In-app toasts',
        parentNodeId: STORY_ROOT,
      }),
    ];

    render(<PlanReviewCanvas items={items} projectKey="MOTIR" version={1} />);

    await waitFor(() => expect(el(STORY_ROOT)).not.toBeNull());
    expect(el(EPIC_ID)).not.toBeNull();
    expect(el(BUG_A)).toBeNull();
    expect(el(BUG_B)).toBeNull();
    expect(screen.getByTestId('level-group-node').textContent).toContain('2 items');
  });
});
