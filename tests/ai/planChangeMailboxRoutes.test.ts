import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';

// Route-level TRANSPORT tests for the BOUNDARY MAILBOX's two doors (Story
// MOTIR-4054 · MOTIR-4067). The behaviour behind them is driven against a real
// Postgres in `tests/integration/planning/planChangeMailbox.test.ts`; what is
// proven HERE is the seam only a route can carry:
//
//   * the INGEST is SESSION-authenticated and project-scoped, and its body
//     contract is strict about the one field that cannot be defaulted;
//   * the READ DOOR is SERVICE-authenticated (the §4a bearer + the §4b job
//     token) — the same gate every other `/api/internal/ai/*` route takes, so a
//     browser session cannot reach it at all;
//   * the read door is a POST, because it CONSUMES;
//   * a typed service error becomes the right status, with the field a client
//     needs to act on.
//
// Mocked: the service (the layer under test is the transport), the two context
// resolvers the node env cannot supply with no cookies, and the 2FA policy —
// the `askStreamRoute` precedent.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const attachTurn = vi.fn();
const readForBoundary = vi.fn();
const raiseStop = vi.fn();
const raiseSkipFinalCheck = vi.fn();
vi.mock('@/lib/services/planChangeMailboxService', () => ({
  planChangeMailboxService: {
    attachTurn: (...args: unknown[]) => attachTurn(...args),
    readForBoundary: (...args: unknown[]) => readForBoundary(...args),
    raiseStop: (...args: unknown[]) => raiseStop(...args),
    raiseSkipFinalCheck: (...args: unknown[]) => raiseSkipFinalCheck(...args),
  },
}));

const { POST: ingest } = await import('@/app/api/ai/plan-change/session/mailbox/route');
const { POST: stopDoor } = await import('@/app/api/ai/plan-change/session/mailbox/stop/route');
const { POST: skipDoor } =
  await import('@/app/api/ai/plan-change/session/mailbox/skip-final-check/route');
const { POST: readDoor } = await import('@/app/api/internal/ai/plan-change-mailbox/route');
const { mintJobToken } = await import('@/lib/ai/jobToken');
const {
  PlanChangeJobNotRunningError,
  PlanChangeMailboxJobMismatchError,
  PlanSessionNotFoundError,
} = await import('@/lib/planChange/errors');

// Every conversation door names its session by id (MOTIR-6023). The builders add
// the one these cases hold unless a case is about its absence.
const SESSION_ID = 's1';
const withSession = (body: unknown) =>
  body && typeof body === 'object' && !('sessionId' in body)
    ? { sessionId: SESSION_ID, ...body }
    : body;

const SERVICE_SECRET = 'core-callback-secret-test';
const EMPTY = { turns: [], stopped: false };

function ingestReq(body: unknown, opts: { session?: boolean } = {}): Request {
  const sent = opts.session === false ? body : withSession(body);
  return new Request('http://localhost:3000/api/ai/plan-change/session/mailbox', {
    method: 'POST',
    body: typeof sent === 'string' ? sent : JSON.stringify(sent),
  });
}

function readReq(body: unknown, headers: Record<string, string>): Request {
  return new Request('http://internal/api/internal/ai/plan-change-mailbox', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  session.current = { user: { id: 'u1', email: 'yue@example.com', name: 'Yue' } };
  // A synthetic context with no rows behind it — the layer under test is the
  // TRANSPORT, and the service it calls is mocked. `project` is the ProjectDTO
  // the browser context carries; nothing on these two routes reads it, so a stub
  // is honest rather than a shortcut.
  activeCtx.current = {
    userId: 'u1',
    workspaceId: 'ws1',
    projectId: 'pj1',
    project: { id: 'pj1', key: 'MOTIR', name: 'Motir' } as unknown as ProjectContext['project'],
  };
  attachTurn.mockResolvedValue(EMPTY);
  readForBoundary.mockResolvedValue(EMPTY);
  raiseStop.mockResolvedValue({ turns: [], stopped: true });
  raiseSkipFinalCheck.mockResolvedValue({
    outcome: 'skipped',
    mailbox: { turns: [], stopped: false, skipFinalCheck: true },
  });
});

function stopReq(body: unknown, opts: { session?: boolean } = {}): Request {
  const sent = opts.session === false ? body : withSession(body);
  return new Request('http://localhost:3000/api/ai/plan-change/session/mailbox/stop', {
    method: 'POST',
    body: typeof sent === 'string' ? sent : JSON.stringify(sent),
  });
}

describe('the INGEST — POST /api/ai/plan-change/session/mailbox', () => {
  it('passes the parsed turn to the service and answers the mailbox', async () => {
    attachTurn.mockResolvedValue({
      turns: [
        {
          id: 'e1',
          text: 'queued',
          receivedAt: '2026-09-03T05:00:00.000Z',
          disposition: 'fold',
          target: null,
        },
      ],
      stopped: false,
    });

    const res = await ingest(ingestReq({ jobId: 'job-1', body: 'queued', idempotencyKey: 'k1' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ turns: [{ id: 'e1' }], stopped: false });
    expect(attachTurn).toHaveBeenCalledWith(
      {
        jobId: 'job-1',
        sessionId: SESSION_ID,
        body: 'queued',
        idempotencyKey: 'k1',
        disposition: 'fold',
        restartTarget: null,
      },
      activeCtx.current,
    );
    // The answer is per-viewer and must never be cached between them.
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('401s with no session and 404s with no active project — before any service call', async () => {
    session.current = null;
    expect((await ingest(ingestReq({ jobId: 'j', body: 'x', idempotencyKey: 'k' }))).status).toBe(
      401,
    );

    session.current = { user: { id: 'u1', email: 'yue@example.com', name: 'Yue' } };
    activeCtx.current = null;
    expect((await ingest(ingestReq({ jobId: 'j', body: 'x', idempotencyKey: 'k' }))).status).toBe(
      404,
    );

    expect(attachTurn).not.toHaveBeenCalled();
  });

  it('400s on a missing `idempotencyKey` — the server does not invent one', async () => {
    // A server-generated key cannot recognise the SAME submit arriving twice,
    // which is the entire property the field exists for. A caller that will not
    // supply one is told so rather than silently getting at-least-once delivery.
    const res = await ingest(ingestReq({ jobId: 'job-1', body: 'x' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'BAD_REQUEST' });
    expect(attachTurn).not.toHaveBeenCalled();
  });

  it('400s on a missing `jobId` or `body`, and on an unparseable payload', async () => {
    for (const body of [
      { body: 'x', idempotencyKey: 'k' },
      { jobId: 'j', idempotencyKey: 'k' },
      'not json at all',
    ]) {
      expect((await ingest(ingestReq(body))).status).toBe(400);
    }
    expect(attachTurn).not.toHaveBeenCalled();
  });

  it('reads `disposition` STRICTLY — anything but the literal `restart` folds', async () => {
    // The two are not symmetric: folding carries on, restarting WITHDRAWS what
    // the pass appended. So an unrecognised value must land on the branch that
    // destroys nothing — the same reading motir-ai's own parse takes.
    for (const value of ['RESTART', 'Restart', 'stop', 1, true, null, undefined]) {
      await ingest(ingestReq({ jobId: 'j', body: 'x', idempotencyKey: 'k', disposition: value }));
      expect(attachTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({ disposition: 'fold' }),
        activeCtx.current,
      );
    }
    await ingest(ingestReq({ jobId: 'j', body: 'x', idempotencyKey: 'k', disposition: 'restart' }));
    expect(attachTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ disposition: 'restart' }),
      activeCtx.current,
    );
  });

  it('409s a turn addressed at a finished job AND names the status', async () => {
    // "That run is over" leaves the client guessing whether to resubmit as a new
    // turn (succeeded / stopped) or to surface a failure, and those are opposite
    // next steps — so the status is on the wire, not only in the prose.
    attachTurn.mockRejectedValue(new PlanChangeJobNotRunningError('job-1', 'succeeded'));
    const res = await ingest(ingestReq({ jobId: 'job-1', body: 'late', idempotencyKey: 'k' }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
      jobStatus: 'succeeded',
    });
  });

  it('400s a turn that names no session, and 404s one from another project (MOTIR-6023)', async () => {
    const res = await ingest(
      ingestReq({ jobId: 'job-1', body: 'x', idempotencyKey: 'k' }, { session: false }),
    );
    expect(res.status).toBe(400);
    expect(attachTurn).not.toHaveBeenCalled();

    attachTurn.mockRejectedValue(new PlanSessionNotFoundError('elsewhere'));
    const foreign = await ingest(ingestReq({ jobId: 'job-1', body: 'x', idempotencyKey: 'k' }));
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toMatchObject({ code: 'PLAN_SESSION_NOT_FOUND' });
  });

  it('404s a job this thread is not on — no existence leak', async () => {
    attachTurn.mockRejectedValue(new PlanChangeMailboxJobMismatchError('someone-elses'));
    const res = await ingest(ingestReq({ jobId: 'someone-elses', body: 'x', idempotencyKey: 'k' }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: 'PLAN_CHANGE_MAILBOX_JOB_MISMATCH',
    });
  });
});

describe('the READ DOOR — POST /api/internal/ai/plan-change-mailbox', () => {
  const token = () => mintJobToken({ userId: 'u1', workspaceId: 'ws1', projectId: 'pj1' });
  const authed = () => ({
    authorization: `Bearer ${SERVICE_SECRET}`,
    'x-motir-job-token': token(),
  });

  it('reads the mailbox AS the job token’s user, in the token’s project', async () => {
    readForBoundary.mockResolvedValue({
      turns: [
        {
          id: 'e1',
          text: 'fold me',
          receivedAt: '2026-09-03T05:00:00.000Z',
          disposition: 'fold',
          target: null,
        },
      ],
      stopped: true,
    });

    const res = await readDoor(readReq({ jobId: 'job-1' }, authed()));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      turns: [
        {
          id: 'e1',
          text: 'fold me',
          receivedAt: '2026-09-03T05:00:00.000Z',
          disposition: 'fold',
          target: null,
        },
      ],
      stopped: true,
    });
    // The tenancy is the TOKEN's, never the request body's — which is what makes
    // a job token from another tenant read its own empty mailbox rather than
    // somebody else's.
    expect(readForBoundary).toHaveBeenCalledWith('job-1', {
      userId: 'u1',
      workspaceId: 'ws1',
      projectId: 'pj1',
    });
  });

  it('401s without the service bearer, and without the job token', async () => {
    // A browser session cannot reach this door at all: it takes neither cookie
    // nor session, only the two service credentials.
    expect((await readDoor(readReq({ jobId: 'j' }, { 'x-motir-job-token': token() }))).status).toBe(
      401,
    );
    expect(
      (await readDoor(readReq({ jobId: 'j' }, { authorization: `Bearer ${SERVICE_SECRET}` })))
        .status,
    ).toBe(401);
    expect(readForBoundary).not.toHaveBeenCalled();
  });

  it('401s on a bearer that is merely CLOSE — the compare is not a prefix match', async () => {
    expect(
      (
        await readDoor(
          readReq(
            { jobId: 'j' },
            { authorization: `Bearer ${SERVICE_SECRET}x`, 'x-motir-job-token': token() },
          ),
        )
      ).status,
    ).toBe(401);
  });

  it('400s a request with no `jobId` — there is no default mailbox', async () => {
    const res = await readDoor(readReq({}, authed()));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'JOB_ID_REQUIRED' });
    expect(readForBoundary).not.toHaveBeenCalled();
  });

  it('answers an EMPTY mailbox with 200, not 404 — the run must tell "nothing waiting" from "could not tell"', async () => {
    // The card's own criterion, and the one place a tidier-looking 404 would be
    // actively wrong: motir-ai reads every non-2xx as empty, so a 404 here would
    // erase the distinction the run needs to proceed on the answer.
    readForBoundary.mockResolvedValue(EMPTY);
    const res = await readDoor(readReq({ jobId: 'nothing-waiting' }, authed()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(EMPTY);
  });

  it('is not cached — the answer changes the moment it is read', async () => {
    const res = await readDoor(readReq({ jobId: 'job-1' }, authed()));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('the STOP door — POST /api/ai/plan-change/session/mailbox/stop (MOTIR-4068)', () => {
  it('raises the stop through the SAME mailbox service, never a second channel', async () => {
    const res = await stopDoor(stopReq({ jobId: 'job-1', idempotencyKey: 'stop:job-1' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ stopped: true });
    // ONE pipe. The turns and the stop share a `seq` sequence per job, which is
    // only true while both go through this service — a stop with a store of its
    // own would let it overtake a turn typed before it.
    expect(raiseStop).toHaveBeenCalledWith('job-1', 'stop:job-1', activeCtx.current, SESSION_ID);
    expect(attachTurn).not.toHaveBeenCalled();
  });

  it('401s with no session and 404s with no active project', async () => {
    session.current = null;
    expect((await stopDoor(stopReq({ jobId: 'j', idempotencyKey: 'k' }))).status).toBe(401);

    session.current = { user: { id: 'u1', email: 'yue@example.com', name: 'Yue' } };
    activeCtx.current = null;
    expect((await stopDoor(stopReq({ jobId: 'j', idempotencyKey: 'k' }))).status).toBe(404);

    expect(raiseStop).not.toHaveBeenCalled();
  });

  it('400s without a `jobId` or an `idempotencyKey` — a double click must raise ONE stop', async () => {
    for (const body of [{ idempotencyKey: 'k' }, { jobId: 'j' }, 'not json']) {
      expect((await stopDoor(stopReq(body))).status).toBe(400);
    }
    expect(raiseStop).not.toHaveBeenCalled();
  });

  it('⚠️ does NOT refuse a run that has already finished — unlike the turn door beside it', async () => {
    // The one place the two doors deliberately differ. The control is reachable
    // in states where the click is redundant (the run can settle between render
    // and click), so it has to be safe there: an entry nobody reads is harmless,
    // and a refusal the user cannot act on is not. The service answers cleanly
    // and this route passes that through.
    raiseStop.mockResolvedValue({ turns: [], stopped: true });
    const res = await stopDoor(stopReq({ jobId: 'job-1', idempotencyKey: 'stop:job-1' }));
    expect(res.status).toBe(200);
  });

  it('400s a stop that names no session', async () => {
    const res = await stopDoor(stopReq({ jobId: 'j', idempotencyKey: 'k' }, { session: false }));
    expect(res.status).toBe(400);
    expect(raiseStop).not.toHaveBeenCalled();
  });

  it('404s a job this thread is not on', async () => {
    raiseStop.mockRejectedValue(new PlanChangeMailboxJobMismatchError('someone-elses'));
    const res = await stopDoor(stopReq({ jobId: 'someone-elses', idempotencyKey: 'k' }));
    expect(res.status).toBe(404);
  });
});

function skipReq(body: unknown, opts: { session?: boolean } = {}): Request {
  const sent = opts.session === false ? body : withSession(body);
  return new Request('http://localhost:3000/api/ai/plan-change/session/mailbox/skip-final-check', {
    method: 'POST',
    body: typeof sent === 'string' ? sent : JSON.stringify(sent),
  });
}

describe('the SKIP door — POST /api/ai/plan-change/session/mailbox/skip-final-check (MOTIR-11266)', () => {
  it('raises the skip through the SAME mailbox service and answers its outcome', async () => {
    const res = await skipDoor(skipReq({ jobId: 'job-1', idempotencyKey: 'skip:job-1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(res.json()).resolves.toEqual({
      outcome: 'skipped',
      mailbox: { turns: [], stopped: false, skipFinalCheck: true },
    });
    expect(raiseSkipFinalCheck).toHaveBeenCalledWith(
      'job-1',
      'skip:job-1',
      activeCtx.current,
      SESSION_ID,
    );
    expect(raiseStop).not.toHaveBeenCalled();
  });

  it('answers a check that already ended with 200 `not_running`, not a refusal', async () => {
    raiseSkipFinalCheck.mockResolvedValue({ outcome: 'not_running', mailbox: EMPTY });
    const res = await skipDoor(skipReq({ jobId: 'job-1', idempotencyKey: 'k' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'not_running' });
  });

  it('401s with no session and 404s with no active project', async () => {
    session.current = null;
    expect((await skipDoor(skipReq({ jobId: 'j', idempotencyKey: 'k' }))).status).toBe(401);
    session.current = { user: { id: 'u1', email: 'yue@example.com', name: 'Yue' } };
    activeCtx.current = null;
    expect((await skipDoor(skipReq({ jobId: 'j', idempotencyKey: 'k' }))).status).toBe(404);
    expect(raiseSkipFinalCheck).not.toHaveBeenCalled();
  });

  it('400s without a `jobId`, an `idempotencyKey` or a session, and on a bad body', async () => {
    for (const body of [{ idempotencyKey: 'k' }, { jobId: 'j' }, 'not json']) {
      expect((await skipDoor(skipReq(body))).status).toBe(400);
    }
    const noSession = skipReq({ jobId: 'j', idempotencyKey: 'k' }, { session: false });
    expect((await skipDoor(noSession)).status).toBe(400);
    expect(raiseSkipFinalCheck).not.toHaveBeenCalled();
  });

  it('403s a caller without `ai:plan`, as the stop door does', async () => {
    const { PermissionDeniedError } = await import('@/lib/projects/errors');
    raiseSkipFinalCheck.mockRejectedValue(new PermissionDeniedError('pj1', 'ai:plan'));
    const res = await skipDoor(skipReq({ jobId: 'job-1', idempotencyKey: 'k' }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ permission: 'ai:plan' });
  });

  it('404s a job this thread is not on', async () => {
    raiseSkipFinalCheck.mockRejectedValue(new PlanChangeMailboxJobMismatchError('someone-elses'));
    const res = await skipDoor(skipReq({ jobId: 'someone-elses', idempotencyKey: 'k' }));
    expect(res.status).toBe(404);
  });

  it('lets an unmapped error through', async () => {
    raiseSkipFinalCheck.mockRejectedValue(new Error('boom'));
    await expect(skipDoor(skipReq({ jobId: 'job-1', idempotencyKey: 'k' }))).rejects.toThrow(
      'boom',
    );
  });
});
