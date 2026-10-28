import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CreateRepositoryCommand, DeleteRepositoryCommand, ECRClient } from '@aws-sdk/client-ecr';
import {
  CreateAliasCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionCommand,
  GetAliasCommand,
  GetFunctionCommand,
  GetFunctionUrlConfigCommand,
  LambdaClient,
  ListFunctionsCommand,
  PublishVersionCommand,
  TagResourceCommand,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { OrchestratorApiError } from '../../errors';
import type { ServerlessHostingConfig } from './config';
import type { LambdaMetricSums } from './usage';

// The serverless account's boundary (Story MOTIR-9793 · MOTIR-9972) — the ONE
// module that speaks the AWS SDK for the serverless target, the twin of
// `../fly/flyMachines.ts`. `ServerlessAwsApi` is plain shapes: no SDK type
// crosses it, so the adapter codes against it and its tests drive it through the
// SDK client seam (`clientFactory`) with an in-memory account.
//
// ⚠️ ONE ROLE, ONE ACCOUNT. Every client is made under the scoped role of
// `MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN`, assumed here, so nothing this module
// does can act anywhere the role cannot — and it calls no IAM API at all. Who
// assumes it is the composition root's to say (`sourceCredentials`): Motir's
// management key and role on the app, the default chain on an operator's laptop.
//
// ⚠️ A FAILURE CARRIES THE SERVICE'S ERROR CODE, NEVER ITS MESSAGE. An AWS message
// can quote a request — an environment value, a secret string — so the only text
// an `OrchestratorApiError` from here carries is the code (`ResourceNotFound…`).

export type ServerlessAwsService = 'sts' | 'lambda' | 'ecr' | 'secrets' | 'logs' | 'cloudwatch';

/** An access key, and optionally a role it first assumes (Motir's management
 *  role, which the scoped role trusts). */
export interface ServerlessSourceCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly roleArn?: string;
}

export interface AwsCredentialIdentity {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

export type AwsCredentialIdentityProvider = () => Promise<AwsCredentialIdentity>;

export interface ServerlessSdkClient {
  send(command: unknown): Promise<unknown>;
}

export type ServerlessSdkClientFactory = (
  service: ServerlessAwsService,
  options: { region: string; credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider },
) => ServerlessSdkClient;

export interface ServerlessClientDeps {
  /** The SDK seam: tests answer commands in memory. */
  readonly clientFactory?: ServerlessSdkClientFactory;
  /** Who assumes the scoped role; absent means the SDK's default chain. */
  readonly sourceCredentials?: ServerlessSourceCredentials | null;
  readonly now?: () => Date;
}

export function defaultServerlessClientFactory(
  service: ServerlessAwsService,
  options: Parameters<ServerlessSdkClientFactory>[1],
): ServerlessSdkClient {
  switch (service) {
    case 'sts':
      return new STSClient(options);
    case 'lambda':
      return new LambdaClient(options);
    case 'ecr':
      return new ECRClient(options);
    case 'secrets':
      return new SecretsManagerClient(options);
    case 'logs':
      return new CloudWatchLogsClient(options);
    case 'cloudwatch':
      return new CloudWatchClient(options);
  }
}

interface SdkErrorShape {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

/** The AWS error code of a failure, never its message. */
export function awsErrorCode(err: unknown): string {
  const shape = (typeof err === 'object' && err !== null ? err : {}) as SdkErrorShape;
  if (typeof shape.Code === 'string' && shape.Code) return shape.Code;
  return typeof shape.name === 'string' && shape.name ? shape.name : 'UnknownError';
}

function toApiError(service: ServerlessAwsService, err: unknown): OrchestratorApiError {
  if (err instanceof OrchestratorApiError) return err;
  const shape = (typeof err === 'object' && err !== null ? err : {}) as SdkErrorShape;
  const status =
    typeof shape.$metadata?.httpStatusCode === 'number' ? shape.$metadata.httpStatusCode : null;
  return new OrchestratorApiError('aws', status, `${service}: ${awsErrorCode(err)}`);
}

const NOT_FOUND: ReadonlySet<string> = new Set([
  'ResourceNotFoundException',
  'RepositoryNotFoundException',
  'NotFoundException',
]);

const EXISTS = Symbol('exists');

const ROLE_SESSION_NAME = 'motir-hosting-serverless';
const ROLE_SESSION_SECONDS = 3600;
/** Renew a session this long before it expires. */
const RENEW_BEFORE_MS = 5 * 60_000;

/**
 * The scoped role's credentials, assumed on first use and again before they
 * expire — what every client of this module, and the SigV4 helper, signs with.
 */
export function serverlessCredentialProvider(
  config: Pick<ServerlessHostingConfig, 'roleArn' | 'region'>,
  deps: ServerlessClientDeps = {},
): AwsCredentialIdentityProvider {
  const factory = deps.clientFactory ?? defaultServerlessClientFactory;
  const now = deps.now ?? (() => new Date());
  const source = deps.sourceCredentials ?? null;
  let session: AwsCredentialIdentity | null = null;

  async function assume(
    roleArn: string,
    credentials: AwsCredentialIdentity | undefined,
  ): Promise<AwsCredentialIdentity> {
    const sts = factory('sts', { region: config.region, ...(credentials ? { credentials } : {}) });
    let response: unknown;
    try {
      response = await sts.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: ROLE_SESSION_NAME,
          DurationSeconds: ROLE_SESSION_SECONDS,
        }),
      );
    } catch (err) {
      throw toApiError('sts', err);
    }
    const c = (response as { Credentials?: Record<string, unknown> }).Credentials;
    if (
      typeof c?.['AccessKeyId'] !== 'string' ||
      typeof c['SecretAccessKey'] !== 'string' ||
      typeof c['SessionToken'] !== 'string'
    ) {
      throw new OrchestratorApiError('aws', null, 'sts: AssumeRole returned no credentials');
    }
    return {
      accessKeyId: c['AccessKeyId'],
      secretAccessKey: c['SecretAccessKey'],
      sessionToken: c['SessionToken'],
      ...(c['Expiration'] instanceof Date ? { expiration: c['Expiration'] } : {}),
    };
  }

  return async () => {
    const expiresAt = session?.expiration?.getTime() ?? Infinity;
    if (session && expiresAt - now().getTime() > RENEW_BEFORE_MS) return session;
    let base: AwsCredentialIdentity | undefined;
    if (source) {
      base = { accessKeyId: source.accessKeyId, secretAccessKey: source.secretAccessKey };
      if (source.roleArn) base = await assume(source.roleArn, base);
    }
    session = await assume(config.roleArn, base);
    return session;
  };
}

/** A Lambda function as the adapter reads it. */
export interface LambdaFunctionView {
  readonly name: string;
  readonly arn: string;
  readonly state: string;
  readonly lastUpdateStatus: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface LambdaFunctionSpec {
  readonly name: string;
  readonly imageUri: string;
  readonly roleArn: string;
  readonly memoryMb: number;
  readonly timeoutSeconds: number;
  readonly command: readonly string[];
  readonly variables: Readonly<Record<string, string>>;
}

/** The narrow calls the adapter makes — plain shapes in, plain shapes out. */
export interface ServerlessAwsApi {
  ensureRepository(name: string): Promise<void>;
  deleteRepository(name: string): Promise<void>;
  /** The function, or null when it does not exist. */
  getFunction(name: string): Promise<LambdaFunctionView | null>;
  createFunction(spec: LambdaFunctionSpec, tags: Record<string, string>): Promise<void>;
  updateFunctionConfiguration(spec: LambdaFunctionSpec): Promise<void>;
  updateFunctionCode(name: string, imageUri: string): Promise<void>;
  publishVersion(name: string): Promise<string>;
  /** The version an alias points at, or null when there is no such alias. */
  getAliasVersion(name: string, alias: string): Promise<string | null>;
  putAlias(name: string, alias: string, version: string, exists: boolean): Promise<void>;
  /** The URL of the alias, created with IAM auth when absent. */
  ensureFunctionUrl(name: string, alias: string): Promise<string>;
  getFunctionUrl(name: string, alias: string): Promise<string | null>;
  tagFunction(arn: string, tags: Record<string, string>): Promise<void>;
  /** Deletes the function with every version, alias and URL; gone is success. */
  deleteFunction(name: string): Promise<void>;
  listFunctionNames(): Promise<string[]>;
  putSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  deleteLogGroup(name: string): Promise<void>;
  metricSums(
    functionName: string,
    since: Date,
    until: Date,
    period: number,
  ): Promise<LambdaMetricSums>;
}

export function createServerlessAwsApi(
  config: Pick<ServerlessHostingConfig, 'roleArn' | 'region'>,
  deps: ServerlessClientDeps = {},
): ServerlessAwsApi {
  const factory = deps.clientFactory ?? defaultServerlessClientFactory;
  const credentials = serverlessCredentialProvider(config, deps);
  const clients = new Map<ServerlessAwsService, ServerlessSdkClient>();

  function clientFor(service: ServerlessAwsService): ServerlessSdkClient {
    let client = clients.get(service);
    if (!client) {
      client = factory(service, { region: config.region, credentials });
      clients.set(service, client);
    }
    return client;
  }

  async function send<T>(service: ServerlessAwsService, command: unknown): Promise<T> {
    try {
      return (await clientFor(service).send(command)) as T;
    } catch (err) {
      throw toApiError(service, err);
    }
  }

  /** A call whose refusal with one of `codes` answers `fallback` — "absent",
   *  "already gone" or "already there" — instead of throwing. */
  async function sendOr<T, F>(
    service: ServerlessAwsService,
    command: unknown,
    codes: ReadonlySet<string>,
    fallback: F,
  ): Promise<T | F> {
    try {
      return (await clientFor(service).send(command)) as T;
    } catch (err) {
      if (codes.has(awsErrorCode(err))) return fallback;
      throw toApiError(service, err);
    }
  }

  function functionInput(spec: LambdaFunctionSpec) {
    return {
      Role: spec.roleArn,
      MemorySize: spec.memoryMb,
      Timeout: spec.timeoutSeconds,
      Environment: { Variables: { ...spec.variables } },
      ImageConfig: { Command: [...spec.command] },
    };
  }

  const api: ServerlessAwsApi = {
    async ensureRepository(name) {
      await sendOr(
        'ecr',
        new CreateRepositoryCommand({ repositoryName: name, imageTagMutability: 'MUTABLE' }),
        new Set(['RepositoryAlreadyExistsException']),
        undefined,
      );
    },

    async deleteRepository(name) {
      await sendOr(
        'ecr',
        new DeleteRepositoryCommand({ repositoryName: name, force: true }),
        NOT_FOUND,
        undefined,
      );
    },

    async getFunction(name) {
      const response = await sendOr<
        {
          Configuration?: { FunctionArn?: string; State?: string; LastUpdateStatus?: string };
          Tags?: Record<string, string>;
        },
        null
      >('lambda', new GetFunctionCommand({ FunctionName: name }), NOT_FOUND, null);
      if (!response?.Configuration?.FunctionArn) return null;
      const { Configuration: c } = response;
      return {
        name,
        arn: c.FunctionArn!,
        state: c.State ?? 'Pending',
        lastUpdateStatus: c.LastUpdateStatus ?? 'InProgress',
        tags: { ...(response.Tags ?? {}) },
      };
    },

    async createFunction(spec, tags) {
      await send(
        'lambda',
        new CreateFunctionCommand({
          FunctionName: spec.name,
          PackageType: 'Image',
          Code: { ImageUri: spec.imageUri },
          Architectures: ['x86_64'],
          Tags: tags,
          ...functionInput(spec),
        }),
      );
    },

    async updateFunctionConfiguration(spec) {
      await send(
        'lambda',
        new UpdateFunctionConfigurationCommand({ FunctionName: spec.name, ...functionInput(spec) }),
      );
    },

    async updateFunctionCode(name, imageUri) {
      await send(
        'lambda',
        new UpdateFunctionCodeCommand({ FunctionName: name, ImageUri: imageUri }),
      );
    },

    async publishVersion(name) {
      const response = await send<{ Version?: string }>(
        'lambda',
        new PublishVersionCommand({ FunctionName: name }),
      );
      if (!response.Version) {
        throw new OrchestratorApiError('aws', null, 'lambda: PublishVersion returned no version');
      }
      return response.Version;
    },

    async getAliasVersion(name, alias) {
      const response = await sendOr<{ FunctionVersion?: string }, null>(
        'lambda',
        new GetAliasCommand({ FunctionName: name, Name: alias }),
        NOT_FOUND,
        null,
      );
      return response?.FunctionVersion ?? null;
    },

    async putAlias(name, alias, version, exists) {
      const input = { FunctionName: name, Name: alias, FunctionVersion: version };
      await send('lambda', exists ? new UpdateAliasCommand(input) : new CreateAliasCommand(input));
    },

    async getFunctionUrl(name, alias) {
      const response = await sendOr<{ FunctionUrl?: string }, null>(
        'lambda',
        new GetFunctionUrlConfigCommand({ FunctionName: name, Qualifier: alias }),
        NOT_FOUND,
        null,
      );
      return response?.FunctionUrl ?? null;
    },

    async ensureFunctionUrl(name, alias) {
      const existing = await api.getFunctionUrl(name, alias);
      if (existing) return existing;
      const response = await send<{ FunctionUrl?: string }>(
        'lambda',
        new CreateFunctionUrlConfigCommand({
          FunctionName: name,
          Qualifier: alias,
          AuthType: 'AWS_IAM',
          InvokeMode: 'RESPONSE_STREAM',
        }),
      );
      if (!response.FunctionUrl) {
        throw new OrchestratorApiError(
          'aws',
          null,
          'lambda: CreateFunctionUrlConfig returned no URL',
        );
      }
      return response.FunctionUrl;
    },

    async tagFunction(arn, tags) {
      await send('lambda', new TagResourceCommand({ Resource: arn, Tags: tags }));
    },

    async deleteFunction(name) {
      await sendOr(
        'lambda',
        new DeleteFunctionCommand({ FunctionName: name }),
        NOT_FOUND,
        undefined,
      );
    },

    async listFunctionNames() {
      const names: string[] = [];
      let marker: string | undefined;
      do {
        const page = await send<{
          Functions?: Array<{ FunctionName?: string }>;
          NextMarker?: string;
        }>('lambda', new ListFunctionsCommand({ ...(marker ? { Marker: marker } : {}) }));
        for (const fn of page.Functions ?? []) if (fn.FunctionName) names.push(fn.FunctionName);
        marker = page.NextMarker;
      } while (marker);
      return names;
    },

    async putSecret(name, value) {
      const created = await sendOr(
        'secrets',
        new CreateSecretCommand({ Name: name, SecretString: value }),
        new Set(['ResourceExistsException']),
        EXISTS,
      );
      if (created === EXISTS) {
        await send('secrets', new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      }
    },

    async deleteSecret(name) {
      await sendOr(
        'secrets',
        new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
        NOT_FOUND,
        undefined,
      );
    },

    async deleteLogGroup(name) {
      await sendOr('logs', new DeleteLogGroupCommand({ logGroupName: name }), NOT_FOUND, undefined);
    },

    async metricSums(functionName, since, until, period) {
      const metric = (id: string, name: string) => ({
        Id: id,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/Lambda',
            MetricName: name,
            Dimensions: [{ Name: 'FunctionName', Value: functionName }],
          },
          Period: period,
          Stat: 'Sum',
        },
      });
      const sums = { duration: 0, invocations: 0 };
      let token: string | undefined;
      do {
        const page = await send<{
          MetricDataResults?: Array<{ Id?: string; Values?: number[] }>;
          NextToken?: string;
        }>(
          'cloudwatch',
          new GetMetricDataCommand({
            MetricDataQueries: [
              metric('duration', 'Duration'),
              metric('invocations', 'Invocations'),
            ],
            StartTime: since,
            EndTime: until,
            ...(token ? { NextToken: token } : {}),
          }),
        );
        for (const result of page.MetricDataResults ?? []) {
          const total = (result.Values ?? []).reduce((a, b) => a + b, 0);
          if (result.Id === 'duration') sums.duration += total;
          if (result.Id === 'invocations') sums.invocations += total;
        }
        token = page.NextToken;
      } while (token);
      return { durationMs: sums.duration, invocations: sums.invocations };
    },
  };
  return api;
}
