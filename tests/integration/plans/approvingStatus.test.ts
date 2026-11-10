import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// BUG MOTIR-9006 — A PLAN BEING APPROVED STILL READ "WAITING FOR APPROVAL".
//
// Approve materialized every proposal inside ONE long transaction and wrote `approved` at
// its end, so under READ COMMITTED every other reader saw `planned` (and an `awaiting`
// gate) until the commit: the To-approve row said Review, a re-opened overlay offered
// Approve / Decline / edit / revise, and each of those either queued on the plan's lock
// and then failed — on Prisma's default budget, as a bare P2028 — or, for a revise,
// dispatched a paid planning job first.
//
// The approve now CLAIMS the plan (`approving`) in a short transaction of its own before
// materialize opens. This file holds the approve OPEN mid-materialize and reads the plan
// from other connections — exactly the reporter's situation — then lets it commit.
//
// Mocked: the motir-ai boundary (a revise must dispatch NOTHING, which is asserted), the
// job bus. Every service, repository, lock and transaction is real.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(async () => ({ jobId: 'job-should-not-exist' })),
}));

const { submitJob } = await import('@/lib/ai/motirAiClient');
const { plansService } = await import('@/lib/services/plansService');
const { planDecisionService } = await import('@/lib/services/planDecisionService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { aiPlanEditsService } = await import('@/lib/services/aiPlanEditsService');
const { releaseStalledApprovals, STALLED_APPROVAL_AFTER_MS } =
  await import('@/lib/services/stalledPlanApprovalService');
const { projectRepository } = await import('@/lib/repositories/projectRepository');
const { planRepository } = await import('@/lib/repositories/planRepository');
const { summarizeGateSubjects } = await import('@/lib/approvalGates/subjectSummary');
const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');
const { gateDecisionRefusalResponse } = await import('@/lib/approvalGates/decisionRefusalResponse');
const errors = await import('@/lib/plans/errors');
const { ApprovalGateStaleSubjectError } = await import('@/lib/approvalGates/errors');

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  vi.mocked(submitJob).mockClear();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });

/** A `planned` plan proposing one `add` per title — closing it raises its gate. */
async function plannedPlan(titles: string[]) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'A plan' }, fx.ctx);
  const itemIds: string[] = [];
  for (const title of titles) {
    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title, kind: 'task', type: 'code' } }],
      fx.ctx,
    );
    itemIds.push(after.items[after.items.length - 1]!.id);
  }
  await plansService.markPlanned(plan.id, fx.ctx);
  const read = await approvalGatesService.getForPlan({ planId: plan.id }, fx.ctx);
  return { planId: plan.id, itemIds, stamp: read.stamp! };
}

/**
 * HOLD the approve inside its materialize transaction — after every proposal is written
 * and before `approved` is — until `release()` is called. `markOnboardingRan` is the
 * write approve makes right between the two, on the transaction's own client.
 */
function holdMaterialize() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const inside = new Promise<void>((resolve) => (reached = resolve));
  const original = projectRepository.markOnboardingRan.bind(projectRepository);
  vi.spyOn(projectRepository, 'markOnboardingRan').mockImplementation(async (...args) => {
    reached();
    await released;
    return original(...args);
  });
  return { inside, release };
}

/** Refused AT ONCE — a writer that queued on the held lock would never settle here. */
async function refusedImmediately(work: () => Promise<unknown>): Promise<unknown> {
  const timeout = new Promise<'queued'>((resolve) => setTimeout(() => resolve('queued'), 3_000));
  const outcome = await Promise.race([
    work().then(
      () => 'resolved' as const,
      (err: unknown) => err,
    ),
    timeout,
  ]);
  expect(outcome).not.toBe('queued');
  expect(outcome).not.toBe('resolved');
  return outcome;
}

describe('the mid-approve read (MOTIR-9006 AC 1, 6)', () => {
  it('reads `approving` from a second connection while materialize runs, then `approved`', async () => {
    const { planId, stamp } = await plannedPlan(['One', 'Two', 'Three']);
    const hold = holdMaterialize();

    const approving = planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx);
    await hold.inside;

    // A SECOND CONNECTION — the admin client — sees the claim the approve committed.
    const mid = await planRow(planId);
    expect(mid.status).toBe('approving');
    expect(mid.approvingAt).toBeInstanceOf(Date);
    // …and so does every reader through the product: the plan read, and the To-approve
    // row's subject summary, on the app's own pool.
    expect((await plansService.getPlan(planId, fx.ctx)).status).toBe('approving');
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { kind: 'plan_approval', subjectId: planId },
    });
    expect(gate.state).toBe('awaiting');
    const summaries = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      summarizeGateSubjects([{ id: gate.id, kind: gate.kind, subjectId: planId }], tx),
    );
    expect(summaries.get(gate.id)).toMatchObject({ kind: 'plan_approval', approving: true });

    hold.release();
    const approved = await approving;
    expect(approved.status).toBe('approved');
    const after = await planRow(planId);
    expect(after.status).toBe('approved');
    expect(after.approvingAt).toBeNull();
  });

  it('a plan nobody is approving reads `approving: false` on its row', async () => {
    const { planId } = await plannedPlan(['One']);
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { kind: 'plan_approval', subjectId: planId },
    });
    const summaries = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      summarizeGateSubjects([{ id: gate.id, kind: gate.kind, subjectId: planId }], tx),
    );
    expect(summaries.get(gate.id)).toMatchObject({ approving: false });
  });
});

describe('every writer refuses an `approving` plan AT ONCE with PLAN_APPROVING (AC 3, 6)', () => {
  it('edit, correct, add, withdraw, brief, classification, lease, revise, approve and decline', async () => {
    const { planId, itemIds, stamp } = await plannedPlan(['One', 'Two']);
    const hold = holdMaterialize();
    const approving = planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx);
    await hold.inside;

    const attempts: Record<string, () => Promise<unknown>> = {
      edit: () => plansService.updateProposal(planId, itemIds[0]!, { title: 'Renamed' }, fx.ctx),
      correct: () =>
        plansService.correctProposal(planId, itemIds[0]!, { title: 'Corrected' }, fx.ctx),
      add: () =>
        plansService.addProposals(
          planId,
          [{ op: 'add', proposedFields: { title: 'Late', kind: 'task' } }],
          fx.ctx,
          { revision: true },
        ),
      withdraw: () => plansService.withdrawProposal(planId, itemIds[1]!, fx.ctx),
      brief: () => plansService.correctPlanBrief(planId, { title: 'New title' }, fx.ctx),
      classification: () =>
        plansService.recordRevisionClassification(
          { planId, branch: 'new_ask', evidenceMd: 'The person asked for something new.' },
          fx.ctx,
        ),
      lease: () =>
        plansService.acquireRevisionLease(planId, fx.ctx, {
          source: 'mcp',
          harness: 'Claude Code',
          model: null,
        }),
      revise: () =>
        aiPlanEditsService.submitRevise(planId, 'split it', {
          ...fx.ctx,
          projectId: fx.projectId,
          project: fx.project,
        }),
      secondApprove: () => planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx),
      decline: () => planDecisionService.decline({ planId, stamp, source: 'ui' }, fx.ctx),
    };

    for (const [name, attempt] of Object.entries(attempts)) {
      const err = await refusedImmediately(attempt);
      expect(err, name).toBeInstanceOf(errors.PlanApprovingError);
      expect((err as InstanceType<typeof errors.PlanApprovingError>).code, name).toBe(
        'PLAN_APPROVING',
      );
    }
    // A REVISE DISPATCHED NOTHING — the paid job the old pre-check let through.
    expect(submitJob).not.toHaveBeenCalled();

    hold.release();
    expect((await approving).status).toBe('approved');
    // Nothing any refused writer tried landed.
    const items = await adminDb.planItem.findMany({ where: { planId } });
    expect(items).toHaveLength(2);
    expect(items.map((i) => (i.proposedFields as { title: string }).title).sort()).toEqual([
      'One',
      'Two',
    ]);
  });

  it('the status-contract callers (approvePlan, the v1 route) hear it as the plan status `approving`', async () => {
    const { planId, stamp } = await plannedPlan(['One']);
    const hold = holdMaterialize();
    const approving = planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx);
    await hold.inside;

    try {
      const err = await refusedImmediately(() => plansService.approvePlan(planId, fx.ctx));
      expect(err).toBeInstanceOf(errors.PlanNotInExpectedStatusError);
      expect((err as InstanceType<typeof errors.PlanNotInExpectedStatusError>).actual).toBe(
        'approving',
      );
    } finally {
      hold.release();
    }
    expect((await approving).status).toBe('approved');
  });

  it('answers 409 PLAN_APPROVING on every decide route, naming how long it has run', () => {
    const since = new Date('2026-11-10T12:00:00.000Z');
    const res = gateDecisionRefusalResponse(new errors.PlanApprovingError('plan_1', since));
    expect(res?.status).toBe(409);
    return expect(res?.json()).resolves.toMatchObject({
      code: 'PLAN_APPROVING',
      planId: 'plan_1',
      approvingSince: since.toISOString(),
    });
  });

  it('is a PlanNotEditableError, so every not-editable 409 arm carries it with its own code', () => {
    const err = new errors.PlanApprovingError('plan_1', null);
    expect(err).toBeInstanceOf(errors.PlanNotEditableError);
    expect(err.status).toBe('approving');
    expect(err.message).toMatch(/is being approved:/);
    expect(err.message).not.toMatch(/since/);
  });
});

describe('a failed approval gives the plan back (AC 4)', () => {
  it('a failure inside materialize returns the plan to `planned`, its gate still asked', async () => {
    const { planId, stamp } = await plannedPlan(['One']);
    vi.spyOn(projectRepository, 'markOnboardingRan').mockRejectedValue(new Error('boom'));

    await expect(
      planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx),
    ).rejects.toThrow('boom');

    const after = await planRow(planId);
    expect(after.status).toBe('planned');
    expect(after.approvingAt).toBeNull();
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { kind: 'plan_approval', subjectId: planId },
    });
    expect(gate.state).toBe('awaiting');
    expect(await adminDb.workItem.count({ where: { title: 'One' } })).toBe(0);
    // …and it is approvable again.
    vi.restoreAllMocks();
    expect(
      (await planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx)).status,
    ).toBe('approved');
  });

  it('a timed-out approval returns the plan to `planned` and still reads as the timeout', async () => {
    const { planId, stamp } = await plannedPlan(['One']);
    vi.spyOn(projectRepository, 'markOnboardingRan').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Transaction already closed', {
        code: 'P2028',
        clientVersion: 'test',
      }),
    );

    await expect(
      planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(errors.PlanApproveTimedOutError);
    expect((await planRow(planId)).status).toBe('planned');
  });

  it('the plain path (no asked question) claims and gives back the same way', async () => {
    const { planId } = await plannedPlan(['One']);
    await adminDb.approvalGate.deleteMany({ where: { kind: 'plan_approval', subjectId: planId } });
    vi.spyOn(projectRepository, 'markOnboardingRan').mockRejectedValue(new Error('boom'));

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toThrow('boom');
    expect((await planRow(planId)).status).toBe('planned');

    vi.restoreAllMocks();
    expect((await plansService.approvePlan(planId, fx.ctx)).status).toBe('approved');
  });

  it('a press whose stamp has moved claims nothing and is refused stale', async () => {
    const { planId } = await plannedPlan(['One']);
    const update = vi.spyOn(planRepository, 'update');

    await expect(
      planDecisionService.approve({ planId, stamp: 'v1.stale.stale.stale', source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateStaleSubjectError);

    expect(update.mock.calls.some(([, data]) => data.status === 'approving')).toBe(false);
    expect((await planRow(planId)).status).toBe('planned');
  });

  it('an approve whose claim was released under it is refused rather than committed', async () => {
    const { planId, stamp } = await plannedPlan(['One']);
    // The sweep (or another approver) took the claim away between the claim and the lock.
    let swept = false;
    vi.spyOn(planRepository, 'lockById').mockImplementation(async (id, tx) => {
      const row = await planRepository.findById(id, fx.workspaceId, tx);
      if (row?.status === 'approving' && !swept) {
        swept = true;
        await adminDb.plan.update({
          where: { id },
          data: { status: 'planned', approvingAt: null },
        });
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "plan" WHERE "id" = ${id} FOR UPDATE`;
      return rows[0] ?? null;
    });

    await expect(
      planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(errors.PlanNotInExpectedStatusError);
    expect(swept).toBe(true);
    expect((await planRow(planId)).status).toBe('planned');
    expect(await adminDb.workItem.count({ where: { title: 'One' } })).toBe(0);
  });

  it("an approve that finds ANOTHER approver's claim under the lock is refused PLAN_APPROVING", async () => {
    const { planId, stamp } = await plannedPlan(['One']);
    let retaken = false;
    vi.spyOn(planRepository, 'lockById').mockImplementation(async (id, tx) => {
      const row = await planRepository.findById(id, fx.workspaceId, tx);
      if (row?.status === 'approving' && !retaken) {
        retaken = true;
        await adminDb.plan.update({ where: { id }, data: { approvingAt: new Date(0) } });
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "plan" WHERE "id" = ${id} FOR UPDATE`;
      return rows[0] ?? null;
    });

    await expect(
      planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(errors.PlanApprovingError);
    // The other claim is not this approve's to give back.
    const after = await planRow(planId);
    expect(after.status).toBe('approving');
    expect(after.approvingAt?.getTime()).toBe(0);
  });
});

describe('the stalled-approval sweep (AC 4)', () => {
  it('gives back a claim older than the bound and leaves a fresh one alone', async () => {
    const stuck = await plannedPlan(['Stuck']);
    const fresh = await plannedPlan(['Fresh']);
    const now = new Date();
    await adminDb.plan.update({
      where: { id: stuck.planId },
      data: {
        status: 'approving',
        approvingAt: new Date(now.getTime() - STALLED_APPROVAL_AFTER_MS - 1_000),
      },
    });
    await adminDb.plan.update({
      where: { id: fresh.planId },
      data: { status: 'approving', approvingAt: new Date(now.getTime() - 1_000) },
    });

    const result = await releaseStalledApprovals(now);

    expect(result).toEqual({ released: 1, planIds: [stuck.planId] });
    expect(await planRow(stuck.planId)).toMatchObject({ status: 'planned', approvingAt: null });
    expect((await planRow(fresh.planId)).status).toBe('approving');
    // Idempotent: the released plan no longer matches.
    expect(await releaseStalledApprovals(now)).toEqual({ released: 0, planIds: [] });
  });

  it('a release that fails for one plan does not stop the pass', async () => {
    const stuck = await plannedPlan(['Stuck']);
    const old = new Date(Date.now() - STALLED_APPROVAL_AFTER_MS - 60_000);
    await adminDb.plan.update({
      where: { id: stuck.planId },
      data: { status: 'approving', approvingAt: old },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(planRepository, 'releaseApprovingClaim').mockRejectedValueOnce(new Error('down'));

    expect(await releaseStalledApprovals()).toEqual({ released: 0, planIds: [] });
    expect(warn).toHaveBeenCalled();
    expect((await planRow(stuck.planId)).status).toBe('approving');
  });

  it('never releases a claim whose token moved (a later approver took it)', async () => {
    const { planId } = await plannedPlan(['One']);
    await adminDb.plan.update({
      where: { id: planId },
      data: { status: 'approving', approvingAt: new Date('2026-01-01T00:00:00Z') },
    });
    const released = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.releaseApprovingClaim(planId, new Date('2025-01-01T00:00:00Z'), tx),
    );
    expect(released).toBe(0);
    expect((await planRow(planId)).status).toBe('approving');
  });
});

describe('a failed release is best-effort and never masks the refusal', () => {
  it('logs, leaves the claim for the sweep, and still throws the approve failure', async () => {
    const { planId, stamp } = await plannedPlan(['One']);
    vi.spyOn(projectRepository, 'markOnboardingRan').mockRejectedValue(new Error('boom'));
    vi.spyOn(planRepository, 'releaseApprovingClaim').mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      planDecisionService.approve({ planId, stamp, source: 'ui' }, fx.ctx),
    ).rejects.toThrow('boom');
    expect(warn).toHaveBeenCalled();
    expect((await planRow(planId)).status).toBe('approving');
  });
});

describe('the edges of the claim and its refusals', () => {
  it('a claim on a plan that is gone is refused not-found', async () => {
    const { planId } = await plannedPlan(['One']);
    const prep = await plansService.prepareApprovePlan(planId, fx.ctx);
    await adminDb.plan.delete({ where: { id: planId } });
    await expect(plansService.claimApprovePlan(prep, fx.ctx, null)).rejects.toBeInstanceOf(
      errors.PlanNotFoundError,
    );
  });

  it('a claim on a plan that left `planned` is refused with its status', async () => {
    const { planId } = await plannedPlan(['One']);
    const prep = await plansService.prepareApprovePlan(planId, fx.ctx);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
    await expect(plansService.claimApprovePlan(prep, fx.ctx, null)).rejects.toBeInstanceOf(
      errors.PlanNotInExpectedStatusError,
    );
  });

  it('the 409 body carries a null `approvingSince` when the claim recorded none', async () => {
    const res = gateDecisionRefusalResponse(new errors.PlanApprovingError('plan_1', null));
    expect(res?.status).toBe(409);
    await expect(res?.json()).resolves.toMatchObject({ approvingSince: null });
  });

  it('a decline that reaches the handler on a plan being approved is refused under the lock', async () => {
    const { planId, stamp } = await plannedPlan(['One']);
    await adminDb.plan.update({
      where: { id: planId },
      data: { status: 'approving', approvingAt: new Date() },
    });
    // The pre-lock courtesy is skipped, as for a decline that read `planned` just
    // before the claim committed: the under-lock check is the guarantee.
    vi.spyOn(plansService, 'refusePlanBeingApproved').mockResolvedValue(undefined);
    await expect(
      planDecisionService.decline({ planId, stamp, source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(errors.PlanApprovingError);
    expect((await planRow(planId)).status).toBe('approving');
  });

  it('a revise on a claim with no recorded time is still refused, and dispatches nothing', async () => {
    const { planId } = await plannedPlan(['One']);
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'approving' } });
    const err = await aiPlanEditsService
      .submitRevise(planId, 'split it', { ...fx.ctx, projectId: fx.projectId, project: fx.project })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(errors.PlanApprovingError);
    expect((err as InstanceType<typeof errors.PlanApprovingError>).approvingSince).toBeNull();
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('the sweep leaves a candidate whose claim moved between discovery and release', async () => {
    const { planId } = await plannedPlan(['One']);
    await adminDb.plan.update({
      where: { id: planId },
      data: { status: 'approving', approvingAt: new Date() },
    });
    // Discovery saw an OLD token; the row now carries a newer approver's.
    vi.spyOn(planRepository, 'listStalledApprovals').mockResolvedValue([
      { id: planId, workspaceId: fx.workspaceId, approvingAt: new Date(0) },
    ]);
    expect(await releaseStalledApprovals()).toEqual({ released: 0, planIds: [] });
    expect((await planRow(planId)).status).toBe('approving');
  });
});
