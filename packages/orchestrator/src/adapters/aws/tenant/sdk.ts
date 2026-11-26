import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListStacksCommand,
  StackStatus,
  UpdateStackCommand,
  type Stack,
  type StackSummary,
} from '@aws-sdk/client-cloudformation';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  type FilteredLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeManagedPrefixListsCommand,
  EC2Client,
  type ManagedPrefixList,
} from '@aws-sdk/client-ec2';
import {
  DeregisterTaskDefinitionCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
  UpdateServiceCommand,
  type Service,
  type Task,
} from '@aws-sdk/client-ecs';
import {
  DescribeRulesCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  type Rule,
  type TargetHealthDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  CreateRoleCommand,
  DeleteInstanceProfileCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListInstanceProfilesForRoleCommand,
  ListPoliciesCommand,
  ListPolicyVersionsCommand,
  ListRolePoliciesCommand,
  ListRolesCommand,
  PutRolePolicyCommand,
  RemoveRoleFromInstanceProfileCommand,
  UpdateAssumeRolePolicyCommand,
  type AttachedPolicy,
  type InstanceProfile,
  type Policy,
  type PolicyVersion,
  type Role,
} from '@aws-sdk/client-iam';
import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  GetProvisionedConcurrencyConfigCommand,
  LambdaClient,
  ListVersionsByFunctionCommand,
  UpdateAliasCommand,
  type FunctionConfiguration,
} from '@aws-sdk/client-lambda';
import { ExecuteStatementCommand, RDSDataClient, type Field } from '@aws-sdk/client-rds-data';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  AddTagsToResourceCommand,
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { AwsSdkClient } from '../management';
import type {
  TenantCloudFormation,
  TenantEc2,
  TenantIam,
  TenantIamPolicyRef,
  TenantIamRole,
  TenantPolicyDocument,
  TenantLogs,
  TenantRdsData,
  TenantSecretsManager,
  TenantSqlValue,
  TenantStack,
  TenantStackSummary,
  TenantStackWrite,
} from './clients';
import type {
  TenantEcs,
  TenantEcsContainerExit,
  TenantEcsDeployment,
  TenantEcsTask,
  TenantElb,
  TenantSsm,
  TenantTargetHealth,
} from './container/ecsClient';
import { AwsTenantApiError, TenantRoleUnavailableError } from './errors';
import type {
  TenantCloudWatch,
  TenantFunctionState,
  TenantMetricPoint,
  TenantFunctionVersion,
  TenantLambda,
} from './function/lambdaClient';

// The SDK-backed tenant clients (MOTIR-10004). The only file of the seam that
// imports an AWS SDK package; what it exports speaks only `clients.ts`'s types.
//
// API references, read 2026-10-28:
//   https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeStacks.html,
//   API_GetTemplate.html, API_CreateStack.html, API_UpdateStack.html, API_DeleteStack.html
//   https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html
//   https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html,
//   API_PutSecretValue.html
//   https://docs.aws.amazon.com/lambda/latest/api/API_GetAlias.html, API_UpdateAlias.html,
//   API_ListVersionsByFunction.html, API_GetFunctionConfiguration.html
//   https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html
//   https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeServices.html,
//   API_UpdateService.html, API_ListTaskDefinitions.html, API_DeregisterTaskDefinition.html,
//   API_ListTasks.html, API_DescribeTasks.html
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_DescribeTargetHealth.html,
//   API_DescribeRules.html
//   https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameter.html,
//   API_PutParameter.html, API_AddTagsToResource.html, API_DeleteParameter.html
//   https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeManagedPrefixLists.html
//   (read 2026-11-20)
//   https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ListStacks.html
//   https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRole.html, API_CreateRole.html,
//   API_UpdateAssumeRolePolicy.html, API_GetRolePolicy.html, API_PutRolePolicy.html,
//   API_DeleteRolePolicy.html, API_ListRolePolicies.html, API_ListAttachedRolePolicies.html,
//   API_DetachRolePolicy.html, API_ListInstanceProfilesForRole.html,
//   API_RemoveRoleFromInstanceProfile.html, API_DeleteInstanceProfile.html, API_DeleteRole.html,
//   API_ListRoles.html, API_ListPolicies.html, API_ListPolicyVersions.html,
//   API_DeletePolicyVersion.html, API_DeletePolicy.html (read 2026-11-23)
//   https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_FilterLogEvents.html,
//   https://docs.aws.amazon.com/lambda/latest/api/API_GetProvisionedConcurrencyConfig.html,
//   https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_Container.html (stop facts)
//   (read 2026-11-23)

/** The services a tenant client bundle builds. Later cards add theirs. */
export type TenantSdkService =
  | 'cloudformation'
  | 'rds-data'
  | 'secretsmanager'
  | 'lambda'
  | 'cloudwatch'
  | 'ecs'
  | 'elasticloadbalancing'
  | 'ssm'
  | 'ec2'
  | 'iam'
  | 'logs';

/** Temporary credentials, as the SDK's credential provider answers them. */
export interface TenantSdkCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration?: Date;
}

/** How the seam builds each SDK client: always with a credential PROVIDER, the
 *  deploy-role session, never a static key. */
export type TenantSdkClientFactory = (
  service: TenantSdkService,
  config: { region: string; credentials: () => Promise<TenantSdkCredentials> },
) => AwsSdkClient;

/** The real SDK client for each service. */
export const createTenantSdkClient: TenantSdkClientFactory = (service, config) => {
  switch (service) {
    case 'cloudformation':
      return new CloudFormationClient(config);
    case 'rds-data':
      return new RDSDataClient(config);
    case 'secretsmanager':
      return new SecretsManagerClient(config);
    case 'lambda':
      return new LambdaClient(config);
    case 'cloudwatch':
      return new CloudWatchClient(config);
    case 'ecs':
      return new ECSClient(config);
    case 'elasticloadbalancing':
      return new ElasticLoadBalancingV2Client(config);
    case 'ssm':
      return new SSMClient(config);
    case 'ec2':
      return new EC2Client(config);
    case 'iam':
      return new IAMClient(config);
    case 'logs':
      return new CloudWatchLogsClient(config);
  }
};

interface SdkErrorShape {
  name?: unknown;
  Code?: unknown;
  message?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

function shapeOf(err: unknown): SdkErrorShape {
  return (typeof err === 'object' && err !== null ? err : {}) as SdkErrorShape;
}

/** AWS's code for the error — never its message, which can echo inputs. */
export function tenantApiError(
  service: string,
  err: unknown,
): AwsTenantApiError | TenantRoleUnavailableError {
  // A credential the provider could not get is the role's refusal, not the call's.
  if (err instanceof AwsTenantApiError || err instanceof TenantRoleUnavailableError) return err;
  const shape = shapeOf(err);
  const code =
    (typeof shape.Code === 'string' && shape.Code) ||
    (typeof shape.name === 'string' && shape.name) ||
    'UnknownError';
  const status =
    typeof shape.$metadata?.httpStatusCode === 'number' ? shape.$metadata.httpStatusCode : null;
  return new AwsTenantApiError(service, code, status);
}

/** CloudFormation answers both of these as a `ValidationError`; only the
 *  message tells them apart, so it is read here and never carried further. */
function validationSays(err: unknown, text: RegExp): boolean {
  const shape = shapeOf(err);
  return (
    (shape.name === 'ValidationError' || shape.Code === 'ValidationError') &&
    typeof shape.message === 'string' &&
    text.test(shape.message)
  );
}

const pairs = (record: Readonly<Record<string, string>>) => Object.entries(record);

function stackOf(name: string, stack: Stack): TenantStack {
  return {
    name,
    status: stack.StackStatus ?? 'UNKNOWN',
    parameters: Object.fromEntries(
      (stack.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue ?? '']),
    ),
    tags: Object.fromEntries((stack.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? ''])),
    outputs: Object.fromEntries(
      (stack.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
    ),
    ...(stack.CreationTime ? { createdAt: stack.CreationTime } : {}),
  };
}

/** The write's fields as CreateStack and UpdateStack take them. Named IAM roles
 *  need `CAPABILITY_NAMED_IAM`. */
function writeOf(input: TenantStackWrite) {
  return {
    StackName: input.name,
    TemplateBody: input.templateBody,
    Parameters: pairs(input.parameters).map(([ParameterKey, ParameterValue]) => ({
      ParameterKey,
      ParameterValue,
    })),
    Tags: pairs(input.tags).map(([Key, Value]) => ({ Key, Value })),
    Capabilities: ['CAPABILITY_NAMED_IAM' as const],
  };
}

/** Every stack status but `DELETE_COMPLETE`: ListStacks keeps a deleted stack
 *  for 90 days, and the filter leaves those out on AWS's side. */
const LIVE_STACK_STATUSES = Object.values(StackStatus).filter((s) => s !== 'DELETE_COMPLETE');

/** `TenantCloudFormation` over an SDK client. */
export function sdkTenantCloudFormation(client: AwsSdkClient): TenantCloudFormation {
  async function send<T>(command: unknown): Promise<T> {
    try {
      return (await client.send(command)) as T;
    } catch (err) {
      throw tenantApiError('cloudformation', err);
    }
  }

  return {
    async listStacks() {
      const stacks: TenantStackSummary[] = [];
      let nextToken: string | undefined;
      do {
        const page = await send<{ StackSummaries?: StackSummary[]; NextToken?: string }>(
          new ListStacksCommand({
            StackStatusFilter: LIVE_STACK_STATUSES,
            ...(nextToken ? { NextToken: nextToken } : {}),
          }),
        );
        for (const summary of page.StackSummaries ?? []) {
          if (summary.StackName && summary.StackStatus !== 'DELETE_COMPLETE') {
            stacks.push({ name: summary.StackName, status: summary.StackStatus ?? 'UNKNOWN' });
          }
        }
        nextToken = page.NextToken;
      } while (nextToken);
      return stacks;
    },

    async describeStack(name) {
      try {
        const { Stacks } = (await client.send(new DescribeStacksCommand({ StackName: name }))) as {
          Stacks?: Stack[];
        };
        const stack = Stacks?.[0];
        return stack ? stackOf(name, stack) : null;
      } catch (err) {
        if (validationSays(err, /does not exist/)) return null;
        throw tenantApiError('cloudformation', err);
      }
    },

    async getTemplateBody(name) {
      const { TemplateBody } = await send<{ TemplateBody?: string }>(
        new GetTemplateCommand({ StackName: name, TemplateStage: 'Original' }),
      );
      return TemplateBody ?? '';
    },

    async createStack(input) {
      await send(new CreateStackCommand(writeOf(input)));
    },

    async updateStack(input) {
      try {
        await client.send(new UpdateStackCommand(writeOf(input)));
        return 'updating';
      } catch (err) {
        if (validationSays(err, /No updates are to be performed/)) return 'no_change';
        throw tenantApiError('cloudformation', err);
      }
    },

    async deleteStack(name) {
      await send(new DeleteStackCommand({ StackName: name }));
    },
  };
}

function valueOf(field: Field): TenantSqlValue {
  if (field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  return null;
}

/** `TenantRdsData` over an SDK client. A failure carries AWS's code only — never
 *  the statement, which can hold a password. */
export function sdkTenantRdsData(client: AwsSdkClient): TenantRdsData {
  return {
    async executeStatement(statement) {
      try {
        const { records } = (await client.send(
          new ExecuteStatementCommand({
            resourceArn: statement.resourceArn,
            secretArn: statement.secretArn,
            database: statement.database,
            sql: statement.sql,
            parameters: Object.entries(statement.parameters ?? {}).map(([name, stringValue]) => ({
              name,
              value: { stringValue },
            })),
          }),
        )) as { records?: Field[][] };
        return (records ?? []).map((row) => row.map(valueOf));
      } catch (err) {
        throw tenantApiError('rds-data', err);
      }
    },
  };
}

/** `TenantSecretsManager` over an SDK client. */
export function sdkTenantSecretsManager(client: AwsSdkClient): TenantSecretsManager {
  return {
    async getSecretValue(secretId) {
      try {
        const { SecretString } = (await client.send(
          new GetSecretValueCommand({ SecretId: secretId }),
        )) as { SecretString?: string };
        return SecretString ?? '';
      } catch (err) {
        throw tenantApiError('secretsmanager', err);
      }
    },
    async putSecretValue(secretId, value, versionId) {
      try {
        await client.send(
          new PutSecretValueCommand({
            SecretId: secretId,
            SecretString: value,
            ...(versionId ? { ClientRequestToken: versionId } : {}),
          }),
        );
      } catch (err) {
        throw tenantApiError('secretsmanager', err);
      }
    },
  };
}

const notFound = (err: unknown) => shapeOf(err).name === 'ResourceNotFoundException';

/** Lambda's `LastModified` (`2026-11-23T10:00:00.000+0000`, an offset with no
 *  colon) as a date; null when absent or unreadable. */
function lambdaInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(at.getTime()) ? null : at;
}

/** `TenantLambda` over an SDK client. */
export function sdkTenantLambda(client: AwsSdkClient): TenantLambda {
  async function send<T>(command: unknown): Promise<T> {
    try {
      return (await client.send(command)) as T;
    } catch (err) {
      throw tenantApiError('lambda', err);
    }
  }

  return {
    async getAlias(functionName, alias) {
      try {
        const { FunctionVersion } = (await client.send(
          new GetAliasCommand({ FunctionName: functionName, Name: alias }),
        )) as { FunctionVersion?: string };
        return FunctionVersion ?? null;
      } catch (err) {
        if (notFound(err)) return null;
        throw tenantApiError('lambda', err);
      }
    },

    async updateAlias(functionName, alias, version) {
      await send(
        new UpdateAliasCommand({
          FunctionName: functionName,
          Name: alias,
          FunctionVersion: version,
        }),
      );
    },

    async listVersions(functionName) {
      const versions: string[] = [];
      let marker: string | undefined;
      do {
        const page = await send<{ Versions?: FunctionConfiguration[]; NextMarker?: string }>(
          new ListVersionsByFunctionCommand({
            FunctionName: functionName,
            ...(marker ? { Marker: marker } : {}),
          }),
        );
        for (const v of page.Versions ?? []) {
          if (v.Version && v.Version !== '$LATEST') versions.push(v.Version);
        }
        marker = page.NextMarker;
      } while (marker);
      return versions;
    },

    async getFunctionVersion(functionName, version) {
      try {
        const config = (await client.send(
          new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: version }),
        )) as Pick<FunctionConfiguration, 'State' | 'LastUpdateStatus' | 'LastModified'>;
        return {
          state: (config.State?.toLowerCase() ?? 'pending') as TenantFunctionState,
          lastUpdateStatus: config.LastUpdateStatus?.toLowerCase() ?? null,
          lastModified: lambdaInstant(config.LastModified),
        } satisfies TenantFunctionVersion;
      } catch (err) {
        if (notFound(err)) return null;
        throw tenantApiError('lambda', err);
      }
    },

    async getProvisionedConcurrency(functionName, alias) {
      try {
        const { Status } = (await client.send(
          new GetProvisionedConcurrencyConfigCommand({
            FunctionName: functionName,
            Qualifier: alias,
          }),
        )) as { Status?: string };
        return Status ?? 'IN_PROGRESS';
      } catch (err) {
        if (
          notFound(err) ||
          shapeOf(err).name === 'ProvisionedConcurrencyConfigNotFoundException'
        ) {
          return null;
        }
        throw tenantApiError('lambda', err);
      }
    },

    async getFunctionState(functionName, version) {
      try {
        const { State } = (await client.send(
          new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: version }),
        )) as { State?: string };
        return (State?.toLowerCase() ?? 'pending') as TenantFunctionState;
      } catch (err) {
        if (notFound(err)) return null;
        throw tenantApiError('lambda', err);
      }
    },
  };
}

/** The coarsest period CloudWatch serves at every age (an hour, past 63 days),
 *  stretched to the window, so the sum is one datapoint per page. */
function sumPeriodSeconds(start: Date, end: Date): number {
  const seconds = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 1000));
  return Math.ceil(seconds / 3600) * 3600;
}

/** `TenantCloudWatch` over an SDK client. */
export function sdkTenantCloudWatch(client: AwsSdkClient): TenantCloudWatch {
  return {
    async sumMetric(query) {
      let total = 0;
      let nextToken: string | undefined;
      try {
        do {
          const page = (await client.send(
            new GetMetricDataCommand({
              StartTime: query.start,
              EndTime: query.end,
              MetricDataQueries: [
                {
                  Id: 'sum',
                  ReturnData: true,
                  MetricStat: {
                    Metric: {
                      Namespace: query.namespace,
                      MetricName: query.metricName,
                      Dimensions: Object.entries(query.dimensions).map(([Name, Value]) => ({
                        Name,
                        Value,
                      })),
                    },
                    Period: sumPeriodSeconds(query.start, query.end),
                    Stat: 'Sum',
                  },
                },
              ],
              ...(nextToken ? { NextToken: nextToken } : {}),
            }),
          )) as { MetricDataResults?: MetricDataResult[]; NextToken?: string };
          for (const result of page.MetricDataResults ?? []) {
            for (const value of result.Values ?? []) total += value;
          }
          nextToken = page.NextToken;
        } while (nextToken);
      } catch (err) {
        throw tenantApiError('cloudwatch', err);
      }
      return total;
    },

    async metricPoints(query) {
      const points: TenantMetricPoint[] = [];
      let nextToken: string | undefined;
      try {
        do {
          const page = (await client.send(
            new GetMetricDataCommand({
              StartTime: query.start,
              EndTime: query.end,
              ScanBy: 'TimestampAscending',
              MetricDataQueries: [
                {
                  Id: 'series',
                  ReturnData: true,
                  MetricStat: {
                    Metric: {
                      Namespace: query.namespace,
                      MetricName: query.metricName,
                      Dimensions: Object.entries(query.dimensions).map(([Name, Value]) => ({
                        Name,
                        Value,
                      })),
                    },
                    Period: query.periodSeconds,
                    Stat: query.stat,
                  },
                },
              ],
              ...(nextToken ? { NextToken: nextToken } : {}),
            }),
          )) as { MetricDataResults?: MetricDataResult[]; NextToken?: string };
          for (const result of page.MetricDataResults ?? []) {
            const values = result.Values ?? [];
            (result.Timestamps ?? []).forEach((at, i) => {
              const value = values[i];
              if (value !== undefined) points.push({ at: new Date(at), value });
            });
          }
          nextToken = page.NextToken;
        } while (nextToken);
      } catch (err) {
        throw tenantApiError('cloudwatch', err);
      }
      return points.sort((a, b) => a.at.getTime() - b.at.getTime());
    },
  };
}

/** One SDK call, its failure carried as AWS's code only. */
function sender(service: string, client: AwsSdkClient) {
  return async <T>(command: unknown): Promise<T> => {
    try {
      return (await client.send(command)) as T;
    } catch (err) {
      throw tenantApiError(service, err);
    }
  };
}

const named = (err: unknown, ...names: string[]) =>
  err instanceof AwsTenantApiError && names.includes(err.awsCode);

function deploymentOf(d: NonNullable<Service['deployments']>[number]): TenantEcsDeployment {
  return {
    taskDefinition: d.taskDefinition ?? '',
    status: d.status ?? '',
    rolloutState: (d.rolloutState ?? 'IN_PROGRESS') as TenantEcsDeployment['rolloutState'],
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

/** The release's container, `app` (the release template names it), else the
 *  only one: how it exited, or null while it has not. */
function containerExitOf(t: Task): TenantEcsContainerExit | null {
  const containers = t.containers ?? [];
  const app = containers.find((c) => c.name === 'app') ?? containers[0];
  if (!app || (app.exitCode === undefined && !app.reason)) return null;
  return { exitCode: app.exitCode ?? null, reason: app.reason ?? null };
}

function taskOf(t: Task): TenantEcsTask {
  return {
    taskArn: t.taskArn ?? '',
    taskDefinition: t.taskDefinitionArn ?? '',
    lastStatus: t.lastStatus ?? '',
    startedAt: t.pullStartedAt ?? t.startedAt ?? null,
    stoppedAt: t.stoppedAt ?? null,
    cpu: Number(t.cpu ?? 0),
    memory: Number(t.memory ?? 0),
    stopCode: t.stopCode ?? null,
    stoppedReason: t.stoppedReason ?? null,
    container: containerExitOf(t),
  };
}

/** `TenantEcs` over an SDK client. */
export function sdkTenantEcs(client: AwsSdkClient): TenantEcs {
  const send = sender('ecs', client);
  return {
    async describeService(cluster, service) {
      let services: Service[];
      try {
        ({ services = [] } = await send<{ services?: Service[] }>(
          new DescribeServicesCommand({ cluster, services: [service] }),
        ));
      } catch (err) {
        if (named(err, 'ClusterNotFoundException')) return null;
        throw err;
      }
      const found = services.find((s) => s.status !== 'INACTIVE');
      if (!found) return null;
      return {
        taskDefinition: found.taskDefinition ?? '',
        desiredCount: found.desiredCount ?? 0,
        runningCount: found.runningCount ?? 0,
        deployments: (found.deployments ?? []).map(deploymentOf),
      };
    },

    async updateService(cluster, service, taskDefinition) {
      await send(new UpdateServiceCommand({ cluster, service, taskDefinition }));
    },

    async listTaskDefinitions(family) {
      const arns: string[] = [];
      let nextToken: string | undefined;
      do {
        const page = await send<{ taskDefinitionArns?: string[]; nextToken?: string }>(
          new ListTaskDefinitionsCommand({
            familyPrefix: family,
            status: 'ACTIVE',
            sort: 'ASC',
            ...(nextToken ? { nextToken } : {}),
          }),
        );
        // The prefix also matches longer families (`mh-x` and `mh-x-pr1`).
        arns.push(...(page.taskDefinitionArns ?? []).filter((a) => a.includes(`/${family}:`)));
        nextToken = page.nextToken;
      } while (nextToken);
      return arns;
    },

    async deregisterTaskDefinition(taskDefinition) {
      await send(new DeregisterTaskDefinitionCommand({ taskDefinition }));
    },

    async listTasks(cluster, service) {
      const arns: string[] = [];
      try {
        for (const desiredStatus of ['RUNNING', 'STOPPED'] as const) {
          let nextToken: string | undefined;
          do {
            const page = await send<{ taskArns?: string[]; nextToken?: string }>(
              new ListTasksCommand({
                cluster,
                serviceName: service,
                desiredStatus,
                ...(nextToken ? { nextToken } : {}),
              }),
            );
            arns.push(...(page.taskArns ?? []));
            nextToken = page.nextToken;
          } while (nextToken);
        }
      } catch (err) {
        if (named(err, 'ClusterNotFoundException', 'ServiceNotFoundException')) return [];
        throw err;
      }
      const tasks: TenantEcsTask[] = [];
      for (let i = 0; i < arns.length; i += 100) {
        const { tasks: page = [] } = await send<{ tasks?: Task[] }>(
          new DescribeTasksCommand({ cluster, tasks: arns.slice(i, i + 100) }),
        );
        tasks.push(...page.map(taskOf));
      }
      return tasks;
    },
  };
}

/** `TenantElb` over an SDK client. */
export function sdkTenantElb(client: AwsSdkClient): TenantElb {
  const send = sender('elasticloadbalancing', client);
  return {
    async describeTargetHealth(targetGroupArn) {
      const { TargetHealthDescriptions = [] } = await send<{
        TargetHealthDescriptions?: TargetHealthDescription[];
      }>(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn }));
      return TargetHealthDescriptions.map(
        (d) => (d.TargetHealth?.State ?? 'unavailable') as TenantTargetHealth,
      );
    },

    async listRulePriorities(listenerArn) {
      const priorities: number[] = [];
      let marker: string | undefined;
      do {
        const page = await send<{ Rules?: Rule[]; NextMarker?: string }>(
          new DescribeRulesCommand({
            ListenerArn: listenerArn,
            ...(marker ? { Marker: marker } : {}),
          }),
        );
        for (const rule of page.Rules ?? []) {
          const priority = Number(rule.Priority);
          if (Number.isInteger(priority)) priorities.push(priority);
        }
        marker = page.NextMarker;
      } while (marker);
      return priorities;
    },
  };
}

/** `TenantSsm` over an SDK client. A parameter is a plain String: it holds
 *  usage numbers, never a secret. */
export function sdkTenantSsm(client: AwsSdkClient): TenantSsm {
  const send = sender('ssm', client);
  return {
    async getParameter(name) {
      try {
        const { Parameter } = await send<{ Parameter?: { Value?: string } }>(
          new GetParameterCommand({ Name: name }),
        );
        return Parameter?.Value ?? null;
      } catch (err) {
        if (named(err, 'ParameterNotFound')) return null;
        throw err;
      }
    },

    async putParameter(name, value, tags) {
      await send(
        new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }),
      );
      await send(
        new AddTagsToResourceCommand({
          ResourceType: 'Parameter',
          ResourceId: name,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
    },

    async deleteParameter(name) {
      try {
        await send(new DeleteParameterCommand({ Name: name }));
      } catch (err) {
        if (!named(err, 'ParameterNotFound')) throw err;
      }
    },
  };
}

/** `TenantEc2` over an SDK client: an AWS-managed prefix list, found by its
 *  name — its id differs by region, so it is never written down. */
export function sdkTenantEc2(client: AwsSdkClient): TenantEc2 {
  const send = sender('ec2', client);
  return {
    async managedPrefixListId(name) {
      const { PrefixLists = [] } = await send<{ PrefixLists?: ManagedPrefixList[] }>(
        new DescribeManagedPrefixListsCommand({
          Filters: [{ Name: 'prefix-list-name', Values: [name] }],
        }),
      );
      return PrefixLists.find((list) => list.PrefixListName === name)?.PrefixListId ?? null;
    },
  };
}

/** `TenantLogs` over an SDK client: FilterLogEvents, a group that does not
 *  exist answered as null rather than as a failure. */
export function sdkTenantLogs(client: AwsSdkClient): TenantLogs {
  return {
    async filterLogEvents(group, input) {
      let page: { events?: FilteredLogEvent[]; nextToken?: string };
      try {
        page = (await client.send(
          new FilterLogEventsCommand({
            logGroupName: group,
            startTime: input.startMs,
            endTime: input.endMs,
            ...(input.filterPattern ? { filterPattern: input.filterPattern } : {}),
            ...(input.nextToken ? { nextToken: input.nextToken } : {}),
          }),
        )) as typeof page;
      } catch (err) {
        if (notFound(err)) return null;
        throw tenantApiError('logs', err);
      }
      return {
        events: (page.events ?? []).flatMap((e) =>
          typeof e.timestamp === 'number' && Number.isFinite(e.timestamp)
            ? [
                {
                  // An event with no id is keyed by its stream, instant and text.
                  eventId:
                    e.eventId ?? `${e.logStreamName ?? ''}:${e.timestamp}:${e.message ?? ''}`,
                  timestamp: e.timestamp,
                  message: e.message ?? '',
                },
              ]
            : [],
        ),
        nextToken: page.nextToken ? page.nextToken : null,
      };
    },
  };
}

/** The default credential chain's credentials (environment, profile, SSO,
 *  instance role), resolved the way an SDK client in `region` resolves them —
 *  for a caller that signs its own requests (`sigv4Fetch.ts`). */
export function defaultChainCredentials(region: string): () => Promise<{
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}> {
  const client = new LambdaClient({ region });
  return () => client.config.credentials();
}

/** IAM returns policy documents URL-encoded. */
function documentOf(encoded: string | undefined): TenantPolicyDocument {
  if (!encoded) return { Version: '2012-10-17', Statement: [] };
  return JSON.parse(decodeURIComponent(encoded)) as TenantPolicyDocument;
}

function roleOf(role: Role): TenantIamRole {
  return {
    name: role.RoleName ?? '',
    arn: role.Arn ?? '',
    path: role.Path ?? '/',
    trust: documentOf(role.AssumeRolePolicyDocument),
  };
}

/** `TenantIam` over an SDK client (MOTIR-12130). A delete of something already
 *  gone answers quietly, so every caller is look-before-act by construction. */
export function sdkTenantIam(client: AwsSdkClient): TenantIam {
  const send = sender('iam', client);
  const gone = (err: unknown) => named(err, 'NoSuchEntity', 'NoSuchEntityException');
  async function quietly(command: unknown): Promise<void> {
    try {
      await send(command);
    } catch (err) {
      if (!gone(err)) throw err;
    }
  }

  return {
    async getRole(name) {
      try {
        const { Role: role } = await send<{ Role?: Role }>(new GetRoleCommand({ RoleName: name }));
        return role ? roleOf(role) : null;
      } catch (err) {
        if (gone(err)) return null;
        throw err;
      }
    },

    async createRole(input) {
      await send(
        new CreateRoleCommand({
          RoleName: input.name,
          ...(input.path ? { Path: input.path } : {}),
          AssumeRolePolicyDocument: JSON.stringify(input.trust),
          Description: input.description,
          MaxSessionDuration: input.maxSessionSeconds,
          Tags: Object.entries(input.tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
    },

    async updateAssumeRolePolicy(name, trust) {
      await send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: name,
          PolicyDocument: JSON.stringify(trust),
        }),
      );
    },

    async getRolePolicy(role, policyName) {
      try {
        const { PolicyDocument } = await send<{ PolicyDocument?: string }>(
          new GetRolePolicyCommand({ RoleName: role, PolicyName: policyName }),
        );
        return documentOf(PolicyDocument);
      } catch (err) {
        if (gone(err)) return null;
        throw err;
      }
    },

    async putRolePolicy(role, policyName, document) {
      await send(
        new PutRolePolicyCommand({
          RoleName: role,
          PolicyName: policyName,
          PolicyDocument: JSON.stringify(document),
        }),
      );
    },

    async deleteRolePolicy(role, policyName) {
      await quietly(new DeleteRolePolicyCommand({ RoleName: role, PolicyName: policyName }));
    },

    async listRolePolicies(role) {
      const names: string[] = [];
      let marker: string | undefined;
      do {
        const page = await send<{ PolicyNames?: string[]; IsTruncated?: boolean; Marker?: string }>(
          new ListRolePoliciesCommand({ RoleName: role, ...(marker ? { Marker: marker } : {}) }),
        );
        names.push(...(page.PolicyNames ?? []));
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
      return names;
    },

    async listAttachedRolePolicies(role) {
      const refs: TenantIamPolicyRef[] = [];
      let marker: string | undefined;
      do {
        const page = await send<{
          AttachedPolicies?: AttachedPolicy[];
          IsTruncated?: boolean;
          Marker?: string;
        }>(
          new ListAttachedRolePoliciesCommand({
            RoleName: role,
            ...(marker ? { Marker: marker } : {}),
          }),
        );
        for (const p of page.AttachedPolicies ?? []) {
          refs.push({ name: p.PolicyName ?? '', arn: p.PolicyArn ?? '' });
        }
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
      return refs;
    },

    async detachRolePolicy(role, policyArn) {
      await quietly(new DetachRolePolicyCommand({ RoleName: role, PolicyArn: policyArn }));
    },

    async listInstanceProfilesForRole(role) {
      const names: string[] = [];
      let marker: string | undefined;
      do {
        const page = await send<{
          InstanceProfiles?: InstanceProfile[];
          IsTruncated?: boolean;
          Marker?: string;
        }>(
          new ListInstanceProfilesForRoleCommand({
            RoleName: role,
            ...(marker ? { Marker: marker } : {}),
          }),
        );
        for (const p of page.InstanceProfiles ?? []) {
          if (p.InstanceProfileName) names.push(p.InstanceProfileName);
        }
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
      return names;
    },

    async removeRoleFromInstanceProfile(profile, role) {
      await quietly(
        new RemoveRoleFromInstanceProfileCommand({ InstanceProfileName: profile, RoleName: role }),
      );
    },

    async deleteInstanceProfile(profile) {
      await quietly(new DeleteInstanceProfileCommand({ InstanceProfileName: profile }));
    },

    async deleteRole(name) {
      await quietly(new DeleteRoleCommand({ RoleName: name }));
    },

    async listRoles() {
      const roles: TenantIamRole[] = [];
      let marker: string | undefined;
      do {
        const page = await send<{ Roles?: Role[]; IsTruncated?: boolean; Marker?: string }>(
          new ListRolesCommand(marker ? { Marker: marker } : {}),
        );
        roles.push(...(page.Roles ?? []).map(roleOf));
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
      return roles;
    },

    async listPolicies(pathPrefix) {
      const refs: TenantIamPolicyRef[] = [];
      let marker: string | undefined;
      do {
        const page = await send<{ Policies?: Policy[]; IsTruncated?: boolean; Marker?: string }>(
          new ListPoliciesCommand({
            Scope: 'Local',
            PathPrefix: pathPrefix,
            ...(marker ? { Marker: marker } : {}),
          }),
        );
        for (const p of page.Policies ?? []) {
          refs.push({ name: p.PolicyName ?? '', arn: p.Arn ?? '' });
        }
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
      return refs;
    },

    async deletePolicy(policyArn) {
      let versions: PolicyVersion[];
      try {
        ({ Versions: versions = [] } = await send<{ Versions?: PolicyVersion[] }>(
          new ListPolicyVersionsCommand({ PolicyArn: policyArn }),
        ));
      } catch (err) {
        if (gone(err)) return;
        throw err;
      }
      for (const v of versions) {
        if (!v.IsDefaultVersion && v.VersionId) {
          await quietly(
            new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: v.VersionId }),
          );
        }
      }
      await quietly(new DeletePolicyCommand({ PolicyArn: policyArn }));
    },
  };
}
