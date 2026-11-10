import { describe, expect, it } from 'vitest';
import {
  REPORTER_EVENT_LIMIT_WARNING,
  REPORTER_EVENT_REFUSED_WARNING,
  REPORTER_OFFLINE_WARNING,
  REPORTER_QUEUE_LIMIT,
  REPORTER_RETRY_DELAYS_MS,
  classifyReportingFailure,
  createDispatchRunReporter,
  nullDispatchRunReporter,
  type DispatchRunReporterDeps,
} from '../src/dispatchRunReporter.js';
import type {
  DispatchRunAppended,
  DispatchRunEventInput,
  DispatchRunOpened,
  MotirClient,
} from '../src/client.js';
import {
  ApiRefusalError,
  AuthError,
  CliError,
  DispatchRunClosedError,
  IncompatibleServerError,
  NetworkError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ResponseShapeError,
  ServerFailureError,
} from '../src/errors.js';

// The DISPATCH RUN REPORTER (Story MOTIR-1789 · MOTIR-1794).
//
// ⚠️ THE CENTRAL CLAIM IS A NEGATIVE — that nothing here can break a run — and a
// negative is not checkable by reading the code, because a `try` that catches
// the wrong thing looks exactly like one that catches everything. So every
// method is driven against a client that FAILS, and asserted to resolve.
//
// The second claim is about what does NOT leave the machine. A BYOK run executes
// against a checkout Motir has never seen; with the opt-in off, no `body` may
// reach the wire. That is asserted by INSPECTING THE PAYLOADS the fake client
// received — never by reading the source, which is the check that would still
// pass if a later call site added a body of its own.

interface Recorded {
  opens: Array<Parameters<MotirClient['openDispatchRun']>[0]>;
  appends: Array<Parameters<MotirClient['appendDispatchRunEvents']>[0]>;
  closes: Array<Parameters<MotirClient['closeDispatchRun']>[0]>;
}

function fakeClient(over: Partial<DispatchRunReporterDeps['client']> = {}): {
  client: DispatchRunReporterDeps['client'];
  recorded: Recorded;
} {
  const recorded: Recorded = { opens: [], appends: [], closes: [] };
  const client: DispatchRunReporterDeps['client'] = {
    async openDispatchRun(args): Promise<DispatchRunOpened> {
      recorded.opens.push(args);
      return {
        runId: 'run_1',
        created: recorded.opens.length === 1,
        status: 'running',
        seq: 0,
        cards: args.cards.map((c) => ({ key: c.key, disposition: c.disposition })),
      };
    },
    async appendDispatchRunEvents(args): Promise<DispatchRunAppended> {
      recorded.appends.push(args);
      return { runId: args.runId, appended: args.events.length, seq: args.events.length };
    },
    async closeDispatchRun(args): Promise<void> {
      recorded.closes.push(args);
    },
    ...over,
  };
  return { client, recorded };
}

const OPEN = {
  projectKey: 'PROD',
  command: 'run_scope' as const,
  runId: '20260829-120000',
  cards: [{ key: 'PROD-1', disposition: 'queued' as const }],
};

describe('the reporter carries the run id it was given', () => {
  it('sends `runIdFromDate`’s id as the idempotency key — never a second identity', async () => {
    const { client, recorded } = fakeClient();
    const reporter = createDispatchRunReporter({ client });

    await reporter.open(OPEN);

    // ⚠️ THE SAME STRING the session branch is derived from and the session
    // pull-request body prints. A second id minted here would be a second answer
    // to "which run was this?" — and the branch a reviewer merges would name a
    // run the page does not have.
    expect(recorded.opens[0]?.idempotencyKey).toBe('20260829-120000');
    expect(reporter.runId).toBe('run_1');
  });

  it('opens ONCE — a second open on the same reporter is ignored', async () => {
    const { client, recorded } = fakeClient();
    const reporter = createDispatchRunReporter({ client });

    await reporter.open(OPEN);
    await reporter.open({ ...OPEN, cards: [{ key: 'PROD-9', disposition: 'queued' }] });

    expect(recorded.opens).toHaveLength(1);
  });

  it('appends a leg by RE-ISSUING the idempotent open — never through an event', async () => {
    const { client, recorded } = fakeClient();
    const reporter = createDispatchRunReporter({ client });

    await reporter.open({ ...OPEN, command: 'auto', cards: [] });
    await reporter.addCard({ key: 'PROD-7', disposition: 'queued' });

    // The open is the ONLY operation that takes a card set: the set IS the plan
    // the run published, and an event may never add a card to it. The second
    // open carries the SAME key, which is what makes it a leg rather than a
    // second run.
    expect(recorded.opens).toHaveLength(2);
    expect(recorded.opens[1]).toMatchObject({
      idempotencyKey: '20260829-120000',
      cards: [{ key: 'PROD-7', disposition: 'queued' }],
    });
    expect(recorded.appends).toHaveLength(0);
  });
});

describe('the opt-in gates every log BODY', () => {
  it('STRIPS the body by default — nothing from the machine reaches the wire', async () => {
    const { client, recorded } = fakeClient();
    const reporter = createDispatchRunReporter({ client });

    await reporter.open(OPEN);
    reporter.event({ kind: 'log', workItemKey: 'PROD-1', body: '/Users/yue/secret.ts:12 …' });
    reporter.event({ kind: 'agent_exited', workItemKey: 'PROD-1', exitCode: 0 });
    await reporter.flush();

    const sent = recorded.appends.flatMap((a) => a.events);
    // ⚠️ ASSERTED OVER THE PAYLOAD, not over the source. The stripping happens in
    // ONE place precisely because there are dozens of call sites and a site that
    // forgot would leak — so the check has to be on what left, not on who sent.
    expect(sent).toHaveLength(2);
    expect(sent.every((e) => e.body === undefined)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain('secret.ts');
    // The lifecycle itself still goes — that is the whole point of the split.
    expect(sent.map((e) => e.kind)).toEqual(['log', 'agent_exited']);
  });

  it('sends the body when the operator asked for it', async () => {
    const { client, recorded } = fakeClient();
    const reporter = createDispatchRunReporter({ client, reportLogBodies: true });

    await reporter.open(OPEN);
    reporter.event({ kind: 'log', workItemKey: 'PROD-1', body: 'the tail' });
    await reporter.flush();

    expect(recorded.appends[0]?.events[0]?.body).toBe('the tail');
  });
});

describe('nothing here can break a run', () => {
  const boom = (): never => {
    throw new Error('500 Internal Server Error');
  };

  it('resolves through a failing OPEN, APPEND and CLOSE', async () => {
    const warnings: string[] = [];
    const reporter = createDispatchRunReporter({
      client: {
        openDispatchRun: boom,
        appendDispatchRunEvents: boom,
        closeDispatchRun: boom,
      },
      warn: (m) => warnings.push(m),
    });

    // Every one of these RESOLVES. Not "throws a handled error" — resolves, so
    // no caller is ever asked to handle a reporting failure, and no `await` in a
    // dispatch path can reject because telemetry did.
    await expect(reporter.open(OPEN)).resolves.toBeUndefined();
    expect(() => reporter.event({ kind: 'run_opened' })).not.toThrow();
    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(reporter.close('completed')).resolves.toBeUndefined();
    await expect(
      reporter.addCard({ key: 'PROD-2', disposition: 'queued' }),
    ).resolves.toBeUndefined();

    expect(reporter.offline).toBe(true);
  });

  it('resolves when the server is UNREACHABLE, not merely erroring', async () => {
    const unreachable = (): never => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:3000');
      (err as { code?: string }).code = 'ECONNREFUSED';
      throw err;
    };
    const reporter = createDispatchRunReporter({
      client: {
        openDispatchRun: unreachable,
        appendDispatchRunEvents: unreachable,
        closeDispatchRun: unreachable,
      },
      warn: () => {},
    });

    await expect(reporter.open(OPEN)).resolves.toBeUndefined();
    await expect(reporter.close('drained')).resolves.toBeUndefined();
  });

  it('goes offline on the first DEFINITIVE failure and warns exactly ONCE per session', async () => {
    const warnings: string[] = [];
    let calls = 0;
    const reporter = createDispatchRunReporter({
      client: {
        openDispatchRun: async () => {
          calls += 1;
          throw new Error('nope');
        },
        appendDispatchRunEvents: async () => {
          calls += 1;
          throw new Error('nope');
        },
        closeDispatchRun: async () => {
          calls += 1;
          throw new Error('nope');
        },
      },
      warn: (m) => warnings.push(m),
    });

    await reporter.open(OPEN);
    for (let i = 0; i < 50; i += 1) reporter.event({ kind: 'log' });
    await reporter.flush();
    await reporter.close('completed');

    // ⚠️ ONE LINE, not fifty-two. The operator is watching their AGENT's output;
    // burying it under telemetry noise would make the feature cost them the
    // thing they actually came for, and the second failure tells them nothing
    // the first did not.
    expect(warnings).toEqual([REPORTER_OFFLINE_WARNING]);
    // …and it STOPS TRYING. One failed call, then nothing.
    expect(calls).toBe(1);
    expect(reporter.offline).toBe(true);
  });

  it('a failure mid-flush does not lose the run’s own close for the CALLER', async () => {
    // The close still resolves, which is what the dispatch path awaits.
    let appends = 0;
    const reporter = createDispatchRunReporter({
      client: {
        openDispatchRun: async () => ({
          runId: 'run_1',
          created: true,
          status: 'running',
          seq: 0,
          cards: [],
        }),
        appendDispatchRunEvents: async () => {
          appends += 1;
          throw new Error('boom');
        },
        closeDispatchRun: async () => {},
      },
      warn: () => {},
    });

    await reporter.open(OPEN);
    reporter.event({ kind: 'run_closed' });
    await expect(reporter.close('completed')).resolves.toBeUndefined();
    expect(appends).toBe(1);
  });
});

describe('the queue is BOUNDED and drops the oldest', () => {
  it('never grows past the limit, and keeps the TAIL', async () => {
    const { client, recorded } = fakeClient();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    const total = REPORTER_QUEUE_LIMIT + 25;
    for (let i = 0; i < total; i += 1) {
      reporter.event({ kind: 'log', data: { i } });
    }
    await reporter.flush();

    const sent = recorded.appends.flatMap((a) => a.events);
    // ⚠️ BOUNDED. An unbounded buffer on a machine whose network is down is a
    // leak that grows for as long as the run does — hours, on `motir auto`.
    expect(sent).toHaveLength(REPORTER_QUEUE_LIMIT);
    // ⚠️ AND IT KEPT THE TAIL. The first 25 were dropped; the LAST event is the
    // one an operator opens a run page for.
    expect((sent[0]?.data as { i: number }).i).toBe(25);
    expect((sent.at(-1)?.data as { i: number }).i).toBe(total - 1);
  });

  it('batches a flush rather than sending one request per event', async () => {
    const { client, recorded } = fakeClient();
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    for (let i = 0; i < 300; i += 1) reporter.event({ kind: 'log', data: { i } });
    await reporter.flush();

    // A chatty agent must not cost one request per line: 300 events, two calls.
    expect(recorded.appends).toHaveLength(2);
    expect(recorded.appends[0]?.events).toHaveLength(200);
    expect(recorded.appends[1]?.events).toHaveLength(100);
  });

  it('queues NOTHING before the run is open — an event with no run has nowhere to go', async () => {
    const { client, recorded } = fakeClient();
    const reporter = createDispatchRunReporter({ client });

    reporter.event({ kind: 'run_opened' });
    await reporter.flush();

    expect(recorded.appends).toHaveLength(0);
  });
});

describe('the null reporter', () => {
  it('does nothing, successfully — the default that makes wiring a no-op', async () => {
    await expect(nullDispatchRunReporter.open(OPEN)).resolves.toBeUndefined();
    await expect(nullDispatchRunReporter.flush()).resolves.toBeUndefined();
    await expect(nullDispatchRunReporter.close('completed')).resolves.toBeUndefined();
    expect(nullDispatchRunReporter.runId).toBeNull();
    expect(nullDispatchRunReporter.offline).toBe(false);
  });
});

describe('the build-through and STOP writes (MOTIR-8722)', () => {
  const POINTS = [{ planAsked: 'a', built: 'b', why: 'c' }];

  it('posts the points and the STOP on the run it holds', async () => {
    const calls: unknown[] = [];
    const { client } = fakeClient({
      async recordDispatchRunDiscrepancy(args) {
        calls.push(args);
        return { commentId: 'c1', recorded: true };
      },
      async reportDispatchRunStop(args) {
        calls.push(args);
        return { commentId: 'c2', movedToPlanning: true };
      },
    });
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    await reporter.reportDiscrepancy!('PROD-1', POINTS);
    // MOTIR-10000: the decisions ride the same call, and only when there are any.
    await reporter.reportDiscrepancy!('PROD-2', [], [{ planSaid: 'n', chose: 'c', why: 'w' }]);
    await reporter.reportStop!('PROD-1', {
      comment: 'no such table',
      toPlanning: true,
      requirement: { outcome: 'O' },
    });

    expect(calls).toEqual([
      { runId: 'run_1', key: 'PROD-1', points: POINTS },
      {
        runId: 'run_1',
        key: 'PROD-2',
        points: [],
        decisions: [{ planSaid: 'n', chose: 'c', why: 'w' }],
      },
      {
        runId: 'run_1',
        key: 'PROD-1',
        comment: 'no such table',
        toPlanning: true,
        requirement: { outcome: 'O' },
      },
    ]);
  });

  it('a failure warns once each and takes nothing down; no run held sends nothing', async () => {
    const warnings: string[] = [];
    let sent = 0;
    const { client } = fakeClient({
      async recordDispatchRunDiscrepancy() {
        sent += 1;
        throw new Error('409');
      },
      async reportDispatchRunStop() {
        sent += 1;
        throw new Error('422');
      },
    });
    const idle = createDispatchRunReporter({ client });
    await idle.reportDiscrepancy!('PROD-1', POINTS);
    await idle.reportStop!('PROD-1', { comment: 'x', toPlanning: false, requirement: null });
    expect(sent).toBe(0);

    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);
    await expect(reporter.reportDiscrepancy!('PROD-1', POINTS)).resolves.toBeUndefined();
    await expect(
      reporter.reportStop!('PROD-1', { comment: 'x', toPlanning: true, requirement: null }),
    ).resolves.toBeUndefined();
    expect(sent).toBe(2);
    expect(warnings).toEqual([
      'motir: could not record the discrepancies on PROD-1 in Motir. The run continues.',
      'motir: could not comment on PROD-1 or move it to Planning in Motir. The run continues.',
    ]);
  });
});

describe('the run-found report (MOTIR-8698)', () => {
  it('posts the stopped card and reason on the run it holds', async () => {
    const reports: Array<{ runId: string; targetKey: string; reason: string }> = [];
    const { client } = fakeClient({
      async reportDispatchRunUnbuildable(args) {
        reports.push(args);
        return { recordedOnRun: true };
      },
    });
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);

    await reporter.reportUnbuildable!('PROD-1', 'no such table');

    expect(reports).toEqual([{ runId: 'run_1', targetKey: 'PROD-1', reason: 'no such table' }]);
  });

  it('is sent even after event reporting went OFFLINE, and its own failure takes nothing down', async () => {
    const warnings: string[] = [];
    let reported = 0;
    const { client } = fakeClient({
      async appendDispatchRunEvents() {
        throw new Error('500');
      },
      async reportDispatchRunUnbuildable() {
        reported += 1;
        throw new Error('network down');
      },
    });
    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);
    reporter.event({ kind: 'card_claimed', workItemKey: 'PROD-1' });
    await reporter.flush();
    expect(reporter.offline).toBe(true);

    await expect(reporter.reportUnbuildable!('PROD-1', 'why')).resolves.toBeUndefined();
    expect(reported).toBe(1);
    expect(warnings.some((w) => w.includes('could not report PROD-1 as unbuildable'))).toBe(true);
  });

  it('sends nothing when no run is held', async () => {
    let reported = 0;
    const { client } = fakeClient({
      async reportDispatchRunUnbuildable() {
        reported += 1;
        return { recordedOnRun: true };
      },
    });
    const reporter = createDispatchRunReporter({ client });
    await reporter.reportUnbuildable!('PROD-1', 'why');
    expect(reported).toBe(0);
  });
});

// ── MOTIR-10705 — a refused or failed append no longer silences the run ─────
//
// A hosted run is ended as a STALL when its newest event is fifteen minutes old, so a
// reporter that went quiet over ONE refused batch killed a run whose agent was still
// working. These drive the reporter against a client that refuses the way the server
// does — the whole batch, typed by the transport — and assert reporting carries on.

const tooLarge = () =>
  new ApiRefusalError('An event body exceeds the limit.', 413, 'DISPATCH_RUN_BODY_TOO_LARGE');

/** A client whose append refuses any batch holding an event `bad` picks out — WHOLE, as
 *  the server refuses — and records what it accepted. */
function refusingClient(bad: (e: DispatchRunEventInput) => boolean, refusal = tooLarge) {
  const accepted: DispatchRunEventInput[] = [];
  let calls = 0;
  const { client, recorded } = fakeClient({
    async appendDispatchRunEvents(args) {
      calls += 1;
      if (args.events.some(bad)) throw refusal();
      accepted.push(...args.events);
      return { runId: args.runId, appended: args.events.length, seq: accepted.length };
    },
  });
  return { client, recorded, accepted, calls: () => calls };
}

const noSleep = async () => {};

describe('a REFUSED batch is narrowed to the event the server will not take (MOTIR-10705)', () => {
  it.each([
    ['413', tooLarge],
    ['422', () => new ApiRefusalError('Not a valid event.', 422, 'INVALID_BODY')],
  ])('after a %s the reporter keeps sending, and agent_exited still lands', async (_s, refusal) => {
    const warnings: string[] = [];
    const { client, recorded, accepted } = refusingClient((e) => e.body === 'BAD', refusal);
    const reporter = createDispatchRunReporter({
      client,
      reportLogBodies: true,
      warn: (m) => warnings.push(m),
    });
    await reporter.open(OPEN);

    reporter.event({ kind: 'log', workItemKey: 'PROD-1', body: 'first' });
    reporter.event({ kind: 'log', workItemKey: 'PROD-1', body: 'BAD' });
    reporter.event({ kind: 'log', workItemKey: 'PROD-1', body: 'third' });
    await reporter.flush();
    // LATER events — the ones a stall check reads — keep flowing.
    reporter.event({ kind: 'agent_exited', workItemKey: 'PROD-1', exitCode: 0 });
    await reporter.close('completed');

    expect(accepted.map((e) => e.body ?? e.kind)).toEqual(['first', 'third', 'agent_exited']);
    expect(reporter.offline).toBe(false);
    expect(recorded.closes).toHaveLength(1);
    // One line, once — not per dropped event.
    expect(warnings).toEqual([REPORTER_EVENT_REFUSED_WARNING]);
  });

  it('bisects a full batch: one bad event among 200 costs a handful of requests, not 200', async () => {
    const { client, accepted, calls } = refusingClient((e) => e.body === 'BAD');
    const reporter = createDispatchRunReporter({ client, reportLogBodies: true, warn: () => {} });
    await reporter.open(OPEN);
    for (let i = 0; i < 200; i += 1) {
      reporter.event({ kind: 'log', body: i === 137 ? 'BAD' : `line ${i}` });
    }
    await reporter.flush();

    expect(accepted).toHaveLength(199);
    expect(accepted.map((e) => e.body)).not.toContain('BAD');
    // Order is kept: the halves are sent first-half first.
    expect(accepted[136]?.body).toBe('line 136');
    expect(accepted[137]?.body).toBe('line 138');
    expect(calls()).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(200)) + 1);
  });

  it('every event refused drops them all, still warns once, and stays online', async () => {
    const warnings: string[] = [];
    const { client, accepted } = refusingClient(() => true);
    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);
    for (let i = 0; i < 5; i += 1) reporter.event({ kind: 'log' });
    await reporter.flush();
    expect(accepted).toEqual([]);
    expect(reporter.offline).toBe(false);
    expect(warnings).toEqual([REPORTER_EVENT_REFUSED_WARNING]);
  });
});

describe('a TRANSIENT failure is retried and never stops reporting (MOTIR-10705)', () => {
  it.each([
    ['a 5xx', () => new ServerFailureError('The Motir server failed (503).', 503)],
    ['a network failure', () => new NetworkError('Could not reach http://x: fetch failed.')],
    ['an exhausted rate-limit wait', () => new RateLimitError(undefined)],
  ])('%s is retried on the backoff schedule, and the batch lands', async (_name, failure) => {
    const waits: number[] = [];
    let failures = 2;
    const { client, recorded } = fakeClient();
    const append = client.appendDispatchRunEvents.bind(client);
    client.appendDispatchRunEvents = async (args) => {
      if (failures > 0) {
        failures -= 1;
        throw failure();
      }
      return append(args);
    };
    const reporter = createDispatchRunReporter({
      client,
      warn: () => {},
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await reporter.open(OPEN);
    reporter.event({ kind: 'card_claimed', workItemKey: 'PROD-1' });
    await reporter.flush();

    expect(waits).toEqual(REPORTER_RETRY_DELAYS_MS.slice(0, 2));
    expect(recorded.appends.flatMap((a) => a.events.map((e) => e.kind))).toEqual(['card_claimed']);
    expect(reporter.offline).toBe(false);
  });

  it('without an injected sleep it waits on a REAL timer between retries', async () => {
    let failures = 1;
    const { client, recorded } = fakeClient();
    const append = client.appendDispatchRunEvents.bind(client);
    client.appendDispatchRunEvents = async (args) => {
      if (failures-- > 0) throw new NetworkError('Could not reach http://x: ECONNRESET.');
      return append(args);
    };
    const reporter = createDispatchRunReporter({ client, warn: () => {}, retryDelaysMs: [5] });
    await reporter.open(OPEN);
    reporter.event({ kind: 'log' });
    const started = Date.now();
    await reporter.flush();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    expect(recorded.appends).toHaveLength(1);
  });

  it('a failure that outlasts the retries is KEPT for the next flush, never dropped', async () => {
    let down = true;
    const { client, recorded } = fakeClient();
    const append = client.appendDispatchRunEvents.bind(client);
    client.appendDispatchRunEvents = async (args) => {
      if (down) throw new ServerFailureError('The Motir server failed (502).', 502);
      return append(args);
    };
    const waits: number[] = [];
    const reporter = createDispatchRunReporter({
      client,
      warn: () => {},
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await reporter.open(OPEN);
    reporter.event({ kind: 'log', data: { i: 0 } });
    reporter.event({ kind: 'log', data: { i: 1 } });
    await reporter.flush();
    expect(waits).toEqual([...REPORTER_RETRY_DELAYS_MS]);
    expect(recorded.appends).toHaveLength(0);

    down = false;
    reporter.event({ kind: 'log', data: { i: 2 } });
    await reporter.flush();
    expect(
      recorded.appends.flatMap((a) => a.events.map((e) => (e.data as { i: number }).i)),
    ).toEqual([0, 1, 2]);
    expect(reporter.offline).toBe(false);
  });

  it('a batch put back keeps the queue bound, dropping the OLDEST', async () => {
    let down = true;
    let reporterRef: ReturnType<typeof createDispatchRunReporter> | null = null;
    const { client, recorded } = fakeClient();
    const append = client.appendDispatchRunEvents.bind(client);
    client.appendDispatchRunEvents = async (args) => {
      if (down) {
        // More output arrives while the request is failing.
        for (let i = 0; i < 100; i += 1) reporterRef!.event({ kind: 'log', data: { i: 1000 + i } });
        throw new NetworkError('Could not reach http://x: ECONNRESET.');
      }
      return append(args);
    };
    const reporter = createDispatchRunReporter({ client, warn: () => {}, retryDelaysMs: [] });
    reporterRef = reporter;
    await reporter.open(OPEN);
    for (let i = 0; i < 450; i += 1) reporter.event({ kind: 'log', data: { i } });
    await reporter.flush();
    down = false;
    await reporter.flush();

    const sent = recorded.appends.flatMap((a) => a.events.map((e) => (e.data as { i: number }).i));
    expect(sent).toHaveLength(REPORTER_QUEUE_LIMIT);
    // 200 put back + 250 still queued + 100 new = 550: the oldest 50 went.
    expect(sent[0]).toBe(50);
    expect(sent.at(-1)).toBe(1099);
  });

  it('the open, a leg and the close are retried too', async () => {
    const failing = <T>(fn: (...a: never[]) => Promise<T>) => {
      let first = true;
      return async (...a: never[]) => {
        if (first) {
          first = false;
          throw new NetworkError('Could not reach http://x: timeout.');
        }
        return fn(...a);
      };
    };
    const { client, recorded } = fakeClient();
    client.openDispatchRun = failing(client.openDispatchRun.bind(client) as never) as never;
    client.closeDispatchRun = failing(client.closeDispatchRun.bind(client) as never) as never;
    const reporter = createDispatchRunReporter({ client, warn: () => {}, sleep: noSleep });
    await reporter.open(OPEN);
    expect(reporter.runId).toBe('run_1');
    client.openDispatchRun = failing(client.openDispatchRun.bind(client) as never) as never;
    await reporter.addCard({ key: 'PROD-2', disposition: 'queued' });
    await reporter.close('completed');
    expect(recorded.opens).toHaveLength(2);
    expect(recorded.closes).toHaveLength(1);
    expect(reporter.offline).toBe(false);
  });

  it('a transient failure of the close that persists ends quietly, without going offline', async () => {
    const { client } = fakeClient({
      async closeDispatchRun() {
        throw new ServerFailureError('The Motir server failed (500).', 500);
      },
    });
    const warnings: string[] = [];
    const reporter = createDispatchRunReporter({
      client,
      warn: (m) => warnings.push(m),
      sleep: noSleep,
    });
    await reporter.open(OPEN);
    await expect(reporter.close('completed')).resolves.toBeUndefined();
    expect(reporter.offline).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('an open that never succeeds takes the reporter offline — there is no run to report into', async () => {
    const warnings: string[] = [];
    const { client, recorded } = fakeClient({
      async openDispatchRun() {
        throw new ServerFailureError('The Motir server failed (503).', 503);
      },
    });
    const reporter = createDispatchRunReporter({
      client,
      warn: (m) => warnings.push(m),
      sleep: noSleep,
    });
    await reporter.open(OPEN);
    reporter.event({ kind: 'log' });
    await reporter.flush();
    expect(reporter.offline).toBe(true);
    expect(recorded.appends).toEqual([]);
    expect(warnings).toEqual([REPORTER_OFFLINE_WARNING]);
  });

  it('flushes asked for while one is in flight JOIN the one queued behind it', async () => {
    let release: () => void = () => {};
    let held = true;
    const { client, recorded } = fakeClient();
    const append = client.appendDispatchRunEvents.bind(client);
    client.appendDispatchRunEvents = async (args) => {
      if (held) {
        held = false;
        await new Promise<void>((r) => (release = r));
      }
      return append(args);
    };
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);
    reporter.event({ kind: 'log', data: { i: 0 } });
    const first = reporter.flush();
    await Promise.resolve();
    reporter.event({ kind: 'log', data: { i: 1 } });
    const a = reporter.flush();
    reporter.event({ kind: 'log', data: { i: 2 } });
    const b = reporter.flush();
    release();
    await Promise.all([first, a, b]);
    // Two requests, not three: the second and third flush were the same pending one.
    expect(recorded.appends.map((x) => x.events.length)).toEqual([1, 2]);
  });
});

describe('only a DEFINITIVE end takes reporting down (MOTIR-10705)', () => {
  it.each([
    ['a 401', () => new AuthError()],
    ['a 403', () => new PermissionError('dispatch:report', 'appendDispatchRunEvents')],
    ['a closed run (409)', () => new DispatchRunClosedError('Run is closed.')],
    ['another 409', () => new ApiRefusalError('Conflict.', 409, 'SOMETHING_ELSE')],
    ['a run that is gone (404)', () => new NotFoundError('No dispatch run run_1.')],
  ])('%s goes offline with the one warning, and stops trying', async (_name, failure) => {
    const warnings: string[] = [];
    let appends = 0;
    const { client } = fakeClient({
      async appendDispatchRunEvents() {
        appends += 1;
        throw failure();
      },
    });
    const reporter = createDispatchRunReporter({
      client,
      warn: (m) => warnings.push(m),
      sleep: noSleep,
    });
    await reporter.open(OPEN);
    reporter.event({ kind: 'log' });
    await reporter.flush();
    reporter.event({ kind: 'log' });
    await reporter.flush();
    expect(appends).toBe(1);
    expect(reporter.offline).toBe(true);
    expect(warnings).toEqual([REPORTER_OFFLINE_WARNING]);
  });

  it('the event CEILING stops events, but the run is still closed', async () => {
    const warnings: string[] = [];
    let appends = 0;
    const { client, recorded } = fakeClient({
      async appendDispatchRunEvents() {
        appends += 1;
        throw new ApiRefusalError('Limit reached.', 422, 'DISPATCH_RUN_EVENT_LIMIT');
      },
    });
    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);
    reporter.event({ kind: 'log' });
    await reporter.flush();
    reporter.event({ kind: 'log' });
    await reporter.flush();
    await reporter.close('completed');
    expect(appends).toBe(1);
    expect(recorded.closes).toHaveLength(1);
    expect(reporter.offline).toBe(false);
    expect(warnings).toEqual([REPORTER_EVENT_LIMIT_WARNING]);
  });

  it('a batch that would CROSS the ceiling still sends the events that fit, agent_exited among them', async () => {
    // The server refuses a batch WHOLE when it would take the run past its ceiling.
    const ceiling = 5;
    const accepted: DispatchRunEventInput[] = [];
    const warnings: string[] = [];
    const { client } = fakeClient({
      async appendDispatchRunEvents(args) {
        if (accepted.length + args.events.length > ceiling) {
          throw new ApiRefusalError('Limit reached.', 422, 'DISPATCH_RUN_EVENT_LIMIT');
        }
        accepted.push(...args.events);
        return { runId: args.runId, appended: args.events.length, seq: accepted.length };
      },
    });
    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);
    for (let i = 0; i < 4; i += 1) reporter.event({ kind: 'log', data: { i } });
    reporter.event({ kind: 'agent_exited', workItemKey: 'PROD-1', exitCode: 0 });
    reporter.event({ kind: 'card_settled', workItemKey: 'PROD-1' });
    reporter.event({ kind: 'log', data: { i: 99 } });
    await reporter.flush();

    expect(accepted.map((e) => e.kind)).toEqual(['log', 'log', 'log', 'log', 'agent_exited']);
    expect(warnings).toEqual([REPORTER_EVENT_LIMIT_WARNING]);
    expect(reporter.offline).toBe(false);
  });

  it('the ceiling met by a leg or the close caps events the same way', async () => {
    const warnings: string[] = [];
    const { client, recorded } = fakeClient();
    const open = client.openDispatchRun.bind(client);
    let opens = 0;
    client.openDispatchRun = async (args) => {
      opens += 1;
      if (opens > 1) throw new ApiRefusalError('Limit reached.', 422, 'DISPATCH_RUN_EVENT_LIMIT');
      return open(args);
    };
    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);
    await reporter.addCard({ key: 'PROD-2', disposition: 'queued' });
    reporter.event({ kind: 'log' });
    await reporter.flush();
    expect(recorded.appends).toEqual([]);
    expect(warnings).toEqual([REPORTER_EVENT_LIMIT_WARNING]);
  });

  it('a 2xx it could not read is DELIVERED — never sent again', async () => {
    let appends = 0;
    const { client } = fakeClient({
      async appendDispatchRunEvents() {
        appends += 1;
        throw new ResponseShapeError('http://x', 'appendDispatchRunEvents', 'seq', 'is required');
      },
    });
    const reporter = createDispatchRunReporter({ client, warn: () => {} });
    await reporter.open(OPEN);
    reporter.event({ kind: 'log' });
    reporter.event({ kind: 'log' });
    await reporter.flush();
    expect(appends).toBe(1);
    expect(reporter.offline).toBe(false);
  });
});

describe('classifyReportingFailure', () => {
  it.each([
    [new ApiRefusalError('x', 413, 'DISPATCH_RUN_BODY_TOO_LARGE'), 'refused'],
    [new ApiRefusalError('x', 422, 'INVALID_BODY'), 'refused'],
    [new ApiRefusalError('x', 400, null), 'refused'],
    [new ApiRefusalError('x', 422, 'DISPATCH_RUN_EVENT_LIMIT'), 'capped'],
    [new ApiRefusalError('x', 409, null), 'end'],
    [new ServerFailureError('x', 500), 'transient'],
    [new NetworkError('x'), 'transient'],
    [new RateLimitError(undefined), 'transient'],
    [new ResponseShapeError('u', 'op', 'f', 'd'), 'delivered'],
    [new AuthError(), 'end'],
    [new PermissionError('p', 'op'), 'end'],
    [new DispatchRunClosedError('x'), 'end'],
    [new NotFoundError('x'), 'end'],
    [new IncompatibleServerError('x', 'h'), 'end'],
    [new CliError('x'), 'end'],
    [new Error('not from the transport'), 'end'],
    ['a string', 'end'],
  ] as const)('%o → %s', (err, expected) => {
    expect(classifyReportingFailure(err)).toBe(expected);
  });
});

describe('the How to test a tool-less agent wrote (MOTIR-10877)', () => {
  const BODY = { bodyMd: '## Locally', repos: [{ repo: 'acme/web', commitSha: 'abc1234' }] };

  it('publishes it on the run it holds and answers true', async () => {
    const calls: unknown[] = [];
    const { client } = fakeClient({
      async publishDispatchRunHowToTest(args) {
        calls.push(args);
        return { testInstructionsId: 'ti_1', created: true };
      },
    });
    const reporter = createDispatchRunReporter({ client });
    await reporter.open(OPEN);
    await expect(reporter.publishHowToTest!('PROD-1', BODY)).resolves.toBe(true);
    expect(calls).toEqual([{ runId: 'run_1', key: 'PROD-1', ...BODY }]);
  });

  it('answers false — and sends nothing — with no run held, after the close, or with no door', async () => {
    let sent = 0;
    const { client } = fakeClient({
      async publishDispatchRunHowToTest() {
        sent += 1;
        return { testInstructionsId: 'ti_1', created: true };
      },
    });
    const idle = createDispatchRunReporter({ client });
    await expect(idle.publishHowToTest!('PROD-1', BODY)).resolves.toBe(false);

    const closed = createDispatchRunReporter({ client });
    await closed.open(OPEN);
    await closed.close('completed');
    await expect(closed.publishHowToTest!('PROD-1', BODY)).resolves.toBe(false);
    expect(sent).toBe(0);

    const { client: older } = fakeClient({});
    const withoutDoor = createDispatchRunReporter({ client: older });
    await withoutDoor.open(OPEN);
    await expect(withoutDoor.publishHowToTest!('PROD-1', BODY)).resolves.toBe(false);
  });

  it('a refused publish warns, naming why, answers false, and takes nothing down', async () => {
    const warnings: string[] = [];
    const { client } = fakeClient({
      async publishDispatchRunHowToTest() {
        throw new Error('the repository is not connected');
      },
    });
    const reporter = createDispatchRunReporter({ client, warn: (m) => warnings.push(m) });
    await reporter.open(OPEN);
    await expect(reporter.publishHowToTest!('PROD-1', BODY)).resolves.toBe(false);
    expect(warnings).toEqual([
      'motir: could not publish How to test on PROD-1 in Motir (the repository is not connected). The run continues.',
    ]);
    expect(reporter.offline).toBe(false);
  });
});
