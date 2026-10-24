import {
  AWS_MANAGEMENT_ENV,
  AWS_RUNNER_IAM_USER,
  AwsAccountCreationRefusedError,
  awsCredentialsFromEnv,
  awsManagementCredentials,
  awsRunnerPolicyDocument,
  awsRuntimeKeyEnvNames,
  createAwsManagementApi,
  createEc2Api,
  ensureAwsShardNetwork,
  type AwsCredentialsConfig,
  type AwsManagementApi,
  type AwsSessionCredentials,
  type Ec2Api,
} from '@motir/orchestrator';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import type {
  ProviderStepContext,
  ShardProvisioningProvider,
} from '@/lib/fleetShards/provisioningProviders';

// THE `aws` PROVIDER OF ADD-SHARD (Story MOTIR-9270 · MOTIR-9278) — the steps
// that make one AWS Organizations member account a fleet account: the account
// (found by name, else created and waited on), its network, its vCPU quota read
// and its runner IAM user. The shared walk around it — preflight, the GitHub
// org and App, the row, the audit — is `fleetShardProvisioningService`'s.
//
// It reaches AWS only through `@motir/orchestrator`: no SDK import here.
//
// ⚠️ NO KEY IS MINTED. The member account's admin session (from assuming
// `OrganizationAccountAccessRole`) lives in memory for the run. The runner's own
// key is created by a person in the console; this provider words that step and
// later CONFIRMS, read-only, that the key a person set works.

/** Where a fleet account boots when `--region` is not given. */
export const AWS_DEFAULT_REGION = 'us-east-1';

const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What the account step hands the later steps, in memory only. */
interface AwsAccountState {
  accountId: string;
  credentials: AwsSessionCredentials;
}

export interface AwsProvisioningDeps {
  /** The management API, from this deployment's management credential. */
  management(): AwsManagementApi;
  /** An EC2 surface for a credential and region. */
  ec2(config: AwsCredentialsConfig): Ec2Api;
  /** Where the runtime key is read from. */
  env(): Readonly<Record<string, string | undefined>>;
}

const defaultDeps: AwsProvisioningDeps = {
  management: () => createAwsManagementApi(awsManagementCredentials(process.env)),
  ec2: (config) => createEc2Api(config),
  env: () => process.env,
};

function regionOf(ctx: ProviderStepContext): string {
  return ctx.region.trim() || AWS_DEFAULT_REGION;
}

function accountStateOf(ctx: ProviderStepContext): AwsAccountState | null {
  const state = ctx.account as AwsAccountState | undefined;
  return state && typeof state.accountId === 'string' ? state : null;
}

function accountIdOf(ctx: ProviderStepContext): string | null {
  return accountStateOf(ctx)?.accountId ?? ctx.shard?.aws?.accountId ?? null;
}

/** The `aws` provider over `deps` — the default reaches real AWS. */
export function createAwsShardProvisioningProvider(
  deps: AwsProvisioningDeps = defaultDeps,
): ShardProvisioningProvider {
  let management: AwsManagementApi | null = null;
  const api = () => (management ??= deps.management());

  /** The member account's admin session: this run's, or — on `refresh-limits`,
   *  which runs no account step — assumed again from the row's account id. */
  async function memberCredentials(ctx: ProviderStepContext): Promise<AwsSessionCredentials> {
    const state = accountStateOf(ctx);
    if (state) return state.credentials;
    const accountId = ctx.shard?.aws?.accountId;
    if (!accountId) {
      throw new FleetShardProvisioningRefusedError([
        `fleet account ${ctx.name} records no AWS account id`,
      ]);
    }
    return api().assumeMemberRole(accountId);
  }

  return {
    name: 'aws',
    options: [
      {
        name: 'account-email',
        description:
          'the root email of the AWS member account, required only when the account must be created',
        required: false,
      },
    ],

    requiredEnv: () => Object.values(AWS_MANAGEMENT_ENV),

    validate(ctx) {
      const problems: string[] = [];
      if (!REGION_PATTERN.test(regionOf(ctx))) {
        problems.push(
          `--region ${ctx.region} is not an AWS region id (e.g. ${AWS_DEFAULT_REGION})`,
        );
      }
      const email = ctx.options['account-email'];
      if (email !== undefined && !EMAIL_PATTERN.test(email)) {
        problems.push(`--account-email ${email} is not an email address`);
      }
      return problems;
    },

    location: (ctx) => ({
      provider: 'aws',
      awsAccountId: accountIdOf(ctx),
      awsRegion: regionOf(ctx),
    }),

    matchesRow: (shard, ctx) => shard.provider === 'aws' && shard.aws?.region === regionOf(ctx),

    async account(ctx) {
      const lookup = await api().findOrganizationAccount(ctx.name);
      let accountId: string;
      let created = false;
      let detail: string;
      try {
        if (lookup.account) {
          accountId = lookup.account.accountId;
          detail = `AWS account ${accountId} (${ctx.name}) found`;
        } else if (lookup.inProgressRequestId) {
          // An earlier run filed it: wait on that request, never file a second.
          accountId = (await api().waitForCreateAccount(lookup.inProgressRequestId, ctx.name))
            .accountId;
          created = true;
          detail = `waited on the CreateAccount an earlier run filed; AWS account ${accountId}`;
        } else {
          const email = ctx.options['account-email'];
          if (!email) {
            throw new FleetShardProvisioningRefusedError([
              `no AWS account is named ${ctx.name}; pass --account-email <email> to create it`,
            ]);
          }
          accountId = (await api().createOrganizationAccount({ name: ctx.name, email })).accountId;
          created = true;
          detail = `created AWS account ${accountId} (${ctx.name})`;
        }
      } catch (err) {
        if (err instanceof AwsAccountCreationRefusedError) {
          throw new FleetShardProvisioningRefusedError([
            `AWS refused to create the account ${ctx.name}: ${err.reason}`,
          ]);
        }
        throw err;
      }
      const recorded = ctx.shard?.aws?.accountId;
      if (recorded && recorded !== accountId) {
        throw new FleetShardProvisioningRefusedError([
          `--name ${ctx.name} is recorded on AWS account ${recorded}, but the organization's ` +
            `account of that name is ${accountId}; pick another name`,
        ]);
      }
      const credentials = await api().assumeMemberRole(accountId);
      const account: AwsAccountState = { accountId, credentials };
      return { created, detail, account };
    },

    async network(ctx) {
      const credentials = await memberCredentials(ctx);
      const region = regionOf(ctx);
      const network = await ensureAwsShardNetwork({
        credentials,
        regionId: region,
        shardTag: ctx.name,
        ec2: deps.ec2({ ...credentials, region }),
      });
      return { created: network.created };
    },

    async readQuota(ctx) {
      const vcpuQuota = await api().readVcpuQuota(await memberCredentials(ctx), regionOf(ctx));
      return { vcpuQuota };
    },

    async runtimeCredential(ctx) {
      const credentials = await memberCredentials(ctx);
      const region = regionOf(ctx);
      const { created } = await api().ensureRunnerIamUser(
        credentials,
        awsRunnerPolicyDocument({ shardTag: ctx.name, regionId: region }),
      );
      const key = awsCredentialsFromEnv(ctx.credentialRef, deps.env());
      if (!key) return { created, confirmed: false };
      try {
        // Read-only, with the person-set key itself: proves it resolves and works.
        await deps.ec2({ ...key, region }).describeInstances({ maxResults: 5 });
        return { created, confirmed: true };
      } catch {
        return { created, confirmed: false };
      }
    },

    manualCredentialStep(ctx) {
      const names = awsRuntimeKeyEnvNames(ctx.credentialRef);
      const accountId = accountIdOf(ctx) ?? '(the account)';
      return (
        `create an access key for the IAM user ${AWS_RUNNER_IAM_USER} in AWS account ${accountId} ` +
        `(IAM console → Users → ${AWS_RUNNER_IAM_USER} → Security credentials → Create access key), ` +
        `then run: flyctl secrets set -a motir-core ${names.accessKeyId}=… ${names.secretAccessKey}=…`
      );
    },
  };
}

/** The registered `aws` provider. */
export const awsShardProvisioningProvider = createAwsShardProvisioningProvider();
