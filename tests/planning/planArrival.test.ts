// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { arrivalLevel } from '@/lib/planning/planArrival';
import { planReviewItem } from '../helpers/planReview';

// WHERE A PLAN LANDS — the direct unit (MOTIR-6162's coverage clause).
//
// ⚠️ WHY THIS FILE EXISTS AT ALL, since the function is unchanged. It MOVED out
// of `components/planning/PlanReviewCanvas.tsx` (MOTIR-6161), and its coverage
// moved with it: every branch below used to be reached only through the plan
// page's component specs, which mount a canvas and a database to ask a pure
// question. Now that it is a lib module, the per-file gate on it is met by
// calling it — and the branches a component test reaches only incidentally
// (a folder level, a proposal-only ancestor chain, an archived ancestor) get an
// assertion that says what they are FOR rather than exercising them in passing.

const EPIC_TRAIL = [{ id: 'wi_e1', identifier: 'MOTIR-1', title: 'The epic' }];

describe('arrivalLevel — the container the plan most FILLS', () => {
  it('takes the level carrying the most proposals', () => {
    const items = [
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: 'wi_a',
        parentIdentifier: 'MOTIR-2',
        parentTitle: 'A',
        parentTrail: EPIC_TRAIL,
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: 'wi_a',
        parentIdentifier: 'MOTIR-2',
        parentTitle: 'A',
        parentTrail: EPIC_TRAIL,
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p3',
        parentNodeId: 'wi_b',
        parentIdentifier: 'MOTIR-3',
        parentTitle: 'B',
        parentTrail: EPIC_TRAIL,
      }),
    ];

    const arrival = arrivalLevel(items, 'New');
    expect(arrival?.id).toBe('wi_a');
    // The trail is the WHOLE committed chain down to it, not one crumb.
    expect(arrival?.trail.map((c) => c.id)).toEqual(['wi_e1']);
  });

  it('answers NOTHING for a plan that proposes only roots', () => {
    // Not a gap: a plan with no container opens at the top level, which is what
    // a genuine root should do.
    expect(
      arrivalLevel([planReviewItem({ op: 'add', nodeId: 'p1', parentNodeId: null })], 'New'),
    ).toBeNull();
  });

  it('answers NOTHING for an empty plan', () => {
    expect(arrivalLevel([], 'New')).toBeNull();
  });
});

describe('the trail down to the level', () => {
  it('names a PROPOSED ancestor with the proposed WORD, not a fabricated key', () => {
    // An un-materialized `add` has `identifier: null` BY CONSTRUCTION, and a
    // placeholder key would assert a work item that does not exist — on the one
    // surface whose whole promise is that nothing is real until approve. So the
    // crumb keeps the `KEY · Title` grammar and substitutes the SLOT.
    const items = [
      planReviewItem({
        op: 'add',
        nodeId: 'prop_story',
        identifier: null,
        title: 'A proposed story',
        parentNodeId: 'wi_e1',
        parentIdentifier: 'MOTIR-1',
        parentTitle: 'The epic',
        parentTrail: EPIC_TRAIL,
      }),
      planReviewItem({ op: 'add', nodeId: 'c1', parentNodeId: 'prop_story', parentTrail: [] }),
      planReviewItem({ op: 'add', nodeId: 'c2', parentNodeId: 'prop_story', parentTrail: [] }),
    ];

    const arrival = arrivalLevel(items, 'New');
    expect(arrival?.id).toBe('prop_story');
    expect(arrival?.trail.map((c) => c.label)).toEqual([
      'MOTIR-1 · The epic',
      'New · A proposed story',
    ]);
  });

  it('degrades to the single crumb the parent fields name when the chain cannot resolve', () => {
    // An EMPTY trail beside a non-null parent is the archived-ancestor case; it
    // degrades to the one crumb the parent fields still carry, so the canvas
    // never arrives with no breadcrumb at all.
    const items = [
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: 'wi_gone',
        parentIdentifier: 'MOTIR-9',
        parentTitle: 'An archived parent',
        parentTrail: [],
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: 'wi_gone',
        parentIdentifier: 'MOTIR-9',
        parentTitle: 'An archived parent',
        parentTrail: [],
      }),
    ];

    const arrival = arrivalLevel(items, 'New');
    expect(arrival?.trail.map((c) => c.label)).toEqual(['MOTIR-9 · An archived parent']);
  });

  it('carries NO crumb at all when neither a chain nor a parent name survives', () => {
    const items = [
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: 'wi_gone',
        parentIdentifier: null,
        parentTitle: null,
        parentTrail: [],
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: 'wi_gone',
        parentIdentifier: null,
        parentTitle: null,
        parentTrail: [],
      }),
    ];

    expect(arrivalLevel(items, 'New')?.trail).toEqual([]);
  });
});

describe('a FOLDER is a level', () => {
  it('arrives ON the folder, and its trail IS the folder chain', () => {
    const folderTrail = [{ id: 'f1', name: 'Bugs' }];
    const items = [
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: null,
        folderId: 'f1',
        folderTrail,
        folderMissing: false,
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: null,
        folderId: 'f1',
        folderTrail,
        folderMissing: false,
      }),
    ];

    const arrival = arrivalLevel(items, 'New');
    expect(arrival?.trail.map((c) => c.label)).toEqual(['Bugs']);
  });

  it('contributes NO crumb for a STALE folder — there is no level to navigate to', () => {
    const items = [
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: null,
        folderId: 'f1',
        folderTrail: [{ id: 'f1', name: 'Gone' }],
        folderMissing: true,
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: null,
        folderId: 'f1',
        folderTrail: [{ id: 'f1', name: 'Gone' }],
        folderMissing: true,
      }),
    ];

    const arrival = arrivalLevel(items, 'New');
    expect(arrival === null || arrival.trail.length === 0).toBe(true);
  });

  it('leads a PROPOSAL-ONLY chain with the topmost proposal’s own folder', () => {
    // Every ancestor is a proposal, so the walk runs out inside the plan. What
    // goes in front of them is the TOPMOST one's committed trail and its folder —
    // not the container's, whose trail already ends at the walked ancestors (a
    // root the plan modifies would otherwise be named twice, bug MOTIR-6078).
    const items = [
      planReviewItem({
        op: 'add',
        nodeId: 'prop_top',
        identifier: null,
        title: 'A proposed epic',
        parentNodeId: null,
        folderId: 'f1',
        folderTrail: [{ id: 'f1', name: 'Bugs' }],
        folderMissing: false,
        parentTrail: [],
      }),
      planReviewItem({ op: 'add', nodeId: 'c1', parentNodeId: 'prop_top', parentTrail: [] }),
      planReviewItem({ op: 'add', nodeId: 'c2', parentNodeId: 'prop_top', parentTrail: [] }),
    ];

    const arrival = arrivalLevel(items, 'New');
    expect(arrival?.id).toBe('prop_top');
    expect(arrival?.trail.map((c) => c.label)).toEqual(['Bugs', 'New · A proposed epic']);
  });

  it('stops walking a CYCLE rather than looping for ever', () => {
    // A cycle cannot be authored through the plan doors, and the walk guards it
    // anyway: `seen` is what makes this function total over whatever a payload
    // happens to contain.
    const items = [
      planReviewItem({
        op: 'add',
        nodeId: 'a',
        identifier: null,
        title: 'A',
        parentNodeId: 'b',
        parentTrail: [],
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'b',
        identifier: null,
        title: 'B',
        parentNodeId: 'a',
        parentTrail: [],
      }),
      planReviewItem({ op: 'add', nodeId: 'c1', parentNodeId: 'a', parentTrail: [] }),
      planReviewItem({ op: 'add', nodeId: 'c2', parentNodeId: 'a', parentTrail: [] }),
    ];

    const arrival = arrivalLevel(items, 'New');
    expect(arrival?.id).toBe('a');
    expect(arrival?.trail.length).toBeGreaterThan(0);
  });
});

describe('arrivalLevel — a plan that also marks finished work outdated (Bug MOTIR-12097)', () => {
  // The dogfooded plan's shape: 3 proposed subtasks under the story it is about,
  // and 4 mark-only `modify` items on the done subtasks of an older story.
  const STORY_TRAIL = [{ id: 'wi_story', identifier: 'MOTIR-11023', title: 'The new story' }];
  const OLD_TRAIL = [{ id: 'wi_old', identifier: 'MOTIR-7093', title: 'The finished story' }];

  function marks(n: number) {
    const base = planReviewItem();
    return Array.from({ length: n }, (_, i) =>
      planReviewItem({
        planItemId: `pi_mark_${i}`,
        nodeId: `wi_done_${i}`,
        identifier: `MOTIR-${7117 + i}`,
        op: 'modify',
        parentNodeId: 'wi_old',
        parentIdentifier: 'MOTIR-7093',
        parentTitle: 'The finished story',
        parentTrail: OLD_TRAIL,
        proposal: {
          ...base.proposal,
          op: 'modify',
          identifier: `MOTIR-${7117 + i}`,
          changedFields: ['obsolescence', 'obsolescenceNote'],
        },
      }),
    );
  }

  function adds(n: number) {
    return Array.from({ length: n }, (_, i) =>
      planReviewItem({
        planItemId: `pi_add_${i}`,
        nodeId: `pi_add_${i}`,
        op: 'add',
        parentNodeId: 'wi_story',
        parentIdentifier: 'MOTIR-11023',
        parentTitle: 'The new story',
        parentTrail: STORY_TRAIL,
      }),
    );
  }

  it('opens on the story holding the adds, not the finished story holding more marks', () => {
    const arrival = arrivalLevel([...marks(4), ...adds(3)], 'New');

    expect(arrival?.id).toBe('wi_story');
    expect(arrival?.trail.map((c) => c.id)).toEqual(['wi_story']);
  });

  it('a plan of marks alone still opens on the container holding them', () => {
    expect(arrivalLevel(marks(4), 'New')?.id).toBe('wi_old');
  });
});
