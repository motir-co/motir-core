import { vi } from 'vitest';
import * as jobDispatcher from '@/lib/jobs/engine/dispatcher';
import { jobServices } from '@/lib/jobs/services';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { jobRunsService } from '@/lib/services/jobRunsService';
import type { EngineJobDefinition, JobContext } from '@/lib/jobs/defineJob';
import { emailSend } from '@/lib/jobs/definitions/emailSend';
import type { EmailSendData } from '@/lib/jobs/types';
import { adminDb } from './adminDb';

// Test helpers for the background-job path (Story 1.6 · Subtask 1.6.3;
// re-based off the retired vendor SDK by Story MOTIR-3418).
//
// ⚠️ WHAT CHANGED, AND WHY THE CALL SITES DID NOT. These helpers used to reach
// for two vendor surfaces: `inngest.send` (spied, both to stop a publish reaching
// the network and to capture what was published) and `InngestTestEngine` (to
// invoke a job handler in-process). Neither exists now. Their replacements sit at
// the SAME two seams — the engine's dispatcher and the engine's own handler
// contract — and keep the same shapes, so the call sites across the suite change
// by a name and nothing else.
//
// ⚠️ AND THE STOP-IT-REACHING-THE-NETWORK HALF IS NO LONGER NEEDED AT ALL, which
// is why `tests/helpers/inngestSetup.ts` is gone rather than replaced. That file
// existed because a real `inngest.send` THREW in the test environment ("we
// couldn't find an event key"), so without a suite-wide no-op every create and
// update in the suite would have failed. Emitting now writes a `job_event` +
// `job_queue` row to the worker's own test database, which every test already
// has — so the UNSTUBBED path is both the faithful one and the working one.
// (Measured on `tests/workflows/transition-validation.test.ts`: 10 passed in
// 11.1 s unstubbed, against 20.9 s and 3 failures with a dispatch stub in place.)
// What these helpers still do is CAPTURE, and they swallow the enqueue for the
// same reason the old spy did: a test asserting on emitted events is not
// asserting on queue rows.

export interface CapturedEmailEvent {
  name: 'email.send';
  data: EmailSendData;
}

/** The dispatcher's own empty result — what a swallowed enqueue returns. */
const NO_DISPATCH = {
  eventId: null,
  enqueued: [],
  alreadyEnqueued: [],
  coalesced: [],
  failed: [],
};

/**
 * A bare spy on the emit seam, swallowing the enqueue — the direct replacement
 * for `vi.spyOn(inngest, 'send')` in the suites that assert on the spy itself
 * rather than on a collected list.
 *
 * ⚠️ THE RECORDED CALL SHAPE IS `(name, data, opts)`, NOT `({ name, data })`.
 * The vendor client took ONE envelope argument; the engine's dispatcher takes the
 * name and the payload separately. {@link dispatchedEvents} re-assembles the
 * envelope for a reader that wants it, and is what the migrated assertions use.
 */
export function spyOnJobDispatch() {
  return vi
    .spyOn(jobDispatcher, 'dispatchEventToEngine')
    .mockImplementation(async () => ({ ...NO_DISPATCH }));
}

/** The `{ name, data }` envelopes a dispatch spy recorded, in call order. */
export function dispatchedEvents(spy: { mock: { calls: unknown[][] } }): CapturedJobEvent[] {
  return spy.mock.calls.map((call) => ({ name: call[0] as string, data: call[1] }));
}

/**
 * Collect the `email.send` events `sendEvent()` emits, and swallow the enqueue.
 * Returns the live array (mutated as events arrive) plus a `restore()`. Install
 * in a `beforeEach`; call `restore()` in the matching `afterEach`.
 */
export function captureEmailEvents(): { events: CapturedEmailEvent[]; restore: () => void } {
  const events: CapturedEmailEvent[] = [];
  const spy = vi
    .spyOn(jobDispatcher, 'dispatchEventToEngine')
    .mockImplementation(async (name: string, data: unknown) => {
      if (name === 'email.send' && data) {
        events.push({ name: 'email.send', data: data as EmailSendData });
      }
      return { ...NO_DISPATCH };
    });
  return { events, restore: () => spy.mockRestore() };
}

/** Any event emitted through the job seam — name + raw payload. */
export interface CapturedJobEvent {
  name: string;
  data: unknown;
}

/**
 * Like {@link captureEmailEvents}, but collects EVERY event `sendEvent()` emits
 * — the 5.4.5 emit-seam assertions read `work-item/transitioned` off the same
 * spy that swallows the enqueue.
 */
export function captureJobEvents(): { events: CapturedJobEvent[]; restore: () => void } {
  const events: CapturedJobEvent[] = [];
  const spy = vi
    .spyOn(jobDispatcher, 'dispatchEventToEngine')
    .mockImplementation(async (name: string, data: unknown) => {
      events.push({ name, data });
      return { ...NO_DISPATCH };
    });
  return { events, restore: () => spy.mockRestore() };
}

/**
 * Collect the PAYLOADS of one named event, and swallow the enqueue — the
 * single-event sibling of {@link captureJobEvents}, for the several suites that
 * assert on exactly one event type and want its data unwrapped.
 */
export function captureEventPayloads<T>(name: string): { events: T[]; restore: () => void } {
  const events: T[] = [];
  const spy = vi
    .spyOn(jobDispatcher, 'dispatchEventToEngine')
    .mockImplementation(async (emitted: string, data: unknown) => {
      if (emitted === name && data) events.push(data as T);
      return { ...NO_DISPATCH };
    });
  return { events, restore: () => spy.mockRestore() };
}

/**
 * THE IN-PROCESS JOB HARNESS — the replacement for `@inngest/test`'s
 * `InngestTestEngine`, with the same constructor and the same `execute()` shape
 * so a spec that drove one drives this instead by changing the class name.
 *
 * ⚠️ ITS `step` IS IN-MEMORY, AND THAT IS THE FAITHFUL CHOICE HERE. The shipped
 * shim (`lib/jobs/engine/step.ts`) memoizes through the `job_step` table, which
 * needs a claimed `job_queue` row to key against — i.e. the whole worker loop. A
 * unit test driving ONE handler has no such row, and the vendor harness this
 * replaces did not have one either: it executed each step and remembered the
 * result for the length of the invocation. So does this. A spec that needs the
 * DURABLE semantics (a memo surviving a retry, a `sleep` that yields and
 * re-enqueues) is testing the ENGINE rather than a handler, and belongs in
 * `tests/jobs/engine-*.test.ts` against the real runner.
 *
 * `sleep` resolves immediately for the same reason: the real shim throws
 * `JobStepYield` so the worker can re-enqueue the run, and there is no worker
 * here to catch it. A supervisor under this harness therefore runs its loop
 * without waiting, which is what the specs driving one already assume.
 *
 * ⚠️ IT DOES WRITE THE `job_run` LEDGER, and that is not a convenience. Roughly
 * eighty assertions across the job suites read the row back — the `functionId`,
 * the synthesized `scheduled.<id>` event name, the `output` column carrying a
 * sweep's summary — because the ledger is the operator surface and asserting it
 * from the same run that produced it is what makes those tests about the shipped
 * behaviour rather than about the harness. The vendor harness got the rows for
 * free: the bookkeeping lived inside the function `defineJob` built, so invoking
 * the function wrote them. It lives in `lib/jobs/engine/ledger.ts` now, around a
 * CLAIMED run — which this harness has no way to produce — so the same two calls
 * are made here, in the same order, with the same `lane`.
 *
 * ⚠️ AND A THROW LEAVES THE ROW `running`, DELIBERATELY. The terminal-failure
 * hook is the WORKER's, fired when `attempts` reaches `maxAttempts`; a
 * single-invocation harness has no retry budget to exhaust, so writing a `failed`
 * row here would assert a transition this run cannot have made.
 * `tests/jobs/dlq.test.ts` asserts exactly that shape — a failing attempt leaves
 * the row `running` and writes no DLQ — and it is the in-flight state the
 * dashboard shows for a retrying run.
 */
export interface JobTestEngineOptions {
  function: EngineJobDefinition;
  events?: Array<{ name: string; data?: unknown }>;
  /**
   * PRE-FULFILLED steps — a step id whose result is already known, as if a
   * previous attempt had completed it. The handler's `step.run` returns the value
   * without executing, which is exactly what a `job_step` memo does on a resume.
   * It is how the supervisor suites drive the RESUME path without a worker.
   */
  steps?: Array<{ id: string; handler: () => unknown }>;
  /**
   * The ZERO-INDEXED attempt the handler is told it is on (default 0). A job whose
   * FINAL attempt does something before it throws — records a terminal failure where
   * a person looks — is driven to that attempt with this.
   */
  attempt?: number;
}

/**
 * ⚠️ `step.run` AND `step.sleep` ARE `vi.fn()`s, and that is a contract several
 * suites read. The vendor harness handed back a MOCKED `ctx`, so a spec could
 * assert the STEP IDS a run passed through (`tests/helpers/indexFleet.ts`'s
 * `indexStepIds` reads `ctx.step.run.mock.calls`) — which is how the supervisor
 * suites assert the SHAPE of a run rather than only its result. Keeping the spy
 * wrapper keeps those assertions meaning what they meant.
 */
export interface JobTestEngineContext extends Omit<JobContext, 'step'> {
  step: {
    run: ReturnType<typeof vi.fn>;
    sleep: ReturnType<typeof vi.fn>;
  };
}

export interface JobTestEngineOutcome {
  result?: unknown;
  error?: Error;
  /** The context the run executed against — its `step` members are spies. */
  ctx: JobTestEngineContext;
}

export class JobTestEngine {
  constructor(private readonly opts: JobTestEngineOptions) {}

  /**
   * Invoke the handler once. `overrides` matches the constructor's options, so a
   * spec can build the engine once and drive it with different events — the
   * shape the vendor harness offered and several suites use.
   */
  async execute(overrides?: Partial<JobTestEngineOptions>): Promise<JobTestEngineOutcome> {
    const def = overrides?.function ?? this.opts.function;
    const event = (overrides?.events ?? this.opts.events)?.[0];
    const memo = new Map<string, unknown>();
    for (const seeded of overrides?.steps ?? this.opts.steps ?? []) {
      memo.set(seeded.id, seeded.handler());
    }
    const run = vi.fn(async (id: string, fn: () => unknown) => {
      if (memo.has(id)) return memo.get(id);
      const value = await fn();
      memo.set(id, value);
      return value;
    });
    // No worker to re-enqueue into — see the class header.
    const sleep = vi.fn(async () => undefined);
    const ctx = {
      event: {
        name: event?.name ?? (def.cron !== undefined ? `scheduled.${def.id}` : def.id),
        data: event?.data ?? {},
        id: `test-event-${def.id}`,
      },
      step: { run, sleep },
      runId: `test-run-${def.id}`,
      attempt: overrides?.attempt ?? this.opts.attempt ?? 0,
    } as unknown as JobTestEngineContext;
    const data = (ctx.event.data ?? {}) as {
      workspaceId?: string | null;
      idempotencyKey?: string;
    };
    const jobRun = await run('job-run:start', () =>
      jobRunsService.recordStart({
        workspaceId: data.workspaceId ?? null,
        functionId: def.id,
        eventName: ctx.event.name,
        eventId: ctx.event.id ?? ctx.runId,
        lane: 'engine',
        attempt: ctx.attempt,
        idempotencyKey: data.idempotencyKey ?? null,
      }),
    );

    try {
      const result = await this.driveToCompletion(def, ctx);
      // `recordStart` returns null when the run's tenant vanished before the row
      // could be written (MOTIR-1545) — the same guard the real ledger carries.
      if (jobRun) {
        await run('job-run:succeeded', () =>
          jobRunsService.recordSuccess(
            (jobRun as { id: string }).id,
            serializeOutput(result) as never,
          ),
        );
      }
      return { result, ctx };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)), ctx };
    }
  }

  /**
   * Invoke the handler, and KEEP invoking it while it DEFERS (MOTIR-3828).
   *
   * ⚠️ THIS IS THE HARNESS'S MODEL OF THE ENGINE, not a convenience. A
   * self-rescheduling supervision does one poll per RUN and throws
   * `JobRunDefer`, which the worker turns into `rescheduleAt(…, { refundAttempt:
   * true })` and a later claim re-invokes the handler FROM THE TOP against the
   * same `job_step` rows. This loop is exactly that, minus the queue: the same
   * `ctx`, so the same memo, re-entered until the handler returns.
   *
   * ⚠️ IT DOES NOT SLEEP, and a job-level suite must not read that as the
   * cadence being tested. `resumeAt` is ignored here — what a pass is owed
   * between polls is asserted BY VALUE against the fleet budgets, and end to end
   * against a real worker in the story gate. What this harness is for is the
   * SHAPE and the LEDGER.
   *
   * The pass ceiling is a runaway guard: a handler that defers for ever would
   * otherwise hang the suite with no output, which reads as a slow test rather
   * than as a broken one.
   */
  private async driveToCompletion(
    def: EngineJobDefinition,
    ctx: JobTestEngineContext,
  ): Promise<unknown> {
    for (let pass = 1; pass <= MAX_TEST_ENGINE_PASSES; pass += 1) {
      try {
        return await def.handler(ctx as unknown as JobContext, jobServices);
      } catch (err) {
        if (!isJobRunDefer(err)) throw err;
      }
    }
    throw new Error(
      `JobTestEngine: ${def.id} deferred ${MAX_TEST_ENGINE_PASSES} times without settling`,
    );
  }
}

/**
 * How many times this harness will re-invoke a deferring handler before calling
 * it a runaway. Comfortably above the shipped poll ceilings a supervision suite
 * lowers anyway, and low enough that a genuinely stuck machine fails with a
 * message rather than a timeout.
 */
const MAX_TEST_ENGINE_PASSES = 5_000;

/** JSON-roundtrip a handler result for the ledger's `output` column, as the real one does. */
function serializeOutput(result: unknown): unknown {
  if (result === undefined || result === null) return undefined;
  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return undefined;
  }
}

/**
 * Run the real `email.send` job in-process against a given event payload. The
 * handler renders the template via emailService and dispatches through the
 * console provider (so a `captureConsoleEmails()` spy sees the `[EMAIL]` line).
 */
export async function runEmailSendJob(data: EmailSendData): Promise<{ result?: unknown }> {
  return new JobTestEngine({
    function: emailSend,
    events: [{ name: 'email.send', data }],
  }).execute();
}

/**
 * Capture the dev-console provider's `[EMAIL] …` stdout lines (the same shape
 * 1.1.6's console provider emits), dropping all other console.log noise so the
 * reporter stays clean.
 */
export function captureConsoleEmails(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((arg) => {
    if (typeof arg === 'string' && arg.startsWith('[EMAIL]')) lines.push(arg);
  });
  return { lines, restore: () => spy.mockRestore() };
}

/**
 * Give every registered cron job a fresh `scheduled.*` ledger row, so
 * `system.daily-health-check`'s schedule-health probe (MOTIR-1970) passes.
 *
 * The probe FAILS the health-check run when a cron job has stopped firing, which
 * is the whole point of it — but it also means any test that drives
 * `dailyHealthCheck` for some OTHER reason (the scheduled-path primitive, the
 * cross-cutting ledger invariants) needs the schedules to look healthy first.
 * Without this the run throws, and the test fails for a reason that has nothing
 * to do with what it is asserting.
 *
 * `system.daily-health-check` is deliberately SKIPPED: the ledger writes its
 * `running` row before the handler body runs, so it always clears its own check
 * — and skipping it keeps it the only row of its own functionId, so callers can
 * still assert an exact run count for the job under test.
 *
 * Importing `@/lib/jobs/registry` here is load-bearing: it evaluates every
 * definition module, which is what populates the schedule table. Callers get
 * that for free rather than depending on which modules their own imports
 * happen to pull in.
 */
export async function seedHealthyJobSchedules(): Promise<void> {
  const { jobSchedules } = await import('@/lib/jobs/schedules');
  await import('@/lib/jobs/registry');
  // ⚠️ SEEDED AT `now`, NOT AT `now - 60s` — the difference is a CI flake, not a
  // style preference. `jobScheduleHealthService.judge` holds a schedule to the
  // tick BEFORE the most recent one, so for the every-minute cron
  // (`system.ci-runner-provision-sweep`, `* * * * *`) the deadline is
  // `floor_to_minute(now) - 60s`. A run seeded at exactly `now - 60s` therefore
  // sits ON that deadline with ZERO margin: if a minute boundary falls between
  // this seed and the health check's read — a window as wide as the elapsed
  // time, which on a loaded CI runner is easily a second — the sweep flips to
  // overdue, the job throws `ScheduledJobsOverdueError`, and the caller sees its
  // `job_run` row stuck at `running` with no hint why. Seeding at `now` gives a
  // full minute of margin for the same "this schedule just ran" fixture.
  const startedAt = new Date();
  for (const { functionId } of jobSchedules()) {
    if (functionId === 'system.daily-health-check') continue;
    // FIXTURE (MOTIR-2792) → the admin client. `job_run` is workspace-scoped and its
    // policy admits the trusted-writer/system-admin context production's job runtime
    // binds; a test SEEDING a ledger row is not exercising that runtime, so it writes
    // as the owner rather than pretending to be it.
    await adminDb.jobRun.create({
      data: {
        workspaceId: null,
        functionId,
        eventName: `scheduled.${functionId}`,
        eventId: `seed-${functionId}`,
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
      },
    });
  }
}
