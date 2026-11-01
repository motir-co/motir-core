import {
  OrchestratorNotConfiguredError,
  awsManagementCredentials,
  createAwsHostingDeployPort,
  createAwsManagementApi,
  createTenantClients,
  type HostingDeployPort,
} from '@motir/orchestrator';
import { TENANT_ACCOUNT_REGION } from '@/lib/ciFleet/hostingTenantAccounts';

// The AWS hosting adapter's WIRING (Story MOTIR-9794 · MOTIR-10010), registered
// as the `aws` target by `./hosting`. Everything is read when the adapter is
// asked for, not when this module loads: the management credential (the one
// identity every tenant session is assumed from — no Motir key reaches a tenant
// account and none is stored), the forwarder's principal and the apps' domain.
// Motir's own records are reached through `awsHostingLookupService`, imported on
// the first call that needs it, so the composition root stays free of the
// database until an `aws` call is made.

/** The forwarder's IAM principal, the one identity a function URL admits. */
export const AWS_FORWARDER_PRINCIPAL_ENV = 'MOTIR_HOSTING_AWS_FORWARDER_PRINCIPAL_ARN';
/** The domain under which the forwarder names an app (`<appRef>.<domain>`). */
export const AWS_APP_DOMAIN_ENV = 'MOTIR_HOSTING_AWS_APP_DOMAIN';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OrchestratorNotConfiguredError(`set ${name}`);
  return value;
}

const lookups = () =>
  import('@/lib/services/awsHostingLookupService').then((m) => m.awsHostingLookupService);

/** The `aws` adapter, from this deployment's configuration. */
export function createConfiguredAwsHostingPort(originSecretKey: string): HostingDeployPort {
  const forwarderPrincipalArn = requiredEnv(AWS_FORWARDER_PRINCIPAL_ENV);
  const appDomain = requiredEnv(AWS_APP_DOMAIN_ENV);
  const management = createAwsManagementApi(awsManagementCredentials(process.env));
  return createAwsHostingDeployPort({
    clientsFor: ({ accountId, region }) => createTenantClients({ management, accountId, region }),
    region: TENANT_ACCOUNT_REGION,
    ensureTenantAccount: async (organizationId) =>
      (await lookups()).ensureTenantAccount(organizationId),
    organizationOf: async (repositoryId) => (await lookups()).organizationOf(repositoryId),
    isCustomerRepository: async (repositoryId) =>
      (await lookups()).isCustomerRepository(repositoryId),
    githubIdsOf: async (repositoryId) => (await lookups()).githubIdsOf(repositoryId),
    forwarderPrincipalArn,
    appHostOf: (appRef) => `${appRef}.${appDomain}`,
    originSecretKey,
    // eslint-disable-next-line no-console -- the per-step line the card asks for; names only
    log: (line) => console.info('[hosting:aws]', line),
  });
}
