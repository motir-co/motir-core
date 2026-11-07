// MOTIR-6586 — A `redispatchable` index exit is RE-DISPATCHED, within the run.
//
// `classifyIndexExit` has always marked `20` repo_unfetchable, `40`
// upload_failed and `41` pointer_unrecorded `redispatchable: true`, and nothing
// read the flag. The job's own retry could not stand in for it: a settle RETURNS
// its verdict rather than throwing, so `index-settle:<pid>` is memoized, and a
// retry does not clear the step ledger (`lib/jobs/engine/step.ts`). Attempts 2–5
// replayed `index-admit` → `index-boot` → `index-settle` and threw the identical
// error without booting a container, so one transient fault left the graph stale
// until the next push.
//
// These cases drive the SHIPPED `system.code-graph-index` job on a real Postgres
// with the fake orchestrator, and read the containers the orchestrator was asked
// for — the only count that says whether a second boot happened. A job RETRY is
// modelled the way the engine performs one: the handler is invoked again from
// the top against the memos the failed attempt left (`replayOf` below), which is
// exactly what `job_step` hands a retried run.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine, type JobTestEngineContext } from '../helpers/jobs';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import {
  codeGraphIndexDispatchService,
  MAX_DISPATCH_ATTEMPTS,
} from '@/lib/services/codeGraphIndexDispatchService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  driveIndexFleetFast,
  INDEX_REPO_REF,
  indexEventFor,
  indexJobRuns,
  indexStepIds,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  driveIndexFleetFast();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Fleet-wide and FK-less, so no truncate reaches it — see
  // `tests/jobs/code-graph-index.test.ts` for what a leaked slot does next door.
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * Container N (1-based, in provision order) exits with `codes[N-1]`; every
 * container past the list exits with its LAST entry.
 *
 * Keyed on the orchestrator's own provision count, so the code a container
 * exits with is decided by WHICH container it is — the property a re-dispatch
 * test turns on — rather than by how many polls happened to run.
 */
function containersExitWith(...codes: Array<number | null>): void {
  const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
    async (session, previous, options) => {
      const n = Math.min(fakeOrchestrator.provisioned.length, codes.length);
      for (const id of fakeOrchestrator.liveContainerIds()) {
        fakeOrchestrator.completeJob(id, { exitCode: codes[n - 1]! });
      }
      return realPoll(session, previous, options);
    },
  );
}

/**
 * The memos a finished execution left, as `JobTestEngine`'s pre-fulfilled steps
 * — what `job_step` hands the next attempt of the same run. A step whose `fn`
 * threw left no memo, exactly as in the shipped shim.
 */
async function replayOf(
  ctx: JobTestEngineContext,
  keep: (id: string) => boolean = () => true,
): Promise<Array<{ id: string; handler: () => unknown }>> {
  const memo = new Map<string, unknown>();
  const { calls, results } = ctx.step.run.mock;
  for (let i = 0; i < calls.length; i += 1) {
    const id = String(calls[i]![0]);
    if (!keep(id) || memo.has(id)) continue;
    try {
      memo.set(id, await results[i]!.value);
    } catch {
      // Threw: not memoized.
    }
  }
  return [...memo].map(([id, value]) => ({ id, handler: () => value }));
}

async function seed(slug: string) {
  const fx = await seedIndexWorkspace(slug, 1);
  stubIndexFleet();
  return {
    ...fx,
    projectId: fx.projectIds[0]!,
    event: indexEventFor({
      installationId: fx.installationId,
      workspaceId: fx.workspaceId,
      eventId: `evt-${slug}`,
    }),
  };
}

type Outcome = { result?: unknown; error?: { message?: string }; ctx: JobTestEngineContext };

describe('a re-dispatchable exit boots a FRESH container within the same run', () => {
  it('caps re-dispatch at two containers — the number the rest of this file assumes', () => {
    expect(MAX_DISPATCH_ATTEMPTS).toBe(2);
  });

  it.each([
    [20, 'repo_unfetchable'],
    [40, 'upload_failed'],
    [41, 'pointer_unrecorded'],
  ] as const)(
    'exit %s (%s) then exit 0: the second container indexes and the run succeeds',
    async (code, _exitClass) => {
      const fx = await seed(`redispatch-ok-${code}`);
      containersExitWith(code, 0);

      const { result, ctx } = (await new JobTestEngine({ function: codeGraphIndex }).execute({
        events: [fx.event],
      })) as Outcome;

      expect(result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF, projectsIndexed: 1 });
      // TWO boots — the assertion that was false before MOTIR-6586, where the
      // flag promised a second container and the run never asked for one.
      expect(fakeOrchestrator.provisioned).toHaveLength(2);
      // Both torn down: the failed container is not left for the reaper.
      expect(fakeOrchestrator.teardowns).toHaveLength(2);
      expect(fakeOrchestrator.liveContainerIds()).toEqual([]);

      // Attempt 1 under the bare ids every memo before MOTIR-6586 carries, and
      // attempt 2 under ids — and a `job_supervision` subject — of its own.
      const own = indexStepIds(ctx).filter((id) => id.includes(`:${fx.projectId}`));
      expect(own).toEqual([
        // MOTIR-10600: each admission ASK is its own step, called INSIDE the
        // attempt's `index-admit:` step (this lists calls, in call order).
        `index-admit:${fx.projectId}`,
        `index-admit-try:${fx.projectId}:1`,
        `index-boot:${fx.projectId}`,
        `index-settle:${fx.projectId}`,
        // MOTIR-7130: an `upload_failed` settle asks once, memoized, whether motir-ai
        // refused the graph for SIZE before it goes round again. This world records
        // no verdict, so the answer is "no" and the re-dispatch proceeds.
        ...(code === 40 ? [`index-size-refusal:${fx.projectId}`] : []),
        `index-admit:${fx.projectId}:r2`,
        `index-admit-try:${fx.projectId}:r2:1`,
        `index-boot:${fx.projectId}:r2`,
        `index-settle:${fx.projectId}:r2`,
      ]);

      // The ledger claims the repo — the second container earned it.
      const runs = await indexJobRuns();
      expect(runs.filter((run) => run.status === 'succeeded')).toHaveLength(1);
      // And the admission slot came back after each container, not only the last.
      expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
    },
    30_000,
  );

  it('every container exits 40: the run fails naming the LAST class and the attempt count, and a job retry boots nothing more', async () => {
    const fx = await seed('redispatch-exhausted');
    containersExitWith(40);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const first = (await engine.execute({ events: [fx.event] })) as Outcome;

    expect(first.result).toBeUndefined();
    expect(first.error?.message).toContain('(upload_failed) after 2 dispatch attempts');
    expect(first.error?.message).toContain(INDEX_REPO_REF);
    expect(fakeOrchestrator.provisioned).toHaveLength(MAX_DISPATCH_ATTEMPTS);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);

    // THE ENGINE'S RETRY PATH: the same run, re-entered from the top against the
    // memos attempt 1 of the JOB left. The cap is a property of the memos, so
    // the retry replays both settled attempts, boots nothing, and fails the same
    // way — a retry budget of five is never five more containers.
    const retried = (await engine.execute({
      events: [fx.event],
      steps: await replayOf(first.ctx),
    })) as Outcome;

    expect(retried.result).toBeUndefined();
    expect(retried.error?.message).toBe(first.error?.message);
    expect(fakeOrchestrator.provisioned).toHaveLength(MAX_DISPATCH_ATTEMPTS);
    expect((await indexJobRuns()).filter((run) => run.status === 'succeeded')).toEqual([]);
  }, 30_000);

  it('a first-attempt failure message reads exactly as it did before — no attempt count', async () => {
    const fx = await seed('redispatch-single');
    containersExitWith(30);

    const { error } = (await new JobTestEngine({ function: codeGraphIndex }).execute({
      events: [fx.event],
    })) as Outcome;

    expect(error?.message).toContain('(graph_unbuildable): ');
    expect(error?.message).not.toContain('dispatch attempts');
  }, 30_000);
});

describe('a NON-re-dispatchable exit is still final — one container', () => {
  it.each([
    [10, 'dispatch_malformed'],
    [30, 'graph_unbuildable'],
    [50, 'credential_refused'],
    [137, 'out_of_memory'],
    [null, 'exit_unobserved'],
  ] as const)(
    'exit %s (%s) boots no second container',
    async (code, name) => {
      const fx = await seed(`redispatch-final-${code ?? 'null'}`);
      containersExitWith(code);

      const { error, ctx } = (await new JobTestEngine({ function: codeGraphIndex }).execute({
        events: [fx.event],
      })) as Outcome;

      expect(error?.message).toContain(`(${name})`);
      expect(fakeOrchestrator.provisioned).toHaveLength(1);
      expect(indexStepIds(ctx).some((id) => id.endsWith(':r2'))).toBe(false);
    },
    30_000,
  );
});

describe('a run IN FLIGHT at deploy time resumes on its attempt-1 memos', () => {
  it('holding only attempt 1’s memos — a failed, memoized settle — it replays them and boots ONLY the re-dispatch', async () => {
    const fx = await seed('redispatch-inflight');
    // What the previous revision left in `job_step`: attempt 1's three memos,
    // the settle carrying a re-dispatchable verdict. Produced here by the
    // shipped code and then cut down to attempt 1's ids, so the memo SHAPES are
    // real rather than hand-written.
    containersExitWith(40, 0);
    const engine = new JobTestEngine({ function: codeGraphIndex });
    const produced = (await engine.execute({ events: [fx.event] })) as Outcome;
    const attemptOne = await replayOf(produced.ctx, (id) => !id.endsWith(':r2'));
    expect(attemptOne.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        `index-admit:${fx.projectId}`,
        `index-boot:${fx.projectId}`,
        `index-settle:${fx.projectId}`,
      ]),
    );

    // A FRESH supervision store: the previous revision never wrote an `:r2` row,
    // and the shared one now holds a settled `:r2` from the run above. Every spy
    // is re-installed on the real methods, not stacked on the old ones.
    vi.restoreAllMocks();
    stubIndexFleet();
    driveIndexFleetFast();
    containersExitWith(0);
    const before = fakeOrchestrator.provisioned.length;
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const resumed = (await engine.execute({
      events: [fx.event],
      steps: attemptOne,
    })) as Outcome;

    expect(resumed.result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF });
    // Attempt 1 was NOT re-executed — its boot answered from the memo, and its
    // settle handed back the recorded exit 40. One boot, and it is the re-dispatch.
    expect(boot).toHaveBeenCalledTimes(1);
    expect(fakeOrchestrator.provisioned.length - before).toBe(1);
    const booted = resumed.ctx.step.run.mock.calls
      .map((call) => String(call[0]))
      .filter((id) => id.startsWith('index-boot:'));
    expect(new Set(booted)).toEqual(
      new Set([`index-boot:${fx.projectId}`, `index-boot:${fx.projectId}:r2`]),
    );
  }, 30_000);
});
