import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { InvalidPlanStepError, PlanNotGeneratingError } from '@/lib/plans/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../../helpers/sqlstate';

// Story MOTIR-7820 · Subtask MOTIR-7822 — a `generating` plan holds the step each
// of its running planner sessions is on, and knows when anything last happened to
// it. Every case drives `plansService` against real Postgres and reads the stored
// rows back through `adminDb`, so a service that refused yet returned a plausible
// DTO cannot pass.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function generatingPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' } }],
    fx.ctx,
  );
  return { planId: plan.id, addId: appended.items[0]!.id };
}

const stepsOf = (planId: string) =>
  adminDb.planStep.findMany({ where: { planId }, orderBy: { startedAt: 'asc' } });
const activityOf = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).lastActivityAt;
/** Push the stored stamp into the past, so "did it move?" is a comparison that a
 *  write landing in the same millisecond cannot fake. */
async function backdate(planId: string): Promise<Date> {
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await adminDb.plan.update({ where: { id: planId }, data: { lastActivityAt: past } });
  return past;
}

describe('recordPlanStep / endPlanStep — one row per running session', () => {
  it('stores a step with a server-set startedAt, REPLACES it for the same session, adds for another', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);
    const before = Date.now();

    const first = await plansService.recordPlanStep(
      planId,
      { sessionKey: 's1', kind: 'settle', targetRef: null },
      fx.ctx,
    );
    expect(first).toMatchObject({ sessionKey: 's1', kind: 'settle', targetRef: null });
    expect(Date.parse(first.startedAt)).toBeGreaterThanOrEqual(before - 1000);

    await plansService.recordPlanStep(
      planId,
      { sessionKey: 's1', kind: 'author', targetRef: `planItem:${addId}` },
      fx.ctx,
    );
    let rows = await stepsOf(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'author', targetRef: `planItem:${addId}` });

    await plansService.recordPlanStep(
      planId,
      { sessionKey: 's2', kind: 'lay', targetRef: `planItem:${addId}` },
      fx.ctx,
    );
    rows = await stepsOf(planId);
    expect(rows.map((r) => r.sessionKey).sort()).toEqual(['s1', 's2']);
  });

  it('accepts BOTH untargeted forms — a lay of the top level and an author of a new item', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    const lay = await plansService.recordPlanStep(
      planId,
      { sessionKey: 'root', kind: 'lay', targetRef: null },
      fx.ctx,
    );
    const author = await plansService.recordPlanStep(
      planId,
      { sessionKey: 'new', kind: 'author', targetRef: null },
      fx.ctx,
    );
    expect(lay.targetRef).toBeNull();
    expect(author.targetRef).toBeNull();
    const rows = await stepsOf(planId);
    expect(rows.map((r) => [r.kind, r.targetRef])).toEqual([
      ['lay', null],
      ['author', null],
    ]);
  });

  it('accepts a committed work item of the plan’s project as a target', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    const item = await createTestWorkItem(fx, { title: 'Committed parent', kind: 'story' });
    const step = await plansService.recordPlanStep(
      planId,
      { sessionKey: 'relay', kind: 'lay', targetRef: item.id },
      fx.ctx,
    );
    expect(step.targetRef).toBe(item.id);
  });

  it('endPlanStep removes that session’s row only, and is a no-op success on a missing one', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'a', kind: 'settle', targetRef: null },
      fx.ctx,
    );
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'b', kind: 'lay', targetRef: null },
      fx.ctx,
    );

    await plansService.endPlanStep(planId, 'a', fx.ctx);
    expect((await stepsOf(planId)).map((r) => r.sessionKey)).toEqual(['b']);

    const past = await backdate(planId);
    await expect(
      plansService.endPlanStep(planId, 'never-reported', fx.ctx),
    ).resolves.toBeUndefined();
    expect((await stepsOf(planId)).map((r) => r.sessionKey)).toEqual(['b']);
    // …and the no-op still stamps the activity: an ending session is a sign of life.
    expect((await activityOf(planId)).getTime()).toBeGreaterThan(past.getTime());
  });
});

describe('the generating-only guard', () => {
  async function closedPlan(fx: WorkItemFixture, to: 'planned' | 'approved' | 'declined') {
    const { planId } = await generatingPlan(fx);
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'left', kind: 'settle', targetRef: null },
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    if (to === 'approved') await plansService.approvePlan(planId, fx.ctx);
    if (to === 'declined') await plansService.declinePlan(planId, fx.ctx);
    return planId;
  }

  for (const status of ['planned', 'approved', 'declined'] as const) {
    it(`refuses both writes on a ${status} plan and changes nothing`, async () => {
      const fx = await makeWorkItemFixture();
      const planId = await closedPlan(fx, status);
      const stamp = await activityOf(planId);
      const rowsBefore = await stepsOf(planId);

      await expect(
        plansService.recordPlanStep(
          planId,
          { sessionKey: 'x', kind: 'settle', targetRef: null },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(PlanNotGeneratingError);
      await expect(plansService.endPlanStep(planId, 'left', fx.ctx)).rejects.toBeInstanceOf(
        PlanNotGeneratingError,
      );

      expect(await stepsOf(planId)).toEqual(rowsBefore);
      expect((await activityOf(planId)).getTime()).toBe(stamp.getTime());
    });
  }

  it('refuses an actor without ai:view_plan before any write', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    const outsider = await createTestUser();
    const outsiderCtx = { userId: outsider.id, workspaceId: fx.ctx.workspaceId };
    await expect(
      plansService.recordPlanStep(
        planId,
        { sessionKey: 'x', kind: 'settle', targetRef: null },
        outsiderCtx,
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(await stepsOf(planId)).toEqual([]);
  });
});

describe('input validation — refused with a typed error, nothing written', () => {
  it.each([
    [
      'settle WITH a target',
      (addId: string) => ({ kind: 'settle', targetRef: `planItem:${addId}` }),
    ],
    [
      'a planItem ref naming no add on this plan',
      () => ({ kind: 'author', targetRef: 'planItem:nope' }),
    ],
    ['a folder ref', () => ({ kind: 'lay', targetRef: 'folder:abc' })],
    ['a key instead of an id', () => ({ kind: 'lay', targetRef: 'ACME-12' })],
    ['an empty-string target', () => ({ kind: 'author', targetRef: '' })],
    ['an unknown work-item id', () => ({ kind: 'lay', targetRef: 'cnotarealworkitemid000000' })],
  ] as const)('refuses %s', async (_label, build) => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);
    const past = await backdate(planId);
    const shape = build(addId) as { kind: 'settle' | 'lay' | 'author'; targetRef: string };
    await expect(
      plansService.recordPlanStep(planId, { sessionKey: 's', ...shape }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await stepsOf(planId)).toEqual([]);
    expect((await activityOf(planId)).getTime()).toBe(past.getTime());
  });

  it('refuses a work item from another tenant’s project', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const foreign = await createTestWorkItem(elsewhere, {
      title: 'Not this project',
      kind: 'story',
    });
    await expect(
      plansService.recordPlanStep(
        planId,
        { sessionKey: 's', kind: 'lay', targetRef: foreign.id },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
  });

  it('refuses a planItem ref naming an add on a DIFFERENT plan', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    const other = await generatingPlan(fx);
    await expect(
      plansService.recordPlanStep(
        planId,
        { sessionKey: 's', kind: 'author', targetRef: `planItem:${other.addId}` },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
  });

  it('refuses an empty or over-long session key', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    for (const sessionKey of ['', '   ', 'k'.repeat(129)]) {
      await expect(
        plansService.recordPlanStep(
          planId,
          { sessionKey, kind: 'settle', targetRef: null },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(InvalidPlanStepError);
      await expect(plansService.endPlanStep(planId, sessionKey, fx.ctx)).rejects.toBeInstanceOf(
        InvalidPlanStepError,
      );
    }
    expect(await stepsOf(planId)).toEqual([]);
  });
});

describe('lastActivityAt — stamped by every content write, never by a decision', () => {
  it('advances on each stamped write', async () => {
    const fx = await makeWorkItemFixture();
    const created = await plansService.createPlan(fx.projectId, { title: 'Stamps' }, fx.ctx);
    const planId = created.id;
    expect(await activityOf(planId)).toBeInstanceOf(Date);

    const moves = async (label: string, write: () => Promise<unknown>) => {
      const past = await backdate(planId);
      await write();
      expect((await activityOf(planId)).getTime(), label).toBeGreaterThan(past.getTime());
    };

    let addId = '';
    await moves('append', async () => {
      const r = await plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'One', kind: 'story' } }],
        fx.ctx,
      );
      addId = r.items[0]!.id;
    });
    await moves('second append', () =>
      plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Two', kind: 'story' } }],
        fx.ctx,
      ),
    );
    await moves('deepen', () =>
      plansService.deepenProposal(planId, addId, { descriptionMd: 'Body' }, fx.ctx),
    );
    await moves('step', () =>
      plansService.recordPlanStep(
        planId,
        { sessionKey: 's', kind: 'settle', targetRef: null },
        fx.ctx,
      ),
    );
    await moves('end step', () => plansService.endPlanStep(planId, 's', fx.ctx));
    await moves('correction', () =>
      plansService.correctProposal(planId, addId, { title: 'One!' }, fx.ctx),
    );
    await moves('brief correction', () =>
      plansService.correctPlanBrief(planId, { title: 'Renamed' }, fx.ctx),
    );
    const second = (await plansService.getPlan(planId, fx.ctx)).items.find((i) => i.id !== addId)!;
    await moves('withdrawal', () => plansService.withdrawProposal(planId, second.id, fx.ctx));

    // The DECISIONS do not stamp it.
    let stamp = await backdate(planId);
    await plansService.markPlanned(planId, fx.ctx);
    expect((await activityOf(planId)).getTime(), 'markPlanned').toBe(stamp.getTime());
    await moves('update on a planned plan', () =>
      plansService.updateProposal(planId, addId, { title: 'Edited in review' }, fx.ctx),
    );
    stamp = await backdate(planId);
    await plansService.approvePlan(planId, fx.ctx);
    expect((await activityOf(planId)).getTime(), 'approvePlan').toBe(stamp.getTime());
  });

  it('does not move on a decline', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    const stamp = await backdate(planId);
    await plansService.declinePlan(planId, fx.ctx);
    expect((await activityOf(planId)).getTime()).toBe(stamp.getTime());
  });
});

describe('the review read carries both fields', () => {
  it('returns lastActivityAt and inFlightSteps ordered by startedAt, and [] once planned', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'first', kind: 'settle', targetRef: null },
      fx.ctx,
    );
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'second', kind: 'author', targetRef: `planItem:${addId}` },
      fx.ctx,
    );

    const live = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(live.lastActivityAt).toBe((await activityOf(planId)).toISOString());
    expect(live.inFlightSteps?.map((s) => [s.sessionKey, s.kind, s.targetRef])).toEqual([
      ['first', 'settle', null],
      ['second', 'author', `planItem:${addId}`],
    ]);
    expect(Object.keys(live.inFlightSteps![0]!).sort()).toEqual([
      'kind',
      'providerWait',
      'sessionKey',
      'startedAt',
      'targetRef',
    ]);

    await plansService.markPlanned(planId, fx.ctx);
    // The rows are still there — nobody cleared them — and the read hides them.
    expect(await stepsOf(planId)).toHaveLength(2);
    const closed = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(closed.inFlightSteps).toEqual([]);
    expect(typeof closed.lastActivityAt).toBe('string');
  });
});

describe('REAL concurrency — parallel transactions against one plan row', () => {
  it('six sessions recording at once leave exactly six rows', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        plansService.recordPlanStep(
          planId,
          {
            sessionKey: `author-${i}`,
            kind: 'author',
            targetRef: i % 2 ? null : `planItem:${addId}`,
          },
          fx.ctx,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await stepsOf(planId)).toHaveLength(6);
  });

  it('a step racing markPlanned ends committed-then-hidden or refused — nothing else', async () => {
    for (let round = 0; round < 4; round += 1) {
      const fx = await makeWorkItemFixture({ name: `Race ${round}`, identifier: `RC${round}` });
      const { planId } = await generatingPlan(fx);
      const [step, close] = await Promise.allSettled([
        plansService.recordPlanStep(
          planId,
          { sessionKey: 'racer', kind: 'settle', targetRef: null },
          fx.ctx,
        ),
        plansService.markPlanned(planId, fx.ctx),
      ]);
      expect(close.status).toBe('fulfilled');
      const read = await planReviewService.getPlanReview(planId, fx.ctx);
      expect(read.status).toBe('planned');
      expect(read.inFlightSteps).toEqual([]);
      if (step.status === 'fulfilled') {
        // Committed first: the row exists, and was written while the plan was
        // still generating (its start precedes the close).
        const rows = await stepsOf(planId);
        expect(rows).toHaveLength(1);
        const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
        expect(rows[0]!.startedAt.getTime()).toBeLessThanOrEqual(plan.plannedAt!.getTime());
      } else {
        expect(step.reason).toBeInstanceOf(PlanNotGeneratingError);
        expect((step.reason as PlanNotGeneratingError).code).toBe('PLAN_NOT_GENERATING');
        expect(await stepsOf(planId)).toEqual([]);
      }
    }
  });
});

describe('plan_step RLS — the gate is the parent plan', () => {
  async function asAppRole<T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx);
    });
  }

  it('a step on another workspace’s plan is neither readable nor writable', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await plansService.recordPlanStep(
      planB.planId,
      { sessionKey: 'b', kind: 'settle', targetRef: null },
      b.ctx,
    );

    const seen = await asAppRole(a.workspaceId, (tx) => tx.planStep.findMany());
    expect(seen).toEqual([]);

    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.planStep.create({
          data: {
            planId: planB.planId,
            sessionKey: 'intruder',
            kind: 'settle',
            startedAt: new Date(),
          },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    const deleted = await asAppRole(a.workspaceId, (tx) =>
      tx.planStep.deleteMany({ where: { planId: planB.planId } }),
    );
    expect(deleted.count).toBe(0);
    expect(await stepsOf(planB.planId)).toHaveLength(1);

    const own = await asAppRole(b.workspaceId, (tx) => tx.planStep.findMany());
    expect(own).toHaveLength(1);
  });
});
