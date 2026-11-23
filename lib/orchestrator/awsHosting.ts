import {
  OrchestratorNotConfiguredError,
  awsManagementCredentials,
  createAwsHostingDeployPort,
  createAwsManagementApi,
  createTenantClients,
  createTenantHandover,
  createTenantMemberIam,
  type AwsHostingDeployPort,
  type AwsManagementApi,
  type OpenUpstreamResult,
  type ReleaseHandle,
  type TenantHandover,
} from '@motir/orchestrator';
import { TENANT_ACCOUNT_REGION } from '@/lib/ciFleet/hostingTenantAccounts';

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

/** The `aws` adapter, from this deployment's configuration. */
export function createConfiguredAwsHostingPort(originSecretKey: string): AwsHostingDeployPort {
  const forwarderPrincipalArn = requiredEnv(AWS_FORWARDER_PRINCIPAL_ENV);
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
    // The takeover's `openUpstream` reaches a `handing_over` account through
    // this alone; `ensureTenantAccount` keeps answering it not ready (MOTIR-12131).
    handoverAccountOf: async (organizationId) =>
      (await lookups()).handoverAccountOf(organizationId),
    forwarderPrincipalArn,
    originSecretKey,
    // eslint-disable-next-line no-console -- the per-step line the card asks for; names only
    log: (line) => console.info('[hosting:aws]', line),
  });
}

/** What the takeover handover reaches AWS through (MOTIR-12131): the tenant
 *  account calls, the management account's email, readiness and removal calls,
 *  and the adapter's `openUpstream`. */
export interface ConfiguredAwsHandover {
  readonly handover: TenantHandover;
  readonly management: AwsManagementApi;
  openUpstream(handle: ReleaseHandle): Promise<OpenUpstreamResult>;
}

/** The AWS account id in an IAM role ARN (`arn:aws:iam::<id>:role/<name>`). */
export function accountIdOfRoleArn(roleArn: string): string {
  const id = /^arn:aws[a-z-]*:iam::(\d{12}):/.exec(roleArn)?.[1];
  if (!id) throw new OrchestratorNotConfiguredError('the management role ARN names no account');
  return id;
}

/** The handover's AWS reach, from this deployment's configuration. The
 *  management account is the one the management role lives in: the handover
 *  strips its principals from every trust in the leaving account. */
export function createConfiguredAwsHandover(originSecretKey: string): ConfiguredAwsHandover {
  const credentials = awsManagementCredentials(process.env);
  const management = createAwsManagementApi(credentials);
  const handover = createTenantHandover({
    clientsFor: ({ accountId, region }) => createTenantClients({ management, accountId, region }),
    memberIamFor: ({ accountId, region }) =>
      createTenantMemberIam({ management, accountId, region }),
    region: TENANT_ACCOUNT_REGION,
    managementAccountId: accountIdOfRoleArn(credentials.roleArn),
    // eslint-disable-next-line no-console -- the per-step line; names only
    options: { log: (line) => console.info('[hosting:aws-handover]', line) },
  });
  const port = createConfiguredAwsHostingPort(originSecretKey);
  return { handover, management, openUpstream: (handle) => port.openUpstream(handle) };
}
