import { describe, expect, it } from 'vitest';
import type { PlanItemChangeField } from '@/lib/dto/planReview';
import {
  fullestContainer,
  isMarkOnlyProposal,
  planContainerCount,
  planContainers,
} from '@/lib/planning/planShape';
import { planReviewItem } from '../helpers/planReview';

// MOTIR-3260 — the pure container-spread module (`design/ai-planning/design-notes.md`
// Part IX §1 and §3).
//
// A plan is not a tree; it is a SCATTER of proposals across somebody else's tree.
// Two surfaces reason about that scatter — the canvas picks the level it most
// FILLS, and the plan detail asks whether it STRADDLES — and this module is the
// one implementation of both questions.
//
// ⚠️ THE CASE THIS FILE EXISTS FOR: a PROPOSED container counts. The shipped
// `arrivalLevel` skipped any item without a `parentIdentifier`, and
// `getPlanReview` sets that field to null for an intra-plan (`planItem:`) parent
// — deliberately — so the count discarded exactly the items the null describes.

/** A committed epic with one proposed story under it, and `n` subtasks under
 *  that story by intra-plan ref. The shape the whole card is about. */
function storyAndSubtasks(n: number) {
  const story = planReviewItem({
    planItemId: 'pi_story',
    nodeId: 'pi_story',
    op: 'add',
    title: 'Payout reconciliation',
    kind: 'story',
    // Committed parent — the epic.
    parentNodeId: 'wi_epic',
    parentIdentifier: 'MOTIR-653',
    parentTitle: 'Epic 8',
    parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-653', title: 'Epic 8' }],
  });
  const subtasks = Array.from({ length: n }, (_, i) =>
    planReviewItem({
      planItemId: `pi_sub_${i}`,
      nodeId: `pi_sub_${i}`,
      op: 'add',
      title: `Subtask ${i}`,
      kind: 'subtask',
      // An intra-plan parent: `parentNodeId` populated, `parentIdentifier` NULL.
      parentNodeId: 'pi_story',
      parentIdentifier: null,
      parentTitle: null,
      parentTrail: [],
    }),
  );
  return [story, ...subtasks];
}

describe('planContainers — a PROPOSED container counts', () => {
  it('counts proposals under a proposed parent, which the shipped rule discarded', () => {
    const containers = planContainers(storyAndSubtasks(5));

    // Most-filled first: the proposed story holds five, the committed epic one.
    expect(containers[0]!.parentNodeId).toBe('pi_story');
    expect(containers[0]!.count).toBe(5);
    expect(containers[1]!.parentNodeId).toBe('wi_epic');
    expect(containers[1]!.count).toBe(1);
  });

  it('counts the TOP LEVEL as a container, keyed null', () => {
    // Part IX §3: a plan of pure roots has exactly ONE container, so it does not
    // straddle. That is only true if `null` is a key rather than skipped.
    const roots = [
      planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: null }),
      planReviewItem({ planItemId: 'b', nodeId: 'b', parentNodeId: null }),
    ];

    expect(planContainers(roots)).toEqual([{ parentNodeId: null, count: 2, depth: 0 }]);
    expect(planContainerCount(roots)).toBe(1);
  });

  it('an empty plan has no containers', () => {
    expect(planContainers([])).toEqual([]);
    expect(planContainerCount([])).toBe(0);
    expect(fullestContainer([])).toBeNull();
  });
});

describe('the TIE-BREAK is the DEEPER level (Part IX §1.2)', () => {
  it('prefers the deeper container when two hold the same count', () => {
    // One story under an epic plus one subtask under that story is 1–1. The
    // shipped code kept whichever the `Map` yielded first — an accident of
    // insertion order. A reviewer wants to land where the work is.
    const items = storyAndSubtasks(1);

    expect(fullestContainer(items)!.parentNodeId).toBe('pi_story');
  });

  it('and does so REGARDLESS of insertion order', () => {
    // The assertion that stops it silently reverting to Map iteration order.
    const items = storyAndSubtasks(1);
    const reversed = [...items].reverse();

    expect(fullestContainer(reversed)!.parentNodeId).toBe('pi_story');
  });

  it('COUNT still outranks depth', () => {
    // Depth breaks a tie; it does not win one. A committed parent holding three
    // beats a proposed one holding two, however deep the second sits.
    const items = [
      ...storyAndSubtasks(2),
      planReviewItem({
        planItemId: 'x1',
        nodeId: 'x1',
        parentNodeId: 'wi_epic',
        parentIdentifier: 'MOTIR-653',
        parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-653', title: 'Epic 8' }],
      }),
      planReviewItem({
        planItemId: 'x2',
        nodeId: 'x2',
        parentNodeId: 'wi_epic',
        parentIdentifier: 'MOTIR-653',
        parentTrail: [{ id: 'wi_epic', identifier: 'MOTIR-653', title: 'Epic 8' }],
      }),
    ];

    // The epic now holds three (the story + x1 + x2), the proposed story two.
    expect(fullestContainer(items)!.parentNodeId).toBe('wi_epic');
  });
});

describe('depth walks the whole proposal chain', () => {
  it('a container nested TWO proposals deep is deeper than one nested one', () => {
    const epic = planReviewItem({
      planItemId: 'pi_epic',
      nodeId: 'pi_epic',
      op: 'add',
      parentNodeId: null,
      parentTrail: [],
    });
    const story = planReviewItem({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      op: 'add',
      parentNodeId: 'pi_epic',
      parentIdentifier: null,
      parentTrail: [],
    });
    const sub = planReviewItem({
      planItemId: 'pi_sub',
      nodeId: 'pi_sub',
      op: 'add',
      parentNodeId: 'pi_story',
      parentIdentifier: null,
      parentTrail: [],
    });

    const containers = planContainers([epic, story, sub]);
    const depthOf = (id: string | null) => containers.find((c) => c.parentNodeId === id)!.depth;

    expect(depthOf('pi_story')).toBeGreaterThan(depthOf('pi_epic'));
    expect(depthOf(null)).toBe(0);
  });

  it('a committed ancestor NOBODY names directly still terminates the walk', () => {
    // Reached when the chain climbs THROUGH a proposal into a committed
    // container that no item names as its own `parentNodeId` — the proposal
    // above it carries the trail instead. The walk must end with a depth rather
    // than looking for a namer that is not there.
    const story = planReviewItem({
      planItemId: 'pi_story',
      nodeId: 'pi_story',
      op: 'add',
      parentNodeId: 'wi_unnamed',
      parentIdentifier: null,
      parentTitle: null,
      parentTrail: [],
    });
    const sub = planReviewItem({
      planItemId: 'pi_sub',
      nodeId: 'pi_sub',
      op: 'add',
      parentNodeId: 'pi_story',
      parentIdentifier: null,
      parentTrail: [],
    });

    const containers = planContainers([story, sub]);
    const committed = containers.find((c) => c.parentNodeId === 'wi_unnamed')!;

    expect(committed.depth).toBeGreaterThan(0);
    expect(planContainerCount([story, sub])).toBe(2);
  });

  it('a cycle cannot hang the walk', () => {
    // The DTO cannot produce one, but a pure function that walks a graph should
    // not depend on that for termination.
    const a = planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: 'b' });
    const b = planReviewItem({ planItemId: 'b', nodeId: 'b', parentNodeId: 'a' });

    expect(() => planContainers([a, b])).not.toThrow();
  });
});

describe('planContainerCount — what MOTIR-3262 reads', () => {
  it('is ONE for a plan that lives under a single committed parent', () => {
    const items = [
      planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: 'wi_p' }),
      planReviewItem({ planItemId: 'b', nodeId: 'b', parentNodeId: 'wi_p' }),
    ];

    expect(planContainerCount(items)).toBe(1);
  });

  it('is TWO for a plan that straddles — the case the list view is the honest default for', () => {
    const items = [
      planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: 'wi_story' }),
      planReviewItem({ planItemId: 'b', nodeId: 'b', parentNodeId: 'wi_story' }),
      planReviewItem({ planItemId: 'c', nodeId: 'c', parentNodeId: 'wi_epic' }),
    ];

    expect(planContainerCount(items)).toBe(2);
  });
});

describe('fullestContainer', () => {
  it('is null for a plan that lives entirely at the TOP level', () => {
    // There is no level to arrive at — the canvas opens at the top, which is
    // where it already is.
    const roots = [planReviewItem({ planItemId: 'a', nodeId: 'a', parentNodeId: null })];

    expect(fullestContainer(roots)).toBeNull();
  });
});

// ── Bug MOTIR-12097 — a MARK-ONLY `modify` does not choose where the canvas opens ──
//
// A plan that replaces old work marks several FINISHED cards outdated and adds a
// few new ones elsewhere. Counted alike, the marks out-numbered the adds and the
// canvas opened on a finished story whose cards are not changing.

/** `n` adds under `parent`. */
function addUnder(parent: string, n: number) {
  return Array.from({ length: n }, (_, i) =>
    planReviewItem({
      planItemId: `${parent}_add_${i}`,
      nodeId: `${parent}_add_${i}`,
      op: 'add',
      parentNodeId: parent,
    }),
  );
}

/** `n` modifies of committed cards under `parent`, each moving exactly `fields`. */
function modifyUnder(
  parent: string,
  n: number,
  fields: PlanItemChangeField[] = ['obsolescence', 'obsolescenceNote'],
) {
  const base = planReviewItem();
  return Array.from({ length: n }, (_, i) =>
    planReviewItem({
      planItemId: `${parent}_mod_${i}`,
      nodeId: `wi_${parent}_mod_${i}`,
      identifier: `MOTIR-${100 + i}`,
      op: 'modify',
      parentNodeId: parent,
      proposal: { ...base.proposal, op: 'modify', changedFields: fields },
    }),
  );
}

describe('isMarkOnlyProposal', () => {
  it('is true for a modify whose every changed field is a mark field', () => {
    const markSets: PlanItemChangeField[][] = [
      ['obsolescence'],
      ['obsolescence', 'obsolescenceNote'],
      ['supersedes'],
      ['supersededBy', 'obsolescence'],
    ];
    for (const fields of markSets) {
      expect(isMarkOnlyProposal(modifyUnder('wi_b', 1, fields)[0]!)).toBe(true);
    }
  });

  it('is false for a modify moving anything else, an empty change set, and add / remove', () => {
    expect(isMarkOnlyProposal(modifyUnder('wi_b', 1, ['obsolescence', 'title'])[0]!)).toBe(false);
    expect(isMarkOnlyProposal(modifyUnder('wi_b', 1, [])[0]!)).toBe(false);
    expect(isMarkOnlyProposal(addUnder('wi_a', 1)[0]!)).toBe(false);
    expect(isMarkOnlyProposal({ ...modifyUnder('wi_b', 1)[0]!, op: 'remove' })).toBe(false);
  });
});

describe('fullestContainer — mark-only modifies (Bug MOTIR-12097)', () => {
  it('3 adds under A beat 4 mark-only modifies under B — the reproduction', () => {
    const items = [...modifyUnder('wi_b', 4), ...addUnder('wi_a', 3)];

    expect(fullestContainer(items)!.parentNodeId).toBe('wi_a');
    expect(fullestContainer(items, { folders: true })!.parentNodeId).toBe('wi_a');
    // The spread itself is unchanged: B still holds more items, and both count.
    expect(planContainers(items)[0]).toMatchObject({ parentNodeId: 'wi_b', count: 4 });
    expect(planContainerCount(items)).toBe(2);
  });

  it('a non-mark modify and a remove are work too', () => {
    const titled = [...modifyUnder('wi_b', 4), ...modifyUnder('wi_a', 2, ['title'])];
    expect(fullestContainer(titled)!.parentNodeId).toBe('wi_a');

    const removed = [
      ...modifyUnder('wi_b', 4),
      ...modifyUnder('wi_a', 1).map((item) => ({ ...item, op: 'remove' as const })),
    ];
    expect(fullestContainer(removed)!.parentNodeId).toBe('wi_a');
  });

  it('mark-only items still count toward a container that also holds work', () => {
    // A: 2 adds + 2 marks = 4. C: 3 adds. A wins on its whole count.
    const items = [...addUnder('wi_a', 2), ...modifyUnder('wi_a', 2), ...addUnder('wi_c', 3)];

    expect(fullestContainer(items)).toMatchObject({ parentNodeId: 'wi_a', count: 4 });
  });

  it('a plan of nothing but marks opens where it did — on the container with the most', () => {
    const items = [...modifyUnder('wi_b', 2), ...modifyUnder('wi_d', 3)];

    expect(fullestContainer(items)).toMatchObject({ parentNodeId: 'wi_d', count: 3 });
  });

  it('work only at the TOP level still opens at the top, however many marks sit below', () => {
    const roots = addUnder('wi_root', 1).map((item) => ({ ...item, parentNodeId: null }));

    expect(fullestContainer([...modifyUnder('wi_b', 4), ...roots])).toBeNull();
  });
});
