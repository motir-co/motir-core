import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import { resolveRefreshDisposition } from '@/lib/ai/codeContext';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import type { CodeGraphRefreshData } from '@/lib/jobs/types';

// EVERY REFRESH IS DUE AT ONCE (MOTIR-11884; MOTIR-5360 before it).
//
// MOTIR-4591 measured the 2-minute push debounce at 122 s of the ≈ 211 s it took
// motir-core's graph to become current after a planning session started on a
// stale one, and MOTIR-5360 let a session start skip it. MOTIR-11884 removed the
// debounce outright: each refresh is handed off to motir-ai, whose service queue
// supersedes a still-queued push of the same repository and ref, so motir-core no
// longer coalesces. What this file existed for still holds and is asserted: a
// session start is due NOW; and what changed is asserted too: a push is due now,
// and two refreshes of one repository are two runs.
//
// Asserted on the QUEUE ROW's `run_at`, which is what the worker claims on —
// not on the enqueue call's arguments, which would pass whatever the engine then
// did with them. Against real Postgres.

const JOB_ID = 'system.code-graph-refresh';

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

const claimAll = () =>
  withSystemContext((tx) => jobQueueRepository.claimDueRuns('worker-under-test', 5, 60_000, tx));

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

describe('the refresh job declares no debounce', () => {
  it('has no `debounce`', () => {
    expect(codeGraphRefresh.debounce).toBeUndefined();
  });
});

describe.each([
  ['a session start', { trigger: 'session_start' as const }],
  ['a push', { trigger: 'push' as const }],
  ['a caller that says nothing', {}],
])('%s', (_label, opts) => {
  it('enqueues a refresh that is due now, with no debounce key', async () => {
    const before = Date.now();
    await enqueueCodeGraphRefresh(payload(), opts);
    const after = Date.now();

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row!.state).toBe('pending');
    // Due NOW — not `now + 2m`. The lower bound is what proves the row is not
    // simply stamped in the past by something else.
    expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row!.runAt.getTime()).toBeLessThanOrEqual(after);
    expect(row!.debounceKey).toBeNull();
    expect(row!.debounceFirstSeenAt).toBeNull();

    // Claimable on the worker's very next claim.
    expect((await claimAll()).map((r) => r.id)).toEqual([row!.id]);
  });
});

describe('one run per refresh — nothing coalesces', () => {
  it('two refreshes of ONE repository enqueued back to back are two runs, both due', async () => {
    await enqueueCodeGraphRefresh({ ...payload(), refreshCause: 'push' });
    await enqueueCodeGraphRefresh({ ...payload(), refreshCause: 'push' });

    const all = await rows();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.eventId)).size).toBe(2);
    expect((await claimAll()).map((r) => r.id).sort()).toEqual(all.map((r) => r.id).sort());
  });

  it('a session start beside a queued push is a run of its own', async () => {
    await enqueueCodeGraphRefresh({ ...payload(), refreshCause: 'push' });
    await enqueueCodeGraphRefresh(payload(), { trigger: 'session_start' });
    expect(await rows()).toHaveLength(2);
  });

  it('repositories stay independent', async () => {
    await enqueueCodeGraphRefresh(payload({ repoName: 'a' }));
    await enqueueCodeGraphRefresh(payload({ repoName: 'b' }));
    const all = await rows();
    expect(all).toHaveLength(2);
  });

  it('a session start while a refresh is IN FLIGHT enqueues nothing', () => {
    // A running refresh sets the repo's `indexing_run_id`, which the index state
    // reads as `indexing`; the session-start disposition then enqueues nothing.
    expect(resolveRefreshDisposition({ indexState: 'indexing', canIndex: true })).toEqual({
      reason: 'refresh_pending',
      refreshInFlight: true,
      enqueue: false,
    });
  });
});

describe('no priority lane and nothing but the payload differs', () => {
  it('a session-start run and a push run are the same row', async () => {
    await enqueueCodeGraphRefresh({ ...payload({ repoName: 'pushed' }), refreshCause: 'push' });
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

    // The trigger is not written into the event; only a push webhook's
    // `refreshCause` is, and only it makes the run hand off a `push`.
    const eventOf = (r: typeof push) =>
      adminDb.jobEvent.findUniqueOrThrow({ where: { id: r!.eventId! } });
    const [pushEvent, sessionEvent] = [await eventOf(push), await eventOf(session)];
    expect(pushEvent.data).toMatchObject({ refreshCause: 'push' });
    expect(sessionEvent.data).not.toHaveProperty('refreshCause');
  });
});
