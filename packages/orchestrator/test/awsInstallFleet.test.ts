import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrchestratorNotConfiguredError,
  createAwsFleetInventory,
  createAwsOrchestrator,
  createAwsPersistentOrchestrator,
  createEc2Api,
  type ContainerSpec,
  type Ec2RunInstanceInput,
  type Ec2SdkClientFactory,
} from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';
import {
  AWS_AMI_ID,
  AWS_HOSTED_ENV,
  AWS_HOSTED_IMAGE,
  AWS_INDEXER_AMI_ID,
  AWS_INDEX_SPEC_OVERRIDES,
  AWS_SPEC,
} from './contract/awsHarness';
import { testHostAgentConfig } from './contract/awsHostAgentFake';
import { AWS_HOSTER_AMI_ID, AWS_PERSISTENT_SPEC } from './contract/awsPersistentHarness';

// THE INSTALL FLEET'S SEAMS IN THE AWS ADAPTER (Story MOTIR-10792 · MOTIR-10794):
// a network NAMED by configuration instead of found by the shard tag, the VM
// profile by ARN on an index VM only, a tag-scoped inventory, and an EC2 client on
// the SDK's default chain — the process's own identity, no key, no assumed role.

const TAG = 'motir-install-fleet';
const PROFILE_ARN = 'arn:aws:iam::944842271421:instance-profile/motir-install-fleet-vm';
const OTHER = 'some-other-network';

let ec2: AwsEc2Fake;

const INDEX_SPEC: ContainerSpec = {
  ...AWS_SPEC,
  ...AWS_INDEX_SPEC_OVERRIDES,
  workload: 'code_graph_index',
  workflowJobId: null,
};

const HOSTED_SPEC: ContainerSpec = {
  ...AWS_SPEC,
  workload: 'hosted_agent',
  workflowJobId: null,
  image: AWS_HOSTED_IMAGE,
  env: AWS_HOSTED_ENV,
};

/** The subnets a network tagged `OTHER` holds — the install fleet is handed them by id. */
const namedSubnets = () => [`subnet-${OTHER}-us-east-1a`, `subnet-${OTHER}-us-east-1b`];

function launches(): Ec2RunInstanceInput[] {
  return ec2.calls
    .filter((c) => c.method === 'runInstances')
    .map((c) => c.input as Ec2RunInstanceInput);
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  // Real subnets in the fake, tagged with something that is NOT the fleet's tag:
  // a launch can only reach them by the ids it is given.
  ec2.seedShardNetwork(OTHER);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the ephemeral adapter on a named network', () => {
  function adapter() {
    return createAwsOrchestrator({
      ec2,
      region: 'us-east-1',
      shardTag: TAG,
      amiId: AWS_AMI_ID,
      indexerAmiId: AWS_INDEXER_AMI_ID,
      network: { subnetIds: namedSubnets(), securityGroupId: `sg-${OTHER}` },
      indexInstanceProfileArn: PROFILE_ARN,
    });
  }

  it('launches into the named subnets and group, reading no network, rotating across them', async () => {
    const orchestrator = adapter();
    await orchestrator.provision(HOSTED_SPEC);
    await orchestrator.provision(HOSTED_SPEC);
    expect(ec2.calls.some((c) => c.method === 'describeSubnets')).toBe(false);
    expect(ec2.calls.some((c) => c.method === 'describeSecurityGroups')).toBe(false);
    expect(launches().map((l) => l.subnetId)).toEqual(namedSubnets());
    expect(launches().every((l) => l.securityGroupIds[0] === `sg-${OTHER}`)).toBe(true);
  });

  it('tags the instance and its volumes with the install fleet tag', async () => {
    await adapter().provision(HOSTED_SPEC);
    expect(launches()[0]!.tags).toContainEqual({ key: 'motir-shard', value: TAG });
  });

  it('gives an index VM the VM profile by ARN, and an agent run none', async () => {
    await adapter().provision(INDEX_SPEC);
    await adapter().provision(HOSTED_SPEC);
    const [index, hosted] = launches();
    expect(index).toMatchObject({ iamInstanceProfileArn: PROFILE_ARN });
    expect(index!.iamInstanceProfileName).toBeUndefined();
    expect(hosted!.iamInstanceProfileArn).toBeUndefined();
    expect(hosted!.iamInstanceProfileName).toBeUndefined();
  });

  it('a pool account with no ARN keeps its index profile by name', async () => {
    ec2.seedShardNetwork('pool-1');
    await createAwsOrchestrator({
      ec2,
      region: 'us-east-1',
      shardTag: 'pool-1',
      amiId: AWS_AMI_ID,
      indexerAmiId: AWS_INDEXER_AMI_ID,
    }).provision(INDEX_SPEC);
    expect(launches()[0]!.iamInstanceProfileName).toBeDefined();
    expect(launches()[0]!.iamInstanceProfileArn).toBeUndefined();
  });
});

describe('the persistent adapter on a named network', () => {
  function adapter(subnetIds = namedSubnets()) {
    return createAwsPersistentOrchestrator({
      ec2,
      hostAgent: testHostAgentConfig(),
      region: 'us-east-1',
      shardTag: TAG,
      amiId: AWS_HOSTER_AMI_ID,
      sleep: async () => {},
      network: { subnetIds, securityGroupId: `sg-${OTHER}` },
    });
  }

  it("launches into the named subnet of the disk's zone, writes no inbound rule and sends no profile", async () => {
    await adapter().provisionPersistent({ ...AWS_PERSISTENT_SPEC, availabilityZone: 'us-east-1b' });
    const [launch] = launches();
    expect(launch).toMatchObject({
      subnetId: `subnet-${OTHER}-us-east-1b`,
      securityGroupIds: [`sg-${OTHER}`],
    });
    expect(launch!.iamInstanceProfileArn).toBeUndefined();
    expect(launch!.tags).toContainEqual({ key: 'motir-shard', value: TAG });
    expect(ec2.calls.some((c) => c.method === 'authorizeSecurityGroupIngress')).toBe(false);
  });

  it('refuses a zone none of the named subnets is in', async () => {
    await expect(
      adapter([`subnet-${OTHER}-us-east-1a`]).provisionPersistent({
        ...AWS_PERSISTENT_SPEC,
        availabilityZone: 'us-east-1b',
      }),
    ).rejects.toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(launches()).toHaveLength(0);
  });
});

describe('a tag-scoped inventory', () => {
  it('lists only the machines and disks carrying the filter', async () => {
    const mine = ec2.plantInstance({ tags: [{ key: 'motir-shard', value: TAG }] });
    ec2.plantInstance({ tags: [{ key: 'Name', value: 'bastion' }] });
    const myDisk = ec2.plantVolume({ tags: [{ key: 'motir-shard', value: TAG }] });
    ec2.plantVolume({ tags: [] });

    const inventory = createAwsFleetInventory({
      ec2,
      region: 'us-east-1',
      accountName: TAG,
      filters: [{ name: 'tag:motir-shard', values: [TAG] }],
    });
    expect((await inventory.listMachines(TAG)).map((m) => m.machineId)).toEqual([mine]);
    expect((await inventory.listVolumes!(TAG)).map((v) => v.volumeId)).toEqual([myDisk]);
  });
});

describe('the EC2 client on the default chain', () => {
  function stub() {
    const built: unknown[] = [];
    const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
    const factory: Ec2SdkClientFactory = (config) => {
      built.push(config);
      return {
        async send(command: unknown) {
          const c = command as { constructor: { name: string }; input: Record<string, unknown> };
          sent.push({ command: c.constructor.name, input: c.input });
          return { Instances: [{ InstanceId: 'i-1', State: { Name: 'pending' } }] };
        },
      };
    };
    return { built, sent, factory };
  }

  it('hands the SDK no credentials at all, so it reads the task role', () => {
    const { built, factory } = stub();
    createEc2Api({ region: 'us-east-1', defaultCredentials: true }, factory);
    expect(built).toEqual([{ region: 'us-east-1' }]);
  });

  it('sends an instance profile ARN as IamInstanceProfile.Arn', async () => {
    const { sent, factory } = stub();
    const client = createEc2Api({ region: 'us-east-1', defaultCredentials: true }, factory);
    await client.runInstances({
      clientToken: 't',
      imageId: 'ami-1',
      instanceType: 'm7i.large',
      subnetId: 'subnet-1',
      securityGroupIds: ['sg-1'],
      userData: '',
      metadataOptions: {
        httpTokens: 'required',
        httpPutResponseHopLimit: 1,
        httpEndpoint: 'enabled',
      },
      instanceInitiatedShutdownBehavior: 'terminate',
      blockDeviceMappings: [],
      tags: [],
      iamInstanceProfileArn: PROFILE_ARN,
    });
    expect(sent[0]!.input['IamInstanceProfile']).toEqual({ Arn: PROFILE_ARN });
  });
});
