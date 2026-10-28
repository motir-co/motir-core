import type {
  AwsCredentialsConfig,
  Ec2Api,
  Ec2Filter,
  Ec2InternetGateway,
  Ec2RouteTable,
  Ec2SecurityGroup,
  Ec2Subnet,
  Ec2Vpc,
} from './ec2Client';
import { createEc2Api } from './ec2Client';

// An AWS shard's NETWORK (Story MOTIR-9270 · MOTIR-9273), READ AND CHECKED.
//
// The network is built by the pool-account definition (motir-infra's StackSet,
// MOTIR-9708), never by code: a VPC, an internet gateway attached to it, a public
// route table whose default route is that gateway, one public subnet per zone
// (`MapPublicIpOnLaunch`, so every runner gets a public IPv4 address at boot), and
// one security group with NO inbound rule, every resource tagged
// `motir-shard=<shardTag>`. This module finds that network by its tag — what the
// AWS adapter (MOTIR-9276) discovers at boot — and refuses when a resource is
// missing or doubled. It creates, modifies and deletes nothing.
//
// ⚠️ NO NAT GATEWAY, NO ELASTIC IP, NO VPC ENDPOINT. Runners only dial out
// (GitHub, `ghcr.io`), so a public address per runner behind a no-inbound group is
// egress enough, and a NAT gateway charges per GB processed in both directions —
// at fleet scale many times the compute (the CI runner hosting comparison page,
// sections 2.3 and 9). The hourly public IPv4 charge is the accepted cost.

/** The tag every shard resource carries, and the adapter's discovery key. */
export const AWS_SHARD_TAG_KEY = 'motir-shard';

/** The security group's name — unique per VPC, so derived from the tag. */
export function awsShardSecurityGroupName(shardTag: string): string {
  return `motir-runner-${shardTag}`;
}

/** Two tagged resources of one kind for one shard: a race or a hand-made copy.
 *  Refused, never silently resolved by picking one. */
export class AwsShardNetworkConflictError extends Error {
  readonly code = 'AWS_SHARD_NETWORK_CONFLICT' as const;
  constructor(
    readonly shardTag: string,
    readonly resource: string,
    readonly ids: readonly string[],
  ) {
    super(
      `More than one ${resource} carries ${AWS_SHARD_TAG_KEY}=${shardTag} (${ids.join(', ')}); ` +
        `remove the extra one by hand — the network is never chosen between.`,
    );
    this.name = 'AwsShardNetworkConflictError';
  }
}

/** A resource of the shard's network carries no `motir-shard=<tag>` tag:
 *  the network was never built, or was changed by hand. */
export class AwsShardNetworkMissingError extends Error {
  readonly code = 'AWS_SHARD_NETWORK_MISSING' as const;
  constructor(
    readonly shardTag: string,
    readonly resource: string,
  ) {
    super(`No ${resource} carries ${AWS_SHARD_TAG_KEY}=${shardTag}.`);
    this.name = 'AwsShardNetworkMissingError';
  }
}

export interface ReadAwsShardNetworkInput {
  /** The account and region to read in. Ignored when `ec2` is given. */
  readonly credentials?: Omit<AwsCredentialsConfig, 'region'>;
  readonly regionId: string;
  readonly shardTag: string;
  /** An EC2 surface to use instead of building one from `credentials` — the test seam. */
  readonly ec2?: Ec2Api;
}

export interface AwsShardNetwork {
  readonly vpcId: string;
  readonly internetGatewayId: string;
  readonly routeTableId: string;
  /** One public subnet per zone, sorted by zone. */
  readonly subnets: ReadonlyArray<{ readonly zoneId: string; readonly subnetId: string }>;
  readonly securityGroupId: string;
}

function tagFilter(shardTag: string): Ec2Filter {
  return { name: `tag:${AWS_SHARD_TAG_KEY}`, values: [shardTag] };
}

/** The one tagged resource, else a refusal: none is missing, two are a conflict. */
function single<T>(shardTag: string, resource: string, found: T[], idOf: (t: T) => string): T {
  if (found.length > 1) {
    throw new AwsShardNetworkConflictError(shardTag, resource, found.map(idOf));
  }
  const [only] = found;
  if (only === undefined) throw new AwsShardNetworkMissingError(shardTag, resource);
  return only;
}

/**
 * The zones and their `/20` blocks. The block is derived from the zone's index in
 * the SORTED list, so a re-run derives the same CIDR for the same zone.
 */
export function zoneCidrs(vpcCidr: string, zones: readonly string[]): Map<string, string> {
  const [base, bits] = vpcCidr.split('/');
  const octets = (base ?? '').split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o)) || bits !== '16') {
    throw new Error(`The shard VPC range must be an IPv4 /16, got ${vpcCidr}.`);
  }
  const sorted = [...zones].sort();
  if (sorted.length > 16) throw new Error('A /16 holds at most sixteen /20 subnets.');
  return new Map(sorted.map((zone, i) => [zone, `${octets[0]}.${octets[1]}.${i * 16}.0/20`]));
}

function ec2For(input: ReadAwsShardNetworkInput): Ec2Api {
  if (input.ec2) return input.ec2;
  if (!input.credentials)
    throw new Error('readAwsShardNetwork needs credentials or an ec2 surface.');
  return createEc2Api({ ...input.credentials, region: input.regionId });
}

/** Whether any VPC carries the shard's tag — a network, whole or partial, exists. */
export async function awsShardVpcExists(input: ReadAwsShardNetworkInput): Promise<boolean> {
  return (await ec2For(input).describeVpcs([tagFilter(input.shardTag)])).length > 0;
}

/**
 * The shard's network, found by its tag: the VPC, its internet gateway, route
 * table and security group, and its subnets one per zone. Throws
 * `AwsShardNetworkMissingError` naming an absent resource and
 * `AwsShardNetworkConflictError` on two of a kind. Reads only.
 */
export async function readAwsShardNetwork(
  input: ReadAwsShardNetworkInput,
): Promise<AwsShardNetwork> {
  const ec2 = ec2For(input);
  const tag = input.shardTag;
  const vpcId = single<Ec2Vpc>(
    tag,
    'VPC',
    await ec2.describeVpcs([tagFilter(tag)]),
    (v) => v.vpcId,
  ).vpcId;
  const inVpc: Ec2Filter[] = [tagFilter(tag), { name: 'vpc-id', values: [vpcId] }];

  const gateway = single<Ec2InternetGateway>(
    tag,
    'internet gateway',
    await ec2.describeInternetGateways([tagFilter(tag)]),
    (g) => g.internetGatewayId,
  );
  if (!gateway.attachedVpcIds.includes(vpcId)) {
    throw new AwsShardNetworkMissingError(tag, `internet gateway attached to ${vpcId}`);
  }
  const routeTable = single<Ec2RouteTable>(
    tag,
    'route table',
    await ec2.describeRouteTables(inVpc),
    (t) => t.routeTableId,
  );
  const securityGroup = single<Ec2SecurityGroup>(
    tag,
    'security group',
    await ec2.describeSecurityGroups(inVpc),
    (g) => g.groupId,
  );

  const byZone = new Map<string, Ec2Subnet[]>();
  for (const subnet of await ec2.describeSubnets(inVpc)) {
    byZone.set(subnet.availabilityZone, [...(byZone.get(subnet.availabilityZone) ?? []), subnet]);
  }
  if (byZone.size === 0) throw new AwsShardNetworkMissingError(tag, 'subnet');
  const subnets = [...byZone.keys()].sort().map((zone) => ({
    zoneId: zone,
    subnetId: single<Ec2Subnet>(tag, `subnet in ${zone}`, byZone.get(zone) ?? [], (s) => s.subnetId)
      .subnetId,
  }));

  return {
    vpcId,
    internetGatewayId: gateway.internetGatewayId,
    routeTableId: routeTable.routeTableId,
    subnets,
    securityGroupId: securityGroup.groupId,
  };
}
