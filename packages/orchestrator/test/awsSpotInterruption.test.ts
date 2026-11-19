import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAwsOrchestrator,
  createEc2Api,
  type ContainerSpec,
  type Ec2SdkClientFactory,
} from '../src/index';
import { AwsEc2Fake, SPOT_TERMINATION_CODE } from './contract/awsEc2Fake';
import { AWS_AMI_ID, AWS_ATTRIBUTION, AWS_SHARD_TAG, AWS_SPEC } from './contract/awsHarness';

// A CI runner EC2 RECLAIMED for Spot capacity (MOTIR-11728): the adapter's
// `describe` reads the instance's lifecycle and state-reason code while the
// terminated instance is still describable, and reports a provider-neutral
// `reclaimed` — over the in-memory EC2. Nothing reaches AWS.

const ZONES = ['us-east-1a', 'us-east-1b', 'us-east-1c'];
const TYPES = ['m6i.large', 'm7i.large'];

const SPOT_SPEC: ContainerSpec = { ...AWS_SPEC, capacity: 'spot' };

let ec2: AwsEc2Fake;

function adapter() {
  return createAwsOrchestrator({
    ec2,
    region: 'us-east-1',
    shardTag: AWS_SHARD_TAG,
    amiId: AWS_AMI_ID,
    spotInstanceTypes: TYPES,
  });
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(AWS_SHARD_TAG, ZONES);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a Spot instance EC2 reclaimed', () => {
  it('describes as terminal and reclaimed once terminated', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);
    expect(handle.capacity).toBe('spot');

    ec2.reclaimSpot(handle.id);
    const status = await orchestrator.describe(handle);

    expect(status).toMatchObject({ terminal: true, reclaimed: true, exists: false });
  });

  it('describes as terminal and reclaimed while still shutting down', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);

    ec2.reclaimSpot(handle.id, { holdShuttingDown: true });
    const status = await orchestrator.describe(handle);

    expect(status).toMatchObject({
      terminal: true,
      reclaimed: true,
      exists: true,
      state: 'shutting-down',
    });
  });

  it('cannot say why once EC2 has forgotten the instance — no reclaimed', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);

    ec2.reclaimSpot(handle.id);
    ec2.ageOut(handle.id);
    const status = await orchestrator.describe(handle);

    expect(status.terminal).toBe(true);
    expect(status).not.toHaveProperty('reclaimed');
  });

  it('a running Spot instance is not reclaimed', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);

    const status = await orchestrator.describe(handle);

    expect(status.terminal).toBe(false);
    expect(status).not.toHaveProperty('reclaimed');
  });
});

describe('an instance that ended any other way is never reclaimed', () => {
  it('an on-demand instance terminated by our own teardown', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(AWS_SPEC);
    expect(handle.capacity).toBeUndefined();

    await orchestrator.teardown(handle, 'job_completed', AWS_ATTRIBUTION);
    const status = await orchestrator.describe(handle);

    expect(status.terminal).toBe(true);
    expect(status).not.toHaveProperty('reclaimed');
  });

  it('a Spot instance terminated by our own teardown', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);

    await orchestrator.teardown(handle, 'job_completed', AWS_ATTRIBUTION);
    const status = await orchestrator.describe(handle);

    expect(status.terminal).toBe(true);
    expect(status).not.toHaveProperty('reclaimed');
  });

  it('a Spot instance shutting down after our own terminate', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);

    ec2.holdNextTerminate = true;
    await orchestrator.teardown(handle, 'job_completed', AWS_ATTRIBUTION);
    const status = await orchestrator.describe(handle);

    expect(status).toMatchObject({ terminal: true, state: 'shutting-down' });
    expect(status).not.toHaveProperty('reclaimed');
  });

  it('a Spot instance terminated with any other state-reason code', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);

    ec2.reclaimSpot(handle.id, { code: 'Server.InternalError' });
    const status = await orchestrator.describe(handle);

    expect(status.terminal).toBe(true);
    expect(status).not.toHaveProperty('reclaimed');
  });

  it('a Spot instance that powered itself off at the end of its job', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);

    ec2.powerOff(handle.id);
    const status = await orchestrator.describe(handle);

    expect(status.terminal).toBe(true);
    expect(status).not.toHaveProperty('reclaimed');
  });

  it('an on-demand instance carrying the Spot termination code', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(AWS_SPEC);

    ec2.reclaimSpot(handle.id, { code: SPOT_TERMINATION_CODE });
    const status = await orchestrator.describe(handle);

    expect(status.terminal).toBe(true);
    expect(status).not.toHaveProperty('reclaimed');
  });
});

describe('the port carries no AWS name', () => {
  it('a reclaimed status names neither the lifecycle nor the state-reason code', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(SPOT_SPEC);

    ec2.reclaimSpot(handle.id);
    const status = await orchestrator.describe(handle);
    const serialised = JSON.stringify({ status, handle });

    expect(serialised).not.toContain('Server.SpotInstanceTermination');
    expect(serialised).not.toContain('instanceLifecycle');
    expect(serialised).not.toContain('stateReasonCode');
  });
});

describe('the EC2 client reads the structured fields', () => {
  function stub(answer: unknown) {
    const factory: Ec2SdkClientFactory = () => ({
      async send() {
        return answer;
      },
    });
    return createEc2Api(
      { accessKeyId: 'AKID', secretAccessKey: 'secret', region: 'us-east-1' },
      factory,
    );
  }

  it('maps StateReason.Code and InstanceLifecycle', async () => {
    const ec2Api = stub({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-1',
              State: { Name: 'terminated' },
              StateReason: { Code: 'Server.SpotInstanceTermination', Message: 'm' },
              InstanceLifecycle: 'spot',
            },
            { InstanceId: 'i-2', State: { Name: 'running' } },
          ],
        },
      ],
    });

    const { instances } = await ec2Api.describeInstances({ instanceIds: ['i-1', 'i-2'] });

    expect(instances[0]).toMatchObject({
      stateReasonCode: 'Server.SpotInstanceTermination',
      instanceLifecycle: 'spot',
    });
    expect(instances[1]).not.toHaveProperty('stateReasonCode');
    expect(instances[1]).not.toHaveProperty('instanceLifecycle');
  });
});
