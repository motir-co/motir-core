import type { AwsManagementApi } from '../management';
import type { TenantClients } from './clients';
import {
  createTenantSdkClient,
  sdkTenantCloudFormation,
  sdkTenantCloudWatch,
  sdkTenantEcs,
  sdkTenantElb,
  sdkTenantLambda,
  sdkTenantRdsData,
  sdkTenantSecretsManager,
  sdkTenantSsm,
  type TenantSdkClientFactory,
} from './sdk';
import { tenantDeploySession } from './session';

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
  };
}

/** Builds a tenant account's clients — what the adapter is given, and what a
 *  test replaces with the fake. */
export type TenantClientsFactory = (target: { accountId: string; region: string }) => TenantClients;
