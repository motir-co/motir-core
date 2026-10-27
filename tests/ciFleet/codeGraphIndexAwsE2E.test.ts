import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AwsCredentialsConfig,
  AwsSessionCredentials,
  ContainerOrchestrator,
  Ec2Api,
  Ec2Instance,
  Ec2RunInstanceInput,
  FakeOrchestratorControls,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { INDEX_POOL_FULL_PAUSE_REASON } from '@/lib/ciFleet/indexAllowance';
import { SHARD_VCPU_QUOTA_TARGET, fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import type { CodeGraphIndexData } from '@/lib/jobs/types';
import {
  AWS_INDEXER_AMI_ENV_VAR,
  AWS_RUNNER_AMI_ENV_VAR,
  orchestratorForShard,
  recordContainerAccrual,
} from '@/lib/orchestrator';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import {
  codeGraphIndexAdmissionService,
  indexSlotRef,
} from '@/lib/services/codeGraphIndexAdmissionService';
import {
  codeGraphIndexCatchUpService,
  indexPoolHasRoom,
} from '@/lib/services/codeGraphIndexCatchUpService';
import {
  codeGraphIndexDispatchService,
  type IndexSession,
} from '@/lib/services/codeGraphIndexDispatchService';
import {
  FLEET_ATTRIBUTION_GRACE_MS,
  fleetAttributionService,
} from '@/lib/services/fleetAttributionService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { withSystemContext } from '@/lib/workspaces/context';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import { buildContainerAccrual, FLEET_CONTAINER_SIZE } from '@motir/orchestrator';
import { createTestUser } from '../fixtures/userFixtures';
import { JobTestEngine } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  ADD_SHARD_ENTERPRISE_SLUG,
  FakeOrganization,
  buildStacksInto,
  stubPoolDefinitionEnv,
  installAddShardGithub,
  newGithubWorld,
} from '../helpers/addShardFakes';
import {
  driveIndexFleetFast,
  indexEventFor,
  indexJobRuns,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE STORY'S END-TO-END WALK (MOTIR-9453 · Story MOTIR-9360): the indexer fleet
// on AWS, in the order the story's verification recipe drives it. No browser —
// nothing in the story renders.
//
//   1. `fleet-admin add-shard --provider aws --fleet-kind code_graph_index` twice
//      (and once for `ci_runner`), against the add-shard fakes.
//   2. The indexer switch off: an index boots on the Fly fleet.
//   3. The switch on: tenant and Motir-org indexes land on the roomier account.
//   4. Exit codes 0 / 10 / 20 and an unpullable image.
//   5. Every account full: the index waits; the catch-up sweep runs it later.
//   6. The usage rows, and one attribution pass inside and after its grace.
//
// What is real: Postgres, the fleet-admin command, the `codeGraphIndex` job,
// admission, the dispatch service, the per-account resolution, the AWS adapter,
// the catch-up sweep, the usage meter and the attribution pass. What is faked:
// GitHub and motir-ai at `fetch`, the AWS management API (`FakeOrganization`),
// and EC2 — one `AwsEc2Fake` per account, the one add-shard built the account's
// network in, reached at runtime by the account's own access key id. The
// process-wide Fly fleet is a fake so a test can say it was never called.
//
// The seams themselves (switch independence, the cross-kind guard, the coverage
// floor) are MOTIR-9452's `awsIndexPoolSeam.test.ts`; this walks the flow.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE HERE, as in
// `awsPoolDeferral.test.ts`, so the EC2 fake and the adapter share one copy of
// every error class.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

interface Ec2Fake extends Ec2Api {
  readonly calls: ReadonlyArray<{ method: string; input: unknown }>;
  readonly instances: ReadonlyMap<string, Ec2Instance & { request: Ec2RunInstanceInput }>;
  markImageUnpullable(image: string): void;
  exitIndexContainer(instanceId: string, code: number): void;
  plantInstance(instance: Partial<Ec2Instance> & { tags: Ec2Instance['tags'] }): string;
  idsFrom(start: number): void;
}

type FakeFleet = ContainerOrchestrator & FakeOrchestratorControls;

const fakes = vi.hoisted(() => ({
  /** Each account's EC2, by the RUNTIME access key id its credential names. */
  ec2ByKeyId: new Map<string, unknown>(),
  fly: null as unknown,
}));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  fakes.fly = source.createFakeOrchestrator({ idPrefix: 'fly-machine' });
  return {
    ...source,
    createEc2Api: (config: { accessKeyId: string }) => {
      const ec2 = fakes.ec2ByKeyId.get(config.accessKeyId);
      if (!ec2) throw new Error(`no EC2 fake for ${config.accessKeyId}`);
      return ec2;
    },
    flyOrchestrator: fakes.fly,
  };
});

const MINUTE = 60_000;
const INDEX_IMAGE = `ghcr.io/motir-co/motir-indexer@sha256:${'f'.repeat(64)}`;
const ACCOUNT_A = 'code-graph-index-use1-1';
const ACCOUNT_B = 'code-graph-index-use1-2';
const CI_ACCOUNT = 'ci-runner-use1-7';
const SESSION: AwsSessionCredentials = {
  accessKeyId: 'ASIA_SESSION_E2E',
  secretAccessKey: 'SESSION_SECRET_E2E',
  sessionToken: 'SESSION_TOKEN_E2E',
  expiration: null,
};
/** A tenant the busy slots belong to — never the indexing organisation. */
const OTHER_ORG = 'org-busy-elsewhere';

let AwsEc2Fake: new () => Ec2Fake;
let organization: FakeOrganization;
let unregister: () => void;
/** The account add-shard is building right now: its session reaches this EC2. */
let building: Ec2Fake | null = null;
let idRange = 0;
const fly = () => fakes.fly as FakeFleet;

interface Account {
  shard: FleetShardDTO;
  ec2: Ec2Fake;
}

/** `fleet-admin add-shard --provider aws`, as an operator runs it. */
async function addShard(name: string, fleetKind: string, operator: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin(
    [
      'add-shard',
      '--create-org',
      '--provider',
      'aws',
      '--fleet-kind',
      fleetKind,
      '--name',
      name,
      '--github-org',
      `motir-fleet-${name}`,
      '--admin-login',
      'zhuyue11',
      '--account-email',
      `aws+${name}@motir.co`,
      '--operator',
      operator,
    ],
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/**
 * One account through add-shard to `active`: the first run builds it and stops on
 * the person's two steps (quota, runtime key); the operator does both and runs the
 * command again. Returns its row and the EC2 its network was built in.
 */
async function provision(name: string, fleetKind: string, operator: string): Promise<Account> {
  const ec2 = new AwsEc2Fake();
  idRange += 0x10000;
  ec2.idsFrom(idRange);
  building = ec2;
  const first = await addShard(name, fleetKind, operator);
  expect(first.code, first.err).toBe(2);
  const { credentialRef } = (await fleetShardService.findShardByName(name))!;
  const runtimeKeyId = `AKIA_RUNTIME_${name.toUpperCase().replace(/-/g, '_')}`;
  vi.stubEnv(`${credentialRef}_ACCESS_KEY_ID`, runtimeKeyId);
  vi.stubEnv(`${credentialRef}_SECRET_ACCESS_KEY`, `secret-${name}`);
  fakes.ec2ByKeyId.set(runtimeKeyId, ec2);
  const second = await addShard(name, fleetKind, operator);
  expect(second.code, second.err).toBe(0);
  building = null;
  return { shard: (await fleetShardService.findShardByName(name))!, ec2 };
}

/** Occupy `count` units of an account with live index slots of another tenant. */
async function occupy(acct: Account, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await adminDb.fleetInFlightSlot.create({
      data: {
        workload: 'code_graph_index',
        ref: `busy-${acct.shard.id}-${i}`,
        organizationId: OTHER_ORG,
        fleetShardId: acct.shard.id,
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      },
    });
  }
}

const launches = (acct: Account) => [...acct.ec2.instances.values()];
const stateOf = (acct: Account, id: string) => acct.ec2.instances.get(id)!.state;

/** Every container booted anywhere exits `code` at its first poll. Returns what
 *  each poll answered. */
function containersExit(code: number): unknown[] {
  const answers: unknown[] = [];
  const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
    async (session, previous, options) => {
      for (const ec2 of fakes.ec2ByKeyId.values() as Iterable<Ec2Fake>) {
        for (const instance of ec2.instances.values()) {
          if (instance.state === 'pending' || instance.state === 'running') {
            ec2.exitIndexContainer(instance.instanceId, code);
          }
        }
      }
      for (const id of fly().liveContainerIds()) fly().completeJob(id, { exitCode: code });
      const answer = await realPoll(session, previous, options);
      answers.push(answer);
      return answer;
    },
  );
  return answers;
}

/** The state of each VM when settle was handed its session: the exit code was
 *  read by then, so a VM still `stopped` (not `terminated`) proves the read came
 *  before the teardown. */
function vmStatesAtSettle(): string[] {
  const states: string[] = [];
  const realSettle = codeGraphIndexDispatchService.settleIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer').mockImplementation(
    async (session: IndexSession, ...rest) => {
      for (const ec2 of fakes.ec2ByKeyId.values() as Iterable<Ec2Fake>) {
        const vm = ec2.instances.get(session.handle.id);
        if (vm) states.push(vm.state);
      }
      return realSettle(session, ...rest);
    },
  );
  return states;
}

async function tenant(slug: string, repoName: string, opts: { meta?: boolean } = {}) {
  const seeded = await seedIndexWorkspace(slug, 1, [{ owner: 'moooon', name: repoName }]);
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seeded.workspaceId },
  });
  if (opts.meta) {
    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });
  }
  return { ...seeded, repoName, organizationId, projectId: seeded.projectIds[0]! };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function runIndex(fx: Tenant, eventId: string) {
  const engine = new JobTestEngine({ function: codeGraphIndex });
  return (await engine.execute({
    events: [
      indexEventFor({
        installationId: fx.installationId,
        workspaceId: fx.workspaceId,
        repoName: fx.repoName,
        eventId,
      }),
    ],
  })) as { result?: unknown; error?: { name?: string; exitClass?: string } };
}

function repoRow(name: string) {
  return adminDb.githubRepo.findFirstOrThrow({
    where: { owner: 'moooon', name },
    select: { indexPausedReason: true, indexingRunId: true },
  });
}

const indexSlots = () =>
  adminDb.fleetInFlightSlot.count({
    where: { workload: 'code_graph_index', organizationId: { not: OTHER_ORG } },
  });

/** The pool read admission uses, for one kind. */
const poolOf = (kind: string) =>
  withSystemContext(async (tx) =>
    (await fleetShardRepository.listActiveForKindInTx(kind, ['primary'], tx))
      .map((s) => s.name)
      .sort(),
  );

let a: Account;
let b: Account;
let ci: Account;

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.ciContainerUsage.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  fly().reset();
  fakes.ec2ByKeyId.clear();
  fleetShardOrchestratorService.resetCache();
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  // ── Step 1's world: the add-shard fakes ─────────────────────────────────
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4445390');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_ENTERPRISE_SLUG', ADD_SHARD_ENTERPRISE_SLUG);
  vi.stubEnv('GITHUB_ENTERPRISE_ADMIN_TOKEN', 'ghp_ADMIN_E2E');
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', 'AKIA_MANAGEMENT_E2E');
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', 'MANAGEMENT_SECRET_E2E');
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
  stubPoolDefinitionEnv();
  installAddShardGithub(newGithubWorld(), 'ghs_INSTALL_E2E');
  organization = new FakeOrganization(SESSION);
  buildStacksInto(organization, () => building);
  // The operator does the quota step before the second run.
  organization.quota = SHARD_VCPU_QUOTA_TARGET;
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      // The member-role session builds the account being added; a runtime key
      // reaches its own account's EC2.
      ec2: (config: AwsCredentialsConfig) =>
        (fakes.ec2ByKeyId.get(config.accessKeyId) as Ec2Fake | undefined) ?? building!,
      env: () => process.env,
    }),
  );
  const operator = await createTestUser();
  await adminDb.user.update({ where: { id: operator.id }, data: { platformRole: 'superadmin' } });
  a = await provision(ACCOUNT_A, 'code_graph_index', operator.email);
  b = await provision(ACCOUNT_B, 'code_graph_index', operator.email);
  ci = await provision(CI_ACCOUNT, 'ci_runner', operator.email);

  // ── The index world: motir-ai and GitHub at `fetch`, the Fly fake ─────────
  resetTarballBodyTrap();
  driveIndexFleetFast();
  stubIndexFleet();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-fleet');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'motir/ci-runner@sha256:test');
  vi.stubEnv('MOTIR_INDEXER_IMAGE', INDEX_IMAGE);
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, 'ami-0runner000000000');
  vi.stubEnv(AWS_INDEXER_AMI_ENV_VAR, 'ami-0dockerhost00000');
  vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '20');
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(true);
  vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'aws');
});

afterEach(async () => {
  unregister();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('1 · add-shard puts two accounts in the indexer pool', () => {
  it('two code_graph_index rows in us-east-1 with their own credentials, apart from the ci_runner row', async () => {
    for (const acct of [a, b]) {
      expect(acct.shard).toMatchObject({
        fleetKind: 'code_graph_index',
        provider: 'aws',
        state: 'active',
        aws: expect.objectContaining({ region: 'us-east-1' }),
      });
    }
    expect(ci.shard.fleetKind).toBe('ci_runner');
    expect(new Set([a, b, ci].map((x) => x.shard.credentialRef)).size).toBe(3);
    expect(await poolOf('code_graph_index')).toEqual([ACCOUNT_A, ACCOUNT_B]);
    expect(await poolOf('ci_runner')).toEqual([CI_ACCOUNT]);
  }, 60_000);
});

describe('2 · the indexer switch off', () => {
  it('indexes on the Fly fleet, and nothing is created in AWS', async () => {
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'fly');
    containersExit(0);
    const fx = await tenant('e2e-off', 'off');

    const { result } = await runIndex(fx, 'evt-e2e-off');

    expect(result).toMatchObject({ indexed: true, repoRef: 'moooon/off' });
    expect(fly().provisioned).toHaveLength(1);
    for (const acct of [a, b, ci]) expect(acct.ec2.instances.size).toBe(0);
  }, 60_000);
});

describe('3 · the switch on: the roomier account takes every index', () => {
  it('a tenant org and a Motir org each boot a VM on B, index, and leave no VM running; CI stays on Fly', async () => {
    await occupy(a, 3); // A has less free room than B.
    const recordedAccounts: Array<string | null> = [];
    const take = vi.spyOn(codeGraphIndexAdmissionService, 'admit');
    containersExit(0);
    const tenantOrg = await tenant('e2e-tenant', 'tenant-repo');
    const motirOrg = await tenant('e2e-motir', 'motir-repo', { meta: true });

    for (const [fx, id] of [
      [tenantOrg, 'evt-e2e-tenant'],
      [motirOrg, 'evt-e2e-motir'],
    ] as const) {
      const { result } = await runIndex(fx, id);
      expect(result, fx.repoName).toMatchObject({ indexed: true });
    }
    for (const call of take.mock.results) {
      const verdict = (await call.value) as { admission?: { shardId: string | null } };
      recordedAccounts.push(verdict.admission?.shardId ?? null);
    }

    expect(launches(a)).toEqual([]);
    expect(launches(b)).toHaveLength(2);
    expect(launches(b).every((vm) => vm.state === 'terminated')).toBe(true);
    expect(recordedAccounts.length).toBeGreaterThanOrEqual(2);
    expect(recordedAccounts.every((id) => id === b.shard.id)).toBe(true);
    expect(fly().provisioned).toEqual([]);
    expect(await indexSlots()).toBe(0);
    // The CI switch is untouched: a ci_runner job is placed on the Fly fleet.
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    expect(
      await withSystemContext((tx) =>
        fleetShardAdmissionService.chooseInTx(
          { fleetKind: 'ci_runner', organizationId: tenantOrg.organizationId },
          new Date(),
          tx,
        ),
      ),
    ).toEqual({ shardId: null });
    expect(ci.ec2.instances.size).toBe(0);
  }, 90_000);
});

describe('4 · what the indexer reports', () => {
  it.each([
    [0, 'indexed'],
    [10, 'dispatch_malformed'],
    [20, 'repo_unfetchable'],
  ] as const)(
    'exit %i classifies as %s, read before the VM is terminated',
    async (code, exitClass) => {
      const states = vmStatesAtSettle();
      const polls = containersExit(code);
      const fx = await tenant(`e2e-exit-${code}`, `exit-${code}`);

      const { result, error } = await runIndex(fx, `evt-e2e-exit-${code}`);

      if (code === 0) {
        expect(result).toMatchObject({ indexed: true });
      } else {
        expect(error?.name).toBe('IndexDispatchFailedError');
        expect(error?.exitClass).toBe(exitClass);
      }
      // The terminal poll read the code while the VM was only STOPPED.
      const terminal = polls.find((p) => (p as { done?: boolean }).done);
      expect(terminal).toMatchObject({ done: true, exitCode: code });
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((state) => state === 'stopped')).toBe(true);
      expect([...launches(a), ...launches(b)].every((vm) => vm.state === 'terminated')).toBe(true);
      expect(await indexSlots()).toBe(0);
    },
    60_000,
  );

  it('an unpullable image ends image_unpullable, and the next admission for the repo is not blocked', async () => {
    a.ec2.markImageUnpullable(INDEX_IMAGE);
    b.ec2.markImageUnpullable(INDEX_IMAGE);
    containersExit(0);
    const fx = await tenant('e2e-pull', 'pull');

    const { error } = await runIndex(fx, 'evt-e2e-pull');

    expect(error?.exitClass).toBe('image_unpullable');
    expect(await indexSlots()).toBe(0);
    const next = await codeGraphIndexAdmissionService.admit({
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoRef: 'moooon/pull',
      dispatchId: 'next-dispatch',
      containerTimeoutMs: 60_000,
    });
    expect(next.outcome).toBe('admitted');
  }, 60_000);
});

describe('5 · every account full: the index waits, then the catch-up runs it', () => {
  it('a succeeded no-op with the repo pending; the sweep holds while full, then re-dispatches and the pause lifts', async () => {
    // Two units each (a 4 vCPU quota holds two 2 vCPU containers), both taken.
    await adminDb.fleetShard.updateMany({ data: { vcpuQuota: 4 } });
    fleetShardOrchestratorService.resetCache();
    await occupy(a, 2);
    await occupy(b, 2);
    const fx = await tenant('e2e-full', 'full');

    const { result, error } = await runIndex(fx, 'evt-e2e-full');

    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: INDEX_POOL_FULL_PAUSE_REASON });
    expect((await indexJobRuns()).map((r) => r.status)).toEqual(['succeeded']);
    expect((await repoRow('full')).indexPausedReason).toBe(INDEX_POOL_FULL_PAUSE_REASON);
    expect(a.ec2.instances.size + b.ec2.instances.size).toBe(0);
    expect(fly().provisioned).toEqual([]);
    expect(await indexSlots()).toBe(0);

    const enqueued: CodeGraphIndexData[] = [];
    const sweep = () =>
      codeGraphIndexCatchUpService.catchUp({
        deps: {
          check: vi.fn(),
          enqueueRefresh: async (data) => void enqueued.push(data),
          enqueueIndex: async (data) => void enqueued.push(data),
          poolHasRoom: indexPoolHasRoom,
        },
      });
    expect((await sweep()).outcomes.map((o) => o.outcome)).toEqual(['pool_still_full']);
    expect(enqueued).toEqual([]);

    // One container on B finishes.
    await adminDb.fleetInFlightSlot.deleteMany({ where: { ref: `busy-${b.shard.id}-0` } });
    expect((await sweep()).outcomes.map((o) => o.outcome)).toEqual(['index_enqueued']);
    expect(enqueued).toHaveLength(1);

    containersExit(0);
    const { result: rerun } = await runIndex(fx, 'evt-e2e-full-2');
    expect(rerun).toMatchObject({ indexed: true, repoRef: 'moooon/full' });
    expect(launches(b)).toHaveLength(1);
    expect(launches(a)).toEqual([]);
    expect((await repoRow('full')).indexPausedReason).toBeNull();
  }, 90_000);
});

describe('6 · cost and attribution', () => {
  it('each completed AWS index run has a usage row attributed to its org, project and repo', async () => {
    containersExit(0);
    const one = await tenant('e2e-cost-1', 'cost-1');
    const two = await tenant('e2e-cost-2', 'cost-2');
    await runIndex(one, 'evt-e2e-cost-1');
    await runIndex(two, 'evt-e2e-cost-2');

    const vms = [...launches(a), ...launches(b)];
    expect(vms).toHaveLength(2);
    for (const fx of [one, two]) {
      const [row] = await adminDb.ciContainerUsage.findMany({
        where: { repoFullName: `moooon/${fx.repoName}` },
      });
      expect(row, fx.repoName).toMatchObject({
        containerProvider: 'aws',
        workload: 'index',
        organizationId: fx.organizationId,
        projectId: fx.projectId,
      });
      expect(vms.map((vm) => vm.instanceId)).toContain(row!.handleId);
      expect(row!.containerCreatedAt).not.toBeNull();
      expect(row!.containerStoppedAt).not.toBeNull();
    }
  }, 90_000);

  /** A live, recorded index VM on `acct`: booted, checkpointed, its slot held. */
  async function liveIndex(acct: Account, fx: Tenant): Promise<string> {
    const repoFullName = `moooon/${fx.repoName}`;
    const attribution = {
      orgId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoFullName,
      workload: 'code_graph_index' as const,
      workflowJobId: null,
      size: FLEET_CONTAINER_SIZE,
      observedStartedAt: null,
    };
    const handle = await orchestratorForShard(acct.shard).provision({
      orgId: fx.organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      repoFullName,
      workload: 'code_graph_index',
      workflowJobId: null,
      image: INDEX_IMAGE,
      size: FLEET_CONTAINER_SIZE,
      env: { MOTIR_INDEX_PROJECT_ID: fx.projectId },
      timeoutSeconds: 1800,
      region: 'us-east-1',
    });
    await recordContainerAccrual(
      buildContainerAccrual({
        handle,
        attribution,
        createdAt: handle.createdAt,
        startedAt: handle.createdAt,
        observedAt: new Date(),
      }),
    );
    await adminDb.fleetInFlightSlot.create({
      data: {
        workload: 'code_graph_index',
        ref: indexSlotRef(fx.projectId, repoFullName),
        organizationId: fx.organizationId,
        workspaceId: fx.workspaceId,
        fleetShardId: acct.shard.id,
        expiresAt: new Date(Date.now() + 3 * 60 * MINUTE),
      },
    });
    return handle.id;
  }

  it('live recorded VMs on both accounts are kept; an untagged and an unrecorded tagged VM are reaped only after the grace', async () => {
    const fx = await tenant('e2e-reap', 'reap');
    const fy = await tenant('e2e-reap-2', 'reap-2');
    const onA = await liveIndex(a, fx);
    const onB = await liveIndex(b, fy);
    const untagged = a.ec2.plantInstance({ tags: [] });
    const lookalike = a.ec2.plantInstance({
      tags: [
        { key: 'motir:workload', value: 'code_graph_index' },
        { key: 'motir:org', value: fx.organizationId },
        { key: 'motir:project', value: fx.projectId },
        { key: 'motir:repo', value: 'moooon/ghost' },
      ],
    });
    const reconcile = (now: () => Date) =>
      fleetAttributionService.reconcile({ inventory: null, listingRetryDelayMs: 0, now });

    const inGrace = await reconcile(() => new Date());
    expect(inGrace).toMatchObject({ outcome: 'reconciled', killed: [] });
    expect(stateOf(a, untagged)).toBe('running');
    expect(stateOf(a, lookalike)).toBe('running');

    const after = await reconcile(() => new Date(Date.now() + FLEET_ATTRIBUTION_GRACE_MS + MINUTE));
    expect(after.outcome === 'reconciled' && after.killed.map((k) => k.machineId).sort()).toEqual(
      [untagged, lookalike].sort(),
    );
    expect(stateOf(a, untagged)).toBe('terminated');
    expect(stateOf(a, lookalike)).toBe('terminated');
    expect(stateOf(a, onA)).toBe('running');
    expect(stateOf(b, onB)).toBe('running');
    const kills = await adminDb.fleetMachineKill.findMany();
    expect(kills.map((k) => k.machineId).sort()).toEqual([untagged, lookalike].sort());
    expect(kills.every((k) => k.app === ACCOUNT_A)).toBe(true);
    // The CI account is listed too (every AWS account is, MOTIR-9426), and nothing
    // on it is reaped: no index VM ever lands there.
    expect(ci.ec2.calls.some((c) => c.method === 'terminateInstances')).toBe(false);
  }, 90_000);

  it('a listing failure on one account destroys nothing there and does not stop the other', async () => {
    const fx = await tenant('e2e-list', 'list');
    const onB = await liveIndex(b, fx);
    const orphanOnA = a.ec2.plantInstance({
      tags: [],
      launchTime: new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS),
    });
    const orphanOnB = b.ec2.plantInstance({
      tags: [],
      launchTime: new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS),
    });
    vi.spyOn(a.ec2, 'describeInstances').mockRejectedValue(new Error('listing failed'));

    const result = await fleetAttributionService.reconcile({
      inventory: null,
      listingRetryDelayMs: 0,
    });

    expect(result.outcome).toBe('reconciled');
    expect(stateOf(a, orphanOnA)).toBe('running');
    expect(stateOf(b, orphanOnB)).toBe('terminated');
    expect(stateOf(b, onB)).toBe('running');
    expect(await adminDb.fleetMachineKill.count({ where: { app: ACCOUNT_A } })).toBe(0);
  }, 60_000);
});
