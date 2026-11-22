import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { fleetCodeGraphIndex as codeGraphIndex } from '../helpers/fleetIndexJobs';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { fakeOrchestrator } from '@motir/orchestrator';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  containerExitsWith,
  INDEX_REPO_REF,
  indexEventFor,
  driveIndexFleetFast,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE FAN-OUT IS RETIRED (MOTIR-4652 · Story MOTIR-4642 ·
// `docs/decisions/code-graph-index-fan-out.md`, MOTIR-2029).
//
// One repository connected in an organisation used to boot ONE CONTAINER PER
// PROJECT of its workspace, producing byte-identical graphs. The waste landed on
// both sides: the organisation's index allowance was drawn once per project, and
// Motir's own container time was spent once per project, for one output. The
// multiplier was live in `moooon`.
//
// ⚠️ THE ASSERTION IS A FIXED NUMBER, NOT A RATIO. "fewer containers than
// projects" would pass on a fan-out that had merely been narrowed, and would go
// on passing if it widened again to two. The number is ONE.

const REBUILD = { indexMode: 'rebuild' as const };

/** The seeded workspace's organisation — the tenant the graph is keyed to now. */
async function organizationOf(workspaceId: string): Promise<string> {
  const row = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  return row.organizationId;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  stubIndexFleet();
  // The supervision loop is a real `await` since MOTIR-3484, so a job-level test
  // would otherwise sleep at the shipped cadence.
  driveIndexFleetFast();
  containerExitsWith(0);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

describe('ONE container per (organisation, repoRef)', () => {
  it('an organisation with THREE projects boots exactly ONE container', async () => {
    // The card's central criterion. Three projects, one repository, one container.
    const seeded = await seedIndexWorkspace('fanout3', 3);
    expect(seeded.projectIds).toHaveLength(3);

    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphIndex });
    await engine.execute({
      events: [
        indexEventFor({ installationId: seeded.installationId, workspaceId: seeded.workspaceId }),
      ],
    });

    // EXACTLY one boot. Under the old shape this was three.
    const distinct = new Set(boot.mock.calls.map((call) => JSON.stringify(call[0])));
    expect(distinct.size).toBe(1);
  });

  it('the dispatched payload carries the ORGANISATION', async () => {
    // Read back off the payload rather than inferred from the count: a single
    // dispatch that still named a project as its tenant would satisfy the test
    // above and leave the graph keyed to the wrong thing.
    const seeded = await seedIndexWorkspace('fanoutorg', 2);
    const organizationId = await organizationOf(seeded.workspaceId);
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphIndex });
    await engine.execute({
      events: [
        indexEventFor({ installationId: seeded.installationId, workspaceId: seeded.workspaceId }),
      ],
    });

    const payload = boot.mock.calls[0]?.[0];
    expect(payload?.organizationId).toBe(organizationId);
  });

  it('`projectsIndexed` is 1 — the count of containers, which is now a constant', async () => {
    // ⚠️ ITS MEANING CHANGED AND THE FIELD DID NOT. It counted the fan-out; there
    // is one dispatch now, so it is always 1. Kept rather than retired because
    // historical `job_run.output` rows carry other values (`projectsIndexed: 2`)
    // and a reader meeting one needs somewhere to learn what it meant — and
    // because nothing in production reads it: `listSucceededCodeGraphIndexRepoRefs`
    // builds its set from `output.repoRef` alone.
    const seeded = await seedIndexWorkspace('fanoutcount', 3);

    const engine = new JobTestEngine({ function: codeGraphIndex });
    const { result } = await engine.execute({
      events: [
        indexEventFor({ installationId: seeded.installationId, workspaceId: seeded.workspaceId }),
      ],
    });

    expect(result).toMatchObject({ indexed: true, repoRef: INDEX_REPO_REF, projectsIndexed: 1 });
  });
});

describe('⚠️ `no_projects` SURVIVED, and its meaning narrowed', () => {
  it('an organisation with ZERO projects still skips — and the reason is the CREDENTIAL, not the graph', async () => {
    // ⚠️ THIS CARD ASKED FOR `no_projects` TO BE RETIRED AND FOR A ZERO-PROJECT
    // ORGANISATION TO INDEX. IT CANNOT, AND THE REASON IS IN THE OTHER REPOSITORY.
    //
    // The premise of the request is right: the organisation owns the graph, so it
    // is worth building whether or not a project reads it yet. What still needs a
    // project is the RUN CREDENTIAL — motir-ai's `IssueRunCredentialInput` has
    // `coreProjectId: string`, required, and `issueRunCredential` resolves the
    // `AiProject` spine through `findOrCreateByCoreIds` before minting.
    // MOTIR-4656 changed what that credential is SCOPED to (the organisation) and
    // deliberately did not change what it is RESOLVED FROM.
    //
    // So this verdict is still the honest answer, with a narrower meaning: not
    // "there is nowhere to put N graphs" but "there is no project to resolve a
    // run credential through". Asserted rather than left implicit, so the day
    // motir-ai accepts a `coreOrganizationId` alone, this test fails and names
    // what to delete.
    const seeded = await seedIndexWorkspace('fanoutzero', 1);
    await adminDb.project.deleteMany({ where: { workspaceId: seeded.workspaceId } });

    const target = await codeGraphIndexService.resolveIndexTarget({
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
      repoOwner: 'moooon',
      repoName: 'motir-core',
      defaultBranch: 'main',
      ...REBUILD,
    });

    expect(target).toEqual({ indexed: false, reason: 'no_projects' });
  });

  it('a HISTORICAL ledger row carrying the reason is still readable', async () => {
    // The enum-retirement hazard the card warned about, checked rather than
    // assumed — and the finding is that there is nothing to sweep. `job_run.output`
    // is stored JSON and NOTHING switches on `reason`: the only production reader,
    // `listSucceededCodeGraphIndexRepoRefs`, selects `output` and tests
    // `typeof output.repoRef === 'string'`, ignoring the reason entirely. So a row
    // written years ago reads back without a lookup going partial.
    const seeded = await seedIndexWorkspace('fanouthist', 1);
    await adminDb.jobRun.create({
      data: {
        id: 'historical-no-projects-row',
        workspaceId: seeded.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: 'evt-historical-no-projects-row',
        lane: 'engine',
        attempt: 1,
        status: 'succeeded',
        output: { indexed: false, reason: 'no_projects' },
      },
    });

    const rows = await adminDb.jobRun.findMany({
      where: { id: 'historical-no-projects-row' },
      select: { output: true },
    });
    expect(rows[0]?.output).toEqual({ indexed: false, reason: 'no_projects' });
  });
});
