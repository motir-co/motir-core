import {
  AWS_MEMBER_ROLE_NAME,
  AWS_RUNNER_IAM_ROLE,
  AWS_RUNNER_IAM_USER,
  AwsAccountCreationRefusedError,
  AwsManagementApiError,
  awsCredentialsFromEnv,
  awsAgentHosterPolicyDocument,
  awsManagementCredentials,
  awsManagementRequiredEnv,
  awsRunnerPolicyDocument,
  awsRuntimeKeyEnvNames,
  AwsStackOutputsMissingError,
  awsShardVpcExists,
  createAwsManagementApi,
  createEc2Api,
  readAwsShardNetwork,
  type AwsCredentialsConfig,
  type AwsManagementApi,
  type AwsSessionCredentials,
  type AwsShardNetwork,
  type Ec2Api,
} from '@motir/orchestrator';
import {
  FleetShardAccountRefusedError,
  FleetShardProvisioningRefusedError,
  MemberRoleAssumeFailedError,
} from '@/lib/ciFleet/errors';
import {
  AWS_POOL_DEFINITION_ENV,
  AWS_POOL_TEMPLATE_OUTPUTS,
  awsPoolDefinitionFromEnv,
  awsPoolDefinitionProblems,
  awsPoolDefinitionRequiredEnv,
  awsPoolStackOverrides,
} from '@/lib/fleetShards/awsPoolDefinition';
import type {
  ProviderStepContext,
  ShardProvisioningProvider,
} from '@/lib/fleetShards/provisioningProviders';

// THE `aws` PROVIDER OF ADD-SHARD (Story MOTIR-9270 · MOTIR-9278) — the steps
// that make one AWS Organizations member account a fleet account: the account
// (found by name, else created and waited on), its network and runner role —
// built by the pool-account definition's StackSet instance (MOTIR-9845) — its
// vCPU quota read and its runtime credential. The shared walk around it — preflight, the GitHub
// org and App, the row, the audit — is `fleetShardProvisioningService`'s.
//
// It reaches AWS only through `@motir/orchestrator`: no SDK import here.
//
// ⚠️ NO KEY IS MINTED. The member account's admin session (from assuming
// `OrganizationAccountAccessRole`) lives in memory for the run. The runner's own
// key is created by a person in the console; this provider words that step and
// later CONFIRMS, read-only, that the key a person set works.

/**
 * The INTERNAL option the unattended add-shard sets (MOTIR-9460) — never a CLI
 * flag (it is not in `options`): `role` makes the runtime credential the
 * account's `motir-fleet-runner` ROLE, assumed from the management credential,
 * in place of the person-keyed IAM user.
 */
export const AWS_RUNTIME_CREDENTIAL_OPTION = 'runtime-credential';

function runnerRoleMode(ctx: ProviderStepContext): boolean {
  return ctx.options[AWS_RUNTIME_CREDENTIAL_OPTION] === 'role';
}

/**
 * The INTERNAL option a Host organisation's own account is added with (MOTIR-9584):
 * `true` lets its runner role terminate an UNTAGGED instance anywhere in the
 * account, because the attribution pass reaps every machine on an account that
 * belongs to one organisation — not only the ones carrying the shard tag.
 */
export const AWS_REAP_UNTAGGED_OPTION = 'reap-untagged';

/**
 * Whether the account's runners may terminate untagged instances: asked for by
 * the option on the run that adds a Host account, and read from the row's role
 * on a run over an existing one (the Host reconcile passes no options), so a
 * re-run never flips the account's stack parameter back.
 */
function reapsUntagged(ctx: ProviderStepContext): boolean {
  return ctx.options[AWS_REAP_UNTAGGED_OPTION] === 'true' || ctx.shard?.role === 'org_owned';
}

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
  management: () => {
    const roleArn = process.env[AWS_POOL_DEFINITION_ENV.stackSetAdminRoleArn]?.trim();
    return createAwsManagementApi(
      awsManagementCredentials(process.env),
      roleArn ? { stackSetAdmin: { roleArn } } : {},
    );
  },
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

    // The role ARN alone is a full management credential (the default chain
    // supplies the rest); a key, once either half is set, must be whole.
    // The pool-account definition (MOTIR-9845): the StackSet, the kind's unit
    // and the quota to request, from this deployment's configuration.
    requiredEnv: (ctx) => [
      ...awsManagementRequiredEnv(deps.env()),
      ...awsPoolDefinitionRequiredEnv(ctx.fleetKind),
    ],

    validate(ctx) {
      const problems: string[] = [...awsPoolDefinitionProblems(deps.env())];
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
          throw new FleetShardAccountRefusedError(ctx.name, err.reason);
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
      let credentials: AwsSessionCredentials;
      try {
        credentials = await api().assumeMemberRole(accountId);
      } catch (err) {
        if (!runnerRoleMode(ctx) || !(err instanceof AwsManagementApiError)) throw err;
        throw new MemberRoleAssumeFailedError(accountId, AWS_MEMBER_ROLE_NAME, err.awsCode);
      }
      const account: AwsAccountState = { accountId, credentials };
      return { created, detail, account };
    },

    // The network and runner role are the pool-account definition's: the account
    // joins its kind's unit, the StackSet's instance is applied with this run's
    // parameters, and what it built is read back by tag and checked against the
    // instance's outputs. Every fact lives in AWS, so a re-run moves, creates and
    // updates nothing that is already right.
    async network(ctx) {
      const credentials = await memberCredentials(ctx);
      const accountId = accountIdOf(ctx);
      if (!accountId) {
        throw new FleetShardProvisioningRefusedError([
          `fleet account ${ctx.name} records no AWS account id`,
        ]);
      }
      const region = regionOf(ctx);
      const definition = awsPoolDefinitionFromEnv(deps.env(), ctx.fleetKind);
      const ec2 = deps.ec2({ ...credentials, region });
      const target = { stackSetName: definition.stackSetName, accountId, region };

      // A network the definition did not build — an existing account not yet
      // adopted — is refused BEFORE the move: in the unit, auto-deployment would
      // build a second network beside it.
      if (await awsShardVpcExists({ ec2, regionId: region, shardTag: ctx.name })) {
        try {
          await api().readStackInstanceOutputs(target);
        } catch (err) {
          if (err instanceof AwsStackOutputsMissingError && err.missing === 'stack instance') {
            throw new FleetShardProvisioningRefusedError([
              `AWS account ${accountId} already has a network tagged ${ctx.name} that the ` +
                `${definition.stackSetName} StackSet did not build; adopt it into the pool-account ` +
                'definition first (motir-infra `npm run adopt-pool-account`, MOTIR-9842)',
            ]);
          }
          throw err;
        }
      }

      const created: string[] = [];
      const { moved } = await api().moveAccountToOrganizationalUnit(
        accountId,
        definition.organizationalUnitId,
      );
      if (moved) created.push(`unit-membership:${definition.organizationalUnitId}`);
      const { action } = await api().ensureStackInstance({
        ...target,
        organizationalUnitId: definition.organizationalUnitId,
        parameterOverrides: awsPoolStackOverrides({
          shardName: ctx.name,
          fleetKind: ctx.fleetKind,
          reapUntagged: reapsUntagged(ctx),
          requestedVcpuQuota: definition.requestedVcpuQuota,
        }),
      });
      if (action !== 'none') {
        created.push(
          `stack-instance:${definition.stackSetName}/${accountId}/${region} (${action})`,
        );
      }

      const outputs = await api().readStackInstanceOutputs(target);
      const network = await readAwsShardNetwork({ ec2, regionId: region, shardTag: ctx.name });
      checkNetworkAgainstOutputs(ctx.name, network, outputs);
      const detail =
        `vpc ${network.vpcId}, subnets ${network.subnets.map((s) => s.subnetId).join(', ')}, ` +
        `security group ${network.securityGroupId}`;
      return { created, detail };
    },

    async readQuota(ctx) {
      const vcpuQuota = await api().readVcpuQuota(await memberCredentials(ctx), regionOf(ctx));
      return { vcpuQuota };
    },

    async runtimeCredential(ctx) {
      if (runnerRoleMode(ctx)) {
        // No key at all: the definition's stack built `motir-fleet-runner`, which
        // trusts the management role, and the orchestrator assumes it (MOTIR-9460).
        // Confirmed by assuming it once; IAM propagation may make that wait.
        const accountId = accountIdOf(ctx);
        if (!accountId) return { created: [], confirmed: false };
        try {
          await api().assumeRunnerRole(accountId);
          return { created: [], confirmed: true };
        } catch {
          return { created: [], confirmed: false };
        }
      }
      const credentials = await memberCredentials(ctx);
      const region = regionOf(ctx);
      // An agent-hoster account's instances persist — hibernate, wake, rewrite
      // their config, delete their disk — so its key carries those calls too.
      const policy =
        ctx.fleetKind === 'agent_instance' ? awsAgentHosterPolicyDocument : awsRunnerPolicyDocument;
      const { created } = await api().ensureRunnerIamUser(
        credentials,
        ctx.fleetKind === 'agent_instance'
          ? policy({ shardTag: ctx.name, regionId: region })
          : awsRunnerPolicyDocument({
              shardTag: ctx.name,
              regionId: region,
              // The attribution pass reaps untagged VMs on an indexer account (MOTIR-9450).
              reapUntagged: ctx.fleetKind === 'code_graph_index',
            }),
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
      if (runnerRoleMode(ctx)) {
        return (
          `the role ${AWS_RUNNER_IAM_ROLE} in AWS account ${accountId} could not be assumed yet ` +
          '(IAM propagates within minutes); the next growth pass resumes this account'
        );
      }
      return (
        `create an access key for the IAM user ${AWS_RUNNER_IAM_USER} in AWS account ${accountId} ` +
        `(IAM console → Users → ${AWS_RUNNER_IAM_USER} → Security credentials → Create access key), ` +
        `then run: flyctl secrets set -a motir-core ${names.accessKeyId}=… ${names.secretAccessKey}=…`
      );
    },
  };
}

/**
 * Refuse when the network found by tag is not the one the stack instance built:
 * every id output must match the tagged resource, subnet for subnet by zone.
 */
function checkNetworkAgainstOutputs(
  shardTag: string,
  network: AwsShardNetwork,
  outputs: Readonly<Record<string, string>>,
): void {
  const names = AWS_POOL_TEMPLATE_OUTPUTS;
  const problems: string[] = [];
  const compare = (resource: string, output: string, found: string | undefined) => {
    const built = outputs[output];
    if (built === undefined) problems.push(`the stack instance has no ${output} output`);
    else if (built !== found) {
      problems.push(
        `${resource}: the stack built ${built}, the ${shardTag} tag finds ${found ?? 'none'}`,
      );
    }
  };
  compare('VPC', names.vpcId, network.vpcId);
  compare('internet gateway', names.internetGatewayId, network.internetGatewayId);
  compare('route table', names.routeTableId, network.routeTableId);
  compare('security group', names.securityGroupId, network.securityGroupId);
  const subnetOutputs = Object.keys(outputs).filter((key) => names.subnetIdPattern.test(key));
  if (subnetOutputs.length === 0) problems.push('the stack instance has no SubnetId output');
  for (const output of subnetOutputs) {
    const letter = names.subnetIdPattern.exec(output)?.[1]?.toLowerCase();
    const zone = network.subnets.find((s) => s.zoneId.endsWith(letter ?? ''));
    compare(`subnet in zone ${letter}`, output, zone?.subnetId);
  }
  for (const { zoneId, subnetId } of network.subnets) {
    const output = `SubnetId${zoneId.slice(-1).toUpperCase()}`;
    if (!subnetOutputs.includes(output)) {
      problems.push(
        `subnet ${subnetId} in ${zoneId} carries the tag but the stack did not build it`,
      );
    }
  }
  if (problems.length > 0) {
    throw new FleetShardProvisioningRefusedError(
      problems.map((p) => `AWS shard network ${shardTag}: ${p}`),
    );
  }
}

/** The registered `aws` provider. */
export const awsShardProvisioningProvider = createAwsShardProvisioningProvider();
