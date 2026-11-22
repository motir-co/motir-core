import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import { resolveRefreshDisposition } from '@/lib/ai/codeContext';
import { fleetCodeGraphRefresh as codeGraphRefresh } from '../helpers/fleetIndexJobs';
import type { CodeGraphRefreshData } from '@/lib/jobs/types';

// A SESSION-START REFRESH DOES NOT SIT OUT THE PUSH DEBOUNCE (MOTIR-5360).
//
// MOTIR-4591 measured the 2-minute debounce at 122 s of the ≈ 211 s it took
// motir-core's graph to become current after a planning session started on a
// stale one. The debounce is for bursts of pushes; a session start is one event
// with a person waiting behind it.
//
// Asserted on the QUEUE ROW's `run_at`, which is what the worker claims on —
// not on the enqueue call's arguments, which would pass whatever the engine then
// did with them. Against real Postgres, because the coalescing is a row lock and
// a partial unique index.

const JOB_ID = 'system.code-graph-refresh';
const PERIOD_MS = 120_000;
/** Slack for the wall clock between reading `Date.now()` and the row's insert. */
const SLACK_MS = 5_000;

const payload = (over: Partial<CodeGraphRefreshData> = {}): CodeGraphRefreshData => ({
  installationId: 'inst_5360',
  workspaceId: null as unknown as string,
  repoOwner: 'moooon-B-V',
  repoName: 'motir-core',
  defaultBranch: 'main',
  ...over,
});

const rows = () =>
  adminDb.jobQueueRun.findMany({ where: { jobId: JOB_ID }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a session start on a stale graph', () => {
  it('starts a refresh with no debounce wait — the queue row is due now', async () => {
    const before = Date.now();
    await enqueueCodeGraphRefresh(payload(), { trigger: 'session_start' });
    const after = Date.now();

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row!.state).toBe('pending');
    // Due NOW — not `now + 2m`. The lower bound is what proves the row is not
    // simply stamped in the past by something else.
    expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row!.runAt.getTime()).toBeLessThanOrEqual(after);
    // And it is still a DEBOUNCED row: it carries the key, so a later same-repo
    // arrival coalesces into it instead of queueing beside it.
    expect(row!.debounceKey).toBe('inst_5360/moooon-B-V/motir-core');

    // Claimable on the worker's very next claim.
    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns('worker-under-test', 5, 60_000, tx),
    );
    expect(claimed.map((r) => r.id)).toEqual([row!.id]);
  });
});

describe('a push', () => {
  it('still debounces 2 minutes', async () => {
    const before = Date.now();
    await enqueueCodeGraphRefresh(payload());
    const after = Date.now();

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before + PERIOD_MS);
    expect(row!.runAt.getTime()).toBeLessThanOrEqual(after + PERIOD_MS + SLACK_MS);

    // Not claimable yet — the quiet period is real.
    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns('worker-under-test', 5, 60_000, tx),
    );
    expect(claimed).toEqual([]);
  });

  it('keeps the job’s declared debounce byte-for-byte', () => {
    expect(codeGraphRefresh.debounce).toEqual({
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
      timeout: '15m',
    });
  });

  it('says `push` when it says nothing — the default is the debounced trigger', async () => {
    const before = Date.now();
    await enqueueCodeGraphRefresh(payload(), { trigger: 'push' });
    const [row] = await rows();
    expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before + PERIOD_MS);
  });
});

describe('single-flight holds — a session start never adds a second refresh', () => {
  it('coalesces into a refresh already QUEUED for the repo, pulling it forward', async () => {
    await enqueueCodeGraphRefresh(payload());
    const [queued] = await rows();
    expect(queued!.runAt.getTime()).toBeGreaterThan(Date.now() + PERIOD_MS - SLACK_MS);

    const before = Date.now();
    await enqueueCodeGraphRefresh(payload(), { trigger: 'session_start' });
    const after = Date.now();

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(queued!.id);
    expect(all[0]!.runAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(all[0]!.runAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('five session starts in a row still hold ONE queued refresh', async () => {
    for (let i = 0; i < 5; i++) {
      await enqueueCodeGraphRefresh(payload(), { trigger: 'session_start' });
    }
    expect(await rows()).toHaveLength(1);
  });

  it('a push landing before the worker claims does not re-defer the session start', async () => {
    await enqueueCodeGraphRefresh(payload(), { trigger: 'session_start' });
    const [due] = await rows();

    await enqueueCodeGraphRefresh(payload());

    const all = await rows();
    expect(all).toHaveLength(1);
    // Still due at the moment the session start made it due — not `now + 2m`.
    expect(all[0]!.runAt.getTime()).toBe(due!.runAt.getTime());
  });

  it('a session start while a refresh is IN FLIGHT enqueues nothing', () => {
    // A running refresh sets the repo's `indexing_run_id`, which the index state
    // reads as `indexing`; the session-start disposition then enqueues nothing.
    // Past this producer, a run for the repo that did reach the queue would still
    // meet the (repo × project) admission slot the running one holds and wait
    // (`repo_index_in_flight`, tests/ciFleet/codeGraphIndexAdmission.test.ts).
    expect(resolveRefreshDisposition({ indexState: 'indexing', canIndex: true })).toEqual({
      reason: 'refresh_pending',
      refreshInFlight: true,
      enqueue: false,
    });
  });
});

describe('no priority lane and nothing but `run_at` differs', () => {
  it('a session-start run and a push run are the same row apart from when they are due', async () => {
    await enqueueCodeGraphRefresh(payload({ repoName: 'pushed' }));
    await enqueueCodeGraphRefresh(payload({ repoName: 'session' }), { trigger: 'session_start' });

    const [push, session] = await rows();
    const strip = (r: typeof push) => ({
      jobId: r!.jobId,
      eventName: r!.eventName,
      workspaceId: r!.workspaceId,
      maxAttempts: r!.maxAttempts,
      attempts: r!.attempts,
      state: r!.state,
      idempotencyKey: r!.idempotencyKey,
      scheduledFor: r!.scheduledFor,
    });
    expect(strip(session)).toEqual(strip(push));

    // The EVENT carries the same payload shape — the trigger is not written into
    // it, so admission (keyed on the repo and project) cannot tell them apart.
    const eventOf = (r: typeof push) =>
      adminDb.jobEvent.findUniqueOrThrow({ where: { id: r!.eventId! } });
    const [pushEvent, sessionEvent] = [await eventOf(push), await eventOf(session)];
    expect(Object.keys(sessionEvent.data as object).sort()).toEqual(
      Object.keys(pushEvent.data as object).sort(),
    );
  });
});
