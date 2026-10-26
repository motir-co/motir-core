import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { POST as stepPOST } from '@/app/api/internal/ai/plan-step/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Story MOTIR-7820 · Subtask MOTIR-7824) — the hosted planner's
// door, `POST /api/internal/ai/plan-step`, end-to-end through the REAL route
// against a real Postgres.
//
// The step store's own rules are proven in `tests/integration/plans/planSteps.test.ts`.
// What is asserted here is the TRANSPORT: the §4a-bearer + §4b-job-token auth,
// the job-resolved plan and its `planId` cross-check, the body-shape 400s, and
// the status each typed refusal maps to — so motir-ai's walk can match a code and
// carry on, and never meets a 500 for an advisory signal.

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function tokenFor(fx: { ctx: { userId: string; workspaceId: string } }, projectId: string): string {
  return mintJobToken({ userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId });
}

function req(opts: { bearer?: string; token?: string; body?: unknown; raw?: string }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/plan-step', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
}

/** A `generating` plan bound to `jobId`, carrying one `add` — what a walk reports on. */
async function generatingPlan(fx: Fx, jobId: string): Promise<{ planId: string; addId: string }> {
  const plan = await plansService.createPlan(fx.projectId, { sourceJobId: jobId }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The surface', kind: 'story' } }],
    fx.ctx,
  );
  return { planId: plan.id, addId: appended.appendedItemIds[0]! };
}

/** The happy-path call: the fixture's own token, the fixture's own job. */
function report(fx: Fx, jobId: string, body: Record<string, unknown>) {
  return stepPOST(
    req({ bearer: SERVICE_SECRET, token: tokenFor(fx, fx.projectId), body: { jobId, ...body } }),
  );
}

const steps = (planId: string, fx: Fx) =>
  planReviewService.getPlanReview(planId, fx.ctx).then((r) => r.inFlightSteps ?? []);

describe('POST /api/internal/ai/plan-step — what it records', () => {
  it('records each of the four steps on the job’s generating plan', async () => {
    const fx = await makeFixture();
    const jobId = 'job_step_happy';
    const { planId, addId } = await generatingPlan(fx, jobId);

    const settle = await report(fx, jobId, { sessionKey: 'settle', step: 'settle' });
    expect(settle.status).toBe(200);
    const settleBody = (await settle.json()) as {
      planId: string;
      step: string;
      inFlight: { sessionKey: string; kind: string; targetRef: string | null; startedAt: string };
    };
    expect(settleBody).toMatchObject({ planId, step: 'settle', inFlight: { kind: 'settle' } });

    const lay = await report(fx, jobId, {
      sessionKey: 'lay-1',
      step: 'lay',
      target: `planItem:${addId}`,
    });
    expect(lay.status).toBe(200);

    const author = await report(fx, jobId, {
      planId,
      sessionKey: 'author-1',
      step: 'author',
      target: `planItem:${addId}`,
    });
    expect(author.status).toBe(200);

    const live = await steps(planId, fx);
    expect(live.map((s) => [s.sessionKey, s.kind, s.targetRef])).toEqual(
      expect.arrayContaining([
        ['settle', 'settle', null],
        ['lay-1', 'lay', `planItem:${addId}`],
        ['author-1', 'author', `planItem:${addId}`],
      ]),
    );
    // The stored time is the one the route hands back.
    expect(live.find((s) => s.sessionKey === 'settle')!.startedAt).toBe(
      settleBody.inFlight.startedAt,
    );

    const end = await report(fx, jobId, { sessionKey: 'author-1', step: 'end' });
    expect(end.status).toBe(200);
    expect(await end.json()).toEqual({ planId, step: 'end', inFlight: null });
    expect((await steps(planId, fx)).map((s) => s.sessionKey).sort()).toEqual(['lay-1', 'settle']);

    // A repeated `end` is still a success.
    const again = await report(fx, jobId, { sessionKey: 'author-1', step: 'end' });
    expect(again.status).toBe(200);
  });

  it.each(['lay', 'author'] as const)(
    'accepts an untargeted `%s`, stored as `targetRef: null`',
    async (step) => {
      const fx = await makeFixture();
      const jobId = `job_step_untargeted_${step}`;
      const { planId } = await generatingPlan(fx, jobId);

      const res = await report(fx, jobId, { sessionKey: `u-${step}`, step });
      expect(res.status).toBe(200);
      expect(await steps(planId, fx)).toEqual([
        expect.objectContaining({ sessionKey: `u-${step}`, kind: step, targetRef: null }),
      ]);
    },
  );
});

describe('auth and the no-leak posture', () => {
  it('401 without the service bearer, with a wrong one, and without the job token', async () => {
    const fx = await makeFixture();
    const jobId = 'job_step_auth';
    const { planId } = await generatingPlan(fx, jobId);
    const body = { jobId, sessionKey: 's', step: 'settle' };

    expect((await stepPOST(req({ token: tokenFor(fx, fx.projectId), body }))).status).toBe(401);
    expect(
      (await stepPOST(req({ bearer: 'not-the-secret', token: tokenFor(fx, fx.projectId), body })))
        .status,
    ).toBe(401);
    expect((await stepPOST(req({ bearer: SERVICE_SECRET, body }))).status).toBe(401);
    expect(
      (await stepPOST(req({ bearer: SERVICE_SECRET, token: 'not.a.token', body }))).status,
    ).toBe(401);
    expect(await steps(planId, fx)).toHaveLength(0);
  });

  it('a token from ANOTHER workspace → 404, and writes nothing', async () => {
    const fx = await makeFixture();
    const other = await makeFixture({ name: 'Other', identifier: 'OTHR' });
    const jobId = 'job_step_cross_tenant';
    const { planId } = await generatingPlan(fx, jobId);

    const res = await stepPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(other, other.projectId),
        body: { jobId, sessionKey: 's', step: 'settle' },
      }),
    );
    expect(res.status).toBe(404);
    expect(await steps(planId, fx)).toHaveLength(0);
  });

  it('a `planId` that is not the job’s plan is answered like a foreign job → 404', async () => {
    const fx = await makeFixture();
    const mine = await generatingPlan(fx, 'job_step_mine');
    const theirs = await generatingPlan(fx, 'job_step_theirs');

    const res = await report(fx, 'job_step_mine', {
      planId: theirs.planId,
      sessionKey: 's',
      step: 'settle',
    });
    expect(res.status).toBe(404);
    expect(await steps(mine.planId, fx)).toHaveLength(0);
    expect(await steps(theirs.planId, fx)).toHaveLength(0);
  });

  it('a job with no plan → 404', async () => {
    const fx = await makeFixture();
    const res = await report(fx, 'job_that_opened_no_plan', { sessionKey: 's', step: 'settle' });
    expect(res.status).toBe(404);
  });
});

describe('the refusals, and the codes motir-ai branches on', () => {
  it('400 PLAN_STEP_INVALID on a malformed body', async () => {
    const fx = await makeFixture();
    const jobId = 'job_step_400';
    await generatingPlan(fx, jobId);
    const token = tokenFor(fx, fx.projectId);

    const badJson = await stepPOST(req({ bearer: SERVICE_SECRET, token, raw: '{not json' }));
    expect(badJson.status).toBe(400);

    const noJob = await stepPOST(
      req({ bearer: SERVICE_SECRET, token, body: { sessionKey: 's', step: 'settle' } }),
    );
    expect(noJob.status).toBe(400);

    for (const body of [
      { sessionKey: 7, step: 'settle' },
      { step: 'settle' },
      { sessionKey: 's', step: 'daydream' },
      { sessionKey: 's', step: 'lay', target: 12 },
      { sessionKey: 's', step: 'lay', planId: 12 },
    ]) {
      const res = await report(fx, jobId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
    }
  });

  it.each(['planned', 'approved', 'declined'] as const)(
    '409 PLAN_NOT_GENERATING on a `%s` plan, and nothing moves',
    async (status) => {
      const fx = await makeFixture();
      const jobId = `job_step_409_${status}`;
      const { planId } = await generatingPlan(fx, jobId);
      await adminDb.plan.update({ where: { id: planId }, data: { status } });
      const before = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });

      const res = await report(fx, jobId, { sessionKey: 's', step: 'lay' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_NOT_GENERATING');

      expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
      const after = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      expect(after.lastActivityAt.toISOString()).toBe(before.lastActivityAt.toISOString());
    },
  );

  it('422 PLAN_STEP_INVALID on a step the store refuses', async () => {
    const fx = await makeFixture();
    const jobId = 'job_step_422';
    const { planId, addId } = await generatingPlan(fx, jobId);

    for (const body of [
      { sessionKey: 's', step: 'settle', target: `planItem:${addId}` },
      { sessionKey: 's', step: 'end', target: `planItem:${addId}` },
      { sessionKey: 's', step: 'author', target: 'planItem:nothing-here' },
      { sessionKey: 's', step: 'lay', target: 'folder:anything' },
      { sessionKey: '', step: 'settle' },
    ]) {
      const res = await report(fx, jobId, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
    }
    expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
  });
});

describe('the narration arm (Story MOTIR-8060 · MOTIR-8062)', () => {
  it('appends a session’s sentences and returns the stored rows', async () => {
    const fx = await makeFixture();
    const jobId = 'job_narration_happy';
    const { planId } = await generatingPlan(fx, jobId);
    expect((await report(fx, jobId, { sessionKey: 's', step: 'settle' })).status).toBe(200);

    const res = await report(fx, jobId, {
      sessionKey: 's',
      narration: ['Reading the brief.', 'Two epics, likely.'],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planId: string;
      narration: { sessionKey: string; seq: number; body: string }[];
    };
    expect(body.planId).toBe(planId);
    expect(body.narration.map((n) => [n.sessionKey, n.seq, n.body])).toEqual([
      ['s', 1, 'Reading the brief.'],
      ['s', 2, 'Two epics, likely.'],
    ]);
    expect(await adminDb.planNarration.count({ where: { planId } })).toBe(2);
  });

  it('400 on a malformed narration body, writing nothing', async () => {
    const fx = await makeFixture();
    const jobId = 'job_narration_400';
    const { planId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });

    for (const extra of [
      { step: 'settle', narration: ['Both.'] },
      {},
      { narration: 'not an array' },
      { narration: ['ok', 7] },
      { narration: ['Aimed.'], target: 'planItem:x' },
    ]) {
      const res = await report(fx, jobId, { sessionKey: 's', ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
    }
    expect(await adminDb.planNarration.count({ where: { planId } })).toBe(0);
  });

  it('422 when the store refuses — a blank sentence, a session with no step', async () => {
    const fx = await makeFixture();
    const jobId = 'job_narration_422';
    const { planId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });

    for (const body of [
      { sessionKey: 's', narration: ['   '] },
      { sessionKey: 'ghost', narration: ['Hi.'] },
    ]) {
      const res = await report(fx, jobId, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
    }
    expect(await adminDb.planNarration.count({ where: { planId } })).toBe(0);
  });

  it('409 once the plan is not generating', async () => {
    const fx = await makeFixture();
    const jobId = 'job_narration_409';
    const { planId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });
    await plansService.markPlanned(planId, fx.ctx);

    const res = await report(fx, jobId, { sessionKey: 's', narration: ['Late.'] });
    expect(res.status).toBe(409);
  });
});

describe('the provider-retry arm (Story MOTIR-9540 · MOTIR-9619)', () => {
  type WaitBody = {
    planId: string;
    providerWait: { attempt: number; maxAttempts: number; since: string; retryAt: string } | null;
  };
  const waiting = (retryAt: string, attempt = 1, maxAttempts = 3) => ({
    state: 'waiting',
    attempt,
    maxAttempts,
    retryAt,
  });
  const row = (planId: string, sessionKey: string) =>
    adminDb.planStep.findUniqueOrThrow({ where: { planId_sessionKey: { planId, sessionKey } } });
  const lastActivity = async (planId: string) =>
    (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).lastActivityAt.getTime();

  it('stores a waiting report on the session’s step without touching the step, and stamps activity', async () => {
    const fx = await makeFixture();
    const jobId = 'job_retry_happy';
    const { planId, addId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'author', target: `planItem:${addId}` });
    const before = await row(planId, 's');
    const activityBefore = await lastActivity(planId);
    await new Promise((r) => setTimeout(r, 5));

    const retryAt = new Date(Date.now() + 4_000).toISOString();
    const res = await report(fx, jobId, { sessionKey: 's', providerRetry: waiting(retryAt) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WaitBody;
    expect(body.planId).toBe(planId);
    expect(body.providerWait).toMatchObject({ attempt: 1, maxAttempts: 3, retryAt });
    expect(Date.parse(body.providerWait!.since)).toBeGreaterThan(before.startedAt.getTime());

    const after = await row(planId, 's');
    expect([after.kind, after.targetRef, after.startedAt.toISOString()]).toEqual([
      before.kind,
      before.targetRef,
      before.startedAt.toISOString(),
    ]);
    expect(after.providerWaitUntil!.toISOString()).toBe(retryAt);
    expect(await lastActivity(planId)).toBeGreaterThan(activityBefore);

    // Every overlay read carries it, with no extra call.
    const [step] = await steps(planId, fx);
    expect(step!.providerWait).toEqual(body.providerWait);
  });

  it('`cleared` nulls all four wait columns and answers `providerWait: null`', async () => {
    const fx = await makeFixture();
    const jobId = 'job_retry_cleared';
    const { planId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });
    await report(fx, jobId, {
      sessionKey: 's',
      providerRetry: waiting(new Date(Date.now() + 2_000).toISOString()),
    });

    const res = await report(fx, jobId, { sessionKey: 's', providerRetry: { state: 'cleared' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ planId, providerWait: null });
    const after = await row(planId, 's');
    expect([
      after.providerWaitSince,
      after.providerWaitUntil,
      after.providerWaitAttempt,
      after.providerWaitMaxAttempts,
    ]).toEqual([null, null, null, null]);
  });

  it('a new step clears the wait, narration leaves it, and `end` takes it with the row', async () => {
    const fx = await makeFixture();
    const jobId = 'job_retry_precedence';
    const { planId, addId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });
    const retryAt = new Date(Date.now() + 3_000).toISOString();
    await report(fx, jobId, { sessionKey: 's', providerRetry: waiting(retryAt, 2, 3) });

    expect((await report(fx, jobId, { sessionKey: 's', narration: ['Waiting.'] })).status).toBe(
      200,
    );
    expect((await row(planId, 's')).providerWaitAttempt).toBe(2);

    for (const step of [
      { step: 'lay', target: `planItem:${addId}` },
      { step: 'author', target: `planItem:${addId}` },
      { step: 'settle' },
    ]) {
      await report(fx, jobId, { sessionKey: 's', providerRetry: waiting(retryAt) });
      expect((await report(fx, jobId, { sessionKey: 's', ...step })).status).toBe(200);
      expect((await row(planId, 's')).providerWaitSince, JSON.stringify(step)).toBeNull();
    }

    await report(fx, jobId, { sessionKey: 's', providerRetry: waiting(retryAt) });
    expect((await report(fx, jobId, { sessionKey: 's', step: 'end' })).status).toBe(200);
    expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
  });

  it('clamps `retryAt` to [now, now + 15 min]', async () => {
    const fx = await makeFixture();
    const jobId = 'job_retry_clamp';
    const { planId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });

    const past = await report(fx, jobId, {
      sessionKey: 's',
      providerRetry: waiting(new Date(Date.now() - 60_000).toISOString()),
    });
    const pastWait = ((await past.json()) as WaitBody).providerWait!;
    expect(pastWait.retryAt).toBe(pastWait.since);

    const far = await report(fx, jobId, {
      sessionKey: 's',
      providerRetry: waiting(new Date(Date.now() + 3_600_000).toISOString()),
    });
    const farWait = ((await far.json()) as WaitBody).providerWait!;
    expect(Date.parse(farWait.retryAt) - Date.parse(farWait.since)).toBe(900_000);
    expect((await row(planId, 's')).providerWaitUntil!.toISOString()).toBe(farWait.retryAt);
  });

  it('400 on a malformed providerRetry body, writing nothing', async () => {
    const fx = await makeFixture();
    const jobId = 'job_retry_400';
    const { planId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });
    const at = new Date(Date.now() + 1_000).toISOString();

    for (const extra of [
      { step: 'settle', providerRetry: { state: 'cleared' } },
      { narration: ['Both.'], providerRetry: { state: 'cleared' } },
      { providerRetry: { state: 'cleared' }, target: 'planItem:x' },
      { providerRetry: 'waiting' },
      { providerRetry: [] },
      { providerRetry: null },
      { providerRetry: { state: 'sleeping' } },
      { providerRetry: waiting(at, 1.5, 3) },
      { providerRetry: waiting(at, 0, 3) },
      { providerRetry: waiting(at, 1, 21) },
      { providerRetry: waiting(at, 4, 3) },
      { providerRetry: { state: 'waiting', attempt: '1', maxAttempts: 3, retryAt: at } },
      { providerRetry: waiting('soon') },
      { providerRetry: { state: 'waiting', attempt: 1, maxAttempts: 3 } },
    ]) {
      const res = await report(fx, jobId, { sessionKey: 's', ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
    }
    expect((await row(planId, 's')).providerWaitSince).toBeNull();
  });

  it('422 for a session with no step, 409 once the plan is not generating', async () => {
    const fx = await makeFixture();
    const jobId = 'job_retry_refusals';
    const { planId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });
    const providerRetry = waiting(new Date(Date.now() + 1_000).toISOString());

    const ghost = await report(fx, jobId, { sessionKey: 'ghost', providerRetry });
    expect(ghost.status).toBe(422);
    expect(((await ghost.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
    expect(await adminDb.planStep.count({ where: { planId } })).toBe(1);

    await plansService.markPlanned(planId, fx.ctx);
    const late = await report(fx, jobId, { sessionKey: 's', providerRetry });
    expect(late.status).toBe(409);
    expect((await row(planId, 's')).providerWaitSince).toBeNull();
  });

  it('the database refuses a half-written wait', async () => {
    const fx = await makeFixture();
    const jobId = 'job_retry_check';
    const { planId } = await generatingPlan(fx, jobId);
    await report(fx, jobId, { sessionKey: 's', step: 'settle' });

    await expect(
      adminDb.planStep.update({
        where: { planId_sessionKey: { planId, sessionKey: 's' } },
        data: { providerWaitAttempt: 1 },
      }),
    ).rejects.toThrow(/plan_step_provider_wait_complete/);
  });
});
