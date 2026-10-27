import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  AwsShardNetworkConflictError,
  AwsShardNetworkMissingError,
  awsShardVpcExists,
  readAwsShardNetwork,
  zoneCidrs,
} from '../src/index';
import * as orchestrator from '../src/index';
import { AwsEc2Fake } from './contract/awsEc2Fake';

// An AWS shard's network (Story MOTIR-9270 · MOTIR-9273), READ AND CHECKED
// against the in-memory EC2 (MOTIR-9845): the pool-account definition builds it,
// this finds it by its tag, refuses a missing or doubled resource, and never
// writes — no create, no delete, and no NAT gateway, Elastic IP or inbound rule.

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };

function input(ec2: AwsEc2Fake, shardTag = 'ci-1') {
  return { credentials: CREDENTIALS, regionId: 'us-east-1', shardTag, ec2 };
}

describe('readAwsShardNetwork', () => {
  it('finds the VPC, gateway, route table, per-zone subnets and group by the shard tag', async () => {
    const ec2 = new AwsEc2Fake();
    const seeded = ec2.seedShardNetwork('ci-1', ['us-east-1b', 'us-east-1a']);
    ec2.seedShardNetwork('ci-2');
    await expect(readAwsShardNetwork(input(ec2))).resolves.toEqual({
      vpcId: seeded.vpcId,
      internetGatewayId: seeded.internetGatewayId,
      routeTableId: seeded.routeTableId,
      subnets: [
        { zoneId: 'us-east-1a', subnetId: 'subnet-ci-1-us-east-1a' },
        { zoneId: 'us-east-1b', subnetId: 'subnet-ci-1-us-east-1b' },
      ],
      securityGroupId: seeded.groupId,
    });
    expect(ec2.mutations()).toEqual([]);
  });

  it('throws AwsShardNetworkMissingError naming each absent resource', async () => {
    const cases: [string, (ec2: AwsEc2Fake) => void, string][] = [
      ['VPC', () => undefined, 'VPC'],
      ['gateway', (ec2) => ec2.internetGateways.delete('igw-ci-1'), 'internet gateway'],
      [
        'detached gateway',
        (ec2) =>
          ec2.internetGateways.set('igw-ci-1', {
            ...ec2.internetGateways.get('igw-ci-1')!,
            attachedVpcIds: [],
          }),
        'internet gateway attached to vpc-ci-1',
      ],
      ['route table', (ec2) => ec2.routeTables.delete('rtb-ci-1'), 'route table'],
      ['group', (ec2) => ec2.securityGroups.delete('sg-ci-1'), 'security group'],
      ['subnets', (ec2) => ec2.subnets.clear(), 'subnet'],
    ];
    for (const [label, breakIt, resource] of cases) {
      const ec2 = new AwsEc2Fake();
      if (label !== 'VPC') ec2.seedShardNetwork('ci-1');
      breakIt(ec2);
      const thrown = await readAwsShardNetwork(input(ec2)).catch((err: unknown) => err);
      expect(thrown, label).toBeInstanceOf(AwsShardNetworkMissingError);
      expect(thrown, label).toMatchObject({ shardTag: 'ci-1', resource });
      expect(ec2.mutations()).toEqual([]);
    }
  });

  it('refuses two tagged resources of one kind, never choosing between them', async () => {
    const ec2 = new AwsEc2Fake();
    ec2.seedShardNetwork('ci-1', ['us-east-1a']);
    const subnet = ec2.subnets.get('subnet-ci-1-us-east-1a')!;
    ec2.subnets.set('subnet-copy', { ...subnet, subnetId: 'subnet-copy' });
    const thrown = await readAwsShardNetwork(input(ec2)).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(AwsShardNetworkConflictError);
    expect(thrown).toMatchObject({
      resource: 'subnet in us-east-1a',
      ids: ['subnet-ci-1-us-east-1a', 'subnet-copy'],
    });
  });

  it('awsShardVpcExists says whether any VPC carries the tag', async () => {
    const ec2 = new AwsEc2Fake();
    await expect(awsShardVpcExists(input(ec2))).resolves.toBe(false);
    ec2.seedShardNetwork('ci-1');
    await expect(awsShardVpcExists(input(ec2))).resolves.toBe(true);
    await expect(awsShardVpcExists(input(ec2, 'ci-9'))).resolves.toBe(false);
  });

  it('no longer exports a network creator', () => {
    expect('ensureAwsShardNetwork' in orchestrator).toBe(false);
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

  it('writes no NAT gateway or Elastic IP anywhere in the AWS adapter, and no inbound rule outside the hoster’s host agent', async () => {
    const ec2 = new AwsEc2Fake();
    ec2.seedShardNetwork('ci-1');
    await readAwsShardNetwork(input(ec2));
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
    // The ONE inbound rule in the adapter is the agent hoster's host agent port
    // (MOTIR-9470: TCP 8443, mutual TLS), opened by the persistent adapter on its
    // own account's group — never by the shard network, never for a runner.
    // `management.ts` names the action only in the hoster's IAM grant, scoped to
    // its own tagged group.
    const ingressFiles = new Set(
      grep('AuthorizeSecurityGroupIngress|authorizeSecurityGroupIngress')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(':')[0]),
    );
    expect([...ingressFiles].sort()).toEqual([
      'src/adapters/aws/ec2Client.ts',
      'src/adapters/aws/management.ts',
      'src/adapters/aws/persistent.ts',
    ]);
    expect(grep('NatGateway|AllocateAddress')).toBe('');
    expect(grep('process\\.env')).toBe('');
  });
});
