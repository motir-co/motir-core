import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_OUT_OF_STOCK_CODES,
  AWS_QUOTA_CODES,
  AWS_THROTTLED_CODES,
  Ec2ApiError,
  OrchestratorApiError,
  OrchestratorCapacityError,
  classifyAwsLaunchError,
  createAwsOrchestrator,
} from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';
import { AWS_AMI_ID, AWS_SHARD_TAG, AWS_SPEC, AWS_SPEC_ENV } from './contract/awsHarness';

// AWS capacity refusals (MOTIR-9277): an EC2 "full" code becomes the port's
// `OrchestratorCapacityError`, and an out-of-stock zone moves the launch to the
// next zone. Over the in-memory EC2; nothing reaches AWS.

const ZONES = ['us-east-1a', 'us-east-1b', 'us-east-1c'];

let ec2: AwsEc2Fake;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

function adapter() {
  return createAwsOrchestrator({
    ec2,
    region: 'us-east-1',
    shardTag: AWS_SHARD_TAG,
    amiId: AWS_AMI_ID,
  });
}

async function refusal(promise: Promise<unknown>): Promise<OrchestratorApiError> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: OrchestratorApiError) => err,
  );
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(AWS_SHARD_TAG, ZONES);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a quota or throttling refusal is account-wide: one attempt, typed', () => {
  it.each([
    ['VcpuLimitExceeded', 'quota_exceeded'],
    ['InstanceLimitExceeded', 'quota_exceeded'],
    ['RequestLimitExceeded', 'throttled'],
    ['Throttling', 'throttled'],
  ])('%s → %s, in the zone tried, with no second zone and no instance', async (code, reason) => {
    ec2.failNextRunInstances({ code });

    const err = await refusal(adapter().provision(AWS_SPEC));

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({
      provider: 'aws',
      reason,
      zone: 'us-east-1a',
      providerCode: code,
      retryable: true,
    });
    expect(ec2.count('runInstances')).toBe(1);
    expect(ec2.liveInstanceIds()).toEqual([]);
  });
});

describe('an out-of-stock zone moves the launch to the next zone', () => {
  it('launches in a different zone, each attempt with its own ClientToken', async () => {
    ec2.failNextRunInstances({ code: 'InsufficientInstanceCapacity', zone: 'us-east-1a' });

    const handle = await adapter().provision(AWS_SPEC);

    const attempts = ec2.calls
      .filter((c) => c.method === 'runInstances')
      .map((c) => c.input as { clientToken: string; subnetId: string });
    expect(attempts).toHaveLength(2);
    expect(ec2.refusals.map((r) => r.zone)).toEqual(['us-east-1a']);
    expect(ec2.instances.get(handle.id)!.availabilityZone).toBe('us-east-1b');
    expect(new Set(attempts.map((a) => a.subnetId)).size).toBe(2);
    expect(attempts[0]!.clientToken).not.toBe(attempts[1]!.clientToken);
    expect(ec2.liveInstanceIds()).toEqual([handle.id]);
  });

  it('with every zone out, tries each once and throws ONE out_of_stock naming the last', async () => {
    for (const zone of ZONES) ec2.setZoneOutOfStock(zone);

    const err = await refusal(adapter().provision(AWS_SPEC));

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({
      reason: 'out_of_stock',
      zone: 'us-east-1c',
      providerCode: 'InsufficientInstanceCapacity',
    });
    expect(ec2.count('runInstances')).toBe(3);
    expect(ec2.refusals.map((r) => r.zone)).toEqual(ZONES);
    expect(ec2.liveInstanceIds()).toEqual([]);
  });

  it('starts at the rotation and wraps around the list', async () => {
    const orchestrator = adapter();
    await orchestrator.provision(AWS_SPEC); // rotation 0 → us-east-1a
    for (const zone of ZONES) ec2.setZoneOutOfStock(zone);

    await refusal(orchestrator.provision(AWS_SPEC)); // rotation 1 → b, c, a
    expect(ec2.refusals.map((r) => r.zone)).toEqual(['us-east-1b', 'us-east-1c', 'us-east-1a']);
  });

  it('remembers no zone between calls', async () => {
    const orchestrator = adapter();
    ec2.setZoneOutOfStock('us-east-1a');
    await orchestrator.provision(AWS_SPEC);
    ec2.setZoneOutOfStock('us-east-1a', false);
    await orchestrator.provision(AWS_SPEC); // rotation 1 → b
    await orchestrator.provision(AWS_SPEC); // rotation 2 → c
    const fourth = await orchestrator.provision(AWS_SPEC); // rotation 3 → a again
    expect(ec2.instances.get(fourth.id)!.availabilityZone).toBe('us-east-1a');
  });

  it('an account with one zone makes one attempt and throws out_of_stock', async () => {
    ec2 = new AwsEc2Fake();
    ec2.seedShardNetwork(AWS_SHARD_TAG, ['us-east-1a']);
    ec2.failNextRunInstances({ code: 'InsufficientInstanceCapacity' });

    const err = await refusal(adapter().provision(AWS_SPEC));

    expect(err).toMatchObject({ reason: 'out_of_stock', zone: 'us-east-1a' });
    expect(ec2.count('runInstances')).toBe(1);
  });

  it('a zone out of stock is not resent with the same token, though EC2 marks it a 500', async () => {
    ec2.failNextRunInstances({ code: 'InsufficientInstanceCapacity', zone: 'us-east-1a' });
    await adapter().provision(AWS_SPEC);
    expect(ec2.refusals).toHaveLength(1);
    expect(ec2.count('runInstances')).toBe(2);
  });
});

describe('any other refusal is not a full account', () => {
  it.each(['InvalidAMIID.NotFound', 'InvalidSubnetID.NotFound', 'InvalidUserData.Malformed'])(
    '%s throws a plain OrchestratorApiError after one attempt',
    async (code) => {
      ec2.failNextRunInstances({ code });

      const err = await refusal(adapter().provision(AWS_SPEC));

      expect(err).toBeInstanceOf(OrchestratorApiError);
      expect(err).not.toBeInstanceOf(OrchestratorCapacityError);
      expect(ec2.count('runInstances')).toBe(1);
    },
  );

  it('an out-of-stock zone followed by a broken refusal stops at the broken one', async () => {
    ec2.failNextRunInstances({ code: 'InsufficientInstanceCapacity', zone: 'us-east-1a' });
    ec2.failNextRunInstances({ code: 'InvalidAMIID.NotFound', zone: 'us-east-1b' });

    const err = await refusal(adapter().provision(AWS_SPEC));

    expect(err).not.toBeInstanceOf(OrchestratorCapacityError);
    expect(ec2.count('runInstances')).toBe(2);
  });
});

it('no refusal carries the user-data, the JIT config or an AWS message', async () => {
  const marker = 'CAPACITYMARKERJIT0123456789';
  const spec = { ...AWS_SPEC, env: { ...AWS_SPEC_ENV, ACTIONS_RUNNER_INPUT_JITCONFIG: marker } };
  for (const zone of ZONES) ec2.setZoneOutOfStock(zone);

  const err = await refusal(adapter().provision(spec));

  const payload = (
    ec2.calls.find((c) => c.method === 'runInstances')!.input as { userData: string }
  ).userData;
  const surfaced = `${err.message} ${JSON.stringify(err)} ${JSON.stringify([warn.mock.calls, error.mock.calls])}`;
  expect(surfaced).not.toContain(marker);
  expect(surfaced).not.toContain(payload);
  expect((err as OrchestratorCapacityError).providerCode).toBe('InsufficientInstanceCapacity');
});

describe('classifyAwsLaunchError', () => {
  it('maps every code in the three lists, by exact code only', () => {
    const cases = [
      ...AWS_QUOTA_CODES.map((c) => [c, 'quota_exceeded'] as const),
      ...AWS_OUT_OF_STOCK_CODES.map((c) => [c, 'out_of_stock'] as const),
      ...AWS_THROTTLED_CODES.map((c) => [c, 'throttled'] as const),
    ];
    for (const [code, reason] of cases) {
      expect(classifyAwsLaunchError(new Ec2ApiError(code, 400, false), 'us-east-1a')).toMatchObject(
        {
          reason,
          providerCode: code,
          status: 400,
        },
      );
    }
    // A near-miss code, or a code only in the message, is not a capacity refusal.
    expect(
      classifyAwsLaunchError(new Ec2ApiError('VcpuLimitExceededX', 400, false), null),
    ).not.toBeInstanceOf(OrchestratorCapacityError);
    expect(classifyAwsLaunchError(new Error('VcpuLimitExceeded'), null)).toMatchObject({
      provider: 'aws',
      status: null,
    });
  });
});
