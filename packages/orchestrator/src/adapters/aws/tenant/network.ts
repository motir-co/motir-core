import { readTenantStackTemplate } from '../tenantStacks';
import type { TenantClients } from './clients';
import {
  NETWORK_STACK_NAME,
  SHARED_REPOSITORY_TAG,
  TAG_ORGANIZATION,
  TAG_REPOSITORY,
  type StackRunner,
} from './stackRunner';

// THE TENANT NETWORK (MOTIR-10007): `network.yaml`, applied ONCE per tenant
// account as the stack `motir-network`, tagged `motir:repository=shared` — the
// one stack that belongs to no repository. Every repository in the account
// shares it; no app or release destroy deletes it. The runner's look-before-act
// makes a second ensure, for this repository or another, a no change.
//
// It also carries the account's FRONT DOOR (MOTIR-11846): a CloudFront
// distribution whose VPC origin is the internal load balancer, the `https`
// address a container release is reached at. The load balancer admits only
// CloudFront's origin-facing servers, through the AWS-managed prefix list, whose
// id differs by region and so is looked up on every ensure, never written down.

/** The AWS-managed prefix list of CloudFront's origin-facing servers (IPv4). */
export const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST = 'com.amazonaws.global.cloudfront.origin-facing';

/** Every AWS action this module calls outside CloudFormation — unioned into the
 *  deploy role's grant beside the release modules'. */
export const AWS_NETWORK_DEPLOY_ACTIONS: readonly string[] = ['ec2:DescribeManagedPrefixLists'];

/** One tenant account, as the tenant modules work in it. */
export interface TenantAccountContext {
  readonly organizationId: string;
  readonly clients: TenantClients;
  readonly runner: StackRunner;
}

/** The network stack's outputs, as plain values. */
export interface TenantNetwork {
  readonly vpcId: string;
  readonly privateSubnetIds: readonly string[];
  readonly publicSubnetIds: readonly string[];
  readonly databaseSecurityGroupId: string;
  readonly appSecurityGroupId: string;
  readonly albArn: string;
  readonly albListenerArn: string;
  readonly albDnsName: string;
  /** The front door's CloudFront name, `<id>.cloudfront.net`. */
  readonly frontDoorDomainName: string;
  /** The front door's VPC origin, which an open container release's own
   *  distribution reaches the load balancer through (MOTIR-12128). */
  readonly frontDoorVpcOriginId: string;
}

/** A stack finished without an output its caller reads. */
export class TenantStackOutputMissingError extends Error {
  readonly code = 'AWS_TENANT_STACK_OUTPUT_MISSING' as const;
  constructor(
    readonly stackName: string,
    readonly output: string,
  ) {
    super(`Stack ${stackName} has no output ${output}.`);
    this.name = 'TenantStackOutputMissingError';
  }
}

/** The region has no AWS-managed prefix list of that name. */
export class TenantPrefixListMissingError extends Error {
  readonly code = 'AWS_TENANT_PREFIX_LIST_MISSING' as const;
  constructor(readonly prefixList: string) {
    super(`The region has no managed prefix list ${prefixList}.`);
    this.name = 'TenantPrefixListMissingError';
  }
}

/** An output of a stack, or the typed error naming it. */
export function stackOutput(
  stackName: string,
  outputs: Readonly<Record<string, string>>,
  output: string,
): string {
  const value = outputs[output];
  if (!value) throw new TenantStackOutputMissingError(stackName, output);
  return value;
}

/** The account's network, applied once. */
export async function ensureTenantNetwork(account: TenantAccountContext): Promise<TenantNetwork> {
  const prefixListId = await account.clients.ec2.managedPrefixListId(
    CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST,
  );
  if (!prefixListId) throw new TenantPrefixListMissingError(CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST);
  const { outputs } = await account.runner.applyStack({
    stackName: NETWORK_STACK_NAME,
    template: readTenantStackTemplate('network.yaml'),
    parameters: {
      OrganizationId: account.organizationId,
      CloudFrontOriginFacingPrefixListId: prefixListId,
    },
    tags: { [TAG_ORGANIZATION]: account.organizationId, [TAG_REPOSITORY]: SHARED_REPOSITORY_TAG },
  });
  const read = (output: string) => stackOutput(NETWORK_STACK_NAME, outputs, output);
  const list = (output: string) => read(output).split(',');
  return {
    vpcId: read('VpcId'),
    privateSubnetIds: list('PrivateSubnetIds'),
    publicSubnetIds: list('PublicSubnetIds'),
    databaseSecurityGroupId: read('DatabaseSecurityGroupId'),
    appSecurityGroupId: read('AppSecurityGroupId'),
    albArn: read('AlbArn'),
    albListenerArn: read('AlbListenerArn'),
    albDnsName: read('AlbDnsName'),
    frontDoorDomainName: read('FrontDoorDomainName'),
    frontDoorVpcOriginId: read('FrontDoorVpcOriginId'),
  };
}
