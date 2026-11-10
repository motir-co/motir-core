import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { planRepository } from '@/lib/repositories/planRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { PLAN_STATUS_DTO_VALUES } from '@/lib/dto/plans';
import { arrivalLevel } from '@/components/planning/PlanReviewCanvas';
import { planContainerCount, fullestContainer } from '@/lib/planning/planShape';
import { defaultPlanView } from '@/lib/planning/planView';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3242 — the STORY-LEVEL vitest gate for MOTIR-3232.
//
// Each feature card shipped its own units. This file drives one card's REAL
// output into the next card's REAL consumer, against real Postgres, because the
// seams BETWEEN them are what no per-card test can see:
//
//   • read → page: the page size and the cursor
//   • counts ↔ pages: a predicate and a `groupBy` drifting apart
//   • the discard round trip: the three endings that share one status
//   • add_plan_items → getPlanReview → the plan's SHAPE — the ONLY place the
//     canvas cards' premise can be checked, because the null `parentIdentifier`
//     on an intra-plan parent is a property of the SERVICE and not of the type.
//     A hand-built `PlanReviewItemDto[]` would pass against the broken code.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A COMMITTED container to propose into, seeded through the real service so it
 *  carries a valid fractional position (the fixture's own helper does not). */
async function seedEpic(fx: WorkItemFixture, title = 'A committed epic'): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title },
    fx.ctx,
  );
  return dto.id;
}

/** A plan in the given status, through the real service path as far as it goes. */
async function planIn(
  fx: WorkItemFixture,
  status: 'generating' | 'planned' | 'approved' | 'declined',
  title: string,
  createdById?: string,
): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title, ...(createdById ? { createdById } : {}) },
    fx.ctx,
  );
  if (status === 'generating') return plan.id;
  // ⚠️ ONE PROPOSAL, ALWAYS (MOTIR-4124). A close over a plan holding NOTHING
  // DISCARDS it — `declined` / `discarded` — so a helper that appended nothing
  // could not reach `planned` at all, and every status above it would be the
  // wrong one. The proposal is fixture scaffolding, not a subject of these
  // cases.
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: `${title} — a proposal`, kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  if (status === 'planned') return plan.id;
  if (status === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else await plansService.declinePlan(plan.id, fx.ctx);
  return plan.id;
}

/** Every plan a status holds, walked page by page through the real cursor. */
async function walkTab(fx: WorkItemFixture, status: (typeof PLAN_STATUS_DTO_VALUES)[number]) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page: Awaited<ReturnType<typeof plansService.listPlans>> = await plansService.listPlans(
      fx.projectId,
      fx.ctx,
      { status, cursor },
    );
    ids.push(...page.plans.map((p) => p.id));
    if (page.nextCursor === null) return ids;
    cursor = page.nextCursor;
  }
  throw new Error('cursor did not terminate');
}

describe('SEAM: read → page', () => {
  it('pages ten at a time within a status, disjointly', async () => {
    const fx = await makeWorkItemFixture();
    const mara = await createTestUser({ email: 'mara@example.com', name: 'Mara' });

    // Twelve planned plans (two pages), plus a decided one requested by Mara and
    // decided by the fixture owner — two DIFFERENT people, which is the case the
    // row's reversal is about.
    for (let i = 0; i < 12; i += 1) await planIn(fx, 'planned', `planned ${i}`, mara.id);
    const decided = await planIn(fx, 'approved', 'accepted', mara.id);

    const first = await plansService.listPlans(fx.projectId, fx.ctx, { status: 'planned' });
    expect(first.plans).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();

    const second = await plansService.listPlans(fx.projectId, fx.ctx, {
      status: 'planned',
      cursor: first.nextCursor,
    });
    expect(second.plans).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    // Disjoint — the property the `take: limit + 1` trick lives on.
    const seen = new Set([...first.plans, ...second.plans].map((p) => p.id));
    expect(seen.size).toBe(12);

    // The decided plan is in its own status, not this one. (The plan-row
    // view-model this seam used to drive is retired: `/plans` lists
    // conversations since MOTIR-6025, and its row seams live in
    // `tests/integration/plans/planSessionsList.test.ts`.)
    expect(seen.has(decided)).toBe(false);
  });
});

describe('SEAM: the COUNTS agree with the PAGES', () => {
  it('for every status, the count equals a full cursor walk of that tab', async () => {
    // The assertion that catches a predicate and a `groupBy` drifting apart,
    // which no unit test of either alone can see.
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 11; i += 1) await planIn(fx, 'planned', `p${i}`);
    for (let i = 0; i < 3; i += 1) await planIn(fx, 'generating', `g${i}`);
    for (let i = 0; i < 2; i += 1) await planIn(fx, 'approved', `a${i}`);

    const counts = await plansService.countPlansByStatus(fx.projectId, fx.ctx);

    for (const status of PLAN_STATUS_DTO_VALUES) {
      const walked = await walkTab(fx, status);
      expect({ status, n: counts[status] }).toEqual({ status, n: walked.length });
    }
    // …and the map is TOTAL: the empty status reads 0, not undefined.
    expect(counts.declined).toBe(0);
  });
});

describe('SEAM: the DISCARD round trip', () => {
  it('a generating plan discarded lands on the reason-specific outcome', async () => {
    // The three endings that share `declined` are exactly what a unit test on
    // either end mocks away.
    const fx = await makeWorkItemFixture();
    const planId = await planIn(fx, 'generating', 'never finished');
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Half a thought', kind: 'task' } }],
      fx.ctx,
    );

    const declined = await plansService.declinePlan(planId, fx.ctx);
    expect(declined.status).toBe('declined');
    expect(declined.decisionReason).toBe('discarded');

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(review.status).toBe('declined');
    expect(review.decisionReason).toBe('discarded');
    // The proposals SURVIVE the discard — the confirm's promise.
    expect(review.items).toHaveLength(1);
  });

  it('a REVIEWED decline is a different ending on the same status', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await planIn(fx, 'planned', 'read and rejected');

    await plansService.declinePlan(planId, fx.ctx);
    const review = await planReviewService.getPlanReview(planId, fx.ctx);

    expect(review.status).toBe('declined');
    expect(review.decisionReason).toBe('reviewed');
  });
});

describe('SEAM: add_plan_items → getPlanReview → the plan’s SHAPE', () => {
  /** Topology 1 — one story under a committed epic, subtasks under that story by
   *  intra-plan ref. The shape the arrival fix is about. */
  async function topologyOne(fx: WorkItemFixture) {
    const committedEpicId = await seedEpic(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Topology 1' }, fx.ctx);
    const afterStory = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Payout reconciliation', kind: 'story' },
          parentRef: committedEpicId,
        },
      ],
      fx.ctx,
    );
    const storyItemId = afterStory.items[0]!.id;
    for (let i = 0; i < 3; i += 1) {
      await plansService.addProposals(
        plan.id,
        [
          {
            op: 'add',
            proposedFields: { title: `Subtask ${i}`, kind: 'subtask' },
            parentRef: `planItem:${storyItemId}`,
          },
        ],
        fx.ctx,
      );
    }
    await plansService.markPlanned(plan.id, fx.ctx);
    return { planId: plan.id, storyItemId, committedEpicId };
  }

  it('TOPOLOGY 1 — the subtasks come back with a null identifier and a real node id', async () => {
    // ⚠️ THAT PAIR IS THE BUG. `getPlanReview` sets `parentIdentifier` to null for
    // an intra-plan parent — deliberately — and the shipped `arrivalLevel` skipped
    // exactly those items. Asserting the pair here is what makes the arrival
    // assertion below meaningful: a hand-built fixture would pass either way.
    const fx = await makeWorkItemFixture();
    const { planId } = await topologyOne(fx);

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const subtasks = review.items.filter((i) => i.title.startsWith('Subtask'));
    expect(subtasks).toHaveLength(3);
    for (const sub of subtasks) {
      expect(sub.parentIdentifier).toBeNull();
      expect(sub.parentNodeId).not.toBeNull();
      expect(sub.parentTrail).toEqual([]);
    }
  });

  it('TOPOLOGY 1 — the canvas arrives on the STORY’s level, with the proposed crumb', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await topologyOne(fx);
    const review = await planReviewService.getPlanReview(planId, fx.ctx);

    const story = review.items.find((i) => i.title === 'Payout reconciliation')!;
    const arrival = arrivalLevel(review.items, 'New');

    expect(arrival?.id).toBe(story.nodeId);
    expect(arrival?.trail.at(-1)?.label).toBe('New · Payout reconciliation');
  });

  it('TOPOLOGY 2 — two stories under one committed parent arrive at that parent', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await seedEpic(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Topology 2' }, fx.ctx);
    for (const title of ['Story A', 'Story B']) {
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title, kind: 'story' }, parentRef: committed }],
        fx.ctx,
      );
    }
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const arrival = arrivalLevel(review.items, 'New');

    expect(arrival?.id).toBe(committed);
    // The trail is the committed chain — no proposed crumb, because the parent
    // is real.
    expect(arrival?.trail.every((c) => !c.label.startsWith('New ·'))).toBe(true);
    // The emphasis set (what Show changes lights) is exactly the two proposals.
    expect(review.items).toHaveLength(2);
    expect(new Set(review.items.map((i) => i.nodeId)).size).toBe(2);
    expect(planContainerCount(review.items)).toBe(1);
    expect(defaultPlanView(review)).toBe('canvas');
  });

  it('TOPOLOGY 3 — a plan STRADDLING two parents counts 2 and defaults to the LIST', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await seedEpic(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Topology 3' }, fx.ctx);
    // A story under a committed epic, plus a subtask under that story — two
    // containers, one committed and one proposed.
    const afterStory = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' }, parentRef: committed }],
      fx.ctx,
    );
    const storyItemId = afterStory.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Inside the story', kind: 'subtask' },
          parentRef: `planItem:${storyItemId}`,
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);

    expect(planContainerCount(review.items)).toBe(2);
    expect(defaultPlanView(review)).toBe('list');
  });

  it('MATERIALIZE does not disturb the derivation', async () => {
    // An `add` that HAS materialized carries an identifier and keys by the work
    // item it became (MOTIR-3160's re-keying). The arrival must still resolve —
    // a decided plan is a state a reviewer genuinely revisits.
    const fx = await makeWorkItemFixture();
    const { planId } = await topologyOne(fx);
    await plansService.approvePlan(planId, fx.ctx);

    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const arrival = arrivalLevel(review.items, 'New');
    const story = review.items.find((i) => i.title === 'Payout reconciliation')!;

    expect(story.identifier).not.toBeNull();
    expect(arrival).not.toBeNull();
    expect(arrival?.id).toBe(story.nodeId);
    expect(fullestContainer(review.items)).not.toBeNull();
  });
});

describe('GUARD: the abandonment predicate does not RE-NARROW', () => {
  it('a job-less generating row IS returned by the candidate read', async () => {
    // The property four defects in this path kept losing, asserted against the
    // SHAPE rather than the SQL text: it is one row in a fixture.
    const fx = await makeWorkItemFixture();
    const plan = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'generating',
        sourceJobId: null,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    const candidates = await withSystemContext((tx) =>
      planRepository.listAbandonedCandidates(50, tx),
    );

    expect(candidates.map((c) => c.id)).toContain(plan.id);
    expect(candidates.find((c) => c.id === plan.id)!.sourceJobId).toBeNull();
  });
});

describe('GUARD: totality over the status vocabulary', () => {
  it('the count map has a key for every member, and the array IS the type', () => {
    // `PlanStatusDto` is DERIVED from `PLAN_STATUS_DTO_VALUES`, so the two cannot
    // drift: adding a member widens the type, and there is no second list to
    // forget. This asserts the runtime half of that.
    expect([...PLAN_STATUS_DTO_VALUES].sort()).toEqual([
      'approved',
      'approving',
      'declined',
      'generating',
      'planned',
      'stale',
    ]);
  });

  it('an empty project still answers for every status', async () => {
    const fx = await makeWorkItemFixture();

    const counts = await plansService.countPlansByStatus(fx.projectId, fx.ctx);

    for (const status of PLAN_STATUS_DTO_VALUES) {
      expect(counts[status]).toBe(0);
    }
  });
});

describe('GUARD: the arrival derivation is TOTAL over the degenerate plans', () => {
  it('returns a defined answer for every degenerate shape rather than throwing', async () => {
    const fx = await makeWorkItemFixture();

    // No proposals at all.
    const empty = await plansService.createPlan(fx.projectId, { title: 'empty' }, fx.ctx);
    await plansService.markPlanned(empty.id, fx.ctx);
    const emptyReview = await planReviewService.getPlanReview(empty.id, fx.ctx);
    expect(arrivalLevel(emptyReview.items, 'New')).toBeNull();
    expect(defaultPlanView(emptyReview)).toBe('canvas');

    // Every proposal a ROOT.
    const roots = await plansService.createPlan(fx.projectId, { title: 'roots' }, fx.ctx);
    for (const title of ['Root A', 'Root B']) {
      await plansService.addProposals(
        roots.id,
        [{ op: 'add', proposedFields: { title, kind: 'story' } }],
        fx.ctx,
      );
    }
    await plansService.markPlanned(roots.id, fx.ctx);
    const rootReview = await planReviewService.getPlanReview(roots.id, fx.ctx);
    expect(arrivalLevel(rootReview.items, 'New')).toBeNull();
    expect(planContainerCount(rootReview.items)).toBe(1);
    expect(defaultPlanView(rootReview)).toBe('canvas');
  });
});
