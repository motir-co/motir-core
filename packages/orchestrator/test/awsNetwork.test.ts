import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  AWS_SHARD_TAG_KEY,
  AwsShardNetworkConflictError,
  ensureAwsShardNetwork,
  zoneCidrs,
  type EnsureAwsShardNetworkInput,
} from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';

// An AWS shard's network (Story MOTIR-9270 · MOTIR-9273), against the in-memory
// EC2: what a first call creates, that a second creates nothing, that a run which
// died halfway resumes, and that no NAT gateway, Elastic IP or inbound rule is
// ever written.

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
const shardTags = [{ key: AWS_SHARD_TAG_KEY, value: 'ci-1' }];

function input(ec2: AwsEc2Fake, overrides: Partial<EnsureAwsShardNetworkInput> = {}) {
  return { credentials: CREDENTIALS, regionId: 'us-east-1', shardTag: 'ci-1', ec2, ...overrides };
}

function hasShardTag(tags: readonly { key: string; value: string }[], shardTag = 'ci-1') {
  return tags.some((t) => t.key === AWS_SHARD_TAG_KEY && t.value === shardTag);
}

describe('ensureAwsShardNetwork', () => {
  it('creates the whole network on a first call, every resource tagged', async () => {
    const ec2 = new AwsEc2Fake();

    const network = await ensureAwsShardNetwork(input(ec2));

    expect(ec2.vpcs.size).toBe(1);
    expect(ec2.internetGateways.size).toBe(1);
    expect(ec2.routeTables.size).toBe(1);
    expect(ec2.subnets.size).toBe(3);
    expect(ec2.securityGroups.size).toBe(1);

    const gateway = ec2.internetGateways.get(network.internetGatewayId)!;
    expect(gateway.attachedVpcIds).toEqual([network.vpcId]);

    const table = ec2.routeTables.get(network.routeTableId)!;
    expect(table.routes).toContainEqual({
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: network.internetGatewayId,
    });
    expect([...table.associatedSubnetIds].sort()).toEqual(
      network.subnets.map((s) => s.subnetId).sort(),
    );

    expect(network.subnets.map((s) => s.zoneId)).toEqual([
      'us-east-1a',
      'us-east-1b',
      'us-east-1c',
    ]);
    for (const { subnetId } of network.subnets) {
      expect(ec2.subnets.get(subnetId)!.mapPublicIpOnLaunch).toBe(true);
    }
    expect([...ec2.subnets.values()].map((s) => s.cidrBlock).sort()).toEqual([
      '10.40.0.0/20',
      '10.40.16.0/20',
      '10.40.32.0/20',
    ]);

    const group = ec2.securityGroups.get(network.securityGroupId)!;
    expect(group.ingressRuleCount).toBe(0);
    expect(group.groupName).toBe('motir-runner-ci-1');

    const everything = [
      ...ec2.vpcs.values(),
      ...ec2.internetGateways.values(),
      ...ec2.routeTables.values(),
      ...ec2.subnets.values(),
      ...ec2.securityGroups.values(),
    ];
    expect(everything.every((r) => hasShardTag(r.tags))).toBe(true);

    expect(network.created).toEqual([
      `vpc:${network.vpcId}`,
      `internet-gateway:${network.internetGatewayId}`,
      `route-table:${network.routeTableId}`,
      `route:${network.routeTableId}:0.0.0.0/0`,
      ...network.subnets.map((s) => `subnet:${s.subnetId}`),
      `security-group:${network.securityGroupId}`,
    ]);
    // Each create carries its tag in the same call — no separate tagging call.
    expect(ec2.calls.some((c) => /tags$/i.test(c.method))).toBe(false);
  });

  it('changes nothing on a second call and returns the same ids', async () => {
    const ec2 = new AwsEc2Fake();
    const first = await ensureAwsShardNetwork(input(ec2));
    const before = ec2.mutations().length;

    const second = await ensureAwsShardNetwork(input(ec2));

    expect(ec2.mutations()).toHaveLength(before);
    expect(second.created).toEqual([]);
    expect({ ...second, created: [] }).toEqual({ ...first, created: [] });
  });

  it('resumes a run that stopped once the VPC and subnets existed', async () => {
    const ec2 = new AwsEc2Fake();
    const tags = [{ key: AWS_SHARD_TAG_KEY, value: 'ci-1' }];
    const { vpcId } = await ec2.createVpc({ cidrBlock: '10.40.0.0/16', tags });
    for (const [zone, cidrBlock] of zoneCidrs('10.40.0.0/16', [
      'us-east-1a',
      'us-east-1b',
      'us-east-1c',
    ])) {
      const { subnetId } = await ec2.createSubnet({
        vpcId,
        cidrBlock,
        availabilityZone: zone,
        tags,
      });
      await ec2.modifySubnetAttribute({ subnetId, mapPublicIpOnLaunch: true });
    }
    ec2.calls.length = 0;

    const network = await ensureAwsShardNetwork(input(ec2));

    expect(network.vpcId).toBe(vpcId);
    expect(ec2.count('createVpc')).toBe(0);
    expect(ec2.count('createSubnet')).toBe(0);
    expect(ec2.count('modifySubnetAttribute')).toBe(0);
    expect(network.created.map((c) => c.split(':')[0])).toEqual([
      'internet-gateway',
      'route-table',
      'route',
      'security-group',
    ]);
    expect(ec2.count('associateRouteTable')).toBe(3);
  });

  it('attaches a gateway and routes a table a dead run left unattached', async () => {
    const ec2 = new AwsEc2Fake();
    const first = await ensureAwsShardNetwork(input(ec2));
    const gateway = ec2.internetGateways.get(first.internetGatewayId)!;
    ec2.internetGateways.set(first.internetGatewayId, { ...gateway, attachedVpcIds: [] });
    const table = ec2.routeTables.get(first.routeTableId)!;
    ec2.routeTables.set(first.routeTableId, {
      ...table,
      routes: table.routes.filter((r) => r.destinationCidrBlock !== '0.0.0.0/0'),
    });
    ec2.calls.length = 0;

    const second = await ensureAwsShardNetwork(input(ec2));

    expect(ec2.count('attachInternetGateway')).toBe(1);
    expect(ec2.count('createRoute')).toBe(1);
    expect(second.created).toEqual([`route:${first.routeTableId}:0.0.0.0/0`]);
  });

  it('re-asserts a public IP on a subnet someone turned it off on', async () => {
    const ec2 = new AwsEc2Fake();
    const first = await ensureAwsShardNetwork(input(ec2));
    const subnetId = first.subnets[1]!.subnetId;
    ec2.subnets.set(subnetId, { ...ec2.subnets.get(subnetId)!, mapPublicIpOnLaunch: false });
    ec2.calls.length = 0;

    await ensureAwsShardNetwork(input(ec2));

    expect(ec2.calls.filter((c) => c.method === 'modifySubnetAttribute')).toEqual([
      { method: 'modifySubnetAttribute', input: { subnetId, mapPublicIpOnLaunch: true } },
    ]);
  });

  it('refuses two tagged VPCs for one shard, naming both, and creates nothing', async () => {
    const ec2 = new AwsEc2Fake();
    const tags = [{ key: AWS_SHARD_TAG_KEY, value: 'ci-1' }];
    const a = await ec2.createVpc({ cidrBlock: '10.40.0.0/16', tags });
    const b = await ec2.createVpc({ cidrBlock: '10.40.0.0/16', tags });
    ec2.calls.length = 0;

    const thrown = await ensureAwsShardNetwork(input(ec2)).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(AwsShardNetworkConflictError);
    expect((thrown as Error).message).toContain('motir-shard=ci-1');
    expect((thrown as Error).message).toContain(a.vpcId);
    expect((thrown as Error).message).toContain(b.vpcId);
    expect(ec2.mutations()).toEqual([]);
  });

  it.each([
    ['internet gateway', (ec2: AwsEc2Fake) => ec2.createInternetGateway({ tags: shardTags })],
    [
      'route table',
      (ec2: AwsEc2Fake, vpcId: string) => ec2.createRouteTable({ vpcId, tags: shardTags }),
    ],
    [
      'subnet in us-east-1a',
      (ec2: AwsEc2Fake, vpcId: string) =>
        ec2.createSubnet({
          vpcId,
          cidrBlock: '10.40.48.0/20',
          availabilityZone: 'us-east-1a',
          tags: shardTags,
        }),
    ],
    [
      'security group',
      (ec2: AwsEc2Fake, vpcId: string) =>
        ec2.createSecurityGroup({ groupName: 'copy', description: 'd', vpcId, tags: shardTags }),
    ],
  ])('refuses a second tagged %s rather than choosing one', async (resource, duplicate) => {
    const ec2 = new AwsEc2Fake();
    const first = await ensureAwsShardNetwork(input(ec2));
    await duplicate(ec2, first.vpcId);

    const thrown = await ensureAwsShardNetwork(input(ec2)).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(AwsShardNetworkConflictError);
    expect(thrown).toMatchObject({ resource, shardTag: 'ci-1' });
  });

  it('keeps two shards in one region disjoint', async () => {
    const ec2 = new AwsEc2Fake();
    const one = await ensureAwsShardNetwork(input(ec2, { shardTag: 'ci-1' }));
    const two = await ensureAwsShardNetwork(
      input(ec2, { shardTag: 'ci-2', vpcCidr: '10.41.0.0/16' }),
    );

    expect(two.vpcId).not.toBe(one.vpcId);
    expect(two.subnets.map((s) => s.subnetId)).not.toContain(one.subnets[0]!.subnetId);
    expect(two.securityGroupId).not.toBe(one.securityGroupId);
    expect(ec2.subnets.get(two.subnets[0]!.subnetId)!.cidrBlock).toBe('10.41.0.0/20');

    ec2.calls.length = 0;
    await ensureAwsShardNetwork(input(ec2, { shardTag: 'ci-1' }));
    expect(ec2.mutations()).toEqual([]);
    expect(
      two.subnets.every(({ subnetId }) => hasShardTag(ec2.subnets.get(subnetId)!.tags, 'ci-2')),
    ).toBe(true);
  });

  it('uses the zones it is given, sorted, and only available ones otherwise', async () => {
    const ec2 = new AwsEc2Fake();
    ec2.zones = [
      { zoneName: 'us-east-1d', state: 'available' },
      { zoneName: 'us-east-1a', state: 'impaired' },
      { zoneName: 'us-east-1b', state: 'available' },
      { zoneName: 'us-east-1c', state: 'available' },
      { zoneName: 'us-east-1f', state: 'available' },
    ];
    const discovered = await ensureAwsShardNetwork(input(ec2));
    expect(discovered.subnets.map((s) => s.zoneId)).toEqual([
      'us-east-1b',
      'us-east-1c',
      'us-east-1d',
    ]);

    const given = await ensureAwsShardNetwork(
      input(new AwsEc2Fake(), { shardTag: 'ci-9', zones: ['us-east-1f', 'us-east-1a'] }),
    );
    expect(given.subnets.map((s) => s.zoneId)).toEqual(['us-east-1a', 'us-east-1f']);
  });

  it('refuses a region with no available zone', async () => {
    const ec2 = new AwsEc2Fake();
    ec2.zones = [];
    await expect(ensureAwsShardNetwork(input(ec2))).rejects.toThrow(/No available zone/);
    expect(ec2.mutations()).toEqual([]);
  });

  it('derives one /20 per zone from a /16 and refuses anything else', () => {
    expect([...zoneCidrs('10.40.0.0/16', ['b', 'a'])]).toEqual([
      ['a', '10.40.0.0/20'],
      ['b', '10.40.16.0/20'],
    ]);
    expect(() => zoneCidrs('10.40.0.0/20', ['a'])).toThrow(/IPv4 \/16/);
    expect(() => zoneCidrs('nonsense', ['a'])).toThrow(/IPv4 \/16/);
    expect(() =>
      zoneCidrs(
        '10.40.0.0/16',
        Array.from({ length: 17 }, (_, i) => `z${i}`),
      ),
    ).toThrow(/sixteen/);
  });

  it('writes no NAT gateway, Elastic IP or inbound rule anywhere in the AWS adapter', async () => {
    const ec2 = new AwsEc2Fake();
    await ensureAwsShardNetwork(input(ec2));
    expect(ec2.calls.some((c) => /nat|address|ingress/i.test(c.method))).toBe(false);

    const grep = (pattern: string) => {
      try {
        return execFileSync(
          'git',
          ['grep', '--untracked', '-nE', pattern, '--', 'src/adapters/aws/'],
          {
            cwd: new URL('..', import.meta.url).pathname,
            encoding: 'utf8',
          },
        );
      } catch {
        return ''; // git grep exits 1 when nothing matches
      }
    };
    expect(grep('AuthorizeSecurityGroupIngress')).toBe('');
    expect(grep('NatGateway|AllocateAddress')).toBe('');
    expect(grep('process\\.env')).toBe('');
  });
});
