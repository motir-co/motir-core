import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { MotirAiConfigError, MotirAiUnauthorizedError } from '@/lib/ai/errors';
import { db } from '@/lib/db';
import { enqueueCodeGraphForward } from '@/lib/jobs/codeGraphForward';
import type { JobContext } from '@/lib/jobs/defineJob';
import {
  CODE_GRAPH_FORWARD_DEADLINE_MS,
  CODE_GRAPH_FORWARD_MAX_WAIT_MS,
  CODE_GRAPH_FORWARD_MIN_WAIT_MS,
  CodeGraphForwardTimedOutError,
  codeGraphForward,
  codeGraphForwardWaitMs,
} from '@/lib/jobs/definitions/codeGraphForward';
import { isJobRunDefer, type JobRunDefer } from '@/lib/jobs/engine/defer';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobWorker } from '@/lib/jobs/engine/worker';
import * as sendEventModule from '@/lib/jobs/sendEvent';
import { jobServices } from '@/lib/jobs/services';
import type { CodeGraphForwardData } from '@/lib/jobs/types';
import '@/lib/jobs/registry';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';

// THE CODE-GRAPH FORWARD JOB (MOTIR-12055 · story MOTIR-11870) —
// `system.code-graph-forward` and its enqueue door, with motir-ai stubbed at the HTTP
// boundary (`fetch`).
//
// Two drivers:
//   - the REAL engine — `enqueueCodeGraphForward` writes the event and the queue row,
//     a `JobWorker` claims it and `executeWithLedger` runs it over real Postgres — for
//     what the engine decides: a settled answer succeeds on its first pass with no
//     retry, a deferred pass REFUNDS its attempt, a 401 burns the budget;
//   - a PASS DRIVER over one memo — the engine's `job_step` — with the clock moved
//     between passes, for the waits and the 24 h deadline.

const JOB = 'system.code-graph-forward';
const ORG = 'org_fwd';
const REPO = 'moooon/motir-core';

const OPEN: CodeGraphForwardData = {
  kind: 'pull_request_state',
  coreOrganizationId: ORG,
  repoRef: REPO,
  ref: 'feature-x',
  pullRequestNumber: 7,
  state: 'open',
  reportedAt: '2026-11-22T10:00:00Z',
};
const CLOSED: CodeGraphForwardData = {
  ...OPEN,
  state: 'closed',
  reportedAt: '2026-11-22T11:00:00Z',
};
const MERGED: CodeGraphForwardData = {
  ...OPEN,
  state: 'merged',
  mergedAt: '2026-11-22T11:00:00Z',
  reportedAt: '2026-11-22T11:00:00Z',
};
const RETIRE: CodeGraphForwardData = {
  kind: 'retire',
  coreOrganizationId: ORG,
  repoRef: REPO,
  ref: 'feature-x',
};

type Answer = { status: number; body?: unknown } | 'transport';

/** motir-ai, stubbed: answers in order (the last one repeats), every request recorded. */
function stubMotirAi(...answers: Answer[]) {
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) as unknown });
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)]!;
      if (answer === 'transport') throw new TypeError('fetch failed');
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return requests;
}

const settled = (outcome: string): Answer => ({ status: 200, body: { ref: 'feature-x', outcome } });
const problem = (code: string, status: number): Answer => ({
  status,
  body: { type: `https://motir.co/errors/${code}`, title: code, status, code },
});

beforeEach(async () => {
  await truncateJobRuns();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the real engine ───────────────────────────────────────────────────────────

const worker = () =>
  new JobWorker({
    workerId: 'code-graph-forward-test',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    execute: async (run: JobQueueRun) => {
      const event = run.eventId
        ? await adminDb.jobEvent.findUnique({ where: { id: run.eventId } })
        : null;
      await executeWithLedger(run, event?.data ?? {});
    },
    onTerminalFailure: async (run, error) => {
      const event = run.eventId
        ? await adminDb.jobEvent.findUnique({ where: { id: run.eventId } })
        : null;
      await recordEngineTerminalFailure(run, error, event?.data ?? {});
    },
  });

const queueRow = () => adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId: JOB } });
const ledger = () =>
  adminDb.jobRun.findMany({ where: { functionId: JOB }, orderBy: { startedAt: 'asc' } });

/** One claim of the forward's row, made due now first. Returns the row after it. */
async function onePass(w = worker()): Promise<JobQueueRun> {
  await adminDb.jobQueueRun.updateMany({
    where: { jobId: JOB, state: 'pending' },
    data: { runAt: new Date(Date.now() - 1_000) },
  });
  expect(await w.tick()).toBe(1);
  await w.settled();
  return queueRow();
}

describe('enqueueCodeGraphForward', () => {
  it('enqueues ONE system.code-graph-forward run carrying exactly the event', async () => {
    await enqueueCodeGraphForward(OPEN);
    const rows = await adminDb.jobQueueRun.findMany({ where: { jobId: JOB } });
    expect(rows).toHaveLength(1);
    const event = await adminDb.jobEvent.findUniqueOrThrow({ where: { id: rows[0]!.eventId! } });
    expect(event.name).toBe(JOB);
    expect(event.data).toEqual(OPEN);
  });

  it('resolves and logs when the queue write throws', async () => {
    vi.spyOn(sendEventModule, 'sendSystemEvent').mockRejectedValue(new Error('queue down'));
    await expect(enqueueCodeGraphForward(RETIRE)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      '[code-graph-forward] could not enqueue a forward:',
      'queue down',
    );
  });

  it('resolves and logs a non-Error throw', async () => {
    vi.spyOn(sendEventModule, 'sendSystemEvent').mockRejectedValue('boom');
    await expect(enqueueCodeGraphForward(RETIRE)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      '[code-graph-forward] could not enqueue a forward:',
      'boom',
    );
  });

  it.each([[null], [undefined], [{}], [{ kind: 'push' }]])(
    'refuses an invalid argument (%j) without throwing, and enqueues nothing',
    async (bad) => {
      await expect(
        enqueueCodeGraphForward(bad as unknown as CodeGraphForwardData),
      ).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
      expect(await adminDb.jobQueueRun.count({ where: { jobId: JOB } })).toBe(0);
    },
  );
});

describe('a settled or refused answer ends the run on its first pass', () => {
  it.each([
    [OPEN, 'recorded'],
    [OPEN, 'stale'],
    [OPEN, 'default_branch'],
    [CLOSED, 'recorded'],
    // MOTIR-12299: only an OPEN report waits for its branch; a closed or merged one
    // on a branch the service does not hold is settled, as before.
    [CLOSED, 'unknown_ref'],
    [MERGED, 'unknown_ref'],
    [RETIRE, 'retired'],
    [RETIRE, 'already_done'],
    [RETIRE, 'default_branch'],
  ] as const)('%s.kind answered %s: succeeded, not deferred, no retry', async (event, outcome) => {
    const requests = stubMotirAi(settled(outcome));
    await enqueueCodeGraphForward(event);
    const row = await onePass();
    expect(row.state).toBe('succeeded');
    expect(row.attempts).toBe(1);
    expect(requests).toHaveLength(1);
    const runs = await ledger();
    expect(runs.map((r) => r.status)).toEqual(['succeeded']);
    expect(runs[0]!.output).toEqual({ kind: event.kind, outcome });
  });

  it.each([
    ['validation_error', 400],
    ['permission_denied', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['gone', 410],
  ])('a refused %s (%i) succeeds with the refusal recorded and a warning', async (code, status) => {
    stubMotirAi(problem(code, status));
    await enqueueCodeGraphForward(OPEN);
    const row = await onePass();
    expect(row.state).toBe('succeeded');
    expect(row.attempts).toBe(1);
    const runs = await ledger();
    expect(runs[0]!.output).toEqual({
      kind: 'pull_request_state',
      outcome: 'refused',
      status,
      code,
    });
    expect(console.warn).toHaveBeenCalledWith(
      `[code-graph-forward] motir-ai refused pull_request_state for ${REPO} feature-x: ${String(status)} ${code}`,
    );
  });
});

describe('an unavailable answer defers, refunded, until a settled one', () => {
  it('transport, 500, 503 codegraph_unavailable and 429 each defer; then recorded succeeds', async () => {
    const requests = stubMotirAi(
      'transport',
      problem('internal_error', 500),
      problem('codegraph_unavailable', 503),
      problem('rate_limited', 429),
      settled('recorded'),
    );
    await enqueueCodeGraphForward(OPEN);
    const w = worker();
    for (let pass = 1; pass <= 4; pass += 1) {
      const before = Date.now();
      const row = await onePass(w);
      expect(row.state, `pass ${pass}`).toBe('pending');
      // ⚠️ THE ATTEMPT IS REFUNDED: an outage costs none of the retry budget.
      expect(row.attempts, `pass ${pass}`).toBe(0);
      const wait = row.runAt.getTime() - before;
      expect(wait).toBeGreaterThanOrEqual(CODE_GRAPH_FORWARD_MIN_WAIT_MS - 1_000);
      expect(wait).toBeLessThanOrEqual(CODE_GRAPH_FORWARD_MAX_WAIT_MS + 1_000);
    }
    const row = await onePass(w);
    expect(row.state).toBe('succeeded');
    // Every pass re-sent the request: nothing replayed a recorded answer.
    expect(requests).toHaveLength(5);
    expect(new Set(requests.map((r) => JSON.stringify(r.body))).size).toBe(1);
    const runs = await ledger();
    expect(runs.at(-1)!.status).toBe('succeeded');
    expect(runs.at(-1)!.output).toEqual({ kind: 'pull_request_state', outcome: 'recorded' });
    expect(runs.some((r) => r.status === 'failed')).toBe(false);
    // Only the start is a step of the handler's (the two `job-run:` steps are the ledger's).
    const steps = await adminDb.jobStep.findMany({ where: { runId: row.id } });
    expect(steps.map((s) => s.stepId).filter((id) => !id.startsWith('job-run:'))).toEqual([
      'forward-started-v1',
    ]);
  });

  it('a 401 is a failed run through the idempotent budget, never a settled one', async () => {
    const requests = stubMotirAi(problem('service_unauthorized', 401));
    await enqueueCodeGraphForward(RETIRE);
    const w = worker();
    let row = await onePass(w);
    for (let pass = 0; pass < 10 && row.state === 'pending'; pass += 1) row = await onePass(w);
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(row.maxAttempts);
    expect(requests.length).toBe(row.maxAttempts);
    const runs = await ledger();
    expect(runs.some((r) => r.status === 'succeeded')).toBe(false);
  });
});

// ── the pass driver ───────────────────────────────────────────────────────────

function passDriver(data: CodeGraphForwardData) {
  const memo = new Map<string, unknown>();
  const ctx = {
    event: { name: JOB, data, id: 'evt-fwd' },
    step: {
      run: async (id: string, fn: () => unknown) => {
        if (memo.has(id)) return memo.get(id);
        const value = JSON.parse(JSON.stringify(await fn())) as unknown;
        memo.set(id, value);
        return value;
      },
      sleep: async () => undefined,
    },
    runId: 'run-fwd',
    attempt: 0,
  } as unknown as JobContext;
  return {
    memo,
    pass: async (): Promise<
      { kind: 'deferred'; defer: JobRunDefer } | { kind: 'done'; result: unknown }
    > => {
      try {
        return { kind: 'done', result: await codeGraphForward.handler(ctx, jobServices) };
      } catch (err) {
        if (isJobRunDefer(err)) return { kind: 'deferred', defer: err };
        throw err;
      }
    },
  };
}

describe('the waits and the deadline', () => {
  it('codeGraphForwardWaitMs clamps the elapsed time to [30 s, 30 min]', () => {
    expect(codeGraphForwardWaitMs(0)).toBe(30_000);
    expect(codeGraphForwardWaitMs(29_999)).toBe(30_000);
    expect(codeGraphForwardWaitMs(90_000)).toBe(90_000);
    expect(codeGraphForwardWaitMs(31 * 60_000)).toBe(30 * 60_000);
    expect(codeGraphForwardWaitMs(CODE_GRAPH_FORWARD_DEADLINE_MS)).toBe(30 * 60_000);
  });

  it('each deferred pass waits about the time already spent, growing, capped at 30 min', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
    stubMotirAi(problem('codegraph_unavailable', 503));
    const run = passDriver(OPEN);
    const waits: number[] = [];
    for (let pass = 0; pass < 12; pass += 1) {
      const out = await run.pass();
      expect(out.kind).toBe('deferred');
      const resumeAt = (out as { defer: JobRunDefer }).defer.resumeAt.getTime();
      waits.push(resumeAt - Date.now());
      vi.setSystemTime(resumeAt);
    }
    expect(waits[0]).toBe(30_000);
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
      expect(waits[i]!).toBeLessThanOrEqual(CODE_GRAPH_FORWARD_MAX_WAIT_MS);
    }
    // Roughly doubling: the second wait is the first one again, then it doubles.
    expect(waits.slice(0, 5)).toEqual([30_000, 30_000, 60_000, 120_000, 240_000]);
    expect(waits.at(-1)).toBe(CODE_GRAPH_FORWARD_MAX_WAIT_MS);
  });

  it('past 24 h from the memoized start it throws CodeGraphForwardTimedOutError instead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
    stubMotirAi('transport');
    const run = passDriver(RETIRE);
    expect((await run.pass()).kind).toBe('deferred');
    vi.setSystemTime(Date.now() + CODE_GRAPH_FORWARD_DEADLINE_MS - 1);
    expect((await run.pass()).kind).toBe('deferred');
    vi.setSystemTime(Date.now() + 1);
    const error = await run.pass().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeGraphForwardTimedOutError);
    expect((error as Error).message).toContain(`retire for ${REPO} feature-x`);
    expect(run.memo.get('forward-started-v1')).toEqual({ startedAt: '2026-11-22T00:00:00.000Z' });
  });

  it('a deferred pass re-sends the request, and the next answer ends the run', async () => {
    const requests = stubMotirAi('transport', settled('stale'));
    const run = passDriver(OPEN);
    expect((await run.pass()).kind).toBe('deferred');
    expect(await run.pass()).toEqual({
      kind: 'done',
      result: { kind: 'pull_request_state', outcome: 'stale' },
    });
    expect(requests).toHaveLength(2);
  });

  it('two forwards of one branch, in either order, each send their own reportedAt unchanged', async () => {
    const closed: CodeGraphForwardData = {
      ...OPEN,
      state: 'merged',
      mergedAt: '2026-11-22T11:00:00Z',
      reportedAt: '2026-11-22T11:00:00Z',
    };
    for (const order of [
      [OPEN, closed],
      [closed, OPEN],
    ]) {
      const requests = stubMotirAi(settled('recorded'));
      for (const event of order) await passDriver(event).pass();
      expect(requests.map((r) => (r.body as { reportedAt: string }).reportedAt)).toEqual(
        order.map((e) => (e as { reportedAt: string }).reportedAt),
      );
      expect(requests[order.indexOf(closed)]!.body).toEqual({
        coreOrganizationId: ORG,
        repoRef: REPO,
        ref: 'feature-x',
        pullRequestNumber: 7,
        state: 'merged',
        mergedAt: '2026-11-22T11:00:00Z',
        reportedAt: '2026-11-22T11:00:00Z',
      });
    }
  });

  it('a 401 and an unset MOTIR_AI_URL throw out of the pass, never settle', async () => {
    stubMotirAi(problem('token_invalid', 401));
    await expect(passDriver(OPEN).pass()).rejects.toBeInstanceOf(MotirAiUnauthorizedError);
    vi.stubEnv('MOTIR_AI_URL', '');
    await expect(passDriver(RETIRE).pass()).rejects.toBeInstanceOf(MotirAiConfigError);
  });
});

// ── an open report waits for its branch (MOTIR-12299) ──────────────────────────

/**
 * motir-codegraph's pull-request-state rule, faked behind motir-ai: a report is
 * recorded only on a branch the repository holds (`ref_heads`), newest `reportedAt`
 * per pull request wins, and anything else answers `unknown_ref` and writes nothing —
 * `upsertPullRequestState` in motir-codegraph's `src/db/pullRequestState.ts`.
 */
function fakeCodeGraph() {
  const refHeads = new Set<string>();
  const refPullRequests = new Map<
    string,
    { refName: string; pullRequestNumber: number; state: string; reportedAt: string }
  >();
  const requests: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        ref: string;
        pullRequestNumber: number;
        state: string;
        reportedAt: string;
      };
      requests.push(body);
      let outcome: string;
      if (!refHeads.has(body.ref)) {
        outcome = 'unknown_ref';
      } else {
        const key = `${body.ref}#${String(body.pullRequestNumber)}`;
        const stored = refPullRequests.get(key);
        if (stored && Date.parse(stored.reportedAt) >= Date.parse(body.reportedAt)) {
          outcome = 'stale';
        } else {
          refPullRequests.set(key, {
            refName: body.ref,
            pullRequestNumber: body.pullRequestNumber,
            state: body.state,
            reportedAt: body.reportedAt,
          });
          outcome = 'recorded';
        }
      }
      return new Response(JSON.stringify({ ref: body.ref, outcome }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return {
    requests,
    refPullRequests,
    /** The branch's head publishes: `ref_heads` gains its row. */
    publish: (ref: string) => refHeads.add(ref),
  };
}

describe('an open report answered unknown_ref waits for the branch to be indexed', () => {
  it('sent before the head publishes, it defers refunded and records ONE open row once the head is indexed', async () => {
    const codegraph = fakeCodeGraph();
    await enqueueCodeGraphForward(OPEN);
    const w = worker();
    for (let pass = 1; pass <= 3; pass += 1) {
      const before = Date.now();
      const row = await onePass(w);
      expect(row.state, `pass ${pass}`).toBe('pending');
      // Waiting for a branch is not a failure: the attempt is refunded.
      expect(row.attempts, `pass ${pass}`).toBe(0);
      const wait = row.runAt.getTime() - before;
      expect(wait).toBeGreaterThanOrEqual(CODE_GRAPH_FORWARD_MIN_WAIT_MS - 1_000);
      expect(wait).toBeLessThanOrEqual(CODE_GRAPH_FORWARD_MAX_WAIT_MS + 1_000);
    }
    expect(codegraph.refPullRequests.size).toBe(0);

    codegraph.publish('feature-x');
    const row = await onePass(w);
    expect(row.state).toBe('succeeded');
    expect([...codegraph.refPullRequests.values()]).toEqual([
      {
        refName: 'feature-x',
        pullRequestNumber: 7,
        state: 'open',
        reportedAt: '2026-11-22T10:00:00Z',
      },
    ]);
    // Four sends of one identical body: nothing replayed the first answer.
    expect(codegraph.requests).toHaveLength(4);
    expect(new Set(codegraph.requests.map((r) => JSON.stringify(r))).size).toBe(1);
    const runs = await ledger();
    expect(runs.at(-1)!.output).toEqual({ kind: 'pull_request_state', outcome: 'recorded' });
    expect(runs.some((r) => r.status === 'failed')).toBe(false);
  });

  it('a closed report answered unknown_ref is sent once and settled, even while an open one waits', async () => {
    const codegraph = fakeCodeGraph();
    const closedRun = passDriver(CLOSED);
    expect(await closedRun.pass()).toEqual({
      kind: 'done',
      result: { kind: 'pull_request_state', outcome: 'unknown_ref' },
    });
    expect((await passDriver(OPEN).pass()).kind).toBe('deferred');
    expect(codegraph.requests).toHaveLength(2);
  });

  it('waits on the same growing back-off as an outage', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
    stubMotirAi(settled('unknown_ref'));
    const run = passDriver(OPEN);
    const waits: number[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      const out = await run.pass();
      expect(out.kind).toBe('deferred');
      const defer = (out as { defer: JobRunDefer }).defer;
      expect(defer.reason).toContain('not indexed yet');
      waits.push(defer.resumeAt.getTime() - Date.now());
      vi.setSystemTime(defer.resumeAt);
    }
    expect(waits).toEqual([30_000, 30_000, 60_000, 120_000, 240_000]);
  });

  it('an unknown_ref then an outage then stale: the outage defers as before and stale ends the run', async () => {
    const requests = stubMotirAi(settled('unknown_ref'), 'transport', settled('stale'));
    const run = passDriver(OPEN);
    expect((await run.pass()).kind).toBe('deferred');
    expect((await run.pass()).kind).toBe('deferred');
    expect(await run.pass()).toEqual({
      kind: 'done',
      result: { kind: 'pull_request_state', outcome: 'stale' },
    });
    expect(requests).toHaveLength(3);
  });

  it('a branch never indexed settles unknown_ref at the 24 h deadline, with a warning, never failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
    stubMotirAi(settled('unknown_ref'));
    const run = passDriver(OPEN);
    expect((await run.pass()).kind).toBe('deferred');
    vi.setSystemTime(Date.now() + CODE_GRAPH_FORWARD_DEADLINE_MS - 1);
    expect((await run.pass()).kind).toBe('deferred');
    expect(console.warn).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    expect(await run.pass()).toEqual({
      kind: 'done',
      result: { kind: 'pull_request_state', outcome: 'unknown_ref' },
    });
    expect(console.warn).toHaveBeenCalledWith(
      `[code-graph-forward] ${REPO} feature-x was never indexed within 24 hours; pull request #7 stays unrecorded as open`,
    );
  });
});
