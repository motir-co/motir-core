import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobQueueRun } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import {
  ciRunnerBootService,
  FLEET_TIME_BUDGETS,
  pollWaitMs,
  type PollResult,
  type SupervisionSession,
} from '@/lib/services/ciRunnerBootService';
import { isJobRunDefer, type JobRunDefer } from '@/lib/jobs/engine/defer';
import { inProcessMemoSteps } from '@/lib/jobs/supervision/inProcessSteps';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE CI-RUNNER SUPERVISOR ADVANCES ONCE PER RUN (Story MOTIR-3778 · Subtask
// MOTIR-3829), against a real Postgres and the real `job_supervision` table.
//
// The boot and the teardown are faked — `bootOnce`, the JIT mint and the
// admission gate are explicitly out of this card's scope, and
// `tests/ciFleet/` covers them end to end. What is real here is the PASS SHAPE:
// one provider read per run, the `job_queue` row unclaimed between passes, the
// attempt refunded, and teardown reached from three transitions and never from a
// defer.
//
// ⚠️ THE ONE THAT MATTERS MOST IS THE ATTEMPT REFUND. `system.ci-runner-boot` is
// the only job in the tree on `retryPolicy: 'none'` — a budget of exactly ONE —
// so the difference between a suspension that spends an attempt and one that
// does not is the difference between a hundred-poll supervision and a CI job
// dead-lettered on its second poll. `job-queue-foundation.md` §13.4 asked for
// that to be asserted against the worker's real reclaim path rather than cited
// when this mechanism last changed; it changes again, so it is asserted again.
//
// ⚠️ AND THE ADMISSION WAKE IS ASSERTED AS *SETTLE ONCE*, deliberately.
// `dispatchNextPendingForProject` is called from inside `settleSupervision`, and
// this card does not touch that coupling — `tests/ciFleet/
// ciRunnerAdmissionWake.test.ts` drives a real supervised completion end to end
// and asserts the queued sibling's boot leaves in the same call. What CHANGES
// here is WHEN settle is reached, so what this file owes is that it is reached
// exactly once across a whole supervision and on no other pass.

const INTENT_ID = 'i-selfresched';

/**
 * A supervising session — the JSON shape `bootIntent` hands across the step
 * boundary.
 *
 * ⚠️ `bootedAt` IS FRESH and `workspaceId` IS REAL, and both are load-bearing.
 * The driver evaluates the SESSION-ANCHORED deadline before it polls
 * (§13.3(a)), so a session frozen at a past date is one that timed out and
 * settles before its first read; and the supervision row denormalises the
 * session's workspace, which is a foreign key, so a made-up id fails the write
 * rather than the assertion.
 */
function sessionFor(workspaceId: string): SupervisionSession {
  return {
    intentId: INTENT_ID,
    handle: { provider: 'fake', id: 'c-1', region: 'ams', createdAt: new Date().toISOString() },
    githubRunnerId: 9001,
    bootedAt: new Date().toISOString(),
    queuedAt: new Date(Date.now() - 5_000).toISOString(),
    attribution: {
      orgId: 'org-1',
      workspaceId,
      projectId: 'proj-1',
      repoFullName: 'moooon-B-V/motir-core',
      workflowJobId: 99,
    },
  };
}

const NOT_DONE: Extract<PollResult, { done: false }> = {
  done: false,
  startedAt: new Date().toISOString(),
  bootLatencyMs: 1_200,
  consecutiveReadFailures: 0,
};

const DONE: Extract<PollResult, { done: true }> = {
  done: true,
  reason: 'job_completed',
  startedAt: NOT_DONE.startedAt,
  bootLatencyMs: NOT_DONE.bootLatencyMs,
  failureDetail: null,
};

const SETTLED = {
  outcome: 'settled',
  reason: 'job_completed',
  containerId: 'c-1',
  billableSeconds: 42,
  costUsd: '0.0042',
  bootLatencyMs: 1_200,
  usage: {},
} as const;

const FAST = { pollIntervalMs: 1, maxPollIntervalMs: 2 } as const;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function enqueue(opts?: { maxAttempts?: number }): Promise<JobQueueRun> {
  seq += 1;
  const user = await usersService.createUser({
    email: `ci-sr-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `CI SR ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `CI SR WS ${seq}`,
    ownerUserId: user.id,
  });
  return adminDb.jobQueueRun.create({
    data: {
      jobId: 'system.ci-runner-boot',
      eventName: 'ci-runner/boot.requested',
      workspaceId: workspace.id,
      runAt: new Date(),
      maxAttempts: opts?.maxAttempts ?? 3,
    },
  });
}

/** Boot from a fake session; poll and settle scripted. Returns the spies. */
function stubFleet(workspaceId: string, script: { polls: PollResult[] }) {
  vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
    phase: 'supervising',
    session: sessionFor(workspaceId),
  });
  let i = 0;
  const poll = vi
    .spyOn(ciRunnerBootService, 'pollOnce')
    .mockImplementation(async () => script.polls[Math.min(i++, script.polls.length - 1)]!);
  const settle = vi
    .spyOn(ciRunnerBootService, 'settleSupervision')
    .mockResolvedValue(SETTLED as never);
  return { poll, settle };
}

/** One PASS, over a memo that persists across passes — what `job_step` is. */
function passer(runId: string, overrides: Record<string, unknown> = {}) {
  const steps = inProcessMemoSteps({
    run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
  });
  return async (): Promise<{ defer: JobRunDefer } | { outcome: unknown }> => {
    try {
      const outcome = await ciRunnerBootService.advanceIntent(runId, INTENT_ID, {
        ...FAST,
        ...overrides,
        steps,
      });
      return { outcome };
    } catch (err) {
      if (isJobRunDefer(err)) return { defer: err };
      throw err;
    }
  };
}

function readRow(runId: string) {
  return withSystemContext((tx) =>
    jobSupervisionRepository.findByRunAndSubject(runId, INTENT_ID, tx),
  );
}

describe('one pass, one provider read', () => {
  it('polls EXACTLY ONCE per pass, and the total is LINEAR in the poll number', async () => {
    const run = await enqueue();
    const { poll, settle } = stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    const pass = passer(run.id);

    // The opening pass boots and waits — no read, because a container cannot
    // have started in the instant `provision` returned.
    expect('defer' in (await pass())).toBe(true);
    expect(poll).toHaveBeenCalledTimes(0);

    for (let n = 1; n <= 12; n += 1) {
      expect('defer' in (await pass())).toBe(true);
      expect(poll, `after pass ${n}`).toHaveBeenCalledTimes(n);
    }

    // 12 polls, 12 reads. MOTIR-3763 measured the falsified `step.sleep` yield at
    // N(N+1)/2, which for the ~1 200 polls of an hour-long CI job would have been
    // six orders of magnitude of provider calls. Linearity is the property.
    expect(poll).toHaveBeenCalledTimes(12);
    expect(settle).not.toHaveBeenCalled();
    expect((await readRow(run.id))!.pollNumber).toBe(12);
  });

  it('defers at the SHIPPED cadence — `pollWaitMs(n)` is the wait before poll n', async () => {
    const run = await enqueue();
    stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    // The real budgets: §16.6 forbids this change moving a single one.
    const pass = passer(run.id, { pollIntervalMs: undefined, maxPollIntervalMs: undefined });

    const opening = await pass();
    const afterFirstPoll = await pass();

    const owed = (r: { defer: JobRunDefer } | { outcome: unknown }): number =>
      'defer' in r ? r.defer.resumeAt.getTime() - Date.now() : -1;
    // Boot → wait(1) → poll 1 → wait(2) → poll 2, exactly as the `for` loop it
    // replaces, whose body opened with `await sleep(pollWaitMs(iteration))`.
    expect(owed(opening)).toBeGreaterThan(pollWaitMs(1) - 2_000);
    expect(owed(opening)).toBeLessThanOrEqual(pollWaitMs(1));
    expect(owed(afterFirstPoll)).toBeGreaterThan(pollWaitMs(2) - 2_000);
    expect(owed(afterFirstPoll)).toBeLessThanOrEqual(pollWaitMs(2));
  });
});

describe('`retryPolicy: none` survives the whole supervision', () => {
  it('a ONE-attempt run defers past a hundred polls and is still claimable, against the real worker', async () => {
    // `maxAttempts: 1` is what `retryPolicy: 'none'` resolves to, and it is
    // `system.ci-runner-boot`'s. §13.4 requires this be asserted against the
    // worker's real settle path rather than cited, because with a budget of
    // exactly one the difference between a reclaim and a failure is the
    // difference between resuming and dead-lettering a CI job that was fine.
    const run = await enqueue({ maxAttempts: 1 });
    const { poll } = stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    const pass = passer(run.id);

    const outcomes: string[] = [];
    let highWaterAttempts = 0;
    const worker = new JobWorker({
      workerId: 'ci-supervisor',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      onOutcome: (_run, outcome) => outcomes.push(outcome),
      execute: async (claimed) => {
        highWaterAttempts = Math.max(highWaterAttempts, claimed.attempts);
        const result = await pass();
        if ('defer' in result) throw result.defer;
      },
    });

    for (let i = 0; i < 101; i += 1) {
      await adminDb.jobQueueRun.update({ where: { id: run.id }, data: { runAt: new Date() } });
      expect(await worker.tick(), `pass ${i + 1} must be claimable`).toBe(1);
      await worker.settled();
    }

    // 101 passes: the opening wait plus a hundred polls, on a budget of ONE.
    expect(poll).toHaveBeenCalledTimes(100);
    expect(new Set(outcomes)).toEqual(new Set(['deferred']));
    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.attempts).toBe(0);
    expect(highWaterAttempts).toBe(1);
    expect(row.state).toBe('pending');
  });

  it('leaves the `job_queue` row unclaimed and the worker’s pool free between passes', async () => {
    const run = await enqueue();
    stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    const pass = passer(run.id);
    const worker = new JobWorker({
      workerId: 'ci-supervisor-2',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      execute: async () => {
        const result = await pass();
        if ('defer' in result) throw result.defer;
      },
    });

    expect(await worker.tick()).toBe(1);
    await worker.settled();

    const row = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.state).toBe('pending');
    expect(row.claimedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(worker.inFlightCount).toBe(0);
    expect(worker.freeCapacity).toBe(10);
  });
});

describe('a restart mid-supervision', () => {
  it('replays `boot-runner` and registers no second runner', async () => {
    const run = await enqueue();
    const { poll } = stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    const boot = vi.mocked(ciRunnerBootService.bootIntent);

    // ONE persistent memo across six passes, which is what `job_step` is to a
    // restarted worker: the boot executes once and replays thereafter.
    const shared = new Map<string, unknown>();
    const steps = {
      run: async <T>(id: string, fn: () => T | Promise<T>): Promise<T> => {
        if (shared.has(id)) return shared.get(id) as T;
        const value = await fn();
        shared.set(id, value);
        return value;
      },
    };
    for (let i = 0; i < 6; i += 1) {
      await expect(
        ciRunnerBootService.advanceIntent(run.id, INTENT_ID, { ...FAST, steps }),
      ).rejects.toSatisfy(isJobRunDefer);
    }

    // ONE boot — which on this fleet means one JIT registration and one billed
    // machine — across six passes and five polls.
    expect(boot).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(5);
  });
});

describe('teardown is a terminal transition', () => {
  it('is NOT reached on a defer — the negative §15.4 measured', async () => {
    const run = await enqueue();
    const { settle } = stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    const pass = passer(run.id);

    for (let i = 0; i < 6; i += 1) expect('defer' in (await pass())).toBe(true);

    // A `finally` around the old loop would have called this on the FIRST
    // suspension, de-registering the runner and destroying the machine the
    // supervision was watching.
    expect(settle).not.toHaveBeenCalled();
    expect((await readRow(run.id))!.state).toBe('watching');
  });

  it('is reached ONCE on the `done` verdict, and on no other pass', async () => {
    const run = await enqueue();
    const { settle } = stubFleet(run.workspaceId!, { polls: [NOT_DONE, NOT_DONE, DONE] });
    const pass = passer(run.id);

    await pass(); // the opening wait
    await pass(); // poll 1 — not done
    await pass(); // poll 2 — not done
    const result = await pass(); // poll 3 — done

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({ reason: 'job_completed' });
    expect(result).toEqual({ outcome: SETTLED });
    expect((await readRow(run.id))!.state).toBe('settled');
    // ⚠️ SETTLE-ONCE IS THE ADMISSION WAKE'S PROPERTY TOO.
    // `dispatchNextPendingForProject` is called from inside
    // `settleSupervision` — unchanged by this card — so a supervision that
    // settles once wakes the project once. `tests/ciFleet/
    // ciRunnerAdmissionWake.test.ts` drives that coupling end to end against a
    // real intent.
  });

  it('is reached on the DEADLINE, measured from the memoized `bootedAt`', async () => {
    const run = await enqueue();
    const { poll, settle } = stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    const pass = passer(run.id, { jobTimeoutMs: 1 });

    await pass(); // the opening wait
    const result = await pass();

    // Settled BEFORE polling — the resumed-pass case §13.3(a) is about.
    expect(poll).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({
      reason: 'job_timed_out',
      failureDetail: expect.stringContaining('deadline'),
    });
    expect('outcome' in result).toBe(true);
  });

  it('is reached on the POLL CEILING, which is a TOTAL bound across passes', async () => {
    const run = await enqueue();
    const { poll, settle } = stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    const pass = passer(run.id, { maxPollIterations: 4 });

    await pass(); // the opening wait
    for (let i = 0; i < 4; i += 1) expect('defer' in (await pass())).toBe(true);
    await pass();

    expect(poll).toHaveBeenCalledTimes(4);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({
      failureDetail: 'supervision hit the 4-poll ceiling',
    });
  });

  it('is reached on a THROW from inside the poll, and the error still propagates', async () => {
    const run = await enqueue();
    const { settle } = stubFleet(run.workspaceId!, { polls: [NOT_DONE] });
    const pass = passer(run.id);
    await pass();

    const boom = new Error('the provider went away');
    vi.mocked(ciRunnerBootService.pollOnce).mockRejectedValueOnce(boom);

    await expect(pass()).rejects.toBe(boom);
    // Settled FIRST, then the throw — the arm a step reachable only from the
    // loop's two normal exits could never cover (§13.4).
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({
      failureDetail: expect.stringContaining('a poll threw'),
    });
  });
});

describe('what this change may not move', () => {
  it('leaves `FLEET_TIME_BUDGETS` byte-identical', () => {
    expect(FLEET_TIME_BUDGETS).toEqual({
      bootDeadlineMs: 120_000,
      // ADDED by MOTIR-11230 (the idle-runner retirement); every other budget is unchanged.
      idleTimeoutMs: 300_000,
      jobTimeoutMs: 3_600_000,
      pollIntervalMs: 3_000,
      maxPollIntervalMs: 30_000,
      reapAfterMs: 4_200_000,
      maxPollIterations: 2_000,
      stepWorkBudgetMs: 120_000,
      mintDeadlineMs: 15_000,
      containerCallDeadlineMs: 30_000,
    });
    expect([1, 2, 3, 4, 5].map((n) => pollWaitMs(n))).toEqual([
      3_000, 6_000, 12_000, 24_000, 30_000,
    ]);
  });
});
