import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { InvalidPlanStepError, PlanNotGeneratingError } from '@/lib/plans/errors';
import { PLAN_NARRATION_BATCH_MAX, PLAN_NARRATION_SENTENCE_MAX } from '@/lib/plans/planNarration';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { markEveryAddWritten } from '../../helpers/walkWritten';
import { truncateAuthTables } from '../../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../../helpers/sqlstate';

// Story MOTIR-8060 · Subtask MOTIR-8062 — a `generating` plan KEEPS what its
// planner sessions said while they worked (`plan_narration`), and the words each
// session's step was reported with (`plan_narration_session`), so the chat panel
// can show the narration under the step it belongs to — during the run and after
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
    [{ op: 'add', proposedFields: { title: 'The picker story', kind: 'story' } }],
    fx.ctx,
  );
  return { planId: plan.id, addId: appended.items[0]!.id };
}

const narrationOf = (planId: string) =>
  adminDb.planNarration.findMany({ where: { planId }, orderBy: { seq: 'asc' } });
const sessionsOf = (planId: string) =>
  adminDb.planNarrationSession.findMany({ where: { planId }, orderBy: { firstReportedAt: 'asc' } });

const settle = (planId: string, fx: WorkItemFixture, sessionKey = 's1') =>
  plansService.recordPlanStep(planId, { sessionKey, kind: 'settle', targetRef: null }, fx.ctx);

describe('recordPlanNarration — appends the session’s sentences, in order', () => {
  it('stores each sentence cleaned, with a plan-wide seq that continues across calls and sessions', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx, 'a');
    await settle(planId, fx, 'b');

    const first = await plansService.recordPlanNarration(
      planId,
      { sessionKey: 'a', narration: ['Reading the brief.', '  Two\nepics,  likely. '] },
      fx.ctx,
    );
    expect(first.map((n) => [n.seq, n.body])).toEqual([
      [1, 'Reading the brief.'],
      [2, 'Two epics, likely.'],
    ]);

    const second = await plansService.recordPlanNarration(
      planId,
      { sessionKey: 'b', narration: ['Laying the top level.'] },
      fx.ctx,
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ sessionKey: 'b', seq: 3, body: 'Laying the top level.' });

    const rows = await narrationOf(planId);
    expect(rows.map((r) => [r.sessionKey, r.seq, r.body])).toEqual([
      ['a', 1, 'Reading the brief.'],
      ['a', 2, 'Two epics, likely.'],
      ['b', 3, 'Laying the top level.'],
    ]);
    // The DTO reports the STORED row, not a value the service made up.
    expect(first[0]!.id).toBe(rows[0]!.id);
    expect(first[0]!.createdAt).toBe(rows[0]!.createdAt.toISOString());
  });

  it('cuts an over-long sentence to the cap with an ellipsis', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx);
    const [row] = await plansService.recordPlanNarration(
      planId,
      { sessionKey: 's1', narration: ['x'.repeat(PLAN_NARRATION_SENTENCE_MAX * 2)] },
      fx.ctx,
    );
    expect(Array.from(row!.body)).toHaveLength(PLAN_NARRATION_SENTENCE_MAX);
    expect(row!.body.endsWith('…')).toBe(true);
  });

  it('stamps the plan’s activity — narration is a sign of life', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await adminDb.plan.update({ where: { id: planId }, data: { lastActivityAt: past } });

    await plansService.recordPlanNarration(
      planId,
      { sessionKey: 's1', narration: ['Still here.'] },
      fx.ctx,
    );
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.lastActivityAt!.getTime()).toBeGreaterThan(past.getTime());
  });

  it('two concurrent calls on one plan both land, with distinct, gap-free seqs', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx, 'a');
    await settle(planId, fx, 'b');

    await Promise.all([
      plansService.recordPlanNarration(
        planId,
        { sessionKey: 'a', narration: ['a1', 'a2', 'a3'] },
        fx.ctx,
      ),
      plansService.recordPlanNarration(
        planId,
        { sessionKey: 'b', narration: ['b1', 'b2', 'b3'] },
        fx.ctx,
      ),
    ]);

    const rows = await narrationOf(planId);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // Each batch is contiguous — the plan lock serialises the two appends.
    const order = rows.map((r) => r.body).join(',');
    expect(['a1,a2,a3,b1,b2,b3', 'b1,b2,b3,a1,a2,a3']).toContain(order);
  });

  it('keeps the narration once the plan leaves `generating`, and after its sessions end', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx);
    await plansService.recordPlanNarration(
      planId,
      { sessionKey: 's1', narration: ['Kept.'] },
      fx.ctx,
    );
    await plansService.endPlanStep(planId, 's1', fx.ctx);
    // The walk's author sessions finished every card (Bug MOTIR-11701: else it closes `stopped`).
    await markEveryAddWritten(planId);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect((await narrationOf(planId)).map((r) => r.body)).toEqual(['Kept.']);
    expect(await sessionsOf(planId)).toHaveLength(1);
  });
});

describe('recordPlanNarration — refusals record nothing', () => {
  it.each([
    ['an empty batch', []],
    ['a batch over the cap', Array.from({ length: PLAN_NARRATION_BATCH_MAX + 1 }, () => 'x')],
    ['a blank sentence', ['Fine.', '   ']],
    ['a non-string sentence', ['Fine.', 42]],
    ['not an array', 'Just a string.'],
  ])('refuses %s with InvalidPlanStepError', async (_label, narration) => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx);
    await expect(
      plansService.recordPlanNarration(planId, { sessionKey: 's1', narration }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await narrationOf(planId)).toEqual([]);
  });

  it('refuses a session that holds no step — never reported, or already ended', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await expect(
      plansService.recordPlanNarration(planId, { sessionKey: 'ghost', narration: ['Hi.'] }, fx.ctx),
    ).rejects.toThrow(/has no step on this plan/);

    await settle(planId, fx, 'gone');
    await plansService.endPlanStep(planId, 'gone', fx.ctx);
    await expect(
      plansService.recordPlanNarration(planId, { sessionKey: 'gone', narration: ['Hi.'] }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await narrationOf(planId)).toEqual([]);
  });

  it('refuses on a plan that is not `generating`', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      plansService.recordPlanNarration(planId, { sessionKey: 's1', narration: ['Late.'] }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
    expect(await narrationOf(planId)).toEqual([]);
  });

  it('reportPlanStep refuses both arms at once, neither, and a narration with a target', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);
    await settle(planId, fx);
    for (const input of [
      { sessionKey: 's1', targetRef: null, step: 'settle' as const, narration: ['Both.'] },
      { sessionKey: 's1', targetRef: null },
      { sessionKey: 's1', targetRef: `planItem:${addId}`, narration: ['Aimed.'] },
    ]) {
      await expect(plansService.reportPlanStep(planId, input, fx.ctx)).rejects.toBeInstanceOf(
        InvalidPlanStepError,
      );
    }
    expect(await narrationOf(planId)).toEqual([]);

    const ok = await plansService.reportPlanStep(
      planId,
      { sessionKey: 's1', targetRef: null, narration: ['Fine.'] },
      fx.ctx,
    );
    expect(ok.kind).toBe('narration');
  });
});

describe('a step report records the session’s step words', () => {
  it('records kind, ref and the RESOLVED title of a plan add; a later step replaces them, firstReportedAt stays', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, addId } = await generatingPlan(fx);

    await settle(planId, fx, 's');
    const [first] = await sessionsOf(planId);
    expect(first).toMatchObject({
      sessionKey: 's',
      stepKind: 'settle',
      targetRef: null,
      targetTitle: null,
    });

    await plansService.recordPlanStep(
      planId,
      { sessionKey: 's', kind: 'author', targetRef: `planItem:${addId}` },
      fx.ctx,
    );
    const [replaced] = await sessionsOf(planId);
    expect(replaced).toMatchObject({
      stepKind: 'author',
      targetRef: `planItem:${addId}`,
      targetTitle: 'The picker story',
    });
    expect(replaced!.firstReportedAt.getTime()).toBe(first!.firstReportedAt.getTime());
  });

  it('resolves a committed work item’s title, and keeps the words after the step ends', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    const item = await createTestWorkItem(fx, { title: 'Billing epic', kind: 'story' });

    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'lay-1', kind: 'lay', targetRef: item.id },
      fx.ctx,
    );
    await plansService.endPlanStep(planId, 'lay-1', fx.ctx);

    const [row] = await sessionsOf(planId);
    expect(row).toMatchObject({ stepKind: 'lay', targetRef: item.id, targetTitle: 'Billing epic' });
  });

  it('orders sessions by when each first reported', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx, 'first');
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'second', kind: 'lay', targetRef: null },
      fx.ctx,
    );
    // Re-reporting `first` must not move it behind `second`.
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'first', kind: 'author', targetRef: null },
      fx.ctx,
    );
    expect((await sessionsOf(planId)).map((s) => s.sessionKey)).toEqual(['first', 'second']);
  });

  it('deleting the plan cascades both tables', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await generatingPlan(fx);
    await settle(planId, fx);
    await plansService.recordPlanNarration(
      planId,
      { sessionKey: 's1', narration: ['Bye.'] },
      fx.ctx,
    );
    await adminDb.plan.delete({ where: { id: planId } });
    expect(await narrationOf(planId)).toEqual([]);
    expect(await sessionsOf(planId)).toEqual([]);
  });
});

describe('plan_narration / plan_narration_session RLS — the gate is the parent plan', () => {
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

  it('another workspace’s narration is neither readable nor writable', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await settle(planB.planId, b, 'b');
    await plansService.recordPlanNarration(
      planB.planId,
      { sessionKey: 'b', narration: ['Private.'] },
      b.ctx,
    );

    expect(await asAppRole(a.workspaceId, (tx) => tx.planNarration.findMany())).toEqual([]);
    expect(await asAppRole(a.workspaceId, (tx) => tx.planNarrationSession.findMany())).toEqual([]);

    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.planNarration.create({
          data: { planId: planB.planId, sessionKey: 'x', seq: 99, body: 'Intruder.' },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.planNarrationSession.create({
          data: { planId: planB.planId, sessionKey: 'x', stepKind: 'settle' },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    expect(await asAppRole(b.workspaceId, (tx) => tx.planNarration.findMany())).toHaveLength(1);
    expect(await asAppRole(b.workspaceId, (tx) => tx.planNarrationSession.findMany())).toHaveLength(
      1,
    );
  });
});
