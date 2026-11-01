import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  InvalidPlanStepError,
  PlanNotFoundError,
  PlanNotGeneratingError,
} from '@/lib/plans/errors';
import { PLAN_GAP_BATCH_MAX } from '@/lib/plans/planRaisedGap';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../../helpers/sqlstate';

// MOTIR-10176 — a plan KEEPS every gap its author sessions raised
// (`plan_raised_gap`), the moment it is raised, and stamps the ones its level's
// amend was handed. A walk that dies and is resumed reads the unamended ones back
// and hands them to the amend, so a gap the dead attempt raised is never lost.
// Every case drives `plansService` against real Postgres and reads the stored rows
// back through `adminDb`, so a service that refused yet answered cannot pass.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function generatingPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The serverless adapter', kind: 'story' } }],
    fx.ctx,
  );
  return plan.id;
}

const rowsOf = (planId: string) =>
  adminDb.planRaisedGap.findMany({ where: { planId }, orderBy: { seq: 'asc' } });

const execRole = {
  op: 'raise',
  id: 'g-1',
  level: 'planItem:story',
  raisedBy: 'planItem:adapter',
  what: 'Nothing creates the Lambda execution role `mh-shared-exec`.',
  decision: 'Which account owns the shared execution role — the infra owner decides.',
  after: 'planItem:bucket',
};

describe('recordPlanGaps — a raised gap is on the plan before the next session opens', () => {
  it('records each raise with a plan-wide seq, in call order, unamended', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);

    const first = await plansService.recordPlanGaps(
      planId,
      { sessionKey: 'plan.py:run:006', gaps: [execRole] },
      fx.ctx,
    );
    expect(first).toEqual({ raised: ['g-1'], alreadyRaised: [], amended: [] });
    await plansService.recordPlanGaps(
      planId,
      {
        sessionKey: 'plan.py:run:009',
        gaps: [{ op: 'raise', id: 'g-2', what: 'Nothing creates the GitHub-OIDC push roles.' }],
      },
      fx.ctx,
    );

    const rows = await rowsOf(planId);
    expect(rows.map((r) => [r.seq, r.gapId, r.sessionKey])).toEqual([
      [1, 'g-1', 'plan.py:run:006'],
      [2, 'g-2', 'plan.py:run:009'],
    ]);
    expect(rows[0]).toMatchObject({
      level: 'planItem:story',
      raisedBy: 'planItem:adapter',
      what: execRole.what,
      decision: execRole.decision,
      after: 'planItem:bucket',
      before: null,
      amendedAt: null,
      answerRefs: [],
    });
    expect(rows[1]).toMatchObject({ level: null, raisedBy: null, decision: null });
  });

  it('keeps a repeated raise of the same id as it was — a retried report records nothing twice', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanGaps(planId, { sessionKey: 's', gaps: [execRole] }, fx.ctx);
    const again = await plansService.recordPlanGaps(
      planId,
      {
        sessionKey: 's',
        gaps: [
          { ...execRole, what: 'reworded' },
          { ...execRole, id: 'g-2' },
        ],
      },
      fx.ctx,
    );
    expect(again).toEqual({ raised: ['g-2'], alreadyRaised: ['g-1'], amended: [] });
    const rows = await rowsOf(planId);
    expect(rows.map((r) => [r.gapId, r.what])).toEqual([
      ['g-1', execRole.what],
      ['g-2', execRole.what],
    ]);
  });

  it('stamps an amend with the refs it named, and a raise after the amend as already amended', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanGaps(
      planId,
      { sessionKey: 's', gaps: [execRole, { op: 'raise', id: 'g-2', what: 'push roles' }] },
      fx.ctx,
    );
    const amended = await plansService.recordPlanGaps(
      planId,
      {
        sessionKey: 'amend',
        gaps: [
          { op: 'amend', id: 'g-1', refs: ['planItem:role', 'planItem:role'], open: 'the raiser' },
          { op: 'amend', id: 'g-2' },
          { op: 'raise', id: 'g-3', what: 'raised after the amend', amended: true },
        ],
      },
      fx.ctx,
    );
    expect(amended).toEqual({ raised: ['g-3'], alreadyRaised: [], amended: ['g-1', 'g-2'] });
    const rows = await rowsOf(planId);
    expect(rows.map((r) => [r.gapId, r.amendedAt !== null, r.answerRefs, r.answerOpen])).toEqual([
      ['g-1', true, ['planItem:role'], 'the raiser'],
      ['g-2', true, [], null],
      ['g-3', true, [], null],
    ]);
  });

  it('refuses an amend of an id the plan does not hold, and writes nothing from the call', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await expect(
      plansService.recordPlanGaps(
        planId,
        { sessionKey: 's', gaps: [execRole, { op: 'amend', id: 'nope' }] },
        fx.ctx,
      ),
    ).rejects.toThrow(/does not hold \(nope\)/);
    expect(await rowsOf(planId)).toEqual([]);
  });

  it('refuses a malformed batch whole', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const refused = [
      [],
      Array.from({ length: PLAN_GAP_BATCH_MAX + 1 }, (_, i) => ({ ...execRole, id: `g${i}` })),
      [{ ...execRole, what: '  ' }],
      [{ ...execRole, id: '' }],
      [{ ...execRole, op: 'close' }],
      [{ ...execRole, amended: 'yes' }],
      [{ op: 'amend', id: 'g-1', refs: [''] }],
    ];
    for (const gaps of refused) {
      await expect(
        plansService.recordPlanGaps(planId, { sessionKey: 's', gaps }, fx.ctx),
      ).rejects.toBeInstanceOf(InvalidPlanStepError);
    }
    await expect(
      plansService.recordPlanGaps(planId, { sessionKey: '', gaps: [execRole] }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await rowsOf(planId)).toEqual([]);
  });

  it('is refused once the plan is no longer generating', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      plansService.recordPlanGaps(planId, { sessionKey: 's', gaps: [execRole] }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
    expect(await rowsOf(planId)).toEqual([]);
  });

  it('is the fifth exclusive form of reportPlanStep, and names no target', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const result = await plansService.reportPlanStep(
      planId,
      { sessionKey: 's', targetRef: null, gaps: [execRole] },
      fx.ctx,
    );
    expect(result).toEqual({
      kind: 'gaps',
      gaps: { raised: ['g-1'], alreadyRaised: [], amended: [] },
    });
    await expect(
      plansService.reportPlanStep(
        planId,
        { sessionKey: 's', targetRef: 'planItem:x', gaps: [{ ...execRole, id: 'g-2' }] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    await expect(
      plansService.reportPlanStep(
        planId,
        { sessionKey: 's', targetRef: null, step: 'settle', gaps: [{ ...execRole, id: 'g-2' }] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await rowsOf(planId)).toHaveLength(1);
  });
});

describe('listPlanRaisedGaps — the record a resumed walk and the briefing read', () => {
  it('reads every gap back in raise order with its amend state, on a decided plan too', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanGaps(
      planId,
      { sessionKey: 's', gaps: [execRole, { op: 'raise', id: 'g-2', what: 'push roles' }] },
      fx.ctx,
    );
    await plansService.recordPlanGaps(
      planId,
      { sessionKey: 'amend', gaps: [{ op: 'amend', id: 'g-2', refs: ['planItem:roles'] }] },
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    const gaps = await plansService.listPlanRaisedGaps(planId, fx.ctx);
    expect(gaps.map((g) => [g.seq, g.id, g.amended, g.answer])).toEqual([
      [1, 'g-1', false, null],
      [2, 'g-2', true, { refs: ['planItem:roles'], open: null }],
    ]);
    expect(gaps[0]).toMatchObject({
      sessionKey: 's',
      level: 'planItem:story',
      raisedBy: 'planItem:adapter',
      what: execRole.what,
      decision: execRole.decision,
      after: 'planItem:bucket',
      before: null,
      note: null,
      amendedAt: null,
    });
    expect(typeof gaps[0]!.raisedAt).toBe('string');
    expect(typeof gaps[1]!.amendedAt).toBe('string');
  });

  it('answers another workspace’s plan as not found', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await expect(plansService.listPlanRaisedGaps(planB, a.ctx)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });

  it('cascades away with the plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanGaps(planId, { sessionKey: 's', gaps: [execRole] }, fx.ctx);
    await adminDb.plan.delete({ where: { id: planId } });
    expect(await rowsOf(planId)).toEqual([]);
  });
});

describe('the hosted planner’s two doors — written through the step, read back on resume', () => {
  it('records through recordPlanStepForJob and reads back on readPlanProposals', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await adminDb.plan.update({ where: { id: planId }, data: { sourceJobId: 'job-resume' } });
    const auth = { ctx: fx.ctx, projectId: fx.projectId };

    const written = await aiGenerationService.recordPlanStepForJob(
      {
        jobId: 'job-resume',
        planId,
        sessionKey: 'ai:job-dead:7',
        targetRef: null,
        gaps: [execRole],
      },
      auth,
    );
    expect(written).toEqual({
      planId,
      gaps: { raised: ['g-1'], alreadyRaised: [], amended: [] },
    });

    const read = await aiGenerationService.readPlanProposals('job-resume', fx.ctx);
    expect(read.id).toBe(planId);
    expect(read.items).toHaveLength(1);
    expect(read.raisedGaps.map((g) => [g.id, g.amended, g.what])).toEqual([
      ['g-1', false, execRole.what],
    ]);
  });
});

describe('plan_raised_gap RLS — the gate is the parent plan', () => {
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

  it('another workspace’s gaps are neither readable nor writable', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await plansService.recordPlanGaps(planB, { sessionKey: 'b', gaps: [execRole] }, b.ctx);

    expect(await asAppRole(a.workspaceId, (tx) => tx.planRaisedGap.findMany())).toEqual([]);
    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.planRaisedGap.create({
          data: { planId: planB, gapId: 'x', sessionKey: 'x', seq: 99, what: 'smuggled' },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    expect(await asAppRole(b.workspaceId, (tx) => tx.planRaisedGap.findMany())).toHaveLength(1);
  });
});
