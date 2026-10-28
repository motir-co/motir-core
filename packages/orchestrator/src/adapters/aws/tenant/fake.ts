import { createHash } from 'node:crypto';
import type {
  TenantClients,
  TenantCloudFormation,
  TenantRdsData,
  TenantSecretsManager,
  TenantSqlValue,
  TenantStack,
  TenantStackWrite,
  TenantStatement,
} from './clients';
import type {
  TenantEcs,
  TenantEcsDeployment,
  TenantEcsTask,
  TenantElb,
  TenantSsm,
  TenantTargetHealth,
} from './container/ecsClient';
import { AwsTenantApiError } from './errors';
import type {
  TenantCloudWatch,
  TenantFunctionState,
  TenantLambda,
  TenantMetricSum,
} from './function/lambdaClient';

// The FAULT-INJECTING FAKE of a tenant account (MOTIR-10004): CloudFormation held
// in memory by stack name, with the state machine's in-progress states, and a
// control that makes the Nth call of a named operation throw — before it acts
// (the request never landed) or after (it landed, the answer was lost). A test
// cuts a run off at every call in turn and replays it. Later cards add their
// services' fakes to the same bundle.

export type FakeCloudFormationOperation = keyof TenantCloudFormation;

export interface FakeStackRecord {
  status: string;
  templateBody: string;
  parameters: Record<string, string>;
  tags: Record<string, string>;
  outputs: Record<string, string>;
  /** Describes left before an in-progress state settles. */
  pendingPolls: number;
  settlesTo: string;
  /** What the stack becomes when it settles. */
  next: TenantStackWrite | null;
  createdAt: Date;
}

export interface FakeTenantCloudFormation extends TenantCloudFormation {
  readonly stacks: ReadonlyMap<string, FakeStackRecord>;
  /** Every call made, in order: `operation:stackName`. */
  readonly calls: string[];
  /** The `n`th call (1-based, counted from now) of `operation` throws — `before`
   *  it acts, or `after` it has. */
  failAt(operation: FakeCloudFormationOperation, n: number, when?: 'before' | 'after'): void;
  /** The next create of `name` fails and rolls back (`ROLLBACK_COMPLETE`). */
  failNextCreate(name: string): void;
  /** Put a stack in any state, as another actor would. */
  setStatus(name: string, status: string, pendingPolls?: number, settlesTo?: string): void;
  /** How many describes an in-progress state lasts (default 1). */
  pollsToSettle: number;
}

export interface FakeTenantCloudFormationOptions {
  /** A stack's outputs from its name and parameters (default: every parameter
   *  echoed, plus `StackName`). */
  readonly outputs?: (
    name: string,
    parameters: Readonly<Record<string, string>>,
    generation: number,
  ) => Record<string, string>;
  /** Told when a stack's delete completes. */
  readonly onDeleted?: (name: string) => void;
  /** The clock a create is stamped with. */
  readonly now?: () => Date;
}

export function createFakeTenantCloudFormation(
  options: FakeTenantCloudFormationOptions = {},
): FakeTenantCloudFormation {
  const outputsOf = options.outputs ?? ((name, parameters) => ({ StackName: name, ...parameters }));
  const now = options.now ?? (() => new Date());
  const stacks = new Map<string, FakeStackRecord>();
  const calls: string[] = [];
  const faults: Array<{ operation: string; at: number; when: 'before' | 'after' }> = [];
  const counts = new Map<string, number>();
  const failingCreates = new Set<string>();
  // Each create is a new stack id; a re-created stack's suffix differs.
  let generation = 0;
  const generations = new Map<string, number>();

  /** Counts the call; throws when a `before` fault is due; answers whether an
   *  `after` fault is. */
  function enter(operation: FakeCloudFormationOperation, name: string): boolean {
    calls.push(`${operation}:${name}`);
    const count = (counts.get(operation) ?? 0) + 1;
    counts.set(operation, count);
    const index = faults.findIndex((f) => f.operation === operation && f.at === count);
    if (index < 0) return false;
    const [fault] = faults.splice(index, 1);
    if (fault!.when === 'before') throw injected();
    return true;
  }
  const injected = () => new AwsTenantApiError('cloudformation', 'InjectedFault', null);

  function missing(name: string): AwsTenantApiError {
    return new AwsTenantApiError('cloudformation', `ValidationError:${name}`, 400);
  }

  function snapshot(name: string, record: FakeStackRecord): TenantStack {
    return {
      name,
      status: record.status,
      parameters: { ...record.parameters },
      tags: { ...record.tags },
      outputs: { ...record.outputs },
      createdAt: record.createdAt,
    };
  }

  function settle(name: string, record: FakeStackRecord): void {
    record.status = record.settlesTo;
    if (record.status === 'DELETE_COMPLETE') {
      stacks.delete(name);
      options.onDeleted?.(name);
      return;
    }
    const next = record.next;
    if (next && (record.status === 'CREATE_COMPLETE' || record.status === 'UPDATE_COMPLETE')) {
      record.templateBody = next.templateBody;
      record.parameters = { ...next.parameters };
      record.tags = { ...next.tags };
      record.outputs = outputsOf(name, next.parameters, generations.get(name) ?? 0);
    }
    record.next = null;
  }

  const fake: FakeTenantCloudFormation = {
    stacks,
    calls,
    pollsToSettle: 1,

    failAt(operation, n, when = 'before') {
      faults.push({ operation, at: (counts.get(operation) ?? 0) + n, when });
    },
    failNextCreate(name) {
      failingCreates.add(name);
    },
    setStatus(name, status, pendingPolls = 0, settlesTo = status) {
      const record = stacks.get(name);
      if (!record) throw missing(name);
      Object.assign(record, { status, pendingPolls, settlesTo });
    },

    async describeStack(name) {
      const lost = enter('describeStack', name);
      const record = stacks.get(name);
      let answer: TenantStack | null = null;
      if (record) {
        if (record.status.endsWith('_IN_PROGRESS')) {
          if (record.pendingPolls <= 0) settle(name, record);
          else record.pendingPolls -= 1;
        }
        answer = stacks.has(name) ? snapshot(name, record) : null;
      }
      if (lost) throw injected();
      return answer;
    },

    async getTemplateBody(name) {
      const lost = enter('getTemplateBody', name);
      const record = stacks.get(name);
      if (!record) throw missing(name);
      if (lost) throw injected();
      return record.templateBody;
    },

    async createStack(input) {
      const lost = enter('createStack', input.name);
      if (stacks.has(input.name)) {
        throw new AwsTenantApiError('cloudformation', 'AlreadyExistsException', 400);
      }
      const fails = failingCreates.delete(input.name);
      generations.set(input.name, (generation += 1));
      stacks.set(input.name, {
        status: 'CREATE_IN_PROGRESS',
        templateBody: input.templateBody,
        parameters: { ...input.parameters },
        tags: { ...input.tags },
        outputs: {},
        pendingPolls: fake.pollsToSettle,
        settlesTo: fails ? 'ROLLBACK_COMPLETE' : 'CREATE_COMPLETE',
        next: fails ? null : input,
        createdAt: now(),
      });
      if (lost) throw injected();
    },

    async updateStack(input) {
      const lost = enter('updateStack', input.name);
      const record = stacks.get(input.name);
      if (!record) throw missing(input.name);
      if (record.status.endsWith('_IN_PROGRESS')) {
        throw new AwsTenantApiError('cloudformation', 'ValidationError:InProgress', 400);
      }
      const unchanged =
        record.templateBody === input.templateBody &&
        JSON.stringify(record.parameters) === JSON.stringify(input.parameters) &&
        JSON.stringify(record.tags) === JSON.stringify(input.tags);
      if (!unchanged) {
        Object.assign(record, {
          status: 'UPDATE_IN_PROGRESS',
          pendingPolls: fake.pollsToSettle,
          settlesTo: 'UPDATE_COMPLETE',
          next: input,
        });
      }
      if (lost) throw injected();
      return unchanged ? 'no_change' : 'updating';
    },

    async deleteStack(name) {
      const lost = enter('deleteStack', name);
      const record = stacks.get(name);
      if (record && !record.status.endsWith('_IN_PROGRESS')) {
        Object.assign(record, {
          status: 'DELETE_IN_PROGRESS',
          pendingPolls: fake.pollsToSettle,
          settlesTo: 'DELETE_COMPLETE',
          next: null,
        });
      }
      if (lost) throw injected();
    },
  };
  return fake;
}

// ── RDS Data API and Secrets Manager (MOTIR-10007) ──────────────────────────

export type FakeTenantOperation =
  | FakeCloudFormationOperation
  | 'executeStatement'
  | 'getSecretValue'
  | 'putSecretValue';

/** Faults counted per operation, as the CloudFormation fake counts them. */
function faultCounter(service: string) {
  const faults: Array<{ operation: string; at: number; when: 'before' | 'after' }> = [];
  const counts = new Map<string, number>();
  return {
    failAt(operation: string, n: number, when: 'before' | 'after' = 'before') {
      faults.push({ operation, at: (counts.get(operation) ?? 0) + n, when });
    },
    /** Throws for a `before` fault; answers whether an `after` one is due. */
    enter(operation: string): boolean {
      const count = (counts.get(operation) ?? 0) + 1;
      counts.set(operation, count);
      const index = faults.findIndex((f) => f.operation === operation && f.at === count);
      if (index < 0) return false;
      const [fault] = faults.splice(index, 1);
      if (fault!.when === 'before') throw new AwsTenantApiError(service, 'InjectedFault', null);
      return true;
    },
    injected: () => new AwsTenantApiError(service, 'InjectedFault', null),
  };
}

/** A role on the fake cluster. */
export interface FakeDatabaseRole {
  password: string;
}

export interface FakeTenantRdsData extends TenantRdsData {
  /** Roles by name, and databases by name with their owner. */
  readonly roles: Map<string, FakeDatabaseRole>;
  readonly databases: Map<string, { owner: string }>;
  /** Every statement run, in order. */
  readonly statements: TenantStatement[];
  failAt(operation: 'executeStatement', n: number, when?: 'before' | 'after'): void;
  /** The next `n` statements answer that the cluster is resuming. */
  resumingFor(n: number): void;
}

const ident = String.raw`"([a-z0-9_]+)"`;

/** The fake cluster: understands exactly the statements the database module
 *  sends, and refuses anything else. */
export function createFakeTenantRdsData(mainDatabase = 'app'): FakeTenantRdsData {
  const roles = new Map<string, FakeDatabaseRole>();
  const databases = new Map<string, { owner: string }>([[mainDatabase, { owner: 'motir_master' }]]);
  const statements: TenantStatement[] = [];
  const counter = faultCounter('rds-data');
  let resuming = 0;

  function run(statement: TenantStatement): TenantSqlValue[][] {
    const { sql } = statement;
    const p = statement.parameters ?? {};
    let m: RegExpExecArray | null;
    if (/^SELECT 1 FROM pg_roles WHERE rolname = :name$/.test(sql)) {
      return roles.has(p['name']!) ? [[1]] : [];
    }
    if (/^SELECT 1 FROM pg_database WHERE datname = :name$/.test(sql)) {
      return databases.has(p['name']!) ? [[1]] : [];
    }
    if ((m = new RegExp(`^CREATE ROLE ${ident} WITH LOGIN PASSWORD '([A-Za-z0-9]+)'$`).exec(sql))) {
      if (roles.has(m[1]!)) throw new AwsTenantApiError('rds-data', 'DuplicateObject', 400);
      roles.set(m[1]!, { password: m[2]! });
      return [];
    }
    if ((m = new RegExp(`^ALTER ROLE ${ident} WITH LOGIN PASSWORD '([A-Za-z0-9]+)'$`).exec(sql))) {
      const role = roles.get(m[1]!);
      if (!role) throw new AwsTenantApiError('rds-data', 'UndefinedObject', 400);
      role.password = m[2]!;
      return [];
    }
    if ((m = new RegExp(`^GRANT ${ident} TO CURRENT_USER$`).exec(sql))) {
      if (!roles.has(m[1]!)) throw new AwsTenantApiError('rds-data', 'UndefinedObject', 400);
      return [];
    }
    if ((m = new RegExp(`^CREATE DATABASE ${ident} OWNER ${ident}$`).exec(sql))) {
      if (databases.has(m[1]!)) throw new AwsTenantApiError('rds-data', 'DuplicateDatabase', 400);
      databases.set(m[1]!, { owner: m[2]! });
      return [];
    }
    if ((m = new RegExp(`^ALTER DATABASE ${ident} OWNER TO ${ident}$`).exec(sql))) {
      databases.set(m[1]!, { owner: m[2]! });
      return [];
    }
    if ((m = new RegExp(`^DROP DATABASE IF EXISTS ${ident} WITH \\(FORCE\\)$`).exec(sql))) {
      databases.delete(m[1]!);
      return [];
    }
    if ((m = new RegExp(`^DROP ROLE IF EXISTS ${ident}$`).exec(sql))) {
      roles.delete(m[1]!);
      return [];
    }
    throw new AwsTenantApiError('rds-data', 'UnsupportedStatement', 400);
  }

  return {
    roles,
    databases,
    statements,
    failAt: (operation, n, when) => counter.failAt(operation, n, when),
    resumingFor(n) {
      resuming = n;
    },
    async executeStatement(statement) {
      const lost = counter.enter('executeStatement');
      if (resuming > 0) {
        resuming -= 1;
        throw new AwsTenantApiError('rds-data', 'DatabaseResumingException', 400);
      }
      statements.push(statement);
      const rows = run(statement);
      if (lost) throw counter.injected();
      return rows;
    },
  };
}

export interface FakeTenantSecretsManager extends TenantSecretsManager {
  /** Secret values by ARN. A secret a stack generated reads as
   *  `{"password":…}` the first time it is asked for. */
  readonly values: Map<string, string>;
  /** Values put under a version id, by `<arn>@<versionId>`. */
  readonly versions: Map<string, string>;
  readonly calls: string[];
  failAt(
    operation: 'getSecretValue' | 'putSecretValue',
    n: number,
    when?: 'before' | 'after',
  ): void;
}

/** A generated password, deterministic per secret. */
export function fakeGeneratedPassword(secretArn: string): string {
  return createHash('sha256').update(secretArn).digest('hex').slice(0, 32);
}

export function createFakeTenantSecretsManager(): FakeTenantSecretsManager {
  const values = new Map<string, string>();
  const versions = new Map<string, string>();
  const calls: string[] = [];
  const counter = faultCounter('secretsmanager');
  return {
    values,
    versions,
    calls,
    failAt: (operation, n, when) => counter.failAt(operation, n, when),
    async getSecretValue(secretId) {
      calls.push(`getSecretValue:${secretId}`);
      const lost = counter.enter('getSecretValue');
      if (!values.has(secretId)) {
        if (!secretId.startsWith('arn:aws:secretsmanager:')) {
          throw new AwsTenantApiError('secretsmanager', 'ResourceNotFoundException', 400);
        }
        values.set(secretId, JSON.stringify({ password: fakeGeneratedPassword(secretId) }));
      }
      if (lost) throw counter.injected();
      return values.get(secretId)!;
    },
    async putSecretValue(secretId, value, versionId) {
      calls.push(`putSecretValue:${secretId}`);
      const lost = counter.enter('putSecretValue');
      if (versionId) {
        const key = `${secretId}@${versionId}`;
        const held = versions.get(key);
        // AWS ignores the same value under the same id, and refuses another.
        if (held !== undefined && held !== value) {
          throw new AwsTenantApiError('secretsmanager', 'ResourceExistsException', 400);
        }
        versions.set(key, value);
      }
      values.set(secretId, value);
      if (lost) throw counter.injected();
    },
  };
}

/** The outputs the tenant templates give, for the stack names the README
 *  fixes — so a fake account answers like a real one. Any other stack echoes. */
export function fakeTenantStackOutputs(
  accountId: string,
  region: string,
): (
  name: string,
  parameters: Readonly<Record<string, string>>,
  generation: number,
) => Record<string, string> {
  const secret = (name: string, generation: number) =>
    `arn:aws:secretsmanager:${region}:${accountId}:secret:${name}-g${generation}`;
  return (name, parameters, generation): Record<string, string> => {
    if (name === 'motir-network') {
      return {
        VpcId: 'vpc-fake',
        PrivateSubnetIds: 'subnet-private-a,subnet-private-b',
        PublicSubnetIds: 'subnet-public-a,subnet-public-b',
        DatabaseSecurityGroupId: 'sg-database',
        AppSecurityGroupId: 'sg-app',
        AlbArn: `arn:aws:elasticloadbalancing:${region}:${accountId}:loadbalancer/app/motir-tenant/1`,
        AlbListenerArn: `arn:aws:elasticloadbalancing:${region}:${accountId}:listener/app/motir-tenant/1/2`,
        AlbDnsName: `motir-tenant-1.${region}.elb.amazonaws.com`,
      };
    }
    let m = /^motir-database-([a-z0-9]+)$/.exec(name);
    if (m) {
      return {
        ClusterArn: `arn:aws:rds:${region}:${accountId}:cluster:motir-${m[1]}`,
        ClusterEndpoint: `motir-${m[1]}.cluster-fake.${region}.rds.amazonaws.com`,
        MasterSecretArn: secret(`motir/${m[1]}/database-master`, generation),
        ProductionConnectionSecretArn: secret(`motir/${m[1]}/production/database`, generation),
        DatabaseName: 'app',
      };
    }
    m = /^motir-database-([a-z0-9]+)-pr([0-9]+)$/.exec(name);
    if (m) {
      return { PreviewSecretArn: secret(`motir/${m[1]}/preview-${m[2]}/database`, generation) };
    }
    m = /^motir-registry-([a-z0-9]+)$/.exec(name);
    if (m) {
      const registry = `${accountId}.dkr.ecr.${region}.amazonaws.com/mh/${m[1]}`;
      const role = (environment: string) =>
        `arn:aws:iam::${accountId}:role/mh-${m![1]}-${environment}-push`;
      return {
        PreviewRepositoryUri: `${registry}/preview`,
        ProductionRepositoryUri: `${registry}/production`,
        PreviewPushRoleArn: role('preview'),
        ProductionPushRoleArn: role('production'),
      };
    }
    return { StackName: name, ...parameters };
  };
}

// ── Lambda and CloudWatch (MOTIR-10008) ─────────────────────────────────────

/** One function, as the release stack made it. */
export interface FakeFunction {
  /** Published versions and the description each was published with. */
  readonly versions: Map<string, string>;
  /** The version the stack's own Version resource holds. */
  stackVersion: string | null;
  stackDescription: string | null;
  /** Where `live` points, which a rollback moves outside the stack. */
  alias: string | null;
  readonly url: string;
  readonly arn: string;
}

export type FakeLambdaOperation = keyof TenantLambda;

export interface FakeTenantLambda extends TenantLambda {
  readonly functions: Map<string, FakeFunction>;
  /** Every call made, in order: `operation:functionName`. */
  readonly calls: string[];
  /** A version's state; every version is `active` unless set. */
  setState(functionName: string, version: string, state: TenantFunctionState): void;
  failAt(operation: FakeLambdaOperation, n: number, when?: 'before' | 'after'): void;
  /** What the release stack does to the function when it settles: create it,
   *  publish a version when the image or config hash changed, point `live` at
   *  the stack's version. Answers the stack's outputs. */
  applyReleaseStack(
    parameters: Readonly<Record<string, string>>,
    generation: number,
  ): Record<string, string>;
  /** The release stack's delete removes the function and every version. */
  removeFunction(functionName: string): void;
}

export function createFakeTenantLambda(accountId: string, region: string): FakeTenantLambda {
  const functions = new Map<string, FakeFunction>();
  const states = new Map<string, TenantFunctionState>();
  const calls: string[] = [];
  const counter = faultCounter('lambda');
  const missing = () => new AwsTenantApiError('lambda', 'ResourceNotFoundException', 404);

  async function call<T>(operation: FakeLambdaOperation, name: string, act: () => T): Promise<T> {
    calls.push(`${operation}:${name}`);
    const lost = counter.enter(operation);
    const answer = act();
    if (lost) throw counter.injected();
    return answer;
  }

  return {
    functions,
    calls,
    setState(functionName, version, state) {
      states.set(`${functionName}:${version}`, state);
    },
    failAt: (operation, n, when) => counter.failAt(operation, n, when),

    applyReleaseStack(parameters, generation) {
      const name = parameters['AppRef']!;
      let fn = functions.get(name);
      if (!fn) {
        const id = createHash('sha256').update(`${name}:${generation}`).digest('hex').slice(0, 32);
        fn = {
          versions: new Map(),
          stackVersion: null,
          stackDescription: null,
          alias: null,
          url: `https://${id}.lambda-url.${region}.on.aws/`,
          arn: `arn:aws:lambda:${region}:${accountId}:function:${name}`,
        };
        functions.set(name, fn);
      }
      const outputs: Record<string, string> = {
        FunctionName: name,
        FunctionArn: fn.arn,
        EnvironmentSecretArn: `arn:aws:secretsmanager:${region}:${accountId}:secret:motir/${name}/environment-g${generation}`,
      };
      const hash = parameters['ConfigHash'] ?? '';
      if (!hash) return outputs;
      const description = `${parameters['ImageUri']} ${hash}`;
      if (description !== fn.stackDescription) {
        const version = String(fn.versions.size + 1);
        fn.versions.set(version, description);
        fn.stackVersion = version;
        fn.stackDescription = description;
      }
      fn.alias = fn.stackVersion;
      return { ...outputs, FunctionUrl: fn.url, LiveVersion: fn.stackVersion! };
    },
    removeFunction(functionName) {
      functions.delete(functionName);
    },

    getAlias: (functionName) =>
      call('getAlias', functionName, () => functions.get(functionName)?.alias ?? null),
    updateAlias: (functionName, _alias, version) =>
      call('updateAlias', functionName, () => {
        const fn = functions.get(functionName);
        if (!fn || !fn.versions.has(version)) throw missing();
        fn.alias = version;
      }),
    listVersions: (functionName) =>
      call('listVersions', functionName, () => {
        const fn = functions.get(functionName);
        if (!fn) throw missing();
        return [...fn.versions.keys()];
      }),
    getFunctionState: (functionName, version) =>
      call('getFunctionState', functionName, () => {
        if (!functions.get(functionName)?.versions.has(version)) return null;
        return states.get(`${functionName}:${version}`) ?? 'active';
      }),
  };
}

export interface FakeTenantCloudWatch extends TenantCloudWatch {
  /** The `Duration` sum (ms) each function answers, whatever the window. */
  readonly durationSums: Map<string, number>;
  readonly queries: TenantMetricSum[];
  failAt(operation: 'sumMetric', n: number, when?: 'before' | 'after'): void;
}

export function createFakeTenantCloudWatch(): FakeTenantCloudWatch {
  const durationSums = new Map<string, number>();
  const queries: TenantMetricSum[] = [];
  const counter = faultCounter('cloudwatch');
  return {
    durationSums,
    queries,
    failAt: (operation, n, when) => counter.failAt(operation, n, when),
    async sumMetric(query) {
      const lost = counter.enter('sumMetric');
      queries.push(query);
      const sum =
        query.metricName === 'Duration'
          ? (durationSums.get(query.dimensions['FunctionName'] ?? '') ?? 0)
          : 0;
      if (lost) throw counter.injected();
      return sum;
    },
  };
}

// ── ECS, ELB and SSM (MOTIR-10009) ──────────────────────────────────────────

export interface FakeEcsTask extends TenantEcsTask {
  readonly service: string;
  lastStatus: string;
  stoppedAt: Date | null;
}

export interface FakeEcsService {
  taskDefinition: string;
  desiredCount: number;
  deployments: TenantEcsDeployment[];
  /** Describes left before the rollout in progress settles. */
  pendingPolls: number;
  /** The rollout in progress ends FAILED. */
  failing: boolean;
}

export interface FakeTaskDefinition {
  readonly family: string;
  readonly revision: number;
  active: boolean;
  readonly cpu: number;
  readonly memory: number;
}

export type FakeEcsOperation = keyof TenantEcs;

export interface FakeTenantEcs extends TenantEcs {
  readonly services: Map<string, FakeEcsService>;
  readonly taskDefinitions: Map<string, FakeTaskDefinition>;
  /** Tasks still listed. */
  readonly tasks: FakeEcsTask[];
  readonly calls: string[];
  failAt(operation: FakeEcsOperation, n: number, when?: 'before' | 'after'): void;
  /** How many describes a rollout lasts (default 0: done at once). */
  rolloutPolls: number;
  /** The next rollout of the service ends FAILED. */
  failNextRollout(service: string): void;
  /** ECS drops stopped tasks from its listing after a while. */
  forgetStoppedTasks(): void;
  /** Stop a running task, as a crash would — ECS starts no replacement here. */
  stopTask(taskArn: string): void;
  applyReleaseStack(
    parameters: Readonly<Record<string, string>>,
    generation: number,
  ): Record<string, string>;
  removeService(appRef: string): void;
}

export function createFakeTenantEcs(
  accountId: string,
  region: string,
  now: () => Date,
): FakeTenantEcs {
  const services = new Map<string, FakeEcsService>();
  const taskDefinitions = new Map<string, FakeTaskDefinition>();
  const tasks: FakeEcsTask[] = [];
  const calls: string[] = [];
  const counter = faultCounter('ecs');
  const failing = new Set<string>();
  /** What each release stack last registered: its revision and its inputs. */
  const stackState = new Map<string, { key: string; taskDefinition: string }>();
  let taskSerial = 0;

  async function call<T>(operation: FakeEcsOperation, name: string, act: () => T): Promise<T> {
    calls.push(`${operation}:${name}`);
    const lost = counter.enter(operation);
    const answer = act();
    if (lost) throw counter.injected();
    return answer;
  }

  function startTask(service: string, taskDefinition: string): void {
    const def = taskDefinitions.get(taskDefinition)!;
    taskSerial += 1;
    tasks.push({
      service,
      taskArn: `arn:aws:ecs:${region}:${accountId}:task/${service}/t${String(taskSerial).padStart(4, '0')}`,
      taskDefinition,
      lastStatus: 'RUNNING',
      startedAt: now(),
      stoppedAt: null,
      cpu: def.cpu,
      memory: def.memory,
    });
  }

  function stop(task: FakeEcsTask): void {
    task.lastStatus = 'STOPPED';
    task.stoppedAt = now();
  }

  const running = (service: string) =>
    tasks.filter((t) => t.service === service && t.lastStatus !== 'STOPPED');

  /** Move the service onto `taskDefinition` with `desired` tasks. */
  function rollOut(name: string, svc: FakeEcsService, taskDefinition: string, desired: number) {
    const old = svc.deployments.find((d) => d.status === 'PRIMARY');
    svc.taskDefinition = taskDefinition;
    svc.desiredCount = desired;
    svc.failing = failing.delete(name);
    svc.deployments = [
      { taskDefinition, status: 'PRIMARY', rolloutState: 'IN_PROGRESS' },
      ...(old ? [{ ...old, status: 'ACTIVE' }] : []),
    ];
    if (desired > 0) startTask(name, taskDefinition);
    svc.pendingPolls = fake.rolloutPolls;
    if (svc.pendingPolls <= 0) settle(name, svc);
  }

  function settle(name: string, svc: FakeEcsService): void {
    const primary = svc.deployments[0]!;
    if (svc.failing) {
      for (const t of running(name)) if (t.taskDefinition === primary.taskDefinition) stop(t);
      svc.deployments = [{ ...primary, rolloutState: 'FAILED' }, ...svc.deployments.slice(1)];
      return;
    }
    for (const t of running(name)) if (t.taskDefinition !== primary.taskDefinition) stop(t);
    svc.deployments = [{ ...primary, rolloutState: 'COMPLETED' }];
  }

  const fake: FakeTenantEcs = {
    services,
    taskDefinitions,
    tasks,
    calls,
    rolloutPolls: 0,
    failAt: (operation, n, when) => counter.failAt(operation, n, when),
    failNextRollout(service) {
      failing.add(service);
    },
    forgetStoppedTasks() {
      for (let i = tasks.length - 1; i >= 0; i -= 1) {
        if (tasks[i]!.lastStatus === 'STOPPED') tasks.splice(i, 1);
      }
    },
    stopTask(taskArn) {
      const task = tasks.find((t) => t.taskArn === taskArn);
      if (task) stop(task);
    },

    applyReleaseStack(parameters, generation) {
      const name = parameters['AppRef']!;
      const outputs: Record<string, string> = {
        ClusterArn: `arn:aws:ecs:${region}:${accountId}:cluster/${name}`,
        TargetGroupArn: `arn:aws:elasticloadbalancing:${region}:${accountId}:targetgroup/${name}/g${generation}`,
        EnvironmentSecretArn: `arn:aws:secretsmanager:${region}:${accountId}:secret:motir/${name}/environment-g${generation}`,
      };
      // Unpublished: no task definition, no service.
      if (!parameters['ConfigHash']) return outputs;
      const key = ['ImageUri', 'TaskCpu', 'TaskMemory', 'Port', 'ConfigHash']
        .map((k) => parameters[k] ?? '')
        .join('|');
      const state = stackState.get(name);
      let taskDefinition = state?.taskDefinition ?? '';
      if (key !== state?.key) {
        const revision = [...taskDefinitions.values()].filter((d) => d.family === name).length + 1;
        taskDefinition = `arn:aws:ecs:${region}:${accountId}:task-definition/${name}:${revision}`;
        taskDefinitions.set(taskDefinition, {
          family: name,
          revision,
          active: true,
          cpu: Number(parameters['TaskCpu']),
          memory: Number(parameters['TaskMemory']),
        });
      }
      let svc = services.get(name);
      if (!svc) {
        svc = { taskDefinition, desiredCount: 0, deployments: [], pendingPolls: 0, failing: false };
        services.set(name, svc);
        rollOut(name, svc, taskDefinition, 1);
      } else if (taskDefinition !== state?.taskDefinition) {
        rollOut(name, svc, taskDefinition, 1);
      }
      stackState.set(name, { key, taskDefinition });
      return {
        ...outputs,
        ServiceArn: `arn:aws:ecs:${region}:${accountId}:service/${name}/${name}`,
        ServiceName: name,
        TaskDefinitionArn: taskDefinition,
      };
    },
    removeService(appRef) {
      for (const t of running(appRef)) stop(t);
      services.delete(appRef);
      const state = stackState.get(appRef);
      // The stack deletes its current revision; the replaced ones it retained stay.
      if (state) taskDefinitions.get(state.taskDefinition)!.active = false;
      stackState.delete(appRef);
    },

    describeService: (cluster, service) =>
      call('describeService', service, () => {
        const svc = services.get(service);
        if (!svc || cluster !== service) return null;
        if (svc.deployments[0]?.rolloutState === 'IN_PROGRESS') {
          if (svc.pendingPolls <= 0) settle(service, svc);
          else svc.pendingPolls -= 1;
        }
        return {
          taskDefinition: svc.taskDefinition,
          desiredCount: svc.desiredCount,
          runningCount: running(service).filter((t) => t.taskDefinition === svc.taskDefinition)
            .length,
          deployments: svc.deployments.map((d) => ({ ...d })),
        };
      }),
    updateService: (_cluster, service, taskDefinition) =>
      call('updateService', service, () => {
        const svc = services.get(service);
        if (!svc || !taskDefinitions.get(taskDefinition)?.active) {
          throw new AwsTenantApiError('ecs', 'InvalidParameterException', 400);
        }
        rollOut(service, svc, taskDefinition, svc.desiredCount);
      }),
    listTaskDefinitions: (family) =>
      call('listTaskDefinitions', family, () =>
        [...taskDefinitions.entries()]
          .filter(([, d]) => d.family === family && d.active)
          .sort(([, a], [, b]) => a.revision - b.revision)
          .map(([arn]) => arn),
      ),
    deregisterTaskDefinition: (taskDefinition) =>
      call('deregisterTaskDefinition', taskDefinition, () => {
        const def = taskDefinitions.get(taskDefinition);
        if (def) def.active = false;
      }),
    listTasks: (_cluster, service) =>
      call('listTasks', service, () =>
        tasks
          .filter((t) => t.service === service)
          .map(({ service: _service, ...task }) => ({ ...task })),
      ),
  };
  return fake;
}

export interface FakeTenantElb extends TenantElb {
  /** Each release's listener rule priority, by app. */
  readonly rules: Map<string, number>;
  /** Apps whose targets fail their health check. */
  readonly unhealthy: Set<string>;
  readonly calls: string[];
  failAt(operation: keyof TenantElb, n: number, when?: 'before' | 'after'): void;
}

/** Target health follows the fake ECS: a running task of the service's current
 *  revision is a target, `initial` while its rollout is in progress. */
export function createFakeTenantElb(ecs: FakeTenantEcs): FakeTenantElb {
  const rules = new Map<string, number>();
  const unhealthy = new Set<string>();
  const calls: string[] = [];
  const counter = faultCounter('elasticloadbalancing');
  async function call<T>(operation: keyof TenantElb, name: string, act: () => T): Promise<T> {
    calls.push(`${operation}:${name}`);
    const lost = counter.enter(operation);
    const answer = act();
    if (lost) throw counter.injected();
    return answer;
  }
  return {
    rules,
    unhealthy,
    calls,
    failAt: (operation, n, when) => counter.failAt(operation, n, when),
    describeTargetHealth: (targetGroupArn) =>
      call('describeTargetHealth', targetGroupArn, () => {
        const app = targetGroupArn.split('/')[1]!;
        const svc = ecs.services.get(app);
        if (!svc) throw new AwsTenantApiError('elasticloadbalancing', 'TargetGroupNotFound', 400);
        const settling = svc.deployments[0]?.rolloutState === 'IN_PROGRESS';
        return ecs.tasks
          .filter((t) => t.service === app && t.lastStatus !== 'STOPPED')
          .filter((t) => t.taskDefinition === svc.taskDefinition)
          .map<TenantTargetHealth>(() =>
            settling ? 'initial' : unhealthy.has(app) ? 'unhealthy' : 'healthy',
          );
      }),
    listRulePriorities: (listenerArn) =>
      call('listRulePriorities', listenerArn, () => [...rules.values()]),
  };
}

export interface FakeTenantSsm extends TenantSsm {
  readonly parameters: Map<string, { value: string; tags: Record<string, string> }>;
  readonly calls: string[];
  failAt(operation: keyof TenantSsm, n: number, when?: 'before' | 'after'): void;
}

export function createFakeTenantSsm(): FakeTenantSsm {
  const parameters = new Map<string, { value: string; tags: Record<string, string> }>();
  const calls: string[] = [];
  const counter = faultCounter('ssm');
  async function call<T>(operation: keyof TenantSsm, name: string, act: () => T): Promise<T> {
    calls.push(`${operation}:${name}`);
    const lost = counter.enter(operation);
    const answer = act();
    if (lost) throw counter.injected();
    return answer;
  }
  return {
    parameters,
    calls,
    failAt: (operation, n, when) => counter.failAt(operation, n, when),
    getParameter: (name) => call('getParameter', name, () => parameters.get(name)?.value ?? null),
    putParameter: (name, value, tags) =>
      call('putParameter', name, () => {
        parameters.set(name, { value, tags: { ...parameters.get(name)?.tags, ...tags } });
      }),
    deleteParameter: (name) =>
      call('deleteParameter', name, () => {
        parameters.delete(name);
      }),
  };
}

/** A container release stack: the release template's parameters. */
const isContainerRelease = (name: string, parameters: Readonly<Record<string, string>>) =>
  name.startsWith('motir-release-') && 'TaskCpu' in parameters;

/** A function release stack: the release template's parameters. */
const isFunctionRelease = (name: string, parameters: Readonly<Record<string, string>>) =>
  name.startsWith('motir-release-') && 'InvokePrincipalArn' in parameters;

/** A tenant account's clients, all fakes. A release stack's outputs come from
 *  the fake Lambda or ECS, which it creates, publishes and deletes. */
export function createFakeTenantClients(
  options: FakeTenantCloudFormationOptions & { accountId?: string; region?: string } = {},
): TenantClients & {
  readonly cloudformation: FakeTenantCloudFormation;
  readonly rdsData: FakeTenantRdsData;
  readonly secretsManager: FakeTenantSecretsManager;
  readonly lambda: FakeTenantLambda;
  readonly cloudwatch: FakeTenantCloudWatch;
  readonly ecs: FakeTenantEcs;
  readonly elb: FakeTenantElb;
  readonly ssm: FakeTenantSsm;
} {
  const accountId = options.accountId ?? '210987654321';
  const region = options.region ?? 'us-east-1';
  const now = options.now ?? (() => new Date());
  const lambda = createFakeTenantLambda(accountId, region);
  const ecs = createFakeTenantEcs(accountId, region, now);
  const elb = createFakeTenantElb(ecs);
  const templates = fakeTenantStackOutputs(accountId, region);
  return {
    accountId,
    region,
    cloudformation: createFakeTenantCloudFormation({
      outputs:
        options.outputs ??
        ((name, parameters, generation) => {
          if (isFunctionRelease(name, parameters)) {
            return lambda.applyReleaseStack(parameters, generation);
          }
          if (isContainerRelease(name, parameters)) {
            elb.rules.set(parameters['AppRef']!, Number(parameters['ListenerRulePriority']));
            return ecs.applyReleaseStack(parameters, generation);
          }
          return templates(name, parameters, generation);
        }),
      onDeleted: (name) => {
        options.onDeleted?.(name);
        if (!name.startsWith('motir-release-')) return;
        const appRef = name.slice('motir-release-'.length);
        lambda.removeFunction(appRef);
        if (ecs.services.has(appRef)) ecs.removeService(appRef);
        elb.rules.delete(appRef);
      },
      now,
    }),
    rdsData: createFakeTenantRdsData(),
    secretsManager: createFakeTenantSecretsManager(),
    lambda,
    cloudwatch: createFakeTenantCloudWatch(),
    ecs,
    elb,
    ssm: createFakeTenantSsm(),
  };
}
