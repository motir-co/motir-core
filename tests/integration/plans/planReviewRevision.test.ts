import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-3595 · Subtask MOTIR-3601 — the READ side of a revision, over real
// Postgres: the lease the surface holds Approve on, and the set of proposals it
// marks *Revised*.
//
// Both are DERIVED from the plan's own content trail — no column, no table
// (`agent-authored-plans.md` AMENDMENT 10 D2; `design-notes.md` Part XII §D/§E).
// So the surface that must disable Approve, the timeline that tells the reviewer
// why, and the row marker all read ONE fact from ONE place.

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const AGENT = { source: null, harness: 'Motir AI', model: 'claude-opus-5' };

async function plannedPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const one = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The first story', kind: 'story' } }],
    fx.ctx,
  );
  const two = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The second story', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, firstId: one.items[0]!.id, secondId: two.items[1]!.id };
}

describe('the review model reads the revision off the trail', () => {
  it('an UNREVISED plan carries no revision and marks no row — byte-identical to before', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    const view = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(view.revision).toBeNull();
    expect(view.items.every((i) => i.revised === false)).toBe(true);
  });

  it('a HELD plan reports the lease, with the HARNESS and when it expires', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    const view = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(view.revision).not.toBeNull();
    // The HARNESS, never the model — the discriminator Part X §4 fixed for the
    // timeline clause, reused here for the same reason.
    expect(view.revision!.heldBy).toBe('Motir AI');
    expect(Date.parse(view.revision!.expiresAt)).toBeGreaterThan(Date.now());
    // …and the SAME pair is on the timeline the reviewer is already reading.
    expect(view.history.some((e) => e.kind === 'revision_started')).toBe(true);
  });

  it('marks ONLY the proposals the latest revision touched, and keeps marking them after it LANDS', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await plannedPlan(fx);

    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await plansService.correctProposal(
      planId,
      secondId,
      { title: 'Renamed by the revision' },
      fx.ctx,
    );
    await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);

    const view = await planReviewService.getPlanReview(planId, fx.ctx);
    // The lease is gone…
    expect(view.revision).toBeNull();
    // …and the marker is NOT. A landed revision is exactly the case the pill
    // exists for; blanking it the moment the thing it marks finished would leave
    // the reviewer with nothing to read.
    const revised = view.items.filter((i) => i.revised);
    expect(revised.map((i) => i.planItemId)).toEqual([secondId]);
  });

  it('a SECOND revision re-bases the marker — it says what moved since you LAST looked', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await plannedPlan(fx);

    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await plansService.correctProposal(planId, secondId, { title: 'First pass' }, fx.ctx);
    await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);

    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);
    await plansService.correctProposal(planId, firstId, { title: 'Second pass' }, fx.ctx);
    await plansService.releaseRevisionLease(planId, fx.ctx, AGENT);

    const view = await planReviewService.getPlanReview(planId, fx.ctx);
    // The marker is a RECENCY fact, so the earlier revision's row is no longer
    // marked — otherwise it accumulates and stops meaning anything.
    expect(view.items.filter((i) => i.revised).map((i) => i.planItemId)).toEqual([firstId]);
  });

  it('an EXPIRED lease is not held — the only thing that recovers a plan whose job died', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlan(fx);
    await plansService.acquireRevisionLease(planId, fx.ctx, AGENT);

    // Age the trail past the window, exactly as a job that never reported back
    // would leave it.
    await adminDb.planRevision.updateMany({
      where: { planId },
      data: { changedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    expect((await planReviewService.getPlanReview(planId, fx.ctx)).revision).toBeNull();
    // …and the plan is decidable again, with no manual intervention.
    await plansService.approvePlan(planId, fx.ctx);
  });
});

describe('the live read carries each proposal’s last EDIT time (MOTIR-11185)', () => {
  it('is null until a proposal is edited, then the newest edited row’s time — for that row only', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await plannedPlan(fx);

    const before = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(before.items.map((i) => i.lastEditedAt)).toEqual([null, null]);

    await plansService.correctProposal(planId, secondId, { title: 'Edited once' }, fx.ctx);
    await plansService.correctProposal(planId, secondId, { title: 'Edited twice' }, fx.ctx);

    const edits = await adminDb.planRevision.findMany({
      where: { planId, changeKind: 'edited', planItemId: secondId },
      orderBy: { changedAt: 'desc' },
      select: { changedAt: true },
    });
    expect(edits).toHaveLength(2);

    const after = await planReviewService.getPlanReview(planId, fx.ctx);
    const byId = new Map(after.items.map((i) => [i.planItemId, i.lastEditedAt]));
    expect(byId.get(secondId)).toBe(edits[0]!.changedAt.toISOString());
    expect(byId.get(firstId)).toBeNull();
  });
});
