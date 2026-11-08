// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { buildWorkItemLevel, NOT_IN_EPIC_ID } from '@/components/planning/workItemLevel';
import type { RoadmapLevelData, RoadmapLevelItem } from '@/lib/planning/roadmapClient';
import { ProjectRoadmapCanvas } from '@/components/planning/ProjectRoadmapCanvas';

// The roadmap LEVEL → canvas-node adapter, focused on the Subtask 7.20.6 /
// MOTIR-1013 markers it adds for the persistent roadmap: the planning-origin
// cluster at the road's start, the "you are here" current-position marker, and
// the per-container progress meter passed through to each node. (The cross-story
// ghost-anchor behaviour is covered by WorkItemRoadmap.test.) No jest-dom — plain
// vitest assertions + getAttribute.

afterEach(() => cleanup());

// The default workflow's status → category map — the wire carries both, and the
// "you are here" pick reads the CATEGORY (MOTIR-10622), so a fixture that names
// only a status key gets the category the server would send beside it. A test
// that needs a custom status (or an unknown category) passes `statusCategory`.
const DEFAULT_CATEGORY: Record<string, RoadmapLevelItem['statusCategory']> = {
  todo: 'todo',
  blocked: 'todo',
  in_progress: 'in_progress',
  implemented: 'in_progress',
  planning: 'in_progress',
  in_review: 'in_progress',
  approved: 'in_progress',
  done: 'done',
  cancelled: 'done',
};

function item(over: Partial<RoadmapLevelItem> & { id: string }): RoadmapLevelItem {
  const status = over.status ?? 'todo';
  return {
    parentId: null,
    identifier: over.id,
    title: `Title ${over.id}`,
    kind: 'epic',
    status,
    statusCategory: DEFAULT_CATEGORY[status] ?? null,
    hasChildren: false,
    progress: null,
    ...over,
  };
}

function level(items: RoadmapLevelItem[]): RoadmapLevelData {
  return { items, edges: [], offLevelBlockers: [] };
}

const ORIGIN_ID = '__planning_origin__';

describe('buildWorkItemLevel — roadmap markers (MOTIR-1013)', () => {
  it('pins the planning-origin cluster LEFT of the epics when includeOrigin + items exist', () => {
    const { nodes } = buildWorkItemLevel(level([item({ id: 'E1', hasChildren: true })]), {
      includeOrigin: true,
    });
    const origin = nodes.find((n) => n.id === ORIGIN_ID);
    expect(origin).toBeTruthy();
    // Fixed-position (excluded from the auto-layout) and LEFT of the layout origin
    // so the road reads from its completed-planning start.
    expect(origin!.x).toBeLessThan(0);
    // It renders the 7.3 stages as milestones.
    render(<>{origin!.content}</>);
    expect(screen.getByTestId('planning-origin')).toBeTruthy();
    expect(screen.getByText('Idea')).toBeTruthy();
    expect(screen.getByText('Plan')).toBeTruthy();
  });

  // MOTIR-2205 — the card became a DOOR. `drillable` flipped; `decorative` did NOT,
  // and the pair of them is the whole point (see the auto-descend test below).
  it('makes the origin node DRILLABLE, still DECORATIVE, and never viewable', () => {
    const { nodes } = buildWorkItemLevel(level([item({ id: 'E1', hasChildren: true })]), {
      includeOrigin: true,
      originCrumbLabel: 'Planning',
    });
    const origin = nodes.find((n) => n.id === ORIGIN_ID)!;
    expect(origin.drillable).toBe(true);
    expect(origin.decorative).toBe(true);
    // No detail peek of its own — its detail IS the level below it.
    expect(origin.viewable).toBeFalsy();
    // The breadcrumb crumb the drill pushes (localized copy, supplied by the consumer).
    expect(origin.crumbLabel).toBe('Planning');
  });

  it('omits the origin without includeOrigin, or when the level has no items', () => {
    expect(
      buildWorkItemLevel(level([item({ id: 'E1' })])).nodes.some((n) => n.id === ORIGIN_ID),
    ).toBe(false);
    expect(
      buildWorkItemLevel(level([]), { includeOrigin: true }).nodes.some((n) => n.id === ORIGIN_ID),
    ).toBe(false);
  });

  it('marks the FIRST in-progress item "you are here" when markActive', () => {
    const { nodes } = buildWorkItemLevel(
      level([
        item({ id: 'E1', status: 'done' }),
        item({ id: 'E2', status: 'in_progress' }),
        item({ id: 'E3', status: 'in_progress' }), // a later in-progress is NOT the marker
      ]),
      { markActive: true },
    );
    const byId = new Map(nodes.map((n) => [n.id, n]));
    render(<>{byId.get('E2')!.content}</>);
    expect(screen.getByText('You are here')).toBeTruthy();
    cleanup();
    render(<>{byId.get('E3')!.content}</>);
    expect(screen.queryByText('You are here')).toBeNull();
  });

  // Bug MOTIR-10454 — the tag follows the level's BLOCKER order, not its key order.
  // The reproduction from the card: key order 10449 (implemented), 10450, 10451,
  // 10452 (in progress); 10451 blocks 10450, so 10451 sits a column LEFT of it.
  describe('"you are here" follows the blocker order (MOTIR-10454)', () => {
    function hereIds(data: RoadmapLevelData): string[] {
      return buildWorkItemLevel(data, { markActive: true })
        .nodes.filter((n) => n.here)
        .map((n) => n.id);
    }
    const edge = (blockerId: string, blockedId: string) => ({ blockerId, blockedId });

    it('tags the in-progress card EARLIEST along the blocker chain, not the lowest key', () => {
      // The card's reproduction had 10449 at `implemented`; since MOTIR-10622 that
      // status is a candidate too and, at depth 0, would take the tag itself. It is
      // `done` here so the case keeps measuring what it was written for — the order
      // among the in-progress cards — and the implemented-blocker case is below.
      const data: RoadmapLevelData = {
        items: [
          item({ id: '10449', kind: 'subtask', status: 'done' }),
          item({ id: '10450', kind: 'subtask', status: 'in_progress' }),
          item({ id: '10451', kind: 'subtask', status: 'in_progress' }),
          item({ id: '10452', kind: 'subtask', status: 'in_progress' }),
        ],
        edges: [
          edge('10449', '10451'),
          edge('10449', '10450'),
          edge('10451', '10450'),
          edge('10450', '10452'),
          edge('10451', '10452'),
        ],
        offLevelBlockers: [],
      };
      expect(hereIds(data)).toEqual(['10451']);
    });

    it("takes a card's depth from its LONGEST blocker route, not its direct edge", () => {
      // C has a direct edge from F (depth 1 by the shortest route) AND the chain
      // F → M → N → C (depth 3). Y is one step from F. By the shortest route C and
      // Y would tie and C would win on read order; by the longest, Y is earlier.
      const data: RoadmapLevelData = {
        items: [
          item({ id: 'F', kind: 'subtask', status: 'done' }),
          item({ id: 'C', kind: 'subtask', status: 'in_progress' }),
          item({ id: 'M', kind: 'subtask', status: 'done' }),
          item({ id: 'N', kind: 'subtask', status: 'implemented' }),
          item({ id: 'Y', kind: 'subtask', status: 'in_progress' }),
        ],
        edges: [edge('F', 'C'), edge('F', 'M'), edge('M', 'N'), edge('N', 'C'), edge('F', 'Y')],
        offLevelBlockers: [],
      };
      expect(hereIds(data)).toEqual(['Y']);
    });

    it('keeps the read order between in-progress cards at EQUAL depth', () => {
      const data: RoadmapLevelData = {
        items: [
          item({ id: 'R', kind: 'subtask', status: 'done' }),
          item({ id: 'P', kind: 'subtask', status: 'in_progress' }),
          item({ id: 'Q', kind: 'subtask', status: 'in_progress' }),
        ],
        edges: [edge('R', 'P'), edge('R', 'Q')],
        offLevelBlockers: [],
      };
      expect(hereIds(data)).toEqual(['P']);
    });

    it('has no tag when nothing is in the in-progress category', () => {
      const data: RoadmapLevelData = {
        items: [
          item({ id: 'A', kind: 'subtask', status: 'done' }),
          item({ id: 'B', kind: 'subtask', status: 'todo' }),
        ],
        edges: [edge('A', 'B')],
        offLevelBlockers: [],
      };
      expect(hereIds(data)).toEqual([]);
    });

    it("survives a CYCLE among the level's edges and still yields at most one tag", () => {
      const data: RoadmapLevelData = {
        items: [
          item({ id: 'A', kind: 'subtask', status: 'in_progress' }),
          item({ id: 'B', kind: 'subtask', status: 'in_progress' }),
          item({ id: 'C', kind: 'subtask', status: 'in_progress' }),
        ],
        edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')],
        offLevelBlockers: [],
      };
      expect(() => hereIds(data)).not.toThrow();
      expect(hereIds(data)).toHaveLength(1);
    });

    it('does not let an OFF-level blocker move the tag — only edges on the level count', () => {
      // A waits on an off-level card X (drawn as an anchor); B is free. Neither has
      // an on-level blocker, so both sit at depth 0 and A keeps the read order.
      const data: RoadmapLevelData = {
        items: [
          item({ id: 'A', kind: 'subtask', status: 'in_progress' }),
          item({ id: 'B', kind: 'subtask', status: 'in_progress' }),
        ],
        edges: [edge('X', 'A')],
        offLevelBlockers: [
          { id: 'X', identifier: 'PROD-9', title: 'External dep', parentTitle: null },
        ],
      };
      expect(hereIds(data)).toEqual(['A']);
    });
  });

  // MOTIR-10599 made `planning` a "you are here" candidate beside `in_progress`;
  // MOTIR-10622 generalises it: EVERY status in the in-progress CATEGORY is one —
  // `implemented`, `in_review`, `approved` and a project's custom statuses too —
  // read from the category on the row, never from a list of keys.
  describe('"you are here" covers the whole in-progress category (MOTIR-10599, MOTIR-10622)', () => {
    function hereIds(data: RoadmapLevelData): string[] {
      return buildWorkItemLevel(data, { markActive: true })
        .nodes.filter((n) => n.here)
        .map((n) => n.id);
    }
    const edge = (blockerId: string, blockedId: string) => ({ blockerId, blockedId });

    it.each(['in_progress', 'planning', 'implemented', 'in_review', 'approved'])(
      'tags the only active card when it is in %s, and renders the pill',
      (status) => {
        const { nodes } = buildWorkItemLevel(
          level([
            item({ id: 'A', kind: 'task', status: 'done' }),
            item({ id: 'P', kind: 'task', status }),
            item({ id: 'T', kind: 'task', status: 'todo' }),
          ]),
          { markActive: true },
        );
        expect(nodes.filter((n) => n.here).map((n) => n.id)).toEqual(['P']);
        render(<>{nodes.find((n) => n.id === 'P')!.content}</>);
        expect(screen.getByText('You are here')).toBeTruthy();
      },
    );

    it('tags a CUSTOM status in the in-progress category', () => {
      expect(
        hereIds(
          level([
            item({ id: 'T', kind: 'task', status: 'todo' }),
            item({ id: 'Q', kind: 'task', status: 'qa_signoff', statusCategory: 'in_progress' }),
          ]),
        ),
      ).toEqual(['Q']);
    });

    it.each(['planning', 'in_review', 'implemented'])(
      'locates a %s card before the ready nodes',
      async (status) => {
        const { nodes, deps } = buildWorkItemLevel(
          level([
            item({ id: 'R', kind: 'task', status: 'todo', ready: true }),
            item({ id: 'P', kind: 'task', status }),
          ]),
          { markActive: true },
        );
        render(
          <ProjectRoadmapCanvas loadLevel={() => Promise.resolve({ nodes, deps })} locatable />,
        );
        await screen.findByText('Title P');
        fireEvent.click(screen.getByTestId('locate-button'));
        const highlighted = (id: string) =>
          document.querySelector(`[data-node-id="${id}"]`)!.querySelector('[data-highlighted]');
        expect(highlighted('P')).toBeTruthy();
        expect(highlighted('R')).toBeNull();
        // A single `here` target: no ready-node cycling hint.
        expect(screen.queryByTestId('locate-hint')).toBeNull();
      },
    );

    it('ranks planning and in-progress cards together by blocker depth', () => {
      // I (in progress) blocks P (planning): I is earlier and takes the tag even
      // though P comes first in read order.
      expect(
        hereIds({
          items: [
            item({ id: 'P', kind: 'subtask', status: 'planning' }),
            item({ id: 'I', kind: 'subtask', status: 'in_progress' }),
          ],
          edges: [edge('I', 'P')],
          offLevelBlockers: [],
        }),
      ).toEqual(['I']);
      // P (planning) blocks I (in progress): now P is earlier.
      expect(
        hereIds({
          items: [
            item({ id: 'I', kind: 'subtask', status: 'in_progress' }),
            item({ id: 'P', kind: 'subtask', status: 'planning' }),
          ],
          edges: [edge('P', 'I')],
          offLevelBlockers: [],
        }),
      ).toEqual(['P']);
    });

    it('ranks every in-progress-category status together, earliest along the blocker order', () => {
      // Read order puts the in-progress card first, but the in-review card blocks
      // the implemented one, which blocks the in-progress one: in review is earliest.
      expect(
        hereIds({
          items: [
            item({ id: 'I', kind: 'subtask', status: 'in_progress' }),
            item({ id: 'M', kind: 'subtask', status: 'implemented' }),
            item({ id: 'V', kind: 'subtask', status: 'in_review' }),
            item({ id: 'A', kind: 'subtask', status: 'approved' }),
          ],
          edges: [edge('V', 'M'), edge('M', 'I'), edge('M', 'A')],
          offLevelBlockers: [],
        }),
      ).toEqual(['V']);
      // An implemented card at the head of the chain takes the tag from the
      // in-progress cards it blocks (the MOTIR-10454 reproduction's shape).
      expect(
        hereIds({
          items: [
            item({ id: '10449', kind: 'subtask', status: 'implemented' }),
            item({ id: '10450', kind: 'subtask', status: 'in_progress' }),
            item({ id: '10451', kind: 'subtask', status: 'in_progress' }),
          ],
          edges: [edge('10449', '10451'), edge('10449', '10450'), edge('10451', '10450')],
          offLevelBlockers: [],
        }),
      ).toEqual(['10449']);
    });

    it('breaks an equal-depth tie across in-progress-category statuses by read order', () => {
      const data = (first: string, second: string): RoadmapLevelData => ({
        items: [
          item({ id: 'first', kind: 'subtask', status: first }),
          item({ id: 'second', kind: 'subtask', status: second }),
        ],
        edges: [],
        offLevelBlockers: [],
      });
      expect(hereIds(data('planning', 'in_progress'))).toEqual(['first']);
      expect(hereIds(data('in_progress', 'planning'))).toEqual(['first']);
      expect(hereIds(data('in_review', 'in_progress'))).toEqual(['first']);
      expect(hereIds(data('approved', 'implemented'))).toEqual(['first']);
    });

    it.each(['todo', 'blocked', 'done', 'cancelled'])('never tags a card in %s', (status) => {
      expect(hereIds(level([item({ id: 'X', kind: 'task', status })]))).toEqual([]);
    });

    it('never tags a row whose status category is unknown', () => {
      expect(
        hereIds(
          level([
            item({ id: 'X', kind: 'task', status: 'in_progress', statusCategory: null }),
            item({ id: 'Y', kind: 'task', status: 'mystery', statusCategory: undefined }),
          ]),
        ),
      ).toEqual([]);
    });
  });

  it('does NOT mark "you are here" without markActive (e.g. onboarding)', () => {
    const { nodes } = buildWorkItemLevel(level([item({ id: 'E1', status: 'in_progress' })]));
    render(<>{nodes[0]!.content}</>);
    expect(screen.queryByText('You are here')).toBeNull();
  });

  it('passes a container progress roll-up through to its node meter', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'E1', kind: 'epic', hasChildren: true, progress: { done: 3, total: 4 } })]),
    );
    render(<>{nodes[0]!.content}</>);
    expect(screen.getByTestId('progress-meter')).toBeTruthy();
    expect(screen.getByText('3 / 4')).toBeTruthy();
  });
});

// The off-level dependency signal (MOTIR-1331 cross-story tangle; MOTIR-1379
// sprint validity). In PROJECT scope an off-level blocker is always the bad-plan
// tangle, flagged "blocked elsewhere" (MOTIR-1568 — the label is level-agnostic,
// since one pill can't name a mix of story/epic/bug parents). In SPRINT scope it
// becomes a sprint-validity signal: a DONE or IN-sprint blocker is satisfied (not
// drawn), and only an out-of-sprint, NOT-done blocker is flagged — as "blocker not
// in sprint" (MOTIR-1582: the flag names the out-of-sprint BLOCKER, not the card,
// which IS an in-sprint member — distinct from the neutral "not in sprint"
// membership tag), not "blocked elsewhere".
function levelWithOffBlocker(stub: {
  isDone?: boolean;
  inActiveSprint?: boolean;
}): RoadmapLevelData {
  return {
    items: [item({ id: 'A1', kind: 'subtask' })],
    edges: [{ blockedId: 'A1', blockerId: 'X' }],
    offLevelBlockers: [
      { id: 'X', identifier: 'PROD-9', title: 'External dep', parentTitle: 'Story Z', ...stub },
    ],
  };
}
// The flag's NAME is its sentence; the committed card shows the short `blocked`
// label (MOTIR-10508), so the assertions read `aria-label`, not the text.
const A1_FLAG = 'cross-blocked-flag';

describe('buildWorkItemLevel — off-level dependency signal', () => {
  it('PROJECT scope: an off-level blocker is the bad-plan tangle (red edge + anchor + "blocked elsewhere" flag)', () => {
    const { nodes, deps } = buildWorkItemLevel(levelWithOffBlocker({ isDone: false }));
    expect(deps).toContainEqual({ from: 'X', to: 'A1', variant: 'cross' });
    expect(nodes.some((n) => n.id === 'X')).toBe(true); // ghost anchor
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).getAttribute('aria-label')).toContain('blocked elsewhere');
  });

  it('the ghost anchor is VIEWABLE so the off-level blocker is peekable (MOTIR-1586)', () => {
    // The off-level blocker is a real, peekable work item — its anchor offers the
    // View affordance (`viewable`), exactly like any other work-item node, so the
    // roadmap can peek "blocked by something elsewhere". Opening is via the View
    // button on select (not a bare click), consistent with every card.
    const { nodes } = buildWorkItemLevel(levelWithOffBlocker({ isDone: false }));
    const anchor = nodes.find((n) => n.id === 'X');
    expect(anchor).toBeTruthy();
    expect(anchor!.viewable).toBe(true);
  });

  it('SPRINT scope: an out-of-sprint, NOT-done blocker is flagged "blocker not in sprint"', () => {
    const { nodes, deps } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: false }),
      { scope: 'sprint' },
    );
    expect(deps).toContainEqual({ from: 'X', to: 'A1', variant: 'cross' });
    const anchor = nodes.find((n) => n.id === 'X');
    expect(anchor).toBeTruthy();
    render(<>{anchor!.content}</>);
    expect(screen.getByText(/not in this sprint/)).toBeTruthy();
    cleanup();
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    // MOTIR-1582: the red flag names the BLOCKER, not the card. The distinguishing
    // "blocker" token must be present — the bare "not in sprint" membership string
    // (the buggy reuse) would fail this.
    expect(screen.getByTestId(A1_FLAG).getAttribute('aria-label')).toContain(
      'blocker not in sprint',
    );
  });

  it('SPRINT scope: a DONE off-level blocker is satisfied — no edge, no anchor, no flag', () => {
    const { nodes, deps } = buildWorkItemLevel(levelWithOffBlocker({ isDone: true }), {
      scope: 'sprint',
    });
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'X')).toBe(false);
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });

  it('SPRINT scope: an IN-sprint off-level blocker is satisfied — no edge, no anchor, no flag', () => {
    const { nodes, deps } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: true }),
      { scope: 'sprint' },
    );
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'X')).toBe(false);
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });

  it('an off-level blocker with NO stub still anchors, named by its bare id', () => {
    // The stub list is best-effort: a blocker the read could not resolve still gets
    // an anchor, so the edge never dangles — it just has nothing but an id to say.
    const { nodes } = buildWorkItemLevel({
      items: [item({ id: 'A1', kind: 'subtask' })],
      edges: [{ blockedId: 'A1', blockerId: 'X' }],
      offLevelBlockers: [],
    });
    const anchor = nodes.find((n) => n.id === 'X')!;
    expect(anchor.searchText).toBe('X');
    expect(anchor.crumbLabel).toBeUndefined();
  });

  it('SPRINT scope: an UNRESOLVED off-level blocker is treated as satisfied', () => {
    // Nothing is known about it, so there is nothing to flag as out-of-sprint —
    // the sprint-validity signal only fires on a blocker it can actually judge.
    const { nodes, deps } = buildWorkItemLevel(
      {
        items: [item({ id: 'A1', kind: 'subtask' })],
        edges: [{ blockedId: 'A1', blockerId: 'X' }],
        offLevelBlockers: [],
      },
      { scope: 'sprint' },
    );
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'X')).toBe(false);
  });

  it('anchors a shared off-level blocker ONCE, however many nodes it blocks', () => {
    const { nodes, deps } = buildWorkItemLevel({
      items: [item({ id: 'A1', kind: 'subtask' }), item({ id: 'A2', kind: 'subtask' })],
      edges: [
        { blockedId: 'A1', blockerId: 'X' },
        { blockedId: 'A2', blockerId: 'X' },
      ],
      offLevelBlockers: [
        { id: 'X', identifier: 'PROD-9', title: 'External dep', parentTitle: 'Story Z' },
      ],
    });
    expect(deps.filter((d) => d.from === 'X').length).toBe(2); // both edges drawn…
    expect(nodes.filter((n) => n.id === 'X').length).toBe(1); // …one anchor
  });
});

// WITHIN-LEVEL blocked_by edges — the ordinary case, where both ends are on the
// level. The variant reports whether the dependency is SETTLED: a done blocker
// draws firm, an unfinished one dashed.
describe('buildWorkItemLevel — within-level dependency edges', () => {
  it('draws a firm edge from a DONE blocker and a pending one from an unfinished blocker', () => {
    const { deps, nodes } = buildWorkItemLevel({
      items: [
        item({ id: 'B1', status: 'done' }),
        item({ id: 'B2', status: 'todo' }),
        item({ id: 'B3', status: 'todo' }),
      ],
      edges: [
        { blockedId: 'B3', blockerId: 'B1' },
        { blockedId: 'B3', blockerId: 'B2' },
      ],
      offLevelBlockers: [],
    });
    expect(deps).toContainEqual({ from: 'B1', to: 'B3', variant: 'firm' });
    expect(deps).toContainEqual({ from: 'B2', to: 'B3', variant: 'pending' });
    // A within-level blocker is not the cross-story tangle — no ghost anchor, and
    // the blocked node carries no flag.
    expect(nodes.length).toBe(3);
    render(<>{nodes.find((n) => n.id === 'B3')!.content}</>);
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });
});

// The per-NODE "not in sprint" signal (MOTIR-1379 follow-up). In SPRINT scope the
// root level shows only in-sprint members, but drilling into a committed root
// reveals its WHOLE subtree — so a drilled-in node the sprint did not commit to
// (`inActiveSprint: false`) is rendered with a neutral dashed edge + a "not in
// sprint" tag, keeping the committed unit distinct from the rest of the subtree.
// Never flags in PROJECT scope (no sprint resolved), and never the red chrome.
const NOT_IN_SPRINT_TAG = 'not-in-sprint-tag';

describe('buildWorkItemLevel — not-in-sprint node signal (MOTIR-1379)', () => {
  it('SPRINT scope: a NON-member drilled-in node shows the "not in sprint" tag + card state', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'S1', kind: 'subtask', parentId: 'P1', inActiveSprint: false })]),
      { scope: 'sprint' },
    );
    render(<>{nodes.find((n) => n.id === 'S1')!.content}</>);
    expect(screen.getByTestId(NOT_IN_SPRINT_TAG).textContent).toContain('not in sprint');
    // A neutral, informational state — NOT the red cross-blocked chrome.
    expect(document.querySelector('[data-node-state="not-in-sprint"]')).toBeTruthy();
    expect(screen.queryByTestId(A1_FLAG)).toBeNull();
  });

  it('SPRINT scope: an IN-sprint member is NOT flagged', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'S1', kind: 'subtask', parentId: 'P1', inActiveSprint: true })]),
      { scope: 'sprint' },
    );
    render(<>{nodes.find((n) => n.id === 'S1')!.content}</>);
    expect(screen.queryByTestId(NOT_IN_SPRINT_TAG)).toBeNull();
    expect(document.querySelector('[data-node-state="not-in-sprint"]')).toBeNull();
  });

  it('PROJECT scope: a non-member is NEVER flagged (the flag is sprint-scope only)', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'S1', kind: 'subtask', parentId: 'P1', inActiveSprint: false })]),
    );
    render(<>{nodes.find((n) => n.id === 'S1')!.content}</>);
    expect(screen.queryByTestId(NOT_IN_SPRINT_TAG)).toBeNull();
    expect(document.querySelector('[data-node-state="not-in-sprint"]')).toBeNull();
  });

  it('a cross-blocked non-member shows ONLY the cross-blocked flag (no double tag)', () => {
    // A1 in levelWithOffBlocker has no `inActiveSprint` → defaults to a non-member;
    // in sprint scope it is BOTH cross-blocked and not-in-sprint. The red flag wins
    // the slot; the neutral tag is suppressed so the card never carries two tags.
    const { nodes } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: false }),
      { scope: 'sprint' },
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).getAttribute('aria-label')).toContain(
      'blocker not in sprint',
    );
    expect(screen.queryByTestId(NOT_IN_SPRINT_TAG)).toBeNull();
  });

  // MOTIR-1582 (regression): the sprint-scope cross-blocked flag must name the
  // BLOCKER, never restate the node's own membership. An in-sprint card blocked by
  // an out-of-sprint dependency wears the red flag; its copy must be DISTINCT from
  // the neutral "not in sprint" membership tag, so a reader can't misread the flag
  // as "this card isn't in the sprint" (it is). Before the fix both resolved to the
  // same `node.notInSprint` string ("not in sprint"); now the flag adds "blocker".
  it('SPRINT scope: the cross-blocked flag copy names the blocker, distinct from the membership tag', () => {
    const { nodes } = buildWorkItemLevel(
      levelWithOffBlocker({ isDone: false, inActiveSprint: false }),
      { scope: 'sprint' },
    );

    // The flag on the (in-sprint) blocked card: blocker-oriented copy.
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    const flagText = screen.getByTestId(A1_FLAG).getAttribute('aria-label') ?? '';
    expect(flagText).toContain('blocker not in sprint');
    cleanup();

    // The neutral membership tag on a genuine non-member: still the bare node copy.
    const { nodes: tagNodes } = buildWorkItemLevel(
      level([item({ id: 'S1', kind: 'subtask', parentId: 'P1', inActiveSprint: false })]),
      { scope: 'sprint' },
    );
    render(<>{tagNodes.find((n) => n.id === 'S1')!.content}</>);
    const tagText = screen.getByTestId(NOT_IN_SPRINT_TAG).textContent ?? '';
    expect(tagText).toBe('not in sprint');

    // The two must NOT be the same string — that identity was the MOTIR-1582 bug.
    expect(flagText.trim()).not.toBe(tagText.trim());
  });
});

describe('buildWorkItemLevel — ready highlight (MOTIR-1417 / MOTIR-1422)', () => {
  it('a ready node shows the "Ready" pill + the card mint wash', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'subtask', status: 'todo', ready: true })]),
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId('ready-pill')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    // The ready signal is now the whole-card wash (MOTIR-1422), not a 3px bar.
    expect(document.querySelector('[data-node-state="ready"]')).toBeTruthy();
  });

  it('a NOT-ready node shows the normal status pill, no ready treatment', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'subtask', status: 'todo', ready: false })]),
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId('ready-pill')).toBeNull();
    expect(document.querySelector('[data-node-state="ready"]')).toBeNull();
  });

  it('the "you are here" frontier wins the ready FRAME; its slot still says Ready', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'story', status: 'in_progress', ready: true })]),
      { markActive: true },
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByText('You are here')).toBeTruthy();
    // MOTIR-10630: You are here is the card's tab, so the slot is the item's own.
    expect(screen.getByTestId('ready-pill')).toBeTruthy();
    expect(document.querySelector('[data-node-state="ready"]')).toBeNull();
    expect(document.querySelector('[data-node-state="here"]')!.className).not.toContain(
      'bg-(--el-tint-mint)',
    );
  });

  it('a DONE node shows the neutral "Done" pill + the recessed/done card state (distinct from ready)', () => {
    const { nodes } = buildWorkItemLevel(
      level([item({ id: 'A1', kind: 'story', status: 'done', ready: false })]),
    );
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId('done-pill')).toBeTruthy();
    expect(document.querySelector('[data-node-state="done"]')).toBeTruthy();
    expect(document.querySelector('[data-node-state="ready"]')).toBeNull();
  });
});

// ── MOTIR-3557 · a level's EDGES are the ones whose BLOCKED end is on it ──────
// The edge loop asks only "is the BLOCKER on this level?". That was sufficient
// BY CONSTRUCTION until MOTIR-3490's grouping existed: `findBlockedByEdges`
// selects `fromId IN (level rows)`, so every edge in a level payload already had
// its blocked end on that level. Grouping is the first thing that moves a row OFF
// a level after the read, and it broke the guarantee at BOTH ends — the root
// (whose grouped rows leave) and the synthetic grouped level (whose consumer is
// handed the root's whole edge list).
describe('buildWorkItemLevel — an edge belongs to the level its BLOCKED end is on (MOTIR-3557)', () => {
  const loose = (id: string) => item({ id, kind: 'bug', parentId: null });

  it('ROOT: an edge between two GROUPED rows draws nothing on the road — no dep, no anchor', () => {
    // The shipped instance: MOTIR-3490 `blocked_by` MOTIR-3493, both parentless,
    // both grouped. The blocker was off-level so it minted a ghost anchor beside
    // the epics, while its target had ALSO been grouped — so the canvas drew a
    // red "blocked elsewhere" card for a row that is one hop inside the group,
    // with an arrow pointing at a node nobody draws.
    const { nodes, deps } = buildWorkItemLevel(
      {
        items: [item({ id: 'E1' }), item({ id: 'E2' }), loose('G1'), loose('G2')],
        edges: [{ blockedId: 'G2', blockerId: 'G1' }],
        offLevelBlockers: [],
      },
      { groupNonEpicRoots: true, groupCrumbLabel: 'Not in an epic' },
    );
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'G1')).toBe(false);
    expect(nodes.map((n) => n.id).sort()).toEqual(['E1', 'E2', NOT_IN_EPIC_ID].sort());
  });

  it('GROUPED level: the root’s epic→epic edges draw NO anchors on it', () => {
    // The consumer's synthetic level: `items` are the grouped rows, `edges` is
    // the whole root list. Every root epic is then an off-level BLOCKER of a
    // level it has nothing to do with — and none of them is in `offLevelBlockers`
    // (an epic is ON the root level), so each drew as an ANONYMOUS anchor.
    const { nodes, deps } = buildWorkItemLevel({
      items: [loose('G1'), loose('G2')],
      edges: [
        { blockedId: 'E2', blockerId: 'E1' }, // the epic roadmap's own chain…
        { blockedId: 'E3', blockerId: 'E2' },
        { blockedId: 'G2', blockerId: 'G1' }, // …and the one edge this level owns
      ],
      offLevelBlockers: [],
    });
    expect(nodes.map((n) => n.id).sort()).toEqual(['G1', 'G2']);
    expect(deps).toEqual([{ from: 'G1', to: 'G2', variant: 'pending' }]);
  });

  it('emits no anchor for an id the level READ itself carries', () => {
    // The anonymity was the tell: an anchor with no stub renders `—` over the
    // "Blocked across stories" fallback, because a row that is ON the level read
    // is never in `offLevelBlockers` to be named from. The fix is not to name
    // those anchors — it is not to emit them.
    const read = {
      items: [item({ id: 'E1' }), item({ id: 'E2' }), loose('G1')],
      edges: [{ blockedId: 'E2', blockerId: 'E1' }],
      offLevelBlockers: [],
    };
    // The grouped level: only its own rows. The root: the epics + the door.
    // Both sets are stated WHOLE — an extra id is an anchor, and naming the
    // expected set is what makes that unmissable.
    expect(buildWorkItemLevel({ ...read, items: [loose('G1')] }).nodes.map((n) => n.id)).toEqual([
      'G1',
    ]);
    expect(
      buildWorkItemLevel(read, { groupNonEpicRoots: true })
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(['E1', 'E2', NOT_IN_EPIC_ID].sort());
  });

  it('leaves the shipped off-level signal intact (MOTIR-1331 regression)', () => {
    // A GENUINE off-level blocker — one the level read named in `offLevelBlockers`
    // because it lives somewhere else entirely — still anchors, still draws the
    // red edge, and still flags the blocked node. The fix narrows which edges the
    // level owns; it does not weaken what it says about the ones it does.
    const { nodes, deps } = buildWorkItemLevel(levelWithOffBlocker({ isDone: false }));
    expect(deps).toContainEqual({ from: 'X', to: 'A1', variant: 'cross' });
    const anchor = nodes.find((n) => n.id === 'X');
    expect(anchor).toBeTruthy();
    render(<>{anchor!.content}</>);
    expect(screen.getByText('PROD-9')).toBeTruthy();
    cleanup();
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).getAttribute('aria-label')).toContain('blocked elsewhere');
  });
});

// ── MOTIR-5043 · a blocker the level's CAP dropped is not off the level ───────
// The fourth exclusion in this family, after grouping (MOTIR-3557), archived rows
// (MOTIR-3927) and a plan's arriving card (MOTIR-4952). `itemIds` is what the READ
// returned and the read stops at 200 rows key-ASC, so on a level past that a plain
// SIBLING of the blocked row arrives at the off-level branch and gets the canvas's
// loudest verdict — whose legend reads "the blocker sits elsewhere in the plan (a
// bad plan)" — about a tree that is correct.
//
// The SERVICE decides membership (it is the only reader that can compare a
// blocker's parent against the level's own) and says so on the level DTO; the
// builder's job is only to keep the three off-level effects off it.
describe('buildWorkItemLevel — a cap-dropped level MEMBER (MOTIR-5043)', () => {
  /** A truncated level: A1 survives the cap, its blocker M did not; S is a genuine
   *  cross-parent stranger, so both shapes are exercised on one level. */
  function truncatedLevel(): RoadmapLevelData {
    return {
      items: [item({ id: 'A1', kind: 'subtask', parentId: 'P' })],
      edges: [
        { blockedId: 'A1', blockerId: 'M' },
        { blockedId: 'A1', blockerId: 'S' },
      ],
      offLevelBlockers: [
        { id: 'S', identifier: 'PROD-9', title: 'Cross-story dep', parentTitle: 'Story Z' },
      ],
      levelMemberBlockers: [{ id: 'M', isDone: false }],
    };
  }

  it('fires NONE of the three off-level effects for it — no cross dep, no anchor, no flag', () => {
    // The MEMBER alone, so the third effect is readable: `crossBlocked` is a flag on
    // the BLOCKED node, and the stranger in `truncatedLevel` would raise it on the
    // same card for its own, legitimate reason.
    const { nodes, deps } = buildWorkItemLevel({
      items: [item({ id: 'A1', kind: 'subtask', parentId: 'P' })],
      edges: [{ blockedId: 'A1', blockerId: 'M' }],
      offLevelBlockers: [],
      levelMemberBlockers: [{ id: 'M', isDone: false }],
    });

    // (1) no `cross` dep to it, and (2) no ghost anchor minted for it — both read
    // off the builder's return value.
    expect(deps.filter((d) => d.from === 'M')).toEqual([
      { from: 'M', to: 'A1', variant: 'pending' },
    ]);
    expect(nodes.some((n) => n.id === 'M')).toBe(false);
    // Nothing is DRAWN for it either: the row is not on the level, so `computeLevel`
    // drops the dep for want of a node. The truncation tile is what tells the reader
    // rows are missing — a ghost anchor would be a card standing in for a member,
    // wearing the flag that means the plan is wrong.

    // (3) no `crossBlocked` entry. It is the one effect that is not a top-level
    // field: it is applied to the blocked node's `content`, so the node element
    // the builder returned is where it has to be read.
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.queryByTestId(A1_FLAG)?.getAttribute('aria-label') ?? '').not.toContain(
      'blocked elsewhere',
    );
  });

  it('leaves the GENUINE cross-parent blocker on the same level untouched', () => {
    const { nodes, deps } = buildWorkItemLevel(truncatedLevel());
    // The same card carries both blockers, which is exactly the frame the defect was
    // found in: two ghosts that were right and one that was a lie, with nothing on
    // screen separating them.
    expect(deps).toContainEqual({ from: 'S', to: 'A1', variant: 'cross' });
    expect(nodes.some((n) => n.id === 'S')).toBe(true);
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).getAttribute('aria-label')).toContain('blocked elsewhere');
  });

  it('draws a FIRM within-level variant when the dropped member is done', () => {
    const { deps } = buildWorkItemLevel({
      items: [item({ id: 'A1', kind: 'subtask', parentId: 'P' })],
      edges: [{ blockedId: 'A1', blockerId: 'M' }],
      offLevelBlockers: [],
      levelMemberBlockers: [{ id: 'M', isDone: true }],
    });
    expect(deps).toEqual([{ from: 'M', to: 'A1', variant: 'firm' }]);
  });

  it('SPRINT scope is unchanged — the service sends no members there, so the arm still flags', () => {
    // `getProjectRoadmap` returns an EMPTY member list in sprint scope: that level is
    // re-rooted at the topmost in-sprint rows, so a parent comparison says nothing
    // about membership, and the arm's own verdict about a sibling outside the sprint
    // ("blocker not in sprint") is true. This is that payload.
    const { nodes, deps } = buildWorkItemLevel(
      {
        items: [item({ id: 'A1', kind: 'subtask', parentId: 'P' })],
        edges: [{ blockedId: 'A1', blockerId: 'X' }],
        offLevelBlockers: [
          {
            id: 'X',
            identifier: 'PROD-9',
            title: 'Sibling outside the sprint',
            parentTitle: 'Story P',
            isDone: false,
            inActiveSprint: false,
          },
        ],
        levelMemberBlockers: [],
      },
      { scope: 'sprint' },
    );
    expect(deps).toContainEqual({ from: 'X', to: 'A1', variant: 'cross' });
    expect(nodes.some((n) => n.id === 'X')).toBe(true);
    render(<>{nodes.find((n) => n.id === 'A1')!.content}</>);
    expect(screen.getByTestId(A1_FLAG).getAttribute('aria-label')).toContain(
      'blocker not in sprint',
    );
  });

  it('an ABSENT member list is the pre-MOTIR-5043 behaviour, not a crash', () => {
    // Every synthetic level the client builds itself (the grouped node's, the
    // pre-plan stations') omits the field, and so does an older server. Membership
    // there is the rows the client already holds, so an unknown blocker is genuinely
    // off the level and keeps the signal.
    const { nodes, deps } = buildWorkItemLevel({
      items: [item({ id: 'A1', kind: 'subtask', parentId: 'P' })],
      edges: [{ blockedId: 'A1', blockerId: 'M' }],
      offLevelBlockers: [],
    });
    expect(deps).toEqual([{ from: 'M', to: 'A1', variant: 'cross' }]);
    expect(nodes.some((n) => n.id === 'M')).toBe(true);
  });
});

// ── MOTIR-6359 · an off-level edge draws by its DISPOSITION ───────────────────
// Design `design/roadmap/design-notes.md` § "Covered cross-parent edges
// (MOTIR-6015)" (MOTIR-6353). The service computes each off-level edge's
// disposition with the validators' own predicates; the builder only reads it. So
// these cases hand the builder a DTO with `coverage` already set — the same shape
// `getProjectRoadmap` produces (tests/integration/work-items/roadmap-edge-coverage).
describe('buildWorkItemLevel — off-level edge disposition (MOTIR-6359)', () => {
  const Y = {
    id: 'Y',
    identifier: 'MOTIR-804',
    title: 'Tokenise a card',
    parentTitle: 'Payments API',
  };
  const Z = {
    id: 'Z',
    identifier: 'MOTIR-829',
    title: 'Audit the payment',
    parentTitle: 'Audit log',
  };
  const X = item({ id: 'X', kind: 'subtask', parentId: 'B' });

  function flagText(nodes: ReturnType<typeof buildWorkItemLevel>['nodes'], id: string) {
    render(<>{nodes.find((n) => n.id === id)!.content}</>);
    const text = screen.queryByTestId(A1_FLAG)?.getAttribute('aria-label') ?? '';
    cleanup();
    return text;
  }

  it('UNCOVERED: the shipped treatment — cross dep, danger anchor, flag (sheet 1)', () => {
    const { nodes, deps } = buildWorkItemLevel({
      items: [X],
      edges: [{ blockedId: 'X', blockerId: 'Y', coverage: 'uncovered' }],
      offLevelBlockers: [Y],
    });
    expect(deps).toEqual([{ from: 'Y', to: 'X', variant: 'cross' }]);
    expect(flagText(nodes, 'X')).toContain('blocked elsewhere');
    render(<>{nodes.find((n) => n.id === 'Y')!.content}</>);
    expect(document.querySelector('[data-anchor-tone]')?.getAttribute('data-anchor-tone')).toBe(
      'danger',
    );
  });

  it('COVERED: none of the three — no dep, no anchor, no flag (sheet 2)', () => {
    const { nodes, deps } = buildWorkItemLevel({
      items: [X],
      edges: [{ blockedId: 'X', blockerId: 'Y', coverage: 'covered' }],
      offLevelBlockers: [{ ...Y, isDone: true }],
    });
    expect(deps).toEqual([]);
    expect(nodes.some((n) => n.id === 'Y')).toBe(false);
    expect(flagText(nodes, 'X')).not.toContain('blocked elsewhere');
  });

  it('MIXED: keeps the flag, and mints exactly ONE anchor — the uncovered blocker (sheet 3)', () => {
    const { nodes, deps } = buildWorkItemLevel({
      items: [X],
      edges: [
        { blockedId: 'X', blockerId: 'Y', coverage: 'covered' },
        { blockedId: 'X', blockerId: 'Z', coverage: 'uncovered' },
      ],
      offLevelBlockers: [Y, Z],
    });
    expect(deps).toEqual([{ from: 'Z', to: 'X', variant: 'cross' }]);
    expect(nodes.filter((n) => n.id === 'Y' || n.id === 'Z').map((n) => n.id)).toEqual(['Z']);
    expect(flagText(nodes, 'X')).toContain('blocked elsewhere');
  });

  it('CROSS-LEVEL is flagged like an uncovered edge (MOTIR-6509)', () => {
    const { deps } = buildWorkItemLevel({
      items: [X],
      edges: [{ blockedId: 'X', blockerId: 'Y', coverage: 'cross_level' }],
      offLevelBlockers: [Y],
    });
    expect(deps).toEqual([{ from: 'Y', to: 'X', variant: 'cross' }]);
  });

  it('EXEMPT: an ordinary arrow from a NEUTRAL anchor, and no flag (sheet 7)', () => {
    const R = item({ id: 'R', kind: 'task', parentId: null });
    const F = {
      id: 'F',
      identifier: 'MOTIR-871',
      title: 'Secrets store',
      parentTitle: null,
      folderPath: ['Ops', 'Infra'],
    };
    const open = buildWorkItemLevel({
      items: [R],
      edges: [{ blockedId: 'R', blockerId: 'F', coverage: 'exempt' }],
      offLevelBlockers: [{ ...F, isDone: false }],
    });
    expect(open.deps).toEqual([{ from: 'F', to: 'R', variant: 'pending' }]);
    expect(flagText(open.nodes, 'R')).not.toContain('blocked elsewhere');
    render(<>{open.nodes.find((n) => n.id === 'F')!.content}</>);
    expect(document.querySelector('[data-anchor-tone]')?.getAttribute('data-anchor-tone')).toBe(
      'neutral',
    );
    // The folder line (MOTIR-5713 decision 7) survives on the neutral anchor.
    expect(screen.getByTestId('anchor-folder').textContent).toContain('Infra');
    cleanup();

    const done = buildWorkItemLevel({
      items: [R],
      edges: [{ blockedId: 'R', blockerId: 'F', coverage: 'exempt' }],
      offLevelBlockers: [{ ...F, isDone: true }],
    });
    expect(done.deps).toEqual([{ from: 'F', to: 'R', variant: 'firm' }]);
  });

  it('one blocker with a flagged AND an exempt edge keeps the DANGER anchor', () => {
    const W = item({ id: 'W', kind: 'subtask', parentId: 'B' });
    const { nodes } = buildWorkItemLevel({
      items: [X, W],
      edges: [
        { blockedId: 'X', blockerId: 'Y', coverage: 'exempt' },
        { blockedId: 'W', blockerId: 'Y', coverage: 'uncovered' },
      ],
      offLevelBlockers: [Y],
    });
    render(<>{nodes.find((n) => n.id === 'Y')!.content}</>);
    expect(document.querySelector('[data-anchor-tone]')?.getAttribute('data-anchor-tone')).toBe(
      'danger',
    );
  });

  it('SPRINT scope ignores the disposition — its own arm decides, unchanged', () => {
    const { deps } = buildWorkItemLevel(
      {
        items: [X],
        edges: [{ blockedId: 'X', blockerId: 'Y', coverage: 'covered' }],
        offLevelBlockers: [{ ...Y, isDone: false, inActiveSprint: false }],
      },
      { scope: 'sprint' },
    );
    expect(deps).toEqual([{ from: 'Y', to: 'X', variant: 'cross' }]);
  });
});
