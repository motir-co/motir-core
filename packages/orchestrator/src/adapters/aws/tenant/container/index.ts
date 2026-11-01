import { createHash } from 'node:crypto';
import { IdlePolicyUnsupportedError } from '../../../../hosting/errors';
import { deriveOriginSecret } from '../../../../hosting/originSecret';
import type {
  HostingEnvironment,
  ReleaseEnvVar,
  ReleaseIdlePolicy,
  ReleaseRuntime,
  ReleaseSize,
  ReleaseState,
  ReleaseUsage,
} from '../../../../hosting/types';
import { awsContainerSize } from '../../../../hosting/usage';
import { readTenantStackTemplate } from '../../tenantStacks';
import type { EnvironmentDatabaseReference } from '../database';
import { ReleaseVariableInvalidError } from '../function/errors';
import { stackOutput, type TenantAccountContext, type TenantNetwork } from '../network';
import {
  releaseConfigHash,
  replaceMarkerLine,
  yamlString,
  type ReleaseVariableSplit,
} from '../releaseTemplate';
import { NETWORK_STACK_NAME, TAG_ORGANIZATION, TAG_REPOSITORY } from '../stackRunner';
import type { TenantEcsTask } from './ecsClient';
import {
  ContainerRolloutFailedError,
  ContainerRolloutTimeoutError,
  NoPreviousTaskDefinitionError,
} from './errors';
import {
  containerReleaseNames,
  fargateTaskUnits,
  taskDefinitionRevision,
  type ContainerReleaseNames,
} from './names';
import { accrueStoppedTasks, parseAccrual, windowUsage, type UsageAccrual } from './usage';

// THE CONTAINER SHAPE (MOTIR-10009, to MOTIR-5769 §4 "AWS containers"): a
// release is the ECS Fargate service `mh-<rid>` / `mh-<rid>-pr<n>` behind the
// tenant network's ONE load balancer, reached through a listener rule that
// matches the app's host AND its `X-Motir-Origin-Secret`.
//
// The release stack (`container-release.yaml`, `motir-release-<appRef>`) owns the
// cluster, service, task definition, target group, listener rule and the
// environment secret. This module applies it, and touches ECS directly only to
// move the service between revisions (a rollback, and the reconcile after a
// deploy) and to read tasks and target health.
//
// A deploy, in order:
//   1. a suspend idle policy is refused before any call — a container is always on;
//   2. the stack exists — a first apply with an empty ConfigHash runs no task;
//   3. the secret variables are put as the secret version the hash names (each
//      task `secrets` entry reads that version, so a revision keeps its values);
//   4. the usage of tasks stopped so far is accrued, then the stack is applied
//      with the hash, registering a revision when anything changed;
//   5. the service is moved to the stack's revision if a rollback left it on
//      another, and the module waits for the rollout and a healthy target;
//   6. the tasks the rollout stopped are accrued.
//
// The previous release is the newest revision of the family below the STACK's
// (the one deployed); a rollback moves the service there and is idempotent.

export * from './ecsClient';
export * from './errors';
export * from './names';
export * from './usage';

/** The lines of `container-release.yaml` the release's variables replace. */
export const CONTAINER_VARIABLES_MARKER = '# <release variables>';
export const CONTAINER_SECRETS_MARKER = '# <release secrets>';

/** The variables the template sets itself. */
export const CONTAINER_TEMPLATE_VARIABLES = ['PORT', 'MOTIR_ENVIRONMENT'] as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RULE_PRIORITY = 50_000;
const ROLLOUT_TIMEOUT_MS = 30 * 60_000;
const ROLLOUT_POLL_MS = 10_000;

export interface ContainerReleaseTarget {
  readonly account: TenantAccountContext;
  readonly repositoryId: string;
  readonly environment: HostingEnvironment;
  /** The rollout wait's clock; real time when absent. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export interface DeployContainerReleaseInput extends ContainerReleaseTarget {
  /** The image, from `registryImageReference`, by digest. */
  readonly imageUri: string;
  readonly idle: ReleaseIdlePolicy;
  /** Production's size; a preview runs at the fixed preview size. */
  readonly size?: ReleaseSize;
  readonly runtime: Pick<ReleaseRuntime, 'port' | 'healthCheck'>;
  readonly env: readonly ReleaseEnvVar[];
  readonly network: Pick<
    TenantNetwork,
    'vpcId' | 'privateSubnetIds' | 'appSecurityGroupId' | 'albListenerArn' | 'albDnsName'
  >;
  /** The host the listener rule matches. */
  readonly appHost: string;
  /** The key the app's origin secret is derived from (`deriveOriginSecret`). */
  readonly originSecretKey: string;
  /** The environment's database secret, passed by ARN only. */
  readonly database?: EnvironmentDatabaseReference | null;
}

/** A deployed or rolled-back release, as plain data. A task definition
 *  revision's ARN is the release's id. */
export interface ContainerRelease {
  readonly appRef: string;
  readonly stackName: string;
  readonly releaseId: string;
  /** The load balancer, reached with the app's host and its origin secret. */
  readonly upstreamAddress: string;
  readonly liveTaskDefinition: string;
  readonly previousTaskDefinition: string | null;
}

export interface ContainerReleaseDescription {
  readonly state: Extract<ReleaseState, 'deploying' | 'healthy' | 'unhealthy' | 'destroyed'>;
  readonly releaseId: string | null;
  readonly previousReleaseId: string | null;
  readonly upstreamAddress: string | null;
  readonly originCredential: 'origin_secret' | 'none';
}

export interface ContainerUsageInput extends ContainerReleaseTarget {
  /** The release the usage is reported against. */
  readonly releaseId: string;
}

const clock = (target: ContainerReleaseTarget) => target.now ?? (() => new Date());
const upstreamOf = (albDnsName: string) => `http://${albDnsName}`;
const tagsOf = (account: TenantAccountContext, repositoryId: string) => ({
  [TAG_ORGANIZATION]: account.organizationId,
  [TAG_REPOSITORY]: repositoryId,
});

/** The release's variables: plain ones as task `environment`, secret ones as
 *  task `secrets`. A name no task can carry is refused, by name only. */
export function splitContainerVariables(
  variables: readonly ReleaseEnvVar[],
  hasDatabase: boolean,
): ReleaseVariableSplit {
  const owned: readonly string[] = [
    ...CONTAINER_TEMPLATE_VARIABLES,
    ...(hasDatabase ? ['DATABASE_URL'] : []),
  ];
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const v of variables) {
    if (!NAME.test(v.name)) throw new ReleaseVariableInvalidError(v.name, 'is not a variable name');
    if (v.name in plain || v.name in secret) {
      throw new ReleaseVariableInvalidError(v.name, 'is given twice');
    }
    if (owned.includes(v.name)) {
      throw new ReleaseVariableInvalidError(v.name, 'is set by the release itself');
    }
    (v.secret ? secret : plain)[v.name] = v.value;
  }
  return { plain, secret };
}

/** The template with the release's variables written in at the markers. A
 *  secret entry reads its key of the environment secret at the version the
 *  stack's ConfigHash names. */
export function renderContainerTemplate(template: string, split: ReleaseVariableSplit): string {
  const names = (record: Readonly<Record<string, string>>) => Object.keys(record).sort();
  const withPlain = replaceMarkerLine(
    template,
    CONTAINER_VARIABLES_MARKER,
    names(split.plain).map((n) => `- { Name: ${n}, Value: ${yamlString(split.plain[n]!)} }`),
  );
  return replaceMarkerLine(
    withPlain,
    CONTAINER_SECRETS_MARKER,
    names(split.secret).map(
      (n) => `- { Name: ${n}, ValueFrom: !Sub '\${EnvironmentSecret}:${n}::\${ConfigHash}' }`,
    ),
  );
}

/** A free priority on the shared listener, starting from one the app's name
 *  picks, so apps rarely probe. */
export function pickRulePriority(appRef: string, taken: readonly number[]): number {
  const used = new Set(taken);
  const start =
    (parseInt(createHash('sha256').update(appRef).digest('hex').slice(0, 8), 16) %
      MAX_RULE_PRIORITY) +
    1;
  for (let i = 0; i < MAX_RULE_PRIORITY; i += 1) {
    const priority = ((start - 1 + i) % MAX_RULE_PRIORITY) + 1;
    if (!used.has(priority)) return priority;
  }
  throw new ContainerRolloutFailedError('listener rule', appRef);
}

/** The revision a rollback restores: the newest below the stack's. */
function rollbackTarget(revisions: readonly string[], stackRevision: string): string | null {
  const stack = taskDefinitionRevision(stackRevision);
  const below = revisions.filter((arn) => taskDefinitionRevision(arn) < stack);
  return below.length > 0 ? below[below.length - 1]! : null;
}

/** The revision a rollback would restore from `live`: below the stack's while
 *  the stack's is live, the stack's own after a rollback. */
function previousOf(revisions: readonly string[], live: string, stackRevision: string) {
  return live === stackRevision ? rollbackTarget(revisions, stackRevision) : stackRevision;
}

/** Wait until the service runs `taskDefinition`, rolled out, with a healthy target. */
async function waitForRollout(
  target: ContainerReleaseTarget,
  names: ContainerReleaseNames,
  targetGroupArn: string,
  taskDefinition: string,
  operation: string,
): Promise<void> {
  const { ecs, elb } = target.account.clients;
  const now = clock(target);
  const sleep = target.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now().getTime() + (target.timeoutMs ?? ROLLOUT_TIMEOUT_MS);
  for (;;) {
    const service = await ecs.describeService(names.cluster, names.service);
    if (!service) throw new ContainerRolloutFailedError(operation, names.service);
    const primary = service.deployments.find((d) => d.status === 'PRIMARY');
    if (primary?.rolloutState === 'FAILED') {
      throw new ContainerRolloutFailedError(operation, names.service);
    }
    const rolledOut =
      service.taskDefinition === taskDefinition &&
      primary?.taskDefinition === taskDefinition &&
      primary.rolloutState === 'COMPLETED' &&
      service.deployments.length === 1 &&
      service.runningCount >= service.desiredCount;
    if (rolledOut && (await elb.describeTargetHealth(targetGroupArn)).includes('healthy')) return;
    if (now().getTime() >= deadline) {
      throw new ContainerRolloutTimeoutError(operation, names.service);
    }
    await sleep(target.pollMs ?? ROLLOUT_POLL_MS);
  }
}

/** Accrue the stopped tasks still listed; answers the accrual and the tasks. */
async function sweep(
  target: ContainerReleaseTarget,
  names: ContainerReleaseNames,
): Promise<{ accrual: UsageAccrual; tasks: TenantEcsTask[] }> {
  const { ecs, ssm } = target.account.clients;
  const tasks = await ecs.listTasks(names.cluster, names.service);
  const held = parseAccrual(await ssm.getParameter(names.usageParameter));
  const { accrual, changed } = accrueStoppedTasks(held, tasks);
  if (changed) {
    await ssm.putParameter(
      names.usageParameter,
      JSON.stringify(accrual),
      tagsOf(target.account, target.repositoryId),
    );
  }
  return { accrual, tasks };
}

/** Deploy the release; repeating it with the same input is a no change. */
export async function deployContainerRelease(
  input: DeployContainerReleaseInput,
): Promise<ContainerRelease> {
  if (input.idle.mode !== 'always_on') {
    throw new IdlePolicyUnsupportedError('aws', 'container', input.idle.mode);
  }
  const { account, repositoryId, environment } = input;
  const names = containerReleaseNames(repositoryId, environment);
  const { stackName, appRef } = names;
  const split = splitContainerVariables(input.env, Boolean(input.database));
  const configHash = releaseConfigHash(split);
  const template = renderContainerTemplate(
    readTenantStackTemplate('container-release.yaml'),
    split,
  );
  const units = fargateTaskUnits(awsContainerSize(input.size, environment));

  const existing = await account.runner.describeStack(stackName);
  const priority =
    existing?.parameters['ListenerRulePriority'] ??
    String(
      pickRulePriority(
        appRef,
        await account.clients.elb.listRulePriorities(input.network.albListenerArn),
      ),
    );
  const parameters = (hash: string) => ({
    OrganizationId: account.organizationId,
    RepositoryId: repositoryId,
    AppRef: appRef,
    Environment: environment.kind,
    ImageUri: input.imageUri,
    IdlePolicy: 'always_on',
    TaskCpu: units.cpu,
    TaskMemory: units.memory,
    Port: String(input.runtime.port),
    HealthCheckPath: input.runtime.healthCheck.path,
    VpcId: input.network.vpcId,
    PrivateSubnetIds: input.network.privateSubnetIds.join(','),
    AppSecurityGroupId: input.network.appSecurityGroupId,
    AlbListenerArn: input.network.albListenerArn,
    ListenerRulePriority: priority,
    AppHost: input.appHost,
    OriginSecret: deriveOriginSecret(input.originSecretKey, appRef),
    DatabaseSecretArn: input.database?.secretArn ?? '',
    ConfigHash: hash,
  });
  const apply = (hash: string) =>
    account.runner.applyStack({
      stackName,
      template,
      parameters: parameters(hash),
      tags: tagsOf(account, repositoryId),
    });

  // The stack and its environment secret; unpublished only until it has finished once.
  let outputs = existing?.outputs ?? {};
  if (!outputs['EnvironmentSecretArn']) outputs = (await apply('')).outputs;
  await account.clients.secretsManager.putSecretValue(
    stackOutput(stackName, outputs, 'EnvironmentSecretArn'),
    JSON.stringify(split.secret),
    configHash,
  );

  await sweep(input, names);
  const published = (await apply(configHash)).outputs;
  const live = stackOutput(stackName, published, 'TaskDefinitionArn');
  const targetGroupArn = stackOutput(stackName, published, 'TargetGroupArn');

  const { ecs } = account.clients;
  const service = await ecs.describeService(names.cluster, names.service);
  if (service && service.taskDefinition !== live) {
    await ecs.updateService(names.cluster, names.service, live);
  }
  await waitForRollout(input, names, targetGroupArn, live, 'deploy');
  await sweep(input, names);
  const revisions = await ecs.listTaskDefinitions(names.family);
  return {
    appRef,
    stackName,
    releaseId: live,
    upstreamAddress: upstreamOf(input.network.albDnsName),
    liveTaskDefinition: live,
    previousTaskDefinition: rollbackTarget(revisions, live),
  };
}

const DESTROYED: ContainerReleaseDescription = {
  state: 'destroyed',
  releaseId: null,
  previousReleaseId: null,
  upstreamAddress: null,
  originCredential: 'none',
};

/** The release's state, from its stack, its service and its target health. */
export async function describeContainerRelease(
  target: ContainerReleaseTarget,
): Promise<ContainerReleaseDescription> {
  const names = containerReleaseNames(target.repositoryId, target.environment);
  const { runner, clients } = target.account;
  const stack = await runner.describeStack(names.stackName);
  if (!stack || stack.status.startsWith('DELETE_IN_PROGRESS')) return DESTROYED;
  const network = await runner.describeStack(NETWORK_STACK_NAME);
  const albDnsName = network?.outputs['AlbDnsName'];
  const address = albDnsName
    ? { upstreamAddress: upstreamOf(albDnsName), originCredential: 'origin_secret' as const }
    : { upstreamAddress: null, originCredential: 'none' as const };
  const stackRevision = stack.outputs['TaskDefinitionArn'];
  const failed = stack.status.endsWith('_FAILED') || stack.status === 'ROLLBACK_COMPLETE';
  const service = stackRevision
    ? await clients.ecs.describeService(names.cluster, names.service)
    : null;
  if (failed || !stackRevision || !service || service.desiredCount === 0) {
    return {
      state: failed || (stackRevision && !service) ? 'unhealthy' : 'deploying',
      releaseId: null,
      previousReleaseId: null,
      ...address,
    };
  }
  const live = service.taskDefinition;
  const revisions = await clients.ecs.listTaskDefinitions(names.family);
  const primary = service.deployments.find((d) => d.status === 'PRIMARY');
  let state: ContainerReleaseDescription['state'];
  if (primary?.rolloutState === 'FAILED') state = 'unhealthy';
  else if (
    stack.status.endsWith('_IN_PROGRESS') ||
    primary?.rolloutState !== 'COMPLETED' ||
    service.deployments.length > 1
  ) {
    state = 'deploying';
  } else {
    const health = await clients.elb.describeTargetHealth(
      stackOutput(names.stackName, stack.outputs, 'TargetGroupArn'),
    );
    state = health.includes('healthy')
      ? 'healthy'
      : health.length > 0 && health.every((h) => h === 'initial')
        ? 'deploying'
        : 'unhealthy';
  }
  return {
    state,
    releaseId: live,
    previousReleaseId: previousOf(revisions, live, stackRevision),
    ...address,
  };
}

/** Move the service to the revision below the stack's — no image, no new
 *  revision — and wait for it to be healthy. Repeating it changes nothing. */
export async function rollbackContainerRelease(
  target: ContainerReleaseTarget,
): Promise<ContainerRelease> {
  const names = containerReleaseNames(target.repositoryId, target.environment);
  const { runner, clients } = target.account;
  const stack = await runner.describeStack(names.stackName);
  const stackRevision = stack?.outputs['TaskDefinitionArn'];
  if (!stack || !stackRevision) throw new NoPreviousTaskDefinitionError(names.service);
  const revisions = await clients.ecs.listTaskDefinitions(names.family);
  const previous = rollbackTarget(revisions, stackRevision);
  if (!previous) throw new NoPreviousTaskDefinitionError(names.service);

  const service = await clients.ecs.describeService(names.cluster, names.service);
  if (!service) throw new ContainerRolloutFailedError('rollback', names.service);
  await sweep(target, names);
  if (service.taskDefinition !== previous) {
    await clients.ecs.updateService(names.cluster, names.service, previous);
  }
  await waitForRollout(
    target,
    names,
    stackOutput(names.stackName, stack.outputs, 'TargetGroupArn'),
    previous,
    'rollback',
  );
  await sweep(target, names);
  const network = await runner.describeStack(NETWORK_STACK_NAME);
  return {
    appRef: names.appRef,
    stackName: names.stackName,
    releaseId: previous,
    upstreamAddress: upstreamOf(
      stackOutput(NETWORK_STACK_NAME, network?.outputs ?? {}, 'AlbDnsName'),
    ),
    liveTaskDefinition: previous,
    previousTaskDefinition: stackRevision,
  };
}

function usageRecord(
  input: ContainerUsageInput,
  appRef: string,
  since: Date,
  until: Date,
  totals: { vcpuSeconds: number; gbSeconds: number },
): ReleaseUsage {
  return {
    target: 'aws',
    appRef,
    releaseId: input.releaseId,
    since,
    until,
    runningSeconds: Math.max(0, Math.floor((until.getTime() - since.getTime()) / 1000)),
    compute: { unit: 'fargate', ...totals },
  };
}

/** vCPU-seconds and GB-seconds of the environment's tasks from `since` until now. */
export async function containerUsageSince(
  input: ContainerUsageInput & { readonly since: Date },
): Promise<ReleaseUsage> {
  const names = containerReleaseNames(input.repositoryId, input.environment);
  const until = clock(input)();
  const { accrual, tasks } = await sweep(input, names);
  return usageRecord(
    input,
    names.appRef,
    input.since,
    until,
    windowUsage(accrual, tasks, input.since, until),
  );
}

/**
 * Destroy the release, returning its usage from the stack's creation until now.
 * The usage is measured FIRST and recorded in the accrual as the final total;
 * then the stack goes, then the parameter. A destroy replayed after the stack is
 * gone still returns the recorded total; an absent release returns zero.
 */
export async function destroyContainerRelease(input: ContainerUsageInput): Promise<ReleaseUsage> {
  const names = containerReleaseNames(input.repositoryId, input.environment);
  const { runner, clients } = input.account;
  const until = clock(input)();
  let final = parseAccrual(await clients.ssm.getParameter(names.usageParameter)).final;
  if (!final) {
    const stack = await runner.describeStack(names.stackName);
    if (!stack) {
      return usageRecord(input, names.appRef, until, until, { vcpuSeconds: 0, gbSeconds: 0 });
    }
    const since = stack.createdAt ?? until;
    const { accrual, tasks } = await sweep(input, names);
    final = {
      ...windowUsage(accrual, tasks, since, until),
      sinceMs: since.getTime(),
      untilMs: until.getTime(),
    };
    await clients.ssm.putParameter(
      names.usageParameter,
      JSON.stringify({ ...accrual, final }),
      tagsOf(input.account, input.repositoryId),
    );
  }
  await runner.deleteStack(names.stackName);
  // The revisions the stack retained would otherwise outlive it, and a later
  // release of the same name would take one for its rollback target.
  for (const arn of await clients.ecs.listTaskDefinitions(names.family)) {
    await clients.ecs.deregisterTaskDefinition(arn);
  }
  try {
    await clients.ssm.deleteParameter(names.usageParameter);
  } catch (err) {
    // A delete whose answer was lost but which landed is a finished delete.
    if ((await clients.ssm.getParameter(names.usageParameter)) !== null) throw err;
  }
  return usageRecord(input, names.appRef, new Date(final.sinceMs), new Date(final.untilMs), {
    vcpuSeconds: final.vcpuSeconds,
    gbSeconds: final.gbSeconds,
  });
}

/** Every AWS action this module and its stack need — unioned into the deploy
 *  role's grant by the deploy-role permissions card. */
export const AWS_CONTAINER_DEPLOY_ACTIONS: readonly string[] = [
  // Called by this module.
  'ecs:DescribeServices',
  'ecs:UpdateService',
  'ecs:ListTaskDefinitions',
  'ecs:DeregisterTaskDefinition',
  'ecs:ListTasks',
  'ecs:DescribeTasks',
  'elasticloadbalancing:DescribeTargetHealth',
  'elasticloadbalancing:DescribeRules',
  'secretsmanager:PutSecretValue',
  'ssm:GetParameter',
  'ssm:PutParameter',
  'ssm:AddTagsToResource',
  'ssm:DeleteParameter',
  // The release stack's resources, through CloudFormation.
  'ecs:CreateCluster',
  'ecs:DeleteCluster',
  'ecs:DescribeClusters',
  'ecs:RegisterTaskDefinition',
  'ecs:DescribeTaskDefinition',
  'ecs:CreateService',
  'ecs:DeleteService',
  'ecs:TagResource',
  'ecs:UntagResource',
  'ecs:ListTagsForResource',
  'elasticloadbalancing:CreateTargetGroup',
  'elasticloadbalancing:DeleteTargetGroup',
  'elasticloadbalancing:ModifyTargetGroup',
  'elasticloadbalancing:ModifyTargetGroupAttributes',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetGroupAttributes',
  'elasticloadbalancing:CreateRule',
  'elasticloadbalancing:DeleteRule',
  'elasticloadbalancing:ModifyRule',
  'elasticloadbalancing:SetRulePriorities',
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:AddTags',
  'elasticloadbalancing:RemoveTags',
  'elasticloadbalancing:DescribeTags',
  'ec2:DescribeSecurityGroups',
  'ec2:DescribeSubnets',
  'ec2:DescribeVpcs',
  'iam:CreateRole',
  'iam:DeleteRole',
  'iam:GetRole',
  'iam:PassRole',
  'iam:PutRolePolicy',
  'iam:GetRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:TagRole',
  'iam:UntagRole',
  'iam:ListRolePolicies',
  'iam:ListAttachedRolePolicies',
  'logs:CreateLogGroup',
  'logs:DeleteLogGroup',
  'logs:DescribeLogGroups',
  'logs:PutRetentionPolicy',
  'logs:TagResource',
  'logs:UntagResource',
  'logs:ListTagsForResource',
  'secretsmanager:CreateSecret',
  'secretsmanager:DeleteSecret',
  'secretsmanager:DescribeSecret',
  'secretsmanager:UpdateSecret',
  'secretsmanager:TagResource',
  'secretsmanager:UntagResource',
];
