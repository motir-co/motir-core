import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContainerOrchestrator,
  Ec2Api,
  Ec2Instance,
  Ec2RunInstanceInput,
  FakeOrchestratorControls,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import { INDEX_POOL_FULL_PAUSE_REASON } from '@/lib/ciFleet/indexAllowance';
import { fleetKindOnPool, wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import type { CodeGraphIndexData } from '@/lib/jobs/types';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { AWS_INDEXER_AMI_ENV_VAR, AWS_RUNNER_AMI_ENV_VAR } from '@/lib/orchestrator';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
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
import { JobTestEngine } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { runnerRole, stubRunnerRoleManagementEnv } from '../helpers/awsRunnerRoleFake';
import {
  driveIndexFleetFast,
  indexEventFor,
  indexJobRuns,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE STORY'S INTEGRATION GATE (MOTIR-9452 · Story MOTIR-9360): the indexer fleet
// on its own AWS pool, assembled. Each blocker proved its own change alone; this
// proves the seam none of them owns: admission chooses an account, the account
// rides the session into the AWS adapter, the adapter reports the indexer's exit
// code, and settle classifies it and releases the slot.
//
// What is real: Postgres, the `codeGraphIndex` job, admission, the dispatch
// service, the per-account resolution (`orchestratorForShard`'s `aws` case), the
// AWS adapter, the catch-up sweep and the attribution pass. What is faked:
//   - EC2: each account's `createEc2Api` answers the `AwsEc2Fake` keyed on that
//     account's access key id, so the credential the resolution READ picks the
//     fake, and an instance on the wrong account is visible as one.
//   - Fly: the process-wide `flyOrchestrator` is a fake, present so a test can say
//     it was never called while the indexer switch is on.
//   - GitHub and motir-ai: `stubIndexFleet`'s `fetch`, as every index suite.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE HERE, as in
// `awsPoolDeferral.test.ts`: the EC2 fake throws the source's `Ec2ApiError`, and
// the adapter types a refusal by `instanceof`.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

/** The surface of `AwsEc2Fake` this file drives. */
interface Ec2Fake extends Ec2Api {
  readonly calls: ReadonlyArray<{ method: string; input: unknown }>;
  readonly instances: ReadonlyMap<string, Ec2Instance & { request: Ec2RunInstanceInput }>;
  seedShardNetwork(shardTag: string, zones?: readonly string[]): unknown;
  markImageUnpullable(image: string): void;
  exitIndexContainer(instanceId: string, code: number): void;
  plantInstance(instance: Partial<Ec2Instance> & { tags: Ec2Instance['tags'] }): string;
  idsFrom(start: number): void;
}

type FakeFleet = ContainerOrchestrator & FakeOrchestratorControls;

const fakes = vi.hoisted(() => ({
  /** Each account's EC2, by the access key id its credential names. */
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
    createAwsManagementApi: () => runnerRole.management(),
    createEc2Api: (config: Parameters<typeof runnerRole.ec2For>[0]) =>
      runnerRole.ec2For(config, (keyId) => fakes.ec2ByKeyId.get(keyId) as object | undefined),
    flyOrchestrator: fakes.fly,
  };
});

const MINUTE = 60_000;
const REGION = 'us-east-1';
const ZONES = ['us-east-1a', 'us-east-1b'];
const INDEX_IMAGE = `ghcr.io/motir-co/motir-indexer@sha256:${'e'.repeat(64)}`;
/** A tenant the busy slots belong to — never the indexing organisation, so a
 *  seeded slot moves an account's headroom and no organisation's share. */
const OTHER_ORG = 'org-busy-elsewhere';

let AwsEc2Fake: new () => Ec2Fake;
let idRange = 0;
const fly = () => fakes.fly as FakeFleet;

interface Account {
  shard: FleetShardDTO;
  ec2: Ec2Fake;
}

/** One `aws` account of `fleetKind`'s pool, through add-shard's own service: its
 *  row, its credential and its own EC2, with the tagged network add-shard builds. */
async function account(fleetKind: FleetWorkloadKind, machineLimit: number): Promise<Account> {
  const label = randomToken(6).toUpperCase();
  const credentialRef = `AWS_SEAM_${label}`;
  const accessKeyId = `AKIA${label}`;
  const awsAccountId = String(100_000_000_000 + Math.floor(Math.random() * 1e9));
  runnerRole.grant(awsAccountId, accessKeyId);
  const shard = await fleetShardService.createShard({
    name: `${fleetKind.replace(/_/g, '-')}-use1-${label.toLowerCase()}`,
    fleetKind,
    provider: 'aws',
    state: 'active',
    githubOrg: 'motir-projects',
    githubInstallationId: '556677',
    awsAccountId,
    awsRegion: REGION,
    credentialRef,
    limits: { machineLimit },
  });
  const ec2 = new AwsEc2Fake();
  idRange += 0x10000;
  ec2.idsFrom(idRange);
  ec2.seedShardNetwork(shard.name, ZONES);
  fakes.ec2ByKeyId.set(accessKeyId, ec2);
  return { shard, ec2 };
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

/** The CI runner, agent and hoster pools, each with the most headroom of all. */
async function otherKindsPools(): Promise<Account[]> {
  return [
    await account('ci_runner', 500),
    await account('agent_instance', 500),
    await account('hosted_agent', 500),
  ];
}

const launches = (acct: Account) => [...acct.ec2.instances.values()];
const stateOf = (acct: Account, id: string) => acct.ec2.instances.get(id)!.state;
const ec2Calls = (acct: Account) => acct.ec2.calls.length;

/** Every container booted on any account exits `code` at its first poll — the
 *  indexer returning while supervision sleeps. Wraps the real poll. With
 *  `afterLaunches`, no container exits until that many VMs have launched across
 *  every account, so concurrent runs are all live at once however the runner is
 *  loaded (otherwise the first can settle, freeing its slot, before the second
 *  is admitted). */
function containersExit(code: number, { afterLaunches = 0 } = {}): void {
  const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  const launched = () =>
    [...(fakes.ec2ByKeyId.values() as Iterable<Ec2Fake>)].reduce(
      (n, ec2) => n + ec2.instances.size,
      0,
    );
  vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
    async (session, previous, options) => {
      for (let waited = 0; launched() < afterLaunches && waited < 30_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (const ec2 of fakes.ec2ByKeyId.values() as Iterable<Ec2Fake>) {
        for (const instance of ec2.instances.values()) {
          if (instance.state === 'pending' || instance.state === 'running') {
            ec2.exitIndexContainer(instance.instanceId, code);
          }
        }
      }
      for (const id of fly().liveContainerIds()) fly().completeJob(id, { exitCode: code });
      return realPoll(session, previous, options);
    },
  );
}

/** The sessions settle was handed, each through a JSON round trip — the shape a
 *  memoized step carries between invocations. */
function settledSessions(): IndexSession[] {
  const settled: IndexSession[] = [];
  const realSettle = codeGraphIndexDispatchService.settleIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'settleIndexContainer').mockImplementation(
    async (session, ...rest) => {
      settled.push(JSON.parse(JSON.stringify(session)) as IndexSession);
      return realSettle(session, ...rest);
    },
  );
  return settled;
}

async function tenant(slug: string, repoName = 'motir-core') {
  const seeded = await seedIndexWorkspace(slug, 1, [{ owner: 'moooon', name: repoName }]);
  return { ...seeded, repoName };
}

async function runIndex(fx: Awaited<ReturnType<typeof tenant>>, eventId: string) {
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
  })) as {
    result?: unknown;
    error?: { name?: string; exitClass?: string; message?: string };
  };
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
  _resetInstallationTokenCache();
  fly().reset();
  fakes.ec2ByKeyId.clear();
  runnerRole.reset();
  stubRunnerRoleManagementEnv();
  fleetShardOrchestratorService.resetCache();
  resetTarballBodyTrap();
  driveIndexFleetFast();
  stubIndexFleet();
  // The deployment's own selection — Fly, configured — so the process-wide fleet
  // is the Fly fake and each account resolves through its real `aws` case.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-fleet');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'motir/ci-runner@sha256:test');
  vi.stubEnv('MOTIR_INDEXER_IMAGE', INDEX_IMAGE);
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, 'ami-0runner000000000');
  vi.stubEnv(AWS_INDEXER_AMI_ENV_VAR, 'ami-0dockerhost00000');
  vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '20');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  // The cost meter writes only on a cloud build — where the fleet is also
  // paid-AI-plan only (MOTIR-6909), so every tenant here has the plan.
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(true);
  vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'aws');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const kind of ['ci_runner', 'agent_instance', 'hosted_agent'] as const) {
    wireFleetKindSwitch(kind, null);
  }
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('admit → account → adapter → exit code → settle, on one account ref', () => {
  it('exit 0: the roomier account boots it, the session carries that account, it indexes, the VM ends and the slot is gone', async () => {
    const busy = await account('code_graph_index', 4);
    const roomy = await account('code_graph_index', 4);
    await occupy(busy, 2);
    await occupy(roomy, 1);
    const sessions = settledSessions();
    containersExit(0);
    const fx = await tenant('seam-ok');

    const { result, error } = await runIndex(fx, 'evt-seam-ok');

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ indexed: true });
    expect(launches(busy)).toEqual([]);
    expect(launches(roomy)).toHaveLength(1);
    const vm = launches(roomy)[0]!;
    expect(vm.request.instanceInitiatedShutdownBehavior).toBe('stop');
    expect(stateOf(roomy, vm.instanceId)).toBe('terminated');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      shardId: roomy.shard.id,
      handle: { provider: 'aws', id: vm.instanceId },
    });
    expect(ec2Calls(busy)).toBe(0);
    expect(fly().provisioned).toEqual([]);
    expect(await indexSlots()).toBe(0);
    expect((await indexJobRuns()).map((r) => r.status)).toEqual(['succeeded']);
  }, 60_000);

  it.each([
    [10, 'dispatch_malformed'],
    [20, 'repo_unfetchable'],
  ] as const)(
    'exit %i classifies as %s, never exit_unobserved, and the slot is released',
    async (code, exitClass) => {
      const acct = await account('code_graph_index', 4);
      containersExit(code);
      const fx = await tenant(`seam-exit-${code}`);

      const { error } = await runIndex(fx, `evt-seam-exit-${code}`);

      expect(error?.name).toBe('IndexDispatchFailedError');
      expect(error?.exitClass).toBe(exitClass);
      expect(launches(acct).length).toBeGreaterThan(0);
      expect(launches(acct).every((vm) => vm.state === 'terminated')).toBe(true);
      expect(fly().provisioned).toEqual([]);
      expect(await indexSlots()).toBe(0);
    },
    60_000,
  );

  it('an unpullable indexer image ends as image_unpullable, releases the slot, and the next admission for the repo is admitted', async () => {
    const acct = await account('code_graph_index', 4);
    acct.ec2.markImageUnpullable(INDEX_IMAGE);
    containersExit(0);
    const fx = await tenant('seam-pull');

    const { error } = await runIndex(fx, 'evt-seam-pull');

    expect(error?.name).toBe('IndexDispatchFailedError');
    expect(error?.exitClass).toBe('image_unpullable');
    expect(await indexSlots()).toBe(0);
    expect(fly().provisioned).toEqual([]);

    const project = fx.projectIds[0]!;
    const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
      where: { id: fx.workspaceId },
    });
    const again = await codeGraphIndexAdmissionService.admit({
      organizationId,
      workspaceId: fx.workspaceId,
      projectId: project,
      repoRef: `moooon/${fx.repoName}`,
      dispatchId: 'next-dispatch',
      containerTimeoutMs: 60_000,
    });
    expect(again).toMatchObject({ outcome: 'admitted', admission: { shardId: acct.shard.id } });
  }, 60_000);
});

describe('an index never lands on another kind’s account', () => {
  it('with the ci_runner, agent and hoster pools roomier, the index boots on the indexer account only', async () => {
    const others = await otherKindsPools();
    for (const kind of ['ci_runner', 'agent_instance', 'hosted_agent'] as const) {
      wireFleetKindSwitch(kind, () => true);
    }
    const indexer = await account('code_graph_index', 2);
    const ciIntentsBefore = await adminDb.ciRunnerProvisioningIntent.count();
    const otherSlotsBefore = await adminDb.fleetInFlightSlot.count({
      where: { workload: { not: 'code_graph_index' } },
    });
    containersExit(0);
    const fx = await tenant('seam-guard');

    const { result } = await runIndex(fx, 'evt-seam-guard');

    expect(result).toMatchObject({ indexed: true });
    expect(launches(indexer)).toHaveLength(1);
    for (const other of others) {
      expect(launches(other), other.shard.fleetKind).toEqual([]);
      expect(ec2Calls(other), other.shard.fleetKind).toBe(0);
    }
    expect(await adminDb.ciRunnerProvisioningIntent.count()).toBe(ciIntentsBefore);
    expect(
      await adminDb.fleetInFlightSlot.count({ where: { workload: { not: 'code_graph_index' } } }),
    ).toBe(otherSlotsBefore);
  }, 60_000);

  it('with no indexer account at all, the other pools’ room is not borrowed: the index waits as pool_full', async () => {
    await otherKindsPools();
    const fx = await tenant('seam-guard-none');

    const { result, error } = await runIndex(fx, 'evt-seam-guard-none');

    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: INDEX_POOL_FULL_PAUSE_REASON });
    for (const acct of fakes.ec2ByKeyId.values() as Iterable<Ec2Fake>) {
      expect(acct.instances.size).toBe(0);
    }
  }, 60_000);
});

describe('the indexer switch moves no other kind, and no other kind’s switch moves indexing', () => {
  it('flipping ci_runner, then agent, then hoster changes neither where an index boots nor their own reads', async () => {
    await otherKindsPools();
    const indexer = await account('code_graph_index', 8);
    containersExit(0);
    const flips: Array<FleetWorkloadKind[]> = [['ci_runner'], ['agent_instance'], ['hosted_agent']];
    let n = 0;
    for (const on of flips) {
      for (const kind of ['ci_runner', 'agent_instance', 'hosted_agent'] as const) {
        wireFleetKindSwitch(kind, () => on.includes(kind));
      }
      const before = await Promise.all(
        (['ci_runner', 'agent_instance', 'hosted_agent'] as const).map((k) => fleetKindOnPool(k)),
      );
      n += 1;
      const fx = await tenant(`seam-flip-${n}`, `flip-${n}`);
      const { result } = await runIndex(fx, `evt-seam-flip-${n}`);

      expect(result, on.join()).toMatchObject({ indexed: true });
      expect(launches(indexer), on.join()).toHaveLength(n);
      expect(fly().provisioned, on.join()).toEqual([]);
      const after = await Promise.all(
        (['ci_runner', 'agent_instance', 'hosted_agent'] as const).map((k) => fleetKindOnPool(k)),
      );
      expect(after, on.join()).toEqual(before);
    }
  }, 90_000);

  it('flipping the indexer switch changes none of the other kinds’ reads', async () => {
    for (const kind of ['ci_runner', 'agent_instance', 'hosted_agent'] as const) {
      wireFleetKindSwitch(kind, () => kind !== 'agent_instance');
    }
    const read = () =>
      Promise.all(
        (['ci_runner', 'agent_instance', 'hosted_agent'] as const).map((k) => fleetKindOnPool(k)),
      );
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'aws');
    const on = await read();
    expect(await fleetKindOnPool('code_graph_index')).toBe(true);
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'fly');
    expect(await fleetKindOnPool('code_graph_index')).toBe(false);
    expect(await read()).toEqual(on);
    expect(on).toEqual([true, false, true]);
  });

  it('indexer switch off, the other three on: the index boots on the process-wide Fly fleet, no account, no EC2 call', async () => {
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'fly');
    const others = await otherKindsPools();
    for (const kind of ['ci_runner', 'agent_instance', 'hosted_agent'] as const) {
      wireFleetKindSwitch(kind, () => true);
    }
    const indexer = await account('code_graph_index', 4);
    const sessions = settledSessions();
    containersExit(0);
    const fx = await tenant('seam-off');

    const { result } = await runIndex(fx, 'evt-seam-off');

    expect(result).toMatchObject({ indexed: true });
    expect(fly().provisioned).toHaveLength(1);
    expect(sessions[0]?.shardId ?? null).toBeNull();
    for (const acct of [indexer, ...others]) expect(ec2Calls(acct)).toBe(0);
  }, 60_000);
});

describe('a full pool: a recorded wait, then the catch-up indexes it', () => {
  it('pool_full leaves no slot, no failed run and no Fly call; once an account has room the sweep enqueues it and it indexes and lifts the pause', async () => {
    const acct = await account('code_graph_index', 2);
    await occupy(acct, 2);
    const fx = await tenant('seam-full');

    const { result, error } = await runIndex(fx, 'evt-seam-full');

    expect(error).toBeUndefined();
    expect(result).toEqual({ indexed: false, reason: INDEX_POOL_FULL_PAUSE_REASON });
    expect((await indexJobRuns()).map((r) => r.status)).toEqual(['succeeded']);
    expect(await indexSlots()).toBe(0);
    expect(fly().provisioned).toEqual([]);
    expect(acct.ec2.instances.size).toBe(0);
    expect((await repoRow(fx.repoName)).indexPausedReason).toBe(INDEX_POOL_FULL_PAUSE_REASON);

    // A container on the account finishes.
    await adminDb.fleetInFlightSlot.deleteMany({ where: { organizationId: OTHER_ORG } });
    const enqueued: CodeGraphIndexData[] = [];
    const check = vi.fn();
    const summary = await codeGraphIndexCatchUpService.catchUp({
      deps: {
        check,
        enqueueRefresh: async (data) => void enqueued.push(data),
        enqueueIndex: async (data) => void enqueued.push(data),
        poolHasRoom: indexPoolHasRoom,
      },
    });
    expect(summary.outcomes.map((o) => o.outcome)).toEqual(['index_enqueued']);
    expect(check).not.toHaveBeenCalled();

    containersExit(0);
    const { result: second } = await runIndex(fx, 'evt-seam-full-2');
    expect(second).toMatchObject({ indexed: true });
    expect(launches(acct)).toHaveLength(1);
    expect((await repoRow(fx.repoName)).indexPausedReason).toBeNull();
    expect(await indexSlots()).toBe(0);
  }, 90_000);
});

describe('every bound defers before any account is chosen', () => {
  async function ask(fx: Awaited<ReturnType<typeof tenant>>, dispatchId: string) {
    const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
      where: { id: fx.workspaceId },
    });
    return codeGraphIndexAdmissionService.admit({
      organizationId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectIds[0]!,
      repoRef: `moooon/${fx.repoName}`,
      dispatchId,
      containerTimeoutMs: 60_000,
    });
  }

  it('kill switch, per-repo single flight, per-org share and the global cap each defer with their own reason, no slot, no AWS call', async () => {
    const acct = await account('code_graph_index', 50);
    const choose = vi.spyOn(fleetShardAdmissionService, 'chooseInTx');
    const fx = await tenant('seam-bounds');
    const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
      where: { id: fx.workspaceId },
    });
    const slotsBefore = await adminDb.fleetInFlightSlot.count();

    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    expect(await ask(fx, 'd-kill')).toMatchObject({ outcome: 'deferred', reason: 'fleet_ceiling' });
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');

    // Another dispatch holds this (repo × project).
    expect(await ask(fx, 'd-holder')).toMatchObject({ outcome: 'admitted' });
    choose.mockClear();
    expect(await ask(fx, 'd-second')).toMatchObject({
      outcome: 'deferred',
      reason: 'repo_index_in_flight',
    });
    await adminDb.fleetInFlightSlot.deleteMany({ where: { ownerRef: 'd-holder' } });

    // The organisation holds ceil(4 / 2) = 2 elsewhere.
    vi.stubEnv('MOTIR_INDEX_MAX_IN_FLIGHT', '4');
    for (const ref of ['own-1', 'own-2']) {
      await adminDb.fleetInFlightSlot.create({
        data: {
          workload: 'code_graph_index',
          ref,
          organizationId,
          expiresAt: new Date(Date.now() + 60 * MINUTE),
        },
      });
    }
    expect(await ask(fx, 'd-org')).toMatchObject({ outcome: 'deferred', reason: 'org_index_cap' });
    await adminDb.fleetInFlightSlot.deleteMany({ where: { organizationId } });

    // Indexing as a whole is at its cap, across other tenants.
    await occupy(acct, 4);
    expect(await ask(fx, 'd-global')).toMatchObject({ outcome: 'deferred', reason: 'index_cap' });

    expect(choose).not.toHaveBeenCalled();
    expect(await adminDb.fleetInFlightSlot.count({ where: { organizationId } })).toBe(0);
    expect(await adminDb.fleetInFlightSlot.count()).toBe(slotsBefore + 4);
    expect(ec2Calls(acct)).toBe(0);
  }, 60_000);
});

describe('two accounts, two runs, settled at once', () => {
  it('each run’s describe and terminate reach only its own account, and neither slot leaks', async () => {
    const a = await account('code_graph_index', 1);
    const b = await account('code_graph_index', 1);
    const sessions = settledSessions();
    containersExit(0, { afterLaunches: 2 });
    const one = await tenant('seam-par-a', 'par-a');
    const two = await tenant('seam-par-b', 'par-b');

    const [r1, r2] = await Promise.all([runIndex(one, 'evt-par-a'), runIndex(two, 'evt-par-b')]);

    expect(r1.result).toMatchObject({ indexed: true });
    expect(r2.result).toMatchObject({ indexed: true });
    expect(launches(a)).toHaveLength(1);
    expect(launches(b)).toHaveLength(1);
    const byAccount = new Map(sessions.map((s) => [s.shardId, s.handle.id]));
    expect(byAccount.get(a.shard.id)).toBe(launches(a)[0]!.instanceId);
    expect(byAccount.get(b.shard.id)).toBe(launches(b)[0]!.instanceId);
    for (const acct of [a, b]) {
      const own = launches(acct)[0]!.instanceId;
      const terminates = acct.ec2.calls
        .filter((c) => c.method === 'terminateInstances')
        .flatMap((c) => c.input as string[]);
      expect(terminates.length).toBeGreaterThan(0);
      expect(terminates.every((id) => id === own)).toBe(true);
      expect(stateOf(acct, own)).toBe('terminated');
    }
    // Neither account's EC2 was ever asked about the other's VM.
    const [onA, onB] = [launches(a)[0]!.instanceId, launches(b)[0]!.instanceId];
    expect(JSON.stringify(a.ec2.calls)).not.toContain(onB);
    expect(JSON.stringify(b.ec2.calls)).not.toContain(onA);
    expect(await indexSlots()).toBe(0);
  }, 90_000);
});

describe('attribution and reaping across the pool', () => {
  it('a settled run is billed to its org on aws; an untagged VM on the other account is reaped there', async () => {
    const a = await account('code_graph_index', 4);
    const b = await account('code_graph_index', 4);
    await occupy(b, 1); // A is roomier, so the run lands there.
    containersExit(0);
    const fx = await tenant('seam-attr');
    const { result } = await runIndex(fx, 'evt-seam-attr');
    expect(result).toMatchObject({ indexed: true });
    const vm = launches(a)[0]!;
    await adminDb.fleetInFlightSlot.deleteMany({ where: { organizationId: OTHER_ORG } });
    const untagged = b.ec2.plantInstance({
      tags: [],
      launchTime: new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS),
    });

    const reconciled = await fleetAttributionService.reconcile({
      inventory: null,
      listingRetryDelayMs: 0,
      now: () => new Date(Date.now() + FLEET_ATTRIBUTION_GRACE_MS + MINUTE),
    });

    expect(stateOf(a, vm.instanceId)).toBe('terminated');
    const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
      where: { id: fx.workspaceId },
    });
    const usage = await adminDb.ciContainerUsage.findMany({ where: { handleId: vm.instanceId } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      containerProvider: 'aws',
      handleId: vm.instanceId,
      organizationId,
      projectId: fx.projectIds[0],
      repoFullName: `moooon/${fx.repoName}`,
    });
    expect(reconciled.outcome === 'reconciled' && reconciled.killed).toEqual([
      expect.objectContaining({ app: b.shard.name, machineId: untagged }),
    ]);
    expect(stateOf(b, untagged)).toBe('terminated');
  }, 60_000);
});
