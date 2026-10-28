import {
  awsManagementCredentials,
  createAwsManagementApi,
  createEc2Api,
  type AwsManagementApi,
} from '@motir/orchestrator';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import { hostingTenantAccountPlan } from '@/lib/ciFleet/hostingTenantAccounts';
import {
  AWS_RUNTIME_CREDENTIAL_OPTION,
  createAwsShardProvisioningProvider,
} from '@/lib/fleetShards/awsProvisioningProvider';
import {
  AWS_MEMBER_EMAIL_TEMPLATE_ENV,
  memberEmailTemplateProblems,
} from '@/lib/fleetShards/awsMemberAccountPlan';
import type { ProviderStepContext } from '@/lib/fleetShards/provisioningProviders';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// MAKE AN ORGANISATION'S TENANT AWS ACCOUNT EXIST (Story MOTIR-9792 · MOTIR-9940)
// — `tenant-<org>` in Motir's AWS Organization, under the `Tenants` OU, its
// account id and OU id on the organisation's `hosting_tenant_account` row.
//
// It reuses add-shard's `aws` provider `account` step (find by name, else wait on
// an earlier run's CreateAccount, else file one, then assume the member access
// role) and NOTHING else of add-shard: its walk writes a `fleet_shard` row and
// installs a GitHub App, which a tenant account never has.
//
// Every step reads before it writes, in an order a cut-off pass resumes from: the
// OU, the account, the record, the move. A replay recomputes the same name, finds
// the account, records the same ids and finds it already in the OU.
//
// It sets no `state`, records no refusal and raises no alert — AWS refusing
// CreateAccount surfaces as `FleetShardAccountRefusedError` for the reconcile to
// record. The member session the provider step assumed is dropped here; nothing
// returned or stored carries a credential or the member email, and it logs nothing.

export interface TenantAccountProvisioningDeps {
  /** The management API, from this deployment's management credential. */
  management?: AwsManagementApi;
  /** Where the member email template and the management credential are read. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface TenantAccountProvisioningResult {
  accountId: string;
  ouId: string;
  /** Whether this call made (or waited on) the account. */
  created: boolean;
  /** Whether this call moved the account into the OU. */
  moved: boolean;
}

export async function createOrFindTenantAccount(
  organizationId: string,
  deps: TenantAccountProvisioningDeps = {},
): Promise<TenantAccountProvisioningResult> {
  const env = deps.env ?? process.env;
  let management: AwsManagementApi | null = deps.management ?? null;
  const api = () => (management ??= createAwsManagementApi(awsManagementCredentials(env)));
  const provider = createAwsShardProvisioningProvider({
    management: api,
    // Only the `account` step runs; the EC2 seam is never reached.
    ec2: (config) => createEc2Api(config),
    env: () => env,
  });

  const template = env[AWS_MEMBER_EMAIL_TEMPLATE_ENV];
  const plan = hostingTenantAccountPlan(organizationId, template);
  const ctx: ProviderStepContext = {
    name: plan.name,
    fleetKind: 'tenant',
    region: plan.region,
    options: {
      'account-email': plan.memberEmail ?? '',
      [AWS_RUNTIME_CREDENTIAL_OPTION]: 'role',
    },
    credentialRef: '',
  };

  // Preflight, before any AWS call.
  const problems = memberEmailTemplateProblems(template);
  const missing = provider.requiredEnv(ctx).filter((name) => !env[name]?.trim());
  if (missing.length > 0) problems.push(`set ${missing.join(', ')}`);
  if (problems.length > 0) throw new FleetShardProvisioningRefusedError(problems);

  const record = await withSystemContext((tx) =>
    hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
  );

  const { ouId } = await api().ensureOrganizationalUnit(plan.ouName);

  const step = await provider.account(ctx);
  // The provider's answer carries the member session too; keep only the id.
  const accountId = (step.account as { accountId: string }).accountId;

  if (record?.awsAccountId && record.awsAccountId !== accountId) {
    throw new FleetShardProvisioningRefusedError([
      `${plan.name} is recorded on AWS account ${record.awsAccountId}, but the organization's ` +
        `account of that name is ${accountId}; the record is not overwritten`,
    ]);
  }

  if (record?.awsAccountId !== accountId || record?.ouId !== ouId) {
    await withSystemContext(async (tx) => {
      await hostingTenantAccountRepository.ensureRequestedInTx(organizationId, plan.region, tx);
      await hostingTenantAccountRepository.recordAccountInTx(organizationId, accountId, ouId, tx);
    });
  }

  const { moved } = await api().moveAccountToOu(accountId, ouId);
  return { accountId, ouId, created: step.created, moved };
}
