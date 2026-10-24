import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_IMAGE_TAG_KEY,
  AWS_LIST_PAGE_SIZE,
  AWS_STOP_WAIT_ATTEMPTS,
  AWS_TERMINAL_KEY_ID_TAG_KEY,
  AWS_TERMINAL_VERSION_TAG_KEY,
  OrchestratorApiError,
  OrchestratorCapacityError,
  PersistentUserDataError,
  createAwsPersistentOrchestrator,
  parseInstanceUserData,
  type PersistentContainerHandle,
  type PersistentContainerSpec,
  type PersistentTerminalConfig,
} from '../src/index';
import { testHostAgentConfig } from './contract/awsHostAgentFake';
import { AwsEc2Fake } from './contract/awsEc2Fake';
import {
  AWS_HOSTER_AMI_ID,
  AWS_HOSTER_SHARD_TAG as SHARD,
  AWS_HOSTER_ZONES,
  AWS_PERSISTENT_SPEC as SPEC,
} from './contract/awsPersistentHarness';

// The AWS adapter's UPKEEP on EC2 (Story MOTIR-9361 · MOTIR-9479): the config
// document a provision launches with and the terminal stamp, ensure-config and
// the image move as read · replace one field · write on a STOPPED instance, and
// the account's tag listing with untracked machines reported.

const START = Date.parse('2026-10-24T10:00:00.000Z');
const MARKER = 'SECRET-MARKER-UPKEEP';

const TERMINAL: PersistentTerminalConfig = {
  version: 2,
  keyId: 'kid-a',
  command: ['motir', 'agent-terminal', 'serve'],
  env: { MOTIR_TERMINAL_KEY: MARKER },
  service: {
    internalPort: 7681,
    ports: [{ port: 443, handlers: ['tls', 'http'] }],
    autostart: false,
    autostop: 'off',
  },
};

let ec2: AwsEc2Fake;
let clock: number;

function adapter() {
  return createAwsPersistentOrchestrator({
    ec2,
    hostAgent: testHostAgentConfig(),
    region: 'us-east-1',
    shardTag: SHARD,
    amiId: AWS_HOSTER_AMI_ID,
    now: () => new Date(clock),
    sleep: async () => {},
  });
}

function spec(overrides: Partial<PersistentContainerSpec> = {}): PersistentContainerSpec {
  return { ...SPEC, env: { ...SPEC.env, API_TOKEN: MARKER }, ...overrides };
}

function docOf(handle: PersistentContainerHandle) {
  return parseInstanceUserData(ec2.userData.get(handle.machineId)!);
}

function tagsOf(handle: PersistentContainerHandle): Record<string, string> {
  return Object.fromEntries(ec2.instances.get(handle.machineId)!.tags.map((t) => [t.key, t.value]));
}

async function stopped(overrides: Partial<PersistentContainerSpec> = {}) {
  const orchestrator = adapter();
  const handle = await orchestrator.provisionPersistent(spec(overrides));
  await orchestrator.stop(handle);
  return { orchestrator, handle };
}

function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => null,
    (e: unknown) => e,
  );
}

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  clock = START;
  ec2.now = () => new Date(clock);
  ec2.seedShardNetwork(SHARD, AWS_HOSTER_ZONES);
});

describe('provisionPersistent — launches with the config document', () => {
  it('carries the spec’s config in user-data and stamps the terminal as tags', async () => {
    const handle = await adapter().provisionPersistent(spec({ terminal: TERMINAL }));
    expect(docOf(handle)).toEqual({
      image: SPEC.image,
      mountPath: SPEC.mountPath,
      env: { ...SPEC.env, API_TOKEN: MARKER },
      idleCommand: ['sleep', 'infinity'],
      terminal: TERMINAL,
      hostAgent: expect.anything(),
    });
    expect(tagsOf(handle)).toMatchObject({
      [AWS_TERMINAL_VERSION_TAG_KEY]: '2',
      [AWS_TERMINAL_KEY_ID_TAG_KEY]: 'kid-a',
    });
  });

  it('stamps nothing for an instance without a terminal', async () => {
    const handle = await adapter().provisionPersistent(spec());
    expect(tagsOf(handle)).not.toHaveProperty(AWS_TERMINAL_VERSION_TAG_KEY);
  });
});

describe('ensureMachineConfig — the terminal block of a stopped instance', () => {
  it('rewrites only the terminal and the stamp of an older instance, and leaves it stopped', async () => {
    const { orchestrator, handle } = await stopped({ terminal: { ...TERMINAL, version: 1 } });
    const before = docOf(handle);
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('updated');
    expect(docOf(handle)).toEqual({ ...before, terminal: TERMINAL });
    expect(tagsOf(handle)).toMatchObject({
      [AWS_TERMINAL_VERSION_TAG_KEY]: '2',
      [AWS_TERMINAL_KEY_ID_TAG_KEY]: 'kid-a',
      [AWS_IMAGE_TAG_KEY]: SPEC.image,
    });
    expect(ec2.instances.get(handle.machineId)!.state).toBe('stopped');
    expect(ec2.count('startInstances')).toBe(0);
    expect(ec2.volumes.get(handle.volumeId)!.attachedInstanceId).toBe(handle.machineId);
    // A second call finds it current.
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('current');
  });

  it('rewrites an instance made before the terminal, and one with the same version and another key', async () => {
    const { orchestrator, handle } = await stopped();
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('updated');
    expect(docOf(handle).terminal).toEqual(TERMINAL);
    const rotated = { ...TERMINAL, keyId: 'kid-b' };
    expect(await orchestrator.ensureMachineConfig(handle, rotated)).toBe('updated');
    expect(docOf(handle).terminal).toEqual(rotated);
  });

  it('answers current with no write when the stamp is newer, or equal with the same key', async () => {
    const { orchestrator, handle } = await stopped({ terminal: { ...TERMINAL, version: 5 } });
    expect(await orchestrator.ensureMachineConfig(handle, TERMINAL)).toBe('current');
    const same = await stopped({ instanceId: 'inst-same', terminal: TERMINAL });
    expect(await same.orchestrator.ensureMachineConfig(same.handle, TERMINAL)).toBe('current');
    expect(ec2.count('modifyInstanceUserData')).toBe(0);
    expect(ec2.count('createTags')).toBe(0);
  });

  it('refuses a running instance as instance_not_stopped and changes nothing', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    const before = ec2.userData.get(handle.machineId);
    const err = await thrown(() => orchestrator.ensureMachineConfig(handle, TERMINAL));
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).toMatchObject({ provider: 'aws', status: 409 });
    expect((err as Error).message).toContain('instance_not_stopped');
    expect(ec2.userData.get(handle.machineId)).toBe(before);
    expect(ec2.count('modifyInstanceUserData')).toBe(0);
  });

  it('refuses a gone instance with the typed not-found error', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.terminateOutside(handle.machineId);
    await expect(orchestrator.ensureMachineConfig(handle, TERMINAL)).rejects.toMatchObject({
      provider: 'aws',
      status: 404,
    });
    ec2.ageOut(handle.machineId);
    await expect(orchestrator.ensureMachineConfig(handle, TERMINAL)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('InvalidInstanceID.NotFound'),
    });
  });

  it('refuses unreadable user-data without echoing it', async () => {
    const { orchestrator, handle } = await stopped();
    ec2.userData.set(handle.machineId, `#!/bin/bash\necho ${MARKER}\n`);
    const err = await thrown(() => orchestrator.ensureMachineConfig(handle, TERMINAL));
    expect(err).toBeInstanceOf(PersistentUserDataError);
    expect((err as Error).message).not.toContain(MARKER);
    ec2.userData.delete(handle.machineId);
    await expect(orchestrator.ensureMachineConfig(handle, TERMINAL)).rejects.toBeInstanceOf(
      PersistentUserDataError,
    );
  });

  it('turns a refused read or write into the AWS code, with no value in it', async () => {
    const { orchestrator, handle } = await stopped();
    ec2.failNext('describeInstanceUserData', 'UnauthorizedOperation', 403);
    await expect(orchestrator.ensureMachineConfig(handle, TERMINAL)).rejects.toMatchObject({
      provider: 'aws',
      status: 403,
    });
    ec2.failNext('modifyInstanceUserData', 'UnauthorizedOperation', 403);
    const err = await thrown(() => orchestrator.ensureMachineConfig(handle, TERMINAL));
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect((err as Error).message).not.toContain(MARKER);
    expect(ec2.count('createTags')).toBe(0);
  });
});

describe('moveImage — the same instance and disk, only the image replaced', () => {
  const NEXT = 'ghcr.io/motir-co/motir-sandbox@sha256:' + 'd'.repeat(64);

  it('writes a stopped instance’s image without starting it; the next start boots it', async () => {
    const { orchestrator, handle } = await stopped({ terminal: TERMINAL });
    const before = docOf(handle);
    await orchestrator.moveImage(handle, NEXT, { launch: false });
    expect(docOf(handle)).toEqual({ ...before, image: NEXT });
    expect(tagsOf(handle)[AWS_IMAGE_TAG_KEY]).toBe(NEXT);
    expect(ec2.instances.get(handle.machineId)!.state).toBe('stopped');
    expect(ec2.count('startInstances')).toBe(0);
    await orchestrator.start(handle);
    expect(docOf(handle).image).toBe(NEXT);
    expect((await orchestrator.describePersistent(handle)).image).toBe(NEXT);
    expect(ec2.liveInstanceIds()).toEqual([handle.machineId]);
    expect(ec2.liveVolumeIds()).toEqual([handle.volumeId]);
  });

  it('stops, writes and starts a running instance, in that order', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.calls.length = 0;
    await orchestrator.moveImage(handle, NEXT, { launch: true });
    const order = ec2.calls
      .map((c) => c.method)
      .filter((m) => ['stopInstances', 'modifyInstanceUserData', 'startInstances'].includes(m));
    expect(order).toEqual(['stopInstances', 'modifyInstanceUserData', 'startInstances']);
    expect(ec2.instances.get(handle.machineId)!.state).toBe('running');
    expect(docOf(handle).image).toBe(NEXT);
    expect(ec2.liveInstanceIds()).toEqual([handle.machineId]);
    expect(ec2.liveVolumeIds()).toEqual([handle.volumeId]);
  });

  it('waits for a stopping instance, bounded', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.holdNextStop = true;
    const sleep = vi.fn(async () => {
      ec2.setState(handle.machineId, 'stopped');
    });
    const waiting = createAwsPersistentOrchestrator({
      ec2,
      hostAgent: testHostAgentConfig(),
      region: 'us-east-1',
      shardTag: SHARD,
      amiId: AWS_HOSTER_AMI_ID,
      sleep,
    });
    await waiting.moveImage(handle, NEXT, { launch: true });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(docOf(handle).image).toBe(NEXT);

    ec2.holdNextStop = true;
    await expect(
      orchestrator.moveImage(handle, SPEC.image, { launch: true }),
    ).rejects.toMatchObject({ message: expect.stringContaining('InstanceNotStopped') });
    expect(ec2.count('describeInstances')).toBeGreaterThanOrEqual(AWS_STOP_WAIT_ATTEMPTS);
    expect(docOf(handle).image).toBe(NEXT);
  });

  it('a refused write sends no start and leaves the instance stopped on the old document', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    const before = ec2.userData.get(handle.machineId);
    ec2.failNext('modifyInstanceUserData', 'UnauthorizedOperation', 403);
    await expect(orchestrator.moveImage(handle, NEXT, { launch: true })).rejects.toMatchObject({
      provider: 'aws',
      status: 403,
    });
    expect(ec2.count('startInstances')).toBe(0);
    expect(ec2.instances.get(handle.machineId)!.state).toBe('stopped');
    expect(ec2.userData.get(handle.machineId)).toBe(before);
  });

  it('a refused stop sends nothing more', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.failNext('stopInstances', 'UnauthorizedOperation', 403);
    await expect(orchestrator.moveImage(handle, NEXT, { launch: true })).rejects.toMatchObject({
      status: 403,
    });
    expect(ec2.count('modifyInstanceUserData')).toBe(0);
    expect(ec2.count('startInstances')).toBe(0);
  });

  it('a capacity refusal on the restart is typed', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.failNext('startInstances', 'InsufficientInstanceCapacity', 500);
    await expect(orchestrator.moveImage(handle, NEXT, { launch: true })).rejects.toBeInstanceOf(
      OrchestratorCapacityError,
    );
    expect(docOf(handle).image).toBe(NEXT);
  });

  it('a running instance asked not to launch is refused by EC2’s rule', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    await expect(orchestrator.moveImage(handle, NEXT, { launch: false })).rejects.toMatchObject({
      message: expect.stringContaining('IncorrectInstanceState'),
    });
  });

  it('a gone instance is the typed not-found error', async () => {
    const orchestrator = adapter();
    const handle = await orchestrator.provisionPersistent(spec());
    ec2.terminateOutside(handle.machineId);
    await expect(orchestrator.moveImage(handle, NEXT, { launch: false })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('listPersistent — the account’s machines and disks, by tag', () => {
  it('lists two instances and their volumes, leaving out terminated ones and other accounts', async () => {
    const orchestrator = adapter();
    const a = await orchestrator.provisionPersistent(spec());
    const b = await orchestrator.provisionPersistent(spec({ instanceId: 'inst-b' }));
    const done = await orchestrator.provisionPersistent(spec({ instanceId: 'inst-done' }));
    await orchestrator.destroyPersistent(done);
    ec2.plantInstance({ tags: [{ key: 'motir-shard', value: 'another-account' }] });
    await orchestrator.stop(b);

    const inventory = await orchestrator.listPersistent(SHARD);
    expect(inventory.app).toBe(SHARD);
    expect(inventory.machines).toEqual(
      expect.arrayContaining([
        {
          machineId: a.machineId,
          state: 'running',
          instanceId: SPEC.instanceId,
          createdAt: new Date(START),
        },
        {
          machineId: b.machineId,
          state: 'stopped',
          instanceId: 'inst-b',
          createdAt: new Date(START),
        },
      ]),
    );
    expect(inventory.machines).toHaveLength(2);
    expect(inventory.volumes).toEqual(
      expect.arrayContaining([
        {
          volumeId: a.volumeId,
          name: expect.stringContaining(SPEC.instanceId),
          attachedMachineId: a.machineId,
          createdAt: new Date(START),
        },
        {
          volumeId: b.volumeId,
          name: expect.stringContaining('inst-b'),
          attachedMachineId: b.machineId,
          createdAt: new Date(START),
        },
      ]),
    );
    expect(inventory.volumes).toHaveLength(2);
  });

  it('follows more than one page of results', async () => {
    const orchestrator = adapter();
    for (let i = 0; i < AWS_LIST_PAGE_SIZE + 3; i += 1) {
      ec2.plantInstance({
        tags: [
          { key: 'motir-shard', value: SHARD },
          { key: 'motir_instance_id', value: `inst-${i}` },
        ],
      });
      ec2.volumes.set(`vol-p${i}`, {
        volumeId: `vol-p${i}`,
        state: 'available',
        availabilityZone: 'us-east-1a',
        sizeGb: 10,
        attachedInstanceId: null,
        createTime: null,
        tags: [{ key: 'motir-shard', value: SHARD }],
        deleteOnTermination: false,
      });
    }
    const inventory = await orchestrator.listPersistent(SHARD);
    expect(inventory.machines).toHaveLength(AWS_LIST_PAGE_SIZE + 3);
    expect(inventory.volumes).toHaveLength(AWS_LIST_PAGE_SIZE + 3);
    expect(ec2.count('describeInstances')).toBe(2);
    expect(ec2.count('describeVolumes')).toBe(2);
    // A volume without a Name tag is named by its id.
    expect(inventory.volumes[0]!.name).toBe(inventory.volumes[0]!.volumeId);
  });

  it('answers an account with nothing in it as empty', async () => {
    expect(await adapter().listPersistent('an-account-with-nothing')).toEqual({
      app: 'an-account-with-nothing',
      machines: [],
      volumes: [],
    });
  });

  it('lists a hand-made machine with instanceId null, and destroyMachine takes only it', async () => {
    const orchestrator = adapter();
    const kept = await orchestrator.provisionPersistent(spec());
    const stray = ec2.plantInstance({ tags: [{ key: 'motir-shard', value: SHARD }] });
    const inventory = await orchestrator.listPersistent(SHARD);
    expect(inventory.machines.find((m) => m.machineId === stray)).toMatchObject({
      instanceId: null,
    });
    await orchestrator.destroyMachine(SHARD, stray);
    expect(ec2.liveInstanceIds()).toEqual([kept.machineId]);
  });

  it('turns a refused listing into the AWS code', async () => {
    ec2.failNext('describeVolumes', 'UnauthorizedOperation', 403);
    await expect(adapter().listPersistent(SHARD)).rejects.toMatchObject({
      provider: 'aws',
      status: 403,
    });
  });
});

describe('no value leaks', () => {
  it('no error from an upkeep operation holds an env value', async () => {
    const { orchestrator, handle } = await stopped({ terminal: TERMINAL });
    const errors: unknown[] = [];
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ec2.failNext('modifyInstanceUserData', 'InternalError', 500);
    errors.push(
      await thrown(() => orchestrator.ensureMachineConfig(handle, { ...TERMINAL, version: 9 })),
    );
    ec2.failNext('modifyInstanceUserData', 'InternalError', 500);
    errors.push(await thrown(() => orchestrator.moveImage(handle, 'img', { launch: false })));
    errors.push(
      await thrown(() =>
        orchestrator.ensureMachineConfig(handle, {
          ...TERMINAL,
          version: 9,
          env: { MOTIR_TERMINAL_KEY: `${MARKER}\nX=1` },
        }),
      ),
    );
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(`${(err as Error).message} ${JSON.stringify(err)}`).not.toContain(MARKER);
    }
    for (const spy of [log, warn]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(MARKER);
      spy.mockRestore();
    }
  });
});
