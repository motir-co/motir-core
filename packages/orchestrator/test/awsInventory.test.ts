import { describe, expect, it, vi } from 'vitest';
import { OrchestratorApiError, createAwsFleetInventory, toEc2ApiError } from '../src';
import { AwsEc2Fake } from './contract/awsEc2Fake';

// THE AWS FLEET INVENTORY (MOTIR-9426) — one account's whole region, against the
// in-memory EC2 fake: no tag filter, every page, the port's state vocabulary, and
// a listing error that throws rather than reading as empty — and, for an
// agent-hoster account's persistent machines (MOTIR-9476), a real stop and every
// disk listed and deleted.

const ACCOUNT = 'agents-us-east-1-a';

function inventoryOver(ec2: AwsEc2Fake, pageSize?: number) {
  return createAwsFleetInventory({
    ec2,
    region: 'us-east-1',
    accountName: ACCOUNT,
    ...(pageSize ? { pageSize } : {}),
  });
}

describe('createAwsFleetInventory', () => {
  it('lists exactly the account as its one app, and nothing for any other app', async () => {
    const ec2 = new AwsEc2Fake();
    ec2.plantInstance({ tags: [] });
    const inventory = inventoryOver(ec2);
    expect(inventory.provider).toBe('aws');
    expect(await inventory.listApps()).toEqual([ACCOUNT]);
    expect(await inventory.listMachines('another-account')).toEqual([]);
    expect(ec2.count('describeInstances')).toBe(0);
  });

  it('lists every instance across pages, tagged and untagged, with no tag filter', async () => {
    const ec2 = new AwsEc2Fake();
    const launched = new Date('2026-10-24T10:00:00.000Z');
    const tagged = ec2.plantInstance({
      launchTime: launched,
      tags: [
        { key: 'Name', value: 'motir-agent-run1' },
        { key: 'motir-shard', value: 'agents-a' },
        { key: 'motir_dispatch_run_id', value: 'run1' },
      ],
    });
    const byHand = ec2.plantInstance({ tags: [], launchTime: null });
    const states = ['pending', 'stopping', 'stopped', 'shutting-down', 'terminated'];
    const others = states.map((state) => ec2.plantInstance({ state, tags: [] }));

    const machines = await inventoryOver(ec2, 2).listMachines(ACCOUNT);

    expect(ec2.count('describeInstances')).toBe(4);
    for (const call of ec2.calls.filter((c) => c.method === 'describeInstances')) {
      expect((call.input as { filters?: unknown }).filters).toBeUndefined();
    }
    expect(machines).toHaveLength(7);
    expect(machines.find((m) => m.machineId === tagged)).toEqual({
      app: ACCOUNT,
      machineId: tagged,
      name: 'motir-agent-run1',
      region: 'us-east-1',
      state: 'running',
      createdAt: launched,
      metadata: {
        Name: 'motir-agent-run1',
        'motir-shard': 'agents-a',
        motir_dispatch_run_id: 'run1',
      },
    });
    expect(machines.find((m) => m.machineId === byHand)).toMatchObject({
      name: '',
      createdAt: null,
      metadata: {},
      state: 'running',
    });
    expect(others.map((id) => machines.find((m) => m.machineId === id)!.state)).toEqual([
      'starting',
      'stopping',
      'stopped',
      'gone',
      'gone',
    ]);
  });

  it.each([
    [503, 'RequestLimitExceeded'],
    [400, 'UnauthorizedOperation'],
  ])('a failing DescribeInstances (%s) throws, never an empty list', async (status, code) => {
    const ec2 = new AwsEc2Fake();
    ec2.plantInstance({ tags: [] });
    // As `createEc2Api` hands it over: the SDK's error reduced to its code.
    const sdkError = Object.assign(new Error('the user-data was S3CRET'), {
      Code: code,
      $metadata: { httpStatusCode: status },
    });
    vi.spyOn(ec2, 'describeInstances').mockRejectedValueOnce(toEc2ApiError(sdkError));

    const listed = inventoryOver(ec2).listMachines(ACCOUNT);
    await expect(listed).rejects.toBeInstanceOf(OrchestratorApiError);
    const error = (await listed.catch((e: unknown) => e)) as OrchestratorApiError;
    expect(error).toMatchObject({ provider: 'aws', status });
    expect(error.message).toContain(code);
    expect(error.message).not.toContain('S3CRET');
  });

  it('destroyMachine terminates, and resolves again and on an unknown id', async () => {
    const ec2 = new AwsEc2Fake();
    const id = ec2.plantInstance({ tags: [] });
    const inventory = inventoryOver(ec2);

    await inventory.destroyMachine(ACCOUNT, id);
    expect(ec2.liveInstanceIds()).toEqual([]);
    await expect(inventory.destroyMachine(ACCOUNT, id)).resolves.toBeUndefined();
    await expect(inventory.destroyMachine(ACCOUNT, 'i-0000dead')).resolves.toBeUndefined();
  });

  it('destroyMachine throws any other EC2 refusal as the port error', async () => {
    const ec2 = new AwsEc2Fake();
    const id = ec2.plantInstance({ tags: [] });
    ec2.failNext('terminateInstances', 'UnauthorizedOperation', 403);
    await expect(inventoryOver(ec2).destroyMachine(ACCOUNT, id)).rejects.toMatchObject({
      provider: 'aws',
      status: 403,
    });
  });

  it('stops a machine; one gone or already terminating is where a stop puts it', async () => {
    const ec2 = new AwsEc2Fake();
    const inventory = inventoryOver(ec2);
    const machine = ec2.plantInstance({ tags: [] });
    await inventory.stopMachine(ACCOUNT, machine);
    expect(ec2.instances.get(machine)!.state).toBe('stopped');
    await expect(inventory.stopMachine(ACCOUNT, 'i-0000dead')).resolves.toBeUndefined();
    const ending = ec2.plantInstance({ tags: [], state: 'shutting-down' });
    await expect(inventory.stopMachine(ACCOUNT, ending)).resolves.toBeUndefined();
    ec2.failNext('stopInstances', 'InternalError', 500);
    await expect(inventory.stopMachine(ACCOUNT, machine)).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
  });

  it('lists every disk across pages, with its state, attachment, creation and tags', async () => {
    const ec2 = new AwsEc2Fake();
    const created = new Date('2026-10-24T08:00:00Z');
    const loose = ec2.plantVolume({ createTime: created, tags: [{ key: 'Name', value: 'home' }] });
    const machine = ec2.plantInstance({ tags: [] });
    const held = ec2.plantVolume({ attachedInstanceId: machine });
    ec2.backdateVolume(held, null);
    for (let i = 0; i < 6; i += 1) ec2.plantVolume();

    const volumes = await inventoryOver(ec2, 5).listVolumes!(ACCOUNT);

    expect(volumes).toHaveLength(8);
    expect(ec2.count('describeVolumes')).toBe(2);
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
    expect(await inventoryOver(ec2).listVolumes!('another-account')).toEqual([]);
  });

  it('a failed disk listing throws as an orchestrator error, never an empty list', async () => {
    const ec2 = new AwsEc2Fake();
    ec2.plantVolume();
    ec2.failNext('describeVolumes', 'UnauthorizedOperation', 403);
    await expect(inventoryOver(ec2).listVolumes!(ACCOUNT)).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
  });

  it('destroys a machine with its disk left, and deletes only an unattached disk', async () => {
    const ec2 = new AwsEc2Fake();
    const inventory = inventoryOver(ec2);
    const machine = ec2.plantInstance({ tags: [] });
    const home = ec2.plantVolume({ attachedInstanceId: machine });
    await inventory.destroyMachine(ACCOUNT, machine);
    expect(ec2.liveVolumeIds()).toEqual([home]);

    const loose = ec2.plantVolume();
    await inventory.destroyVolume!(ACCOUNT, loose);
    expect(ec2.liveVolumeIds()).toEqual([home]);
    await expect(inventory.destroyVolume!(ACCOUNT, loose)).resolves.toBeUndefined();
    const other = ec2.plantInstance({ tags: [] });
    const held = ec2.plantVolume({ attachedInstanceId: other });
    await expect(inventory.destroyVolume!(ACCOUNT, held)).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
  });

  it('a transport failure on any action is an orchestrator error, never success', async () => {
    const ec2 = new AwsEc2Fake();
    const inventory = inventoryOver(ec2);
    const machine = ec2.plantInstance({ tags: [] });
    const loose = ec2.plantVolume();
    const dropped = () => Promise.reject(new Error('socket hang up'));
    vi.spyOn(ec2, 'terminateInstances').mockImplementation(dropped);
    vi.spyOn(ec2, 'stopInstances').mockImplementation(dropped);
    vi.spyOn(ec2, 'deleteVolume').mockImplementation(dropped);
    for (const action of [
      () => inventory.destroyMachine(ACCOUNT, machine),
      () => inventory.stopMachine(ACCOUNT, machine),
      () => inventory.destroyVolume!(ACCOUNT, loose),
    ]) {
      await expect(action()).rejects.toBeInstanceOf(OrchestratorApiError);
    }
  });
});
