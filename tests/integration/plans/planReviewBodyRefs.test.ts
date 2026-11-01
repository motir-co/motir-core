import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-9355 — the plan review resolves the work-item links in every
// proposal's PROPOSED title and bodies, in ONE batched read for the whole plan,
// and each item carries the summaries of its own links. The peek renders those
// bodies, and before this it had no map that covered them: an `add` rendered
// with `{}` and a `modify` with its target's map, so every link was drawn as a
// deleted card.

async function seed(
  fx: WorkItemFixture,
  title: string,
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

const link = (w: { id: string; identifier: string }) => `[${w.identifier}](motir:${w.id})`;

beforeEach(async () => {
  await truncateAuthTables();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('planReviewService.getPlanReview — the proposed bodies’ work-item refs (MOTIR-9355)', () => {
  it('resolves an add’s and a modify’s PROPOSED links, both bodies, in one batched read', async () => {
    const fx = await makeWorkItemFixture();
    const pool = await seed(fx, 'The fleet pool layer');
    const aws = await seed(fx, 'The AWS runner pool');
    const target = await seed(fx, 'A card the plan rewrites');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Refs plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'An added card',
            kind: 'task',
            descriptionMd: `Builds on ${link(pool)} and [MOTIR-1](motir:wi_never_existed).`,
            explanationMd: `Waits on ${link(aws)}.`,
          },
        },
        {
          op: 'modify',
          workItemId: target.id,
          patch: { descriptionMd: `Now also cites ${link(aws)}.` },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const reads = vi.spyOn(workItemRepository, 'findByIdsInWorkspace');
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    const added = review.items.find((i) => i.op === 'add')!;
    expect(Object.keys(added.workItemRefs ?? {}).sort()).toEqual([pool.id, aws.id].sort());
    expect(added.workItemRefs?.[pool.id]).toMatchObject({
      accessible: true,
      identifier: pool.identifier,
      title: 'The fleet pool layer',
    });
    // The explanation's link resolves exactly as the description's does.
    expect(added.workItemRefs?.[aws.id]).toMatchObject({ identifier: aws.identifier });
    // A link to nothing stays ABSENT, which is what draws it struck through.
    expect(added.workItemRefs?.['wi_never_existed']).toBeUndefined();

    const modified = review.items.find((i) => i.op === 'modify')!;
    expect(Object.keys(modified.workItemRefs ?? {})).toEqual([aws.id]);

    // ONE resolve for the whole plan, never one per proposal.
    const refReads = reads.mock.calls.filter(([ids]) => ids.includes(aws.id));
    expect(refReads).toHaveLength(1);
  });

  it('resolves the plan SUMMARY’s links in the same batched read (MOTIR-9697)', async () => {
    const fx = await makeWorkItemFixture();
    const pool = await seed(fx, 'The fleet pool layer');
    const aws = await seed(fx, 'The AWS runner pool');

    const plan = await plansService.createPlan(
      fx.projectId,
      {
        title: 'Summary plan',
        summary: `## 1. Asked\nBuilds on ${link(pool)}, not [MOTIR-1](motir:wi_gone).`,
      },
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Added', kind: 'task', descriptionMd: `Uses ${link(aws)}.` },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const reads = vi.spyOn(workItemRepository, 'findByIdsInWorkspace');
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    expect(Object.keys(review.summaryRefs ?? {})).toEqual([pool.id]);
    expect(review.summaryRefs?.[pool.id]).toMatchObject({
      accessible: true,
      identifier: pool.identifier,
      title: 'The fleet pool layer',
    });
    // ONE resolve covers the summary AND the proposal bodies.
    const refReads = reads.mock.calls.filter(
      ([ids]) => ids.includes(pool.id) || ids.includes(aws.id),
    );
    expect(refReads).toHaveLength(1);
    expect(refReads[0]![0]).toEqual(expect.arrayContaining([pool.id, aws.id]));
  });

  it('carries an empty map when no body links a work item', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Plain plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Plain', kind: 'task', descriptionMd: 'No links.' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]!.workItemRefs).toEqual({});
  });
});
