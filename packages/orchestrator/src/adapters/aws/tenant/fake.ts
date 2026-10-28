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
import { AwsTenantApiError } from './errors';

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
}

export function createFakeTenantCloudFormation(
  options: FakeTenantCloudFormationOptions = {},
): FakeTenantCloudFormation {
  const outputsOf = options.outputs ?? ((name, parameters) => ({ StackName: name, ...parameters }));
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
    };
  }

  function settle(name: string, record: FakeStackRecord): void {
    record.status = record.settlesTo;
    if (record.status === 'DELETE_COMPLETE') {
      stacks.delete(name);
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
  const calls: string[] = [];
  const counter = faultCounter('secretsmanager');
  return {
    values,
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
    async putSecretValue(secretId, value) {
      calls.push(`putSecretValue:${secretId}`);
      const lost = counter.enter('putSecretValue');
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
    return { StackName: name, ...parameters };
  };
}

/** A tenant account's clients, all fakes. */
export function createFakeTenantClients(
  options: FakeTenantCloudFormationOptions & { accountId?: string; region?: string } = {},
): TenantClients & {
  readonly cloudformation: FakeTenantCloudFormation;
  readonly rdsData: FakeTenantRdsData;
  readonly secretsManager: FakeTenantSecretsManager;
} {
  const accountId = options.accountId ?? '210987654321';
  const region = options.region ?? 'us-east-1';
  return {
    accountId,
    region,
    cloudformation: createFakeTenantCloudFormation({
      outputs: options.outputs ?? fakeTenantStackOutputs(accountId, region),
    }),
    rdsData: createFakeTenantRdsData(),
    secretsManager: createFakeTenantSecretsManager(),
  };
}
