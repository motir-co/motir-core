import { hostingAppNames } from '../../../../hosting/names';
import type {
  HostingEnvironment,
  ReleaseEnvVar,
  ReleaseIdlePolicy,
  ReleaseRuntime,
  ReleaseState,
  ReleaseUsage,
} from '../../../../hosting/types';
import { readTenantStackTemplate } from '../../tenantStacks';
import type { EnvironmentDatabaseReference } from '../database';
import { AwsTenantApiError } from '../errors';
import { stackOutput, type TenantAccountContext, type TenantNetwork } from '../network';
import { TAG_ORGANIZATION, TAG_REPOSITORY } from '../stackRunner';
import {
  releaseConfigHash,
  renderFunctionTemplate,
  splitReleaseVariables,
  type ReleaseVariableSplit,
} from './environment';
import { FunctionUsageReadError, NoPreviousFunctionVersionError } from './errors';
import { FUNCTION_DURATION_METRIC, functionComputeUsage } from './usage';

// THE FUNCTION SHAPE (MOTIR-10008, to MOTIR-5769 §4 "AWS functions"): a release
// is the Lambda function `mh-<rid>` / `mh-<rid>-pr<n>`, running the image through
// the AWS Lambda Web Adapter in the tenant VPC, with a version per release behind
// the alias `live` and an IAM-auth function URL only the forwarder may invoke.
//
// The release stack (`function-release.yaml`, `motir-release-<appRef>`) owns the
// function, its versions, the alias, the URL, provisioned concurrency and the
// environment secret. This module applies it and touches Lambda directly only to
// move the alias (a rollback, and the reconcile after every deploy) — so a deploy
// is one idempotent stack apply plus one alias check, and a deploy replayed
// after a cut-off at any call ends in the same single stack and version.
//
// A deploy, in order:
//   1. the stack exists — a first apply with an empty ConfigHash creates the
//      function and its environment secret UNPUBLISHED (no version, alias or URL);
//   2. the secret variables are put as the secret version named by the hash of
//      every variable, so each published version reads its own release's values
//      (a rollback restores them with the code);
//   3. the stack is applied with that hash, which publishes a version when the
//      image or any variable changed and moves `live` to it;
//   4. `live` is put on the stack's version even when the apply changed nothing,
//      so a deploy after a rollback makes the stack's release live again.
//
// The PREVIOUS version needs no state of its own: while `live` is the newest
// version, it is the newest one below it; after a rollback `live` is older than
// the newest, and the newest — the release the rollback replaced — is the one a
// further rollback restores.

export * from './lambdaClient';
export * from './environment';
export * from './usage';
export * from './errors';

/** The alias the function URL and provisioned concurrency hang off. */
export const LIVE_ALIAS = 'live';

/** What a release's identity is built from. */
export interface FunctionReleaseTarget {
  readonly account: TenantAccountContext;
  readonly repositoryId: string;
  readonly environment: HostingEnvironment;
}

export interface DeployFunctionReleaseInput extends FunctionReleaseTarget {
  /** The image, from `registryImageReference`, by digest. */
  readonly imageUri: string;
  readonly idle: ReleaseIdlePolicy;
  readonly runtime: Pick<ReleaseRuntime, 'port' | 'healthCheck'>;
  readonly env: readonly ReleaseEnvVar[];
  readonly network: Pick<TenantNetwork, 'privateSubnetIds' | 'appSecurityGroupId'>;
  /** The forwarder's IAM principal, the only one that may invoke the URL. */
  readonly invokePrincipalArn: string;
  /** The environment's database secret, passed by ARN only. */
  readonly database?: EnvironmentDatabaseReference | null;
}

/** A deployed or rolled-back release, as plain data. A version is the
 *  release's id. */
export interface FunctionRelease {
  readonly appRef: string;
  readonly stackName: string;
  readonly releaseId: string;
  /** The function URL (`AuthType AWS_IAM`). */
  readonly upstreamAddress: string;
  readonly liveVersion: string;
  readonly previousVersion: string | null;
}

export interface FunctionReleaseDescription {
  readonly state: Extract<ReleaseState, 'deploying' | 'healthy' | 'unhealthy' | 'destroyed'>;
  readonly releaseId: string | null;
  readonly previousReleaseId: string | null;
  readonly upstreamAddress: string | null;
  readonly originCredential: 'aws_sigv4' | 'none';
}

export interface FunctionUsageInput extends FunctionReleaseTarget {
  /** The release the usage is reported against. */
  readonly releaseId: string;
  readonly now?: () => Date;
}

/** The function's name and its stack's (the templates README). */
export function functionReleaseNames(
  repositoryId: string,
  environment: HostingEnvironment,
): { appRef: string; stackName: string } {
  const { appRef } = hostingAppNames('mh-', repositoryId, environment);
  return { appRef, stackName: `motir-release-${appRef}` };
}

/** The version a rollback would restore, from the versions and `live`. */
export function previousFunctionVersion(
  versions: readonly string[],
  live: string | null,
): string | null {
  const numbers = versions.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (live === null || numbers.length === 0) return null;
  const current = Number(live);
  const newest = Math.max(...numbers);
  if (current < newest) return String(newest);
  const below = numbers.filter((n) => n < current);
  return below.length > 0 ? String(Math.max(...below)) : null;
}

function releaseTags(account: TenantAccountContext, repositoryId: string) {
  return { [TAG_ORGANIZATION]: account.organizationId, [TAG_REPOSITORY]: repositoryId };
}

/** Deploy the release; repeating it with the same input is a no change. */
export async function deployFunctionRelease(
  input: DeployFunctionReleaseInput,
): Promise<FunctionRelease> {
  const { account, repositoryId, environment } = input;
  const { appRef, stackName } = functionReleaseNames(repositoryId, environment);
  const databaseSecretArn = input.database?.secretArn ?? '';
  const fixed = {
    AWS_LWA_PORT: String(input.runtime.port),
    AWS_LWA_READINESS_CHECK_PATH: input.runtime.healthCheck.path,
    MOTIR_ENVIRONMENT: environment.kind,
    MOTIR_ENVIRONMENT_SECRET_VERSION: 'x'.repeat(64),
    MOTIR_DATABASE_SECRET_ARN: databaseSecretArn,
  };
  const split: ReleaseVariableSplit = splitReleaseVariables(input.env, fixed);
  const configHash = releaseConfigHash(split);
  const template = renderFunctionTemplate(
    readTenantStackTemplate('function-release.yaml'),
    split.plain,
  );
  const parameters = (hash: string) => ({
    OrganizationId: account.organizationId,
    RepositoryId: repositoryId,
    AppRef: appRef,
    Environment: environment.kind,
    ImageUri: input.imageUri,
    IdlePolicy: input.idle.mode,
    Port: String(input.runtime.port),
    HealthCheckPath: input.runtime.healthCheck.path,
    PrivateSubnetIds: input.network.privateSubnetIds.join(','),
    AppSecurityGroupId: input.network.appSecurityGroupId,
    DatabaseSecretArn: databaseSecretArn,
    ConfigHash: hash,
    InvokePrincipalArn: input.invokePrincipalArn,
  });
  const apply = (hash: string) =>
    account.runner.applyStack({
      stackName,
      template,
      parameters: parameters(hash),
      tags: releaseTags(account, repositoryId),
    });

  // 1. The stack and its environment secret — created unpublished only when the
  // stack has never finished; a published stack is never taken back.
  let outputs = (await account.runner.describeStack(stackName))?.outputs ?? {};
  if (!outputs['EnvironmentSecretArn']) outputs = (await apply('')).outputs;
  const secretArn = stackOutput(stackName, outputs, 'EnvironmentSecretArn');

  // 2. The secret variables, as the version the hash names.
  await account.clients.secretsManager.putSecretValue(
    secretArn,
    JSON.stringify(split.secret),
    configHash,
  );

  // 3. Publish.
  const published = (await apply(configHash)).outputs;
  const liveVersion = stackOutput(stackName, published, 'LiveVersion');
  const upstreamAddress = stackOutput(stackName, published, 'FunctionUrl');

  // 4. `live` on the stack's version, whatever a rollback did to it.
  const { lambda } = account.clients;
  if ((await lambda.getAlias(appRef, LIVE_ALIAS)) !== liveVersion) {
    await lambda.updateAlias(appRef, LIVE_ALIAS, liveVersion);
  }
  const versions = await lambda.listVersions(appRef);
  return {
    appRef,
    stackName,
    releaseId: liveVersion,
    upstreamAddress,
    liveVersion,
    previousVersion: previousFunctionVersion(versions, liveVersion),
  };
}

const DESTROYED: FunctionReleaseDescription = {
  state: 'destroyed',
  releaseId: null,
  previousReleaseId: null,
  upstreamAddress: null,
  originCredential: 'none',
};

/** The release's state, from its stack and its `live` version. */
export async function describeFunctionRelease(
  target: FunctionReleaseTarget,
): Promise<FunctionReleaseDescription> {
  const { appRef, stackName } = functionReleaseNames(target.repositoryId, target.environment);
  const stack = await target.account.runner.describeStack(stackName);
  if (!stack || stack.status.startsWith('DELETE_IN_PROGRESS')) return DESTROYED;
  const url = stack.outputs['FunctionUrl'] ?? null;
  const address = {
    upstreamAddress: url,
    originCredential: url ? ('aws_sigv4' as const) : ('none' as const),
  };
  const failed = stack.status.endsWith('_FAILED') || stack.status === 'ROLLBACK_COMPLETE';
  if (failed || !stack.outputs['LiveVersion']) {
    return {
      state: failed ? 'unhealthy' : 'deploying',
      releaseId: null,
      previousReleaseId: null,
      ...address,
    };
  }
  const { lambda } = target.account.clients;
  const live = (await lambda.getAlias(appRef, LIVE_ALIAS)) ?? stack.outputs['LiveVersion'];
  const versions = await lambda.listVersions(appRef);
  let state: FunctionReleaseDescription['state'];
  if (stack.status.endsWith('_IN_PROGRESS')) {
    state = 'deploying';
  } else {
    const version = await lambda.getFunctionState(appRef, live);
    state =
      version === 'active' || version === 'inactive'
        ? 'healthy'
        : version === 'pending'
          ? 'deploying'
          : 'unhealthy';
  }
  return {
    state,
    releaseId: live,
    previousReleaseId: previousFunctionVersion(versions, live),
    ...address,
  };
}

/** Point `live` back at the previous version: no image, no stack apply. */
export async function rollbackFunctionRelease(
  target: FunctionReleaseTarget,
): Promise<FunctionRelease> {
  const { appRef, stackName } = functionReleaseNames(target.repositoryId, target.environment);
  const stack = await target.account.runner.describeStack(stackName);
  const upstreamAddress = stack?.outputs['FunctionUrl'];
  if (!upstreamAddress) throw new NoPreviousFunctionVersionError(appRef);
  const { lambda } = target.account.clients;
  const live = await lambda.getAlias(appRef, LIVE_ALIAS);
  const versions = await lambda.listVersions(appRef);
  const previous = previousFunctionVersion(versions, live);
  if (previous === null) throw new NoPreviousFunctionVersionError(appRef);
  await lambda.updateAlias(appRef, LIVE_ALIAS, previous);
  return {
    appRef,
    stackName,
    releaseId: previous,
    upstreamAddress,
    liveVersion: previous,
    previousVersion: previousFunctionVersion(versions, previous),
  };
}

/** The `Duration` sum over the window, or the typed error naming the function. */
async function readUsage(
  input: FunctionUsageInput,
  appRef: string,
  since: Date,
  until: Date,
): Promise<ReleaseUsage> {
  let durationMs = 0;
  if (until > since) {
    try {
      durationMs = await input.account.clients.cloudwatch.sumMetric({
        ...FUNCTION_DURATION_METRIC,
        dimensions: { FunctionName: appRef },
        start: since,
        end: until,
      });
    } catch (err) {
      throw new FunctionUsageReadError(
        appRef,
        err instanceof AwsTenantApiError ? err.awsCode : 'UnknownError',
      );
    }
  }
  return {
    target: 'aws',
    appRef,
    releaseId: input.releaseId,
    since,
    until,
    runningSeconds: Math.max(0, Math.floor((until.getTime() - since.getTime()) / 1000)),
    compute: functionComputeUsage(input.environment, durationMs),
  };
}

/** GB-seconds of the environment's function from `since` until now. */
export async function functionUsageSince(
  input: FunctionUsageInput & { readonly since: Date },
): Promise<ReleaseUsage> {
  const { appRef } = functionReleaseNames(input.repositoryId, input.environment);
  return readUsage(input, appRef, input.since, (input.now ?? (() => new Date()))());
}

/**
 * Destroy the release, returning its usage from the stack's creation until now.
 * The usage is read FIRST: if CloudWatch does not answer, nothing is deleted.
 * An absent release is destroyed with zero usage. A delete whose answer was lost
 * but which finished is a finished delete, so its usage is still returned; a
 * caller that settles windows through `functionUsageSince` loses at most the
 * unsettled tail if the process itself dies after the delete.
 */
export async function destroyFunctionRelease(input: FunctionUsageInput): Promise<ReleaseUsage> {
  const { appRef, stackName } = functionReleaseNames(input.repositoryId, input.environment);
  const until = (input.now ?? (() => new Date()))();
  const { runner } = input.account;
  const stack = await runner.describeStack(stackName);
  if (!stack) return readUsage(input, appRef, until, until);
  const usage = await readUsage(input, appRef, stack.createdAt ?? until, until);
  try {
    await runner.deleteStack(stackName);
  } catch (err) {
    if (await runner.describeStack(stackName)) throw err;
  }
  return usage;
}

/** Every AWS action this module and its stack need — unioned into the deploy
 *  role's grant by the deploy-role permissions card. */
export const AWS_FUNCTION_DEPLOY_ACTIONS: readonly string[] = [
  // Called by this module.
  'lambda:GetAlias',
  'lambda:UpdateAlias',
  'lambda:ListVersionsByFunction',
  'lambda:GetFunctionConfiguration',
  'cloudwatch:GetMetricData',
  'secretsmanager:PutSecretValue',
  // The release stack's resources, through CloudFormation.
  'lambda:CreateFunction',
  'lambda:DeleteFunction',
  'lambda:GetFunction',
  'lambda:UpdateFunctionCode',
  'lambda:UpdateFunctionConfiguration',
  'lambda:PublishVersion',
  'lambda:CreateAlias',
  'lambda:DeleteAlias',
  'lambda:PutProvisionedConcurrencyConfig',
  'lambda:GetProvisionedConcurrencyConfig',
  'lambda:DeleteProvisionedConcurrencyConfig',
  'lambda:CreateFunctionUrlConfig',
  'lambda:GetFunctionUrlConfig',
  'lambda:UpdateFunctionUrlConfig',
  'lambda:DeleteFunctionUrlConfig',
  'lambda:AddPermission',
  'lambda:RemovePermission',
  'lambda:GetPolicy',
  'lambda:TagResource',
  'lambda:UntagResource',
  'lambda:ListTags',
  'ecr:BatchGetImage',
  'ecr:GetDownloadUrlForLayer',
  'ecr:GetRepositoryPolicy',
  'ecr:SetRepositoryPolicy',
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
