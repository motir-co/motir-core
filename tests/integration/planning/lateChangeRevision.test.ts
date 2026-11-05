import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A CHANGE FORWARDED AFTER THE WALK FINISHED (Story MOTIR-7990 · MOTIR-7997) —
// submitted as ONE REVISE_PLAN revision of the run's own plan, or refused with a
// reason and its text. Never dropped.
//
// Real Postgres for the session, the mailbox, the plan and its trail. Mocked: the
// motir-ai boundary (`submitJob` / `getJob`) and the session/active-project seam
// the late-changes route reads.

const RUN_JOB = 'job-run-1';

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

vi.mock('@/lib/services/planReviewService', () => ({
  planReviewService: {
    getPlanReview: async () => {
      throw Object.assign(new Error('nope'), { code: 'PLAN_NOT_FOUND' });
    },
  },
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planChangeMailboxService } = await import('@/lib/services/planChangeMailboxService');
const { aiPlanEditsService } = await import('@/lib/services/aiPlanEditsService');
const { POST: lateChanges } = await import('@/app/api/ai/plan-change/session/late-changes/route');

let fx: WorkItemFixture;
let ctx: ProjectContext;
let sessionId: string;
let planId: string;
let askSeq = 0;

function setRun(status: 'running' | 'succeeded' | 'failed' | 'canceled') {
  jobs.set(RUN_JOB, { jobId: RUN_JOB, status, result: null, error: null });
}

async function plannedPlan(): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'The run plan', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The proposal', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  // The plan IS the run's: the generate seam binds it to the job, the session owns it.
  await adminDb.plan.update({ where: { id: plan.id }, data: { sourceJobId: RUN_JOB, sessionId } });
  return plan.id;
}

function lateReq(over: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/ai/plan-change/session/late-changes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, runJobId: RUN_JOB, ...over }),
  });
}

/** Attach a forwarded change while the run is `running` (it is ACCEPTED). */
async function strand(body: string, key: string) {
  setRun('running');
  await planChangeMailboxService.attachTurn(
    { jobId: RUN_JOB, sessionId, body, idempotencyKey: key },
    ctx,
  );
}

async function pendingTurns() {
  return (await planChangeMailboxService.peekForJob(RUN_JOB, ctx, sessionId)).turns;
}

async function revisionStarts() {
  return adminDb.planRevision.findMany({
    where: { planId, changeKind: 'revision_started' },
    orderBy: { changedAt: 'asc' },
  });
}

/** A mid-run turn that the answering session read as a change to forward. */
async function settledForward(body: string) {
  const jobId = `job-ask-${++askSeq}`;
  submitJobMock.mockResolvedValueOnce({ jobId });
  await aiAskService.submitMidRunTurn(body, ctx, { sessionId, runJobId: RUN_JOB, planId });
  jobs.set(jobId, {
    jobId,
    status: 'succeeded',
    result: { ask: { intent: 'plan_change', forward: { text: body } } },
    error: null,
  });
  return jobId;
}

beforeEach(async () => {
  askSeq = 0;
  jobs.clear();
  submitJobMock.mockReset();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  ctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = ctx;
  const row = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      lastJobId: RUN_JOB,
      lastSubmittedAt: new Date(),
    },
  });
  sessionId = row.id;
  planId = await plannedPlan();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a forward REFUSED because the run already ended', () => {
  it('settles revised_late: one revision of the run plan, on its trail, the turn marked', async () => {
    const jobId = await settledForward('add a reporting epic');
    setRun('succeeded');
    submitJobMock.mockClear();
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-1' });
    const plansBefore = await adminDb.plan.count({ where: { projectId: fx.projectId } });

    const settled = await aiAskService.settle(jobId, ctx, { sessionId });

    expect(settled).toMatchObject({
      outcome: 'revised_late',
      planId,
      revisionJobId: 'job-rev-1',
      text: 'add a reporting epic',
    });
    // ONE revise submit, on the run's plan, carrying the forwarded body verbatim.
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [kind, , context] = submitJobMock.mock.calls[0]!;
    expect(kind).toBe('plan');
    expect(context).toMatchObject({ planId });
    expect((context as { prompt: string }).prompt).toContain('add a reporting epic');
    // No second plan; the trail carries a revision_started bound to the revision job.
    expect(await adminDb.plan.count({ where: { projectId: fx.projectId } })).toBe(plansBefore);
    const starts = await revisionStarts();
    expect(starts).toHaveLength(1);
    expect(starts[0]!.diff).toMatchObject({ revision: true, jobId: 'job-rev-1' });
    // The user turn is recorded plan_change with the marker; nothing was mailboxed.
    const turn = (await planChangeSessionsService.getById(ctx, sessionId)).turns.find(
      (t) => t.jobId === jobId,
    )!;
    expect(turn).toMatchObject({
      intent: 'plan_change',
      revisedLate: { revisionJobId: 'job-rev-1' },
    });
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(0);
    // The session now names the revision as its run (MOTIR-10455), so the reopened
    // overlay's Stop addresses the job that is actually writing the plan.
    const bound = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(bound.lastJobId).toBe('job-rev-1');
  });

  it('a replayed settle answers revised_late again and submits nothing', async () => {
    const jobId = await settledForward('add a reporting epic');
    setRun('succeeded');
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-1' });
    await aiAskService.settle(jobId, ctx, { sessionId });
    submitJobMock.mockClear();

    const again = await aiAskService.settle(jobId, ctx, { sessionId });

    expect(again).toMatchObject({ outcome: 'revised_late', planId, revisionJobId: 'job-rev-1' });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await revisionStarts()).toHaveLength(1);
  });

  it('a replayed settle whose revision no longer names a plan does not answer revised_late from stale state', async () => {
    const jobId = await settledForward('add a reporting epic');
    setRun('succeeded');
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-1' });
    await aiAskService.settle(jobId, ctx, { sessionId });
    submitJobMock.mockClear();
    // The revision job no longer resolves to a plan: the marker alone is no answer.
    const find = vi.spyOn(plansService, 'findPlanIdForJob').mockResolvedValueOnce(null);

    const again = await aiAskService.settle(jobId, ctx, { sessionId });

    expect(find).toHaveBeenCalledWith('job-rev-1', ctx);
    // It is re-derived instead: the revision it started is the session's run now
    // (MOTIR-10455), so the finished walk no longer addresses the thread and the
    // forward is refused as superseded, with the words kept — and no second
    // revision starts.
    expect(again).toMatchObject({
      outcome: 'forward_refused',
      code: 'PLAN_CHANGE_MAILBOX_JOB_MISMATCH',
      jobStatus: 'superseded',
      text: 'add a reporting epic',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
    find.mockRestore();
  });

  it('a decided plan is refused PLAN_CHANGE_PLAN_DECIDED with the text, and nothing is submitted', async () => {
    for (const status of ['approved', 'declined'] as const) {
      await adminDb.plan.update({ where: { id: planId }, data: { status } });
      const jobId = await settledForward(`change after ${status}`);
      setRun('succeeded');
      submitJobMock.mockClear();

      const settled = await aiAskService.settle(jobId, ctx, { sessionId });

      expect(settled).toMatchObject({
        outcome: 'forward_refused',
        code: 'PLAN_CHANGE_PLAN_DECIDED',
        jobStatus: 'succeeded',
        text: `change after ${status}`,
      });
      expect(submitJobMock).not.toHaveBeenCalled();
    }
  });

  it('a FAILED run is refused PLAN_CHANGE_RUN_FAILED with the text', async () => {
    const jobId = await settledForward('late idea');
    setRun('failed');
    submitJobMock.mockClear();

    const settled = await aiAskService.settle(jobId, ctx, { sessionId });

    expect(settled).toMatchObject({
      outcome: 'forward_refused',
      code: 'PLAN_CHANGE_RUN_FAILED',
      text: 'late idea',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('a run the person STOPPED is refused PLAN_CHANGE_RUN_STOPPED with the text', async () => {
    const jobId = await settledForward('late idea');
    await planChangeMailboxService.raiseStop(RUN_JOB, 'stop-1', ctx, sessionId);
    setRun('canceled');
    submitJobMock.mockClear();

    const settled = await aiAskService.settle(jobId, ctx, { sessionId });

    expect(settled).toMatchObject({
      outcome: 'forward_refused',
      code: 'PLAN_CHANGE_RUN_STOPPED',
      text: 'late idea',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('another revision holding the plan refuses PLAN_REVISION_IN_FLIGHT, the text kept, no second start', async () => {
    setRun('succeeded');
    const jobId = await settledForward('late idea');
    // The plan is held by an MCP revision — no job, so the session keeps naming the run.
    await plansService.acquireRevisionLease(planId, fx.ctx, {
      source: 'mcp',
      harness: 'Claude Code',
      model: null,
    });
    submitJobMock.mockClear();

    const settled = await aiAskService.settle(jobId, ctx, { sessionId });

    expect(settled).toMatchObject({
      outcome: 'forward_refused',
      code: 'PLAN_REVISION_IN_FLIGHT',
      text: 'late idea',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await revisionStarts()).toHaveLength(1);
  });

  it('a review-page revision moves the session onto its job: a turn addressed at the finished run is refused before any write', async () => {
    setRun('succeeded');
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-held' });
    await aiPlanEditsService.submitRevise(planId, 'someone elses revision', ctx);
    submitJobMock.mockClear();

    await expect(
      aiAskService.submitMidRunTurn('late idea', ctx, { sessionId, runJobId: RUN_JOB, planId }),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_MAILBOX_JOB_MISMATCH' });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await revisionStarts()).toHaveLength(1);
  });
});

describe('POST /api/ai/plan-change/session/late-changes — STRANDED turns', () => {
  it('claims every stranded fold turn, submits ONE revision in seq order, and answers none after', async () => {
    await strand('first change', 'k1');
    await strand('second change', 'k2');
    setRun('succeeded');
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-1' });

    const res = await lateChanges(lateReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: 'revised',
      planId,
      revisionJobId: 'job-rev-1',
      texts: ['first change', 'second change'],
    });
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const prompt = (submitJobMock.mock.calls[0]![2] as { prompt: string }).prompt;
    expect(prompt.indexOf('first change')).toBeGreaterThan(-1);
    expect(prompt.indexOf('second change')).toBeGreaterThan(prompt.indexOf('first change'));
    const entries = await adminDb.planChangeMailboxEntry.findMany({ where: { sessionId } });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.consumedAt !== null)).toBe(true);

    // The revision is the session's run now (MOTIR-10455): the finished walk no
    // longer addresses the thread, so a second call is a 404 that claims and submits
    // nothing.
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })).lastJobId,
    ).toBe('job-rev-1');
    submitJobMock.mockClear();
    const second = await lateChanges(lateReq());
    expect(second.status).toBe(404);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await revisionStarts()).toHaveLength(1);
  });

  it('two simultaneous calls submit exactly one revision between them', async () => {
    await strand('only change', 'k1');
    setRun('succeeded');
    submitJobMock.mockResolvedValue({ jobId: 'job-rev-1' });

    const [a, b] = await Promise.all([lateChanges(lateReq()), lateChanges(lateReq())]);
    const bodies = [await a.json(), await b.json()];

    expect(submitJobMock).toHaveBeenCalledTimes(1);
    expect(bodies.filter((r) => r.outcome === 'revised')).toHaveLength(1);
    expect(bodies.filter((r) => r.outcome === 'none')).toHaveLength(1);
    expect(await revisionStarts()).toHaveLength(1);
  });

  it('answers none and submits nothing when no turn is stranded', async () => {
    setRun('succeeded');

    const res = await lateChanges(lateReq());

    expect(await res.json()).toEqual({ outcome: 'none' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it.each(['approved', 'declined'] as const)(
    'a %s plan refuses PLAN_CHANGE_PLAN_DECIDED and hands every text back',
    async (status) => {
      await strand('one', 'k1');
      await strand('two', 'k2');
      await adminDb.plan.update({ where: { id: planId }, data: { status } });
      setRun('succeeded');

      const body = await (await lateChanges(lateReq())).json();

      expect(body).toMatchObject({
        outcome: 'refused',
        code: 'PLAN_CHANGE_PLAN_DECIDED',
        texts: ['one', 'two'],
        planStatus: status,
      });
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(await pendingTurns()).toEqual([]);
    },
  );

  it('a stopped run refuses PLAN_CHANGE_RUN_STOPPED with the texts', async () => {
    await strand('one', 'k1');
    await planChangeMailboxService.raiseStop(RUN_JOB, 'stop-1', ctx, sessionId);
    setRun('canceled');

    const body = await (await lateChanges(lateReq())).json();

    expect(body).toMatchObject({
      outcome: 'refused',
      code: 'PLAN_CHANGE_RUN_STOPPED',
      texts: ['one'],
    });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await pendingTurns()).toEqual([]);
  });

  it('a failed run refuses PLAN_CHANGE_RUN_FAILED with the texts', async () => {
    await strand('one', 'k1');
    setRun('failed');

    const body = await (await lateChanges(lateReq())).json();

    expect(body).toMatchObject({
      outcome: 'refused',
      code: 'PLAN_CHANGE_RUN_FAILED',
      texts: ['one'],
    });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await pendingTurns()).toEqual([]);
  });

  it('a held revision lease refuses PLAN_REVISION_IN_FLIGHT, the texts kept, no second start', async () => {
    await strand('one', 'k1');
    // An MCP revision holds the plan — no job, so the session keeps naming the run.
    await plansService.acquireRevisionLease(planId, fx.ctx, {
      source: 'mcp',
      harness: 'Claude Code',
      model: null,
    });
    setRun('succeeded');
    submitJobMock.mockClear();

    const body = await (await lateChanges(lateReq())).json();

    expect(body).toMatchObject({
      outcome: 'refused',
      code: 'PLAN_REVISION_IN_FLIGHT',
      texts: ['one'],
    });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await revisionStarts()).toHaveLength(1);
    expect(await pendingTurns()).toEqual([]);
  });

  it('leaves a restart turn and the stop alone: only fold turns are claimed', async () => {
    setRun('running');
    await planChangeMailboxService.attachTurn(
      {
        jobId: RUN_JOB,
        sessionId,
        body: 'start over',
        idempotencyKey: 'r1',
        disposition: 'restart',
      },
      ctx,
    );
    setRun('succeeded');

    const body = await (await lateChanges(lateReq())).json();

    expect(body).toEqual({ outcome: 'none' });
    expect(
      await adminDb.planChangeMailboxEntry.count({ where: { sessionId, consumedAt: null } }),
    ).toBe(1);
  });

  it('404s a runJobId that is not the addressed session run, before any claim or submit', async () => {
    await strand('one', 'k1');
    setRun('succeeded');

    const res = await lateChanges(lateReq({ runJobId: 'job-someone-elses' }));

    expect(res.status).toBe(404);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(
      await adminDb.planChangeMailboxEntry.count({ where: { sessionId, consumedAt: null } }),
    ).toBe(1);
  });

  it('400s a body naming no session or no run', async () => {
    expect((await lateChanges(lateReq({ sessionId: undefined }))).status).toBe(400);
    expect((await lateChanges(lateReq({ runJobId: '' }))).status).toBe(400);
  });
});
