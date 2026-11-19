import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemProposedFields } from '@/lib/dto/plans';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-11838 — plan approval stored an EXECUTOR (and a TYPE) on a story or
// epic, and the card could then not be edited at all.
//
// `materialize` writes the created row directly — it never goes through
// `workItemsService` — and copied `proposedFields.executor` / `.type` onto every
// `add`, whatever its kind. A container cannot carry either (the leaf-only rule,
// `assertTypeKindConsistent`), and `updateWorkItem` checks the card's state AFTER
// every patch with the stored executor carried over, so the first later edit of
// the story — a re-parent that never touched the executor included — was refused
// with TYPE_NOT_ALLOWED_ON_KIND for a field the item page does not show.
//
// The fix drops both leaf fields on a container kind at materialize (and the
// review rail reports the card as approve will create it). These tests drive the
// real approve path against real Postgres.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Author + approve a plan of `add`s, returning each created row by title. */
async function approveAdds(fx: WorkItemFixture, adds: PlanItemProposedFields[]) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    adds.map((proposedFields) => ({ op: 'add' as const, proposedFields })),
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  const rows = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
  return new Map(rows.map((r) => [r.title, r]));
}

describe('MOTIR-11838 — approve never stores a leaf field on a container', () => {
  it('a story `add` carrying an executor is created with NO executor, and re-parenting it then succeeds', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'epic', title: 'Target epic' });

    const rows = await approveAdds(fx, [
      { title: 'A story from a plan', kind: 'story', executor: 'coding_agent' },
    ]);
    const story = rows.get('A story from a plan')!;

    expect(story.kind).toBe('story');
    expect(story.executor).toBeNull();
    expect(story.type).toBeNull();

    // The edit the bug blocked: the item page's parent edit, `updateWorkItem`
    // with a `parentId`, which re-checks the leaf-only rule after the patch.
    const reparented = await workItemsService.updateWorkItem(
      story.id,
      { parentId: target.id },
      fx.ctx,
    );
    expect(reparented.parentId).toBe(target.id);

    // …and an ordinary field edit, which went through the same refused check.
    const renamed = await workItemsService.updateWorkItem(
      story.id,
      { title: 'A renamed story' },
      fx.ctx,
    );
    expect(renamed.title).toBe('A renamed story');
  });

  it('an epic `add` carrying a type AND an executor is created with neither', async () => {
    const fx = await makeWorkItemFixture();

    const rows = await approveAdds(fx, [
      { title: 'An epic from a plan', kind: 'epic', type: 'code', executor: 'human' },
    ]);
    const epic = rows.get('An epic from a plan')!;

    expect(epic.kind).toBe('epic');
    expect(epic.type).toBeNull();
    expect(epic.executor).toBeNull();
  });

  it('a story `add` carrying a type is created untyped', async () => {
    const fx = await makeWorkItemFixture();

    const rows = await approveAdds(fx, [{ title: 'Typed story', kind: 'story', type: 'design' }]);

    expect(rows.get('Typed story')!.type).toBeNull();
  });

  it('a LEAF `add` keeps the type and executor it proposed — the drop is container-only', async () => {
    const fx = await makeWorkItemFixture();

    const rows = await approveAdds(fx, [
      { title: 'A task', kind: 'task', type: 'manual', executor: 'human' },
      { title: 'A defaulted task', type: 'code', executor: 'coding_agent' },
    ]);

    expect(rows.get('A task')).toMatchObject({ type: 'manual', executor: 'human' });
    // No `kind` on the proposal materializes as a `task` — still a leaf.
    expect(rows.get('A defaulted task')).toMatchObject({
      kind: 'task',
      type: 'code',
      executor: 'coding_agent',
    });
  });
});

describe('MOTIR-11838 — the review rail shows the card approve will create', () => {
  it('reports no executor and no type for a container `add`, and the proposed ones for a leaf', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Story', kind: 'story', type: 'code', executor: 'coding_agent' },
        },
        {
          op: 'add',
          proposedFields: { title: 'Task', kind: 'task', type: 'code', executor: 'coding_agent' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const story = review.items.find((i) => i.title === 'Story')!;
    const task = review.items.find((i) => i.title === 'Task')!;

    expect(story).toMatchObject({ type: null, executor: null });
    expect(task).toMatchObject({ type: 'code', executor: 'coding_agent' });
  });
});
