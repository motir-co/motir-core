// THE SIZE REFUSAL, ASSEMBLED IN MOTIR-CORE (Story MOTIR-7092 · MOTIR-7133).
//
// Each motir-core card of the story tests its own half with the next one's
// injected: the verdict client against a stubbed body (MOTIR-7129), the retry
// decision and the repository write on the shipped job (MOTIR-7130), the row from
// a hand-built DTO (MOTIR-7132). The risk lives in the hand-offs — an outcome
// field the fleet step does not read, a column the set read does not select, a
// clear on the wrong branch — and only the real writer driven into the real
// reader catches those. So here a settled attempt whose motir-ai verdict says
// `GRAPH_TOO_LARGE` travels the whole way: the shipped `system.code-graph-index`
// job, the dispatch service, the `GithubRepo` columns, and `resolveCodeContextState`
// onto `CodeContextRepoDTO.graphTooLarge` — the read `/code` renders.
//
// Real Postgres; the fake orchestrator; motir-ai's HTTP boundary stubbed at
// `fetch`, the one seam outside this repository. The suite-wide per-file coverage
// floor over the story's files is the PR's CI coverage gate's to measure (the
// runbook's suite-wide-criterion rule): it runs every suite that exercises them.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { db } from '@/lib/db';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import { MAX_DISPATCH_ATTEMPTS } from '@/lib/services/codeGraphIndexDispatchService';
import { fakeOrchestrator } from '@motir/orchestrator';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  driveIndexFleetFast,
  INDEX_REPO_REF,
  indexEventFor,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
  type SeededIndexWorkspace,
} from '../helpers/indexFleet';
import {
  containersExitWith,
  GIB,
  motirAiAnswersVerdict,
  REFUSED_SIZE,
  type VerdictAnswer,
} from '../helpers/indexSizeRefusal';

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

type Outcome = { result?: unknown; error?: { message?: string } };

/** One run of the shipped job, with motir-ai and the containers answering as told. */
async function indexRun(
  fx: SeededIndexWorkspace,
  eventId: string,
  verdict: VerdictAnswer,
  ...exitCodes: Array<number | null>
): Promise<Outcome> {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stubIndexFleet();
  driveIndexFleetFast();
  motirAiAnswersVerdict(verdict);
  containersExitWith(...exitCodes);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return (await new JobTestEngine({ function: codeGraphIndex }).execute({
    events: [
      indexEventFor({ installationId: fx.installationId, workspaceId: fx.workspaceId, eventId }),
    ],
  })) as Outcome;
}

function refusalColumns() {
  return adminDb.githubRepo.findFirstOrThrow({
    where: { owner: REPO_OWNER, name: REPO_NAME },
    select: { indexRefusedSizeBytes: true, indexRefusedCapBytes: true, indexRefusedAt: true },
  });
}

/** The repository's row as `/code` reads it, for one project. */
async function codeRow(fx: SeededIndexWorkspace, projectId: string) {
  const state = await resolveCodeContextState(projectId, {
    userId: fx.ownerUserId,
    workspaceId: fx.workspaceId,
  });
  return state.repos.find((r) => r.repoRef === INDEX_REPO_REF);
}

describe('a size-refused run, end to end in motir-core', () => {
  it('1–3 · refused, not retried, recorded on the repository, and on the DTO with refreshFailing still true', async () => {
    const fx = await seedIndexWorkspace('int-refused', 1);

    const { error } = await indexRun(fx, 'evt-int-refused', 'refused', 40);

    // 1 — one container, and a failure naming both sizes.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(error?.message).toContain('(upload_failed)');
    expect(error?.message).toContain(`${REFUSED_SIZE} bytes`);
    expect(error?.message).toContain(`${GIB} bytes`);

    // 2 — the repository holds the verdict's numbers.
    const row = await refusalColumns();
    expect(row.indexRefusedSizeBytes).toBe(BigInt(REFUSED_SIZE));
    expect(row.indexRefusedCapBytes).toBe(BigInt(GIB));
    expect(row.indexRefusedAt).toBeInstanceOf(Date);

    // 3 — the read `/code` renders carries it, beside a refresh that is still dead.
    // The failed run leaves its claim on the repository (`indexingRunId` is not
    // released on the failure path), and the claim names the run's own ledger row
    // (MOTIR-9454). In production the engine then writes that row `failed`.
    // `JobTestEngine` has no attempt budget to exhaust and never finalises a ledger
    // row, so that one terminal write is made here — it is what
    // `deriveRefreshFailing` reads, and nothing about the refusal.
    const { indexingRunId } = await adminDb.githubRepo.findFirstOrThrow({
      where: { owner: REPO_OWNER, name: REPO_NAME },
      select: { indexingRunId: true },
    });
    expect(indexingRunId).not.toBeNull();
    const ledgerRow = await adminDb.jobRun.findUniqueOrThrow({ where: { id: indexingRunId! } });
    expect(ledgerRow).toMatchObject({ functionId: 'system.code-graph-index', status: 'running' });
    await adminDb.jobRun.update({ where: { id: indexingRunId! }, data: { status: 'failed' } });
    expect(await codeRow(fx, fx.projectIds[0]!)).toMatchObject({
      graphTooLarge: { sizeBytes: REFUSED_SIZE, capBytes: GIB },
      refreshFailing: true,
    });
  }, 60_000);

  it('4 · a later run that INDEXES clears all three columns and the DTO', async () => {
    const fx = await seedIndexWorkspace('int-recover', 1);
    await indexRun(fx, 'evt-int-recover-1', 'refused', 40);
    expect((await codeRow(fx, fx.projectIds[0]!))?.graphTooLarge).not.toBeNull();

    const { result } = await indexRun(fx, 'evt-int-recover-2', 'none', 0);

    expect(result).toMatchObject({ indexed: true });
    expect(await refusalColumns()).toEqual({
      indexRefusedSizeBytes: null,
      indexRefusedCapBytes: null,
      indexRefusedAt: null,
    });
    expect((await codeRow(fx, fx.projectIds[0]!))?.graphTooLarge).toBeNull();
  }, 60_000);

  it('5 · a later run that fails graph_unbuildable leaves the refusal as it was', async () => {
    const fx = await seedIndexWorkspace('int-other', 1);
    await indexRun(fx, 'evt-int-other-1', 'refused', 40);
    const refused = await refusalColumns();

    const { error } = await indexRun(fx, 'evt-int-other-2', 'refused', 30);

    expect(error?.message).toContain('(graph_unbuildable)');
    expect(await refusalColumns()).toEqual(refused);
    expect((await codeRow(fx, fx.projectIds[0]!))?.graphTooLarge).toEqual({
      sizeBytes: REFUSED_SIZE,
      capBytes: GIB,
    });
  }, 60_000);

  it.each([
    ['6 · an OLDER motir-ai (the verdict route answers 404)', 'not-found'],
    ['7 · a plain upload failure (class UPLOAD)', 'upload'],
  ] as const)(
    '%s re-dispatches up to MAX_DISPATCH_ATTEMPTS and writes nothing',
    async (_label, answer) => {
      const fx = await seedIndexWorkspace(`int-plain-${answer}`, 1);

      const { error } = await indexRun(fx, `evt-int-plain-${answer}`, answer, 40);

      expect(fakeOrchestrator.provisioned).toHaveLength(MAX_DISPATCH_ATTEMPTS);
      expect(error?.message).toContain(
        `(upload_failed) after ${MAX_DISPATCH_ATTEMPTS} dispatch attempts`,
      );
      expect(await refusalColumns()).toEqual({
        indexRefusedSizeBytes: null,
        indexRefusedCapBytes: null,
        indexRefusedAt: null,
      });
      expect((await codeRow(fx, fx.projectIds[0]!))?.graphTooLarge).toBeNull();
    },
    60_000,
  );

  it('8 · a repository shared by two projects shows the refusal on BOTH projects’ rows', async () => {
    const fx = await seedIndexWorkspace('int-shared', 2);

    await indexRun(fx, 'evt-int-shared', 'refused', 40);

    for (const projectId of fx.projectIds) {
      expect(await codeRow(fx, projectId)).toMatchObject({
        graphTooLarge: { sizeBytes: REFUSED_SIZE, capBytes: GIB },
      });
    }
  }, 60_000);
});
