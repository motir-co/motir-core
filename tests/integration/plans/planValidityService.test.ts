import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planValidityService } from '@/lib/services/planValidityService';
import { buildProjection, projectedWorkItem } from '@/lib/services/planProjectionService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { sprintsService } from '@/lib/services/sprintsService';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import {
  isCoverageAdvisory,
  isMislabelledLinkAdvisory,
  type WorkItemValidityDto,
} from '@/lib/dto/workItems';
import type { ProposalInput } from '@/lib/dto/plans';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { NoActiveSprintError } from '@/lib/sprints/errors';
import { makeWorkItemFixture, createTestProject, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { seedBlockedBy } from '../../helpers/seedBlockedBy';
import { truncateAuthTables } from '../../helpers/db';
import { renderSections } from '@/lib/workItems/sections/render';
import { fixture as sectionsFixture } from '../../unit/workItems/sections/helpers/sectionFixture';

/**
 * Drop the target locks an UN-DECIDED plan holds, so a fixture can build a
 * SECOND open plan over the same card (MOTIR-5645).
 *
 * ⚠️ FIXTURE SURGERY, and it records a real consequence rather than dodging a
 * defect. A plan PARKS every committed target it names and holds it while the
 * plan is open, so a tenant can have at most ONE open plan per card — a second
 * is refused with `PlanTargetLockedError` (AMENDMENT 16 D4). The cases here need
 * several open plans over one card, which no tenant can now produce.
 *
 * The lock's own behaviour, including that refusal, is covered in
 * `tests/planning/planTargetParkDoor.test.ts`.
 */
async function freePlanTargets(planId: string): Promise<string> {
  await adminDb.planTargetLock.deleteMany({ where: { planId } });
  return planId;
}

// `planValidityService` (Story 7.28 · Subtask 7.28.1 / MOTIR-1386) over real
// Postgres — the PROJECTION-aware finishability engine. It answers the shipped
// validate_work_item / validate_sprint question over the live tree ⊕ a Plan's
// PlanItem delta, WITHOUT materializing. We assert each op kind (add/modify/
// remove), temp-ref resolution, loose vs tight, the remove-drops-edges case, and
// — critically — that the PROJECTION verdict equals the POST-materialize
// (approve) validate_work_item / validate_sprint verdict (the projection==
// materialize contract).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const mk = (
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'subtask',
  parentId?: string,
) =>
  workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind,
      title,
      parentId,
      // Typed so a leaf is not UNDER-AUTHORED (MOTIR-5427); containers cannot carry one.
      ...(kind === 'task' || kind === 'subtask' ? { type: 'code' as const } : {}),
    },
    fx.ctx,
  );

/**
 * A TASK one level below a root of its own ("Elsewhere"), in `projectId` (the
 * fixture's project by default). MOTIR-6411: a `blocked_by` joins two items at
 * the same depth below their nearest common ancestor, so an "outside the
 * subtree" blocker for a CHILD of a root story must itself sit one level down —
 * an unrelated ROOT task is cross-level. The edge then crosses parents, so a case
 * that expects `valid: true` also owes the parents' edge (MOTIR-6370).
 */
async function outsideTask(fx: WorkItemFixture, title: string, projectId = fx.projectId) {
  const elsewhere = await workItemsService.createWorkItem(
    { projectId, kind: 'story', title: `Elsewhere (${title})` },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId, kind: 'task', type: 'code', title, parentId: elsewhere.id },
    fx.ctx,
  );
  return Object.assign(item, { elsewhere });
}

const link = (fx: WorkItemFixture, fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

const putInSprint = (id: string, sprintId: string) =>
  adminDb.workItem.update({ where: { id }, data: { sprintId } });

const markDone = (id: string) =>
  adminDb.workItem.update({ where: { id }, data: { status: 'done' } });

async function freshPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Plan' }, fx.ctx);
  return plan.id;
}

function addProposal(
  fx: WorkItemFixture,
  planId: string,
  proposal: ProposalInput,
): Promise<PlanWithItemsDto> {
  return plansService.addProposals(planId, [proposal], fx.ctx);
}

const itemIdByTitle = (plan: PlanWithItemsDto, title: string): string =>
  plan.items.find((i) => i.proposedFields?.title === title)!.id;

/** Make an ACTIVE sprint (createSprint + startSprint), returning its id. */
async function activeSprint(fx: WorkItemFixture): Promise<string> {
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
  await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  return sprint.id;
}

describe('planValidityService.validateProjectedWorkItem — the projected subtree rule', () => {
  it('an `add` blocked_by an item OUTSIDE the target subtree is INVALID (loose) and names the real blocker', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const outside = await outsideTask(fx, 'Outside'); // not in Story's subtree, not done

    const planId = await freshPlan(fx);
    const p = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [outside.id],
    });
    await plansService.markPlanned(planId, fx.ctx);
    const addId = itemIdByTitle(p, 'New child');

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.key).toBe(story.identifier);
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: `planItem:${addId}`,
        blockedBy: outside.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('an out-of-subtree blocker that is DONE is satisfied under LOOSE but flagged under TIGHT', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const outside = await outsideTask(fx, 'Outside done');
    await markDone(outside.id);
    // The parents carry the edge too (MOTIR-6370), and theirs is done as well —
    // so the only question left is loose vs tight.
    await link(fx, story.id, outside.elsewhere.id);
    await markDone(outside.elsewhere.id);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [outside.id],
    });
    await plansService.markPlanned(planId, fx.ctx);

    const loose = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
      'loose',
    );
    expect(loose.valid).toBe(true);
    expect(loose.blockers).toEqual([]);

    const tight = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
      'tight',
    );
    expect(tight.valid).toBe(false);
    expect(tight.blockers.map((b) => b.blockedBy)).toContain(outside.identifier);
  });

  it('an `add` whose blocker is ANOTHER add IN the subtree is VALID (temp-ref resolution, in-set)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    const p1 = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Dep', kind: 'subtask' },
      parentRef: story.id,
    });
    const depId = itemIdByTitle(p1, 'Dep');
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [`planItem:${depId}`], // intra-plan blocker, both under Story
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
  });

  it('a temp-ref blocker pointing at an add OUTSIDE the subtree is named as the `planItem:<id>` temp-ref', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    // A backlog add outside Story's subtree, not done — one level down under a
    // root of its own, at the gated child's depth (MOTIR-6411).
    const elsewhere = await mk(fx, 'Elsewhere', 'story');
    const pDep = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Backlog dep', kind: 'task' },
      parentRef: elsewhere.id,
    });
    const depId = itemIdByTitle(pDep, 'Backlog dep');
    const pGated = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [`planItem:${depId}`],
    });
    await plansService.markPlanned(planId, fx.ctx);
    const gatedId = itemIdByTitle(pGated, 'Gated child');

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: `planItem:${gatedId}`,
        blockedBy: `planItem:${depId}`,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('a blocker the plan does NOT own is also reported as a WAIT; one the plan draws is not (MOTIR-9021)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const outside = await outsideTask(fx, 'Outside');
    await link(fx, story.id, outside.elsewhere.id); // LIVE, before the plan: Story blocked_by Elsewhere

    const planId = await freshPlan(fx);
    const p = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [outside.id],
    });
    await plansService.markPlanned(planId, fx.ctx);
    const addId = itemIdByTitle(p, 'New child');

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    // `valid` and `blockers` are unchanged: both edges still gate the subtree …
    expect(res.valid).toBe(false);
    expect(res.blockers.map((b) => b.blockedBy).sort()).toEqual(
      [outside.elsewhere.identifier, outside.identifier].sort(),
    );
    // … but only the edge in place before the plan is a wait.
    expect(res.waits).toEqual([
      {
        item: story.identifier,
        blockedBy: outside.elsewhere.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
    expect(res.waits!.some((w) => w.item === `planItem:${addId}`)).toBe(false);
  });

  it('a `modify` adding an out-of-subtree blocked_by edge is INVALID, and the verdict EQUALS post-materialize validate_work_item', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const outside = await outsideTask(fx, 'Outside'); // real, not done, not in subtree

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: child.id,
      patch: { blockedByAdd: [outside.id] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const projected = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(projected.valid).toBe(false);
    expect(projected.blockers).toEqual([
      {
        item: child.identifier,
        blockedBy: outside.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    // Equivalence: materialize the SAME plan, then validate the real result.
    await plansService.approvePlan(planId, fx.ctx);
    const materialized = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    expect(materialized).toEqual(projected);
  });

  it('a `remove` drops the target node AND every edge touching it (a removed blocker no longer gates)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const outside = await outsideTask(fx, 'Outside');
    await link(fx, child.id, outside.id); // LIVE: Child blocked_by Outside → live-invalid

    // Sanity: live (no plan) the story is invalid.
    const live = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(live.valid).toBe(false);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, { op: 'remove', workItemId: outside.id });
    await plansService.markPlanned(planId, fx.ctx);

    const projected = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(projected.valid).toBe(true);
    expect(projected.blockers).toEqual([]);

    // Equivalence: removing Outside (archive) makes the live verdict valid too.
    await plansService.approvePlan(planId, fx.ctx);
    const materialized = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    expect(materialized).toEqual(projected);
  });

  it('an unknown targetKey throws WorkItemNotFoundError; an unknown planId throws PlanNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    await expect(
      planValidityService.validateProjectedWorkItem(planId, 'MOTIR-999999', fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(
      planValidityService.validateProjectedWorkItem(
        'plan_does_not_exist',
        story.identifier,
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  // ── Validating a NEWLY-PROPOSED subtree by its temp-ref (MOTIR-1431) ──────────
  // The root may be a node THIS plan creates — a new story + its new subtasks —
  // not just an existing committed anchor.

  it('validates a NEW story (a proposed `add` root) by its `planItem:` temp-ref — VALID when its subtasks self-contain', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    // A whole new subtree: a new story, and two new subtasks under it (one gating the other).
    const pStory = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New story', kind: 'story' },
    });
    const storyItemId = itemIdByTitle(pStory, 'New story');
    const pDep = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Schema', kind: 'subtask' },
      parentRef: `planItem:${storyItemId}`,
    });
    const depId = itemIdByTitle(pDep, 'Schema');
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Service', kind: 'subtask' },
      parentRef: `planItem:${storyItemId}`,
      blockedByRefs: [`planItem:${depId}`], // in-subtree blocker
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      `planItem:${storyItemId}`,
      fx.ctx,
    );
    expect(res.key).toBe(`planItem:${storyItemId}`);
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
  });

  it('a new story whose subtask is blocked_by an OUT-OF-SUBTREE backlog add is INVALID, named by temp-refs', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const pStory = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New story', kind: 'story' },
    });
    const storyItemId = itemIdByTitle(pStory, 'New story');
    // A backlog add OUTSIDE the new story's subtree, not done — one level down
    // under a root of its own, at the gated subtask's depth (MOTIR-6411).
    const elsewhere = await mk(fx, 'Elsewhere', 'story');
    const pDep = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Backlog dep', kind: 'task' },
      parentRef: elsewhere.id,
    });
    const depId = itemIdByTitle(pDep, 'Backlog dep');
    const pGated = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated subtask', kind: 'subtask' },
      parentRef: `planItem:${storyItemId}`,
      blockedByRefs: [`planItem:${depId}`],
    });
    const gatedId = itemIdByTitle(pGated, 'Gated subtask');
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      `planItem:${storyItemId}`,
      fx.ctx,
    );
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: `planItem:${gatedId}`,
        blockedBy: `planItem:${depId}`,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('an unknown `planItem:` temp-ref root throws WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      planValidityService.validateProjectedWorkItem(planId, 'planItem:does_not_exist', fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('planValidityService.validateProjectedPlan — the WHOLE-forest rule (MOTIR-1550)', () => {
  // The headline case: the multi-root epic forest `generate_tree` emits, with a
  // CROSS-ROOT blocked_by edge. Iterating the single-subtree rule per root
  // false-positives it (the gate sits in a sibling subtree); the forest rule,
  // whose containing set is the whole projection, does not.
  it('a CROSS-ROOT blocked_by (story under epic B gated by a story under epic A) is FINISHABLE over the forest — and VALID only when the epics carry the edge', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    // Two new root "epics" (adds with no parentRef), each with one "story" child.
    const pEpicA = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Epic A', kind: 'story' },
    });
    const epicAId = itemIdByTitle(pEpicA, 'Epic A');
    const pEpicB = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Epic B', kind: 'story' },
    });
    const epicBId = itemIdByTitle(pEpicB, 'Epic B');
    const pStoryA = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Story A', kind: 'subtask' },
      parentRef: `planItem:${epicAId}`,
    });
    const storyAId = itemIdByTitle(pStoryA, 'Story A');
    const pStoryB = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Story B', kind: 'subtask' },
      parentRef: `planItem:${epicBId}`,
      blockedByRefs: [`planItem:${storyAId}`], // CROSS-ROOT: Story B (epic B) blocked_by Story A (epic A)
    });
    const storyBId = itemIdByTitle(pStoryB, 'Story B');
    await plansService.markPlanned(planId, fx.ctx);

    // FINISHABLE — the forest holds both roots, so the edge's gate is in S — but
    // not VALID (MOTIR-6370): the two stories sit under different parents that
    // carry no edge of their own.
    const forest = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(forest).toEqual({
      planId,
      valid: false,
      blockers: [],
      rejections: [],
      invalidEdges: [
        {
          item: `planItem:${storyBId}`,
          blockedBy: `planItem:${storyAId}`,
          itemParent: `planItem:${epicBId}`,
          blockerParent: `planItem:${epicAId}`,
        },
      ],
      crossLevelEdges: [],
      sectionFindings: expect.any(Array),
    });

    // The OTHER half: the same forest with epic B blocked_by epic A is VALID.
    const coveredPlanId = await freshPlan(fx);
    const cA = itemIdByTitle(
      await addProposal(fx, coveredPlanId, {
        op: 'add',
        proposedFields: { title: 'Epic A', kind: 'story' },
      }),
      'Epic A',
    );
    const cB = itemIdByTitle(
      await addProposal(fx, coveredPlanId, {
        op: 'add',
        proposedFields: { title: 'Epic B', kind: 'story' },
        blockedByRefs: [`planItem:${cA}`],
      }),
      'Epic B',
    );
    const cStoryA = itemIdByTitle(
      await addProposal(fx, coveredPlanId, {
        op: 'add',
        proposedFields: { title: 'Story A', kind: 'subtask' },
        parentRef: `planItem:${cA}`,
      }),
      'Story A',
    );
    await addProposal(fx, coveredPlanId, {
      op: 'add',
      proposedFields: { title: 'Story B', kind: 'subtask' },
      parentRef: `planItem:${cB}`,
      blockedByRefs: [`planItem:${cStoryA}`],
    });
    await plansService.markPlanned(coveredPlanId, fx.ctx);
    expect(await planValidityService.validateProjectedPlan(coveredPlanId, fx.ctx)).toEqual({
      planId: coveredPlanId,
      valid: true,
      blockers: [],
      rejections: [],
      invalidEdges: [],
      crossLevelEdges: [],
      sectionFindings: expect.any(Array),
    });

    // Proof of the defect the forest rule fixes: iterating the SINGLE-subtree
    // rule per root false-positives the cross-root edge — validating epic B's
    // subtree alone reports Story A (in epic A's subtree) as an unsatisfied blocker.
    const perRootB = await planValidityService.validateProjectedWorkItem(
      planId,
      `planItem:${epicBId}`,
      fx.ctx,
    );
    expect(perRootB.valid).toBe(false);
    expect(perRootB.blockers).toEqual([
      {
        item: `planItem:${storyBId}`,
        blockedBy: `planItem:${storyAId}`,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('a forest node blocked_by a not-done CROSS-PROJECT item is INVALID and names the cross-project blocker', async () => {
    const fx = await makeWorkItemFixture();
    // A second project in the SAME workspace holding the (real, not-done) blocker.
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    const qBlocker = await workItemsService.createWorkItem(
      { projectId: projectQ.id, kind: 'task', title: 'Cross-project blocker' },
      fx.ctx,
    );

    const planId = await freshPlan(fx);
    const pGated = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated', kind: 'task' }, // a root add in project PROD
      blockedByRefs: [qBlocker.id],
    });
    const gatedId = itemIdByTitle(pGated, 'Gated');
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: `planItem:${gatedId}`,
        blockedBy: qBlocker.identifier, // e.g. "BETA-1" — out of the PROD forest, not done
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('a DONE cross-project blocker is satisfied under LOOSE but flagged under TIGHT', async () => {
    const fx = await makeWorkItemFixture();
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    const qBlocker = await workItemsService.createWorkItem(
      { projectId: projectQ.id, kind: 'task', title: 'Cross-project done blocker' },
      fx.ctx,
    );
    await markDone(qBlocker.id);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated', kind: 'task' },
      blockedByRefs: [qBlocker.id],
    });
    await plansService.markPlanned(planId, fx.ctx);

    const loose = await planValidityService.validateProjectedPlan(planId, fx.ctx, 'loose');
    expect(loose.valid).toBe(true);
    expect(loose.blockers).toEqual([]);

    const tight = await planValidityService.validateProjectedPlan(planId, fx.ctx, 'tight');
    expect(tight.valid).toBe(false);
    expect(tight.blockers[0]?.blockedBy).toBe(qBlocker.identifier);
  });

  // The card floated "a new node blocked_by a real ARCHIVED item is flagged", but
  // the SHIPPED projection deliberately DROPS an edge to an archived/missing ref
  // (buildProjection excludes `row.archivedAt`, and the add-edge pass skips a ref
  // with no node) — "mirrors the archived-blocker read-exclusion". The forest rule
  // reuses that projection unchanged, so an archived blocker does not gate. We pin
  // that behaviour rather than the card's (inaccurate) expectation.
  it('a node blocked_by a real ARCHIVED item has its edge DROPPED → the forest is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const archived = await mk(fx, 'Archived blocker', 'task');
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated', kind: 'task' },
      blockedByRefs: [archived.id],
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res).toEqual({
      planId,
      valid: true,
      blockers: [],
      rejections: [],
      invalidEdges: [],
      crossLevelEdges: [],
      sectionFindings: expect.any(Array),
    });
  });

  it('an EMPTY plan (no items, no live tree) is vacuously valid', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res).toEqual({
      planId,
      valid: true,
      blockers: [],
      rejections: [],
      invalidEdges: [],
      crossLevelEdges: [],
      sectionFindings: expect.any(Array),
    });
  });

  // NOTE: a SAME-project blocker can never make the forest invalid — every
  // same-project node is a forest member, so it is always in S. The only forest-
  // invalidating gate is an OUT-of-forest (cross-project) not-done blocker; hence
  // the cross-project setup here to get an invalid-before / valid-after `remove`.
  it('a `remove` of the gated node clears a cross-project blocker → the forest becomes valid', async () => {
    const fx = await makeWorkItemFixture();
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    const qBlocker = await workItemsService.createWorkItem(
      { projectId: projectQ.id, kind: 'task', title: 'Cross blocker' },
      fx.ctx,
    );
    const gated = await mk(fx, 'Gated', 'task');
    await link(fx, gated.id, qBlocker.id); // LIVE cross-project: Gated blocked_by BETA-1 (not done)

    // Sanity: with an EMPTY plan the live forest is INVALID (out-of-forest gate).
    const emptyPlanId = await freshPlan(fx);
    await plansService.markPlanned(emptyPlanId, fx.ctx);
    const live = await planValidityService.validateProjectedPlan(emptyPlanId, fx.ctx);
    expect(live.valid).toBe(false);

    // Removing the gated node drops the edge → the projected forest is valid.
    const planId = await freshPlan(fx);
    await addProposal(fx, planId, { op: 'remove', workItemId: gated.id });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res).toEqual({
      planId,
      valid: true,
      blockers: [],
      rejections: [],
      invalidEdges: [],
      crossLevelEdges: [],
      sectionFindings: expect.any(Array),
    });
  });

  it('an unknown planId throws PlanNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      planValidityService.validateProjectedPlan('plan_does_not_exist', fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });
});

// MOTIR-6354 / MOTIR-6368 — the projected twin of validate_work_item's NON-gating
// `softBlocks`: every open projected blocked_by edge owned by a projected ANCESTOR.
describe('planValidityService.validateProjectedWorkItem — softBlocks (MOTIR-6368)', () => {
  it('a no-op plan reads the SAME softBlocks as the committed validate_work_item', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Parent epic', 'epic');
    const openEpic = await mk(fx, 'Open epic', 'epic');
    const story = await mk(fx, 'Story', 'story', epic.id);
    await link(fx, epic.id, openEpic.id);

    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    const projected = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    const committed = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    expect(projected.valid).toBe(true);
    expect(projected.softBlocks).toEqual([
      {
        via: { key: epic.identifier, title: 'Parent epic' },
        blockedBy: { key: openEpic.identifier, title: 'Open epic' },
        blockerStatus: 'todo',
      },
    ]);
    expect(projected.softBlocks).toEqual(committed.softBlocks);
  });

  it('a PROPOSED ancestor and a PROPOSED blocker are named by temp-ref and proposed title; a done blocker is skipped', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Epic', 'epic');
    // An epic is blocked only by another epic (MOTIR-6443), and the proposed
    // blocker sits beside the proposed story under the epic — same level.
    const epicBlocker = await mk(fx, 'Epic blocker', 'epic');
    const doneBlocker = await mk(fx, 'Done blocker', 'epic');
    await markDone(doneBlocker.id);
    await link(fx, epic.id, epicBlocker.id);
    await link(fx, epic.id, doneBlocker.id);

    const planId = await freshPlan(fx);
    const pB = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Proposed blocker', kind: 'story' },
      parentRef: epic.id,
    });
    const blockerRef = `planItem:${itemIdByTitle(pB, 'Proposed blocker')}`;
    const pS = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Proposed story', kind: 'story' },
      parentRef: epic.id,
      blockedByRefs: [blockerRef],
    });
    const storyRef = `planItem:${itemIdByTitle(pS, 'Proposed story')}`;
    const pC = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Proposed subtask', kind: 'subtask' },
      parentRef: storyRef,
    });
    const childRef = `planItem:${itemIdByTitle(pC, 'Proposed subtask')}`;
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(planId, childRef, fx.ctx);
    expect(res.valid).toBe(true);
    expect(res.softBlocks).toHaveLength(2);
    expect(res.softBlocks).toContainEqual({
      via: { key: epic.identifier, title: 'Epic' },
      blockedBy: { key: epicBlocker.identifier, title: 'Epic blocker' },
      blockerStatus: 'todo',
    });
    expect(res.softBlocks).toContainEqual({
      via: { key: storyRef, title: 'Proposed story' },
      blockedBy: { key: blockerRef, title: 'Proposed blocker' },
      blockerStatus: 'todo',
    });
  });

  it('a parent the plan REMOVES ends the chain — nothing above it is reported', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Epic', 'epic');
    const openEpic = await mk(fx, 'Open epic', 'epic');
    const story = await mk(fx, 'Story', 'story', epic.id);
    const subtask = await mk(fx, 'Subtask', 'subtask', story.id);
    await link(fx, epic.id, openEpic.id);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, { op: 'remove', workItemId: story.id });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      subtask.identifier,
      fx.ctx,
    );
    expect(res.softBlocks).toEqual([]);
  });
});

describe('planValidityService.validateProjectedSprint — the projected sprint rule', () => {
  it('a `modify` making an in-sprint item blocked_by a new BACKLOG add is INVALID; the add is named by temp-ref', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const inSprint = await mk(fx, 'In sprint', 'task');
    await putInSprint(inSprint.id, sprintId);

    const planId = await freshPlan(fx);
    const pAdd = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'New backlog dep', kind: 'task' },
    });
    const addId = itemIdByTitle(pAdd, 'New backlog dep');
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: inSprint.id,
      patch: { blockedByAdd: [`planItem:${addId}`] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(res.sprintId).toBe(sprintId);
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: inSprint.identifier,
        blockedBy: `planItem:${addId}`,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('valid once the blocker is also IN the sprint (pulled in)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const inSprint = await mk(fx, 'In sprint', 'task');
    const blocker = await mk(fx, 'Blocker', 'task');
    await putInSprint(inSprint.id, sprintId);
    await putInSprint(blocker.id, sprintId); // blocker also in the sprint

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: inSprint.id,
      patch: { blockedByAdd: [blocker.id] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
  });

  it('the projected sprint verdict EQUALS post-materialize validate_sprint (a modify→backlog edge)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const inSprint = await mk(fx, 'In sprint', 'task');
    const backlog = await mk(fx, 'Backlog blocker', 'task'); // real, not in sprint, not done
    await putInSprint(inSprint.id, sprintId);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: inSprint.id,
      patch: { blockedByAdd: [backlog.id] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const projected = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(projected.valid).toBe(false);
    expect(projected.blockers).toEqual([
      {
        item: inSprint.identifier,
        blockedBy: backlog.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    const materialized = await sprintsService.validateSprint(fx.projectId, null, fx.ctx);
    expect(materialized).toEqual(projected);
  });

  it('throws NoActiveSprintError when the project has no active sprint', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      planValidityService.validateProjectedSprint(planId, fx.ctx),
    ).rejects.toBeInstanceOf(NoActiveSprintError);
  });
});

// ── The PROSE-vs-GRAPH advisory over the PROJECTED tree (MOTIR-1969) ──────────
//
// The projected twin of the live advisory in `validate_work_item`, and the
// reason it is worth having here: the planner sees the gap BEFORE it
// materializes, which is the moment the miss is cheapest to fix. The advisory is
// a SEPARATE channel — it never changes `valid` / `blockers`.

/** A `[label](motir:<id>)` reference token — the shipped chip form. */
const refToken = (label: string, id: string) => `[${label}](motir:${id})`;
/** An intra-plan `[label](motir-ref:planItem:<id>)` token — a projected sibling. */
const planRefToken = (label: string, planItemId: string) =>
  `[${label}](motir-ref:planItem:${planItemId})`;

describe('planValidityService.validateProjectedWorkItem — prose-vs-graph advisories', () => {
  it("an `add`'s PROPOSED body naming a live not-done item with no `blockedByRefs` advises", async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const substrate = await mk(fx, 'The substrate it consumes', 'task');

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'New child',
        kind: 'subtask',
        descriptionMd: `## Acceptance criteria\n- built on ${refToken('SUB', substrate.id)}`,
      },
      parentRef: story.id,
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    // The verdict itself is untouched — the advisory is never a blocker.
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(res.advisories).toHaveLength(1);
    expect(res.advisories[0]).toMatchObject({
      referenced: substrate.identifier,
      referencedStatus: 'todo',
      severity: 'likely-missing-edge',
    });
    // The scanned card is the not-yet-materialized `add`, named by its temp-ref.
    expect(res.advisories[0]?.item).toMatch(/^planItem:/);
  });

  it('an `add` naming a SIBLING `add` by its temp-ref, with no `blockedByRefs`, advises', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    const withSibling = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Producer', kind: 'subtask', type: 'code' },
      parentRef: story.id,
    });
    const producerItemId = itemIdByTitle(withSibling, 'Producer');
    const withConsumer = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'Consumer',
        kind: 'subtask',
        descriptionMd: `## Acceptance criteria\n- reads what ${planRefToken('Producer', producerItemId)} writes`,
      },
      parentRef: story.id,
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(true);
    expect(res.advisories).toEqual([
      {
        item: `planItem:${itemIdByTitle(withConsumer, 'Consumer')}`,
        referenced: `planItem:${producerItemId}`,
        referencedStatus: 'todo',
        severity: 'likely-missing-edge',
      },
    ]);
  });

  it('wiring `blockedByRefs` to the named sibling CLEARS the advisory', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    const p = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Producer', kind: 'subtask', type: 'code' },
      parentRef: story.id,
    });
    const producerItemId = itemIdByTitle(p, 'Producer');
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'Consumer',
        kind: 'subtask',
        descriptionMd: `## Acceptance criteria\n- reads ${planRefToken('Producer', producerItemId)}`,
      },
      parentRef: story.id,
      blockedByRefs: [`planItem:${producerItemId}`],
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.advisories).toEqual([]);
  });

  it("a `modify`'s PATCHED body is what gets scanned, not the stored one", async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const substrate = await mk(fx, 'Substrate', 'task');

    // Stored body names nothing; the plan proposes one that names the substrate.
    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: child.id,
      patch: { descriptionMd: `Depends on ${refToken('SUB', substrate.id)}.` },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const before = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(before.advisories).toEqual([]); // the STORED body names nothing

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.advisories).toEqual([
      {
        item: child.identifier,
        referenced: substrate.identifier,
        referencedStatus: 'todo',
        severity: 'advisory',
      },
    ]);
  });

  it('a `done` referenced item produces no advisory on the projected tree either', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const shipped = await mk(fx, 'Shipped', 'task');
    await markDone(shipped.id);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'New child',
        kind: 'subtask',
        type: 'code',
        descriptionMd: `Built on ${refToken('SHIPPED', shipped.id)}.`,
      },
      parentRef: story.id,
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.advisories).toEqual([]);
  });

  it('the FOREST verdict carries no advisories — an advisory is a per-CARD property', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await mk(fx, 'Substrate', 'task');
    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'Root add',
        kind: 'task',
        descriptionMd: `## Acceptance criteria\n- needs ${refToken('SUB', substrate.id)}`,
      },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const forest = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    // `PlanValidityDto` is deliberately unchanged: the forest has no single
    // subject to attribute a body-vs-edges gap to. Per-card coverage is the
    // `validateProjectedWorkItem` call, asserted above.
    expect(forest).toEqual({
      planId,
      valid: true,
      blockers: [],
      rejections: [],
      invalidEdges: [],
      crossLevelEdges: [],
      sectionFindings: expect.any(Array),
    });
  });
});

describe('the MISLABELLED-LINK advisory on a PROPOSED body (MOTIR-9007)', () => {
  it("AC3: an `add`'s proposed body and a `modify`'s patched one both report it, and nothing is approved", async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const meant = await mk(fx, 'Meant', 'task');
    const opened = await mk(fx, 'Opened', 'task');

    const planId = await freshPlan(fx);
    const withAdd = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'New child',
        kind: 'subtask',
        type: 'code',
        descriptionMd: `Built on ${refToken(meant.identifier, opened.id)}.`,
      },
      parentRef: story.id,
    });
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: child.id,
      patch: { descriptionMd: `Reads ${refToken('PROD-404', 'cl_no_such_card')}.` },
    });
    await plansService.markPlanned(planId, fx.ctx);
    const addRef = `planItem:${itemIdByTitle(withAdd, 'New child')}`;

    // Per subtree, through `validate_work_item`'s planId path …
    const subtree = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(subtree.valid).toBe(true);
    const links = subtree.advisories.filter(isMislabelledLinkAdvisory);
    expect(links).toHaveLength(2);
    expect(links).toEqual(
      expect.arrayContaining([
        {
          kind: 'shape',
          item: child.identifier,
          severity: 'likely-mislabelled-link',
          label: 'PROD-404',
          targetId: 'cl_no_such_card',
          targetKey: null,

          field: 'descriptionMd',
        },
        {
          kind: 'shape',
          item: addRef,
          severity: 'likely-mislabelled-link',
          label: meant.identifier,
          targetId: opened.id,
          targetKey: opened.identifier,
          field: 'descriptionMd',
        },
      ]),
    );

    // … and over the whole plan, for `validate_plan`.
    const whole = (await planValidityService.projectedShapeAdvisories(planId, fx.ctx)).filter(
      isMislabelledLinkAdvisory,
    );
    expect(new Set(whole.map((a) => `${a.item} ${a.targetKey}`))).toEqual(
      new Set([`${child.identifier} null`, `${addRef} ${opened.identifier}`]),
    );

    // Read-only: the stored body is untouched and no card was created.
    const stored = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(stored.advisories.filter(isMislabelledLinkAdvisory)).toEqual([]);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(4);
  });

  it('a `modify` that rewrites ONLY the explanation is scanned, and the advisory names `explanationMd` (MOTIR-9938)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const meant = await mk(fx, 'Meant', 'task');
    const opened = await mk(fx, 'Opened', 'task');

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: child.id,
      patch: { explanationMd: `Why: ${refToken(meant.identifier, opened.id)}.` },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const expected = {
      kind: 'shape',
      item: child.identifier,
      severity: 'likely-mislabelled-link',
      label: meant.identifier,
      targetId: opened.id,
      targetKey: opened.identifier,
      field: 'explanationMd',
    };
    const subtree = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(subtree.advisories.filter(isMislabelledLinkAdvisory)).toEqual([expected]);
    expect(await planValidityService.projectedShapeAdvisories(planId, fx.ctx)).toEqual([expected]);
  });

  it('the whole-plan check scans PROPOSED bodies only — an untouched committed card is not the plan’s finding', async () => {
    const fx = await makeWorkItemFixture();
    const opened = await mk(fx, 'Opened', 'task');
    // A committed card already carrying a crossed link, which the plan never touches.
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        type: 'code',
        title: 'Old card',
        descriptionMd: refToken('PROD-99', opened.id),
      },
      fx.ctx,
    );
    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'Clean add',
        kind: 'task',
        type: 'code',
        descriptionMd: `Uses ${refToken(opened.identifier, opened.id)}.`,
      },
    });
    await plansService.markPlanned(planId, fx.ctx);

    expect(await planValidityService.projectedShapeAdvisories(planId, fx.ctx)).toEqual([]);
  });
});

// ── The QUIET half of every rule (Bug MOTIR-3123) ────────────────────────────
//
// `planValidityService.ts` was in NEITHER `include` nor `thresholds` in
// `vitest.config.ts` until this bug, so the ≥90%-per-file gate had never applied
// to the engine that answers *"can this plan be finished?"* — the check the
// planner runs before it hands a tree to a person, the one the three §4
// `validate-plan*` routes expose, and (MOTIR-3095) the one a PAT can reach.
//
// What the report showed missing was not diffuse: it was the SKIP half of each
// rule. Only-not-done-members-need-a-check, in both walks. The all-done sprint's
// early return. The parent-ready cascade's second half. The comparator that
// decides the wire order. None of them announces itself when it breaks — a
// re-checked done item makes a healthy plan look blocked, and an unstable order
// reads as noise in a verdict rather than as a defect. Hence a named case each.

describe('planValidityService — the not-done filter (MOTIR-3123)', () => {
  it('a DONE member is SKIPPED in the SUBTREE walk — its unsatisfied out-of-subtree blocker stops gating', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const outside = await outsideTask(fx, 'Outside'); // out of subtree, not done
    await link(fx, child.id, outside.id);

    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    // The edge is load-bearing while the gated member is not done…
    const gated = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(gated.valid).toBe(false);
    expect(gated.blockers).toEqual([
      {
        item: child.identifier,
        blockedBy: outside.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    // …and is not consulted at all once it is. The blocker has not moved.
    await markDone(child.id);
    const skipped = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(skipped.valid).toBe(true);
    expect(skipped.blockers).toEqual([]);
  });

  it('a DONE member is SKIPPED in the FOREST walk too — the cross-project blocker that gated it stops gating', async () => {
    const fx = await makeWorkItemFixture();
    // The only forest-invalidating gate is an OUT-of-forest blocker (every
    // same-project node is a forest member), so the blocker lives in project BETA.
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    const qBlocker = await workItemsService.createWorkItem(
      { projectId: projectQ.id, kind: 'task', title: 'Cross-project blocker' },
      fx.ctx,
    );
    const gatedItem = await mk(fx, 'Gated root', 'task'); // a REAL forest root

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: gatedItem.id,
      patch: { blockedByAdd: [qBlocker.id] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const gated = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(gated.valid).toBe(false);
    expect(gated.blockers).toEqual([
      {
        item: gatedItem.identifier,
        blockedBy: qBlocker.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    await markDone(gatedItem.id);
    const skipped = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    // THE SUBJECT: the done member drops out of the walk, so the cross-project
    // blocker that gated it stops gating. Asserted on `blockers` rather than on
    // the whole verdict, because finishing the target ALSO makes the plan
    // unapprovable — a `modify` of terminal work — which is a true statement
    // about a different question (MOTIR-3575), and the one the next assertion
    // pins so it cannot drift into a silent pass.
    expect(skipped.blockers).toEqual([]);
    expect(skipped.rejections.map((r) => r.code)).toEqual(['PLAN_TARGET_IMMUTABLE']);
    expect(skipped.valid).toBe(false);
  });

  it('a subtree whose EVERY member is done scans no BODIES either — the advisory pass returns early', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await mk(fx, 'Substrate', 'task'); // not done, and NOT wired
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    // A body that names a not-done item with no `blocked_by` edge — the exact
    // shape the prose-vs-graph advisory reports on a NOT-done card.
    await workItemsService.updateWorkItem(
      child.id,
      { descriptionMd: `## Acceptance criteria\n- needs ${refToken('SUB', substrate.id)}` },
      fx.ctx,
    );

    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const scanned = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(scanned.advisories.map((a) => a.item)).toEqual([child.identifier]);

    await markDone(story.id);
    await markDone(child.id);
    const empty = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(empty).toEqual({
      key: story.identifier,
      valid: true,
      blockers: [],
      invalidEdges: [],
      crossLevelEdges: [],
      advisories: [],
      softBlocks: [],
      sectionFindings: expect.any(Array),
    });
  });

  it('a target the plan REMOVES projects to an EMPTY subtree — vacuously valid, nothing walked and nothing scanned', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const outside = await outsideTask(fx, 'Outside');
    await link(fx, child.id, outside.id); // live-invalid before the plan

    const live = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(live.valid).toBe(false);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, { op: 'remove', workItemId: story.id });
    await plansService.markPlanned(planId, fx.ctx);

    // The ROOT still resolves against the LIVE tree — it exists — but it is not
    // in the projection, so the containing set is empty and the walk never runs.
    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res).toEqual({
      key: story.identifier,
      valid: true,
      blockers: [],
      invalidEdges: [],
      crossLevelEdges: [],
      advisories: [],
      softBlocks: [],
      sectionFindings: expect.any(Array),
    });
  });

  it('a CROSS-PROJECT blocker carried into the projection is not a LOCAL reference for the advisory pass', async () => {
    const fx = await makeWorkItemFixture();
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    // One level down in project Q, at the child's depth (MOTIR-6411).
    const qBlocker = await outsideTask(fx, 'Cross-project blocker', projectQ.id);
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: child.id,
      patch: { blockedByAdd: [qBlocker.id] },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([
      {
        item: child.identifier,
        blockedBy: qBlocker.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
    // The BETA node entered the projection off a live/plan edge with no browse
    // check, so it is deliberately EXCLUDED from the local reference map and
    // goes through the advisory service's own batched read + `filterBrowsable`.
    expect(res.advisories).toEqual([]);
  });
});

describe('planValidityService.validateProjectedSprint — the sprint rule’s quiet half (MOTIR-3123)', () => {
  it('an ALL-DONE projected sprint returns valid before any probe is built', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const member = await mk(fx, 'In sprint', 'task');
    const backlog = await mk(fx, 'Backlog blocker', 'task'); // not in the sprint, not done
    await putInSprint(member.id, sprintId);
    await link(fx, member.id, backlog.id);

    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const gated = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(gated.valid).toBe(false);
    expect(gated.blockers).toEqual([
      {
        item: member.identifier,
        blockedBy: backlog.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    await markDone(member.id);
    const allDone = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(allDone).toEqual({ sprintId, valid: true, blockers: [] });
  });

  it('the PARENT-READY cascade: a not-done in-sprint parent is gated by a child that is neither done nor in the sprint — and NOT by one that is done', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const parent = await mk(fx, 'Parent', 'story');
    const openChild = await mk(fx, 'Open child', 'subtask', parent.id); // backlog, not done
    const doneChild = await mk(fx, 'Done child', 'subtask', parent.id); // backlog, DONE
    await markDone(doneChild.id);
    await putInSprint(parent.id, sprintId);

    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(res.valid).toBe(false);
    // Exactly one blocker: the DONE child is satisfied under `loose` and never
    // reaches the verdict, which is the half of the cascade nothing asserted.
    expect(res.blockers).toEqual([
      {
        item: parent.identifier,
        blockedBy: openChild.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  // MOTIR-6354 / MOTIR-6368: validate_sprint checks HARD blockers only. This case
  // used to assert the ANCESTOR's blocker gated every in-sprint descendant; a
  // parent's block now reaches its children only as a SOFT block (overridable
  // with `--allow-soft-block`), so only each member's OWN edges are reported.
  it('an ANCESTOR’s blocker does NOT gate in-sprint descendants — only OWN edges are reported, and the wire order is by item then by blocker (MOTIR-6354)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    // Keys are allocated in creation order, so PROD-1 … PROD-5 below sort in the
    // order they are created — which is what makes the expected wire order legible.
    const story = await mk(fx, 'Story', 'story'); // PROD-1 — NOT in the sprint
    const childA = await mk(fx, 'Child A', 'subtask', story.id); // PROD-2 — in sprint
    const childB = await mk(fx, 'Child B', 'subtask', story.id); // PROD-3 — in sprint
    const blockerOne = await mk(fx, 'Blocker one', 'task'); // PROD-4 — backlog, not done
    const blockerTwo = await mk(fx, 'Blocker two', 'task'); // PROD-5 — backlog, not done
    await putInSprint(childA.id, sprintId);
    await putInSprint(childB.id, sprintId);
    await link(fx, story.id, blockerOne.id); // the ANCESTOR's edge — a SOFT block on A and B
    // A's own edges run to ROOT tasks one level above it — cross-level, which the
    // link door refuses (MOTIR-6369 / 6411). This case is about the sprint walk
    // over edges the tree can still carry, so they are seeded below the doors.
    await seedBlockedBy(fx, childA.id, blockerTwo.id); // A's OWN edge — HARD
    await seedBlockedBy(fx, childA.id, blockerOne.id); // A's OWN edge to the ancestor's blocker too

    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    expect(res.valid).toBe(false);
    // A is gated by its own two edges; B has no own edge, so the parent's block
    // does not reach it here. Sorted by gated item, then by blocker.
    expect(res.blockers).toEqual([
      {
        item: childA.identifier,
        blockedBy: blockerOne.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
      {
        item: childA.identifier,
        blockedBy: blockerTwo.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
    // The committed twin reads the same.
    expect(await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx)).toEqual(res);
  });
});

// MOTIR-6354 / MOTIR-6368 — the committed (`validate_sprint`) and projected
// (`validate_sprint {planId}`) twins give the SAME answer on the same fixtures.
describe('validate_sprint HARD blockers only — committed and projected twins agree (MOTIR-6368)', () => {
  async function bothVerdicts(fx: WorkItemFixture, sprintId: string) {
    const planId = await freshPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    const projected = await planValidityService.validateProjectedSprint(planId, fx.ctx);
    const committed = await sprintsService.validateSprint(fx.projectId, sprintId, fx.ctx);
    expect(projected).toEqual(committed);
    return projected;
  }

  it('an in-sprint subtask whose out-of-sprint story is blocked_by an open story is VALID', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const story = await mk(fx, 'Story (backlog)', 'story');
    const child = await mk(fx, 'Subtask', 'subtask', story.id);
    const openStory = await mk(fx, 'Open story', 'story');
    await putInSprint(child.id, sprintId);
    await link(fx, story.id, openStory.id);

    expect(await bothVerdicts(fx, sprintId)).toEqual({ sprintId, valid: true, blockers: [] });
  });

  it('an in-sprint subtask with its OWN blocked_by to an out-of-sprint, not-done subtask is INVALID, naming that edge', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const story = await mk(fx, 'Story (backlog)', 'story');
    const child = await mk(fx, 'Subtask', 'subtask', story.id);
    const other = await mk(fx, 'Other subtask', 'subtask', story.id);
    await putInSprint(child.id, sprintId);
    await link(fx, child.id, other.id);

    expect(await bothVerdicts(fx, sprintId)).toEqual({
      sprintId,
      valid: false,
      blockers: [
        {
          item: child.identifier,
          blockedBy: other.identifier,
          blockerStatus: 'todo',
          blockerSprintId: null,
        },
      ],
    });
  });

  it('an in-sprint story blocked_by an out-of-sprint open story is INVALID', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const story = await mk(fx, 'Story (in sprint)', 'story');
    const openStory = await mk(fx, 'Open story', 'story');
    await putInSprint(story.id, sprintId);
    await link(fx, story.id, openStory.id);

    expect(await bothVerdicts(fx, sprintId)).toEqual({
      sprintId,
      valid: false,
      blockers: [
        {
          item: story.identifier,
          blockedBy: openStory.identifier,
          blockerStatus: 'todo',
          blockerSprintId: null,
        },
      ],
    });
  });

  it('the children rule still fires, and a member blocked_by its OWN out-of-sprint child is reported ONCE', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await activeSprint(fx);
    const story = await mk(fx, 'Story (in sprint)', 'story');
    const child = await mk(fx, 'Child (backlog)', 'subtask', story.id);
    await putInSprint(story.id, sprintId);
    // A parent blocked_by its own child crosses levels, which the link door
    // refuses (MOTIR-6411); the sprint walk still meets such an edge, so it is
    // seeded below the doors.
    await seedBlockedBy(fx, story.id, child.id);

    expect(await bothVerdicts(fx, sprintId)).toEqual({
      sprintId,
      valid: false,
      blockers: [
        {
          item: story.identifier,
          blockedBy: child.identifier,
          blockerStatus: 'todo',
          blockerSprintId: null,
        },
      ],
    });
  });
});

// ── Why three defensive arms carry a `v8 ignore` instead of a case ───────────
//
// MOTIR-3123 asked for a named test per uncovered arm. Three of them cannot
// have one, and the reason is a property of the PROJECTION rather than of the
// walks: `buildProjection` only ever records an edge whose target it has
// already put in `nodes`, `remove` deletes a node together with every edge
// touching it, and `childrenByParent` is derived from the FINAL `nodes` map. So
// `if (!blocker)` / `if (!child)` can never fire — and because a member's
// blocker set is a `Set` of ids and every node's identifier is distinct, the
// `seen` de-duplication inside the two walks can never fire either. (The
// `addBlocker` de-duplication in the SPRINT walk is a different matter and IS
// live: a member blocked_by its OWN out-of-sprint child is reached by both the
// edge and the children rule — asserted above.)
//
// Per `notes.html` #175, a falsified negative premise is discharged by
// asserting the INVARIANT rather than by dropping the criterion. This is that
// assertion; the three `v8 ignore` directives in the service cite it.

describe('planValidityService — the projection invariant behind the walks’ defensive arms (MOTIR-3123)', () => {
  it('every edge target and every child resolves to a node, and identifiers are distinct — including after a `remove` drops a blocker', async () => {
    const fx = await makeWorkItemFixture();
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    // One level down in project Q, at the child's depth (MOTIR-6411).
    const qBlocker = await outsideTask(fx, 'Cross-project blocker', projectQ.id);
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    const doomed = await outsideTask(fx, 'Doomed blocker');
    const archived = await outsideTask(fx, 'Archived blocker');
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await link(fx, child.id, doomed.id);
    await link(fx, child.id, qBlocker.id);

    const planId = await freshPlan(fx);
    const pAdd = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Proposed child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [doomed.id, archived.id, qBlocker.id],
    });
    const addId = itemIdByTitle(pAdd, 'Proposed child');
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Second proposed child', kind: 'subtask' },
      parentRef: story.id,
      blockedByRefs: [`planItem:${addId}`],
    });
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: child.id,
      patch: { blockedByAdd: [archived.id] },
    });
    // LAST: the removal that strands every edge naming it.
    await addProposal(fx, planId, { op: 'remove', workItemId: doomed.id });
    await plansService.markPlanned(planId, fx.ctx);

    const proj = await buildProjection(planId, fx.ctx);

    // The `remove` really did land — otherwise the assertions below are vacuous.
    expect(proj.nodes.has(doomed.id)).toBe(false);
    expect(proj.removedIds.has(doomed.id)).toBe(true);
    // …and there is something to walk.
    expect(proj.blockedBy.size).toBeGreaterThan(0);
    expect(proj.childrenByParent.size).toBeGreaterThan(0);

    for (const [fromId, blockerIds] of proj.blockedBy) {
      expect(proj.nodes.has(fromId)).toBe(true);
      for (const blockerId of blockerIds) expect(proj.nodes.has(blockerId)).toBe(true);
    }
    for (const childIds of proj.childrenByParent.values()) {
      for (const childId of childIds) expect(proj.nodes.has(childId)).toBe(true);
    }
    const identifiers = [...proj.nodes.values()].map((n) => n.identifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });
});

describe('planValidityService.validateProjectedWorkItem — THE ESTIMATION GATE, projected', () => {
  // MOTIR-3110's earliest moment. Four cards have now been sealed over this gate
  // by an author who had already worked out the split and written it into the
  // card's own description (`notes.html` #323) — and a plan is where that author
  // is standing. Every sizing input has a PROPOSED form as well as a stored one,
  // so the projection must read the plan's numbers rather than the row's.

  it("reads an `add`'s PROPOSED sizing — the card has no row and no key yet", async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    const p = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'A 13-pointer',
        kind: 'subtask',
        executor: 'coding_agent',
        storyPoints: 13,
        estimateMinutes: 600,
      },
      parentRef: story.id,
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(res.advisories).toEqual([
      {
        kind: 'shape',
        item: `planItem:${itemIdByTitle(p, 'A 13-pointer')}`,
        severity: 'likely-over-gate-sizing',
        threshold: 'both',
        storyPoints: 13,
        estimateMinutes: 600,
      },
    ]);
  });

  it("reads a `modify`'s RE-SCOPE, in both directions", async () => {
    // Sparse-patch semantics both ways: a patch that pushes a right-sized card
    // over the gate fires, and a patch that brings an over-sized one back under
    // it goes quiet — which is what makes the advisory a live reading of the
    // PROPOSED tree rather than of the stored row.
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'Right-sized today',
        parentId: story.id,
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 3,
        estimateMinutes: 45,
      },
      fx.ctx,
    );

    const growPlan = await freshPlan(fx);
    await addProposal(fx, growPlan, {
      op: 'modify',
      workItemId: child.id,
      patch: { storyPoints: 13, estimateMinutes: 600 },
    });
    await plansService.markPlanned(growPlan, fx.ctx);
    const grown = await planValidityService.validateProjectedWorkItem(
      growPlan,
      story.identifier,
      fx.ctx,
    );
    expect(grown.advisories).toMatchObject([
      { item: child.identifier, severity: 'likely-over-gate-sizing', threshold: 'both' },
    ]);

    // The mirror: the stored row is now the over-sized one, and the SPLIT the
    // plan proposes is what clears the finding.
    //
    // The first plan still HOLDS the card (MOTIR-5645), so the second over the
    // same card would be refused. Free it — this case is about the advisory's
    // reading of a projected patch, not about the lock.
    await freePlanTargets(growPlan);
    await adminDb.workItem.update({
      where: { id: child.id },
      data: { storyPoints: 13, estimateMinutes: 600 },
    });
    const shrinkPlan = await freshPlan(fx);
    await addProposal(fx, shrinkPlan, {
      op: 'modify',
      workItemId: child.id,
      patch: { storyPoints: 5, estimateMinutes: 55 },
    });
    await plansService.markPlanned(shrinkPlan, fx.ctx);
    const shrunk = await planValidityService.validateProjectedWorkItem(
      shrinkPlan,
      story.identifier,
      fx.ctx,
    );
    expect(shrunk.advisories).toEqual([]);
  });

  it('falls through to the STORED sizing when the plan touches neither number', async () => {
    // The third arm of the sparse patch: an absent key leaves the row's own
    // number standing, so a re-titled card is still measured.
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'Oversized already',
        parentId: story.id,
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 13,
        estimateMinutes: 600,
      },
      fx.ctx,
    );

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'modify',
      workItemId: child.id,
      patch: { title: 'Renamed, not resized' },
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.advisories).toMatchObject([
      { item: child.identifier, severity: 'likely-over-gate-sizing' },
    ]);
  });

  it('a projected CHILD makes its parent a container, and silences the parent', async () => {
    // `hasChildren` comes from the PROJECTED adjacency, not the stored row: a
    // plan that adds a child under an over-sized leaf has turned it into a
    // container sized by rollup, and only the projection can see that.
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const leaf = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Oversized leaf today',
        parentId: story.id,
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 13,
        estimateMinutes: 600,
      },
      fx.ctx,
    );

    // Before the plan, it is a leaf and it fires.
    const live = await workItemsService.validateWorkItem(fx.projectId, story.identifier, fx.ctx);
    expect(live.advisories).toMatchObject([{ item: leaf.identifier }]);

    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'The first slice',
        kind: 'subtask',
        executor: 'coding_agent',
        storyPoints: 3,
        estimateMinutes: 45,
      },
      parentRef: leaf.id,
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.advisories).toEqual([]);
  });
});

describe('planValidityService.validateProjectedWorkItem — THE DESIGN GATE, projected', () => {
  // MOTIR-3178's earliest moment, and the one the card's own explanation names:
  // the author SEALING the plan. MOTIR-3154 said the correct shape out loud in
  // its own body — *the design amendment is this card's first child, with the
  // code criteria behind it* — and was then sealed as a childless leaf carrying
  // both halves (`notes.html` #329). A plan is where that is still one edit away.

  /** The reconstructed MOTIR-3154 criteria set — see MOTIR-3178's body. */
  const selfBlockingBody = [
    '## Acceptance criteria',
    '',
    '1. a `design/ai-planning/` three-file amendment — the accepted and declined node treatments',
    '2. decline no longer deletes the proposal rows',
    '3. the plan-detail canvas draws a DECIDED plan, one node per approved add',
  ].join('\n');

  it("fires on an `add`'s PROPOSED body — before the card has a row or a key", async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    const p = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'Draws and builds',
        kind: 'subtask',
        executor: 'coding_agent',
        descriptionMd: selfBlockingBody,
      },
      parentRef: story.id,
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(res.advisories).toEqual([
      {
        kind: 'shape',
        item: `planItem:${itemIdByTitle(p, 'Draws and builds')}`,
        severity: 'likely-self-blocking-design',
        designCriterionIndex: 1,
        surfaceCriterionIndex: 3,
      },
    ]);
  });

  it('goes QUIET when the plan LIFTS the design into a proposed sibling it is blocked_by', async () => {
    // HOLE 1 (MOTIR-3625) at the earliest possible moment. The remedy the
    // advisory names is a LIFT — the design criterion becomes its own `type:
    // design` card, placed BESIDE the card it gates, with a `blocked_by` edge as
    // the entire relationship between them — and a plan can express both halves
    // in one batch. Neither card exists yet, so the type comes from the plan's
    // own `proposedFields` and the edge from a `planItem:` temp-ref: this is the
    // one caller where BOTH inputs are projected rather than stored.
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    const design = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'The design amendment',
        kind: 'subtask',
        type: 'design',
        executor: 'coding_agent',
      },
      parentRef: story.id,
    });
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'Builds what the drawing decides',
        kind: 'subtask',
        executor: 'coding_agent',
        descriptionMd: selfBlockingBody,
      },
      parentRef: story.id,
      blockedByRefs: [`planItem:${itemIdByTitle(design, 'The design amendment')}`],
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(true);
    expect(res.advisories).toEqual([]);
  });

  it('goes QUIET when the plan gives the proposal a child — the PROJECTED adjacency decides', async () => {
    // The remedy, expressed as a plan: the design criterion becomes a child card
    // and the parent is a container. `hasChildren` comes from the projection, not
    // from the stored row, so the advisory has to disappear the moment the plan
    // proposes the split — which is exactly the feedback loop this member exists
    // to give the sealing author.
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const planId = await freshPlan(fx);
    const parent = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: {
        title: 'Draws and builds',
        kind: 'task',
        executor: 'coding_agent',
        descriptionMd: selfBlockingBody,
      },
      parentRef: story.id,
    });
    const parentRef = `planItem:${itemIdByTitle(parent, 'Draws and builds')}`;
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'The design amendment', kind: 'subtask', executor: 'coding_agent' },
      parentRef,
    });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(true);
    expect(res.advisories).toEqual([]);
  });
});

describe('validateProjectedPlan — the APPROVABILITY half (MOTIR-3575)', () => {
  // The defect: `validate_plan` answered VALID for the plan that then failed at
  // the approve button, and that yes is what made a plan carrying a dangling ref
  // safe to close (MOTIR-3560). Finishability was correctly answered; nobody was
  // asking the other question.

  /** Close a plan whose proposals are already appended, past the close gate.
   *  MOTIR-3573 refuses an unapprovable plan at `markPlanned`, which is the
   *  point — so a plan that is unapprovable AND `planned` can only be produced
   *  the way one arises in production: an edit after the close. */
  async function brokenPlannedPlan(
    fx: WorkItemFixture,
    proposals: Parameters<typeof plansService.addProposals>[1],
    breakIt: (planItemIds: string[]) => Promise<void>,
  ): Promise<string> {
    const planId = await freshPlan(fx);
    await plansService.addProposals(planId, proposals, fx.ctx);
    await plansService.markPlanned(planId, fx.ctx);
    const rows = await adminDb.planItem.findMany({
      where: { planId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    await breakIt(rows.map((r) => r.id));
    return planId;
  }

  it('⚠️ IS INVALID for a plan the approve button would refuse, even with a clean dependency closure', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await brokenPlannedPlan(
      fx,
      [{ op: 'add', proposedFields: { title: 'Hangs off nothing', kind: 'task' } }],
      async ([addId]) => {
        await adminDb.planItem.update({
          where: { id: addId! },
          data: { parentRef: 'wi_does_not_exist' },
        });
      },
    );

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);

    // THE assertion this card exists for: it used to be `valid: true`.
    expect(res.valid).toBe(false);
    expect(res.blockers).toEqual([]); // the dependency closure really is clean
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections[0]!.code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(res.rejections[0]!.reason).toBe('dangling');
    expect(res.rejections[0]!.message).toContain('names no work item');
  });

  it('reports a GRAMMAR violation and a TERMINAL `modify` target, each with its own code', async () => {
    const fx = await makeWorkItemFixture();

    const grammar = await brokenPlannedPlan(
      fx,
      [{ op: 'add', proposedFields: { title: 'Orphan', kind: 'task' } }],
      async ([addId]) => {
        const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: addId! } });
        await adminDb.planItem.update({
          where: { id: addId! },
          data: {
            proposedFields: {
              ...(row.proposedFields as object),
              kind: 'subtask',
            } as Prisma.InputJsonValue,
          },
        });
      },
    );
    const grammarRes = await planValidityService.validateProjectedPlan(grammar, fx.ctx);
    expect(grammarRes.valid).toBe(false);
    expect(grammarRes.rejections[0]!.code).toBe('PLAN_GRAMMAR_VIOLATION');
    expect(grammarRes.rejections[0]!.reason).toBe('illegal_parent');

    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Shipped' },
      fx.ctx,
    );
    const immutable = await brokenPlannedPlan(
      fx,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'Rewritten' } }],
      async () => {
        // The target ships while the plan waits — the drift approve exists for. A
        // SYSTEM write (a merge's cascade), because the plan hold refuses a hand
        // move out of `planning` while the plan is undecided (AMENDMENT 21).
        await withWorkspaceContext(fx.ctx, (tx) =>
          workItemsService.applyStatusTransition(target.id, 'done', fx.ctx, tx, { system: true }),
        );
      },
    );
    const immutableRes = await planValidityService.validateProjectedPlan(immutable, fx.ctx);
    expect(immutableRes.valid).toBe(false);
    expect(immutableRes.rejections[0]!.code).toBe('PLAN_TARGET_IMMUTABLE');
    // Immutability has exactly one shape, so it carries no narrower reason.
    expect(immutableRes.rejections[0]!.reason).toBeNull();
  });

  it('names the offending PROPOSAL as a `planItem:` ref — the same form `blockers` uses', async () => {
    const fx = await makeWorkItemFixture();
    let offending = '';
    const planId = await brokenPlannedPlan(
      fx,
      [{ op: 'add', proposedFields: { title: 'Hangs off nothing', kind: 'task' } }],
      async ([addId]) => {
        offending = addId!;
        await adminDb.planItem.update({
          where: { id: addId! },
          data: { parentRef: 'wi_does_not_exist' },
        });
      },
    );

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res.rejections[0]!.item).toBe(`${TEMP_REF_PREFIX}${offending}`);
  });

  it('⚠️ `blockers` KEEPS ITS EXACT MEANING — a finishability failure is reported unchanged, with no rejection', async () => {
    // The regression guard for every existing caller: widening the verdict must
    // not disturb the half that already worked.
    const fx = await makeWorkItemFixture();
    // CROSS-PROJECT, so it is genuinely outside the plan's forest — a
    // same-project root is IN the forest and therefore satisfied-because-in-set.
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'GAMA',
    });
    const blocker = await workItemsService.createWorkItem(
      { projectId: projectQ.id, kind: 'task', title: 'Out-of-forest blocker' },
      fx.ctx,
    );
    const planId = await freshPlan(fx);
    const appended = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Gated', kind: 'task' },
      blockedByRefs: [blocker.id],
    });
    const gatedId = itemIdByTitle(appended, 'Gated');
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res.valid).toBe(false);
    expect(res.rejections).toEqual([]);
    expect(res.blockers).toEqual([
      {
        item: `${TEMP_REF_PREFIX}${gatedId}`,
        blockedBy: blocker.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });

  it('answers for a GENERATING plan — which is the whole point, since that is when it can still be fixed', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The story' },
      fx.ctx,
    );
    const planId = await freshPlan(fx);
    await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'Its subtask', kind: 'subtask' },
      parentRef: story.id,
    });

    // Before `final: true` — no close, no `planned`.
    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res.valid).toBe(true);
    expect(res.rejections).toEqual([]);

    // …and a plan it calls valid CLOSES and APPROVES, which is what makes the
    // claim mean anything at all.
    await plansService.markPlanned(planId, fx.ctx);
    const approved = await plansService.approvePlan(planId, fx.ctx);
    expect(approved.status).toBe('approved');
  });
});

// ── A `modify`'s `patch.parentRef` MOVES the card IN THE PROJECTION (MOTIR-3867) ──
//
// MOTIR-3859 gave `PlanItemPatch` the SITS half of D3's pair; the PROJECTION was
// not widened with it, so `buildProjection` read `parentId` from the live row and
// from an `add`'s `parentRef` and from nowhere else. An authoring agent that
// appended the `modify` and projected the target to check its own work was shown
// the card's OLD parent — not an error, not a null, but the same correct-looking
// value the call returned before the plan existed.
//
// These live here rather than in `modifyReparent.test.ts` (the APPROVE side) or in
// `tests/mcp/plan-projection-gate.test.ts` (the MCP surface, whose own comment says
// the projection RULES belong to this file): what is asserted is the merge.
describe("a `modify`'s `patch.parentRef` moves the card in the PROJECTION (MOTIR-3867)", () => {
  /** Append ONE `modify` carrying just a re-parent. */
  const reparent = (
    fx: WorkItemFixture,
    planId: string,
    workItemId: string,
    parentRef: string | null,
  ) =>
    plansService.addProposals(planId, [{ op: 'modify', workItemId, patch: { parentRef } }], fx.ctx);

  it('an explicit ref re-parents the projected node, and `childrenByParent` moves it on BOTH sides', async () => {
    const fx = await makeWorkItemFixture();
    const from = await mk(fx, 'The story it leaves', 'story');
    const to = await mk(fx, 'The story it joins', 'story');
    const card = await mk(fx, 'The card', 'subtask', from.id);

    const planId = await freshPlan(fx);
    await reparent(fx, planId, card.id, to.id);

    const proj = await buildProjection(planId, fx.ctx);
    expect(proj.nodes.get(card.id)!.parentId).toBe(to.id);
    // BOTH adjacency entries, in one assertion — the vacated parent losing the
    // child and the joined parent gaining it are two separate ways for a derived
    // map to be wrong, and reading only the moved node's `parentId` catches neither.
    expect(proj.childrenByParent.get(from.id) ?? []).toEqual([]);
    expect(proj.childrenByParent.get(to.id) ?? []).toEqual([card.id]);

    // …and the same thing through the READ an authoring agent actually calls —
    // `get_work_item { planId }`. This is the assertion the defect was ABOUT: the
    // wrong answer was never an error or a null, it was `from` — the card's real,
    // current, correct-looking parent, which reads as *the re-parent did not take*.
    const detail = await projectedWorkItem(planId, card.identifier, fx.ctx);
    expect(detail.target.parent).toBe(to.identifier);
    expect(detail.parent!.key).toBe(to.identifier);
    const vacated = await projectedWorkItem(planId, from.identifier, fx.ctx);
    expect(vacated.committedChildren).toEqual([]);
    const joined = await projectedWorkItem(planId, to.identifier, fx.ctx);
    expect(joined.committedChildren.map((r) => r.key)).toEqual([card.identifier]);
  });

  it('an explicit `null` projects the target at the ROOT, and the vacated parent loses it', async () => {
    const fx = await makeWorkItemFixture();
    // A `task` may sit at the root; a `subtask` may not — the same arm
    // `modifyReparent.test.ts` pins on the approve side.
    const epic = await mk(fx, 'The epic', 'epic');
    const card = await mk(fx, 'The card', 'task', epic.id);

    const planId = await freshPlan(fx);
    await reparent(fx, planId, card.id, null);

    const proj = await buildProjection(planId, fx.ctx);
    expect(proj.nodes.get(card.id)!.parentId).toBeNull();
    expect(proj.childrenByParent.get(epic.id) ?? []).toEqual([]);
  });

  it('an ABSENT `parentRef` leaves the LIVE parent — the sparse contract, as its own case', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'The story', 'story');
    const card = await mk(fx, 'The card', 'subtask', story.id);

    const planId = await freshPlan(fx);
    // A patch that changes something ELSE. This is the case that decides the
    // implementation: `'parentRef' in patch` versus `patch.parentRef ?? null`.
    // Collapsing absent into `null` would project EVERY untouched `modify` at the
    // project root, and the two explicit cases above would still pass.
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: card.id, patch: { title: 'Renamed only' } }],
      fx.ctx,
    );

    const proj = await buildProjection(planId, fx.ctx);
    expect(proj.nodes.get(card.id)!.parentId).toBe(story.id);
    expect(proj.childrenByParent.get(story.id) ?? []).toEqual([card.id]);
  });

  it('the projected SUBTREE verdict is taken over the POST-move containment, on both sides of the move', async () => {
    const fx = await makeWorkItemFixture();
    const from = await mk(fx, 'The story it leaves', 'story');
    const to = await mk(fx, 'The story it joins', 'story');
    const leaf = await mk(fx, 'The leaf that moves', 'subtask', from.id);
    // The blocker lives under `to`, so containment is the ONLY thing that decides
    // either verdict: it is out-of-subtree for `from` and in-subtree for `to`.
    const gate = await mk(fx, 'The gate', 'subtask', to.id);
    await link(fx, leaf.id, gate.id);

    const planId = await freshPlan(fx);
    // Before the move the plan is empty, so this is the LIVE verdict.
    const beforeFrom = await planValidityService.validateProjectedWorkItem(
      planId,
      from.identifier,
      fx.ctx,
    );
    expect(beforeFrom.valid).toBe(false);
    expect(beforeFrom.blockers).toEqual([
      {
        item: leaf.identifier,
        blockedBy: gate.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);

    await reparent(fx, planId, leaf.id, to.id);

    // The vacated subtree no longer CONTAINS the gated leaf, so it is finishable…
    const afterFrom = await planValidityService.validateProjectedWorkItem(
      planId,
      from.identifier,
      fx.ctx,
    );
    expect(afterFrom.valid).toBe(true);
    expect(afterFrom.blockers).toEqual([]);
    // …and the joined subtree now contains BOTH ends of the edge, which is what
    // makes it satisfied there. Read `to` before the move for the control.
    const afterTo = await planValidityService.validateProjectedWorkItem(
      planId,
      to.identifier,
      fx.ctx,
    );
    expect(afterTo.valid).toBe(true);
    // TIGHT is what proves the move was actually READ: under `tight` a blocker is
    // satisfied ONLY by being in the set, so the leaf's edge passes here for
    // exactly one reason — the projection put the leaf inside `to`.
    const tightTo = await planValidityService.validateProjectedWorkItem(
      planId,
      to.identifier,
      fx.ctx,
      'tight',
    );
    expect(tightTo.valid).toBe(true);
    const tightFrom = await planValidityService.validateProjectedWorkItem(
      planId,
      from.identifier,
      fx.ctx,
      'tight',
    );
    expect(tightFrom.valid).toBe(true);
  });

  it("`validate_plan`'s whole-forest walk descends the POST-move tree", async () => {
    const fx = await makeWorkItemFixture();
    const from = await mk(fx, 'The story it leaves', 'story');
    const to = await mk(fx, 'The story it joins', 'story');
    const leaf = await mk(fx, 'The leaf that moves', 'subtask', from.id);
    // A done blocker on the leaf's own level (a subtask under a third story), with
    // the parents' edge the post-move tree owes (`to` → `elsewhere`), so neither
    // `invalidEdges` nor `crossLevelEdges` (MOTIR-6509) speaks: this case is about
    // the walk's path after a move, not about the edge.
    const elsewhere = await mk(fx, 'The story it waits on', 'story');
    const outside = await mk(fx, 'Outside the moving subtrees', 'subtask', elsewhere.id);
    await markDone(outside.id);
    await link(fx, leaf.id, outside.id);
    await link(fx, to.id, elsewhere.id);

    const planId = await freshPlan(fx);
    await reparent(fx, planId, leaf.id, to.id);

    const forest = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(forest.valid).toBe(true);
    expect(forest.blockers).toEqual([]);

    // ⚠️ MEASURED, and stated because it is not what the phrase "judges the
    // post-move containment" suggests. `validateProjectedPlan`'s member set S is
    // the WHOLE projected forest — every node reachable down from every root — so
    // an intra-project move cannot add or drop a member, and the forest verdict is
    // INVARIANT under a re-parent by construction. What the move changes is the
    // PATH the walk takes to the leaf, and that is what is asserted here: the leaf
    // is reached as a child of `to` and not of `from`. The verdict that a
    // containment change moves is the SUBTREE one, asserted in the case above —
    // which is the read `validate_work_item { planId }` answers with.
    const proj = await buildProjection(planId, fx.ctx);
    expect(proj.childrenByParent.get(to.id) ?? []).toEqual([leaf.id]);
    expect(proj.childrenByParent.get(from.id) ?? []).toEqual([]);
  });

  it('a `planItem:` parent PROJECTS the card under the proposed node (AMENDMENT 18 §1, MOTIR-6050)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'The epic', 'epic');
    const story = await mk(fx, 'The story', 'story', epic.id);
    const card = await mk(fx, 'The card', 'subtask', story.id);

    const planId = await freshPlan(fx);
    const added = await addProposal(fx, planId, {
      op: 'add',
      proposedFields: { title: 'A proposed story', kind: 'story' },
      parentRef: epic.id,
    });
    const proposedRef = `${TEMP_REF_PREFIX}${itemIdByTitle(added, 'A proposed story')}`;

    // AMENDMENT 11 D2 refused this at the append; AMENDMENT 18 §1 admits it, and
    // `buildProjection`'s `resolveRef` already maps a temp-ref to its projected
    // node, so the card leaves its old story and joins the proposed one.
    await reparent(fx, planId, card.id, proposedRef);

    const proj = await buildProjection(planId, fx.ctx);
    expect(proj.nodes.get(card.id)!.parentId).toBe(proposedRef);
  });
});

// ── The CONTAINER-COVERAGE advisory over the PROJECTED tree (MOTIR-5403) ──────
//
// The projected twin of MOTIR-5362's committed check, and the one that fires at
// the moment adoption actually happens: an author re-parents an existing card
// under a story while writing a plan. Adoption over a projection compares FILING
// instants, with a proposal filed at approve — the pure half pins that instant in
// `tests/workItems/containerCoverage.test.ts`; this half asserts the rows the
// projection feeds it and that the verdict never moves.

describe('planValidityService.validateProjectedWorkItem — the CONTAINER-COVERAGE advisory (MOTIR-5403)', () => {
  /** Criterion 1 names a seam no card below owns; criterion 2 the refusal copy `GATE_TITLE` carries. */
  const COVERAGE_BODY = [
    '## Acceptance criteria',
    '',
    '- `GitProvider` declares `mergeChangeRequest` and the provider returns a typed result.',
    '- Every refusal renders in the merge control.',
  ].join('\n');
  const GATE_TITLE = 'The merge gate — every refusal renders in the control';
  const WIDENED_TITLE =
    'The `GitProvider.mergeChangeRequest` seam and every refusal in the control';

  const storyWithCriteria = (fx: WorkItemFixture, title: string, parentId?: string) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title, descriptionMd: COVERAGE_BODY, parentId },
      fx.ctx,
    );

  /** Move a row's filing instant relative to another's. */
  const fileRelativeTo = (id: string, other: string | Date, offsetMs: number) =>
    adminDb.workItem.update({
      where: { id },
      data: { createdAt: new Date(new Date(other).getTime() + offsetMs) },
    });

  /** A card filed under ANOTHER story a minute before `story` existed — the adoption shape. */
  async function olderCard(
    fx: WorkItemFixture,
    story: { createdAt: string | Date },
    title: string = GATE_TITLE,
  ) {
    const home = await mk(fx, 'Where the card was first filed', 'story');
    const card = await mk(fx, title, 'subtask', home.id);
    await fileRelativeTo(card.id, story.createdAt, -60_000);
    return card;
  }

  const reparent = (
    fx: WorkItemFixture,
    planId: string,
    workItemId: string,
    parentRef: string,
    title?: string,
  ) =>
    plansService.addProposals(
      planId,
      [
        {
          op: 'modify',
          workItemId,
          patch: title === undefined ? { parentRef } : { parentRef, title },
        },
      ],
      fx.ctx,
    );

  const coverageOf = (res: WorkItemValidityDto) => res.advisories.filter(isCoverageAdvisory);

  it('a plan that re-parents an OLDER card under a story reports the criterion that card does not own — still VALID', async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyWithCriteria(fx, 'Motir merges the pull request');
    const gate = await olderCard(fx, story);

    // The control: the committed tree has no such child, so the committed check
    // is structurally blind to the adoption the plan is about to make.
    const committed = await workItemsService.validateWorkItem(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(committed)).toEqual([]);

    const planId = await freshPlan(fx);
    await reparent(fx, planId, gate.id, story.id);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(res.valid).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(coverageOf(res)).toEqual([
      {
        kind: 'coverage',
        item: story.identifier,
        severity: 'likely-unowned-criterion',
        criterionIndex: 1,
        adoptedChildren: [gate.identifier],
      },
    ]);
  });

  it("widening the adopted card's TITLE in the same plan clears the finding", async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyWithCriteria(fx, 'Motir merges the pull request');
    const gate = await olderCard(fx, story);
    const planId = await freshPlan(fx);
    const plan = await reparent(fx, planId, gate.id, story.id);
    const before = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(before)).toHaveLength(1);

    // One `modify` per target, so the correction REPLACES the proposal: withdraw
    // it (which releases the target) and append the re-parent with the wider title.
    const modifyId = plan.items.find((i) => i.op === 'modify' && i.workItemId === gate.id)!.id;
    await plansService.withdrawProposal(planId, modifyId, fx.ctx);
    await reparent(fx, planId, gate.id, story.id, WIDENED_TITLE);

    const after = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(after)).toEqual([]);
  });

  it('the criteria are the PROJECTED body — a plan that writes them onto a story makes its adopted child answerable', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Motir merges the pull request', 'story'); // no body stored
    const gate = await mk(fx, GATE_TITLE, 'subtask', story.id);
    await fileRelativeTo(gate.id, story.createdAt, -60_000);

    const planId = await freshPlan(fx);
    // No criteria stored and none proposed: an adopted child has nothing to own.
    const unwritten = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(unwritten)).toEqual([]);

    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: story.id, patch: { descriptionMd: COVERAGE_BODY } }],
      fx.ctx,
    );
    const written = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(written)).toEqual([
      expect.objectContaining({
        item: story.identifier,
        criterionIndex: 1,
        adoptedChildren: [gate.identifier],
      }),
    ]);
  });

  it('a card the plan PROPOSES is never adopted — under a proposed story with criteria, or one laid with no body', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const stories = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Motir merges the pull request',
            kind: 'story',
            descriptionMd: COVERAGE_BODY,
          },
        },
        { op: 'add', proposedFields: { title: 'A story laid without a body', kind: 'story' } },
      ],
      fx.ctx,
    );
    const authored = `${TEMP_REF_PREFIX}${itemIdByTitle(stories, 'Motir merges the pull request')}`;
    const laid = `${TEMP_REF_PREFIX}${itemIdByTitle(stories, 'A story laid without a body')}`;
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          parentRef: authored,
          proposedFields: { title: 'Unrelated billing work', kind: 'subtask' },
        },
        {
          op: 'add',
          parentRef: laid,
          proposedFields: { title: 'More unrelated billing work', kind: 'subtask' },
        },
      ],
      fx.ctx,
    );

    for (const ref of [authored, laid]) {
      const res = await planValidityService.validateProjectedWorkItem(planId, ref, fx.ctx);
      expect(coverageOf(res)).toEqual([]);
    }
  });

  it('a stored card filed AFTER the story compares the two stored instants — it is not adopted', async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyWithCriteria(fx, 'Motir merges the pull request');
    const home = await mk(fx, 'Where the card was first filed', 'story');
    const gate = await mk(fx, GATE_TITLE, 'subtask', home.id);
    await fileRelativeTo(gate.id, story.createdAt, 60_000);

    const planId = await freshPlan(fx);
    await reparent(fx, planId, gate.id, story.id);

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(res)).toEqual([]);
  });

  it('⚠️ `valid` and `blockers` are BYTE-IDENTICAL with and without the finding', async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyWithCriteria(fx, 'Motir merges the pull request');
    const gate = await olderCard(fx, story);
    const external = await outsideTask(fx, 'Work outside the subtree');
    await link(fx, gate.id, external.id);

    const planId = await freshPlan(fx);
    const plan = await reparent(fx, planId, gate.id, story.id);
    const withFinding = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(withFinding)).toHaveLength(1);

    const modifyId = plan.items.find((i) => i.op === 'modify' && i.workItemId === gate.id)!.id;
    await plansService.withdrawProposal(planId, modifyId, fx.ctx);
    await reparent(fx, planId, gate.id, story.id, WIDENED_TITLE);
    const without = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(coverageOf(without)).toEqual([]);
    expect(without.valid).toBe(false);
    expect(without.valid).toBe(withFinding.valid);
    expect(without.blockers).toEqual(withFinding.blockers);
  });

  it("scans the whole PROJECTED subtree — validating the EPIC reports each story's criteria, in wire order", async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'Approval gates', 'epic');
    const first = await storyWithCriteria(fx, 'Motir merges the pull request', epic.id);
    const second = await storyWithCriteria(fx, 'Motir closes the pull request', epic.id);
    const firstCard = await olderCard(fx, first, 'Unrelated billing work');
    const secondCard = await olderCard(fx, second, 'More unrelated billing work');

    const planId = await freshPlan(fx);
    await plansService.addProposals(
      planId,
      [
        { op: 'modify', workItemId: firstCard.id, patch: { parentRef: first.id } },
        { op: 'modify', workItemId: secondCard.id, patch: { parentRef: second.id } },
      ],
      fx.ctx,
    );

    const res = await planValidityService.validateProjectedWorkItem(
      planId,
      epic.identifier,
      fx.ctx,
    );
    // Neither title owns either criterion, so each story reports both — by
    // container, then by criterion, the committed path's wire order.
    expect(coverageOf(res).map((a) => [a.item, a.criterionIndex])).toEqual([
      [first.identifier, 1],
      [first.identifier, 2],
      [second.identifier, 1],
      [second.identifier, 2],
    ]);
  });
});

describe('planValidityService — SECTION findings parsed from the projected body (MOTIR-9032)', () => {
  const structured = renderSections('task', 'code', sectionsFixture('task', 'code'));
  const { scopeBoundary: _dropped, ...withoutScope } = sectionsFixture('task', 'code');
  const incomplete = renderSections('task', 'code', withoutScope);

  it('reports an `add` whose body is prose, names a missing section, and leaves `valid` alone', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await freshPlan(fx);
    const plan = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Clean', kind: 'task', type: 'code', descriptionMd: structured },
        },
        {
          op: 'add',
          proposedFields: {
            title: 'Prose',
            kind: 'task',
            type: 'code',
            descriptionMd: 'Just prose.',
          },
        },
        {
          op: 'add',
          proposedFields: {
            title: 'Partial',
            kind: 'task',
            type: 'code',
            descriptionMd: incomplete,
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res.valid).toBe(true);
    const byItem = new Map(res.sectionFindings.map((f) => [f.item, f]));
    expect(byItem.size).toBe(2);
    const prose = byItem.get(`planItem:${itemIdByTitle(plan, 'Prose')}`);
    expect(prose?.state).toBe('unstructured');
    const partial = byItem.get(`planItem:${itemIdByTitle(plan, 'Partial')}`);
    expect(partial).toMatchObject({ state: 'incomplete', missing: ['scopeBoundary'] });
    expect(byItem.has(`planItem:${itemIdByTitle(plan, 'Clean')}`)).toBe(false);
    expect(res.sectionFindings.map((f) => f.item)).toEqual(
      [...res.sectionFindings.map((f) => f.item)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('judges a `modify` by its PATCHED body, and never reports an untouched stored card', async () => {
    const fx = await makeWorkItemFixture();
    const touched = await mk(fx, 'Touched', 'task');
    const untouched = await mk(fx, 'Untouched', 'task');
    const planId = await freshPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: touched.id, patch: { descriptionMd: incomplete } }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    const res = await planValidityService.validateProjectedPlan(planId, fx.ctx);
    expect(res.sectionFindings.map((f) => f.item)).toEqual([touched.identifier]);
    expect(res.sectionFindings[0]).toMatchObject({
      state: 'incomplete',
      missing: ['scopeBoundary'],
    });
    expect(res.sectionFindings.some((f) => f.item === untouched.identifier)).toBe(false);
  });

  it('a modify that FIXES a stored bare body clears the finding in the subtree verdict', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'task', story.id);
    const planId = await freshPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: child.id, patch: { descriptionMd: structured } }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    const fixed = await planValidityService.validateProjectedWorkItem(
      planId,
      story.identifier,
      fx.ctx,
    );
    expect(fixed.sectionFindings.some((f) => f.item === child.identifier)).toBe(false);

    const emptyPlan = await freshPlan(fx);
    await plansService.markPlanned(emptyPlan, fx.ctx);
    const bare = await planValidityService.validateProjectedWorkItem(
      emptyPlan,
      story.identifier,
      fx.ctx,
    );
    expect(bare.sectionFindings.find((f) => f.item === child.identifier)?.state).toBe(
      'unstructured',
    );
    expect(bare.valid).toBe(true);
  });
});
