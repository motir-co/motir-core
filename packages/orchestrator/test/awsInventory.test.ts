import { describe, expect, it, vi } from 'vitest';
import {
  OrchestratorApiError,
  OrchestratorNotConfiguredError,
  createAwsFleetInventory,
  toEc2ApiError,
} from '../src';
import { AwsEc2Fake } from './contract/awsEc2Fake';

// THE AWS FLEET INVENTORY (MOTIR-9426) — one account's whole region, against the
// in-memory EC2 fake: no tag filter, every page, the port's state vocabulary, and
// a listing error that throws rather than reading as empty.

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

  it('stopMachine refuses, with no EC2 call', async () => {
    const ec2 = new AwsEc2Fake();
    const id = ec2.plantInstance({ tags: [] });
    await expect(inventoryOver(ec2).stopMachine(ACCOUNT, id)).rejects.toBeInstanceOf(
      OrchestratorNotConfiguredError,
    );
    expect(ec2.calls).toEqual([]);
  });
});
