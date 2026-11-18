import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';

// Route-level TRANSPORT tests for the planner's mid-run PAUSE (Story MOTIR-7990 ·
// MOTIR-8007). The behaviour behind them is `tests/integration/planning/runPause.test.ts`;
// proven HERE is the seam only a route carries: the session door's parsing and error
// mapping, and the internal door's job-token gate.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const recordPause = vi.fn();
const answer = vi.fn();
const latestForSession = vi.fn();
vi.mock('@/lib/services/planChangeRunPauseService', () => ({
  planChangeRunPauseService: {
    recordPause: (...a: unknown[]) => recordPause(...a),
    answer: (...a: unknown[]) => answer(...a),
    latestForSession: (...a: unknown[]) => latestForSession(...a),
  },
}));

const { GET: readPause, POST: answerPause } =
  await import('@/app/api/ai/plan-change/session/run-pause/route');
const { POST: recordDoor } = await import('@/app/api/internal/ai/plan-change-run-pause/route');
const { mintJobToken } = await import('@/lib/ai/jobToken');
const {
  PlanChangeRunPauseAnsweredError,
  PlanChangeRunPauseNotFoundError,
  PlanChangeRunPauseShapeError,
  PlanChangeRunPausePlanDecidedError,
  PlanChangeRunPauseTurnMismatchError,
  PlanChangeJobNotRunningError,
} = await import('@/lib/planChange/errors');

const SERVICE_SECRET = 'core-callback-secret-test';
const PAUSE = { id: 'p1', jobId: 'job-1', kind: 'replan', answer: null, delivery: 'pending' };

const sessionReq = (method: string, body?: unknown, qs = '') =>
  new Request(`http://localhost:3000/api/ai/plan-change/session/run-pause${qs}`, {
    method,
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

const internalReq = (body: unknown, headers: Record<string, string>) =>
  new Request('http://internal/api/internal/ai/plan-change-run-pause', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  session.current = { user: { id: 'u1', email: 'yue@example.com', name: 'Yue' } };
  activeCtx.current = {
    userId: 'u1',
    workspaceId: 'ws1',
    projectId: 'pj1',
    project: { id: 'pj1' } as unknown as ProjectContext['project'],
  };
  recordPause.mockResolvedValue({ outcome: 'recorded', pause: PAUSE });
  answer.mockResolvedValue({
    outcome: 'answered',
    pause: PAUSE,
    delivery: { turns: [], stopped: false },
  });
  latestForSession.mockResolvedValue(PAUSE);
});

describe('GET /api/ai/plan-change/session/run-pause', () => {
  it('answers the latest pause of that run, no-store', async () => {
    const res = await readPause(sessionReq('GET', undefined, '?sessionId=s1&jobId=job-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual(PAUSE);
    expect(latestForSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ projectId: 'pj1' }),
    );
  });

  it('answers null for another run’s pause or none, and 400s a missing session or job', async () => {
    expect(
      await (await readPause(sessionReq('GET', undefined, '?sessionId=s1&jobId=job-2'))).json(),
    ).toBeNull();
    latestForSession.mockResolvedValue(null);
    expect(
      await (await readPause(sessionReq('GET', undefined, '?sessionId=s1&jobId=job-1'))).json(),
    ).toBeNull();
    expect((await readPause(sessionReq('GET', undefined, '?jobId=job-1'))).status).toBe(400);
    expect((await readPause(sessionReq('GET', undefined, '?sessionId=s1'))).status).toBe(400);
  });

  it('401s no session', async () => {
    session.current = null;
    expect(
      (await readPause(sessionReq('GET', undefined, '?sessionId=s1&jobId=job-1'))).status,
    ).toBeGreaterThanOrEqual(401);
    expect(latestForSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/plan-change/session/run-pause', () => {
  const body = { sessionId: 's1', jobId: 'job-1', pauseId: 'p1', choice: 'apply' };

  it('passes the parsed answer to the service', async () => {
    const res = await answerPause(sessionReq('POST', { ...body, choice: 'reply', text: 'hi' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(answer).toHaveBeenCalledWith(
      { sessionId: 's1', jobId: 'job-1', pauseId: 'p1', choice: 'reply', text: 'hi' },
      expect.objectContaining({ projectId: 'pj1' }),
    );
  });

  it('passes a picked option’s id through (MOTIR-11700)', async () => {
    const res = await answerPause(
      sessionReq('POST', { ...body, choice: 'reply', text: 'Billing', optionId: 'o2' }),
    );
    expect(res.status).toBe(200);
    expect(answer).toHaveBeenCalledWith(
      {
        sessionId: 's1',
        jobId: 'job-1',
        pauseId: 'p1',
        choice: 'reply',
        text: 'Billing',
        optionId: 'o2',
      },
      expect.objectContaining({ projectId: 'pj1' }),
    );
  });

  it('passes a resume (a code_unsearchable pause’s answer) to the service', async () => {
    const res = await answerPause(sessionReq('POST', { ...body, choice: 'resume' }));
    expect(res.status).toBe(200);
    expect(answer).toHaveBeenCalledWith(
      { sessionId: 's1', jobId: 'job-1', pauseId: 'p1', choice: 'resume', text: null },
      expect.objectContaining({ projectId: 'pj1' }),
    );
  });

  it('400s a choice outside the four', async () => {
    const res = await answerPause(sessionReq('POST', { ...body, choice: 'retry' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE' });
    expect(answer).not.toHaveBeenCalled();
  });

  it('passes a typed refusal through as a 200 body', async () => {
    const refused = {
      outcome: 'refused',
      code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
      jobStatus: 'succeeded',
      choice: 'apply',
      pause: PAUSE,
    };
    answer.mockResolvedValue(refused);
    const res = await answerPause(sessionReq('POST', body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(refused);
  });

  it.each([
    ['not JSON', 'not json', 400],
    ['no session', { ...body, sessionId: undefined }, 400],
    ['no job', { ...body, jobId: '' }, 400],
    ['no pause', { ...body, pauseId: undefined }, 400],
    ['a bad choice', { ...body, choice: 'maybe' }, 400],
  ])('400s %s before calling the service', async (_n, sent, status) => {
    const res = await answerPause(sessionReq('POST', sent));
    expect(res.status).toBe(status);
    expect(answer).not.toHaveBeenCalled();
  });

  it('maps the typed errors to their statuses', async () => {
    const cases: Array<[Error, number]> = [
      [new PlanChangeRunPauseNotFoundError('p1'), 404],
      [new PlanChangeRunPauseShapeError('nope'), 400],
      [new PlanChangeRunPauseAnsweredError('p1', 'apply'), 409],
    ];
    for (const [err, status] of cases) {
      answer.mockRejectedValueOnce(err);
      const res = await answerPause(sessionReq('POST', body));
      expect(res.status).toBe(status);
    }
    answer.mockRejectedValueOnce(new PlanChangeRunPauseAnsweredError('p1', 'apply'));
    expect(await (await answerPause(sessionReq('POST', body))).json()).toMatchObject({
      code: 'PLAN_CHANGE_RUN_PAUSE_ANSWERED',
      answer: 'apply',
    });
  });
});

describe('POST /api/internal/ai/plan-change-run-pause', () => {
  const token = () => mintJobToken({ userId: 'u1', workspaceId: 'ws1', projectId: 'pj1' });
  const authed = () => ({
    authorization: `Bearer ${SERVICE_SECRET}`,
    'x-motir-job-token': token(),
  });
  const sent = {
    jobId: 'job-1',
    kind: 'replan',
    changeTurnIds: ['e1'],
    reason: 'because',
    idempotencyKey: 'k1',
  };

  it('records AS the job token’s user in the token’s project', async () => {
    const res = await recordDoor(internalReq(sent, authed()));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ outcome: 'recorded', pause: PAUSE });
    expect(recordPause).toHaveBeenCalledWith(
      {
        jobId: 'job-1',
        kind: 'replan',
        changeTurnIds: ['e1'],
        reason: 'because',
        question: null,
        idempotencyKey: 'k1',
      },
      { userId: 'u1', workspaceId: 'ws1', projectId: 'pj1' },
    );
  });

  it('forwards the blocked repositories of a code_unsearchable pause to the service', async () => {
    const repos = [{ repoRef: 'acme/web', state: 'never_indexed' }];
    const res = await recordDoor(
      internalReq(
        {
          jobId: 'job-1',
          kind: 'code_unsearchable',
          changeTurnIds: [],
          repos,
          idempotencyKey: 'k2',
        },
        authed(),
      ),
    );
    expect(res.status).toBe(200);
    expect(recordPause).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'code_unsearchable', repos, changeTurnIds: [] }),
      { userId: 'u1', workspaceId: 'ws1', projectId: 'pj1' },
    );
  });

  it('400s a kind outside the three, calling nothing', async () => {
    const res = await recordDoor(internalReq({ ...sent, kind: 'other' }, authed()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PLAN_CHANGE_RUN_PAUSE_SHAPE' });
    expect(recordPause).not.toHaveBeenCalled();
  });

  it('refuses a request without the service bearer or a job token, calling nothing', async () => {
    for (const headers of <Array<Record<string, string>>>[
      {},
      { authorization: `Bearer ${SERVICE_SECRET}` },
      { 'x-motir-job-token': token() },
    ]) {
      const res = await recordDoor(internalReq(sent, headers));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(recordPause).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'nope'],
    ['no job', { ...sent, jobId: '' }],
    ['a bad kind', { ...sent, kind: 'other' }],
    ['bad turn ids', { ...sent, changeTurnIds: 'e1' }],
    ['no key', { ...sent, idempotencyKey: undefined }],
  ])('400s %s', async (_n, bad) => {
    const res = await recordDoor(internalReq(bad, authed()));
    expect(res.status).toBe(400);
    expect(recordPause).not.toHaveBeenCalled();
  });

  it('maps the service refusals: terminal job, decided plan, foreign turn, shape', async () => {
    const cases: Array<[Error, number]> = [
      [new PlanChangeJobNotRunningError('job-1', 'succeeded'), 409],
      [new PlanChangeRunPausePlanDecidedError('pl1', 'approved'), 409],
      [new PlanChangeRunPauseTurnMismatchError('e9'), 409],
      [new PlanChangeRunPauseShapeError('needs a question'), 400],
    ];
    for (const [err, status] of cases) {
      recordPause.mockRejectedValueOnce(err);
      expect((await recordDoor(internalReq(sent, authed()))).status).toBe(status);
    }
  });
});
