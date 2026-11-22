// MOTIR-7130 — An index run refused for SIZE is not re-dispatched, the refusal is
// recorded on the repository, and the next run that indexes clears it.
//
// motir-ai refuses a graph over the supported maximum at the upload grant and
// records `GRAPH_TOO_LARGE` with both sizes on the run (MOTIR-7127 / MOTIR-7128).
// The container then exits 40, which `classifyIndexExit` reads as `upload_failed`
// — RE-DISPATCHABLE — so before this card every refused run booted a second
// container that cloned, built more than a gibibyte and was refused again, and
// `/code` could only say "This index is not updating."
//
// Driven on the SHIPPED `system.code-graph-index` job against a real Postgres and
// the fake orchestrator, exactly as `code-graph-index-redispatch.test.ts` drives
// the re-dispatch it amends. motir-ai is the HTTP leaf: the shared fleet stub,
// wrapped here so the run-verdict read answers what motir-ai would record.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine, type JobTestEngineContext } from '../helpers/jobs';
import { db } from '@/lib/db';
import { fleetCodeGraphIndex as codeGraphIndex } from '../helpers/fleetIndexJobs';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { MAX_DISPATCH_ATTEMPTS } from '@/lib/services/codeGraphIndexDispatchService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  driveIndexFleetFast,
  INDEX_REPO_REF,
  indexEventFor,
  indexStepIds,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';
import {
  containersExitWith,
  GIB,
  motirAiAnswersVerdict,
  REFUSED_SIZE,
} from '../helpers/indexSizeRefusal';

const SIZE = REFUSED_SIZE; // 1.4 GiB
const [REPO_OWNER, REPO_NAME] = INDEX_REPO_REF.split('/') as [string, string];

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
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The memos a finished execution left — what `job_step` hands a resumed run. */
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
  return { ...fx, projectId: fx.projectIds[0]! };
}

function eventFor(fx: { installationId: string; workspaceId: string }, id: string) {
  return indexEventFor({
    installationId: fx.installationId,
    workspaceId: fx.workspaceId,
    eventId: id,
  });
}

type Outcome = { result?: unknown; error?: { message?: string }; ctx: JobTestEngineContext };

async function run(fx: { installationId: string; workspaceId: string }, eventId: string) {
  return (await new JobTestEngine({ function: codeGraphIndex }).execute({
    events: [eventFor(fx, eventId)],
  })) as Outcome;
}

function refusalColumns() {
  return adminDb.githubRepo.findFirstOrThrow({
    where: { owner: REPO_OWNER, name: REPO_NAME },
    select: { indexRefusedSizeBytes: true, indexRefusedCapBytes: true, indexRefusedAt: true },
  });
}

describe('a run refused for size', () => {
  it('boots exactly ONE container, fails naming both sizes, and records the refusal on the repository', async () => {
    const fx = await seed('size-refused');
    stubIndexFleet();
    const ai = motirAiAnswersVerdict('refused');
    containersExitWith(40);

    const { result, error, ctx } = await run(fx, 'evt-size-refused');

    expect(result).toBeUndefined();
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(error?.message).toContain('(upload_failed)');
    expect(error?.message).toContain('1.4 GiB');
    expect(error?.message).toContain(`${SIZE} bytes`);
    expect(error?.message).toContain(`${GIB} bytes`);
    expect(error?.message).not.toContain('dispatch attempts');
    expect(ai.reads()).toBeGreaterThanOrEqual(1);

    const ids = indexStepIds(ctx);
    expect(ids).toContain(`index-size-refusal:${fx.projectId}`);
    expect(ids.some((id) => id.endsWith(':r2'))).toBe(false);

    const row = await refusalColumns();
    expect(row.indexRefusedSizeBytes).toBe(BigInt(SIZE));
    expect(row.indexRefusedCapBytes).toBe(BigInt(GIB));
    expect(row.indexRefusedAt).toBeInstanceOf(Date);
  }, 30_000);

  it('still fails the same way when the repository write is lost', async () => {
    const fx = await seed('size-write-lost');
    stubIndexFleet();
    motirAiAnswersVerdict('refused');
    containersExitWith(40);
    vi.spyOn(githubRepoRepository, 'markIndexRefusedForSize').mockRejectedValue(
      new Error('write refused'),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { error } = await run(fx, 'evt-size-write-lost');

    expect(error?.message).toContain('(upload_failed)');
    expect(error?.message).toContain('1.4 GiB');
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(
      logged.mock.calls.some((c) => String(c[0]).includes('could not record the size refusal')),
    ).toBe(true);
  }, 30_000);
});

describe('every other upload_failed is re-dispatched exactly as before', () => {
  it.each([
    ['a verdict of another class', 'upload'],
    ['no verdict (an older motir-ai)', 'none'],
    ['a verdict read that fails', 'unreachable'],
  ] as const)(
    '%s: two containers, the second indexes',
    async (_label, answer) => {
      const fx = await seed(`size-plain-${answer}`);
      stubIndexFleet();
      motirAiAnswersVerdict(answer);
      containersExitWith(40, 0);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = await run(fx, `evt-size-plain-${answer}`);

      expect(result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF });
      expect(fakeOrchestrator.provisioned).toHaveLength(MAX_DISPATCH_ATTEMPTS);
      expect((await refusalColumns()).indexRefusedAt).toBeNull();
    },
    30_000,
  );

  it('a non-upload_failed exit never reads the verdict at all', async () => {
    const fx = await seed('size-no-read');
    stubIndexFleet();
    const ai = motirAiAnswersVerdict('refused');
    containersExitWith(30);

    const { error, ctx } = await run(fx, 'evt-size-no-read');

    expect(error?.message).toContain('(graph_unbuildable)');
    expect(indexStepIds(ctx).some((id) => id.startsWith('index-size-refusal:'))).toBe(false);
    expect(ai.reads()).toBe(0);
    expect((await refusalColumns()).indexRefusedAt).toBeNull();
  }, 30_000);
});

describe('the refusal clears only when a run indexes', () => {
  it('a later INDEXED run clears all three columns', async () => {
    const fx = await seed('size-recover');
    stubIndexFleet();
    motirAiAnswersVerdict('refused');
    containersExitWith(40);
    await run(fx, 'evt-size-recover-1');
    expect((await refusalColumns()).indexRefusedAt).not.toBeNull();

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stubIndexFleet();
    driveIndexFleetFast();
    containersExitWith(0);
    const { result } = await run(fx, 'evt-size-recover-2');

    expect(result).toMatchObject({ indexed: true });
    expect(await refusalColumns()).toEqual({
      indexRefusedSizeBytes: null,
      indexRefusedCapBytes: null,
      indexRefusedAt: null,
    });
  }, 30_000);

  it('a later run that fails for ANOTHER reason leaves the refusal as it was', async () => {
    const fx = await seed('size-other-fail');
    stubIndexFleet();
    motirAiAnswersVerdict('refused');
    containersExitWith(40);
    await run(fx, 'evt-size-other-1');
    const refused = await refusalColumns();

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stubIndexFleet();
    driveIndexFleetFast();
    containersExitWith(30);
    const { error } = await run(fx, 'evt-size-other-2');

    expect(error?.message).toContain('(graph_unbuildable)');
    expect(await refusalColumns()).toEqual(refused);
  }, 30_000);
});

describe('the decision is MEMOIZED — a replay never discovers a refusal after a second boot', () => {
  it('an attempt whose read answered "no refusal" stays a re-dispatch on replay, whatever motir-ai says later', async () => {
    const fx = await seed('size-memo');
    stubIndexFleet();
    motirAiAnswersVerdict('none');
    containersExitWith(40, 0);
    const engine = new JobTestEngine({ function: codeGraphIndex });
    const produced = (await engine.execute({
      events: [eventFor(fx, 'evt-size-memo')],
    })) as Outcome;
    const attemptOne = await replayOf(produced.ctx, (id) => !id.endsWith(':r2'));
    expect(attemptOne.map((s) => s.id)).toContain(`index-size-refusal:${fx.projectId}`);

    // The SAME run resumed on attempt 1's memos, with motir-ai now answering a
    // refusal for it. The memo, not the new answer, decides.
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stubIndexFleet();
    driveIndexFleetFast();
    motirAiAnswersVerdict('refused');
    containersExitWith(0);
    const before = fakeOrchestrator.provisioned.length;
    const resumed = (await engine.execute({
      events: [eventFor(fx, 'evt-size-memo')],
      steps: attemptOne,
    })) as Outcome;

    // Attempt 1 replayed its memoized "no refusal" and went round again: one new
    // boot, the re-dispatch, and it indexed. (A success-path verdict read for the
    // ledger still happens, which is why this counts boots rather than reads.)
    expect(resumed.result).toMatchObject({ indexed: true });
    expect(fakeOrchestrator.provisioned.length - before).toBe(1);
    expect((await refusalColumns()).indexRefusedAt).toBeNull();
  }, 30_000);
});
