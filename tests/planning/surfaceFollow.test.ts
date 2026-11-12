// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { followFromPlan, followFromTarget, followRequest } from '@/lib/planning/surfaceFollow';
import { planReview, planReviewItem } from '../helpers/planReview';

// THE FOLLOW-MOVE's TRIGGERS (MOTIR-6161, Story MOTIR-6154). The decision is a
// pure module precisely so the two triggers' precedence is one statement that can
// be ruled on, rather than an ordering that emerges from two effects.

const EPIC = { id: 'wi_1', identifier: 'MOTIR-1', title: 'Refine AI planning' };

describe('followFromTarget — the person ADDED a target', () => {
  it('turns the anchor read into a keyed request, through the arrival rule', () => {
    const req = followFromTarget({
      anchor: { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story', kind: 'story' },
      ancestors: [EPIC],
      hasChildren: true,
      folders: [],
    });

    // The SAME rule the surface arrived by — not a second answer to "where does
    // this target put the canvas".
    expect(req?.trail.map((c) => c.id)).toEqual(['wi_1', 'wi_3']);
    // Keyed on the target, so re-deriving it cannot ask for a second move.
    expect(req?.key).toBe('target:wi_3');
  });

  it('asks for NOTHING when the target cannot be seen', () => {
    // The no-existence-leak answer. A target the viewer cannot see degrades to
    // the root silently at arrival, and to no move at all here — never an error,
    // and never a move to a level that would be empty.
    expect(followFromTarget(null)).toBeNull();
  });

  it('asks for NOTHING when the trail would be empty', () => {
    // A `subtask` at the root of what the reader can see produces no trail, and a
    // move to the root is not a move.
    expect(
      followFromTarget({
        anchor: { id: 'wi_9', identifier: 'MOTIR-9', title: 'A subtask', kind: 'subtask' },
        ancestors: [],
        hasChildren: false,
        folders: [],
      }),
    ).toBeNull();
  });

  it("a CHILDLESS story under a parent moves to the story's OWN level (MOTIR-7621)", () => {
    // Not inside it — that level would be empty. The canvas stands where the
    // story is, among its siblings, with the target ring.
    const req = followFromTarget({
      anchor: { id: 'wi_3', identifier: 'MOTIR-3', title: 'The story', kind: 'story' },
      ancestors: [EPIC],
      hasChildren: false,
      folders: [],
    });
    expect(req?.trail.map((c) => c.id)).toEqual(['wi_1']);
  });

  it('a CHILDLESS root target FILED in a folder moves into that folder', () => {
    // The root level shows only the folder's door, not the filed card, so the
    // target is on screen only once the canvas stands inside its folder chain.
    const req = followFromTarget({
      anchor: { id: 'wi_8', identifier: 'MOTIR-8', title: 'A bug', kind: 'bug' },
      ancestors: [],
      hasChildren: false,
      folders: [{ id: 'f_1', name: 'To do' }],
    });
    expect(req?.trail.map((c) => c.id)).toEqual(['folder:f_1']);
    expect(req?.key).toBe('target:wi_8');
  });

  it('a CHILDLESS root target asks for nothing, so the PLAN can move the canvas later', () => {
    // MOTIR-7621 step 3: the leaf is already on screen at the root, so the target
    // trigger stays silent and `followRequest` falls through to `followFromPlan`
    // — which moves INSIDE the leaf once the plan proposes children under it.
    const fromTarget = followFromTarget({
      anchor: { id: 'wi_8', identifier: 'MOTIR-8', title: 'A bug', kind: 'bug' },
      ancestors: [],
      hasChildren: false,
      folders: [],
    });
    expect(fromTarget).toBeNull();

    const review = planReview([
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: 'wi_8',
        parentIdentifier: 'MOTIR-8',
        parentTitle: 'A bug',
        parentTrail: [{ id: 'wi_8', identifier: 'MOTIR-8', title: 'A bug' }],
      }),
    ]);
    const req = followRequest(fromTarget, followFromPlan(review, 'New'));
    expect(req?.key).toBe('plan:wi_8');
    expect(req?.trail.at(-1)?.id).toBe('wi_8');
  });
});

describe('followFromPlan — the plan showed where it LANDS', () => {
  it('follows a plan into a FOLDER — a folder is a level like any other', () => {
    // ⚠️ THE PREMISE `tests/e2e/cloud-plan-change-folders.spec.ts` RESTS ON. That
    // spec opens the surface from the project with no target, asks for work to be
    // FILED into a folder, and then reads the canvas — so whether the follow-move
    // fires for a folder decides which level that spec is looking at. It is ruled
    // on here, where it is one call, rather than inferred from a browser.
    //
    // It follows from `arrivalLevel` treating a folder as a container (the plan
    // page's own engine, reused by MOTIR-6161 rather than re-cut), but "follows
    // from" is not "asserted".
    const folderTrail = [{ id: 'f_archive', name: 'Archive' }];
    const review = planReview([
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: null,
        folderId: 'f_archive',
        folderTrail,
        folderMissing: false,
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: null,
        folderId: 'f_archive',
        folderTrail,
        folderMissing: false,
      }),
    ]);

    const req = followFromPlan(review, 'New');
    expect(req?.trail.map((c) => c.label)).toEqual(['Archive']);
  });

  it('asks for NOTHING when the plan files into a STALE folder', () => {
    // No level to navigate to, so no move — the same silence a target the viewer
    // cannot see gets.
    const review = planReview([
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: null,
        folderId: 'f_gone',
        folderTrail: [{ id: 'f_gone', name: 'Gone' }],
        folderMissing: true,
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: null,
        folderId: 'f_gone',
        folderTrail: [{ id: 'f_gone', name: 'Gone' }],
        folderMissing: true,
      }),
    ]);

    expect(followFromPlan(review, 'New')).toBeNull();
  });

  it('asks for the level the plan most fills, keyed on that level', () => {
    const review = planReview([
      planReviewItem({
        op: 'add',
        nodeId: 'p1',
        parentNodeId: 'wi_1',
        parentIdentifier: 'MOTIR-1',
        parentTitle: 'Refine AI planning',
        parentTrail: [{ id: 'wi_1', identifier: 'MOTIR-1', title: 'Refine AI planning' }],
      }),
      planReviewItem({
        op: 'add',
        nodeId: 'p2',
        parentNodeId: 'wi_1',
        parentIdentifier: 'MOTIR-1',
        parentTitle: 'Refine AI planning',
        parentTrail: [{ id: 'wi_1', identifier: 'MOTIR-1', title: 'Refine AI planning' }],
      }),
    ]);

    const req = followFromPlan(review, 'New');
    expect(req?.key).toBe('plan:wi_1');
    expect(req?.trail.at(-1)?.id).toBe('wi_1');
  });

  it('asks for NOTHING before there is a plan', () => {
    expect(followFromPlan(null, 'New')).toBeNull();
  });

  it('asks for NOTHING when the plan proposes only roots', () => {
    // A plan that names no container lands at the top level, which is where a
    // target-less surface already is — so there is no move, and nothing to
    // announce. The canvas is not asked to "move" to where it stands.
    const review = planReview([planReviewItem({ op: 'add', nodeId: 'p1', parentNodeId: null })]);
    expect(followFromPlan(review, 'New')).toBeNull();
  });
});

describe('followRequest — the FIRST to fire wins', () => {
  const fromTarget = { key: 'target:wi_3', trail: [{ id: 'wi_3', label: 'MOTIR-3 · The story' }] };
  const fromPlan = { key: 'plan:wi_1', trail: [{ id: 'wi_1', label: 'MOTIR-1 · The epic' }] };

  it('prefers the person’s own act over an inference about it', () => {
    expect(followRequest(fromTarget, fromPlan)).toBe(fromTarget);
  });

  it('falls to the plan when no target was added', () => {
    expect(followRequest(null, fromPlan)).toBe(fromPlan);
  });

  it('asks for nothing when neither fired', () => {
    expect(followRequest(null, null)).toBeNull();
  });
});
