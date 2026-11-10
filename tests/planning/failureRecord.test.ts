import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJob } from '@/lib/ai/motirAiClient';
import {
  MotirAiJobFailedError,
  MotirAiOutOfCreditsError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import { terminalStatusOf, walkPositionOf } from '@/lib/ai/jobStream';
import {
  failureRecordFrom,
  parseJobWalkStop,
  parseWalkPosition,
  reasonCodeFromError,
} from '@/lib/planChange/failureRecord';
import {
  classifyAbandonedCandidate,
  classifySessionCandidate,
} from '@/lib/services/abandonedPlanService';
import { PlanTargetLockedError } from '@/lib/planChange/errors';

// MOTIR-7912 — the pure half of recording a failed hosted attempt: the walk-stop
// parse, the TOTAL reason map, the record builder, the frame readers, the second
// sweep table and the refusal's new fields. No database.

const NOW = new Date('2026-10-09T12:00:00Z');
const WALK_STOP = {
  phase: 'author',
  target: 'planItem:abc',
  targetTitle: 'Export a report',
  depth: 1,
  planId: 'plan_1',
  reasonCode: 'rate_limited',
  detail: 'the model said slow down',
};

describe('parseJobWalkStop', () => {
  it('reads a well-formed walkStop', () => {
    expect(parseJobWalkStop(WALK_STOP)).toMatchObject({ phase: 'author', target: 'planItem:abc' });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['a wrong-typed phase', { ...WALK_STOP, phase: 'think' }],
    ['a wrong-typed depth', { ...WALK_STOP, depth: 'one' }],
    ['a missing reasonCode', { phase: 'lay', target: null, depth: 0 }],
  ])('reads %s as null and never throws', (_name, raw) => {
    expect(parseJobWalkStop(raw)).toBeNull();
  });

  // MOTIR-10209 — a strict object stripped this field, so the halt's lines never reached the
  // record. They are kept, in order; a malformed value is IGNORED and never fails the stop.
  it('keeps notPlannedYet, verbatim and in order', () => {
    const lines = [
      '"D" is not planned yet: plan "B" first, then plan "D".',
      'Not written yet: "T".',
    ];
    expect(parseJobWalkStop({ ...WALK_STOP, notPlannedYet: lines })?.notPlannedYet).toEqual(lines);
  });

  it('reads a walkStop without notPlannedYet as before', () => {
    const parsed = parseJobWalkStop(WALK_STOP);
    expect(parsed).not.toBeNull();
    expect(parsed?.notPlannedYet).toBeUndefined();
  });

  it.each([
    ['a string', 'D is not planned yet'],
    ['an array holding a non-string', ['ok', 7]],
    ['an object', { 0: 'D' }],
    ['null', null],
  ])('ignores a malformed notPlannedYet (%s) and keeps the rest of the stop', (_name, bad) => {
    const parsed = parseJobWalkStop({ ...WALK_STOP, notPlannedYet: bad });
    expect(parsed).toMatchObject({ phase: 'author', reasonCode: 'rate_limited' });
    expect(parsed?.notPlannedYet).toBeUndefined();
  });
});

describe('reasonCodeFromError — total', () => {
  it.each([
    ['MOTIR_AI_OUT_OF_CREDITS', 'out_of_credits'],
    ['MOTIR_AI_UNAUTHORIZED', 'token_expired'],
    ['MOTIR_AI_UNAVAILABLE', 'model_unavailable'],
    ['MOTIR_AI_JOB_FAILED', 'job_failed'],
    // A terminal job whose problem is `validation_error` (any 4xx) reads back as
    // MotirAiBadRequestError: the handler refused it, the provider was not down (MOTIR-9127).
    ['MOTIR_AI_BAD_REQUEST', 'job_failed'],
    ['MOTIR_AI_JOB_NOT_FOUND', 'internal'],
    ['SOMETHING_NEW', 'internal'],
  ])('%s → %s', (code, expected) => {
    expect(reasonCodeFromError({ code })).toBe(expected);
  });

  it('maps a missing error to internal', () => {
    expect(reasonCodeFromError(null)).toBe('internal');
    expect(reasonCodeFromError(undefined)).toBe('internal');
  });
});

describe('failureRecordFrom', () => {
  const base = { failedJobId: 'job_1', now: NOW, lastPosition: null, error: null };

  it('takes the stop point, reason and detail from walkStop', () => {
    const rec = failureRecordFrom({ ...base, walkStop: parseJobWalkStop(WALK_STOP) });
    expect(rec).toEqual({
      failedAt: NOW,
      failedJobId: 'job_1',
      failureReason: 'rate_limited',
      failureDetail: 'the model said slow down',
      failureStopPhase: 'author',
      failureStopRef: 'planItem:abc',
      failureStopTitle: 'Export a report',
      failureResumable: null,
      failureNotPlannedYet: [],
    });
  });

  it('carries the walk stop’s not-planned-yet lines verbatim and in order (MOTIR-10209)', () => {
    const lines = [
      '"D" is not planned yet: plan "B" first, then plan "D".',
      'Not written yet: "T" waits on "S", and planning stopped before it was written — continuing this plan writes it.',
    ];
    const rec = failureRecordFrom({
      ...base,
      walkStop: parseJobWalkStop({ ...WALK_STOP, notPlannedYet: lines }),
    });
    expect(rec.failureNotPlannedYet).toEqual(lines);
  });

  it('records no lines from a relayed position or a bare error (MOTIR-10209)', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: null,
      lastPosition: { phase: 'lay', target: null, depth: 0 },
      error: new MotirAiOutOfCreditsError('out'),
    });
    expect(rec.failureNotPlannedYet).toEqual([]);
  });

  it('falls back to the last relayed position when walkStop is absent', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: null,
      lastPosition: { phase: 'lay', target: null, depth: 0 },
      error: new MotirAiOutOfCreditsError('out'),
    });
    expect(rec).toMatchObject({
      failureReason: 'out_of_credits',
      failureStopPhase: 'lay',
      failureStopRef: null,
    });
  });

  it('is all-null on the stop point with neither, and internal for a plain failure', () => {
    const rec = failureRecordFrom({ ...base, walkStop: null });
    expect(rec).toMatchObject({
      failureReason: 'internal',
      failureStopPhase: null,
      failureStopRef: null,
      failureStopTitle: null,
      failureDetail: null,
    });
  });

  it('carries motir-ai’s resumable verdict onto the record, and unknown as null (MOTIR-9121)', () => {
    const b = { ...base, walkStop: null };
    expect(failureRecordFrom({ ...b, resumable: false }).failureResumable).toBe(false);
    expect(failureRecordFrom({ ...b, resumable: true }).failureResumable).toBe(true);
    expect(failureRecordFrom({ ...b, resumable: null }).failureResumable).toBeNull();
    expect(failureRecordFrom(b).failureResumable).toBeNull();
  });

  it('records a plan with NO job as internal with no job and no stop point (MOTIR-8132)', () => {
    const rec = failureRecordFrom({ ...base, failedJobId: null, walkStop: null });
    expect(rec).toMatchObject({
      failedJobId: null,
      failureReason: 'internal',
      failureStopPhase: null,
      failureStopRef: null,
    });
  });

  it('records a prompt_too_large walkStop as prompt_too_large, not as the provider being unavailable', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: parseJobWalkStop({
        ...WALK_STOP,
        reasonCode: 'prompt_too_large',
        detail: 'the prompt is too large for this model: 210000 of 200000 tokens',
      }),
      error: { code: 'MOTIR_AI_JOB_FAILED' },
    });
    expect(rec.failureReason).toBe('prompt_too_large');
    expect(rec.failureDetail).toMatch(/^the prompt is too large for this model/);
  });

  it('still records an unavailable provider as model_unavailable (MOTIR-9127)', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: null,
      error: new MotirAiUnavailableError('gateway 503'),
    });
    expect(rec.failureReason).toBe('model_unavailable');
  });

  it('records an UNKNOWN reasonCode as internal, never as prose', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: parseJobWalkStop({ ...WALK_STOP, reasonCode: 'cosmic_rays' }),
    });
    expect(rec.failureReason).toBe('internal');
  });

  it('caps an over-long detail', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: parseJobWalkStop({ ...WALK_STOP, detail: 'x'.repeat(900) }),
    });
    expect(rec.failureDetail!.length).toBe(300);
  });

  it('uses the error message as the detail when walkStop carries none', () => {
    const rec = failureRecordFrom({
      ...base,
      walkStop: null,
      error: new MotirAiUnavailableError('gateway 503'),
    });
    expect(rec.failureDetail).toContain('gateway 503');
  });

  it('records a REAPED job exactly as it reads today — model_unavailable, its detail (MOTIR-8304)', async () => {
    // What `getJob` maps motir-ai's `ai_job_abandoned` problem to: the lost-machine
    // fact rides beside the error and never reaches the record.
    const detail =
      'the worker holding this job stopped renewing its lease (claimedBy m1); nothing about the request was judged, so a resubmit is the right response';
    process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobId: 'job_1',
            status: 'failed',
            result: null,
            error: { type: 't', title: 'abandoned', status: 503, code: 'ai_job_abandoned', detail },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const view = await getJob('job_1', 'pj_1');
    vi.unstubAllGlobals();
    expect(view.lostMachine).toBe(true);

    const rec = failureRecordFrom({ ...base, walkStop: view.walkStop ?? null, error: view.error });

    expect(rec.failureReason).toBe('model_unavailable');
    // Exactly the detail any unavailable failure with this message is stored with.
    expect(rec.failureDetail).toBe(new MotirAiUnavailableError(detail).message);
  });

  it('records a job that FAILED as job_failed, never as motir-ai being unavailable (MOTIR-8569)', async () => {
    // The production shape: the planning job ran and threw on a refused read-back.
    // Before, getJob mapped it to MotirAiUnavailableError, so the session read
    // "motir-ai is unavailable" for a job motir-ai had run to its end.
    const detail =
      'planning: the project\'s terminal statuses could not be read for MOTIR-8239: HTTP 401: terminal-statuses read-back failed: {"code":"UNAUTHENTICATED"} — refusing to plan without them';
    process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobId: 'job_1',
            status: 'failed',
            result: null,
            error: { type: 't', title: 'Job failed', status: 500, code: 'ai_job_failed', detail },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const view = await getJob('job_1', 'pj_1');
    vi.unstubAllGlobals();

    const rec = failureRecordFrom({ ...base, walkStop: view.walkStop ?? null, error: view.error });

    expect(rec.failureReason).toBe('job_failed');
    expect(rec.failureDetail).not.toContain('motir-ai is unavailable');
    expect(rec.failureDetail).toContain('HTTP 401');
  });

  it('records a job motir-ai REFUSED with validation_error as job_failed, not model_unavailable (MOTIR-9127)', async () => {
    // The production shape: the job's read token expired in the queue, so motir-ai's
    // handler refused it with a 4xx problem before any model was called. getJob maps
    // that problem to MotirAiBadRequestError.
    const detail = 'none of the target work items (MOTIR-9002) could be read for this user';
    process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobId: 'job_1',
            status: 'failed',
            result: null,
            error: { type: 't', title: 'Invalid', status: 422, code: 'validation_error', detail },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const view = await getJob('job_1', 'pj_1');
    vi.unstubAllGlobals();
    expect(view.error?.code).toBe('MOTIR_AI_BAD_REQUEST');

    const rec = failureRecordFrom({ ...base, walkStop: view.walkStop ?? null, error: view.error });

    expect(rec.failureReason).toBe('job_failed');
    expect(rec.failureDetail).toContain('none of the target work items');
  });
});

describe('the frame readers', () => {
  it('terminalStatusOf separates failed from canceled and ignores the rest', () => {
    expect(terminalStatusOf({ event: 'status', data: { status: 'failed' } })).toBe('failed');
    expect(terminalStatusOf({ event: 'status', data: { status: 'canceled' } })).toBe('canceled');
    expect(terminalStatusOf({ event: 'status', data: { status: 'running' } })).toBeNull();
    expect(terminalStatusOf({ event: 'done', data: {} })).toBeNull();
  });

  it('walkPositionOf reads a walk_position frame and nothing malformed', () => {
    expect(
      walkPositionOf({ event: 'walk_position', data: { phase: 'lay', target: null, depth: 0 } }),
    ).toEqual({ phase: 'lay', target: null, depth: 0 });
    expect(walkPositionOf({ event: 'walk_position', data: { phase: 'x' } })).toBeNull();
    expect(
      walkPositionOf({ event: 'status', data: { phase: 'lay', target: null, depth: 0 } }),
    ).toBeNull();
    expect(parseWalkPosition(null)).toBeNull();
  });

  // MOTIR-10878 — on motir-ai's real wire `walk_position` is a PROGRESS frame, so
  // the position is nested under `data` beside the job id and seq.
  it('walkPositionOf reads the position through motir-ai’s progress envelope', () => {
    expect(
      walkPositionOf({
        event: 'walk_position',
        data: {
          jobId: 'job-1',
          seq: 7,
          data: { phase: 'author', target: 'planItem:x', targetTitle: 'Export', depth: 2 },
        },
      }),
    ).toEqual({ phase: 'author', target: 'planItem:x', targetTitle: 'Export', depth: 2 });
    expect(
      walkPositionOf({ event: 'walk_position', data: { jobId: 'job-1', seq: 8, data: {} } }),
    ).toBeNull();
  });
});

describe('classifySessionCandidate — the second table', () => {
  const failedJob = { status: 'failed', reachable: true, failure: null } as const;
  const succeededJob = { status: 'succeeded', reachable: true, failure: null } as const;
  const SILENT_MS = 20 * 60_000;
  const dead = (job: Parameters<typeof classifyAbandonedCandidate>[0]) => {
    const verdict = classifyAbandonedCandidate(job, SILENT_MS);
    if (!verdict.abandoned) throw new Error('fixture is not dead');
    return verdict;
  };

  it('spares a waiting session on either wait', () => {
    expect(classifySessionCandidate('failed', dead(failedJob))).toEqual({
      action: 'keep',
      reason: 'session_waiting',
    });
    expect(classifySessionCandidate('awaiting_person', dead(failedJob))).toEqual({
      action: 'keep',
      reason: 'session_waiting',
    });
  });

  it('records EVERY dead verdict on an open session — never a decline (MOTIR-8132)', () => {
    expect(classifySessionCandidate('open', dead(failedJob))).toEqual({
      action: 'record',
      reason: 'job_terminal',
    });
    expect(classifySessionCandidate('open', dead(succeededJob))).toEqual({
      action: 'record',
      reason: 'job_terminal',
    });
    const canceled = { status: 'canceled', reachable: true, failure: null } as const;
    expect(classifySessionCandidate('open', dead(canceled))).toEqual({
      action: 'record',
      reason: 'job_terminal',
    });
    const gone = {
      status: null,
      reachable: false,
      failure: { code: 'MOTIR_AI_JOB_NOT_FOUND', message: 'x' },
    } as const;
    expect(classifySessionCandidate('open', dead(gone))).toEqual({
      action: 'record',
      reason: 'job_gone',
    });
    const running = { status: 'running', reachable: true, failure: null } as const;
    expect(classifySessionCandidate('open', dead(running))).toEqual({
      action: 'record',
      reason: 'silent',
    });
    expect(classifySessionCandidate('open', dead(null))).toEqual({
      action: 'record',
      reason: 'silent',
    });
  });
});

describe('PlanTargetLockedError — the waiting fields', () => {
  it('a plain hold is not waiting and keeps its free-by time', () => {
    const err = new PlanTargetLockedError('MOTIR-1', 'Ada', NOW, { sessionId: 's1' });
    expect(err.sessionWaiting).toBe(false);
    expect(err.waitingCause).toBeNull();
    expect(err.freesBy).not.toBeNull();
  });

  it.each(['question', 'reply', 'failed'] as const)(
    'a %s hold says waiting on the holder, with no free-by',
    (cause) => {
      const err = new PlanTargetLockedError('MOTIR-1', 'Ada', NOW, {
        sessionId: 's1',
        waitingCause: cause,
      });
      expect(err.sessionWaiting).toBe(true);
      expect(err.waitingCause).toBe(cause);
      expect(err.freesBy).toBeNull();
      expect(err.holderSessionId).toBe('s1');
      expect(err.message).toContain('waiting on Ada');
    },
  );
});

describe('getJob parses walkStop tolerantly', () => {
  beforeEach(() => {
    process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stub = (error: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ jobId: 'j', status: 'failed', result: null, error }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  const problem = {
    type: 'about:blank',
    title: 'Job failed',
    status: 500,
    code: 'ai_job_failed',
    detail: 'boom',
  };

  it('carries walkStop.notPlannedYet through to the job view (MOTIR-10209)', async () => {
    stub({ ...problem, walkStop: { ...WALK_STOP, notPlannedYet: ['"D" is not planned yet.'] } });
    const view = await getJob('j', 'pj');
    expect(view.walkStop?.notPlannedYet).toEqual(['"D" is not planned yet.']);
  });

  it('carries walkStop when the problem has one', async () => {
    stub({ ...problem, walkStop: WALK_STOP });
    const view = await getJob('j', 'pj');
    expect(view.walkStop).toMatchObject({ reasonCode: 'rate_limited' });
    expect(view.error).toBeInstanceOf(MotirAiJobFailedError);
  });

  it('reads null, with the same typed error, when walkStop is absent', async () => {
    stub(problem);
    const view = await getJob('j', 'pj');
    expect(view.walkStop).toBeNull();
    expect(view.error).toBeInstanceOf(MotirAiJobFailedError);
  });

  it('reads null when walkStop has the wrong shape', async () => {
    stub({ ...problem, walkStop: { phase: 7, depth: 'deep' } });
    const view = await getJob('j', 'pj');
    expect(view.walkStop).toBeNull();
    expect(view.error).toBeInstanceOf(MotirAiJobFailedError);
  });

  it('is null on a job with no error at all', async () => {
    stub(null);
    expect((await getJob('j', 'pj')).walkStop).toBeNull();
  });
});
