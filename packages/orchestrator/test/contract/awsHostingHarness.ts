import {
  AwsTenantApiError,
  createAwsHostingDeployPort,
  createFakeTenantClients,
  type AwsHostingDeps,
  type AwsHostingLogLine,
  type HostingDeployPort,
  type TenantClients,
} from '../../src/index';

// THE REAL AWS ADAPTER OVER THE FAKE TENANT ACCOUNT, for the story test gate
// (MOTIR-10012): the shared deploy contract, the cut-off sweeps and the secrecy
// scan all build it here. Every client call the adapter makes goes through ONE
// recorder, numbered across all eight clients, so "fail the Nth call" means one
// call anywhere in the run — CloudFormation, the Data API, Secrets Manager,
// Lambda, CloudWatch, ECS, ELB or SSM.

export const AWS_ORG = 'cmorg1';
export const AWS_ACCOUNT = '210987654321';
export const AWS_REGION = 'us-east-1';
export const AWS_CUSTOMER = 'cmcustomer1';
export const AWS_ORIGIN_KEY = 'origin-key-do-not-leak';
export const AWS_FORWARDER = 'arn:aws:iam::576360162297:role/motir-hosting-forwarder';
const GITHUB = { githubRepositoryId: '7001', githubOwnerId: '9002' };

const SERVICES = [
  'cloudformation',
  'rdsData',
  'secretsManager',
  'lambda',
  'cloudwatch',
  'ecs',
  'elb',
  'ssm',
] as const;

/** Every adapter call, in order, as `service.operation`, and the one fault. */
export interface CallRecorder {
  readonly calls: string[];
  /** The `n`th call from now (1-based) fails — `before` it acts (it never
   *  landed) or `after` it has (it landed and the answer was lost). */
  failAt(n: number, when?: 'before' | 'after'): void;
}

/** The bundle with every service wrapped by one shared recorder. The fakes'
 *  own controls (`stacks`, `failAt`, …) pass through untouched. */
export function recordingClients<C extends TenantClients>(
  inner: C,
): { clients: C; recorder: CallRecorder } {
  const calls: string[] = [];
  let fault: { at: number; when: 'before' | 'after' } | null = null;
  const recorder: CallRecorder = {
    calls,
    failAt(n, when = 'before') {
      fault = { at: calls.length + n, when };
    },
  };
  const wrap = (service: string, client: object): object =>
    new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function' || typeof prop !== 'string') return value;
        return async (...args: unknown[]) => {
          calls.push(`${service}.${prop}`);
          const due = fault?.at === calls.length ? fault : null;
          if (due) fault = null;
          if (due?.when === 'before') throw new AwsTenantApiError(service, 'InjectedFault', null);
          const answer = await (value as (...a: unknown[]) => unknown).apply(target, args);
          if (due) throw new AwsTenantApiError(service, 'InjectedFault', null);
          return answer;
        };
      },
    });
  const clients = { ...inner } as Record<string, unknown>;
  for (const service of SERVICES) clients[service] = wrap(service, inner[service]);
  return { clients: clients as C, recorder };
}

export type AwsFakeClients = ReturnType<typeof createFakeTenantClients>;

export interface AwsAdapterHarness {
  readonly port: HostingDeployPort;
  readonly deps: AwsHostingDeps;
  /** The fakes themselves, for their stores and their own controls. */
  readonly fakes: AwsFakeClients;
  readonly recorder: CallRecorder;
  readonly logs: AwsHostingLogLine[];
  readonly state: { ready: boolean };
  now(): Date;
  advanceSeconds(seconds: number): void;
}

/** The AWS adapter on a fake tenant account whose clock moves only when told
 *  to (or when the adapter sleeps between polls). */
export function awsAdapterHarness(options: { start?: Date; ready?: boolean } = {}) {
  const clock = { t: (options.start ?? new Date('2026-10-01T00:00:00Z')).getTime() };
  const now = () => new Date(clock.t);
  const fakes = createFakeTenantClients({ accountId: AWS_ACCOUNT, region: AWS_REGION, now });
  fakes.cloudformation.pollsToSettle = 0;
  const { clients, recorder } = recordingClients(fakes);
  const state = { ready: options.ready ?? true };
  const logs: AwsHostingLogLine[] = [];
  const deps: AwsHostingDeps = {
    clientsFor: () => clients,
    region: AWS_REGION,
    ensureTenantAccount: async () =>
      state.ready ? { ready: true, accountId: AWS_ACCOUNT } : { ready: false, accountId: null },
    organizationOf: async () => AWS_ORG,
    isCustomerRepository: async (repositoryId) => repositoryId === AWS_CUSTOMER,
    githubIdsOf: async () => GITHUB,
    forwarderPrincipalArn: AWS_FORWARDER,
    appHostOf: (appRef) => `${appRef}.apps.motir.test`,
    originSecretKey: AWS_ORIGIN_KEY,
    now,
    sleep: async (ms) => {
      clock.t += ms;
    },
    pollMs: 5_000,
    timeoutMs: 600_000,
    log: (line) => logs.push(line),
  };
  const harness: AwsAdapterHarness = {
    port: createAwsHostingDeployPort(deps),
    deps,
    fakes,
    recorder,
    logs,
    state,
    now,
    advanceSeconds(seconds) {
      clock.t += seconds * 1000;
    },
  };
  return harness;
}

const sorted = <T>(entries: Iterable<[string, T]>) =>
  [...entries].sort(([a], [b]) => a.localeCompare(b));

/**
 * Everything the fake tenant account holds, as plain data to deep-compare: every
 * stack (name, status, parameters, tags, outputs), function (versions, alias),
 * ECS service, task definition, running task, listener rule, SSM parameter,
 * secret, database role and database. Times are left out — a replay legitimately
 * runs later — and nothing else is.
 */
export function tenantSnapshot(fakes: AwsFakeClients) {
  return {
    stacks: sorted(fakes.cloudformation.stacks.entries()).map(([name, s]) => ({
      name,
      status: s.status,
      parameters: s.parameters,
      tags: s.tags,
      outputs: s.outputs,
    })),
    functions: sorted(fakes.lambda.functions.entries()).map(([name, f]) => ({
      name,
      versions: sorted(f.versions.entries()),
      live: f.alias,
      url: f.url,
    })),
    services: sorted(fakes.ecs.services.entries()).map(([name, s]) => ({
      name,
      taskDefinition: s.taskDefinition,
      desiredCount: s.desiredCount,
    })),
    taskDefinitions: sorted(fakes.ecs.taskDefinitions.entries()).map(([arn, d]) => ({
      arn,
      active: d.active,
    })),
    runningTasks: fakes.ecs.tasks
      .filter((t) => t.lastStatus !== 'STOPPED')
      .map((t) => `${t.service} ${t.taskDefinition}`)
      .sort(),
    listenerRules: sorted(fakes.elb.rules.entries()),
    ssmParameters: [...fakes.ssm.parameters.keys()].sort(),
    // Every secret is a stack's resource and goes with its stack; the fake
    // Secrets Manager keeps values it was once asked for, so only a secret a
    // live stack still names is in the account.
    secrets: [...fakes.secretsManager.values.keys()]
      .filter((arn) =>
        [...fakes.cloudformation.stacks.values()].some((stack) =>
          Object.values(stack.outputs).includes(arn),
        ),
      )
      .sort(),
    databaseRoles: [...fakes.rdsData.roles.keys()].sort(),
    databases: sorted(fakes.rdsData.databases.entries()),
  };
}
