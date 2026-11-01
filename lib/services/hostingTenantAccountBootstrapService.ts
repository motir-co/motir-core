import {
  awsManagementCredentials,
  createAwsManagementApi,
  type AwsManagementApi,
} from '@motir/orchestrator';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import {
  TENANT_ACCOUNT_REGION,
  TENANT_ORGANIZATION_TAG_KEY,
  TENANT_QUOTA_TARGETS,
  tenantDeployPolicyDocument,
} from '@/lib/ciFleet/hostingTenantAccounts';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// BOOTSTRAP A TENANT AWS ACCOUNT (Story MOTIR-9792 · MOTIR-9941) — once
// `createOrFindTenantAccount` has recorded the account id, make three things
// true inside it, each read before it is written so a replay does nothing twice:
//
//   1. the `motir-tenant-deploy` role, trusted only by Motir's management role,
//      its inline policy converged on `tenantDeployPolicyDocument()`;
//   2. `motir:organization=<id>` on the account in Organizations, for cost
//      allocation;
//   3. each `TENANT_QUOTA_TARGETS` quota at target, or a raise filed (an open
//      raise is pending, which does not block — the adapter reads the applied
//      value when it needs it).
//
// The member access role of the account Motir's own Organization created is the
// only role assumed; its session stays in memory and is dropped. It sets no
// record state, records no refusal and raises no alert — the reconcile does —
// and nothing returned carries a credential or the member email (it never
// derives one).

export interface TenantAccountBootstrapDeps {
  /** The management API, from this deployment's management credential. */
  management?: AwsManagementApi;
}

export interface TenantAccountBootstrapResult {
  /** Whether this call created the deploy role. */
  roleCreated: boolean;
  /** Whether this call wrote the organisation tag. */
  tagged: boolean;
  /** Quota raises this call filed. */
  quotaRaisesFiled: number;
  /** Quotas still below target with a raise open (filed now or earlier). */
  quotaRaisesPending: number;
}

/** The member session of the organisation's recorded account, and the account. */
async function memberSession(organizationId: string, management: AwsManagementApi) {
  const record = await withSystemContext((tx) =>
    hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
  );
  const accountId = record?.awsAccountId;
  if (!accountId) {
    throw new FleetShardProvisioningRefusedError([
      `organisation ${organizationId} has no tenant AWS account recorded yet`,
    ]);
  }
  return { accountId, credentials: await management.assumeMemberRole(accountId) };
}

function managementOf(deps: TenantAccountBootstrapDeps): AwsManagementApi {
  return deps.management ?? createAwsManagementApi(awsManagementCredentials(process.env));
}

export async function bootstrapTenantAccount(
  organizationId: string,
  deps: TenantAccountBootstrapDeps = {},
): Promise<TenantAccountBootstrapResult> {
  const management = managementOf(deps);
  const { accountId, credentials } = await memberSession(organizationId, management);
  const { created: roleCreated } = await management.ensureTenantDeployRole(
    credentials,
    tenantDeployPolicyDocument(),
  );
  const { tagged } = await management.ensureAccountTag(
    accountId,
    TENANT_ORGANIZATION_TAG_KEY,
    organizationId,
  );
  let quotaRaisesFiled = 0;
  let quotaRaisesPending = 0;
  for (const target of TENANT_QUOTA_TARGETS) {
    const raise = await management.ensureQuotaRaise(credentials, TENANT_ACCOUNT_REGION, target);
    if (raise.filed) quotaRaisesFiled += 1;
    if (raise.pending) quotaRaisesPending += 1;
  }
  return { roleCreated, tagged, quotaRaisesFiled, quotaRaisesPending };
}

/** What converging one account's deploy-role policy did. */
export interface TenantDeployPolicyConvergence {
  /** Whether the live inline policy differed and was rewritten. */
  policyChanged: boolean;
}

/**
 * Bring an existing tenant account's deploy role onto today's
 * `tenantDeployPolicyDocument()` (MOTIR-10005). A `ready` account never re-runs
 * the bootstrap, so a policy change reaches it only through this: assume the
 * member role and make the same `ensureTenantDeployRole` call, which reads the
 * inline policy and writes it only when it differs. Writes no record state, and
 * a replay changes nothing.
 */
export async function convergeTenantDeployPolicy(
  organizationId: string,
  deps: TenantAccountBootstrapDeps = {},
): Promise<TenantDeployPolicyConvergence> {
  const management = managementOf(deps);
  const { credentials } = await memberSession(organizationId, management);
  const { policyChanged } = await management.ensureTenantDeployRole(
    credentials,
    tenantDeployPolicyDocument(),
  );
  return { policyChanged };
}
