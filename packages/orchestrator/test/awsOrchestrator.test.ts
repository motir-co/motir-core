import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_REAP_PAGE_SIZE,
  AwsInstanceSizeError,
  Ec2ApiError,
  FLEET_METADATA_KEY,
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  RunnerUserDataError,
  createAwsOrchestrator,
  transitionTimeOf,
  type ContainerHandle,
  type ContainerOrchestrator,
  type Ec2Api,
} from '../src/index';
import { AwsEc2Fake, userInitiated } from './contract/awsEc2Fake';
import {
  AWS_AMI_ID,
  AWS_ATTRIBUTION,
  AWS_SHARD_TAG,
  AWS_SPEC,
  AWS_SPEC_ENV,
} from './contract/awsHarness';

// The AWS adapter's own behaviour (MOTIR-9276) — what the shared contract suite
// does not pin: the launch request EC2 receives, the user-data rule, the
// ClientToken retry, the per-state describe mapping, terminate idempotence and a
// tag-scoped, paged reap. All over the in-memory EC2; nothing reaches AWS.

const HOUR_MS = 3_600_000;

let ec2: AwsEc2Fake;
let tokens: number;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

function adapter(overrides: Partial<Parameters<typeof createAwsOrchestrator>[0]> = {}) {
  return createAwsOrchestrator({
    ec2,
    region: 'us-east-1',
    shardTag: AWS_SHARD_TAG,
    amiId: AWS_AMI_ID,
    clientToken: () => `token-${(tokens += 1)}`,
    ...overrides,
  });
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(AWS_SHARD_TAG);
  tokens = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provision', () => {
  it('sends ONE RunInstances with the AMI, m6i.large, a tagged subnet and group, and locked metadata', async () => {
    const handle = await adapter().provision(AWS_SPEC);

    expect(ec2.count('runInstances')).toBe(1);
    const request = ec2.requestOf(handle.id);
    expect(request).toMatchObject({
      imageId: AWS_AMI_ID,
      instanceType: 'm6i.large',
      subnetId: `subnet-${AWS_SHARD_TAG}-us-east-1a`,
      securityGroupIds: [`sg-${AWS_SHARD_TAG}`],
      metadataOptions: {
        httpTokens: 'required',
        httpPutResponseHopLimit: 1,
        httpEndpoint: 'enabled',
      },
      instanceInitiatedShutdownBehavior: 'terminate',
    });
    expect(request).not.toHaveProperty('iamInstanceProfile');
    expect(request).not.toHaveProperty('keyName');
    expect(handle).toMatchObject({ provider: 'aws', region: 'us-east-1' });
  });

  it('honours an instance-type override', async () => {
    const handle = await adapter({ instanceType: 'm7i.large' }).provision(AWS_SPEC);
    expect(ec2.requestOf(handle.id).instanceType).toBe('m7i.large');
  });

  it('rotates launches across the zones', async () => {
    const orchestrator = adapter();
    const subnets = [];
    for (let i = 0; i < 3; i += 1) {
      subnets.push(ec2.requestOf((await orchestrator.provision(AWS_SPEC)).id).subnetId);
    }
    expect(subnets).toEqual([
      `subnet-${AWS_SHARD_TAG}-us-east-1a`,
      `subnet-${AWS_SHARD_TAG}-us-east-1b`,
      `subnet-${AWS_SHARD_TAG}-us-east-1a`,
    ]);
  });

  it('reads the network once, then re-reads it after the cache interval', async () => {
    let at = new Date('2026-10-24T10:00:00.000Z').getTime();
    const orchestrator = adapter({ now: () => new Date(at) });
    await orchestrator.provision(AWS_SPEC);
    await orchestrator.provision(AWS_SPEC);
    expect(ec2.count('describeSubnets')).toBe(1);
    at += 10 * 60_000;
    await orchestrator.provision(AWS_SPEC);
    expect(ec2.count('describeSubnets')).toBe(2);
  });

  it('drops the cached network when RunInstances says the subnet is gone', async () => {
    const orchestrator = adapter();
    await orchestrator.provision(AWS_SPEC);
    ec2.failNext('runInstances', 'InvalidSubnetID.NotFound', 400);
    await expect(orchestrator.provision(AWS_SPEC)).rejects.toBeInstanceOf(OrchestratorApiError);
    await orchestrator.provision(AWS_SPEC);
    expect(ec2.count('describeSubnets')).toBe(2);
  });

  it('refuses a size other than 2 vCPU / 8192 MB before any EC2 call', async () => {
    for (const size of [
      { ...AWS_SPEC.size, cpus: 4 },
      { ...AWS_SPEC.size, memoryMb: 4096 },
    ]) {
      await expect(adapter().provision({ ...AWS_SPEC, size })).rejects.toBeInstanceOf(
        AwsInstanceSizeError,
      );
    }
    expect(ec2.calls).toEqual([]);
  });

  it('refuses a spec for another region before any EC2 call; an empty region is the account’s', async () => {
    await expect(adapter().provision({ ...AWS_SPEC, region: 'eu-west-1' })).rejects.toBeInstanceOf(
      OrchestratorNotConfiguredError,
    );
    expect(ec2.calls).toEqual([]);
    const handle = await adapter().provision({ ...AWS_SPEC, region: '' });
    expect(handle.region).toBe('us-east-1');
  });

  it('sends the four user-data lines, base64, without ACTIONS_RUNNER_CONFIG_ARGS', async () => {
    const handle = await adapter().provision(AWS_SPEC);
    const decoded = Buffer.from(ec2.requestOf(handle.id).userData, 'base64').toString('utf8');
    expect(decoded.trim().split('\n')).toEqual([
      `ACTIONS_RUNNER_INPUT_JITCONFIG=${AWS_SPEC_ENV['ACTIONS_RUNNER_INPUT_JITCONFIG']}`,
      'MOTIR_RUNNER_LABEL=motir-fleet',
      'MOTIR_INTENT_ID=intent-1',
      'MOTIR_WORKFLOW_JOB_ID=44001',
    ]);
    expect(decoded).not.toContain('ACTIONS_RUNNER_CONFIG_ARGS');
  });

  it.each([
    ['an extra key', { ...AWS_SPEC_ENV, EXTRA: 'x' }],
    ['a missing key', { ...AWS_SPEC_ENV, MOTIR_INTENT_ID: '' }],
    ['a newline in a value', { ...AWS_SPEC_ENV, MOTIR_INTENT_ID: 'a\nb' }],
    [
      'a payload over 16 KB',
      { ...AWS_SPEC_ENV, ACTIONS_RUNNER_INPUT_JITCONFIG: 'A'.repeat(17_000) },
    ],
  ])('refuses %s before any EC2 call', async (_what, env) => {
    await expect(adapter().provision({ ...AWS_SPEC, env })).rejects.toBeInstanceOf(
      RunnerUserDataError,
    );
    expect(ec2.calls).toEqual([]);
  });

  it('never puts the user-data or the JIT config in a log line, an error or a return value', async () => {
    const marker = 'SECRETJITMARKER0123456789';
    const spec = { ...AWS_SPEC, env: { ...AWS_SPEC_ENV, ACTIONS_RUNNER_INPUT_JITCONFIG: marker } };
    ec2.failNext('runInstances', 'InvalidUserData.Malformed', 400);

    const thrown = await adapter()
      .provision(spec)
      .then(
        () => null,
        (err: unknown) => err as Error,
      );
    const handle = await adapter().provision(spec);

    const payload = ec2.calls.find((c) => c.method === 'runInstances')!.input as {
      userData: string;
    };
    const logged = JSON.stringify([warn.mock.calls, error.mock.calls, log.mock.calls]);
    const surfaced = `${thrown?.message} ${JSON.stringify(thrown)} ${JSON.stringify(handle)}`;
    for (const secret of [marker, payload.userData, payload.userData.slice(8, 40)]) {
      expect(logged).not.toContain(secret);
      expect(surfaced).not.toContain(secret);
    }
    expect(thrown).toMatchObject({ provider: 'aws', status: 400 });
    expect(thrown!.message).toContain('InvalidUserData.Malformed');
  });

  it('tags the instance and its volumes in the RunInstances call itself, and makes no tagging call', async () => {
    const handle = await adapter().provision(AWS_SPEC);
    expect(ec2.requestOf(handle.id).tags).toEqual([
      { key: 'motir-shard', value: AWS_SHARD_TAG },
      { key: FLEET_METADATA_KEY, value: 'ci-runner' },
      { key: 'motir_intent_id', value: '44001' },
      { key: 'motir_org_id', value: 'org-1' },
      { key: 'motir_project_id', value: 'proj-1' },
      { key: 'Name', value: 'motir-runner-44001' },
    ]);
    expect(ec2.mutations().map((c) => c.method)).toEqual(['runInstances']);
  });

  it('omits the intent tag and names by project for a workload with no job', async () => {
    const handle = await adapter().provision({
      ...AWS_SPEC,
      workload: 'code_graph_index',
      workflowJobId: null,
    });
    const tags = ec2.requestOf(handle.id).tags;
    expect(tags.map((t) => t.key)).not.toContain('motir_intent_id');
    expect(tags).toContainEqual({ key: FLEET_METADATA_KEY, value: 'code-graph-index' });
    expect(tags).toContainEqual({ key: 'Name', value: 'motir-index-proj-1' });
  });

  it('maps a positive dockerVolumeGb to /dev/sdb gp3 DeleteOnTermination, and omits it otherwise', async () => {
    const withDisk = await adapter().provision({ ...AWS_SPEC, dockerVolumeGb: 40 });
    expect(ec2.requestOf(withDisk.id).blockDeviceMappings).toEqual([
      { deviceName: '/dev/sdb', volumeSizeGb: 40, volumeType: 'gp3', deleteOnTermination: true },
    ]);
    for (const dockerVolumeGb of [0, undefined]) {
      const handle = await adapter().provision({ ...AWS_SPEC, dockerVolumeGb });
      expect(ec2.requestOf(handle.id).blockDeviceMappings).toEqual([]);
    }
  });

  it('retries a 5xx with the SAME ClientToken and makes ONE instance', async () => {
    ec2.failNextRunAfterCreate();
    const handle = await adapter().provision(AWS_SPEC);

    const sentTokens = ec2.calls
      .filter((c) => c.method === 'runInstances')
      .map((c) => (c.input as { clientToken: string }).clientToken);
    expect(sentTokens).toEqual(['token-1', 'token-1']);
    expect(ec2.liveInstanceIds()).toEqual([handle.id]);
  });

  it('retries a transport failure, and gives up after three sends as the typed error', async () => {
    const flaky: Ec2Api = Object.create(ec2) as Ec2Api;
    let sends = 0;
    flaky.runInstances = async () => {
      sends += 1;
      throw new Ec2ApiError('TimeoutError', null, true);
    };
    await expect(adapter({ ec2: flaky }).provision(AWS_SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      provider: 'aws',
      status: null,
    });
    expect(sends).toBe(3);
  });

  it('gives each provision a new token — a provision after a teardown is a new instance', async () => {
    const orchestrator = adapter();
    const first = await orchestrator.provision(AWS_SPEC);
    await orchestrator.teardown(first, 'job_completed', AWS_ATTRIBUTION);
    const second = await orchestrator.provision(AWS_SPEC);

    expect(second.id).not.toBe(first.id);
    expect(ec2.requestOf(second.id).clientToken).not.toBe(ec2.requestOf(first.id).clientToken);
  });

  it('uses a random UUID token by default', async () => {
    const orchestrator = createAwsOrchestrator({
      ec2,
      region: 'us-east-1',
      shardTag: AWS_SHARD_TAG,
      amiId: AWS_AMI_ID,
    });
    const handle = await orchestrator.provision(AWS_SPEC);
    expect(ec2.requestOf(handle.id).clientToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('turns a refusal into OrchestratorApiError with the AWS code, leaving no instance', async () => {
    ec2.failNext('runInstances', 'InvalidAMIID.NotFound', 400);
    await expect(adapter().provision(AWS_SPEC)).rejects.toMatchObject({
      provider: 'aws',
      status: 400,
      message: expect.stringContaining('InvalidAMIID.NotFound'),
    });
    expect(ec2.liveInstanceIds()).toEqual([]);
  });

  it('turns a non-EC2 throw into the typed error without its message', async () => {
    const broken: Ec2Api = Object.create(ec2) as Ec2Api;
    broken.runInstances = async () => {
      throw new Error('raw message that must not surface');
    };
    const thrown = await adapter({ ec2: broken })
      .provision(AWS_SPEC)
      .catch((err: Error) => err);
    expect(thrown).toBeInstanceOf(OrchestratorApiError);
    expect((thrown as Error).message).not.toContain('raw message');
  });

  it.each([
    ['no subnet', () => ec2.subnets.clear()],
    ['no security group', () => ec2.securityGroups.clear()],
    [
      'two security groups',
      () =>
        ec2.securityGroups.set('sg-extra', {
          groupId: 'sg-extra',
          groupName: 'extra',
          vpcId: 'v',
          ingressRuleCount: 0,
          tags: [{ key: 'motir-shard', value: AWS_SHARD_TAG }],
        }),
    ],
  ])('with %s tagged, refuses as not configured, naming tag and region', async (_what, arrange) => {
    arrange();
    const thrown = await adapter()
      .provision(AWS_SPEC)
      .catch((err: Error) => err);
    expect(thrown).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect((thrown as Error).message).toContain(`motir-shard=${AWS_SHARD_TAG}`);
    expect((thrown as Error).message).toContain('us-east-1');
    expect(ec2.count('runInstances')).toBe(0);
  });

  it('surfaces a failed network read as the typed error', async () => {
    ec2.failNext('describeSubnets', 'UnauthorizedOperation', 403);
    await expect(adapter().provision(AWS_SPEC)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      status: 403,
    });
  });
});

describe('describe', () => {
  let orchestrator: ContainerOrchestrator;
  let handle: ContainerHandle;

  beforeEach(async () => {
    orchestrator = adapter();
    handle = await orchestrator.provision(AWS_SPEC);
  });

  it('pending: exists, not terminal, no start', async () => {
    ec2.setState(handle.id, 'pending');
    expect(await orchestrator.describe(handle)).toMatchObject({
      exists: true,
      terminal: false,
      state: 'pending',
      startedAt: null,
      exitCode: null,
    });
  });

  it('running: not terminal, started at the launch time', async () => {
    const launchTime = new Date('2026-10-24T10:00:00.000Z');
    ec2.backdate(handle.id, launchTime);
    expect(await orchestrator.describe(handle)).toMatchObject({
      exists: true,
      terminal: false,
      state: 'running',
      startedAt: launchTime,
      createdAt: launchTime,
      stoppedAt: null,
      exitCode: null,
    });
  });

  it.each(['shutting-down', 'stopping', 'stopped'])('%s: exists and terminal', async (state) => {
    const at = new Date('2026-10-24T11:00:00.000Z');
    ec2.setState(handle.id, state, userInitiated(at));
    expect(await orchestrator.describe(handle)).toMatchObject({
      exists: true,
      terminal: true,
      state,
      stoppedAt: at,
      exitCode: null,
    });
  });

  it('terminated, and a NotFound once it ages out: gone and destroyed', async () => {
    ec2.endJob(handle.id);
    const gone = { exists: false, terminal: true, state: 'destroyed', exitCode: null };
    expect(await orchestrator.describe(handle)).toMatchObject(gone);
    ec2.ageOut(handle.id);
    expect(await orchestrator.describe(handle)).toMatchObject(gone);
  });

  it('throws the typed error on any other describe failure', async () => {
    ec2.failNext('describeInstances', 'RequestLimitExceeded', 503);
    await expect(orchestrator.describe(handle)).rejects.toMatchObject({
      code: 'ORCHESTRATOR_API_FAILED',
      status: 503,
    });
  });
});

describe('teardown', () => {
  it('terminates and returns the aws row, dated by AWS', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(AWS_SPEC);
    const launchTime = new Date(Date.now() - 600_000);
    ec2.backdate(handle.id, launchTime);

    const usage = await orchestrator.teardown(handle, 'job_completed', AWS_ATTRIBUTION);

    expect(usage).toMatchObject({
      provider: 'aws',
      handleId: handle.id,
      region: 'us-east-1',
      orgId: 'org-1',
      workflowJobId: 44001,
      terminalState: 'destroyed',
      teardownReason: 'job_completed',
      startedAt: launchTime,
      createdAt: launchTime,
    });
    expect(usage.billableSeconds).toBeGreaterThanOrEqual(599);
    expect(ec2.liveInstanceIds()).toEqual([]);
  });

  it('dates the stop from the transition reason when AWS gives one', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(AWS_SPEC);
    const launchTime = new Date('2026-10-24T10:00:00.000Z');
    ec2.backdate(handle.id, launchTime);
    ec2.endJob(handle.id, new Date('2026-10-24T10:05:00.000Z'));

    const usage = await orchestrator.teardown(handle, 'job_completed', AWS_ATTRIBUTION);
    expect(usage.stoppedAt).toEqual(new Date('2026-10-24T10:05:00.000Z'));
    expect(usage.billableSeconds).toBe(300);
  });

  it('a second call, and a call on an id EC2 forgot, resolve with a row', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(AWS_SPEC);
    await orchestrator.teardown(handle, 'job_completed', AWS_ATTRIBUTION);

    expect((await orchestrator.teardown(handle, 'reaped', AWS_ATTRIBUTION)).handleId).toBe(
      handle.id,
    );
    ec2.ageOut(handle.id);
    const forgotten = await orchestrator.teardown(handle, 'reaped', AWS_ATTRIBUTION);
    expect(forgotten.handleId).toBe(handle.id);
    expect(forgotten.startedAt).toBeNull();
  });

  it('a terminate error other than not-found throws, and the instance lives', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(AWS_SPEC);
    ec2.failNext('terminateInstances', 'UnauthorizedOperation', 403);
    await expect(
      orchestrator.teardown(handle, 'job_completed', AWS_ATTRIBUTION),
    ).rejects.toMatchObject({ provider: 'aws', status: 403 });
    expect(ec2.liveInstanceIds()).toEqual([handle.id]);
  });

  it('still terminates when the pre-read fails, metering from the caller’s observation', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provision(AWS_SPEC);
    const observedStartedAt = new Date(Date.now() - 60_000);
    ec2.failNext('describeInstances', 'InternalError', 500);

    const usage = await orchestrator.teardown(handle, 'job_completed', {
      ...AWS_ATTRIBUTION,
      observedStartedAt,
    });
    expect(usage.startedAt).toEqual(observedStartedAt);
    expect(ec2.liveInstanceIds()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('reap', () => {
  const cutoff = () => new Date(Date.now() - HOUR_MS);
  const old = () => new Date(Date.now() - 2 * HOUR_MS);
  const resolveAll = async () => AWS_ATTRIBUTION;

  it('terminates only this shard’s fleet instances, live and past the cutoff', async () => {
    const orchestrator = adapter();
    const mine = await orchestrator.provision(AWS_SPEC);
    const fresh = await orchestrator.provision(AWS_SPEC);
    ec2.backdate(mine.id, old());
    const fleetTag = { key: FLEET_METADATA_KEY, value: 'ci-runner' };
    const otherShard = ec2.plantInstance({
      launchTime: old(),
      tags: [{ key: 'motir-shard', value: 'ci-runner-use1-2' }, fleetTag],
    });
    const notFleet = ec2.plantInstance({
      launchTime: old(),
      tags: [{ key: 'motir-shard', value: AWS_SHARD_TAG }],
    });
    const otherValue = ec2.plantInstance({
      launchTime: old(),
      tags: [
        { key: 'motir-shard', value: AWS_SHARD_TAG },
        { key: FLEET_METADATA_KEY, value: 'not-ours' },
      ],
    });
    const stopped = ec2.plantInstance({
      state: 'stopped',
      launchTime: old(),
      tags: [{ key: 'motir-shard', value: AWS_SHARD_TAG }, fleetTag],
    });

    const usages = await orchestrator.reap(cutoff(), resolveAll);

    expect(usages.map((u) => u.handleId).sort()).toEqual([mine.id, stopped].sort());
    expect(usages.every((u) => u.teardownReason === 'reaped')).toBe(true);
    expect(ec2.liveInstanceIds().sort()).toEqual(
      [fresh.id, otherShard, notFleet, otherValue].sort(),
    );
  });

  it('follows the paging token across more than one page', async () => {
    const orchestrator = adapter({ reapPageSize: 5 });
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const handle = await orchestrator.provision(AWS_SPEC);
      ec2.backdate(handle.id, old());
      ids.push(handle.id);
    }

    const usages = await orchestrator.reap(cutoff(), resolveAll);

    expect(usages).toHaveLength(12);
    const pages = ec2.calls.filter(
      (c) => c.method === 'describeInstances' && (c.input as { maxResults?: number }).maxResults,
    );
    expect(pages).toHaveLength(3);
    expect(ec2.liveInstanceIds()).toEqual([]);
    expect(AWS_REAP_PAGE_SIZE).toBe(200);
  });

  it('leaves a spared instance running with no row', async () => {
    const orchestrator = adapter();
    const kept = await orchestrator.provision(AWS_SPEC);
    ec2.backdate(kept.id, old());
    expect(await orchestrator.reap(cutoff(), resolveAll, async () => true)).toEqual([]);
    expect(ec2.liveInstanceIds()).toEqual([kept.id]);
  });

  it('terminates an unattributable instance without a row', async () => {
    const orchestrator = adapter();
    const orphan = await orchestrator.provision(AWS_SPEC);
    ec2.backdate(orphan.id, old());
    expect(await orchestrator.reap(cutoff(), async () => null)).toEqual([]);
    expect(ec2.liveInstanceIds()).toEqual([]);
  });

  it('one failing terminate does not stop the rest', async () => {
    const orchestrator = adapter();
    const a = await orchestrator.provision(AWS_SPEC);
    const b = await orchestrator.provision(AWS_SPEC);
    ec2.backdate(a.id, old());
    ec2.backdate(b.id, old());
    ec2.failNext('terminateInstances', 'InternalError', 500);

    const usages = await orchestrator.reap(cutoff(), resolveAll);

    expect(usages.map((u) => u.handleId)).toEqual([b.id]);
    expect(ec2.liveInstanceIds()).toEqual([a.id]);
    expect(error).toHaveBeenCalled();
  });

  it('skips and reports an instance with no launch time', async () => {
    const undated = ec2.plantInstance({
      launchTime: null,
      tags: [
        { key: 'motir-shard', value: AWS_SHARD_TAG },
        { key: FLEET_METADATA_KEY, value: 'ci-runner' },
      ],
    });
    expect(await adapter().reap(cutoff(), resolveAll)).toEqual([]);
    expect(ec2.liveInstanceIds()).toEqual([undated]);
    expect(warn).toHaveBeenCalled();
  });

  it('re-checks the listing, so an instance a provider failed to filter is not reaped', async () => {
    const leaky: Ec2Api = Object.create(ec2) as Ec2Api;
    leaky.describeInstances = async () => ({
      instances: [
        {
          instanceId: 'i-0000beef',
          state: 'terminated',
          launchTime: old(),
          stateTransitionReason: null,
          availabilityZone: null,
          tags: [
            { key: 'motir-shard', value: AWS_SHARD_TAG },
            { key: FLEET_METADATA_KEY, value: 'ci-runner' },
          ],
        },
        {
          instanceId: 'i-0000cafe',
          state: 'running',
          launchTime: old(),
          stateTransitionReason: null,
          availabilityZone: null,
          tags: [{ key: 'motir-shard', value: 'someone-else' }],
        },
      ],
      nextToken: null,
    });
    expect(await adapter({ ec2: leaky }).reap(cutoff(), resolveAll)).toEqual([]);
    expect(ec2.count('terminateInstances')).toBe(0);
  });

  it('throws the typed error when the listing fails', async () => {
    ec2.failNext('describeInstances', 'UnauthorizedOperation', 403);
    await expect(adapter().reap(cutoff(), resolveAll)).rejects.toMatchObject({ status: 403 });
  });
});

describe('transitionTimeOf', () => {
  it('reads the instant in AWS’s reason, and null otherwise', () => {
    expect(transitionTimeOf('User initiated (2026-10-22 12:00:00 GMT)')).toEqual(
      new Date('2026-10-22T12:00:00.000Z'),
    );
    expect(transitionTimeOf('Server.SpotInstanceTermination')).toBeNull();
    expect(transitionTimeOf('User initiated (2026-13-45 99:00:00 GMT)')).toBeNull();
    expect(transitionTimeOf(null)).toBeNull();
  });
});
