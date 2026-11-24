import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { fakeOrchestrator, type AwsSessionCredentials, type Ec2Api } from '@motir/orchestrator';
import { Prisma, type FleetShard, type JobQueueRun } from '@/generated/prisma/client';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { hostMonthlyPlanCredits } from '@/lib/billing/catalog';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { hostAccountPlan } from '@/lib/ciFleet/hostAccounts';
import { MERGED_AGENT_CEILING, mergedAccountSplit } from '@/lib/ciFleet/hostMergedAccountSplit';
import { AI_PLAN_INDEX_PAUSE_REASON, indexPauseReasonFor } from '@/lib/ciFleet/indexAllowance';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import { db } from '@/lib/db';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import type { RepoTarballUrlResolver } from '@/lib/git';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobWorker } from '@/lib/jobs/engine/worker';
import '@/lib/jobs/registry';
import { ciContainerUsageRepository } from '@/lib/repositories/ciContainerUsageRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { codeGraphIndexAllowanceService } from '@/lib/services/codeGraphIndexAllowanceService';
import { codeGraphIndexCatchUpService } from '@/lib/services/codeGraphIndexCatchUpService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { fleetQuotaRaiseService } from '@/lib/services/fleetQuotaRaiseService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetShardProvisioningService } from '@/lib/services/fleetShardProvisioningService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import {
  hostAccountReconcileService,
  type HostReconcileDeps,
} from '@/lib/services/hostAccountReconcileService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { withSystemContext } from '@/lib/workspaces/context';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import {
  ADD_SHARD_ENTERPRISE_SLUG,
  FakeOrganization,
  POOL_DEFINITION,
  buildStacksInto,
  installAddShardGithub,
  newGithubWorld,
  stubPoolDefinitionEnv,
} from '../helpers/addShardFakes';
import { adminDb } from '../helpers/adminDb';
import { stubAwsManagementCredential } from '../helpers/awsRunnerRoleFake';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  HANDOFF_AI_PATHS,
  HANDOFF_HEAD,
  HANDOFF_OLDER,
  handoffWorld,
  presignedUrlFor,
  stubIndexHandoff,
} from '../helpers/indexHandoff';
import { seedIndexWorkspace, type SeededIndexWorkspace } from '../helpers/indexFleet';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';
import { randomInt, randomToken } from '../helpers/random';
import {
  allowRetiredFleetKind,
  RETIRED_CAPACITY_PAUSES,
  RETIRED_FLEET_KIND,
  refuseRetiredFleetKind,
} from '../helpers/retiredFleetKind';

// THE RETIREMENT GATE (MOTIR-12042 · Story MOTIR-11026).
//
// The story retired motir-core's container indexer across seven cards: the
// allowance ask moved (MOTIR-12035), admission, dispatch and the two capacity
// pauses were deleted (MOTIR-12036), the index boot paths and image pin went
// (MOTIR-12037), the merged host account was re-homed onto its agent row
// (MOTIR-12038), billing and the surfaces dropped their indexer reads
// (MOTIR-12039, MOTIR-12040), and the `code_graph_index` kind itself left the
// workload set and the database (MOTIR-12041). Each card tested its own change;
// this suite tests the SEAMS between them, on the merged code, against real
// Postgres, with motir-ai, GitHub and AWS stubbed only at the HTTP boundary:
//
//   1. the handoff still asks `askIndexAllowance` at its new home and mints its
//      source URL through `requireRepoTarballUrlResolver`;
//   2. a repository left paused by a deleted capacity reason is re-asked;
//   3. a provisioning replay finds the re-homed merged account;
//   4. the re-home and the retirement migrations, run in order over a database
//      as it stood before them, leave no row of the retired kind;
//   5. nothing in the tree imports a deleted module or symbol, or names the kind
//      outside its kept hits — in `code-graph-index-retirement-architecture.test.ts`,
//      split out so the docs-guard lane can run it with no database.
//
// The indexing story's own gate (`tests/jobs/code-graph-handoff-story-gate.test.ts`,
// MOTIR-11887) runs in the same Vitest lane; the pull request carries its diff.

// ── the mint, observed at the module the handoff imports it from ─────────────

const mint = vi.hoisted(() => ({
  /** Every resolver `requireRepoTarballUrlResolver` handed out, as it was called. */
  calls: [] as unknown[][],
}));
vi.mock('@/lib/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/git')>();
  return {
    ...real,
    requireRepoTarballUrlResolver: (
      provider: Parameters<typeof real.requireRepoTarballUrlResolver>[0],
    ): RepoTarballUrlResolver => {
      const resolve = real.requireRepoTarballUrlResolver(provider);
      return (async (...args: Parameters<RepoTarballUrlResolver>) => {
        mint.calls.push(args);
        return resolve(...args);
      }) as RepoTarballUrlResolver;
    },
  };
});

const CODE_GRAPH_JOBS = ['system.code-graph-index', 'system.code-graph-refresh'];
const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma/migrations');
/** The two migrations of this story, found by name: the sibling cards created them. */
const REHOME_MIGRATION = migrationNamed('_merged_host_account_rehome');
const RETIRE_MIGRATION = migrationNamed('_retire_code_graph_index_fleet_kind');
const LIVE_KINDS = ['ci_runner', 'hosted_agent', 'agent_instance'] as const;

function migrationNamed(suffix: string): string {
  const hits = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(suffix));
  if (hits.length !== 1) throw new Error(`expected one migration *${suffix}, found ${hits}`);
  return hits[0]!;
}

/** Run one migration file as one script on one session, as the table owner —
 *  exactly as `prisma migrate deploy` runs it. */
async function runMigration(directory: string): Promise<void> {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, directory, 'migration.sql'), 'utf8');
  const client = new Client({ connectionString: currentWorkerAdminUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Both migrations, in their directory order. */
async function runStoryMigrations(): Promise<void> {
  for (const directory of [REHOME_MIGRATION, RETIRE_MIGRATION].sort()) {
    await runMigration(directory);
  }
}

async function clearFleet(): Promise<void> {
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.fleetGrowthEvent.deleteMany({});
  await adminDb.fleetCapacityRequest.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.agentInstance.deleteMany({});
  await adminDb.dispatchRun.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await adminDb.platformFleetKindSwitch.deleteMany({});
  await adminDb.ciContainerUsage.deleteMany({});
}

afterAll(async () => {
  // Whatever a case left, the worker's database ends in the shape the
  // retirement migration leaves: no row of the kind, the three-kind CHECKs.
  await clearFleet();
  await refuseRetiredFleetKind();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ══ 1–2. THE HANDOFF AND THE CATCH-UP ═════════════════════════════════════════

describe('the handoff and the catch-up sweep, after every deletion', () => {
  let seq = 0;
  const slug = (name: string) => `retire-gate-${name}-${(seq += 1)}`;

  const worker = () =>
    new JobWorker({
      workerId: `retire-gate-${seq}`,
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

  /** Run every queued code-graph run to a terminal state; never sleeps (a
   *  deferral is a row with a later `runAt`, which the drain makes due). */
  async function drain(): Promise<void> {
    const w = worker();
    for (let pass = 0; pass < 60; pass += 1) {
      const live = await adminDb.jobQueueRun.count({
        where: { jobId: { in: CODE_GRAPH_JOBS }, state: { in: ['pending', 'running'] } },
      });
      if (live === 0) return;
      await adminDb.jobQueueRun.updateMany({
        where: { jobId: { in: CODE_GRAPH_JOBS }, state: 'pending' },
        data: { runAt: new Date(Date.now() - 1_000) },
      });
      await adminDb.jobQueueRun.updateMany({
        where: { jobId: { notIn: CODE_GRAPH_JOBS }, state: 'pending' },
        data: { runAt: new Date(Date.now() + 86_400_000) },
      });
      await w.tick();
      await w.settled();
    }
    throw new Error('drain: the code-graph runs did not settle in 60 passes');
  }

  const repoRow = (name = 'motir-core') =>
    adminDb.githubRepo.findFirstOrThrow({ where: { owner: 'moooon', name } });

  const organizationOf = async (seeded: SeededIndexWorkspace) =>
    (await adminDb.workspace.findUniqueOrThrow({ where: { id: seeded.workspaceId } }))
      .organizationId;

  async function stamp(data: Prisma.GithubRepoUpdateManyMutationInput, name = 'motir-core') {
    await adminDb.githubRepo.updateMany({ where: { owner: 'moooon', name }, data });
  }

  /** The bind / reconcile gate's first index of the seeded repository. */
  async function firstIndex(seeded: SeededIndexWorkspace): Promise<void> {
    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
      repos: [
        {
          providerRepoId: (await repoRow()).repoId,
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await drain();
  }

  /** A graph published at `HANDOFF_OLDER`, then a default-branch push to the head —
   *  the refresh job. */
  async function refreshAfterPush(name: string): Promise<SeededIndexWorkspace> {
    const seeded = await seedIndexWorkspace(slug(name), 1);
    await adminDb.jobRun.create({
      data: {
        workspaceId: seeded.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: `evt-seed-${name}-${seq}`,
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        output: {
          indexed: true,
          repoRef: 'moooon/motir-core',
          projectsIndexed: 1,
          indexedBy: 'motir-codegraph',
        },
      },
    });
    await stamp({ indexedAt: new Date('2026-11-01T00:00:00Z'), indexedHeadSha: HANDOFF_OLDER });
    handoffWorld.compare = { files: [{ filename: 'src/a.ts', status: 'modified' }] };
    const res = await githubWebhookService.handleEvent('push', {
      ref: 'refs/heads/main',
      after: HANDOFF_HEAD,
      repository: { id: Number((await repoRow()).repoId) },
      installation: { id: seeded.installationId },
    });
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    await drain();
    return seeded;
  }

  let ask: MockInstance<typeof codeGraphIndexAllowanceService.askIndexAllowance>;

  beforeEach(async () => {
    await truncateAuthTables();
    await truncateJobRuns();
    _resetInstallationTokenCache();
    fakeOrchestrator.reset();
    stubIndexHandoff();
    mint.calls.length = 0;
    // On the allowance's NEW home: a handoff that skipped the ask fails here.
    ask = vi.spyOn(codeGraphIndexAllowanceService, 'askIndexAllowance');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // No fleet after every case: no container, no spec, and motir-ai asked
    // nothing but the handoff world's paths — so no run credential and no pool read.
    expect(fakeOrchestrator.provisioned, 'no container is provisioned').toEqual([]);
    expect(fakeOrchestrator.specs, 'no container spec is built').toEqual([]);
    expect(handoffWorld.aiPaths.filter((p) => !HANDOFF_AI_PATHS.includes(p))).toEqual([]);
    // Every mint was at a handed commit, and every handoff carries its mint's URL.
    const handed = handoffWorld.handoffs.map((h) => String(h['commitSha']));
    expect(mint.calls.map((call) => call[3])).toEqual(handed);
    for (const handoff of handoffWorld.handoffs) {
      expect(handoff['sourceUrl']).toBe(presignedUrlFor(String(handoff['commitSha'])));
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('an allowed job', () => {
    it('index: asks askIndexAllowance once for the organisation, mints through requireRepoTarballUrlResolver at the head, hands off once', async () => {
      const seeded = await seedIndexWorkspace(slug('index'), 1);

      await firstIndex(seeded);

      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledWith(await organizationOf(seeded));
      expect(mint.calls).toEqual([[seeded.installationId, 'moooon', 'motir-core', HANDOFF_HEAD]]);
      expect(handoffWorld.tarballRefs).toEqual([HANDOFF_HEAD]);
      expect(handoffWorld.handoffs).toEqual([
        expect.objectContaining({
          kind: 'first_index',
          commitSha: HANDOFF_HEAD,
          repoRef: 'moooon/motir-core',
          sourceUrl: presignedUrlFor(HANDOFF_HEAD),
        }),
      ]);
      expect((await repoRow()).indexedHeadSha).toBe(HANDOFF_HEAD);
    });

    it('refresh: the same ask, the same mint at the pushed head, one handoff', async () => {
      const seeded = await refreshAfterPush('refresh');

      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledWith(await organizationOf(seeded));
      expect(mint.calls).toEqual([[seeded.installationId, 'moooon', 'motir-core', HANDOFF_HEAD]]);
      expect(handoffWorld.handoffs).toEqual([
        expect.objectContaining({
          kind: 'push',
          commitSha: HANDOFF_HEAD,
          previousCommitSha: HANDOFF_OLDER,
        }),
      ]);
    });

    it('a null allowance (motir-ai could not be asked) is not a stop: the job hands off', async () => {
      const seeded = await seedIndexWorkspace(slug('null'), 1);
      const world = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (new URL(String(url)).pathname === '/v1/credits/index-check') {
            handoffWorld.aiPaths.push('/v1/credits/index-check');
            return new Response('unavailable', { status: 503 });
          }
          return world(url, init);
        }),
      );

      await firstIndex(seeded);

      expect(ask).toHaveBeenCalledTimes(1);
      await expect(ask.mock.results[0]!.value).resolves.toEqual({ proceed: true, outcome: null });
      expect(handoffWorld.handoffs).toHaveLength(1);
      expect((await repoRow()).indexPausedReason).toBeNull();
    });
  });

  describe('a stopped job sends nothing', () => {
    const HARD_STOP = 'hard_stop_allowance_exhausted';

    it.each(['index', 'refresh'] as const)(
      '%s at an allowance hard stop: paused with the reason the allowance maps it to, no mint, no handoff',
      async (job) => {
        handoffWorld.allowanceOutcome = HARD_STOP;
        if (job === 'index') await firstIndex(await seedIndexWorkspace(slug('stop'), 1));
        else await refreshAfterPush('stop');

        expect(ask).toHaveBeenCalledTimes(1);
        expect((await repoRow()).indexPausedReason).toBe(indexPauseReasonFor(HARD_STOP));
        expect(indexPauseReasonFor(HARD_STOP)).toBe('paused_index_allowance_exhausted');
        expect(handoffWorld.handoffs).toEqual([]);
        expect(handoffWorld.tarballRefs).toEqual([]);
        expect(mint.calls).toEqual([]);
      },
    );

    it('no paid AI plan: paused with AI_PLAN_INDEX_PAUSE_REASON, no handoff', async () => {
      vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);

      await firstIndex(await seedIndexWorkspace(slug('noplan'), 1));

      expect(AI_PLAN_INDEX_PAUSE_REASON).toBe('paused_index_ai_plan_required');
      expect((await repoRow()).indexPausedReason).toBe(AI_PLAN_INDEX_PAUSE_REASON);
      expect(handoffWorld.handoffs).toEqual([]);
      expect(mint.calls).toEqual([]);
    });
  });

  describe('a repository paused by a deleted capacity reason', () => {
    const [POOL_FULL, NO_ACCOUNT] = RETIRED_CAPACITY_PAUSES;

    async function seedCapacityPaused(): Promise<SeededIndexWorkspace> {
      const seeded = await seedIndexWorkspace(slug('capacity'), 1, [
        { owner: 'moooon', name: 'pool-full' },
        { owner: 'moooon', name: 'no-account' },
      ]);
      await stamp({ indexPausedReason: POOL_FULL, indexPausedAt: new Date() }, 'pool-full');
      await stamp({ indexPausedReason: NO_ACCOUNT, indexPausedAt: new Date() }, 'no-account');
      return seeded;
    }

    it('is re-asked by the catch-up sweep and, allowed, handed off again with its pause cleared', async () => {
      const seeded = await seedCapacityPaused();
      const organizationId = await organizationOf(seeded);

      const summary = await codeGraphIndexCatchUpService.catchUp();
      expect(summary.organizationsAsked).toBe(1);
      expect(
        summary.outcomes
          .map((o) => [o.repoRef, o.outcome])
          .sort((a, b) => a[0]!.localeCompare(b[0]!)),
      ).toEqual([
        ['moooon/no-account', 'index_enqueued'],
        ['moooon/pool-full', 'index_enqueued'],
      ]);
      await drain();

      const byRepo = handoffWorld.handoffs.map((h) => [h['repoRef'], h['kind']]).sort();
      expect(byRepo).toEqual([
        ['moooon/no-account', 'first_index'],
        ['moooon/pool-full', 'first_index'],
      ]);
      expect((await repoRow('pool-full')).indexPausedReason).toBeNull();
      expect((await repoRow('no-account')).indexPausedReason).toBeNull();
      // The sweep asked the allowance (once, for the org); each job asked again.
      expect(handoffWorld.aiPaths.filter((p) => p === '/v1/credits/index-check')).toHaveLength(3);
      expect(ask.mock.calls.every(([id]) => id === organizationId)).toBe(true);
    });

    it('stays paused at a hard stop, and the sweep reports it as still stopped', async () => {
      await seedCapacityPaused();
      handoffWorld.allowanceOutcome = 'hard_stop_allowance_exhausted';

      const summary = await codeGraphIndexCatchUpService.catchUp();
      await drain();

      expect(summary.scanned).toBe(2);
      expect(summary.outcomes.map((o) => o.outcome)).toEqual(['still_stopped', 'still_stopped']);
      expect(await adminDb.jobQueueRun.count({ where: { jobId: { in: CODE_GRAPH_JOBS } } })).toBe(
        0,
      );
      expect(handoffWorld.handoffs).toEqual([]);
      expect((await repoRow('pool-full')).indexPausedReason).toBe(POOL_FULL);
      expect((await repoRow('no-account')).indexPausedReason).toBe(NO_ACCOUNT);
    });
  });
});

// ══ 3. THE PROVISIONING REPLAY ════════════════════════════════════════════════

describe('a provisioning replay over a re-homed merged account', () => {
  const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';
  let AwsEc2Fake: new () => Ec2Api;
  const GITHUB_ORG = 'motir-fleet-use1-1';
  const TEMPLATE = 'aws+{name}@motir.co';
  const SESSION: AwsSessionCredentials = {
    accessKeyId: 'ASIA_SESSION_12042_never_printed',
    secretAccessKey: 'SESSION_SECRET_12042_never_printed',
    sessionToken: 'SESSION_TOKEN_12042_never_printed',
    expiration: null,
  };
  const T0 = new Date('2026-11-23T12:00:00Z');
  let organization: FakeOrganization;
  let unregister: () => void;

  const deps = (): HostReconcileDeps => ({
    now: () => T0,
    alert: () => undefined,
    capsFor: async () => ({
      kind: 'capped',
      planKey: HOST_PLAN_KEY,
      planName: 'Host',
      caps: capsForPlanKey(HOST_PLAN_KEY)!,
    }),
    provisioning: {
      raise: { management: () => organization, now: () => T0 },
      env: { ...process.env, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE },
    },
  });
  const raiseDeps = () => ({ management: () => organization, now: () => T0 });
  const creates = () => organization.calls.filter((c) => c === 'createOrganizationAccount');

  beforeAll(async () => {
    ({ AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
      AwsEc2Fake: new () => Ec2Api;
    });
  });

  beforeEach(async () => {
    await clearFleet();
    await truncateAuthTables();
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '4445390');
    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
    vi.stubEnv('GITHUB_ENTERPRISE_SLUG', ADD_SHARD_ENTERPRISE_SLUG);
    stubAwsManagementCredential();
    stubPoolDefinitionEnv();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    _resetInstallationTokenCache();
    _resetProvisioningInstallationCache();
    const github = newGithubWorld();
    github.orgs.add(GITHUB_ORG);
    organization = new FakeOrganization(SESSION);
    const ec2 = new AwsEc2Fake();
    buildStacksInto(organization, () => ec2);
    organization.quota = 5;
    installAddShardGithub(github, 'ghs_INSTALL_SECRET_12042_never_printed');
    unregister = registerShardProvisioningProvider(
      createAwsShardProvisioningProvider({
        management: () => organization,
        ec2: () => ec2,
        env: () => process.env,
      }),
    );
    await createTestUser({ email: MOTIR_SYSTEM_USER_EMAIL });
    const primaries = [
      ['ci-runner-use1-1', 'ci_runner', '111122223331'],
      ['hosted-agent-use1-1', 'hosted_agent', '111122223332'],
      ['agent-host-use1-1', 'agent_instance', '111122223334'],
    ] as const;
    for (const [name, fleetKind, awsAccountId] of primaries) {
      await fleetShardService.createShard({
        name,
        fleetKind,
        provider: 'aws',
        state: 'active',
        githubOrg: GITHUB_ORG,
        githubInstallationId: '9001',
        awsAccountId,
        awsRegion: 'us-east-1',
        credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
        limits: { vcpuQuota: 640 },
      });
    }
  });

  afterEach(() => {
    unregister();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('recomputes the slot name, finds the account, creates nothing, keeps one agent row, and caps agents at the whole grant', async () => {
    // A Host organisation's merged account, created as the code before the story
    // created it: the index row carrying the raise, and its agent twin.
    await allowRetiredFleetKind();
    const org = await adminDb.organization.create({
      data: { name: 'Gate host', slug: `retire-gate-host-${Date.now()}`, aiIncludedSeat: true },
    });
    await hostAccountReconcileService.runReconcile(deps());
    const slotName = hostAccountPlan(org.id, 'merged', hostMonthlyPlanCredits()).account.name;
    const created = await adminDb.fleetShard.findUniqueOrThrow({ where: { name: slotName } });
    await adminDb.fleetShard.update({
      where: { id: created.id },
      data: { fleetKind: RETIRED_FLEET_KIND },
    });
    await adminDb.fleetQuotaRequest.updateMany({
      where: { shardId: created.id },
      data: { fleetKind: RETIRED_FLEET_KIND },
    });
    const twin = await adminDb.fleetShard.create({
      data: {
        name: slotName.replace(/-index$/, '-agent-host'),
        fleetKind: 'agent_instance',
        provider: 'aws',
        role: 'org_owned',
        ownerOrganizationId: org.id,
        state: 'provisioning',
        githubOrg: created.githubOrg,
        githubInstallationId: created.githubInstallationId,
        awsAccountId: created.awsAccountId,
        awsRegion: created.awsRegion,
        credentialRef: created.credentialRef,
      },
    });
    organization.accountUnits.set(
      created.awsAccountId!,
      POOL_DEFINITION.unitId(RETIRED_FLEET_KIND),
    );
    const createsBefore = creates().length;

    // Both migrations of the story, in order.
    await runStoryMigrations();

    // The replay of the merged slot.
    const replay = await fleetShardProvisioningService.addOrgOwnedShard(
      { organizationId: org.id, slot: 'merged', planKey: HOST_PLAN_KEY },
      deps().provisioning,
    );
    const outcome = (step: string) => replay.steps.find((s) => s.step === step)?.outcome;
    expect(hostAccountPlan(org.id, 'merged', hostMonthlyPlanCredits()).account.name).toBe(slotName);
    expect(outcome('provider_account')).toBe('already');
    expect(outcome('account_row')).toBe('already');
    expect(outcome('quota_raise')).toBe('already');
    expect(creates()).toHaveLength(createsBefore);

    const onAccount = await adminDb.fleetShard.findMany({
      where: { awsAccountId: created.awsAccountId },
    });
    expect(onAccount).toEqual([
      expect.objectContaining({
        id: twin.id,
        name: slotName,
        fleetKind: 'agent_instance',
        ownerOrganizationId: org.id,
      }),
    ]);

    // The agent cap is the whole grant, in 2 vCPU spots, up to the ceiling.
    const caps: number[] = [];
    for (const granted of [40, 100, 200]) {
      let open = await adminDb.fleetQuotaRequest.findFirst({
        where: { shardId: twin.id, closedAt: null },
      });
      if (!open) {
        await fleetQuotaRaiseService.fileRaise(twin.id, granted, raiseDeps());
        open = await adminDb.fleetQuotaRequest.findFirstOrThrow({
          where: { shardId: twin.id, closedAt: null },
        });
      }
      organization.settleQuotaRequest(open.awsRequestId, 'APPROVED', granted);
      await fleetQuotaRaiseService.refreshOpenRequests(undefined, raiseDeps());
      const row = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: twin.id } });
      caps.push(
        await withSystemContext((tx) => fleetShardAdmissionService.ownCeilingInTx(row, tx)),
      );
      // The split names one figure: no spot is kept for an index kind.
      expect(Object.keys(mergedAccountSplit(granted))).toEqual(['agentCap']);
    }
    expect(caps).toEqual([20, 50, 50]);
    expect(MERGED_AGENT_CEILING).toBe(50);
    expect(
      await adminDb.fleetQuotaRequest.count({ where: { fleetKind: RETIRED_FLEET_KIND } }),
    ).toBe(0);
  });
});

// ══ 4. THE MIGRATION CHAIN ════════════════════════════════════════════════════

describe('the re-home and the retirement migrations, in order, over a pre-story database', () => {
  const T = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes));
  const LATER = new Date(Date.UTC(2027, 0, 1));
  const awsId = () => String(randomInt(100_000_000_000, 999_999_999_999));

  function shard(
    name: string,
    fleetKind: string,
    extra: Partial<Prisma.FleetShardUncheckedCreateInput> = {},
  ): Promise<FleetShard> {
    return adminDb.fleetShard.create({
      data: {
        name,
        fleetKind,
        provider: 'aws',
        role: 'primary',
        state: 'active',
        githubOrg: 'motir-fleet-use1-1',
        githubInstallationId: '9001',
        awsAccountId: awsId(),
        awsRegion: 'us-east-1',
        credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
        vcpuQuota: 120,
        ...extra,
      },
    });
  }

  function raise(on: FleetShard, granted: number) {
    return adminDb.fleetQuotaRequest.create({
      data: {
        shardId: on.id,
        fleetKind: on.fleetKind,
        quotaCode: 'L-1216C47A',
        desiredValue: 120,
        awsRequestId: `req-${randomToken(6)}`,
        status: 'approved',
        grantedValue: granted,
        closedAt: T(2),
      },
    });
  }

  /** A merged account as the code before the story wrote it: an `org_owned`
   *  index row carrying the account, its location, credential and raise. */
  const mergedIndexRow = (organizationId: string) =>
    shard(`host-${organizationId.toLowerCase()}-index`, RETIRED_FLEET_KIND, {
      role: 'org_owned',
      ownerOrganizationId: organizationId,
      awsRegion: 'us-west-2',
      credentialRef: 'FLEET_SHARD_HOST_INDEX',
      limitsSource: { vcpuQuota: 'raised' },
      limitsVerifiedAt: T(5),
      quotaRequestedAt: T(1),
      grantedAt: T(2),
      liveAt: T(3),
    });

  async function seed() {
    // A Host organisation whose merged account has its agent twin.
    const withTwin = await makeWorkItemFixture({
      name: 'Twin',
      identifier: `GT${randomInt(10, 100)}`,
    });
    const twinOrg = withTwin.workspace.organizationId;
    const index = await mergedIndexRow(twinOrg);
    const twin = await shard(`host-${twinOrg.toLowerCase()}-agent-host`, 'agent_instance', {
      role: 'org_owned',
      ownerOrganizationId: twinOrg,
      state: 'provisioning',
      awsAccountId: index.awsAccountId,
      credentialRef: 'FLEET_SHARD_STALE_COPY',
    });
    const twinRaise = await raise(index, 120);
    const twinCapacity = await adminDb.fleetCapacityRequest.create({
      data: {
        organizationId: twinOrg,
        shardId: index.id,
        awsAccountId: index.awsAccountId!,
        fleetKind: RETIRED_FLEET_KIND,
        desiredVcpu: 200,
        reasonMd: 'more index room',
        status: 'closed',
        closedAt: T(4),
        closedNote: 'done',
        requestedByUserId: withTwin.ownerId,
      },
    });

    // A Host organisation whose merged account never got its twin.
    const solo = await makeWorkItemFixture({ name: 'Solo', identifier: `GS${randomInt(10, 100)}` });
    const soloOrg = solo.workspace.organizationId;
    const twinless = await mergedIndexRow(soloOrg);
    const soloRaise = await raise(twinless, 40);
    const soloCapacity = await adminDb.fleetCapacityRequest.create({
      data: {
        organizationId: soloOrg,
        shardId: twinless.id,
        awsAccountId: twinless.awsAccountId!,
        fleetKind: RETIRED_FLEET_KIND,
        desiredVcpu: 100,
        reasonMd: 'more',
        requestedByUserId: solo.ownerId,
      },
    });

    // The retired kind's platform pool and its switch.
    const pool = await shard('indexer-use1-1', RETIRED_FLEET_KIND);
    await raise(pool, 640);
    await adminDb.fleetInFlightSlot.create({
      data: {
        workload: RETIRED_FLEET_KIND,
        ref: `index-${randomToken(6)}`,
        organizationId: soloOrg,
        workspaceId: solo.workspaceId,
        fleetShardId: pool.id,
        expiresAt: LATER,
      },
    });
    await adminDb.fleetGrowthEvent.create({
      data: {
        fleetKind: RETIRED_FLEET_KIND,
        triggeringShardId: pool.id,
        vcpuInUse: 90,
        grantedQuota: 640,
        outcome: 'account_created',
      },
    });
    await adminDb.platformFleetKindSwitch.create({
      data: { fleetKind: RETIRED_FLEET_KIND, onPool: true, lastReason: 'indexer on AWS' },
    });

    // Past index billing usage, on a table that carries no fleet_kind CHECK.
    const handleId = `machine-index-${randomToken(6)}`;
    const usage = await adminDb.ciContainerUsage.create({
      data: {
        containerProvider: 'fly',
        handleId,
        containerRegion: 'iad',
        workspaceId: solo.workspaceId,
        organizationId: soloOrg,
        workload: 'index',
        repoFullName: 'acme/web',
        cpuKind: 'performance',
        cpus: 2,
        memoryMb: 4096,
        containerCreatedAt: T(0),
        containerStartedAt: T(0),
        containerStoppedAt: T(30),
        billableSeconds: 1800,
        periodStart: new Date(Date.UTC(2026, 10, 1)),
        usdPerSecond: new Prisma.Decimal('0.000031636049'),
        costUsd: new Prisma.Decimal('0.056944888200'),
        rateEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
        terminalState: 'destroyed',
        teardownReason: 'job_completed',
      },
    });

    return {
      index,
      twin,
      twinRaise,
      twinCapacity,
      twinless,
      soloRaise,
      soloCapacity,
      pool,
      usage,
      handleId,
    };
  }

  beforeEach(async () => {
    await clearFleet();
    await truncateAuthTables();
    // The database as it stood before the story's two migrations: four kinds.
    await allowRetiredFleetKind();
  });

  afterEach(async () => {
    await clearFleet();
    await refuseRetiredFleetKind();
  });

  it('runs the re-home before the retirement, by directory order', () => {
    expect(REHOME_MIGRATION < RETIRE_MIGRATION).toBe(true);
  });

  it('leaves no row of the kind but the merged accounts’ past capacity requests, each agent row holding what its index row held, and past usage readable', async () => {
    const s = await seed();

    await runStoryMigrations();

    const where = { fleetKind: RETIRED_FLEET_KIND };
    expect(await adminDb.fleetShard.count({ where })).toBe(0);
    expect(await adminDb.fleetQuotaRequest.count({ where })).toBe(0);
    expect(await adminDb.fleetGrowthEvent.count({ where })).toBe(0);
    expect(await adminDb.platformFleetKindSwitch.count({ where })).toBe(0);
    expect(await adminDb.fleetInFlightSlot.count({ where: { workload: RETIRED_FLEET_KIND } })).toBe(
      0,
    );
    expect(await adminDb.fleetShard.findUnique({ where: { id: s.pool.id } })).toBeNull();
    expect(await adminDb.fleetShard.findUnique({ where: { id: s.index.id } })).toBeNull();

    // The twin holds what its index row held.
    expect(await adminDb.fleetShard.findUniqueOrThrow({ where: { id: s.twin.id } })).toMatchObject({
      fleetKind: 'agent_instance',
      name: s.index.name,
      awsAccountId: s.index.awsAccountId,
      awsRegion: 'us-west-2',
      credentialRef: 'FLEET_SHARD_HOST_INDEX',
      vcpuQuota: 120,
      limitsSource: { vcpuQuota: 'raised' },
      limitsVerifiedAt: T(5),
      quotaRequestedAt: T(1),
      grantedAt: T(2),
      liveAt: T(3),
      state: 'active',
    });
    // The twinless row is the agent row, same id and account.
    expect(
      await adminDb.fleetShard.findUniqueOrThrow({ where: { id: s.twinless.id } }),
    ).toMatchObject({
      fleetKind: 'agent_instance',
      name: s.twinless.name,
      awsAccountId: s.twinless.awsAccountId,
    });

    // Raises follow their account onto the agent row, re-keyed.
    expect(
      await adminDb.fleetQuotaRequest.findUniqueOrThrow({ where: { id: s.twinRaise.id } }),
    ).toMatchObject({ shardId: s.twin.id, fleetKind: 'agent_instance', grantedValue: 120 });
    expect(
      await adminDb.fleetQuotaRequest.findUniqueOrThrow({ where: { id: s.soloRaise.id } }),
    ).toMatchObject({ shardId: s.twinless.id, fleetKind: 'agent_instance', grantedValue: 40 });

    // The past capacity requests are history: kept, as stored, on the agent row.
    const kept = await adminDb.fleetCapacityRequest.findMany({ where, orderBy: { id: 'asc' } });
    expect(kept.map((r) => [r.id, r.shardId, r.awsAccountId]).sort()).toEqual(
      [
        [s.twinCapacity.id, s.twin.id, s.index.awsAccountId],
        [s.soloCapacity.id, s.twinless.id, s.twinless.awsAccountId],
      ].sort(),
    );

    // The past usage is unchanged, and billing's meter read still returns it.
    expect(await adminDb.ciContainerUsage.findUniqueOrThrow({ where: { id: s.usage.id } })).toEqual(
      s.usage,
    );
    const metered = await withSystemContext((tx) =>
      ciContainerUsageRepository.findForMeterReport('fly', s.handleId, tx),
    );
    expect(metered).toMatchObject({
      id: s.usage.id,
      workload: 'index',
      billableSeconds: 1800,
      organizationId: s.usage.organizationId,
    });
    expect(String(metered!.costUsd)).toBe(String(s.usage.costUsd));
  });

  it('then refuses the retired kind in every fleet_kind CHECK and takes the three live kinds', async () => {
    await runStoryMigrations();

    const refusal = async (write: () => Promise<unknown>): Promise<string> => {
      try {
        await write();
      } catch (error) {
        return safeJson(error) + String((error as Error).message);
      }
      throw new Error('the write was accepted');
    };

    expect(await refusal(() => shard('indexer-use1-2', RETIRED_FLEET_KIND))).toMatch(
      /fleet_shard_fleet_kind_check/,
    );
    const host = await shard('ci-runner-use1-9', 'ci_runner');
    expect(await refusal(() => raise({ ...host, fleetKind: RETIRED_FLEET_KIND }, 96))).toMatch(
      /fleet_quota_request_fleet_kind_check/,
    );
    expect(
      await refusal(() =>
        adminDb.fleetGrowthEvent.create({
          data: {
            fleetKind: RETIRED_FLEET_KIND,
            vcpuInUse: 1,
            grantedQuota: 2,
            outcome: 'account_created',
          },
        }),
      ),
    ).toMatch(/fleet_growth_event_fleet_kind_check/);

    for (const kind of LIVE_KINDS) {
      const row = await shard(`${kind.replace(/_/g, '-')}-use1-5`, kind);
      await expect(raise(row, 96)).resolves.toMatchObject({ fleetKind: kind });
      await expect(
        adminDb.fleetGrowthEvent.create({
          data: {
            fleetKind: kind,
            triggeringShardId: row.id,
            vcpuInUse: 1,
            grantedQuota: 2,
            outcome: 'account_created',
          },
        }),
      ).resolves.toMatchObject({ fleetKind: kind });
    }
    expect([...FLEET_WORKLOAD_KINDS].sort()).toEqual([...LIVE_KINDS].sort());
  });
});
