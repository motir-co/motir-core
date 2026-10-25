import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_HOME_DEVICE_NAME,
  AWS_IMAGE_TAG_KEY,
  AWS_PERSISTENT_LAUNCH_ATTEMPTS,
  AWS_TERMINATE_WAIT_ATTEMPTS,
  AWS_VOLUME_DELETE_ATTEMPTS,
  AwsInstanceSizeError,
  AwsPersistentSpecError,
  Ec2ApiError,
  FLEET_CONTAINER_SIZE,
  FLEET_METADATA_KEY,
  FLEET_METADATA_VALUES,
  INSTANCE_METADATA_KEY,
  OrchestratorApiError,
  OrchestratorCapacityError,
  OrchestratorNotConfiguredError,
  PersistentUserDataError,
  createAwsPersistentOrchestrator,
  toAwsPersistentState,
  type Ec2Instance,
  type PersistentContainerSpec,
} from '../src/index';
import { testHostAgentConfig } from './contract/awsHostAgentFake';
import { AwsEc2Fake, userInitiated } from './contract/awsEc2Fake';
import {
  AWS_HOSTER_AMI_ID,
  AWS_HOSTER_SHARD_TAG as SHARD,
  AWS_HOSTER_ZONES,
  AWS_PERSISTENT_SPEC as SPEC,
} from './contract/awsPersistentHarness';

// The AWS adapter's persistent half on EC2 (Story MOTIR-9361 · MOTIR-9469) —
// what the shared persistent contract cannot see: the RunInstances request, the
// refusals before any call, the ClientToken retry, the state map, the destroy
// guards and the typed capacity refusal. The port's guarantees themselves are in
// `persistentContract.aws.test.ts`.

const START = Date.parse('2026-10-24T10:00:00.000Z');

let ec2: AwsEc2Fake;
let clock: number;
let tokens: number;

function adapter(overrides: Partial<Parameters<typeof createAwsPersistentOrchestrator>[0]> = {}) {
  return createAwsPersistentOrchestrator({
    ec2,
    hostAgent: testHostAgentConfig(),
    region: 'us-east-1',
    shardTag: SHARD,
    amiId: AWS_HOSTER_AMI_ID,
    now: () => new Date(clock),
    sleep: async () => {},
    clientToken: () => `token-${(tokens += 1)}`,
    ...overrides,
  });
}

function spec(overrides: Partial<PersistentContainerSpec> = {}): PersistentContainerSpec {
  return { ...SPEC, ...overrides };
}

function launches() {
  return ec2.calls.filter((c) => c.method === 'runInstances');
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  clock = START;
  tokens = 0;
  ec2.now = () => new Date(clock);
  ec2.seedShardNetwork(SHARD, AWS_HOSTER_ZONES);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provisionPersistent — one RunInstances makes the machine and its disk', () => {
  it('sends the AMI, the type, the zone’s subnet, the group, the home mapping and the lockdown', async () => {
    const handle = await adapter().provisionPersistent(spec({ availabilityZone: 'us-east-1b' }));
    expect(launches()).toHaveLength(1);
    const request = ec2.requestOf(handle.machineId);
    expect(request).toMatchObject({
      imageId: AWS_HOSTER_AMI_ID,
      instanceType: 'm6i.large',
      subnetId: `subnet-${SHARD}-us-east-1b`,
      securityGroupIds: [`sg-${SHARD}`],
      instanceInitiatedShutdownBehavior: 'stop',
      metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1 },
      blockDeviceMappings: [
        {
          deviceName: AWS_HOME_DEVICE_NAME,
          volumeSizeGb: 10,
          volumeType: 'gp3',
          deleteOnTermination: false,
        },
      ],
    });
    expect(request).not.toHaveProperty('iamInstanceProfile');
    expect(request).not.toHaveProperty('keyName');
    expect(request.tags).toEqual(
      expect.arrayContaining([
        { key: 'motir-shard', value: SHARD },
        { key: FLEET_METADATA_KEY, value: FLEET_METADATA_VALUES.agent_instance },
        { key: INSTANCE_METADATA_KEY, value: SPEC.instanceId },
        { key: 'motir_org_id', value: SPEC.orgId },
        { key: 'motir_project_id', value: SPEC.projectId },
        { key: AWS_IMAGE_TAG_KEY, value: SPEC.image },
        { key: 'Name', value: expect.stringContaining('inst-contract-a') },
      ]),
    );
    // The instance and its home disk carry the tags, written by the one call.
    expect(ec2.volumes.get(handle.volumeId)?.tags).toEqual(request.tags);
    expect(handle).toEqual({
      provider: 'aws',
      app: SHARD,
      machineId: expect.stringMatching(/^i-/),
      volumeId: expect.stringMatching(/^vol-/),
      region: 'us-east-1',
      createdAt: new Date(START),
    });
  });

  it('reads the home disk from DescribeInstances when the launch answer names none', async () => {
    const run = ec2.runInstances.bind(ec2);
    vi.spyOn(ec2, 'runInstances').mockImplementation(async (input) => {
      const { volumes: _v, ...instance } = await run(input);
      return instance as Ec2Instance;
    });
    const handle = await adapter().provisionPersistent(spec());
    expect(ec2.volumes.has(handle.volumeId)).toBe(true);
  });

  it('gives the machine back when no home disk can be read at all', async () => {
    const run = ec2.runInstances.bind(ec2);
    vi.spyOn(ec2, 'runInstances').mockImplementation(async (input) => {
      const { volumes: _v, ...instance } = await run(input);
      return instance as Ec2Instance;
    });
    vi.spyOn(ec2, 'describeInstances').mockResolvedValue({ instances: [], nextToken: null });
    await expect(adapter().provisionPersistent(spec())).rejects.toThrow(/MissingField.HomeVolume/);
    expect(ec2.liveInstanceIds()).toEqual([]);
  });

  it('refuses a spec with no zone, an unmapped size, another region or bad user-data before any call', async () => {
    const orchestrator = adapter();
    const { availabilityZone: _z, ...zoneless } = spec();
    await expect(orchestrator.provisionPersistent(zoneless)).rejects.toBeInstanceOf(
      AwsPersistentSpecError,
    );
    await expect(
      orchestrator.provisionPersistent(
        spec({ size: { ...FLEET_CONTAINER_SIZE, cpus: 4, memoryMb: 16384 } }),
      ),
    ).rejects.toBeInstanceOf(AwsInstanceSizeError);
    await expect(
      orchestrator.provisionPersistent(spec({ region: 'eu-west-1' })),
    ).rejects.toBeInstanceOf(OrchestratorNotConfiguredError);
    await expect(
      orchestrator.provisionPersistent(spec({ env: { MOTIR_TOKEN: 'a\nb' } })),
    ).rejects.toBeInstanceOf(PersistentUserDataError);
    await expect(
      orchestrator.provisionPersistent(spec({ env: { BIG: 'x'.repeat(17 * 1024) } })),
    ).rejects.toMatchObject({ reason: 'too_large' });
    expect(ec2.calls).toEqual([]);
  });

  it('takes the instance type from the config’s map', async () => {
    const orchestrator = adapter({ instanceTypeFor: () => 'c7i.xlarge' });
    const handle = await orchestrator.provisionPersistent(
      spec({ size: { ...FLEET_CONTAINER_SIZE, cpus: 4, memoryMb: 8192 } }),
    );
    expect(ec2.requestOf(handle.machineId).instanceType).toBe('c7i.xlarge');
  });

  it('refuses a zone with no tagged subnet, and an account with no single tagged group', async () => {
    await expect(
      adapter().provisionPersistent(spec({ availabilityZone: 'us-east-1f' })),
    ).rejects.toThrow(/no subnet is tagged motir-shard=agent-hoster-use1-1 in us-east-1f/);
    ec2.securityGroups.clear();
    await expect(adapter().provisionPersistent(spec())).rejects.toThrow(/no security group/);
    ec2.securityGroups.set('sg-a', {
      groupId: 'sg-a',
      groupName: 'a',
      vpcId: 'v',
      ingressRuleCount: 0,
      tags: [{ key: 'motir-shard', value: SHARD }],
    });
    ec2.securityGroups.set('sg-b', { ...ec2.securityGroups.get('sg-a')!, groupId: 'sg-b' });
    await expect(adapter().provisionPersistent(spec())).rejects.toThrow(/more than one/);
    expect(launches()).toEqual([]);
  });

  it('types a network read failure', async () => {
    ec2.failNext('describeSubnets', 'UnauthorizedOperation', 403);
    await expect(adapter().provisionPersistent(spec())).rejects.toMatchObject({
      provider: 'aws',
      status: 403,
    });
  });

  it('throws the AWS code — never the user-data or an env value — and leaves nothing on a refusal', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ec2.failNext('runInstances', 'InvalidParameterValue', 400);
    const marker = 'MARKER-SECRET-7f3a';
    const err = await adapter()
      .provisionPersistent(spec({ env: { MOTIR_TERMINAL_KEY: marker } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).toMatchObject({ provider: 'aws', status: 400 });
    expect((err as Error).message).toContain('InvalidParameterValue');
    expect((err as Error).message).not.toContain(marker);
    expect(JSON.stringify([...errors.mock.calls, ...warns.mock.calls])).not.toContain(marker);
    expect(ec2.liveInstanceIds()).toEqual([]);
    expect(ec2.liveVolumeIds()).toEqual([]);
  });

  it('retries a 5xx with the SAME token — one machine, one disk — and two calls get two tokens', async () => {
    ec2.failNextRunAfterCreate('InternalError');
    const first = await adapter().provisionPersistent(spec());
    const sent = launches().map((c) => (c.input as { clientToken: string }).clientToken);
    expect(sent).toEqual(['token-1', 'token-1']);
    expect(ec2.liveInstanceIds()).toEqual([first.machineId]);
    expect(ec2.liveVolumeIds()).toEqual([first.volumeId]);

    const second = await adapter().provisionPersistent(spec({ instanceId: 'inst-b' }));
    expect(second.machineId).not.toBe(first.machineId);
    expect((launches().at(-1)!.input as { clientToken: string }).clientToken).toBe('token-2');
  });

  it('gives up after its attempts on a 5xx that persists', async () => {
    const failing = vi
      .spyOn(ec2, 'runInstances')
      .mockRejectedValue(new Ec2ApiError('InternalError', 500, true));
    await expect(adapter().provisionPersistent(spec())).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
    expect(failing).toHaveBeenCalledTimes(AWS_PERSISTENT_LAUNCH_ATTEMPTS);
  });

  it.each([
    ['VcpuLimitExceeded', 'quota_exceeded'],
    ['InsufficientInstanceCapacity', 'out_of_stock'],
    ['RequestLimitExceeded', 'throttled'],
    ['VolumeLimitExceeded', 'quota_exceeded'],
    ['InsufficientVolumeCapacity', 'out_of_stock'],
  ])('types %s as a capacity refusal (%s), sent once, in its zone', async (code, reason) => {
    ec2.failNextRunInstances({ code });
    const err = await adapter()
      .provisionPersistent(spec())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect(err).toMatchObject({ reason, zone: 'us-east-1a', providerCode: code });
    expect(launches()).toHaveLength(1);
  });
});

describe('stop and start — the same instance, its own zone, its disk', () => {
  it('keeps the handle, the disk and the zone across a stop and a start, with a later start', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    const firstRun = (await orchestrator.describePersistent(handle)).startedAt!;
    clock += 60_000;
    await orchestrator.stop(handle);
    clock += 60_000;
    await orchestrator.start(handle);
    const status = await orchestrator.describePersistent(handle);
    expect(status).toMatchObject({ state: 'running', stoppedAt: null });
    expect(status.startedAt!.getTime()).toBeGreaterThan(firstRun.getTime());
    expect(ec2.instances.get(handle.machineId)?.availabilityZone).toBe('us-east-1a');
    expect(ec2.volumes.get(handle.volumeId)?.attachedInstanceId).toBe(handle.machineId);
    expect(ec2.liveVolumeIds()).toEqual([handle.volumeId]);
  });

  it('stop resolves for a machine EC2 no longer knows, or one already stopping', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    await orchestrator.stop({ ...handle, machineId: 'i-00000bad' });
    ec2.setState(handle.machineId, 'stopping');
    await expect(orchestrator.stop(handle)).resolves.toBeUndefined();
    vi.spyOn(ec2, 'stopInstances').mockRejectedValueOnce(
      new Ec2ApiError('IncorrectInstanceState', 400, false),
    );
    await expect(orchestrator.stop(handle)).resolves.toBeUndefined();
  });

  it('stop throws a refusal on a running machine, and types any other refusal — capacity included', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    // EC2 refuses the stop while the machine still reads running — not an end state.
    vi.spyOn(ec2, 'stopInstances').mockRejectedValueOnce(
      new Ec2ApiError('IncorrectInstanceState', 400, false),
    );
    await expect(orchestrator.stop(handle)).rejects.toBeInstanceOf(OrchestratorApiError);
    ec2.failNext('stopInstances', 'RequestLimitExceeded', 503);
    const err = await orchestrator.stop(handle).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).not.toBeInstanceOf(OrchestratorCapacityError);
  });

  it('start resolves on a running or pending machine, and throws for one EC2 does not know', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    await expect(orchestrator.start(handle)).resolves.toBeUndefined();
    ec2.setState(handle.machineId, 'pending');
    vi.spyOn(ec2, 'startInstances').mockRejectedValueOnce(
      new Ec2ApiError('IncorrectInstanceState', 400, false),
    );
    await expect(orchestrator.start(handle)).resolves.toBeUndefined();
    await expect(orchestrator.start({ ...handle, machineId: 'i-00000bad' })).rejects.toMatchObject({
      provider: 'aws',
    });
  });

  it('start throws while the machine is still stopping, and types a capacity refusal', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.setState(handle.machineId, 'stopping');
    await expect(orchestrator.start(handle)).rejects.toBeInstanceOf(OrchestratorApiError);
    ec2.setState(handle.machineId, 'stopped');
    ec2.failNext('startInstances', 'InsufficientInstanceCapacity', 500);
    await expect(orchestrator.start(handle)).rejects.toMatchObject({
      reason: 'out_of_stock',
      providerCode: 'InsufficientInstanceCapacity',
    });
  });
});

describe('describePersistent — EC2’s state in the instance vocabulary', () => {
  it.each([
    ['pending', 'starting'],
    ['running', 'running'],
    ['stopping', 'stopping'],
    ['shutting-down', 'stopping'],
    ['stopped', 'stopped'],
    ['terminated', 'gone'],
    ['something-new', 'starting'],
  ] as const)('maps %s to %s', (ec2State, state) => {
    expect(toAwsPersistentState(ec2State)).toBe(state);
  });

  it('reports each live state with its provider state, and terminated and unknown as gone', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    for (const [ec2State, state] of [
      ['pending', 'starting'],
      ['running', 'running'],
      ['stopping', 'stopping'],
      ['shutting-down', 'stopping'],
    ] as const) {
      ec2.setState(handle.machineId, ec2State);
      expect(await orchestrator.describePersistent(handle)).toMatchObject({
        state,
        providerState: ec2State,
        stoppedAt: null,
      });
    }
    expect((await orchestrator.describePersistent(handle)).image).toBe(SPEC.image);
    ec2.setState(handle.machineId, 'terminated');
    expect(await orchestrator.describePersistent(handle)).toEqual({
      machineId: handle.machineId,
      state: 'gone',
      providerState: '',
      startedAt: null,
      stoppedAt: null,
      events: [],
    });
    ec2.ageOut(handle.machineId);
    expect((await orchestrator.describePersistent(handle)).state).toBe('gone');
  });

  it('reads a stopped machine’s stop from StateTransitionReason, events oldest first', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.setState(handle.machineId, 'stopped', userInitiated(new Date('2026-10-24T10:05:00Z')));
    const status = await orchestrator.describePersistent(handle);
    expect(status).toMatchObject({
      state: 'stopped',
      startedAt: new Date(START),
      stoppedAt: new Date('2026-10-24T10:05:00Z'),
    });
    expect(status.events).toEqual([
      { type: 'start', status: 'started', at: new Date(START) },
      { type: 'stop', status: 'stopped', at: new Date('2026-10-24T10:05:00Z') },
    ]);
    expect(status).not.toHaveProperty('exitCode');
    ec2.setState(handle.machineId, 'pending');
    expect((await orchestrator.describePersistent(handle)).events).toEqual([]);
  });

  it('throws a read EC2 refuses for another reason', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.failNext('describeInstances', 'RequestLimitExceeded', 503);
    const err = await orchestrator.describePersistent(handle).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).not.toBeInstanceOf(OrchestratorCapacityError);
  });
});

describe('destroy — the machine, THEN the disk', () => {
  async function provisioned() {
    const orchestrator = adapter();
    return { orchestrator, handle: await orchestrator.provisionPersistent(spec()) };
  }

  it('waits out a terminating machine before it deletes the disk', async () => {
    const { orchestrator, handle } = await provisioned();
    ec2.holdNextTerminate = true;
    const describe = ec2.describeInstances.bind(ec2);
    let reads = 0;
    vi.spyOn(ec2, 'describeInstances').mockImplementation(async (input) => {
      reads += 1;
      if (reads === 2) ec2.finishTermination(handle.machineId);
      return describe(input);
    });
    await orchestrator.destroyPersistent(handle);
    const order = ec2.mutations().map((c) => c.method);
    expect(order).toEqual([
      'authorizeSecurityGroupIngress',
      'runInstances',
      'terminateInstances',
      'deleteVolume',
    ]);
    expect(ec2.liveVolumeIds()).toEqual([]);
  });

  it('never touches the disk of a machine that will not terminate — it throws', async () => {
    const { orchestrator, handle } = await provisioned();
    ec2.holdNextTerminate = true;
    await expect(orchestrator.destroyPersistent(handle)).rejects.toThrow(/InstanceNotTerminated/);
    expect(ec2.count('describeInstances')).toBe(AWS_TERMINATE_WAIT_ATTEMPTS);
    expect(ec2.count('deleteVolume')).toBe(0);
    expect(ec2.liveVolumeIds()).toEqual([handle.volumeId]);
  });

  it('retries a disk still detaching, bounded, then throws and leaves it', async () => {
    const { orchestrator, handle } = await provisioned();
    const remove = ec2.deleteVolume.bind(ec2);
    const deletes = vi
      .spyOn(ec2, 'deleteVolume')
      .mockRejectedValueOnce(new Ec2ApiError('VolumeInUse', 400, false))
      .mockImplementation(remove);
    await orchestrator.destroyPersistent(handle);
    expect(deletes).toHaveBeenCalledTimes(2);
    expect(ec2.liveVolumeIds()).toEqual([]);

    const again = await orchestrator.provisionPersistent(spec({ instanceId: 'inst-b' }));
    deletes.mockReset();
    deletes.mockRejectedValue(new Ec2ApiError('VolumeInUse', 400, false));
    await expect(orchestrator.destroyPersistent(again)).rejects.toThrow(/VolumeInUse/);
    expect(deletes).toHaveBeenCalledTimes(AWS_VOLUME_DELETE_ATTEMPTS);
    expect(ec2.volumes.has(again.volumeId)).toBe(true);
  });

  it('throws a DeleteVolume refusal other than not-found, the disk still present', async () => {
    const { orchestrator, handle } = await provisioned();
    ec2.failNext('deleteVolume', 'InternalError', 500);
    await expect(orchestrator.destroyPersistent(handle)).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
    expect(ec2.volumes.has(handle.volumeId)).toBe(true);
    await orchestrator.destroyPersistent(handle);
    expect(ec2.volumes.has(handle.volumeId)).toBe(false);
  });

  it('throws a terminate EC2 refuses for another reason, the machine and disk kept', async () => {
    const { orchestrator, handle } = await provisioned();
    ec2.failNext('terminateInstances', 'UnauthorizedOperation', 403);
    await expect(orchestrator.destroyPersistent(handle)).rejects.toMatchObject({ status: 403 });
    expect(ec2.liveInstanceIds()).toEqual([handle.machineId]);
    expect(ec2.liveVolumeIds()).toEqual([handle.volumeId]);
  });
});

describe('destroyMachine / destroyVolume — the orphan clean-up', () => {
  it('each takes only its own id, twice without a throw; an attached disk is refused, not detached', async () => {
    const orchestrator = adapter();
    const kept = await orchestrator.provisionPersistent(spec());
    const other = await orchestrator.provisionPersistent(spec({ instanceId: 'inst-b' }));

    await expect(orchestrator.destroyVolume(SHARD, kept.volumeId)).rejects.toThrow(/VolumeInUse/);
    expect(ec2.volumes.get(kept.volumeId)?.attachedInstanceId).toBe(kept.machineId);

    await orchestrator.destroyMachine(SHARD, other.machineId);
    await orchestrator.destroyMachine(SHARD, other.machineId);
    await orchestrator.destroyVolume(SHARD, other.volumeId);
    await orchestrator.destroyVolume(SHARD, other.volumeId);
    await orchestrator.destroyMachine(SHARD, 'i-00000bad');
    expect(ec2.liveInstanceIds()).toEqual([kept.machineId]);
    expect(ec2.liveVolumeIds()).toEqual([kept.volumeId]);
  });
});

describe('the account as the app', () => {
  it('names every handle’s app and region from its own config', () => {
    const orchestrator = adapter();
    expect(orchestrator.appNameFor('any-org')).toBe(SHARD);
    expect(orchestrator.defaultRegion()).toBe('us-east-1');
  });

  it('defaults its clock, sleep and token when the config names none', async () => {
    const orchestrator = createAwsPersistentOrchestrator({
      ec2,
      hostAgent: testHostAgentConfig(),
      region: 'us-east-1',
      shardTag: SHARD,
      amiId: AWS_HOSTER_AMI_ID,
    });
    const handle = await orchestrator.provisionPersistent(spec());
    expect((launches()[0]!.input as { clientToken: string }).clientToken).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    const remove = ec2.deleteVolume.bind(ec2);
    vi.spyOn(ec2, 'deleteVolume')
      .mockRejectedValueOnce(new Ec2ApiError('VolumeInUse', 400, false))
      .mockImplementation(remove);
    vi.useFakeTimers();
    const done = orchestrator.destroyPersistent(handle);
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();
    expect(ec2.liveVolumeIds()).toEqual([]);
  });
});
