// A FAKE AWS THE ACCEPTANCE LANE CAN DRIVE ACROSS PROCESSES (Story MOTIR-9359 ·
// MOTIR-9429). Node-only, installed from `lib/test-mock-seams.ts` whenever
// `MOTIR_FAKE_AWS_STATE_PATH` is set — by the webServer (`instrumentation.ts`)
// and the job worker (`scripts/worker.ts`) alike — and dormant everywhere else.
//
// ⚠️ IT FAKES THE PROVIDER API, NOT THE ADAPTER. Only the EC2 client is replaced
// (`setAwsEc2OverrideForTests`, `lib/orchestrator/index.ts`), so for an `aws`
// account the lane runs the REAL `createAwsOrchestrator` — its user-data, tags,
// zone walk and refusal typing — and the REAL `createAwsFleetInventory`, while a
// `fly` account and the process-wide fleet stay on the existing fakes. That is
// what makes the story E2E evidence about AWS rather than about a stand-in.
//
// ⚠️ ONE FILE, KEYED BY ACCOUNT. A hosted run boots in the webServer, is polled
// and settled in the worker, and is read by the spec — three processes sharing
// no memory — so every EC2 call reads the state file and every write replaces it
// whole (`replaceFixtureFileSync`: write a sibling, rename it over). A missing or
// unreadable file reads as "nothing launched yet", the same tolerance the fake
// orchestrator's `loadShared` gives itself.
//
// ⚠️ THE SPEC STEERS IT THROUGH THE SAME FILE (`tests/e2e/_helpers/
// fake-aws-boundary.ts`): a queued launch refusal, an instance stopped as if its
// container exited, an untagged instance "started by hand". And the agent-runner
// switch reads a second, smaller fixture (`MOTIR_FAKE_FLEET_SWITCH_PATH`), re-read
// on every admission, because a spec cannot change the server's environment.
//
// File access goes through `lib/test-fixture-file.ts` — the NFT-tracing rule its
// header documents.

import type {
  Ec2Api,
  Ec2ApiError,
  Ec2DescribeInstancesInput,
  Ec2Filter,
  Ec2Instance,
  Ec2RunInstanceInput,
  Ec2Tag,
} from '@motir/orchestrator';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { readFixtureFileSync, replaceFixtureFileSync } from '@/lib/test-fixture-file';

/** The state file every lane process shares. */
export const FAKE_AWS_STATE_PATH_ENV_VAR = 'MOTIR_FAKE_AWS_STATE_PATH';
/** The agent-runner switch fixture the spec writes. */
export const FAKE_FLEET_SWITCH_PATH_ENV_VAR = 'MOTIR_FAKE_FLEET_SWITCH_PATH';

/** Every fake account's zones, one subnet each — two, so a zone-local refusal
 *  has somewhere to move to. */
export const FAKE_AWS_ZONES = ['us-east-1a', 'us-east-1b'] as const;

/** The tag the adapter finds an account's network by (`AWS_SHARD_TAG_KEY`). */
const SHARD_TAG_KEY = 'motir-shard';

/** One instance, as the state file holds it. */
export interface FakeAwsInstanceRecord {
  instanceId: string;
  /** `pending` · `running` · `shutting-down` · `terminated` · `stopping` · `stopped`. */
  state: string;
  /** ISO instant, or null for an instance EC2 dates nowhere. */
  launchTime: string | null;
  stateTransitionReason: string | null;
  availabilityZone: string | null;
  tags: Ec2Tag[];
  /** What RunInstances was sent; null for an instance planted by the spec. */
  request: {
    clientToken: string;
    imageId: string;
    instanceType: string;
    subnetId: string;
    /** Base64, exactly as RunInstances took it. */
    userData: string;
  } | null;
}

/** A queued RunInstances refusal: the next launch in `zone` (any zone when
 *  absent) throws this AWS error code. Consumed by the launch it refuses. */
export interface FakeAwsRefusal {
  code: string;
  zone?: string;
}

/** One account's EC2. */
export interface FakeAwsAccountState {
  /** The account's name — its shard tag. */
  name: string;
  instances: Record<string, FakeAwsInstanceRecord>;
  /** ClientToken → instance id, so a repeated token answers the same instance. */
  byToken: Record<string, string>;
  refusals: FakeAwsRefusal[];
}

/** The whole state file, keyed by account (shard id). */
export interface FakeAwsState {
  accounts: Record<string, FakeAwsAccountState>;
}

/** The agent-runner switch fixture. Absent or unset ⇒ the env var decides. */
export interface FleetSwitchFixture {
  hostedAgent?: 'aws' | 'fly';
}

/** The HTTP status EC2 answers each code with; anything else is a 400. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  InsufficientInstanceCapacity: 500,
  RequestLimitExceeded: 503,
  ServiceUnavailable: 503,
  InternalError: 500,
};

/** The status EC2 would answer `code` with — the spec reads it too. */
export function fakeAwsStatusFor(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}

function pathFrom(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? raw : null;
}

/** The state file, or the empty state when there is none yet (or it is unreadable). */
export function readFakeAwsState(path: string): FakeAwsState {
  try {
    const parsed = JSON.parse(readFixtureFileSync(path)) as Partial<FakeAwsState>;
    return { accounts: parsed.accounts ?? {} };
  } catch {
    return { accounts: {} };
  }
}

function emptyAccount(name: string): FakeAwsAccountState {
  return { name, instances: {}, byToken: {}, refusals: [] };
}

/** Read, change and replace the state file — one account's slice of it. */
function withAccount<T>(
  path: string,
  shard: { id: string; name: string },
  change: (account: FakeAwsAccountState) => T,
): T {
  const state = readFakeAwsState(path);
  const account = state.accounts[shard.id] ?? emptyAccount(shard.name);
  try {
    return change(account);
  } finally {
    // Written back on a throw too: a consumed refusal is used once.
    state.accounts[shard.id] = account;
    replaceFixtureFileSync(path, JSON.stringify(state));
  }
}

function readAccount(path: string, shard: { id: string; name: string }): FakeAwsAccountState {
  return readFakeAwsState(path).accounts[shard.id] ?? emptyAccount(shard.name);
}

/** `User initiated (YYYY-MM-DD HH:MM:SS GMT)` — the reason text the adapter dates
 *  a stop by (`transitionTimeOf`). */
export function fakeAwsTransitionReason(at: Date): string {
  return `User initiated (${at.toISOString().slice(0, 19).replace('T', ' ')} GMT)`;
}

function randomHex(length: number): string {
  let out = '';
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** A fresh instance id in EC2's shape. */
export function fakeAwsInstanceId(): string {
  return `i-${randomHex(17)}`;
}

function viewOf(record: FakeAwsInstanceRecord): Ec2Instance {
  return {
    instanceId: record.instanceId,
    state: record.state,
    launchTime: record.launchTime ? new Date(record.launchTime) : null,
    stateTransitionReason: record.stateTransitionReason,
    availabilityZone: record.availabilityZone,
    tags: record.tags,
  };
}

function matches(
  filters: readonly Ec2Filter[],
  tags: readonly Ec2Tag[],
  attrs: Record<string, string>,
) {
  return filters.every((f) => {
    if (f.name.startsWith('tag:')) {
      const key = f.name.slice('tag:'.length);
      return tags.some((t) => t.key === key && f.values.includes(t.value));
    }
    if (f.name === 'tag-key') return tags.some((t) => f.values.includes(t.key));
    const have = attrs[f.name];
    return have !== undefined && f.values.includes(have);
  });
}

function subnetIdFor(shardId: string, zone: string): string {
  return `subnet-${shardId.slice(-8)}${zone.slice(-1)}`;
}

/**
 * One account's EC2 over the state file. Throws the CALLER's `Ec2ApiError`
 * (handed in by `lib/orchestrator/index.ts`), so the adapter's `instanceof`
 * reads it whichever bundle each side was loaded from.
 */
export function createFileBackedEc2(
  path: string,
  shard: Pick<FleetShardDTO, 'id' | 'name'>,
  errors: { Ec2ApiError: typeof Ec2ApiError },
): Ec2Api {
  const fail = (code: string): never => {
    const status = fakeAwsStatusFor(code);
    throw new errors.Ec2ApiError(code, status, status >= 500);
  };
  // The lane provisions no network: add-shard's calls are refused outright.
  const noNetwork = async (): Promise<never> => fail('UnauthorizedOperation');
  const shardTags = (): Ec2Tag[] => [{ key: SHARD_TAG_KEY, value: shard.name }];

  return {
    async describeAvailabilityZones() {
      return FAKE_AWS_ZONES.map((zoneName) => ({ zoneName, state: 'available' }));
    },
    describeVpcs: noNetwork,
    createVpc: noNetwork,
    describeInternetGateways: noNetwork,
    createInternetGateway: noNetwork,
    attachInternetGateway: noNetwork,
    describeRouteTables: noNetwork,
    createRouteTable: noNetwork,
    createRoute: noNetwork,
    associateRouteTable: noNetwork,
    createSubnet: noNetwork,
    modifySubnetAttribute: noNetwork,
    createSecurityGroup: noNetwork,

    // The network add-shard would have left: one subnet per zone and one group,
    // tagged with the account's name.
    async describeSubnets(filters) {
      return FAKE_AWS_ZONES.map((zone, i) => ({
        subnetId: subnetIdFor(shard.id, zone),
        vpcId: `vpc-${shard.id.slice(-8)}`,
        availabilityZone: zone,
        cidrBlock: `10.0.${i}.0/24`,
        mapPublicIpOnLaunch: true,
        tags: shardTags(),
      })).filter((s) => matches(filters, s.tags, {}));
    },
    async describeSecurityGroups(filters) {
      return [
        {
          groupId: `sg-${shard.id.slice(-8)}`,
          groupName: `motir-${shard.name}`,
          vpcId: `vpc-${shard.id.slice(-8)}`,
          ingressRuleCount: 0,
          tags: shardTags(),
        },
      ].filter((g) => matches(filters, g.tags, {}));
    },

    async runInstances(input: Ec2RunInstanceInput) {
      const zone = FAKE_AWS_ZONES.find((z) => subnetIdFor(shard.id, z) === input.subnetId);
      if (!zone) return fail('InvalidSubnetID.NotFound');
      return withAccount(path, shard, (account) => {
        const existing = account.byToken[input.clientToken];
        if (existing && account.instances[existing]) {
          return viewOf(account.instances[existing]!);
        }
        const queued = account.refusals.findIndex((r) => !r.zone || r.zone === zone);
        if (queued >= 0) {
          const [refusal] = account.refusals.splice(queued, 1);
          return fail(refusal!.code);
        }
        const record: FakeAwsInstanceRecord = {
          instanceId: fakeAwsInstanceId(),
          state: 'running',
          launchTime: new Date().toISOString(),
          stateTransitionReason: null,
          availabilityZone: zone,
          tags: [...input.tags],
          request: {
            clientToken: input.clientToken,
            imageId: input.imageId,
            instanceType: input.instanceType,
            subnetId: input.subnetId,
            userData: input.userData,
          },
        };
        account.instances[record.instanceId] = record;
        account.byToken[input.clientToken] = record.instanceId;
        // EC2's own answer to a launch: `pending`, whatever it is a moment later.
        return { ...viewOf(record), state: 'pending' };
      });
    },

    async describeInstances(input: Ec2DescribeInstancesInput) {
      const account = readAccount(path, shard);
      if (input.instanceIds) {
        for (const id of input.instanceIds) {
          if (!/^i-[0-9a-f]+$/.test(id)) fail('InvalidInstanceID.Malformed');
          if (!account.instances[id]) fail('InvalidInstanceID.NotFound');
        }
      }
      const matching = Object.values(account.instances)
        .filter((i) => !input.instanceIds || input.instanceIds.includes(i.instanceId))
        .filter((i) =>
          matches(input.filters ?? [], i.tags, {
            'instance-state-name': i.state,
            'instance-id': i.instanceId,
          }),
        )
        .map(viewOf);
      const start = input.nextToken ? Number(input.nextToken) : 0;
      const end = start + (input.maxResults ?? matching.length);
      return {
        instances: matching.slice(start, end),
        nextToken: end < matching.length ? String(end) : null,
      };
    },

    async terminateInstances(instanceIds) {
      const known = readAccount(path, shard);
      for (const id of instanceIds) {
        if (!known.instances[id]) fail('InvalidInstanceID.NotFound');
      }
      withAccount(path, shard, (account) => {
        for (const id of instanceIds) {
          const record = account.instances[id];
          if (record && record.state !== 'terminated') {
            record.state = 'terminated';
            record.stateTransitionReason = fakeAwsTransitionReason(new Date());
          }
        }
      });
    },
  };
}

/** The agent-runner switch as the fixture says it, or null when it says nothing. */
export function readFleetSwitchFixture(): boolean | null {
  const path = pathFrom(FAKE_FLEET_SWITCH_PATH_ENV_VAR);
  if (!path) return null;
  try {
    const fixture = JSON.parse(readFixtureFileSync(path)) as FleetSwitchFixture;
    if (fixture.hostedAgent === 'aws') return true;
    if (fixture.hostedAgent === 'fly') return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Install the fake AWS in THIS process: every `aws` account's EC2 becomes the
 * state file, and the agent-runner switch reads the fixture first. Answers
 * whether it installed — false, and nothing touched, with the path unset.
 */
export async function installFakeAwsSeam(): Promise<boolean> {
  const path = pathFrom(FAKE_AWS_STATE_PATH_ENV_VAR);
  if (!path) return false;
  const { setAwsEc2OverrideForTests } = await import('@/lib/orchestrator');
  setAwsEc2OverrideForTests((shard, errors) => createFileBackedEc2(path, shard, errors));
  const { setAgentRunnerSwitchForTests } = await import('@/lib/ciFleet/fleetKindSwitches');
  setAgentRunnerSwitchForTests(readFleetSwitchFixture);
  return true;
}
