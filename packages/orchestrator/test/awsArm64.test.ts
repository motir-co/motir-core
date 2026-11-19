import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_DEFAULT_ARM64_INSTANCE_TYPE,
  AWS_DEFAULT_INSTANCE_TYPE,
  OrchestratorCapacityError,
  OrchestratorNotConfiguredError,
  createAwsOrchestrator,
  type AwsOrchestratorConfig,
  type ContainerSpec,
} from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';
import {
  AWS_AMI_ID,
  AWS_HOSTED_ENV,
  AWS_HOSTED_IMAGE,
  AWS_INDEXER_AMI_ID,
  AWS_INDEX_SPEC_OVERRIDES,
  AWS_SHARD_TAG,
  AWS_SPEC,
} from './contract/awsHarness';

// An ARM64 CI runner (MOTIR-11782): the adapter picks the arm64 AMI and the
// Graviton type TOGETHER for an arm64 `ci_runner` spec, never walks Spot for it,
// and refuses — before any EC2 call — an arm64 spec it has no image for or a
// workload that boots no arm64 image. Every x86 launch is unchanged. Over the
// in-memory EC2; nothing reaches AWS.

const ZONES = ['us-east-1a', 'us-east-1b', 'us-east-1c'];
const ARM64_AMI_ID = 'ami-0a1b2c3d4e5f6a7b8';

const ARM64_SPEC: ContainerSpec = { ...AWS_SPEC, architecture: 'arm64' };
const HOSTED_SPEC: ContainerSpec = {
  ...AWS_SPEC,
  workload: 'hosted_agent',
  workflowJobId: null,
  image: AWS_HOSTED_IMAGE,
  env: AWS_HOSTED_ENV,
};
const INDEX_SPEC: ContainerSpec = {
  ...AWS_SPEC,
  workload: 'code_graph_index',
  ...AWS_INDEX_SPEC_OVERRIDES,
};

let ec2: AwsEc2Fake;
let callsBefore = 0;

function adapter(overrides: Partial<AwsOrchestratorConfig> = {}) {
  return createAwsOrchestrator({
    ec2,
    region: 'us-east-1',
    shardTag: AWS_SHARD_TAG,
    amiId: AWS_AMI_ID,
    arm64AmiId: ARM64_AMI_ID,
    indexerAmiId: AWS_INDEXER_AMI_ID,
    spotInstanceTypes: ['m6i.large', 'm7i.large'],
    ...overrides,
  });
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: Error) => err,
  );
}

/** No EC2 call at all — not even the network read a launch starts with. */
function expectNoEc2Call() {
  expect(ec2.calls.slice(callsBefore)).toEqual([]);
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(AWS_SHARD_TAG, ZONES);
  callsBefore = ec2.calls.length;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an arm64 CI runner boots the arm64 AMI on the Graviton type', () => {
  it('is m7g.large by default', () => {
    expect(AWS_DEFAULT_ARM64_INSTANCE_TYPE).toBe('m7g.large');
  });

  it('sends ONE on-demand RunInstances of m7g.large from the arm64 AMI', async () => {
    const handle = await adapter().provision(ARM64_SPEC);

    expect(ec2.launchAttempts()).toEqual([
      expect.objectContaining({ instanceType: 'm7g.large', market: 'on_demand' }),
    ]);
    const request = ec2.requestOf(handle.id);
    expect(request.imageId).toBe(ARM64_AMI_ID);
    expect(request.instanceType).toBe('m7g.large');
    expect(request).not.toHaveProperty('market');
    expect(handle.capacity).toBeUndefined();
  });

  it("takes the config's arm64 type override over the default", async () => {
    const handle = await adapter({ arm64InstanceType: 'c7g.large' }).provision(ARM64_SPEC);

    const request = ec2.requestOf(handle.id);
    expect(request.instanceType).toBe('c7g.large');
    expect(request.imageId).toBe(ARM64_AMI_ID);
  });

  it('never walks Spot, even when the spec asks for it', async () => {
    const handle = await adapter().provision({ ...ARM64_SPEC, capacity: 'spot' });

    expect(ec2.launchAttempts()).toEqual([
      expect.objectContaining({ instanceType: 'm7g.large', market: 'on_demand' }),
    ]);
    expect(ec2.requestOf(handle.id).imageId).toBe(ARM64_AMI_ID);
    // On-demand by refusal to walk, so the handle reports no Spot outcome.
    expect(handle.capacity).toBeUndefined();
  });

  it('walks the zones on a capacity refusal with the same type and image', async () => {
    ec2.setZoneOutOfStock('us-east-1a');

    const handle = await adapter().provision(ARM64_SPEC);

    const attempts = ec2.launchAttempts();
    expect(attempts.map((a) => a.instanceType)).toEqual(['m7g.large', 'm7g.large']);
    expect(attempts[1]!.subnetId).toBe(`subnet-${AWS_SHARD_TAG}-us-east-1b`);
    expect(ec2.requestOf(handle.id).imageId).toBe(ARM64_AMI_ID);
  });

  it('throws the classified capacity refusal when every zone is out, and never tries x86', async () => {
    for (const zone of ZONES) ec2.setZoneOutOfStock(zone);

    const err = await refusal(adapter().provision(ARM64_SPEC));

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(ec2.launchAttempts().every((a) => a.instanceType === 'm7g.large')).toBe(true);
  });
});

describe('an arm64 spec the adapter cannot boot is refused before any EC2 call', () => {
  it('refuses an arm64 CI runner when no arm64 AMI is configured — never the x86 AMI', async () => {
    const err = await refusal(adapter({ arm64AmiId: undefined }).provision(ARM64_SPEC));

    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(err.message).toContain('MOTIR_AWS_RUNNER_ARM64_AMI_ID');
    expectNoEc2Call();
  });

  it.each([
    ['hosted_agent', HOSTED_SPEC],
    ['code_graph_index', INDEX_SPEC],
    ['agent_instance', { ...AWS_SPEC, workload: 'agent_instance' as const }],
  ])('refuses an arm64 %s', async (workload, spec) => {
    const err = await refusal(adapter().provision({ ...spec, architecture: 'arm64' }));

    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(err.message).toContain(`arm64 ${workload}`);
    expectNoEc2Call();
  });
});

describe('every x86 launch is unchanged with an arm64 AMI configured', () => {
  it.each([
    ['absent', AWS_SPEC],
    ['x86_64', { ...AWS_SPEC, architecture: 'x86_64' as const }],
  ])(
    'a CI runner whose architecture is %s boots m6i.large from the runner AMI',
    async (_, spec) => {
      const handle = await adapter().provision(spec);

      const request = ec2.requestOf(handle.id);
      expect(request.instanceType).toBe(AWS_DEFAULT_INSTANCE_TYPE);
      expect(request.imageId).toBe(AWS_AMI_ID);
    },
  );

  it('an x86 CI runner asking for Spot still walks the Spot list', async () => {
    const handle = await adapter().provision({ ...AWS_SPEC, capacity: 'spot' });

    expect(ec2.launchAttempts()[0]).toMatchObject({ instanceType: 'm6i.large', market: 'spot' });
    expect(ec2.requestOf(handle.id).imageId).toBe(AWS_AMI_ID);
  });

  it('a hosted agent boots the x86 type from the runner AMI', async () => {
    const handle = await adapter().provision(HOSTED_SPEC);

    const request = ec2.requestOf(handle.id);
    expect(request.instanceType).toBe(AWS_DEFAULT_INSTANCE_TYPE);
    expect(request.imageId).toBe(AWS_AMI_ID);
  });

  it('an index VM boots the x86 type from the indexer AMI', async () => {
    const handle = await adapter().provision(INDEX_SPEC);

    const request = ec2.requestOf(handle.id);
    expect(request.instanceType).toBe(AWS_DEFAULT_INSTANCE_TYPE);
    expect(request.imageId).toBe(AWS_INDEXER_AMI_ID);
  });
});
