import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { failureRecordFrom } from '@/lib/planChange/failureRecord';
import { AUTO_RESUMES_PER_SESSION } from '@/lib/planChange/sessionWaitingState';
import { jobErrorFromProblem } from '@/lib/ai/errors';
import type { Problem } from '@/lib/ai/types';
import { PLAN_STALLED_AFTER_MS, readPlanProgress } from '@/lib/plans/planProgress';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { homeService } from '@/lib/services/homeService';
import { planProgressService } from '@/lib/services/planProgressService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { plansService } from '@/lib/services/plansService';
import { workbenchPlanningService } from '@/lib/services/workbenchPlanningService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY MOTIR-8301's motir-core GATE (MOTIR-8310): the whole chain, through the SHIPPED code, on
// a real Postgres. motir-ai is stubbed at its HTTP boundary and nowhere else:
//
//   * `submitJob` is replaced (as `sessionResume.test.ts` does), answering `job-new-<n>`;
//   * the REAL `getJob` runs, and `fetch` answers its `GET /v1/jobs/:id` with motir-ai's RAW job
//     body per job id — `ai_job_abandoned` exactly as motir-ai's `src/jobs/reaper.ts` writes it,
//     `ai_job_failed` for a judged failure, `queued` / `running` for a job still waiting.
//
// So the raw-code → `lostMachine` parse, the relay's settle, the sweep's fast path and silence
// test, the automatic resume's bound and bind, and both progress doors all run as shipped. Every
// assertion is on a row core wrote or a read core served.

const submitJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: (...args: unknown[]) => submitJobMock(...args),
}));

const { planSessionResumeService } = await import('@/lib/services/planSessionResumeService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const T = { timeout: 180_000 };
const MIN = 60_000;
const AI_URL = 'http://motir-ai.test';

// ── motir-ai's side of `GET /v1/jobs/:id` ────────────────────────────────────────────────────

type RawJob = { status: 'queued' | 'running' | 'failed' | 'canceled'; error?: Problem };

/** The problem motir-ai's reaper writes on a job whose machine stopped renewing its lease. */
const abandoned = (jobId: string): RawJob => ({
  status: 'failed',
  error: {
    type: 'https://motir.co/errors/ai_job_abandoned',
    title: 'Planning job abandoned',
    status: 500,
    code: 'ai_job_abandoned',
    jobId,
    detail:
      'the worker holding this job stopped renewing its lease (claimedBy machine-1); nothing about the request was judged, so a resubmit is the right response',
  },
});
/** A failure motir-ai judged — the model or the walk failed, not the machine. */
const judgedFailure = (jobId: string): RawJob => ({
  status: 'failed',
  error: {
    type: 'https://motir.co/problems/ai_job_failed',
    title: 'AI job failed',
    status: 502,
    code: 'ai_job_failed',
    jobId,
    detail: 'the planner model returned an error',
  },
});

/** What motir-ai answers per job id; an unlisted `job-new-*` is a resume still queued. */
let jobs = new Map<string, RawJob>();
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const match = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
  if (url.origin !== AI_URL || !match) throw new Error(`unexpected motir-ai call: ${url.href}`);
  const jobId = decodeURIComponent(match[1]!);
  // The cancel the sweep sends for a job it gave up on by silence (MOTIR-9065).
  const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
  if (method === 'DELETE') {
    jobs.set(jobId, { status: 'canceled' });
    return Response.json({ jobId, status: 'canceled' });
  }
  const raw = jobs.get(jobId) ?? (jobId.startsWith('job-new-') ? { status: 'queued' } : null);
  if (!raw) {
    return Response.json(
      { type: 'about:blank', title: 'Not found', status: 404, code: 'not_found', jobId },
      { status: 404, headers: { 'content-type': 'application/problem+json' } },
    );
  }
  return Response.json({ jobId, status: raw.status, result: null, error: raw.error ?? null });
});

let fx: WorkItemFixture;
let jobSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  jobs = new Map();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-new-${++jobSeq}` }));
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('MOTIR_AI_URL', AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'service-token');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});
const actorCtx = () => ({ ...fx.ctx, projectId: fx.projectId });

// ── the seed ─────────────────────────────────────────────────────────────────────────────────

/**
 * An open `conversation` session whose current attempt is `jobId`, writing a `generating` plan
 * with `proposals` appended through the shipped `addProposals`. `silentMs` backdates the plan's
 * activity; `deadStep` leaves a `plan_step` row behind the way a lost session does.
 */
async function seed(
  opts: { jobId?: string; proposals?: number; silentMs?: number; deadStep?: boolean } = {},
) {
  const jobId = opts.jobId ?? 'job-old';
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Card ${Math.random()}` },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_progress' } });
  const session = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([card.identifier]),
    'Split it',
  );
  await adminDb.planChangeSession.update({ where: { id: session.id }, data: { lastJobId: jobId } });
  const plan = await plansService.createPlan(fx.projectId, { title: 'Split' }, fx.ctx);
  await adminDb.plan.update({
    where: { id: plan.id },
    data: { sessionId: session.id, sourceJobId: jobId, createdById: fx.ownerId },
  });
  for (let i = 0; i < (opts.proposals ?? 1); i++) {
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: `P${i}`, kind: 'subtask', descriptionMd: 'Body' } }],
      fx.ctx,
    );
  }
  if (opts.deadStep) {
    await plansService.recordPlanStep(
      plan.id,
      { sessionKey: 'dead', kind: 'settle', targetRef: null },
      fx.ctx,
    );
  }
  if (opts.silentMs) {
    await adminDb.plan.update({
      where: { id: plan.id },
      data: { lastActivityAt: new Date(Date.now() - opts.silentMs) },
    });
  }
  return { sessionId: session.id, planId: plan.id };
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const proposalRows = (planId: string) =>
  adminDb.planItem.findMany({
    where: { planId },
    orderBy: { id: 'asc' },
    select: { id: true, op: true, proposedFields: true, patch: true, createdAt: true },
  });

/** The relay's settle, with its DEFAULT deps — the real `getJob` reads the job. */
const relay = (jobId: string, status: 'failed' | 'canceled' = 'failed') =>
  planSessionEndService.settleFailedJob(jobId, me(), { status });
/** The sweep, with its DEFAULT deps, at an explicit instant. */
const sweep = (now: Date = new Date()) => abandonedPlanService.reconcileAbandoned({ now });

/** The reason the shipped path stores for this raw problem — computed, never re-typed. */
const reasonFor = (problem: Problem) =>
  failureRecordFrom({
    failedJobId: problem.jobId ?? null,
    now: new Date(),
    walkStop: null,
    lastPosition: null,
    error: jobErrorFromProblem(problem),
  }).failureReason;

const toResumeIds = async () =>
  ((await homeService.listToResume(actorCtx())).planningSessions ?? []).map((r) => r.sessionId);
const planningIds = async () =>
  (await workbenchPlanningService.listMyPlansBeingWritten(actorCtx())).items.map((r) => r.planId);

/** Both progress doors, each read through the one derivation at its own observation instant. */
async function progress(planId: string) {
  const p = await planRow(planId);
  const page = (
    await planProgressService.snapshotsForPlans(
      [
        {
          id: p.id,
          status: p.status,
          createdAt: p.createdAt,
          lastActivityAt: p.lastActivityAt,
          sessionId: p.sessionId,
        },
      ],
      fx.ctx,
    )
  ).get(planId)!;
  const review = (await planReviewProgress(planId))!;
  return [page, review].map((snapshot) => ({
    snapshot,
    reading: readPlanProgress(snapshot, Date.parse(snapshot.observedAt)),
  }));
}
async function planReviewProgress(planId: string) {
  const { planReviewService } = await import('@/lib/services/planReviewService');
  return (await planReviewService.getPlanReview(planId, fx.ctx)).progress;
}

/** The end state every A case reaches: one resume, the same plan, the session waiting on it. */
async function expectResumedOnce(sessionId: string, planId: string, newJobId: string) {
  const s = await sessionRow(sessionId);
  const plan = await planRow(planId);
  expect(plan.sourceJobId).toBe(newJobId);
  expect(plan.status).toBe('generating');
  expect(s.failedAt).toBeNull();
  expect(s.endedAt).toBeNull();
  expect(s.lastJobId).toBe(newJobId);
  expect(s.autoResumeCount).toBe(1);
  expect(s.lastAutoResumedAt).not.toBeNull();
  expect(plan.lastActivityAt).toEqual(s.lastAutoResumedAt);
}

/** What every B case asserts: no automatic submit, waiting in To resume, out of Planning. */
async function expectWaits(sessionId: string, planId: string) {
  expect(submitJobMock).not.toHaveBeenCalled();
  expect(await toResumeIds()).toContain(sessionId);
  expect(await planningIds()).not.toContain(planId);
}

// ── A. resumed once, by either door ──────────────────────────────────────────────────────────

describe('A · a reaped job with a saved proposal is resumed once, by either door', () => {
  it('1 · relay first: one submit signed as the starter, the proposal untouched', T, async () => {
    const { sessionId, planId } = await seed();
    jobs.set('job-old', abandoned('job-old'));
    const before = await proposalRows(planId);

    const out = await relay('job-old');

    expect(out).toMatchObject({ settled: 'recorded', lostMachine: true });
    expect(out?.autoResume).toEqual({ started: true, jobId: 'job-new-1', count: 1 });
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [kind, , , actor, extra] = submitJobMock.mock.calls[0]!;
    expect(kind).toBe('plan');
    expect(actor).toEqual({ userId: (await sessionRow(sessionId)).createdById });
    expect(extra).toEqual({ resume: { planId, fromJobId: 'job-old' } });
    await expectResumedOnce(sessionId, planId, 'job-new-1');
    expect(await proposalRows(planId)).toEqual(before);
    expect(before).toHaveLength(1);

    // A sweep afterwards (the new job queued) changes nothing and submits nothing.
    const later = await sweep();
    expect(later.outcomes).toEqual([expect.objectContaining({ planId, outcome: 'left_as_is' })]);
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    await expectResumedOnce(sessionId, planId, 'job-new-1');
  });

  it('2 · sweep first, then a late relay settle submits nothing', T, async () => {
    const { sessionId, planId } = await seed();
    jobs.set('job-old', abandoned('job-old'));

    const out = await sweep();

    expect(out.outcomes).toEqual([
      {
        planId,
        projectId: fx.projectId,
        outcome: 'awaiting_resume',
        reason: 'job_terminal',
        lostMachine: true,
        autoResume: { started: true, jobId: 'job-new-1', count: 1 },
      },
    ]);
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    await expectResumedOnce(sessionId, planId, 'job-new-1');

    expect(await relay('job-old')).toBeNull();
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    await expectResumedOnce(sessionId, planId, 'job-new-1');
  });

  it('3 · both at once, unsynchronised, ≥ 10 times: exactly one bind', T, async () => {
    for (let i = 0; i < 12; i++) {
      const jobId = `job-old-${i}`;
      const { sessionId, planId } = await seed({ jobId });
      jobs.set(jobId, abandoned(jobId));
      const submitsBefore = submitJobMock.mock.calls.length;

      await Promise.all([relay(jobId), sweep()]);

      const submitted = (
        await Promise.all(
          submitJobMock.mock.results.slice(submitsBefore).map(
            (r) =>
              r.value as Promise<{
                jobId: string;
              }>,
          ),
        )
      ).map((r) => r.jobId);
      const s = await sessionRow(sessionId);
      const plan = await planRow(planId);
      const label = `iteration ${i}: submitted ${JSON.stringify(submitted)}`;
      expect(s.autoResumeCount, label).toBe(1);
      expect(s.failedAt, label).toBeNull();
      expect(submitted, label).toContain(plan.sourceJobId);
      expect(submitted.length, label).toBeGreaterThanOrEqual(1);
      expect(submitted.length, label).toBeLessThanOrEqual(2);
      // A second submit may only be the loser's orphan: it resolves no plan.
      for (const orphan of submitted.filter((id) => id !== plan.sourceJobId)) {
        expect(await adminDb.plan.count({ where: { sourceJobId: orphan } }), label).toBe(0);
      }
    }
  });
});

// ── B. waits in To resume, as before the story ──────────────────────────────────────────────

describe('B · every other failure waits in To resume, as before the story', () => {
  it('4 · nothing saved: a lost machine with no proposal waits', T, async () => {
    const { sessionId, planId } = await seed({ proposals: 0 });
    jobs.set('job-old', abandoned('job-old'));

    const out = await relay('job-old');

    expect(out?.autoResume).toEqual({ started: false, reason: 'no_proposal' });
    const s = await sessionRow(sessionId);
    expect(s.failedJobId).toBe('job-old');
    expect(s.failureReason).toBe(reasonFor(abandoned('job-old').error!));
    expect(s.failureReason).toBe('model_unavailable');
    expect(s.autoResumeCount).toBe(0);
    await expectWaits(sessionId, planId);
  });

  it(
    '5 · past the bound: two automatic resumes, the third waits, a manual Resume continues it',
    T,
    async () => {
      expect(AUTO_RESUMES_PER_SESSION).toBe(2);
      const { sessionId, planId } = await seed();
      jobs.set('job-old', abandoned('job-old'));

      expect((await relay('job-old'))?.autoResume).toEqual({
        started: true,
        jobId: 'job-new-1',
        count: 1,
      });
      expect((await planRow(planId)).sourceJobId).toBe('job-new-1');

      await plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Second', kind: 'subtask' } }],
        fx.ctx,
      );
      jobs.set('job-new-1', abandoned('job-new-1'));
      expect((await relay('job-new-1'))?.autoResume).toEqual({
        started: true,
        jobId: 'job-new-2',
        count: 2,
      });
      expect((await planRow(planId)).sourceJobId).toBe('job-new-2');

      await plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Third', kind: 'subtask' } }],
        fx.ctx,
      );
      jobs.set('job-new-2', abandoned('job-new-2'));
      expect((await relay('job-new-2'))?.autoResume).toEqual({
        started: false,
        reason: 'bound_spent',
      });

      expect(submitJobMock).toHaveBeenCalledTimes(2);
      const waiting = await sessionRow(sessionId);
      expect(waiting.failedJobId).toBe('job-new-2');
      expect(waiting.autoResumeCount).toBe(2);
      expect(await toResumeIds()).toContain(sessionId);
      expect(await planningIds()).not.toContain(planId);

      // The owner's manual Resume continues it, and spends nothing of the automatic bound.
      submitJobMock.mockClear();
      const resumed = await planSessionResumeService.resume(me(), sessionId);
      expect(resumed.planId).toBe(planId);
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      expect(submitJobMock.mock.calls[0]![4]).toEqual({
        resume: { planId, fromJobId: 'job-new-2' },
      });
      const after = await sessionRow(sessionId);
      expect(after.failedAt).toBeNull();
      expect(after.autoResumeCount).toBe(2);
      expect((await planRow(planId)).sourceJobId).toBe(resumed.jobId);
    },
  );

  it('6 · a judged failure waits, through the relay and through the sweep', T, async () => {
    const viaRelay = await seed({ jobId: 'job-judged-r' });
    jobs.set('job-judged-r', judgedFailure('job-judged-r'));
    const out = await relay('job-judged-r');
    expect(out).toMatchObject({ settled: 'recorded', lostMachine: false, autoResume: null });
    const r = await sessionRow(viaRelay.sessionId);
    expect(r.failedJobId).toBe('job-judged-r');
    expect(r.failureReason).toBe(reasonFor(judgedFailure('job-judged-r').error!));

    const viaSweep = await seed({ jobId: 'job-judged-s' });
    jobs.set('job-judged-s', judgedFailure('job-judged-s'));
    const swept = await sweep();
    expect(swept.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planId: viaSweep.planId,
          outcome: 'awaiting_resume',
          lostMachine: false,
          autoResume: null,
        }),
      ]),
    );
    const s = await sessionRow(viaSweep.sessionId);
    expect(s.failedJobId).toBe('job-judged-s');
    expect(s.failureReason).toBe(reasonFor(judgedFailure('job-judged-s').error!));

    await expectWaits(viaRelay.sessionId, viaRelay.planId);
    await expectWaits(viaSweep.sessionId, viaSweep.planId);
  });

  it('7 · a cancel ends the attempt and starts nothing', T, async () => {
    const { sessionId, planId } = await seed();
    jobs.set('job-old', { status: 'canceled' });

    const out = await relay('job-old', 'canceled');

    expect(out).toMatchObject({ settled: 'ended', autoResume: null });
    expect(submitJobMock).not.toHaveBeenCalled();
    const s = await sessionRow(sessionId);
    expect(s.endedAt).not.toBeNull();
    expect(s.autoResumeCount).toBe(0);
    expect(await planningIds()).not.toContain(planId);
  });

  it('8 · a person’s stop: the session stays ended, nothing is resumed', T, async () => {
    const { sessionId, planId } = await seed();
    await plansService.declinePlan(planId, fx.ctx);
    const ended = await sessionRow(sessionId);
    expect(ended.endedAt).not.toBeNull();
    jobs.set('job-old', abandoned('job-old'));

    expect(await relay('job-old')).toBeNull();

    expect(submitJobMock).not.toHaveBeenCalled();
    const s = await sessionRow(sessionId);
    expect(s.endedAt).toEqual(ended.endedAt);
    expect(s.endReason).toBe(ended.endReason);
    expect(s.autoResumeCount).toBe(0);
    expect(await toResumeIds()).not.toContain(sessionId);
    expect(await planningIds()).not.toContain(planId);
  });

  it('9 · silence alone is recorded and waits', T, async () => {
    const { sessionId, planId } = await seed({ silentMs: PLAN_STALLED_AFTER_MS + MIN });
    jobs.set('job-old', { status: 'running' });

    const out = await sweep();

    expect(out.outcomes).toEqual([
      {
        planId,
        projectId: fx.projectId,
        outcome: 'awaiting_resume',
        reason: 'silent',
        lostMachine: false,
        autoResume: null,
        jobCancel: { cancelled: true },
      },
    ]);
    expect((await sessionRow(sessionId)).failedJobId).toBe('job-old');
    // Core gave up on the job, so it is cancelled in motir-ai (MOTIR-9065).
    expect(jobs.get('job-old')).toEqual({ status: 'canceled' });
    await expectWaits(sessionId, planId);
  });

  it('10 · a revision’s lost machine settles through the revision arm', T, async () => {
    const { sessionId, planId } = await seed();
    await adminDb.plan.update({
      where: { id: planId },
      data: { status: 'planned', sourceJobId: 'job-rev' },
    });
    jobs.set('job-rev', abandoned('job-rev'));

    const out = await relay('job-rev');

    expect(out).toMatchObject({ arm: 'revision', lostMachine: true, autoResume: null });
    expect((await sessionRow(sessionId)).autoResumeCount).toBe(0);
    await expectWaits(sessionId, planId);
  });
});

// ── C. a resuming plan reads resuming and is not swept ───────────────────────────────────────

/** Case 1's end state: resumed by the relay, `job-new-1` queued, the dead job's step left behind
 *  3 minutes before the resume, and the plan's pre-resume activity 20 minutes old. */
async function resumedPlan() {
  const ids = await seed({ deadStep: true, silentMs: 20 * MIN });
  jobs.set('job-old', abandoned('job-old'));
  expect((await relay('job-old'))?.autoResume).toMatchObject({ started: true, count: 1 });
  const resumedAt = (await sessionRow(ids.sessionId)).lastAutoResumedAt!;
  await adminDb.planStep.updateMany({
    where: { planId: ids.planId, sessionKey: 'dead' },
    data: { startedAt: new Date(resumedAt.getTime() - 3 * MIN) },
  });
  return { ...ids, resumedAt };
}

describe('C · a resuming plan reads resuming and is not swept', () => {
  it(
    '11–12 · resuming through both doors, in Planning, and not swept at resume + 14 min',
    T,
    async () => {
      const { sessionId, planId, resumedAt } = await resumedPlan();

      for (const { snapshot, reading } of await progress(planId)) {
        expect(snapshot.autoResume).toEqual({ at: resumedAt.toISOString(), count: 1 });
        expect(snapshot.steps).toEqual([]);
        expect(reading.state).toBe('resuming');
        expect(reading.liveSteps).toEqual([]);
      }
      expect(await planningIds()).toContain(planId);
      expect(await toResumeIds()).not.toContain(sessionId);

      const out = await sweep(new Date(resumedAt.getTime() + 14 * MIN));

      expect(out.outcomes).toEqual([expect.objectContaining({ planId, outcome: 'left_as_is' })]);
      expect((await planRow(planId)).status).toBe('generating');
      const s = await sessionRow(sessionId);
      expect(s.failedAt).toBeNull();
      expect(s.autoResumeCount).toBe(1);
      expect(submitJobMock).toHaveBeenCalledTimes(1);
    },
  );

  it('13 · the new job’s first step turns both reads to working', T, async () => {
    const { planId } = await resumedPlan();

    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'new', kind: 'settle', targetRef: null },
      fx.ctx,
    );

    for (const { reading } of await progress(planId)) {
      expect(reading.state).toBe('working');
      expect(reading.liveSteps.map((step) => step.sessionKey)).toEqual(['new']);
    }
  });

  it(
    '14 · a resumed job still QUEUED is not recorded by silence, and not resumed again',
    T,
    async () => {
      // MOTIR-9065: a queued job has not started, so the plan's silence says nothing about
      // it. A job that never leaves the queue is motir-ai's to fail (MOTIR-9064); the fast
      // path records it then.
      const { sessionId, planId, resumedAt } = await resumedPlan();

      const out = await sweep(new Date(resumedAt.getTime() + PLAN_STALLED_AFTER_MS + MIN));

      expect(out.outcomes).toEqual([
        { planId, projectId: fx.projectId, outcome: 'left_as_is', reason: 'job_queued' },
      ]);
      const s = await sessionRow(sessionId);
      expect(s.failedAt).toBeNull();
      expect(s.autoResumeCount).toBe(1);
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      expect(await toResumeIds()).not.toContain(sessionId);
      expect(jobs.get('job-new-1')).toBeUndefined();
    },
  );
});

// ── D. the guards the chain passes through ───────────────────────────────────────────────────
// Not cases of the story's behaviour: the branches the story ADDED that the fourteen cases above
// do not happen to take, driven here so the story's coverage lane executes every one of them.

describe('D · the guards the chain passes through', () => {
  const auto = (sessionId: string) =>
    planSessionResumeService.resumeAutomatically({
      sessionId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

  it('the automatic precheck refuses what is not a failed, resumable conversation', T, async () => {
    const open = await seed();
    expect(await auto(open.sessionId)).toEqual({ started: false, reason: 'not_failed' });

    const ended = await seed({ jobId: 'job-ended' });
    await adminDb.planChangeSession.update({
      where: { id: ended.sessionId },
      data: { endedAt: new Date(), endReason: 'failed' },
    });
    expect(await auto(ended.sessionId)).toEqual({ started: false, reason: 'not_resumable' });

    const decided = await seed({ jobId: 'job-decided' });
    await adminDb.planChangeSession.update({
      where: { id: decided.sessionId },
      data: {
        failedAt: new Date(),
        failedJobId: 'job-decided',
        failureReason: 'model_unavailable',
      },
    });
    await adminDb.plan.update({ where: { id: decided.planId }, data: { status: 'planned' } });
    expect(await auto(decided.sessionId)).toEqual({ started: false, reason: 'not_resumable' });

    const orphaned = await seed({ jobId: 'job-orphaned' });
    await adminDb.planChangeSession.update({
      where: { id: orphaned.sessionId },
      data: {
        failedAt: new Date(),
        failedJobId: 'job-orphaned',
        failureReason: 'model_unavailable',
        createdById: null,
      },
    });
    expect(await auto(orphaned.sessionId)).toEqual({
      started: false,
      reason: 'starter_cannot_plan',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('a submit refused with no code is still a submit_refused skip', T, async () => {
    const { sessionId } = await seed();
    jobs.set('job-old', abandoned('job-old'));
    submitJobMock.mockRejectedValueOnce(new Error('socket hang up'));
    vi.spyOn(console, 'info').mockImplementation(() => {});

    expect((await relay('job-old'))?.autoResume).toEqual({
      started: false,
      reason: 'submit_refused',
    });
    expect((await sessionRow(sessionId)).failedJobId).toBe('job-old');
  });

  it('a revision with no session gives its lease back and records nothing', T, async () => {
    const { planId } = await seed();
    await adminDb.plan.update({
      where: { id: planId },
      data: { status: 'planned', sourceJobId: 'job-rev', sessionId: null },
    });
    jobs.set('job-rev', abandoned('job-rev'));

    expect(await relay('job-rev')).toMatchObject({
      settled: 'released',
      sessionId: null,
      arm: 'revision',
      autoResume: null,
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it(
    'a sweep whose second read of the job fails records it as not lost, resumed once as an unavailable provider',
    T,
    async () => {
      const { sessionId, planId } = await seed();
      jobs.set('job-old', abandoned('job-old'));
      let reads = 0;
      fetchMock.mockImplementation(async () => {
        reads += 1;
        return reads === 1
          ? Response.json({
              jobId: 'job-old',
              status: 'failed',
              result: null,
              error: abandoned('job-old').error,
            })
          : new Response('upstream down', { status: 502 });
      });

      const out = await sweep();

      // Unknown is not lost — but the reap's outage problem records `model_unavailable`, which is
      // resumed ONCE by itself since MOTIR-10968, so the same plan is resumed on that cause.
      expect(out.outcomes).toEqual([
        expect.objectContaining({
          planId,
          outcome: 'awaiting_resume',
          lostMachine: false,
          autoResume: { started: true, jobId: 'job-new-1', count: 1 },
        }),
      ]);
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      const s = await sessionRow(sessionId);
      expect(s.failedJobId).toBeNull();
      expect(s.providerResumedAt).toEqual(s.lastAutoResumedAt);
      expect((await planRow(planId)).sourceJobId).toBe('job-new-1');
    },
  );

  it('both progress doors read no resume for a plan with no session', T, async () => {
    const plan = await plansService.createPlan(fx.projectId, { title: 'No session' }, fx.ctx);
    for (const authorSource of ['mcp', null] as const) {
      await adminDb.plan.update({
        where: { id: plan.id },
        data: { authorSource, sessionId: null },
      });
      for (const { snapshot, reading } of await progress(plan.id)) {
        expect(snapshot.autoResume).toBeNull();
        expect(reading.state).not.toBe('resuming');
      }
    }
  });
});
