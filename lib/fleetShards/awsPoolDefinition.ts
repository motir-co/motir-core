import { OrchestratorNotConfiguredError } from '@motir/orchestrator';

// THE POOL-ACCOUNT DEFINITION, AS ADD-SHARD SEES IT (MOTIR-9845). A new AWS
// fleet account is built by the pool-account StackSet (motir-infra), not by
// code: add-shard moves the account into its fleet kind's organisational unit
// and applies the StackSet's instance with this run's parameters. Which
// StackSet, which unit and which role the StackSet calls run on are this
// deployment's configuration, read here from the env — never literals.
//
// The parameter and output names are the template's contract
// (motir-infra `lib/pool-account/stack.ts`, `POOL_TEMPLATE_PARAMETERS` and
// `POOL_TEMPLATE_OUTPUTS`): a rename there is a rename here.

type Env = Readonly<Record<string, string | undefined>>;

export const AWS_POOL_DEFINITION_ENV = {
  stackSetName: 'AWS_POOL_STACK_SET_NAME',
  requestedVcpuQuota: 'AWS_POOL_REQUESTED_VCPU_QUOTA',
  /** Optional: the services account's StackSet-operator role. Unset, the
   *  StackSet calls run on the default credential chain (core's task role). */
  stackSetAdminRoleArn: 'AWS_POOL_STACK_SET_ADMIN_ROLE_ARN',
} as const;

/** The variable holding a fleet kind's unit id: `AWS_POOL_UNIT_ID_<KIND>`. */
export function awsPoolUnitEnvName(fleetKind: string): string {
  return `AWS_POOL_UNIT_ID_${fleetKind.toUpperCase()}`;
}

/** The template's parameters, as a stack instance overrides them. */
export const AWS_POOL_TEMPLATE_PARAMETERS = {
  shardTag: 'ShardTag',
  runnerPolicy: 'RunnerPolicy',
  reapUntagged: 'ReapUntagged',
  requestedVcpuQuota: 'RequestedVcpuQuota',
} as const;

/** The template's outputs a fleet account is checked against. */
export const AWS_POOL_TEMPLATE_OUTPUTS = {
  vpcId: 'VpcId',
  internetGatewayId: 'InternetGatewayId',
  routeTableId: 'RouteTableId',
  securityGroupId: 'SecurityGroupId',
  runnerRoleArn: 'RunnerRoleArn',
  /** `SubnetId<Zone letter>`, one per zone: `SubnetIdA` for `eu-west-1a`. */
  subnetIdPattern: /^SubnetId([A-Z])$/,
} as const;

export interface AwsPoolDefinition {
  stackSetName: string;
  organizationalUnitId: string;
  /** Null: the StackSet calls run on the default credential chain. */
  stackSetAdminRoleArn: string | null;
  requestedVcpuQuota: number;
}

function read(env: Env, name: string): string {
  return env[name]?.trim() ?? '';
}

/** Every variable a run for `fleetKind` needs set, optional ones left out. */
export function awsPoolDefinitionRequiredEnv(fleetKind: string): string[] {
  return [
    AWS_POOL_DEFINITION_ENV.stackSetName,
    awsPoolUnitEnvName(fleetKind),
    AWS_POOL_DEFINITION_ENV.requestedVcpuQuota,
  ];
}

/** What is wrong with the values that ARE set; empty when they are valid. */
export function awsPoolDefinitionProblems(env: Env): string[] {
  const quota = read(env, AWS_POOL_DEFINITION_ENV.requestedVcpuQuota);
  const problems: string[] = [];
  if (quota && !/^[1-9]\d*$/.test(quota)) {
    problems.push(
      `${AWS_POOL_DEFINITION_ENV.requestedVcpuQuota} must be a whole number of vCPUs, got ${quota}`,
    );
  }
  const roleArn = read(env, AWS_POOL_DEFINITION_ENV.stackSetAdminRoleArn);
  if (roleArn && !/^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/.test(roleArn)) {
    problems.push(`${AWS_POOL_DEFINITION_ENV.stackSetAdminRoleArn} is not an IAM role ARN`);
  }
  return problems;
}

/** The definition a run for `fleetKind` applies; refuses naming every missing variable. */
export function awsPoolDefinitionFromEnv(env: Env, fleetKind: string): AwsPoolDefinition {
  const missing = awsPoolDefinitionRequiredEnv(fleetKind).filter((name) => !read(env, name));
  if (missing.length > 0) throw new OrchestratorNotConfiguredError(`set ${missing.join(', ')}`);
  const problems = awsPoolDefinitionProblems(env);
  if (problems.length > 0) throw new OrchestratorNotConfiguredError(problems.join('; '));
  return {
    stackSetName: read(env, AWS_POOL_DEFINITION_ENV.stackSetName),
    organizationalUnitId: read(env, awsPoolUnitEnvName(fleetKind)),
    stackSetAdminRoleArn: read(env, AWS_POOL_DEFINITION_ENV.stackSetAdminRoleArn) || null,
    requestedVcpuQuota: Number(read(env, AWS_POOL_DEFINITION_ENV.requestedVcpuQuota)),
  };
}

/**
 * The parameter overrides a fleet account's stack instance carries — the one
 * place the runner-policy variant and `ReapUntagged` are decided.
 *
 * `agent_instance` accounts host persistent instances (hibernate, wake, rewrite
 * their config, delete their disk), so their runners take the hoster policy. An
 * account reaps untagged instances when asked to (a Host organisation's own
 * account) or when it is an indexer account, whose attribution pass reaps
 * untagged VMs (MOTIR-9450).
 */
export function awsPoolStackOverrides(input: {
  shardName: string;
  fleetKind: string;
  reapUntagged: boolean;
  requestedVcpuQuota: number;
}): Record<string, string> {
  const names = AWS_POOL_TEMPLATE_PARAMETERS;
  return {
    [names.shardTag]: input.shardName,
    [names.runnerPolicy]: input.fleetKind === 'agent_instance' ? 'hoster' : 'runner',
    [names.reapUntagged]: String(input.reapUntagged || input.fleetKind === 'code_graph_index'),
    [names.requestedVcpuQuota]: String(input.requestedVcpuQuota),
  };
}
