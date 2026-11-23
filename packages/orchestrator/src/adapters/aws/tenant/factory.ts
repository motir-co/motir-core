import type { AwsManagementApi } from '../management';
import type { TenantClients } from './clients';
import {
  createTenantSdkClient,
  sdkTenantCloudFormation,
  sdkTenantCloudWatch,
  sdkTenantEc2,
  sdkTenantEcs,
  sdkTenantElb,
  sdkTenantIam,
  sdkTenantLambda,
  sdkTenantRdsData,
  sdkTenantSecretsManager,
  sdkTenantSsm,
  type TenantSdkClientFactory,
} from './sdk';
import { tenantDeploySession, tenantMemberSession } from './session';
import type { TenantIam } from './clients';
import { awsTenantClientsOverride } from '../testOverrides';

// The ASSUMED-ROLE CLIENT FACTORY (MOTIR-10004): every client of a tenant
// account, built on the account's deploy-role session and nothing else. The
// region is the caller's (the adapter passes the tenant account's); this package
// reads no environment.

export interface TenantClientsOptions {
  readonly management: Pick<AwsManagementApi, 'assumeTenantDeployRole'>;
  readonly accountId: string;
  readonly region: string;
  readonly sdkClientFactory?: TenantSdkClientFactory;
  readonly now?: () => number;
}

/** One tenant account's clients, all under its deploy role. */
export function createTenantClients(options: TenantClientsOptions): TenantClients {
  // An E2E lane's fake, when one is installed (MOTIR-12141) — see `testOverrides.ts`.
  const override = awsTenantClientsOverride();
  if (override) return override.clients({ accountId: options.accountId, region: options.region });
  const factory = options.sdkClientFactory ?? createTenantSdkClient;
  const credentials = tenantDeploySession({
    management: options.management,
    accountId: options.accountId,
    ...(options.now ? { now: options.now } : {}),
  });
  const config = { region: options.region, credentials };
  return {
    accountId: options.accountId,
    region: options.region,
    cloudformation: sdkTenantCloudFormation(factory('cloudformation', config)),
    rdsData: sdkTenantRdsData(factory('rds-data', config)),
    secretsManager: sdkTenantSecretsManager(factory('secretsmanager', config)),
    lambda: sdkTenantLambda(factory('lambda', config)),
    cloudwatch: sdkTenantCloudWatch(factory('cloudwatch', config)),
    ecs: sdkTenantEcs(factory('ecs', config)),
    elb: sdkTenantElb(factory('elasticloadbalancing', config)),
    ssm: sdkTenantSsm(factory('ssm', config)),
    ec2: sdkTenantEc2(factory('ec2', config)),
    // IAM is global: its endpoint answers whatever the region.
    iam: sdkTenantIam(factory('iam', config)),
  };
}

export interface TenantMemberIamOptions {
  readonly management: Pick<AwsManagementApi, 'assumeMemberRole'>;
  readonly accountId: string;
  readonly region: string;
  readonly sdkClientFactory?: TenantSdkClientFactory;
  readonly now?: () => number;
}

/** The account's IAM on its MEMBER ACCESS ROLE (MOTIR-12130): the one session
 *  that can delete `motir-tenant-deploy` and then strip itself, which the deploy
 *  role can never do (its policy denies it every action on itself). A new call
 *  is a new session — how the handover tells a role it has closed. */
export function createTenantMemberIam(options: TenantMemberIamOptions): TenantIam {
  const override = awsTenantClientsOverride();
  if (override) return override.memberIam({ accountId: options.accountId, region: options.region });
  const factory = options.sdkClientFactory ?? createTenantSdkClient;
  const credentials = tenantMemberSession({
    management: options.management,
    accountId: options.accountId,
    ...(options.now ? { now: options.now } : {}),
  });
  return sdkTenantIam(factory('iam', { region: options.region, credentials }));
}

/** Builds a tenant account's clients — what the adapter is given, and what a
 *  test replaces with the fake. */
export type TenantClientsFactory = (target: { accountId: string; region: string }) => TenantClients;
