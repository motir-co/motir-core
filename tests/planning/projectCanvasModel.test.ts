import { describe, expect, it } from 'vitest';
import {
  NODE_W,
  breadcrumb,
  childrenOf,
  computeLevel,
  deterministicLayout,
  LOOSE_BAND_COLS,
  focalNode,
  hasChildren,
  levelOf,
  longestPathLayers,
  searchMatches,
  topologicalOrder,
  type ProjectCanvasDep,
  type ProjectCanvasNode,
} from '@/lib/planning/projectCanvasModel';

// A small project forest: epic E1 → stories S1, S2 → subtasks. S1 has T1a, T1b
// (T1b blocked_by T1a); S2 has T2a. A cross-story dep: T2a blocked_by T1a. Content
// is irrelevant to the (structural) model, so it is a placeholder string.
function node(id: string, parentId: string | null, searchText: string): ProjectCanvasNode {
  return { id, parentId, searchText, content: searchText, crumbLabel: id };
}

function forest(): ProjectCanvasNode[] {
  return [
    node('E1', null, 'MOTIR-1 Epic one'),
    node('S1', 'E1', 'MOTIR-2 Story one'),
    node('S2', 'E1', 'MOTIR-3 Story two'),
    node('T1a', 'S1', 'MOTIR-4 Build the engine'),
    node('T1b', 'S1', 'MOTIR-5 Wire the engine'),
    node('T2a', 'S2', 'MOTIR-6 Compose it'),
  ];
}

// T1a is done → its within-story edge is firm; the cross edge is reclassified.
const deps: ProjectCanvasDep[] = [
  { from: 'T1a', to: 'T1b', variant: 'firm' }, // within S1
  { from: 'T1a', to: 'T2a', variant: 'firm' }, // cross story (S1 → S2)
];

describe('childrenOf / hasChildren', () => {
  it('returns the forest roots at the top level', () => {
    expect(childrenOf(forest(), null).map((n) => n.id)).toEqual(['E1']);
  });
  it("returns a node's direct children when focused", () => {
    expect(childrenOf(forest(), 'E1').map((n) => n.id)).toEqual(['S1', 'S2']);
    expect(childrenOf(forest(), 'S1').map((n) => n.id)).toEqual(['T1a', 'T1b']);
  });
  it('treats a node whose parent is absent from the set as a root', () => {
    const partial = [node('T1a', 'S1', 'a'), node('T2a', 'S2', 'b')];
    expect(childrenOf(partial, null).map((n) => n.id)).toEqual(['T1a', 'T2a']);
  });
  it('reports children presence', () => {
    expect(hasChildren(forest(), 'S1')).toBe(true);
    expect(hasChildren(forest(), 'T1a')).toBe(false);
  });
});

describe('computeLevel — drillability + edge classification', () => {
  it('marks nodes with children as drillable', () => {
    const lvl = computeLevel(forest(), deps, 'E1');
    expect(lvl.nodes.map((n) => [n.node.id, n.drillable])).toEqual([
      ['S1', true],
      ['S2', true],
    ]);
  });

  it('keeps a within-parent edge as its consumer variant (firm)', () => {
    const lvl = computeLevel(forest(), deps, 'S1');
    expect(lvl.edges).toEqual([{ from: 'T1a', to: 'T1b', variant: 'firm' }]);
  });

  it('drops edges whose other end is off the current level', () => {
    const lvl = computeLevel(forest(), deps, 'S1');
    expect(lvl.edges.some((e) => e.to === 'T2a')).toBe(false);
  });

  it('reclassifies a cross-PARENT edge as the bad-plan signal when both ends are visible', () => {
    // Render all subtasks as one level (parents absent) → T1a and T2a differ in
    // parentId → the firm hint is overridden to `cross`.
    const subtasks = forest().filter((n) => n.id.startsWith('T'));
    const lvl = computeLevel(subtasks, deps, null);
    const cross = lvl.edges.find((e) => e.to === 'T2a');
    expect(cross).toEqual({ from: 'T1a', to: 'T2a', variant: 'cross' });
  });
});

describe('breadcrumb / levelOf', () => {
  it('builds the root→focus path with crumb labels', () => {
    expect(breadcrumb(forest(), 'T1b').map((c) => c.id)).toEqual(['E1', 'S1', 'T1b']);
    expect(breadcrumb(forest(), 'T1b').map((c) => c.label)).toEqual(['E1', 'S1', 'T1b']);
    expect(breadcrumb(forest(), null)).toEqual([]);
  });
  it('reports the drill level a target lives on', () => {
    expect(levelOf(forest(), 'T1b')).toBe('S1');
    expect(levelOf(forest(), 'E1')).toBe(null);
  });
});

describe('topologicalOrder', () => {
  it('orders blocker before blocked, ties + cycles in input order', () => {
    expect(topologicalOrder(['b', 'a'], [{ from: 'a', to: 'b' }])).toEqual(['a', 'b']);
    expect(
      topologicalOrder(
        ['x', 'y'],
        [
          { from: 'x', to: 'y' },
          { from: 'y', to: 'x' },
        ],
      ),
    ).toEqual(['x', 'y']);
  });
  it('ignores edges to nodes outside the set', () => {
    expect(topologicalOrder(['a'], [{ from: 'a', to: 'ghost' }])).toEqual(['a']);
  });
});

describe('deterministicLayout', () => {
  it('is pure: same input → identical positions', () => {
    const ids = ['a', 'b', 'c'];
    const e = [{ from: 'a', to: 'b' }];
    expect(deterministicLayout(ids, e)).toEqual(deterministicLayout(ids, e));
  });
  it('lays a dependency chain left→right, one layer per step', () => {
    const pos = deterministicLayout(
      ['b', 'a', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    expect(pos['a']!.x).toBeLessThan(pos['b']!.x);
    expect(pos['b']!.x).toBeLessThan(pos['c']!.x);
    expect(pos['a']!.y).toBe(pos['b']!.y);
  });
  it('stacks siblings that share a blocker into one layer (same column, rows apart)', () => {
    const pos = deterministicLayout(
      ['r', 'x', 'y'],
      [
        { from: 'r', to: 'x' },
        { from: 'r', to: 'y' },
      ],
    );
    expect(pos['r']!.x).toBeLessThan(pos['x']!.x); // the blocker sits a layer left
    expect(pos['x']!.x).toBe(pos['y']!.x); // siblings share the layer column
    expect(pos['x']!.y).not.toBe(pos['y']!.y); // …stacked into distinct rows
  });
  it('drops LOOSE nodes (in no edge) into a band BELOW the flow — off every line', () => {
    const pos = deterministicLayout(['a', 'b', 'loose'], [{ from: 'a', to: 'b' }]);
    // the standalone card clears both connected cards, so no dependency line can
    // ever cross it (the "loose bug on the line" bug).
    expect(pos['loose']!.y).toBeGreaterThan(pos['a']!.y);
    expect(pos['loose']!.y).toBeGreaterThan(pos['b']!.y);
  });
  it('lays an all-loose level FIVE to a row; the sixth card starts the second row (MOTIR-10537)', () => {
    expect(LOOSE_BAND_COLS).toBe(5);
    const ids = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
    const pos = deterministicLayout(ids, []);
    // Row one: five cards side by side at the origin row, one column step apart.
    for (let i = 0; i < 5; i += 1) {
      expect(pos[ids[i]!]).toEqual({ x: 40 + i * 360, y: 40 });
    }
    // The sixth wraps to the first column of the next row.
    expect(pos['n5']).toEqual({ x: 40, y: 40 + 196 });
  });
  it('keeps the dependency FLOW as it was, with the five-wide band below it (MOTIR-10537)', () => {
    const loose = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
    const pos = deterministicLayout(
      ['a', ...loose, 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
    );
    // The flow: `a` in layer 0, `b` and `c` stacked in layer 1 — two rows tall.
    expect(pos['a']).toEqual({ x: 40, y: 40 });
    expect(pos['b']).toEqual({ x: 400, y: 40 });
    expect(pos['c']).toEqual({ x: 400, y: 236 });
    // The band starts BAND_GAP (96) below the flow's bottom edge (236 + 124).
    const bandY = 236 + 124 + 96;
    loose.slice(0, 5).forEach((id, i) => expect(pos[id]).toEqual({ x: 40 + i * 360, y: bandY }));
    expect(pos['l5']).toEqual({ x: 40, y: bandY + 196 });
    expect(pos['l6']).toEqual({ x: 400, y: bandY + 196 });
  });
  it('lays an all-loose level as a plain grid that keeps nodes apart', () => {
    const pos = deterministicLayout(['n0', 'n1', 'n2', 'n3', 'n4', 'n5'], []);
    expect(pos['n5']!.y).toBeGreaterThan(pos['n0']!.y);
    expect(Math.abs(pos['n0']!.x - pos['n1']!.x)).toBeGreaterThanOrEqual(NODE_W);
  });
});

describe('searchMatches', () => {
  it('matches the node searchText, case-insensitive, in input order', () => {
    expect(searchMatches(forest(), 'engine')).toEqual(['T1a', 'T1b']);
    expect(searchMatches(forest(), 'motir-6')).toEqual(['T2a']);
  });
  it('a blank query matches nothing (locate, not filter-to-empty)', () => {
    expect(searchMatches(forest(), '   ')).toEqual([]);
  });
});

// ── THE FOCAL CARD (MOTIR-3837) ─────────────────────────────────────────────
describe('focalNode', () => {
  const n = (id: string, over: Partial<ProjectCanvasNode> = {}): ProjectCanvasNode => ({
    id,
    parentId: null,
    searchText: id,
    content: null,
    ...over,
  });

  it('prefers the `here` frontier over everything else', () => {
    expect(focalNode([n('A'), n('B', { ready: true }), n('C', { here: true })])).toBe('C');
  });

  it('falls to the FIRST ready node when there is no frontier', () => {
    expect(focalNode([n('A'), n('B', { ready: true }), n('C', { ready: true })])).toBe('B');
  });

  it('falls to the level’s first node in layout order when there is neither', () => {
    expect(focalNode([n('A'), n('B')])).toBe('A');
  });

  it('NEVER picks a decorative node — not even when it is first, and not even when it is `here`', () => {
    // The pinned planning-origin cluster is provenance drawn beside the road, not
    // the level's work (MOTIR-1824 established that rule for auto-descend).
    expect(focalNode([n('__origin__', { decorative: true }), n('A')])).toBe('A');
    expect(focalNode([n('__origin__', { decorative: true, here: true }), n('A')])).toBe('A');
    expect(focalNode([n('__origin__', { decorative: true }), n('A'), n('B', { here: true })])).toBe(
      'B',
    );
  });

  it('returns null for an empty level, and for one that is ALL decoration', () => {
    expect(focalNode([])).toBeNull();
    expect(focalNode([n('__origin__', { decorative: true })])).toBeNull();
  });
});

// ── the pure layout/order fallbacks ─────────────────────────────────────────
describe('topologicalOrder and deterministicLayout — the defensive arms', () => {
  it('ignores an edge naming a node that is not in the set, and a self-edge', () => {
    const ids = ['A', 'B'];
    const order = topologicalOrder(ids, [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'GHOST' }, // not a member
      { from: 'B', to: 'B' }, // self
    ]);
    expect(order).toEqual(['A', 'B']);
  });

  it('still emits every node when the edges form a CYCLE (no member has in-degree 0)', () => {
    // The queue starts empty, so the drain loop never runs and the tail pass is
    // what produces the order — the arm a well-formed DAG never reaches.
    const order = topologicalOrder(
      ['A', 'B', 'C'],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'A' },
      ],
    );
    expect([...order].sort()).toEqual(['A', 'B', 'C']);
  });

  it('lays out a CYCLE without hanging, and places every node exactly once', () => {
    const pos = deterministicLayout(
      ['A', 'B'],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ],
    );
    expect(Object.keys(pos).sort()).toEqual(['A', 'B']);
    expect(pos['A']).not.toEqual(pos['B']);
  });

  it('lays out a set with NO edges at all — every node is loose', () => {
    const pos = deterministicLayout(['A', 'B', 'C', 'D'], []);
    expect(Object.keys(pos)).toHaveLength(4);
    // The loose band is a grid, so the first row shares a `y`.
    expect(pos['A']!.y).toBe(pos['B']!.y);
  });

  it('lays out a chain DEEPER than one layer, stacking each node past its predecessor', () => {
    const pos = deterministicLayout(
      ['A', 'B', 'C'],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    );
    expect(pos['A']!.x).toBeLessThan(pos['B']!.x);
    expect(pos['B']!.x).toBeLessThan(pos['C']!.x);
  });
});

// Bug MOTIR-10454 — the longest-path layering was lifted out of
// `deterministicLayout` so the roadmap's "you are here" pick reads the SAME depth
// the columns are drawn by. The layout's positions must not move.
describe('longestPathLayers (MOTIR-10454)', () => {
  const repro = [
    { from: '10449', to: '10451' },
    { from: '10449', to: '10450' },
    { from: '10451', to: '10450' },
    { from: '10450', to: '10452' },
    { from: '10451', to: '10452' },
  ];

  it('gives each node its LONGEST-path depth, not its shortest', () => {
    const { layer } = longestPathLayers(['10449', '10450', '10451', '10452'], repro);
    // 10450 has a direct edge from 10449 (depth 1) and the chain via 10451 (depth 2).
    expect(Object.fromEntries(layer)).toEqual({ '10449': 0, '10451': 1, '10450': 2, '10452': 3 });
  });

  it('returns the stable topological order it computed the depths in', () => {
    const { order } = longestPathLayers(['10449', '10450', '10451', '10452'], repro);
    expect(order).toEqual(['10449', '10451', '10450', '10452']);
  });

  it('ignores self-edges and edges with an end outside the set; a node no edge reaches is depth 0', () => {
    const { layer } = longestPathLayers(
      ['a', 'b', 'loose'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'b' },
        { from: 'ghost', to: 'a' },
        { from: 'b', to: 'ghost' },
      ],
    );
    expect(Object.fromEntries(layer)).toEqual({ a: 0, b: 1, loose: 0 });
  });

  it('does not throw on a cycle, and still assigns every node a depth', () => {
    const { layer, order } = longestPathLayers(
      ['a', 'b', 'c'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect([...layer.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it("leaves deterministicLayout's positions exactly where they were", () => {
    // Pinned from the layout as it shipped before the lift (motir-core 2083799f4).
    expect(deterministicLayout(['10449', '10450', '10451', '10452', 'loose'], repro)).toEqual({
      '10449': { x: 40, y: 40 },
      '10450': { x: 760, y: 40 },
      '10451': { x: 400, y: 40 },
      '10452': { x: 1120, y: 40 },
      loose: { x: 40, y: 260 },
    });
    expect(
      deterministicLayout(
        ['a', 'b', 'c', 'd'],
        [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'b' },
          { from: 'c', to: 'd' },
        ],
      ),
    ).toEqual({
      a: { x: 40, y: 40 },
      b: { x: 400, y: 40 },
      c: { x: 760, y: 40 },
      d: { x: 1120, y: 40 },
    });
  });
});
