import {
  FLEET_CONTAINER_SIZE,
  createAwsPersistentOrchestrator,
  type PersistentContainerSpec,
} from '../../src/index';
import { AwsEc2Fake } from './awsEc2Fake';
import { FakeHostAgentClient, testHostAgentConfig } from './awsHostAgentFake';
import type { PersistentContractHarness } from './persistentContract';

// The AWS adapter's persistent half behind the shared persistent contract
// (MOTIR-9469), over the in-memory EC2 of `awsEc2Fake.ts` with the account's
// network seeded by tag.
//
// Every case runs. The listing (MOTIR-9479): a machine made by hand is a planted
// instance with the account's tag and no instance id. Exec and liveness
// (MOTIR-9470) go through the instance's public address to an in-memory host
// agent (`awsHostAgentFake.ts`), whose behaviour the exec controls set.

export const AWS_HOSTER_SHARD_TAG = 'agent-hoster-use1-1';
export const AWS_HOSTER_AMI_ID = 'ami-0fedcba9876543210';
export const AWS_HOSTER_ZONES = ['us-east-1a', 'us-east-1b'];

const START = Date.parse('2026-10-24T10:00:00.000Z');

export const AWS_PERSISTENT_SPEC: PersistentContainerSpec = {
  orgId: 'org-contract',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  instanceId: 'inst-contract-a',
  image: 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'c'.repeat(64),
  size: FLEET_CONTAINER_SIZE,
  env: { MOTIR_INSTANCE_ID: 'inst-contract-a' },
  region: 'us-east-1',
  volumeSizeGb: 10,
  mountPath: '/home/node',
  terminal: null,
  idleCommand: ['sleep', 'infinity'],
  availabilityZone: 'us-east-1a',
};

export function awsPersistentHarness(): PersistentContractHarness {
  const ec2 = new AwsEc2Fake();
  let clock = START;
  const agent = new FakeHostAgentClient();
  const orchestrator = createAwsPersistentOrchestrator({
    ec2,
    hostAgent: testHostAgentConfig(agent),
    region: 'us-east-1',
    shardTag: AWS_HOSTER_SHARD_TAG,
    amiId: AWS_HOSTER_AMI_ID,
    now: () => new Date(clock),
    sleep: async () => {},
  });
  const inApp = (app: string, tags: ReadonlyArray<{ key: string; value: string }>) =>
    tags.some((t) => t.key === 'motir-shard' && t.value === app);
  return {
    orchestrator,
    reset() {
      ec2.clear();
      agent.calls.length = 0;
      agent.behaviour = {};
      clock = START;
      ec2.now = () => new Date(clock);
      ec2.seedShardNetwork(AWS_HOSTER_SHARD_TAG, AWS_HOSTER_ZONES);
    },
    spec: (overrides = {}) => ({ ...AWS_PERSISTENT_SPEC, ...overrides }),
    advance(ms) {
      clock += ms;
    },
    // A 4xx: refused outright, not retried — and RunInstances makes the machine
    // and its disk in one call, so a refusal leaves neither.
    setExecBehaviour(behaviour) {
      agent.behaviour = behaviour;
    },
    execs: () =>
      agent.records(
        (address) =>
          [...ec2.instances.values()].find((i) => i.publicIpAddress === address)?.instanceId ??
          address,
      ),
    failNextMachineCreate: () => ec2.failNext('runInstances', 'InvalidParameterValue', 400),
    destroyOutOfBand(handle, options = {}) {
      if (options.machine !== false) ec2.terminateOutside(handle.machineId);
    },
    addUntrackedMachine: (app) =>
      ec2.plantInstance({
        tags: [{ key: 'motir-shard', value: app }],
        launchTime: new Date(clock),
      }),
    liveMachineIds: (app) =>
      [...ec2.instances.values()]
        .filter((i) => i.state !== 'terminated' && inApp(app, i.tags))
        .map((i) => i.instanceId),
    liveVolumeIds: (app) =>
      [...ec2.volumes.values()].filter((v) => inApp(app, v.tags)).map((v) => v.volumeId),
    operationLog: () =>
      ec2.calls.flatMap((c) =>
        c.method === 'terminateInstances'
          ? (c.input as string[]).map((id) => `machine:${id}`)
          : c.method === 'deleteVolume'
            ? [`volume:${String(c.input)}`]
            : [],
      ),
  };
}
