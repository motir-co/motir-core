import { describe, expect, it } from 'vitest';
import { levelChangeFor, planElsewhere } from '@/lib/planning/levelChange';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// The two pure questions behind the level change band and the plan-elsewhere
// offer (bug MOTIR-6223; design MOTIR-6241). The rendered behaviour is held by
// `tests/components/plan-review-canvas-level-band.test.tsx`; this file holds the
// verdicts, including the tie-breaks no rendered fixture reaches cheaply.

function item(over: Partial<PlanReviewItemDto>): PlanReviewItemDto {
  return {
    planItemId: 'pi',
    op: 'add',
    nodeId: 'pi',
    parentNodeId: null,
    parentIdentifier: null,
    parentTitle: null,
    parentKind: null,
    parentTrail: [],
    folderId: null,
    folderPath: null,
    folderMissing: false,
    folderTrail: [],
    blockedByNodeIds: [],
    blockedByRemovedNodeIds: [],
    committedBlockedBy: [],
    blockerStubs: [],
    identifier: null,
    title: 'T',
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

const modifyOf = (id: string, over: Partial<PlanReviewItemDto> = {}) =>
  item({ planItemId: `m_${id}`, op: 'modify', nodeId: id, identifier: 'K-1', ...over });

describe('levelChangeFor', () => {
  it('is null at the ROOT — the project is not a work item a plan can change', () => {
    expect(levelChangeFor([modifyOf('x')], null, null)).toBeNull();
  });

  it('is null when no proposal is ABOUT the level', () => {
    expect(levelChangeFor([item({ parentNodeId: 'lvl' })], 'lvl', null)).toBeNull();
  });

  it('reads a modify as CHANGED, with its changed fields in change order and the proposed title', () => {
    const change = levelChangeFor(
      [
        modifyOf('lvl', {
          changes: [
            { field: 'title', from: 'Old', to: 'New' },
            { field: 'storyPoints', from: '3', to: '5' },
            // Carried as-is: the band labels it the way the card's diff line
            // does, degrading an unknown field to its wire name (MOTIR-3151).
            { field: 'somethingNew', from: 'a', to: 'b' },
          ],
        }),
      ],
      'lvl',
      null,
    );
    expect(change).toMatchObject({
      state: 'changed',
      fields: ['title', 'storyPoints', 'somethingNew'],
      proposedTitle: 'New',
    });
  });

  it('carries no proposed title when the title does not change', () => {
    const change = levelChangeFor(
      [modifyOf('lvl', { changes: [{ field: 'priority', from: 'low', to: 'high' }] })],
      'lvl',
      null,
    );
    expect(change).toMatchObject({ state: 'changed', proposedTitle: null, fields: ['priority'] });
  });

  it('reads a remove as REMOVED', () => {
    expect(levelChangeFor([modifyOf('lvl', { op: 'remove' })], 'lvl', null)?.state).toBe('removed');
  });

  it('draws nothing for a LOCKED modify or remove — a finished level cannot change', () => {
    expect(levelChangeFor([modifyOf('lvl', { statusCategory: 'done' })], 'lvl', null)).toBeNull();
    expect(
      levelChangeFor([modifyOf('lvl', { op: 'remove', statusCategory: 'done' })], 'lvl', null),
    ).toBeNull();
  });

  it('reads a level that is ITSELF an add as ADDED — until approve makes it real', () => {
    const add = item({ nodeId: 'pi_lvl' });
    expect(levelChangeFor([add], 'pi_lvl', null)?.state).toBe('added');
    expect(levelChangeFor([add], 'pi_lvl', 'declined')?.state).toBe('added');
    expect(levelChangeFor([add], 'pi_lvl', 'accepted')).toBeNull();
  });
});

describe('planElsewhere', () => {
  const epicTrail = [{ id: 'epic', identifier: 'K-1', title: 'Epic' }];
  const underEpic = (n: number) =>
    item({
      planItemId: `a${n}`,
      nodeId: `a${n}`,
      parentNodeId: 'epic',
      parentIdentifier: 'K-1',
      parentTitle: 'Epic',
      parentTrail: epicTrail,
    });
  const inLogin = [
    { id: 'epic', label: 'K-1 · Epic' },
    { id: 'login', label: 'K-2 · Login' },
  ];

  it('is null for an empty plan', () => {
    expect(planElsewhere([], inLogin, 'New')).toBeNull();
  });

  it('names the level the plan fills when it places nothing on the reader’s', () => {
    expect(planElsewhere([underEpic(1)], inLogin, 'New')).toEqual({
      levelId: 'epic',
      trail: [{ id: 'epic', label: 'K-1 · Epic', crumbKey: 'K-1' }],
    });
  });

  it('is null when a proposal sits ON the reader’s level', () => {
    expect(planElsewhere([underEpic(1)], [{ id: 'epic', label: 'K-1 · Epic' }], 'New')).toBeNull();
  });

  it('is null when a proposal changes the reader’s level ITSELF — the band says that', () => {
    expect(
      planElsewhere([underEpic(1), modifyOf('login', { parentNodeId: 'epic' })], inLogin, 'New'),
    ).toBeNull();
  });

  it('names the ROOT when that is where the plan is', () => {
    expect(planElsewhere([item({ nodeId: 'r1' })], inLogin, 'New')).toEqual({
      levelId: null,
      trail: [],
    });
  });

  it('names the level holding the MOST proposals', () => {
    const otherTrail = [{ id: 'other', identifier: 'K-9', title: 'Other' }];
    const underOther = (n: number) =>
      item({
        planItemId: `o${n}`,
        nodeId: `o${n}`,
        parentNodeId: 'other',
        parentIdentifier: 'K-9',
        parentTitle: 'Other',
        parentTrail: otherTrail,
      });
    expect(
      planElsewhere([underEpic(1), underOther(1), underOther(2)], inLogin, 'New')?.levelId,
    ).toBe('other');
  });

  it('breaks a tie toward the level NEAREST the reader', () => {
    // A cousin named first, the reader's own ancestor second — the ancestor wins.
    const cousin = item({
      planItemId: 'c',
      nodeId: 'c',
      parentNodeId: 'cousin',
      parentIdentifier: 'K-7',
      parentTitle: 'Cousin',
      parentTrail: [{ id: 'cousin', identifier: 'K-7', title: 'Cousin' }],
    });
    expect(planElsewhere([cousin, underEpic(1)], inLogin, 'New')?.levelId).toBe('epic');
  });

  it('leaves a full tie with the level the plan names first', () => {
    const a = item({ planItemId: 'x', nodeId: 'x' });
    const b = item({
      planItemId: 'y',
      nodeId: 'y',
      parentNodeId: 'cousin',
      parentIdentifier: 'K-7',
      parentTitle: 'Cousin',
      parentTrail: [{ id: 'cousin', identifier: 'K-7', title: 'Cousin' }],
    });
    // The reader is at the root-adjacent `solo`, sharing nothing with either.
    expect(planElsewhere([a, b], [{ id: 'solo', label: 'Solo' }], 'New')?.levelId).toBeNull();
  });
});
