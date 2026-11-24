import {
  OrchestratorNotConfiguredError,
  awsManagementCredentials,
  createAwsDatabaseUsageReader,
  createAwsHostingDeployPort,
  createAwsManagementApi,
  createFakeAwsDatabaseUsageReader,
  createTenantClients,
  type AwsDatabaseUsageReader,
  type HostingDeployPort,
  type TenantClientsFactory,
} from '@motir/orchestrator';
import { TENANT_ACCOUNT_REGION } from '@/lib/ciFleet/hostingTenantAccounts';
import { selectedOrchestratorProvider } from './provider';

// The AWS hosting adapter's WIRING (Story MOTIR-9794 · MOTIR-10010), registered
// as the `aws` target by `./hosting`. Everything is read when the adapter is
// asked for, not when this module loads: the management credential (the one
// identity every tenant session is assumed from — no Motir key reaches a tenant
// account and none is stored) and the forwarder's principal. There is no apps
// domain (MOTIR-11846): a container release is reached at its tenant network's
// front door and picked by its origin secret alone, so no host is named for it.
// Motir's own records are reached through `awsHostingLookupService`, imported on
// the first call that needs it, so the composition root stays free of the
// database until an `aws` call is made.

/** The forwarder's IAM principal, the one identity a function URL admits. */
export const AWS_FORWARDER_PRINCIPAL_ENV = 'MOTIR_HOSTING_AWS_FORWARDER_PRINCIPAL_ARN';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OrchestratorNotConfiguredError(`set ${name}`);
  return value;
}

const lookups = () =>
  import('@/lib/services/awsHostingLookupService').then((m) => m.awsHostingLookupService);

/** Tenant clients under each account's deploy role, assumed from the
 *  management credential — the one identity no tenant account stores. */
function tenantClientsFactory(): TenantClientsFactory {
  const management = createAwsManagementApi(awsManagementCredentials(process.env));
  return ({ accountId, region }) => createTenantClients({ management, accountId, region });
}

/** The lookups both AWS readers ask Motir's records through. */
const tenantAccountLookups = {
  ensureTenantAccount: async (organizationId: string) =>
    (await lookups()).ensureTenantAccount(organizationId),
  organizationOf: async (repositoryId: string) => (await lookups()).organizationOf(repositoryId),
};

/** The `aws` adapter, from this deployment's configuration. */
export function createConfiguredAwsHostingPort(originSecretKey: string): HostingDeployPort {
  const forwarderPrincipalArn = requiredEnv(AWS_FORWARDER_PRINCIPAL_ENV);
  return createAwsHostingDeployPort({
    clientsFor: tenantClientsFactory(),
    region: TENANT_ACCOUNT_REGION,
    ...tenantAccountLookups,
    isCustomerRepository: async (repositoryId) =>
      (await lookups()).isCustomerRepository(repositoryId),
    githubIdsOf: async (repositoryId) => (await lookups()).githubIdsOf(repositoryId),
    forwarderPrincipalArn,
    originSecretKey,
    // eslint-disable-next-line no-console -- the per-step line the card asks for; names only
    log: (line) => console.info('[hosting:aws]', line),
  });
}

let fakeDatabaseUsage: AwsDatabaseUsageReader | null = null;

/**
 * The usage read of an AWS application's production database — its Aurora
 * cluster in the tenant account (MOTIR-12191). The cluster is the AWS hosting
 * adapter's, not the database port's, so it is read here, over the same
 * management credential and lookups. The fake (one per process, measuring
 * nothing) while `MOTIR_FLEET_ORCHESTRATOR=fake`.
 */
export function getAwsDatabaseUsageReader(): AwsDatabaseUsageReader {
  if (selectedOrchestratorProvider() === 'fake') {
    fakeDatabaseUsage ??= createFakeAwsDatabaseUsageReader();
    return fakeDatabaseUsage;
  }
  return createAwsDatabaseUsageReader({
    clientsFor: tenantClientsFactory(),
    region: TENANT_ACCOUNT_REGION,
    ...tenantAccountLookups,
  });
}
