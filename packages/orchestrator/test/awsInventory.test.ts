import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_INVENTORY_PAGE_SIZE,
  OrchestratorApiError,
  createAwsFleetInventory,
  type FleetInventory,
} from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';

// The AWS HOSTER INVENTORY (Story MOTIR-9361 · MOTIR-9476): every instance in one
// account — tagged or not, terminated ones left out — and every disk, each paged
// to the end; idempotent destroy and stop; a disk deleted only while unattached;
// a failed listing thrown, never an empty answer.

const SHARD = 'agent-hoster-a';
let ec2: AwsEc2Fake;
let inventory: FleetInventory;

beforeEach(() => {
  ec2 = new AwsEc2Fake();
  inventory = createAwsFleetInventory({ ec2, region: 'us-east-1', shardTag: SHARD });
});

describe('createAwsFleetInventory', () => {
  it('answers the one app the account is, and nothing for any other', async () => {
    expect(inventory.provider).toBe('aws');
    expect(await inventory.listApps()).toEqual([SHARD]);
    ec2.plantInstance({ tags: [] });
    expect(await inventory.listMachines('another-app')).toEqual([]);
    expect(await inventory.listVolumes!('another-app')).toEqual([]);
  });

  it('lists every live instance, a hand-started untagged one included, with its launch time and tags', async () => {
    const launched = new Date('2026-10-24T09:00:00Z');
    const tagged = ec2.plantInstance({
      launchTime: launched,
      tags: [
        { key: 'motir-shard', value: SHARD },
        { key: 'Name', value: 'motir-instance-x' },
      ],
    });
    const byHand = ec2.plantInstance({ tags: [], state: 'stopped', launchTime: null });
    const gone = ec2.plantInstance({ tags: [], state: 'terminated' });
    const machines = await inventory.listMachines(SHARD);
    expect(machines.map((m) => m.machineId).sort()).toEqual([tagged, byHand].sort());
    expect(machines.find((m) => m.machineId === tagged)).toEqual({
      app: SHARD,
      machineId: tagged,
      name: 'motir-instance-x',
      region: 'us-east-1',
      state: 'running',
      createdAt: launched,
      metadata: { 'motir-shard': SHARD, Name: 'motir-instance-x' },
    });
    expect(machines.find((m) => m.machineId === byHand)).toMatchObject({
      name: '',
      state: 'stopped',
      createdAt: null,
      metadata: {},
    });
    expect(machines.some((m) => m.machineId === gone)).toBe(false);
  });

  it('pages both listings to the end', async () => {
    for (let i = 0; i < AWS_INVENTORY_PAGE_SIZE + 3; i += 1) ec2.plantInstance({ tags: [] });
    for (let i = 0; i < AWS_INVENTORY_PAGE_SIZE + 2; i += 1) ec2.plantVolume();
    expect(await inventory.listMachines(SHARD)).toHaveLength(AWS_INVENTORY_PAGE_SIZE + 3);
    expect(ec2.count('describeInstances')).toBe(2);
    expect(await inventory.listVolumes!(SHARD)).toHaveLength(AWS_INVENTORY_PAGE_SIZE + 2);
    expect(ec2.count('describeVolumes')).toBe(2);
  });

  it('lists every disk with its state, attachment, creation and tags', async () => {
    const created = new Date('2026-10-24T08:00:00Z');
    const loose = ec2.plantVolume({ createTime: created, tags: [{ key: 'Name', value: 'home' }] });
    const machine = ec2.plantInstance({ tags: [] });
    const held = ec2.plantVolume({ attachedInstanceId: machine });
    ec2.backdateVolume(held, null);
    const volumes = await inventory.listVolumes!(SHARD);
    expect(volumes.find((v) => v.volumeId === loose)).toEqual({
      volumeId: loose,
      state: 'available',
      attachedMachineId: null,
      createdAt: created,
      tags: { Name: 'home' },
    });
    expect(volumes.find((v) => v.volumeId === held)).toMatchObject({
      state: 'in-use',
      attachedMachineId: machine,
      createdAt: null,
    });
  });

  it('a failed listing throws as an orchestrator error — never an empty list', async () => {
    ec2.failNext('describeInstances', 'RequestLimitExceeded', 503);
    await expect(inventory.listMachines(SHARD)).rejects.toBeInstanceOf(OrchestratorApiError);
    ec2.failNext('describeVolumes', 'UnauthorizedOperation', 403);
    await expect(inventory.listVolumes!(SHARD)).rejects.toBeInstanceOf(OrchestratorApiError);
  });

  it('destroys a machine (its disk stays), idempotently', async () => {
    const machine = ec2.plantInstance({ tags: [] });
    const home = ec2.plantVolume({ attachedInstanceId: machine });
    await inventory.destroyMachine(SHARD, machine);
    expect(ec2.liveInstanceIds()).toEqual([]);
    expect(ec2.liveVolumeIds()).toEqual([home]);
    ec2.ageOut(machine);
    await expect(inventory.destroyMachine(SHARD, machine)).resolves.toBeUndefined();
    ec2.failNext('terminateInstances', 'InternalError', 500);
    const other = ec2.plantInstance({ tags: [] });
    await expect(inventory.destroyMachine(SHARD, other)).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
  });

  it('stops a machine; one gone or already terminating is where a stop puts it', async () => {
    const machine = ec2.plantInstance({ tags: [] });
    await inventory.stopMachine(SHARD, machine);
    expect(ec2.instances.get(machine)!.state).toBe('stopped');
    await expect(inventory.stopMachine(SHARD, 'i-0000dead')).resolves.toBeUndefined();
    const ending = ec2.plantInstance({ tags: [], state: 'shutting-down' });
    await expect(inventory.stopMachine(SHARD, ending)).resolves.toBeUndefined();
    ec2.failNext('stopInstances', 'InternalError', 500);
    await expect(inventory.stopMachine(SHARD, machine)).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
  });

  it('deletes an unattached disk, refuses an attached one, and a gone one is done', async () => {
    const loose = ec2.plantVolume();
    await inventory.destroyVolume!(SHARD, loose);
    expect(ec2.liveVolumeIds()).toEqual([]);
    await expect(inventory.destroyVolume!(SHARD, loose)).resolves.toBeUndefined();
    const machine = ec2.plantInstance({ tags: [] });
    const held = ec2.plantVolume({ attachedInstanceId: machine });
    await expect(inventory.destroyVolume!(SHARD, held)).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
    expect(ec2.liveVolumeIds()).toEqual([held]);
  });

  it('a transport failure on any action is an orchestrator error, never success', async () => {
    const machine = ec2.plantInstance({ tags: [] });
    const loose = ec2.plantVolume();
    const dropped = () => Promise.reject(new Error('socket hang up'));
    vi.spyOn(ec2, 'terminateInstances').mockImplementation(dropped);
    vi.spyOn(ec2, 'stopInstances').mockImplementation(dropped);
    vi.spyOn(ec2, 'deleteVolume').mockImplementation(dropped);
    for (const action of [
      () => inventory.destroyMachine(SHARD, machine),
      () => inventory.stopMachine(SHARD, machine),
      () => inventory.destroyVolume!(SHARD, loose),
    ]) {
      await expect(action()).rejects.toBeInstanceOf(OrchestratorApiError);
    }
  });
});
