import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-11487 (design MOTIR-11486 § "The earlier version, kept as history") —
// every `planned` close keeps the briefing that version closed with, and the review
// read returns the versions in order, so the planning rail can draw an earlier
// version's briefing above the follow-up that replaced it. The plan row keeps only
// its CURRENT summary, so before this a revision's close overwrote the briefing the
// person had read for the version before it, and nothing kept it.
//
// Against real Postgres: the trail is read back through `adminDb`, and the review
// through the real `getPlanReview`.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ONE_ADD = [{ op: 'add' as const, proposedFields: { title: 'Add the record', kind: 'task' } }];

const plannedRows = (planId: string) =>
  adminDb.planRevision.findMany({
    where: { planId, changeKind: 'planned' },
    orderBy: { changedAt: 'asc' },
  });

/** A plan closed once with `first`, then revised and closed again with `second`. */
async function revisedPlan(fx: WorkItemFixture, first: string, second: string | null) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Finding records' }, fx.ctx);
  await plansService.addProposals(plan.id, ONE_ADD, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx, { summary: first });
  await plansService.acquireRevisionLease(plan.id, fx.ctx, {
    source: null,
    harness: 'Motir AI',
    model: null,
  });
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'Keep the verdict', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx, {
    revision: true,
    ...(second !== null ? { summary: second } : {}),
  });
  return plan.id;
}

describe('a planned close keeps the briefing it closed with', () => {
  it('records the summary beside the count on the `planned` row', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'One' }, fx.ctx);
    await plansService.addProposals(plan.id, ONE_ADD, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx, { summary: 'The first briefing.' });

    const rows = await plannedRows(plan.id);
    expect(rows.map((r) => r.diff)).toEqual([{ itemCount: 1, summary: 'The first briefing.' }]);
  });

  it('a revision’s close keeps its own briefing, and the earlier row keeps the earlier one', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await revisedPlan(fx, 'Version one.', 'Version two.');

    const rows = await plannedRows(planId);
    expect(rows.map((r) => r.diff)).toEqual([
      { itemCount: 1, summary: 'Version one.' },
      { itemCount: 2, summary: 'Version two.' },
    ]);
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).summary).toBe(
      'Version two.',
    );
  });

  it('a revision that sends no briefing records the one the plan still shows', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await revisedPlan(fx, 'Version one.', null);

    expect((await plannedRows(planId)).map((r) => r.diff)).toEqual([
      { itemCount: 1, summary: 'Version one.' },
      { itemCount: 2, summary: 'Version one.' },
    ]);
  });

  it('a plan with no summary records none', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Bare' }, fx.ctx);
    await plansService.addProposals(plan.id, ONE_ADD, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);

    expect((await plannedRows(plan.id)).map((r) => r.diff)).toEqual([{ itemCount: 1 }]);
  });
});

describe('planReviewService.getPlanReview — the plan’s versions', () => {
  it('returns every version oldest first, each with its count and briefing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await revisedPlan(fx, 'Version one.', 'Version two.');
    const rows = await plannedRows(planId);

    const review = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(review.summary).toBe('Version two.');
    expect(review.versions).toEqual([
      {
        id: rows[0]!.id,
        plannedAt: rows[0]!.changedAt.toISOString(),
        itemCount: 1,
        summary: 'Version one.',
      },
      {
        id: rows[1]!.id,
        plannedAt: rows[1]!.changedAt.toISOString(),
        itemCount: 2,
        summary: 'Version two.',
      },
    ]);
  });

  it('a version closed before briefings were kept reads as no briefing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await revisedPlan(fx, 'Version one.', 'Version two.');
    const [first] = await plannedRows(planId);
    // What every `planned` row written before MOTIR-11487 holds: the count alone.
    await adminDb.planRevision.update({
      where: { id: first!.id },
      data: { diff: { itemCount: 1 } },
    });

    const review = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(review.versions?.map((v) => v.summary)).toEqual([null, 'Version two.']);
    expect(review.versions?.[0]?.itemCount).toBe(1);
  });

  it('resolves the work-item links in an EARLIER version’s briefing too', async () => {
    const fx = await makeWorkItemFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'The findings table' },
      fx.ctx,
    );
    const link = `[${card.identifier}](motir:${card.id})`;
    const planId = await revisedPlan(fx, `Builds on ${link}.`, 'Version two names no card.');

    const review = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(review.summaryRefs?.[card.id]).toMatchObject({
      accessible: true,
      identifier: card.identifier,
      title: 'The findings table',
    });
  });
});
