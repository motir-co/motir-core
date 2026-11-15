import { describe, expect, it } from 'vitest';
import { locateTargets } from '@/lib/planning/livePane';
import {
  LOCATE_START,
  locateHint,
  nextLocateStop,
  type LocateCursor,
  type LocateStop,
} from '@/lib/planning/locateWalk';
import { planReviewItem } from '../helpers/planReview';

// LOCATE GOES TO THE WORK FIRST (MOTIR-11298) — the PURE halves: which cards a
// live step names (`locateTargets`), and the walk over them and the rest
// (`nextLocateStop`, `locateHint`).

// A root proposed story with one proposed child task, a second root, and a
// proposed task under a COMMITTED parent the plan holds no proposal for.
const story = planReviewItem({ planItemId: 'ps', nodeId: 'ps', title: 'Story', kind: 'story' });
const task = planReviewItem({
  planItemId: 'pt',
  nodeId: 'pt',
  parentNodeId: 'ps',
  title: 'Task',
});
const other = planReviewItem({ planItemId: 'po', nodeId: 'po', title: 'Other', kind: 'story' });
const underCommitted = planReviewItem({
  planItemId: 'pc',
  nodeId: 'pc',
  parentNodeId: 'wi_epic',
  parentIdentifier: 'ARP-1',
  parentTitle: 'Epic',
  parentKind: 'epic',
  parentTrail: [{ id: 'wi_epic', identifier: 'ARP-1', title: 'Epic' }],
  title: 'Under the epic',
});
const items = [story, task, other, underCommitted];

describe('locateTargets — the cards the live steps name', () => {
  it('author, check and repair: the card, at the level it SITS on', () => {
    const out = locateTargets(
      items,
      [
        { kind: 'author', targetNodeId: 'ps' },
        { kind: 'check', targetNodeId: 'pt' },
        { kind: 'repair', targetNodeId: 'po' },
      ],
      'New',
    );
    expect(out.map((t) => t.nodeId)).toEqual(['ps', 'pt', 'po']);
    expect(out[0]?.trail).toEqual([]);
    expect(out[1]?.trail?.at(-1)?.id).toBe('ps');
    expect(out[2]?.trail).toEqual([]);
  });

  it('a check step counts as activity, though it draws no cue', () => {
    expect(locateTargets(items, [{ kind: 'check', targetNodeId: 'pt' }], 'New')).toHaveLength(1);
  });

  it('a lay on a proposed parent: the parent card at its own level', () => {
    const [t] = locateTargets(items, [{ kind: 'lay', targetNodeId: 'ps' }], 'New');
    expect(t).toEqual({ nodeId: 'ps', trail: [] });
  });

  it('a lay or amend on a COMMITTED parent: the level being laid, less its last crumb', () => {
    const [lay] = locateTargets(items, [{ kind: 'lay', targetNodeId: 'wi_epic' }], 'New');
    expect(lay).toEqual({ nodeId: 'wi_epic', trail: [] });
    const [amend] = locateTargets(items, [{ kind: 'amend', targetNodeId: 'wi_epic' }], 'New');
    expect(amend?.trail).toEqual([]);
  });

  it('a committed target the plan cannot place keeps its node with no trail', () => {
    expect(locateTargets(items, [{ kind: 'check', targetNodeId: 'wi_x' }], 'New')).toEqual([
      { nodeId: 'wi_x', trail: null },
    ]);
  });

  it('settle and an untargeted step name nothing; one entry per node, in step order', () => {
    const out = locateTargets(
      items,
      [
        { kind: 'settle', targetNodeId: 'ps' },
        { kind: 'author', targetNodeId: null },
        { kind: 'author', targetNodeId: 'po' },
        { kind: 'check', targetNodeId: 'ps' },
        { kind: 'repair', targetNodeId: 'po' },
      ],
      'New',
    );
    expect(out.map((t) => t.nodeId)).toEqual(['po', 'ps']);
  });
});

const here = (id: string): LocateStop => ({ nodeId: id, trail: null });
const away = (id: string): LocateStop => ({
  nodeId: id,
  trail: [{ id: 'lvl', label: 'Level' }],
});

/** Click `n` times; the node each click goes to, and the cursor after. */
function walk(
  active: LocateStop[],
  rest: LocateStop[],
  n: number,
  from: LocateCursor = LOCATE_START,
): { ids: string[]; cursor: LocateCursor } {
  const ids: string[] = [];
  let cursor = from;
  for (let i = 0; i < n; i += 1) {
    const next = nextLocateStop(active, rest, cursor);
    if (!next) break;
    ids.push(next.stop.nodeId);
    cursor = next.cursor;
  }
  return { ids, cursor };
}

describe('nextLocateStop — the walk', () => {
  it('with no active card it is the shipped walk: the first card, then on, wrapping', () => {
    expect(walk([], [here('a'), here('b'), here('c')], 4).ids).toEqual(['a', 'b', 'c', 'a']);
  });

  it('the active cards first, then the rest, then a new round from the first active', () => {
    expect(walk([here('x'), away('y')], [here('a'), here('b')], 6).ids).toEqual([
      'x',
      'y',
      'a',
      'b',
      'x',
      'y',
    ]);
  });

  it('says whether the next stop is an active card', () => {
    const first = nextLocateStop([here('x')], [here('a')], LOCATE_START);
    expect(first?.active).toBe(true);
    const second = first && nextLocateStop([here('x')], [here('a')], first.cursor);
    expect(second?.active).toBe(false);
  });

  it('remembers active cards by id, so a reordered list does not revisit one', () => {
    // Visiting `y` on another level re-orders the walk there: `y` is now on-level.
    const { cursor } = walk([here('x'), away('y')], [], 2);
    expect(walk([here('y'), away('x')], [here('a')], 1, cursor).ids).toEqual(['a']);
  });

  it('only active cards: they cycle', () => {
    expect(walk([here('x'), here('y')], [], 3).ids).toEqual(['x', 'y', 'x']);
  });

  it('nothing to walk → null', () => {
    expect(nextLocateStop([], [], LOCATE_START)).toBeNull();
  });
});

describe('locateHint — `n / total` over the cards being cycled', () => {
  it('nothing before the first click', () => {
    expect(locateHint([here('x'), here('y')], [], LOCATE_START)).toBeNull();
  });

  it('counts the active cards while the walk is on them', () => {
    expect(
      locateHint(
        [here('x'), here('y')],
        [here('a')],
        walk([here('x'), here('y')], [here('a')], 1).cursor,
      ),
    ).toBe('1 / 2');
    expect(
      locateHint(
        [here('x'), here('y')],
        [here('a')],
        walk([here('x'), here('y')], [here('a')], 2).cursor,
      ),
    ).toBe('2 / 2');
  });

  it('never reads below the cards already visited', () => {
    expect(locateHint([here('y')], [], { visited: ['x', 'y'], index: -1 })).toBe('2 / 2');
  });

  it('counts the rest once the walk has moved on', () => {
    const active = [here('x')];
    const rest = [here('a'), here('b')];
    expect(locateHint(active, rest, walk(active, rest, 2).cursor)).toBe('1 / 2');
  });

  it('one card to cycle: no hint', () => {
    expect(locateHint([here('x')], [], { visited: ['x'], index: -1 })).toBeNull();
    expect(locateHint([], [here('a')], { visited: [], index: 0 })).toBeNull();
  });
});
