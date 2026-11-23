import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_QUOTA_CODES,
  AWS_SPOT_LIMIT_CODES,
  AWS_SPOT_OUT_OF_STOCK_CODES,
  AWS_THROTTLED_CODES,
  Ec2ApiError,
  OrchestratorCapacityError,
  OrchestratorNotConfiguredError,
  awsSpotRefusal,
  createAwsOrchestrator,
  isAwsCapacityCode,
  type AwsOrchestratorConfig,
  type ContainerSpec,
  type Ec2Api,
} from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';
import {
  AWS_AMI_ID,
  AWS_HOSTED_ENV,
  AWS_HOSTED_IMAGE,
  AWS_SHARD_TAG,
  AWS_SPEC,
} from './contract/awsHarness';

// A CI runner launched as SPOT (MOTIR-11716): the ordered type walk, each type's
// zone walk on the Spot market, and the immediate on-demand fallback — over the
// in-memory EC2. Nothing reaches AWS.

const ZONES = ['us-east-1a', 'us-east-1b', 'us-east-1c'];
const TYPES = ['m6i.large', 'm7i.large', 'm5.large'];

/** A value that must never surface in an error or a log line. */
const MARKER = 'MARKER-7f3c-should-never-leak';

const SPOT_SPEC: ContainerSpec = {
  ...AWS_SPEC,
  capacity: 'spot',
  env: { ...AWS_SPEC.env, ACTIONS_RUNNER_INPUT_JITCONFIG: `jit-${MARKER}` },
};

let ec2: AwsEc2Fake;
let warn: ReturnType<typeof vi.spyOn>;

function adapter(overrides: Partial<AwsOrchestratorConfig> = {}) {
  return createAwsOrchestrator({
    ec2,
    region: 'us-east-1',
    shardTag: AWS_SHARD_TAG,
    amiId: AWS_AMI_ID,
    spotInstanceTypes: TYPES,
    ...overrides,
  });
}

/** Every type of the list refused for Spot capacity in every zone. */
function refuseEverySpotType(code = 'InsufficientInstanceCapacity') {
  for (const instanceType of TYPES) ec2.refuseSpot({ instanceType, code });
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: Error) => err,
  );
}

function spotAttempts() {
  return ec2.launchAttempts().filter((a) => a.market === 'spot');
}

function onDemandAttempts() {
  return ec2.launchAttempts().filter((a) => a.market === 'on_demand');
}

/** Every warn line, as one string — what a log reader would see. */
function logged(): string {
  return JSON.stringify(warn.mock.calls);
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(AWS_SHARD_TAG, ZONES);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a CI runner asking for Spot launches on the first type of the list', () => {
  it('sends ONE Spot RunInstances on the first type, one-time, terminate, no MaxPrice', async () => {
    const handle = await adapter().provision(SPOT_SPEC);

    expect(handle).toMatchObject({ provider: 'aws', region: 'us-east-1', capacity: 'spot' });
    expect(ec2.launchAttempts()).toEqual([
      expect.objectContaining({
        instanceType: 'm6i.large',
        market: 'spot',
        subnetId: `subnet-${AWS_SHARD_TAG}-us-east-1a`,
      }),
    ]);
    const request = ec2.requestOf(handle.id);
    // The adapter asks for the Spot market and nothing else Spot-shaped: the
    // one-time / terminate options and the absent MaxPrice are the client's
    // fixed mapping of `market: 'spot'` (awsEc2Client.test.ts).
    expect(request.market).toBe('spot');
    expect(request).not.toHaveProperty('maxPrice');
    expect(request.instanceInitiatedShutdownBehavior).toBe('terminate');
  });

  it('tags the instance and its volume only — never a spot-instances-request', async () => {
    await adapter().provision(SPOT_SPEC);

    const [attempt] = ec2.launchAttempts();
    expect(attempt!.taggedResources).toEqual(['instance', 'volume']);
    expect(attempt!.taggedResources).not.toContain('spot-instances-request');
  });
});

describe('the type walk', () => {
  it('moves to the next type once every zone refused the first, each type once per zone, each attempt its own token', async () => {
    ec2.refuseSpot({ instanceType: 'm6i.large' });

    const handle = await adapter().provision(SPOT_SPEC);

    expect(handle.capacity).toBe('spot');
    expect(ec2.requestOf(handle.id).instanceType).toBe('m7i.large');
    const attempts = ec2.launchAttempts();
    expect(attempts.map((a) => [a.instanceType, a.subnetId])).toEqual([
      ['m6i.large', `subnet-${AWS_SHARD_TAG}-us-east-1a`],
      ['m6i.large', `subnet-${AWS_SHARD_TAG}-us-east-1b`],
      ['m6i.large', `subnet-${AWS_SHARD_TAG}-us-east-1c`],
      ['m7i.large', `subnet-${AWS_SHARD_TAG}-us-east-1a`],
    ]);
    expect(attempts.every((a) => a.market === 'spot')).toBe(true);
    expect(new Set(attempts.map((a) => a.clientToken)).size).toBe(attempts.length);
  });

  it('a zone-local refusal moves to the next zone of the same type first', async () => {
    ec2.refuseSpot({
      instanceType: 'm6i.large',
      zone: 'us-east-1a',
      code: 'UnfulfillableCapacity',
    });

    const handle = await adapter().provision(SPOT_SPEC);

    expect(handle.capacity).toBe('spot');
    expect(ec2.launchAttempts().map((a) => [a.instanceType, a.subnetId])).toEqual([
      ['m6i.large', `subnet-${AWS_SHARD_TAG}-us-east-1a`],
      ['m6i.large', `subnet-${AWS_SHARD_TAG}-us-east-1b`],
    ]);
  });

  it('walks the list in order to its last type', async () => {
    ec2.refuseSpot({ instanceType: 'm6i.large' });
    ec2.refuseSpot({ instanceType: 'm7i.large' });

    const handle = await adapter().provision(SPOT_SPEC);

    expect(ec2.requestOf(handle.id).instanceType).toBe('m5.large');
    expect(spotAttempts().map((a) => a.instanceType)).toEqual([
      ...Array(3).fill('m6i.large'),
      ...Array(3).fill('m7i.large'),
      'm5.large',
    ]);
  });
});

describe('no Spot to be had: ONE on-demand launch, at once', () => {
  it('every type refused in every zone → one on-demand provision on the adapter type, no timer awaited', async () => {
    vi.useFakeTimers();
    refuseEverySpotType();

    // Nothing advances the fake clock: a sleep anywhere in the walk would hang here.
    const handle = await adapter({ instanceType: 'm6i.large' }).provision(SPOT_SPEC);

    expect(vi.getTimerCount()).toBe(0);
    expect(handle.capacity).toBe('on_demand');
    expect(spotAttempts()).toHaveLength(TYPES.length * ZONES.length);
    expect(onDemandAttempts()).toEqual([
      expect.objectContaining({
        instanceType: 'm6i.large',
        subnetId: `subnet-${AWS_SHARD_TAG}-us-east-1a`,
      }),
    ]);
    expect(ec2.requestOf(handle.id)).not.toHaveProperty('market');
    expect(logged()).toContain('no Spot capacity of any type');
  });

  it.each(AWS_SPOT_LIMIT_CODES)(
    'the account Spot limit (%s) skips every remaining type and zone',
    async (code) => {
      ec2.failNextRunInstances({ code, market: 'spot' });

      const handle = await adapter().provision(SPOT_SPEC);

      expect(handle.capacity).toBe('on_demand');
      expect(spotAttempts()).toHaveLength(1);
      expect(onDemandAttempts()).toHaveLength(1);
      expect(logged()).toContain(code);
    },
  );

  it.each(['AuthFailure.ServiceLinkedRoleCreationNotPermitted', 'SpotMaxPriceTooLow', 'Unknown'])(
    'a Spot refusal that is no capacity code (%s) launches on-demand, logging the code only',
    async (code) => {
      ec2.failNextRunInstances({ code, market: 'spot' });

      const handle = await adapter().provision(SPOT_SPEC);

      expect(handle.capacity).toBe('on_demand');
      expect(spotAttempts()).toHaveLength(1);
      expect(onDemandAttempts()).toHaveLength(1);
      expect(logged()).toContain(code);
      expect(logged()).not.toContain(MARKER);
    },
  );

  it("never surfaces AWS's message, the user-data or the JIT config — in a log line or a thrown error", async () => {
    const userData = { seen: '' };
    const leaky: Ec2Api = new Proxy(ec2, {
      get(target, prop, receiver) {
        if (prop !== 'runInstances') return Reflect.get(target, prop, receiver);
        return async (input: Parameters<Ec2Api['runInstances']>[0]) => {
          userData.seen = input.userData;
          // A failure that is not an Ec2ApiError, its message echoing the request.
          if (input.market === 'spot') throw new Error(`AWS said ${MARKER} ${input.userData}`);
          throw new Ec2ApiError('VcpuLimitExceeded', 400, false);
        };
      },
    });

    const err = await refusal(adapter({ ec2: leaky }).provision(SPOT_SPEC));

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({ reason: 'quota_exceeded' });
    const surfaced = `${err.message} ${JSON.stringify(err)} ${logged()}`;
    expect(surfaced).toContain('UnknownError');
    expect(surfaced).not.toContain(MARKER);
    expect(userData.seen).not.toBe('');
    expect(surfaced).not.toContain(userData.seen);
    expect(surfaced).not.toContain('jit-');
  });

  it('a Spot attempt that keeps failing transiently is resent with its OWN token, then launches on-demand', async () => {
    const tokens: string[] = [];
    let failures = 0;
    const flaky: Ec2Api = new Proxy(ec2, {
      get(target, prop, receiver) {
        if (prop !== 'runInstances') return Reflect.get(target, prop, receiver);
        return async (input: Parameters<Ec2Api['runInstances']>[0]) => {
          if (input.market === 'spot') {
            tokens.push(input.clientToken);
            failures += 1;
            throw new Ec2ApiError('InternalError', 500, true);
          }
          return target.runInstances(input);
        };
      },
    });

    const handle = await adapter({ ec2: flaky }).provision(SPOT_SPEC);

    expect(failures).toBe(3);
    expect(new Set(tokens).size).toBe(1);
    expect(handle.capacity).toBe('on_demand');
  });
});

describe('throttling is the account’s: one attempt, no on-demand call', () => {
  it.each(AWS_THROTTLED_CODES)('%s → throttled after one Spot attempt', async (code) => {
    ec2.failNextRunInstances({ code, market: 'spot' });

    const err = await refusal(adapter().provision(SPOT_SPEC));

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({ reason: 'throttled', providerCode: code, zone: 'us-east-1a' });
    expect(ec2.count('runInstances')).toBe(1);
    expect(onDemandAttempts()).toEqual([]);
    expect(ec2.liveInstanceIds()).toEqual([]);
  });
});

describe("the on-demand fallback's own refusals are today's", () => {
  it.each([
    ...AWS_QUOTA_CODES.map((code) => [code, 'quota_exceeded'] as const),
    ['RequestLimitExceeded', 'throttled'] as const,
  ])('%s on the fallback → %s, as without Spot', async (code, reason) => {
    refuseEverySpotType();
    ec2.failNextRunInstances({ code, market: 'on_demand' });

    const err = await refusal(adapter().provision(SPOT_SPEC));

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({ provider: 'aws', reason, providerCode: code, retryable: true });
    expect(onDemandAttempts()).toHaveLength(1);
  });

  it('every zone out of stock → out_of_stock after the on-demand zone walk', async () => {
    for (const zone of ZONES) ec2.setZoneOutOfStock(zone);

    const err = await refusal(adapter().provision(SPOT_SPEC));

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({
      reason: 'out_of_stock',
      providerCode: 'InsufficientInstanceCapacity',
    });
    expect(spotAttempts()).toHaveLength(TYPES.length * ZONES.length);
    expect(onDemandAttempts()).toHaveLength(ZONES.length);
  });
});

describe('nothing else is ever Spot', () => {
  const HOSTED_SPEC: ContainerSpec = {
    ...AWS_SPEC,
    workload: 'hosted_agent',
    workflowJobId: null,
    image: AWS_HOSTED_IMAGE,
    env: AWS_HOSTED_ENV,
    capacity: 'spot',
  };

  it.each([
    ['a CI runner with no capacity', AWS_SPEC],
    ['a CI runner asking on_demand', { ...AWS_SPEC, capacity: 'on_demand' as const }],
    ['a hosted agent asking spot', HOSTED_SPEC],
  ])('%s sends no market option, on the type it always sent', async (_label, spec) => {
    const types = vi.fn(async () => TYPES);

    const handle = await adapter({
      instanceType: 'm6i.large',
      spotInstanceTypes: types,
    }).provision(spec);

    expect(ec2.count('runInstances')).toBe(1);
    const request = ec2.requestOf(handle.id);
    expect(request.instanceType).toBe('m6i.large');
    expect(request).not.toHaveProperty('market');
    expect(handle).not.toHaveProperty('capacity');
    expect(types).not.toHaveBeenCalled();
  });

  it('an agent instance asking spot is refused before any EC2 call, as today', async () => {
    const spec: ContainerSpec = { ...HOSTED_SPEC, workload: 'agent_instance' };

    await expect(adapter().provision(spec)).rejects.toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(ec2.count('runInstances')).toBe(0);
  });
});

describe('the Spot type list', () => {
  it('is read once per Spot launch when given as a read', async () => {
    const types = vi.fn(async () => ['m7i.large']);
    const orchestrator = adapter({ spotInstanceTypes: types });

    const first = await orchestrator.provision(SPOT_SPEC);
    const second = await orchestrator.provision(SPOT_SPEC);

    expect(types).toHaveBeenCalledTimes(2);
    expect(ec2.requestOf(first.id).instanceType).toBe('m7i.large');
    expect(ec2.requestOf(second.id).instanceType).toBe('m7i.large');
  });

  it.each([
    ['unset', { spotInstanceTypes: undefined }],
    ['empty', { spotInstanceTypes: [] }],
  ])('%s → straight to on-demand, with no Spot attempt and no log', async (_label, overrides) => {
    const handle = await adapter(overrides).provision(SPOT_SPEC);

    expect(handle.capacity).toBe('on_demand');
    expect(spotAttempts()).toEqual([]);
    expect(onDemandAttempts()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a read that fails → on-demand, logged without its error', async () => {
    const handle = await adapter({
      spotInstanceTypes: async () => {
        throw new Error(MARKER);
      },
    }).provision(SPOT_SPEC);

    expect(handle.capacity).toBe('on_demand');
    expect(spotAttempts()).toEqual([]);
    expect(logged()).toContain('could not be read');
    expect(logged()).not.toContain(MARKER);
  });
});

describe('the Spot refusal table', () => {
  it('matches each code exactly', () => {
    for (const code of AWS_SPOT_OUT_OF_STOCK_CODES) expect(awsSpotRefusal(code)).toBe('next_zone');
    for (const code of AWS_SPOT_LIMIT_CODES) expect(awsSpotRefusal(code)).toBe('spot_limit');
    for (const code of AWS_THROTTLED_CODES) expect(awsSpotRefusal(code)).toBe('throttled');
    expect(awsSpotRefusal('insufficientinstancecapacity')).toBe('not_capacity');
    expect(awsSpotRefusal('VcpuLimitExceeded')).toBe('not_capacity');
  });

  it('counts every capacity code of either market as never resent', () => {
    for (const code of [
      ...AWS_QUOTA_CODES,
      ...AWS_THROTTLED_CODES,
      ...AWS_SPOT_OUT_OF_STOCK_CODES,
      ...AWS_SPOT_LIMIT_CODES,
    ]) {
      expect(isAwsCapacityCode(code)).toBe(true);
    }
    expect(isAwsCapacityCode('InternalError')).toBe(false);
  });
});
