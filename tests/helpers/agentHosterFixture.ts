import { vi } from 'vitest';
import type {
  AwsHostAgentConfig,
  Ec2Api,
  Ec2Instance,
  Ec2RunInstanceInput,
  Ec2Volume,
  FleetInventory,
  HostAgentClient,
  HostAgentExecRequest,
  PersistentContainerHandle,
  PersistentContainerOrchestrator,
  PersistentExecResult,
  PersistentTerminalEndpoint,
} from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { adminDb } from './adminDb';

// THE AGENT HOSTER, ASSEMBLED (Story MOTIR-9361 · MOTIR-9477). Two (or more) AWS
// hoster accounts, each the REAL AWS persistent adapter over its own in-memory
// EC2 (`packages/orchestrator/test/contract/awsEc2Fake.ts`) and its own in-memory
// host agent, while the process-wide orchestrator stays the Fly fake the
// agent-instance harness selects. A call that wrongly reaches Fly therefore shows
// as a Fly-fake call, and a call that reaches the wrong account shows in that
// account's EC2 or host-agent log.
//
// ⚠️ USE IT FROM A TEST FILE'S OWN `vi.mock`s — they are hoisted only inside the
// file that declares them, so each suite carries the two lines below, and this
// module imports neither `@motir/orchestrator` nor `@/lib/orchestrator` by value
// (both are what it stands in for):
//
//   vi.mock('@motir/orchestrator', async () =>
//     (await import('../helpers/agentHosterFixture')).hosterOrchestratorPackage());
//   vi.mock('@/lib/orchestrator', async (importOriginal) =>
//     (await import('../helpers/agentHosterFixture')).hosterCompositionRoot(
//       await importOriginal()));
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE: the EC2 fake throws the
// source's `Ec2ApiError`, and the adapter types refusals by `instanceof` — the
// convention of `tests/ciFleet/fleetAttributionHoster.test.ts`.

const SOURCE = '../../packages/orchestrator/src/index';
const EC2_FAKE = '../../packages/orchestrator/test/contract/awsEc2Fake';
const HOST_AGENT_FAKE = '../../packages/orchestrator/test/contract/awsHostAgentFake';

type Source = typeof import('@motir/orchestrator');

/** The EC2 fake's surface this fixture reads (it lives outside the type program). */
export interface HosterEc2 extends Ec2Api {
  readonly calls: ReadonlyArray<{ method: string; input: unknown }>;
  readonly instances: ReadonlyMap<string, Ec2Instance & { request: Ec2RunInstanceInput }>;
  readonly volumes: ReadonlyMap<string, Ec2Volume>;
  now: () => Date;
  seedShardNetwork(shardTag: string, zones?: readonly string[]): void;
  plantInstance(instance: Partial<Ec2Instance> & { tags: Ec2Instance['tags'] }): string;
  liveInstanceIds(): string[];
  liveVolumeIds(): string[];
  /** FULL: every launch and every start is refused for capacity until cleared. */
  full: boolean;
}

/** One exec as an account's host agent received it, against the machine it reached. */
export interface HostAgentCall {
  readonly machineId: string;
  readonly command: readonly string[];
  readonly stdin?: string;
}

export interface HosterAccount {
  readonly shard: FleetShard;
  readonly ec2: HosterEc2;
  /** Every exec this account's host agents answered. */
  readonly execs: HostAgentCall[];
  /** The account's machines, as the adapter's handle names them. */
  liveMachines(): string[];
  liveVolumes(): string[];
  /** The order the adapter tore things down in: `machine:<id>` / `volume:<id>`. */
  teardownLog(): string[];
}

interface World {
  source: Source | null;
  ec2Class: (new () => HosterEc2) | null;
  hostAgentConfig: ((client: HostAgentClient) => AwsHostAgentConfig) | null;
  byKeyId: Map<string, HosterAccount>;
  byShardId: Map<string, HosterAccount>;
  orchestrators: Map<string, PersistentContainerOrchestrator>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  answer: (command: readonly string[]) => PersistentExecResult;
  /** Files written to a home disk through exec, by account and volume. */
  homes: Map<string, Map<string, string>>;
}

const world: World = {
  source: null,
  ec2Class: null,
  hostAgentConfig: null,
  byKeyId: new Map(),
  byShardId: new Map(),
  orchestrators: new Map(),
  now: () => new Date(),
  sleep: async () => {},
  answer: () => ({ exitCode: 0, stdout: '', stderr: '' }),
  homes: new Map(),
};

async function source(): Promise<Source> {
  world.source ??= (await import(/* @vite-ignore */ SOURCE)) as Source;
  return world.source;
}

/** `@motir/orchestrator`, the source, with each account's EC2 answered by its key id. */
export async function hosterOrchestratorPackage(): Promise<Source> {
  const pkg = await source();
  return {
    ...pkg,
    createEc2Api: ((credentials: { accessKeyId: string }) => {
      const account = world.byKeyId.get(credentials.accessKeyId);
      if (!account) throw new Error(`no hoster account answers key ${credentials.accessKeyId}`);
      return account.ec2;
    }) as Source['createEc2Api'],
  };
}

/**
 * `@/lib/orchestrator` with an AWS account's persistent orchestrator and its
 * terminal endpoint the REAL AWS adapter over that account's fakes. The fake
 * selection short-circuits both to the shared persistent fake otherwise; every
 * other export, and every non-AWS account, is the composition root as written.
 */
export function hosterCompositionRoot<T extends Record<string, unknown>>(original: T): T {
  const root = original as T & {
    persistentOrchestratorForShard: (shard: FleetShardDTO) => PersistentContainerOrchestrator;
    hosterTerminalEndpointFor: (
      shard: FleetShardDTO,
      handle: PersistentContainerHandle,
    ) => Promise<PersistentTerminalEndpoint>;
    inventoryForShard: (shard: FleetShardDTO) => FleetInventory | null;
  };
  return {
    ...original,
    persistentOrchestratorForShard(shard: FleetShardDTO) {
      const account = world.byShardId.get(shard.id);
      return account ? orchestratorOf(account) : root.persistentOrchestratorForShard(shard);
    },
    async hosterTerminalEndpointFor(shard: FleetShardDTO, handle: PersistentContainerHandle) {
      const account = world.byShardId.get(shard.id);
      return account
        ? orchestratorOf(account).terminalEndpoint(handle)
        : root.hosterTerminalEndpointFor(shard, handle);
    },
    // The account's real AWS listing over its own EC2: under the fake selector the
    // root answers no listing for an `aws` account (MOTIR-9429).
    inventoryForShard(shard: FleetShardDTO) {
      const account = world.byShardId.get(shard.id);
      if (!account) return root.inventoryForShard(shard);
      return world.source!.createAwsFleetInventory({
        ec2: account.ec2,
        region: account.shard.awsRegion!,
        accountName: account.shard.name,
      });
    },
  };
}

function orchestratorOf(account: HosterAccount): PersistentContainerOrchestrator {
  let orchestrator = world.orchestrators.get(account.shard.id);
  if (!orchestrator) {
    const { createAwsPersistentOrchestrator } = world.source!;
    orchestrator = createAwsPersistentOrchestrator({
      ec2: account.ec2,
      region: account.shard.awsRegion!,
      shardTag: account.shard.name,
      amiId: 'ami-0hoster00000000000',
      hostAgent: world.hostAgentConfig!(hostAgentFor(account)),
      now: () => world.now(),
      sleep: (ms) => world.sleep(ms),
    });
    world.orchestrators.set(account.shard.id, orchestrator);
  }
  return orchestrator;
}

/** The volume attached to the machine at `address` in this account. */
function machineAt(account: HosterAccount, address: string): Ec2Instance | undefined {
  return [...account.ec2.instances.values()].find(
    (i) => i.state === 'running' && i.publicIpAddress === address,
  );
}

/**
 * The account's host agents. Two commands touch the home disk — `tee <path>`
 * (the file's text on stdin) and `cat <path>` — and are kept per VOLUME, so a
 * file survives a stop and start exactly when the same disk comes back; every
 * other command is answered by {@link configureHoster}'s `answer`.
 */
function hostAgentFor(account: HosterAccount): HostAgentClient {
  return {
    async exec(address: string, request: HostAgentExecRequest): Promise<PersistentExecResult> {
      const machine = machineAt(account, address);
      if (!machine) {
        const { OrchestratorApiError } = world.source!;
        throw new OrchestratorApiError('aws', 503, 'unreachable');
      }
      account.execs.push({
        machineId: machine.instanceId,
        command: request.command,
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      });
      const volume = [...account.ec2.volumes.values()].find(
        (v) => v.attachedInstanceId === machine.instanceId,
      );
      const homeKey = `${account.shard.id}:${volume?.volumeId ?? 'none'}`;
      const home = world.homes.get(homeKey) ?? new Map<string, string>();
      world.homes.set(homeKey, home);
      const [verb, path] = request.command;
      if (verb === 'tee' && path) {
        home.set(path, request.stdin ?? '');
        return { exitCode: 0, stdout: request.stdin ?? '', stderr: '' };
      }
      if (verb === 'cat' && path) {
        const text = home.get(path);
        return text === undefined
          ? { exitCode: 1, stdout: '', stderr: `cat: ${path}: No such file or directory` }
          : { exitCode: 0, stdout: text, stderr: '' };
      }
      return world.answer(request.command);
    },
  };
}

/** Load the fakes and set the clock and the exec answers. Call in `beforeEach`. */
export async function configureHoster(options: {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  answer: (command: readonly string[]) => PersistentExecResult;
}): Promise<void> {
  await source();
  if (!world.ec2Class) {
    const { AwsEc2Fake } = (await import(/* @vite-ignore */ EC2_FAKE)) as {
      AwsEc2Fake: new () => HosterEc2;
    };
    const { Ec2ApiError } = world.source!;
    const refuseWhenFull = (ec2: HosterEc2, method: string, input: unknown) => {
      if (!ec2.full) return;
      (ec2.calls as Array<{ method: string; input: unknown }>).push({ method, input });
      throw new Ec2ApiError('InsufficientInstanceCapacity', 500, false);
    };
    class CapacityEc2 extends AwsEc2Fake {
      override full = false;
      override async runInstances(input: Ec2RunInstanceInput) {
        refuseWhenFull(this, 'runInstances', input);
        return super.runInstances(input);
      }
      override async startInstances(instanceIds: readonly string[]) {
        refuseWhenFull(this, 'startInstances', instanceIds);
        return super.startInstances(instanceIds);
      }
    }
    world.ec2Class = CapacityEc2;
    const { testHostAgentConfig } = (await import(/* @vite-ignore */ HOST_AGENT_FAKE)) as {
      testHostAgentConfig: (client: HostAgentClient) => AwsHostAgentConfig;
    };
    world.hostAgentConfig = testHostAgentConfig;
  }
  world.byKeyId.clear();
  world.byShardId.clear();
  world.orchestrators.clear();
  world.homes.clear();
  world.now = options.now;
  world.sleep = options.sleep;
  world.answer = options.answer;
}

let seq = 0;

/** Register an agent-hoster AWS account: its row, its key's env vars, its EC2 and network. */
export async function seedHosterAccount(name: string, machineLimit = 10): Promise<HosterAccount> {
  seq += 1;
  const credentialRef = `FLEET_SHARD_HOSTER_GATE_${seq}`;
  const keyId = `AKIA-GATE-${seq}`;
  vi.stubEnv(`${credentialRef}_ACCESS_KEY_ID`, keyId);
  vi.stubEnv(`${credentialRef}_SECRET_ACCESS_KEY`, 'not-a-secret');
  const shard = await adminDb.fleetShard.create({
    data: {
      name,
      fleetKind: 'agent_instance',
      provider: 'aws',
      state: 'active',
      githubOrg: 'motir-co',
      githubInstallationId: '556677',
      awsAccountId: `7777${String(seq).padStart(8, '0')}`,
      awsRegion: 'us-east-1',
      credentialRef,
      machineLimit,
    },
  });
  const ec2 = new world.ec2Class!();
  ec2.now = () => world.now();
  ec2.seedShardNetwork(name, ['us-east-1a', 'us-east-1b']);
  const inAccount = (tags: Ec2Instance['tags']) =>
    tags.some((t) => t.key === 'motir-shard' && t.value === name);
  const account: HosterAccount = {
    shard,
    ec2,
    execs: [],
    liveMachines: () =>
      [...ec2.instances.values()]
        .filter((i) => i.state !== 'terminated' && inAccount(i.tags))
        .map((i) => i.instanceId),
    liveVolumes: () => ec2.liveVolumeIds(),
    teardownLog: () =>
      ec2.calls.flatMap((c) =>
        c.method === 'terminateInstances'
          ? (c.input as string[]).map((id) => `machine:${id}`)
          : c.method === 'deleteVolume'
            ? [`volume:${String(c.input)}`]
            : [],
      ),
  };
  world.byKeyId.set(keyId, account);
  world.byShardId.set(shard.id, account);
  return account;
}

/** The account is full: every launch and start is refused for capacity. */
export function fillAccount(account: HosterAccount): void {
  account.ec2.full = true;
}

/** Room again on `account`: launches accepted, and the pause a refusal put on it ended. */
export async function freeRoom(account: HosterAccount): Promise<void> {
  account.ec2.full = false;
  await adminDb.fleetShard.update({
    where: { id: account.shard.id },
    data: { admissionPausedUntil: null, admissionPausedReason: null },
  });
}

/** The EC2 calls an account was asked for, by method — the routing evidence. */
export const ec2CallsOf = (account: HosterAccount, method?: string): number =>
  account.ec2.calls.filter((c) => !method || c.method === method).length;
