import type {
  ServerlessAwsService,
  ServerlessSdkClient,
  ServerlessSdkClientFactory,
} from '../../src/index';

// An in-memory serverless account for the SERVERLESS hosting adapter (MOTIR-9972):
// Lambda functions with versions, aliases and URLs, ECR repositories, Secrets
// Manager secrets, log groups, CloudWatch's Lambda metrics and STS sessions.
// It answers at the SDK seam — the adapter's client module builds real SDK
// commands and this reads `command.constructor.name` and `command.input` — so
// the client module is exercised exactly as it runs against AWS. Shared by the
// adapter's own tests (`serverlessHosting.test.ts`) and the deploy port contract
// (`deployPortContract.test.ts`). Every command is recorded, and `failNext`
// refuses one call before the account sees it.

export interface LambdaSimCall {
  readonly service: ServerlessAwsService;
  readonly command: string;
  readonly input: Record<string, unknown>;
}

interface Snapshot {
  imageUri: string;
  variables: Record<string, string>;
  command: string[];
  memory: number;
  timeout: number;
  role: string;
}

export interface SimLambdaFunction {
  name: string;
  arn: string;
  state: string;
  lastUpdateStatus: string;
  /** Reads of the function left before an update settles. */
  pendingReads: number;
  latest: Snapshot;
  tags: Record<string, string>;
  versions: Array<{ version: string; snapshot: Snapshot }>;
  aliases: Map<string, string>;
  urls: Map<string, string>;
  /** Provisioned concurrency per alias, with its status. */
  provisioned: Map<string, { instances: number; status: string }>;
}

export interface LambdaSim {
  readonly calls: LambdaSimCall[];
  readonly functions: Map<string, SimLambdaFunction>;
  readonly repositories: Set<string>;
  readonly secrets: Map<string, string>;
  readonly logGroups: Set<string>;
  readonly metrics: Array<{ fn: string; at: number; durationMs: number; invocations: number }>;
  /** Every session STS issued, with the role and the key it was asked with. */
  readonly sessions: Array<{ roleArn: string; asKey: string | null; accessKeyId: string }>;
  readonly clientFactory: ServerlessSdkClientFactory;
  /** Refuse the next `command` whose input `matches`, once, with `code`. */
  failNext(
    command: string,
    matches?: (input: Record<string, unknown>) => boolean,
    code?: string,
    status?: number,
  ): void;
  /** Serve traffic for `seconds`: every function with a live alias runs the
   *  whole time, one request a second. */
  advanceSeconds(seconds: number): void;
  /** A request to a function URL: 200 when it carries a SigV4 signature made
   *  with a session this account issued, 403 otherwise, 404 for no such URL. */
  invoke(url: string, headers: Record<string, string>): number;
  /** The release `live` serves in `name`: its image, port and health path. */
  liveSnapshot(name: string): Snapshot | null;
  /** Provisioned concurrency that is put from now on reports FAILED. */
  failProvisioning: boolean;
  /** How many commands the account has answered or refused. */
  callCount(): number;
}

export const SIM_ACCOUNT = '212859366014';
export const SIM_REGION = 'us-east-1';

function simError(name: string, status: number): Error {
  return Object.assign(new Error(`${name} (simulated) with a message AWS might fill`), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createLambdaSim(clock: () => number): LambdaSim {
  const calls: LambdaSimCall[] = [];
  const functions = new Map<string, SimLambdaFunction>();
  const repositories = new Set<string>();
  const secrets = new Map<string, string>();
  const logGroups = new Set<string>();
  const metrics: LambdaSim['metrics'] = [];
  const sessions: LambdaSim['sessions'] = [];
  const failures: Array<{
    command: string;
    matches: (input: Record<string, unknown>) => boolean;
    code: string;
    status: number;
  }> = [];

  function fn(input: Record<string, unknown>): SimLambdaFunction {
    const found = functions.get(asString(input['FunctionName']));
    if (!found) throw simError('ResourceNotFoundException', 404);
    return found;
  }

  function begin(f: SimLambdaFunction): void {
    if (f.lastUpdateStatus === 'InProgress') throw simError('ResourceConflictException', 409);
    f.lastUpdateStatus = 'InProgress';
    f.pendingReads = 1;
  }

  function configOf(input: Record<string, unknown>, base: Snapshot): Snapshot {
    const env = input['Environment'] as { Variables?: Record<string, string> } | undefined;
    const image = input['ImageConfig'] as { Command?: string[] } | undefined;
    return {
      ...base,
      ...(env?.Variables ? { variables: { ...env.Variables } } : {}),
      ...(image?.Command ? { command: [...image.Command] } : {}),
      ...(typeof input['MemorySize'] === 'number' ? { memory: input['MemorySize'] } : {}),
      ...(typeof input['Timeout'] === 'number' ? { timeout: input['Timeout'] } : {}),
      ...(typeof input['Role'] === 'string' ? { role: input['Role'] } : {}),
    };
  }

  const lambda: Record<string, (input: Record<string, unknown>) => unknown> = {
    GetFunctionCommand(input) {
      const f = fn(input);
      if (f.pendingReads > 0) {
        f.pendingReads -= 1;
      } else if (f.lastUpdateStatus === 'InProgress') {
        f.state = 'Active';
        f.lastUpdateStatus = 'Successful';
      }
      return {
        Configuration: { FunctionArn: f.arn, State: f.state, LastUpdateStatus: f.lastUpdateStatus },
        Code: { ImageUri: f.latest.imageUri },
        Tags: { ...f.tags },
      };
    },
    CreateFunctionCommand(input) {
      const name = asString(input['FunctionName']);
      if (functions.has(name)) throw simError('ResourceConflictException', 409);
      const code = input['Code'] as { ImageUri: string };
      const f: SimLambdaFunction = {
        name,
        arn: `arn:aws:lambda:${SIM_REGION}:${SIM_ACCOUNT}:function:${name}`,
        state: 'Pending',
        lastUpdateStatus: 'InProgress',
        pendingReads: 1,
        latest: configOf(input, {
          imageUri: code.ImageUri,
          variables: {},
          command: [],
          memory: 128,
          timeout: 3,
          role: '',
        }),
        tags: { ...(input['Tags'] as Record<string, string>) },
        versions: [],
        aliases: new Map(),
        urls: new Map(),
        provisioned: new Map(),
      };
      functions.set(name, f);
      logGroups.add(`/aws/lambda/${name}`);
      return { FunctionArn: f.arn };
    },
    UpdateFunctionConfigurationCommand(input) {
      const f = fn(input);
      begin(f);
      f.latest = configOf(input, f.latest);
      return {};
    },
    UpdateFunctionCodeCommand(input) {
      const f = fn(input);
      begin(f);
      f.latest = { ...f.latest, imageUri: asString(input['ImageUri']) };
      return {};
    },
    PublishVersionCommand(input) {
      const f = fn(input);
      if (f.lastUpdateStatus === 'InProgress') throw simError('ResourceConflictException', 409);
      const last = f.versions.at(-1);
      // Lambda publishes nothing new for unchanged code and configuration.
      if (last && JSON.stringify(last.snapshot) === JSON.stringify(f.latest)) {
        return { Version: last.version };
      }
      const version = String(f.versions.length + 1);
      f.versions.push({ version, snapshot: { ...f.latest } });
      return { Version: version };
    },
    GetAliasCommand(input) {
      const version = fn(input).aliases.get(asString(input['Name']));
      if (!version) throw simError('ResourceNotFoundException', 404);
      return { FunctionVersion: version };
    },
    CreateAliasCommand(input) {
      const f = fn(input);
      if (f.aliases.has(asString(input['Name']))) throw simError('ResourceConflictException', 409);
      f.aliases.set(asString(input['Name']), asString(input['FunctionVersion']));
      return {};
    },
    UpdateAliasCommand(input) {
      const f = fn(input);
      if (!f.aliases.has(asString(input['Name']))) throw simError('ResourceNotFoundException', 404);
      f.aliases.set(asString(input['Name']), asString(input['FunctionVersion']));
      return {};
    },
    GetFunctionUrlConfigCommand(input) {
      const url = fn(input).urls.get(asString(input['Qualifier']));
      if (!url) throw simError('ResourceNotFoundException', 404);
      return { FunctionUrl: url };
    },
    CreateFunctionUrlConfigCommand(input) {
      const f = fn(input);
      const qualifier = asString(input['Qualifier']);
      if (input['AuthType'] !== 'AWS_IAM') throw simError('InvalidParameterValueException', 400);
      if (!f.aliases.has(qualifier)) throw simError('ResourceNotFoundException', 404);
      const url = `https://${f.name.replace(/[^a-z0-9]/g, '')}x.lambda-url.${SIM_REGION}.on.aws/`;
      f.urls.set(qualifier, url);
      return { FunctionUrl: url };
    },
    TagResourceCommand(input) {
      const f = [...functions.values()].find((x) => x.arn === input['Resource']);
      if (!f) throw simError('ResourceNotFoundException', 404);
      Object.assign(f.tags, input['Tags'] as Record<string, string>);
      return {};
    },
    DeleteFunctionCommand(input) {
      functions.delete(fn(input).name);
      return {};
    },
    PutProvisionedConcurrencyConfigCommand(input) {
      const f = fn(input);
      const qualifier = asString(input['Qualifier']);
      if (!f.aliases.has(qualifier)) throw simError('ResourceNotFoundException', 404);
      f.provisioned.set(qualifier, {
        instances: Number(input['ProvisionedConcurrentExecutions']),
        status: 'IN_PROGRESS',
      });
      return { Status: 'IN_PROGRESS' };
    },
    GetProvisionedConcurrencyConfigCommand(input) {
      const config = fn(input).provisioned.get(asString(input['Qualifier']));
      if (!config) throw simError('ProvisionedConcurrencyConfigNotFoundException', 404);
      const reported = config.status;
      // Ready (or failed) one read after it was put — the clock tick.
      if (config.status === 'IN_PROGRESS')
        config.status = sim.failProvisioning ? 'FAILED' : 'READY';
      return { Status: reported, RequestedProvisionedConcurrentExecutions: config.instances };
    },
    DeleteProvisionedConcurrencyConfigCommand(input) {
      if (!fn(input).provisioned.delete(asString(input['Qualifier']))) {
        throw simError('ProvisionedConcurrencyConfigNotFoundException', 404);
      }
      return {};
    },
    ListFunctionsCommand(input) {
      const all = [...functions.keys()];
      const start = Number(asString(input['Marker']) || '0');
      const page = all.slice(start, start + 2);
      return {
        Functions: page.map((name) => ({ FunctionName: name })),
        ...(start + 2 < all.length ? { NextMarker: String(start + 2) } : {}),
      };
    },
  };

  const ecr: Record<string, (input: Record<string, unknown>) => unknown> = {
    CreateRepositoryCommand(input) {
      const name = asString(input['repositoryName']);
      if (repositories.has(name)) throw simError('RepositoryAlreadyExistsException', 400);
      repositories.add(name);
      return {};
    },
    DeleteRepositoryCommand(input) {
      const name = asString(input['repositoryName']);
      if (!repositories.delete(name)) throw simError('RepositoryNotFoundException', 400);
      return {};
    },
  };

  const secretsManager: Record<string, (input: Record<string, unknown>) => unknown> = {
    CreateSecretCommand(input) {
      const name = asString(input['Name']);
      if (secrets.has(name)) throw simError('ResourceExistsException', 400);
      secrets.set(name, asString(input['SecretString']));
      return {};
    },
    PutSecretValueCommand(input) {
      const name = asString(input['SecretId']);
      if (!secrets.has(name)) throw simError('ResourceNotFoundException', 400);
      secrets.set(name, asString(input['SecretString']));
      return {};
    },
    DeleteSecretCommand(input) {
      if (!secrets.delete(asString(input['SecretId']))) {
        throw simError('ResourceNotFoundException', 400);
      }
      return {};
    },
  };

  const logs: Record<string, (input: Record<string, unknown>) => unknown> = {
    DeleteLogGroupCommand(input) {
      if (!logGroups.delete(asString(input['logGroupName']))) {
        throw simError('ResourceNotFoundException', 400);
      }
      return {};
    },
  };

  const cloudwatch: Record<string, (input: Record<string, unknown>) => unknown> = {
    GetMetricDataCommand(input) {
      const queries = input['MetricDataQueries'] as Array<{
        Id: string;
        MetricStat: { Metric: { MetricName: string; Dimensions: Array<{ Value: string }> } };
      }>;
      const start = (input['StartTime'] as Date).getTime();
      const end = (input['EndTime'] as Date).getTime();
      // One query per page, so the client's paging is exercised.
      const index = Number(asString(input['NextToken']) || '0');
      const query = queries[index]!;
      const name = query.MetricStat.Metric.Dimensions[0]!.Value;
      const points = metrics.filter((m) => m.fn === name && m.at >= start && m.at < end);
      const value = points.reduce(
        (sum, m) =>
          sum + (query.MetricStat.Metric.MetricName === 'Duration' ? m.durationMs : m.invocations),
        0,
      );
      return {
        MetricDataResults: [{ Id: query.Id, Values: points.length ? [value] : [] }],
        ...(index + 1 < queries.length ? { NextToken: String(index + 1) } : {}),
      };
    },
  };

  function stsFor(
    asKey: string | null,
  ): Record<string, (input: Record<string, unknown>) => unknown> {
    return {
      AssumeRoleCommand(input) {
        const n = sessions.length + 1;
        const accessKeyId = `ASIASIM${n}`;
        sessions.push({ roleArn: asString(input['RoleArn']), asKey, accessKeyId });
        return {
          Credentials: {
            AccessKeyId: accessKeyId,
            SecretAccessKey: `sim-session-secret-${n}`,
            SessionToken: `sim-session-token-${n}`,
            Expiration: new Date(clock() + 3_600_000),
          },
        };
      },
    };
  }

  const clientFactory: ServerlessSdkClientFactory = (service, options): ServerlessSdkClient => {
    const credentials = options.credentials;
    const asKey = credentials && typeof credentials === 'object' ? credentials.accessKeyId : null;
    const handlers =
      service === 'lambda'
        ? lambda
        : service === 'ecr'
          ? ecr
          : service === 'secrets'
            ? secretsManager
            : service === 'logs'
              ? logs
              : service === 'cloudwatch'
                ? cloudwatch
                : stsFor(asKey);
    return {
      async send(command: unknown) {
        // A client that signs with the provider resolves it, as the SDK does.
        if (typeof credentials === 'function') await credentials();
        const name = (command as object).constructor.name;
        const input = { ...((command as { input?: Record<string, unknown> }).input ?? {}) };
        calls.push({ service, command: name, input });
        const failure = failures.findIndex((f) => f.command === name && f.matches(input));
        if (failure >= 0) {
          const [f] = failures.splice(failure, 1);
          throw simError(f!.code, f!.status);
        }
        const handler = handlers[name];
        if (!handler) throw new Error(`the Lambda simulator does not answer ${service} ${name}`);
        return handler(input);
      },
    };
  };

  const sim: LambdaSim = {
    calls,
    functions,
    repositories,
    secrets,
    logGroups,
    metrics,
    sessions,
    clientFactory,
    failNext(command, matches = () => true, code = 'ServiceException', status = 503) {
      failures.push({ command, matches, code, status });
    },
    advanceSeconds(seconds) {
      const at = clock();
      for (const f of functions.values()) {
        if (f.aliases.has('live')) {
          metrics.push({ fn: f.name, at, durationMs: seconds * 1000, invocations: seconds });
        }
      }
    },
    invoke(url, headers) {
      const target = [...functions.values()].find((f) => [...f.urls.values()].includes(url));
      if (!target) return 404;
      const auth = headers['authorization'] ?? '';
      const key =
        /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/[a-z0-9-]+\/lambda\/aws4_request,/.exec(
          auth,
        )?.[1];
      return key && sessions.some((s) => s.accessKeyId === key) ? 200 : 403;
    },
    liveSnapshot(name) {
      const f = functions.get(name);
      const version = f?.aliases.get('live');
      return f?.versions.find((v) => v.version === version)?.snapshot ?? null;
    },
    failProvisioning: false,
    callCount: () => calls.length,
  };
  return sim;
}
