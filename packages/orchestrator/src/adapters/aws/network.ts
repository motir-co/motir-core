import type {
  AwsCredentialsConfig,
  Ec2Api,
  Ec2Filter,
  Ec2InternetGateway,
  Ec2RouteTable,
  Ec2SecurityGroup,
  Ec2Subnet,
  Ec2Tag,
  Ec2Vpc,
} from './ec2Client';
import { createEc2Api } from './ec2Client';

// An AWS shard's NETWORK (Story MOTIR-9270 · MOTIR-9273), provisioned idempotently.
//
// One function leaves a region holding exactly what the AWS adapter (MOTIR-9276)
// discovers by tag at boot: a VPC, an internet gateway attached to it, a public
// route table whose default route is that gateway, one public subnet per zone
// (`MapPublicIpOnLaunch`, so every runner gets a public IPv4 address at boot), and
// one security group with NO inbound rule. Every resource carries
// `motir-shard=<shardTag>`, written in the create call itself.
//
// ⚠️ NO NAT GATEWAY, NO ELASTIC IP, NO VPC ENDPOINT. Runners only dial out
// (GitHub, `ghcr.io`), so a public address per runner behind a no-inbound group is
// egress enough, and a NAT gateway charges per GB processed in both directions —
// at fleet scale many times the compute (the CI runner hosting comparison page,
// sections 2.3 and 9). The hourly public IPv4 charge is the accepted cost.
//
// FIND BEFORE CREATE, AT EVERY STEP, so a run that died halfway resumes: each
// resource is looked up by its tag first and created only when absent, and
// `created` names only what THIS call made. Nothing here deletes anything.

/** The tag every shard resource carries, and the adapter's discovery key. */
export const AWS_SHARD_TAG_KEY = 'motir-shard';

/** The VPC's address range when the caller names none. */
export const AWS_SHARD_VPC_CIDR = '10.40.0.0/16';

/** How many zones a shard spreads across when the caller names none. */
export const AWS_SHARD_MAX_ZONES = 3;

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

export interface EnsureAwsShardNetworkInput {
  /** The account and region to build in. Ignored when `ec2` is given. */
  readonly credentials: Omit<AwsCredentialsConfig, 'region'>;
  readonly regionId: string;
  readonly shardTag: string;
  /** The zones to use, else the region's available zones (sorted, at most three). */
  readonly zones?: readonly string[];
  /** The VPC range, `10.40.0.0/16` by default. */
  readonly vpcCidr?: string;
  /** An EC2 surface to use instead of building one from `credentials` — the test seam. */
  readonly ec2?: Ec2Api;
}

export interface AwsShardNetwork {
  readonly vpcId: string;
  readonly internetGatewayId: string;
  readonly routeTableId: string;
  readonly subnets: ReadonlyArray<{ readonly zoneId: string; readonly subnetId: string }>;
  readonly securityGroupId: string;
  /** What this call created, as `<kind>:<id>` — empty on a second call. */
  readonly created: string[];
}

interface Step {
  readonly ec2: Ec2Api;
  readonly shardTag: string;
  readonly tags: readonly Ec2Tag[];
  readonly created: string[];
}

function tagFilter(shardTag: string): Ec2Filter {
  return { name: `tag:${AWS_SHARD_TAG_KEY}`, values: [shardTag] };
}

/** The one tagged resource, none, or a refusal naming every id. */
function single<T>(step: Step, resource: string, found: T[], idOf: (t: T) => string): T | null {
  if (found.length > 1) {
    throw new AwsShardNetworkConflictError(step.shardTag, resource, found.map(idOf));
  }
  return found[0] ?? null;
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

async function resolveZones(ec2: Ec2Api, zones: readonly string[] | undefined): Promise<string[]> {
  if (zones && zones.length > 0) return [...zones].sort();
  const available = await ec2.describeAvailabilityZones([{ name: 'state', values: ['available'] }]);
  return available
    .map((z) => z.zoneName)
    .sort()
    .slice(0, AWS_SHARD_MAX_ZONES);
}

async function ensureVpc(step: Step, cidrBlock: string): Promise<string> {
  const found = single<Ec2Vpc>(
    step,
    'VPC',
    await step.ec2.describeVpcs([tagFilter(step.shardTag)]),
    (v) => v.vpcId,
  );
  if (found) return found.vpcId;
  const { vpcId } = await step.ec2.createVpc({ cidrBlock, tags: step.tags });
  step.created.push(`vpc:${vpcId}`);
  return vpcId;
}

async function ensureInternetGateway(step: Step, vpcId: string): Promise<string> {
  const found = single<Ec2InternetGateway>(
    step,
    'internet gateway',
    await step.ec2.describeInternetGateways([tagFilter(step.shardTag)]),
    (g) => g.internetGatewayId,
  );
  let internetGatewayId = found?.internetGatewayId;
  if (!internetGatewayId) {
    ({ internetGatewayId } = await step.ec2.createInternetGateway({ tags: step.tags }));
    step.created.push(`internet-gateway:${internetGatewayId}`);
  }
  // A gateway created by a run that died before attaching it is attached now.
  if (!found?.attachedVpcIds.includes(vpcId)) {
    await step.ec2.attachInternetGateway({ internetGatewayId, vpcId });
  }
  return internetGatewayId;
}

async function ensureRouteTable(
  step: Step,
  vpcId: string,
  internetGatewayId: string,
): Promise<Ec2RouteTable | { routeTableId: string; associatedSubnetIds: string[] }> {
  const found = single<Ec2RouteTable>(
    step,
    'route table',
    await step.ec2.describeRouteTables([
      tagFilter(step.shardTag),
      { name: 'vpc-id', values: [vpcId] },
    ]),
    (t) => t.routeTableId,
  );
  let routeTableId = found?.routeTableId;
  if (!routeTableId) {
    ({ routeTableId } = await step.ec2.createRouteTable({ vpcId, tags: step.tags }));
    step.created.push(`route-table:${routeTableId}`);
  }
  const hasDefaultRoute = (found?.routes ?? []).some(
    (r) => r.destinationCidrBlock === '0.0.0.0/0' && r.gatewayId === internetGatewayId,
  );
  if (!hasDefaultRoute) {
    await step.ec2.createRoute({
      routeTableId,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: internetGatewayId,
    });
    step.created.push(`route:${routeTableId}:0.0.0.0/0`);
  }
  return found ?? { routeTableId, associatedSubnetIds: [] };
}

async function ensureSubnets(
  step: Step,
  vpcId: string,
  cidrs: Map<string, string>,
): Promise<Array<{ zoneId: string; subnetId: string }>> {
  const existing = await step.ec2.describeSubnets([
    tagFilter(step.shardTag),
    { name: 'vpc-id', values: [vpcId] },
  ]);
  const subnets: Array<{ zoneId: string; subnetId: string }> = [];
  for (const [zone, cidrBlock] of cidrs) {
    const found = single<Ec2Subnet>(
      step,
      `subnet in ${zone}`,
      existing.filter((s) => s.availabilityZone === zone),
      (s) => s.subnetId,
    );
    let subnetId = found?.subnetId;
    if (!subnetId) {
      ({ subnetId } = await step.ec2.createSubnet({
        vpcId,
        cidrBlock,
        availabilityZone: zone,
        tags: step.tags,
      }));
      step.created.push(`subnet:${subnetId}`);
    }
    // Set on create, re-asserted on find: cheap, and it heals a hand-edited subnet.
    // Only a CHANGE is a call, so a second run makes none.
    if (!found?.mapPublicIpOnLaunch) {
      await step.ec2.modifySubnetAttribute({ subnetId, mapPublicIpOnLaunch: true });
    }
    subnets.push({ zoneId: zone, subnetId });
  }
  return subnets;
}

async function ensureSecurityGroup(step: Step, vpcId: string): Promise<string> {
  const found = single<Ec2SecurityGroup>(
    step,
    'security group',
    await step.ec2.describeSecurityGroups([
      tagFilter(step.shardTag),
      { name: 'vpc-id', values: [vpcId] },
    ]),
    (g) => g.groupId,
  );
  if (found) return found.groupId;
  // Created with no inbound rule, and nothing in this package ever adds one: a
  // runner is reached by nobody, it only dials out.
  const { groupId } = await step.ec2.createSecurityGroup({
    groupName: awsShardSecurityGroupName(step.shardTag),
    description: `Motir CI runners of shard ${step.shardTag}: no inbound, all outbound`,
    vpcId,
    tags: step.tags,
  });
  step.created.push(`security-group:${groupId}`);
  return groupId;
}

/**
 * Leave the region holding the shard's network, creating only what is missing.
 * A second call with the same `shardTag` creates, attaches, associates and
 * modifies nothing, and returns the same ids with `created` empty.
 */
export async function ensureAwsShardNetwork(
  input: EnsureAwsShardNetworkInput,
): Promise<AwsShardNetwork> {
  const ec2 = input.ec2 ?? createEc2Api({ ...input.credentials, region: input.regionId });
  const step: Step = {
    ec2,
    shardTag: input.shardTag,
    tags: [
      { key: AWS_SHARD_TAG_KEY, value: input.shardTag },
      { key: 'Name', value: `motir-shard-${input.shardTag}` },
    ],
    created: [],
  };
  const zones = await resolveZones(ec2, input.zones);
  if (zones.length === 0) {
    throw new Error(`No available zone in ${input.regionId} to place the shard network in.`);
  }
  const cidrs = zoneCidrs(input.vpcCidr ?? AWS_SHARD_VPC_CIDR, zones);

  const vpcId = await ensureVpc(step, input.vpcCidr ?? AWS_SHARD_VPC_CIDR);
  const internetGatewayId = await ensureInternetGateway(step, vpcId);
  const routeTable = await ensureRouteTable(step, vpcId, internetGatewayId);
  const subnets = await ensureSubnets(step, vpcId, cidrs);
  for (const { subnetId } of subnets) {
    if (routeTable.associatedSubnetIds.includes(subnetId)) continue;
    await ec2.associateRouteTable({ routeTableId: routeTable.routeTableId, subnetId });
  }
  const securityGroupId = await ensureSecurityGroup(step, vpcId);

  return {
    vpcId,
    internetGatewayId,
    routeTableId: routeTable.routeTableId,
    subnets,
    securityGroupId,
    created: step.created,
  };
}
