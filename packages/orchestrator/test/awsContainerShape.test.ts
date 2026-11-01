import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AWS_CONTAINER_DEPLOY_ACTIONS,
  AwsTenantApiError,
  CONTAINER_SECRETS_MARKER,
  CONTAINER_VARIABLES_MARKER,
  ContainerRolloutFailedError,
  ContainerRolloutTimeoutError,
  EMPTY_ACCRUAL,
  IdlePolicyUnsupportedError,
  MAX_ACCRUAL_ENTRIES,
  NoPreviousTaskDefinitionError,
  ReleaseVariableInvalidError,
  StackFailedError,
  accrueStoppedTasks,
  containerReleaseNames,
  containerUsageSince,
  createFakeTenantClients,
  createStackRunner,
  createTenantClients,
  deployContainerRelease,
  deriveOriginSecret,
  describeContainerRelease,
  destroyContainerRelease,
  ensureTenantNetwork,
  fargateTaskUnits,
  parseAccrual,
  pickRulePriority,
  readTenantStackTemplate,
  renderContainerTemplate,
  rollbackContainerRelease,
  sdkTenantEcs,
  sdkTenantElb,
  sdkTenantSsm,
  splitContainerVariables,
  taskDefinitionRevision,
  windowUsage,
  type AwsSdkClient,
  type DeployContainerReleaseInput,
  type HostingEnvironment,
  type TenantAccountContext,
  type TenantEcsTask,
  type TenantNetwork,
  type TenantSdkService,
} from '../src/index';

// THE CONTAINER SHAPE (MOTIR-10009), against the seam's fakes: CloudFormation,
// ECS, ELB, SSM and Secrets Manager in memory, each able to fail at the Nth
// call. The fake ECS is driven by the fake release stack, so a revision is
// registered and rolled out exactly when the stack would; its tasks start and
// stop on the test's clock.

const ORG = 'cmorg1';
const RID = 'cmrepo1';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 7 };
const STACK = 'motir-release-mh-cmrepo1';
const APP = 'mh-cmrepo1';
const KEY = 'origin-key-for-tests';
const IMAGE_A = '210987654321.dkr.ecr.us-east-1.amazonaws.com/mh/cmrepo1/production@sha256:aaa';
const IMAGE_B = '210987654321.dkr.ecr.us-east-1.amazonaws.com/mh/cmrepo1/production@sha256:bbb';
const DATABASE_ARN =
  'arn:aws:secretsmanager:us-east-1:210987654321:secret:motir/cmrepo1/production/database-g1';
const SECRET_VALUE = 'sk_live_container_do_not_leak';
const PARAMETER = '/motir/hosting/mh-cmrepo1/usage';
const T0 = new Date('2026-10-01T00:00:00Z');

async function account() {
  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);
  const clients = createFakeTenantClients({ now });
  clients.cloudformation.pollsToSettle = 0;
  const runner = createStackRunner(clients.cloudformation, { sleep: async () => undefined });
  const context: TenantAccountContext = { organizationId: ORG, clients, runner };
  const network = await ensureTenantNetwork(context);
  const advance = (seconds: number) => {
    clock.t += seconds * 1000;
  };
  const sleep = async (ms: number) => {
    clock.t += ms;
  };
  return { context, network, clock, now, advance, sleep, ...clients };
}
type Account = Awaited<ReturnType<typeof account>>;

const target = (a: Account, environment: HostingEnvironment = PRODUCTION) => ({
  account: a.context,
  repositoryId: RID,
  environment,
  sleep: a.sleep,
  now: a.now,
  pollMs: 5_000,
  timeoutMs: 60_000,
});

function input(
  a: Account,
  overrides: Partial<DeployContainerReleaseInput> = {},
): DeployContainerReleaseInput {
  const network: TenantNetwork = a.network;
  return {
    ...target(a),
    imageUri: IMAGE_A,
    idle: { mode: 'always_on' },
    size: 'medium',
    runtime: { port: 3000, healthCheck: { path: '/healthz' } },
    env: [
      { name: 'NODE_ENV', value: 'production', secret: false },
      { name: 'STRIPE_KEY', value: SECRET_VALUE, secret: true },
    ],
    network,
    appHost: 'mh-cmrepo1.apps.motir.test',
    originSecretKey: KEY,
    database: { secretArn: DATABASE_ARN, variable: 'DATABASE_URL' },
    ...overrides,
  };
}

const revision = (n: number) => `arn:aws:ecs:us-east-1:210987654321:task-definition/${APP}:${n}`;
const stackWrites = (a: Account) =>
  a.cloudformation.calls.filter((c) => /^(create|update)Stack:motir-release/.test(c));
const allCalls = (a: Account) => [
  ...a.cloudformation.calls,
  ...a.ecs.calls,
  ...a.elb.calls,
  ...a.ssm.calls,
  ...a.secretsManager.calls,
];

describe('deployContainerRelease', () => {
  it('refuses a suspend idle policy before any AWS call', async () => {
    const a = await account();
    const before = allCalls(a).length;
    const err = await deployContainerRelease(
      input(a, { idle: { mode: 'suspend', idleSeconds: 60 } }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdlePolicyUnsupportedError);
    expect(err).toMatchObject({ target: 'aws', shape: 'container', mode: 'suspend' });
    expect(allCalls(a)).toHaveLength(before);
  });

  it('applies the release stack tagged, with the image, size, network, host and origin secret', async () => {
    const a = await account();
    const release = await deployContainerRelease(input(a));
    expect(release).toEqual({
      appRef: APP,
      stackName: STACK,
      releaseId: revision(1),
      upstreamAddress: `http://${a.network.albDnsName}`,
      liveTaskDefinition: revision(1),
      previousTaskDefinition: null,
    });
    const stack = a.cloudformation.stacks.get(STACK)!;
    expect(stack.tags).toEqual({ 'motir:organization': ORG, 'motir:repository': RID });
    expect(stack.parameters).toMatchObject({
      OrganizationId: ORG,
      RepositoryId: RID,
      AppRef: APP,
      Environment: 'production',
      ImageUri: IMAGE_A,
      IdlePolicy: 'always_on',
      TaskCpu: '512',
      TaskMemory: '1024',
      Port: '3000',
      HealthCheckPath: '/healthz',
      VpcId: a.network.vpcId,
      PrivateSubnetIds: a.network.privateSubnetIds.join(','),
      AppSecurityGroupId: a.network.appSecurityGroupId,
      AlbListenerArn: a.network.albListenerArn,
      AppHost: 'mh-cmrepo1.apps.motir.test',
      OriginSecret: deriveOriginSecret(KEY, APP),
      DatabaseSecretArn: DATABASE_ARN,
    });
    expect(Number(stack.parameters['ListenerRulePriority'])).toBeGreaterThanOrEqual(1);
    const svc = a.ecs.services.get(APP)!;
    expect(svc).toMatchObject({ taskDefinition: revision(1), desiredCount: 1 });
    // The template creates no load balancer or listener: one per account.
    expect(stack.templateBody).not.toMatch(
      /AWS::ElasticLoadBalancingV2::(LoadBalancer|Listener)\b/,
    );
    expect(stack.templateBody).toMatch(/Type: AWS::ElasticLoadBalancingV2::ListenerRule/);
    expect(stack.templateBody).toContain('HttpHeaderName: X-Motir-Origin-Secret');
  });

  it('runs a preview at the fixed preview size, as mh-<rid>-pr<n>', async () => {
    const a = await account();
    const release = await deployContainerRelease(input(a, { environment: PREVIEW, size: 'large' }));
    expect(release.appRef).toBe('mh-cmrepo1-pr7');
    expect(a.cloudformation.stacks.get('motir-release-mh-cmrepo1-pr7')!.parameters).toMatchObject({
      TaskCpu: '256',
      TaskMemory: '512',
      Environment: 'preview',
    });
    expect(containerReleaseNames(RID, PREVIEW)).toEqual({
      appRef: 'mh-cmrepo1-pr7',
      stackName: 'motir-release-mh-cmrepo1-pr7',
      cluster: 'mh-cmrepo1-pr7',
      service: 'mh-cmrepo1-pr7',
      family: 'mh-cmrepo1-pr7',
      usageParameter: '/motir/hosting/mh-cmrepo1-pr7/usage',
    });
  });

  it('waits for the rollout and a healthy target; until then the release is deploying', async () => {
    const a = await account();
    a.ecs.rolloutPolls = 3;
    let seen: string | null = null;
    const sleep = async (ms: number) => {
      seen ??= (await describeContainerRelease(target(a))).state;
      a.clock.t += ms;
    };
    const release = await deployContainerRelease(input(a, { sleep }));
    expect(seen).toBe('deploying');
    expect(release.liveTaskDefinition).toBe(revision(1));
    expect((await describeContainerRelease(target(a))).state).toBe('healthy');
  });

  it('waits on the real clock when none is given', async () => {
    const a = await account();
    a.ecs.rolloutPolls = 1;
    const { sleep: _sleep, now: _now, ...realTime } = input(a);
    const release = await deployContainerRelease({ ...realTime, pollMs: 1 });
    expect(release.liveTaskDefinition).toBe(revision(1));
    const usage = await containerUsageSince({
      account: a.context,
      repositoryId: RID,
      environment: PRODUCTION,
      releaseId: release.releaseId,
      since: T0,
    });
    expect(usage.until.getTime()).toBeGreaterThan(T0.getTime());
  });

  it('creates no revision and makes no write when repeated with the same input', async () => {
    const a = await account();
    const first = await deployContainerRelease(input(a));
    const writes = stackWrites(a).length;
    const second = await deployContainerRelease(input(a));
    expect(second).toEqual(first);
    expect(stackWrites(a)).toHaveLength(writes);
    expect(a.ecs.taskDefinitions.size).toBe(1);
    expect(a.ecs.calls.filter((c) => c.startsWith('updateService'))).toEqual([]);
  });

  it('keeps its listener rule priority and takes a free one beside other apps', async () => {
    const a = await account();
    a.elb.rules.set('other', pickRulePriority(APP, []));
    await deployContainerRelease(input(a));
    const priority = a.cloudformation.stacks.get(STACK)!.parameters['ListenerRulePriority'];
    expect(Number(priority)).not.toBe(a.elb.rules.get('other'));
    await deployContainerRelease(input(a, { imageUri: IMAGE_B }));
    expect(a.cloudformation.stacks.get(STACK)!.parameters['ListenerRulePriority']).toBe(priority);
    expect(a.elb.calls.filter((c) => c.startsWith('listRulePriorities'))).toHaveLength(1);

    expect(pickRulePriority(APP, [])).toBeGreaterThanOrEqual(1);
    expect(pickRulePriority(APP, [])).toBeLessThanOrEqual(50_000);
    const all = Array.from({ length: 50_000 }, (_, i) => i + 1);
    expect(() => pickRulePriority(APP, all)).toThrow(ContainerRolloutFailedError);
    expect(pickRulePriority(APP, all.slice(1))).toBe(1);
  });

  it('surfaces a failed rollout as a typed error and describes it unhealthy', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    a.ecs.failNextRollout(APP);
    await expect(deployContainerRelease(input(a, { imageUri: IMAGE_B }))).rejects.toBeInstanceOf(
      ContainerRolloutFailedError,
    );
    expect((await describeContainerRelease(target(a))).state).toBe('unhealthy');
  });

  it('times out on a target that never turns healthy, naming only the operation and service', async () => {
    const a = await account();
    a.elb.unhealthy.add(APP);
    const err = await deployContainerRelease(input(a)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContainerRolloutTimeoutError);
    expect(err).toMatchObject({ operation: 'deploy', service: APP });
    expect((err as Error).message).toBe(
      'The deploy of service mh-cmrepo1 did not finish healthy in time.',
    );
    expect((await describeContainerRelease(target(a))).state).toBe('unhealthy');
  });

  it('throws the seam’s StackFailedError when the stack fails, and describes it unhealthy', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    a.cloudformation.setStatus(STACK, 'UPDATE_FAILED');
    await expect(deployContainerRelease(input(a, { imageUri: IMAGE_B }))).rejects.toBeInstanceOf(
      StackFailedError,
    );
    expect(await describeContainerRelease(target(a))).toMatchObject({
      state: 'unhealthy',
      releaseId: null,
    });
  });

  type Service = 'cloudformation' | 'ecs' | 'elb' | 'ssm' | 'secretsManager';
  const OPS: Array<[Service, string]> = [
    ['cloudformation', 'describeStack'],
    ['cloudformation', 'getTemplateBody'],
    ['cloudformation', 'createStack'],
    ['cloudformation', 'updateStack'],
    ['secretsManager', 'putSecretValue'],
    ['ecs', 'describeService'],
    ['ecs', 'updateService'],
    ['ecs', 'listTaskDefinitions'],
    ['ecs', 'listTasks'],
    ['elb', 'describeTargetHealth'],
    ['elb', 'listRulePriorities'],
    ['ssm', 'getParameter'],
    ['ssm', 'putParameter'],
  ];
  const count = (a: Account, [service, op]: [Service, string]) =>
    a[service].calls.filter((c) => c.startsWith(`${op}:`)).length;
  const failAt = (a: Account, [service, op]: [Service, string], n: number, w: string) =>
    (a[service] as unknown as { failAt: (o: string, n: number, w: string) => void }).failAt(
      op,
      n,
      w,
    );

  const SCENARIOS: Array<{
    name: string;
    before: (a: Account) => Promise<unknown>;
    image: string;
  }> = [
    { name: 'a first deploy', before: async () => undefined, image: IMAGE_A },
    { name: 'a second image', before: (a) => deployContainerRelease(input(a)), image: IMAGE_B },
    {
      name: 'a deploy after a rollback',
      before: async (a) => {
        await deployContainerRelease(input(a));
        await deployContainerRelease(input(a, { imageUri: IMAGE_B }));
        await rollbackContainerRelease(target(a));
      },
      image: IMAGE_B,
    },
  ];

  for (const scenario of SCENARIOS) {
    it(`replayed after a cut-off at every call of ${scenario.name}, ends as an uncut run`, async () => {
      const clean = await account();
      await scenario.before(clean);
      const baseline = OPS.map((op) => count(clean, op));
      const expected = await deployContainerRelease(input(clean, { imageUri: scenario.image }));
      const counts = OPS.map((op, i) => count(clean, op) - baseline[i]!);

      let cuts = 0;
      for (const [i, op] of OPS.entries()) {
        for (let n = 1; n <= counts[i]!; n += 1) {
          for (const when of ['before', 'after'] as const) {
            const a = await account();
            await scenario.before(a);
            failAt(a, op, n, when);
            await expect(
              deployContainerRelease(input(a, { imageUri: scenario.image })),
            ).rejects.toThrow();
            cuts += 1;
            const replayed = await deployContainerRelease(input(a, { imageUri: scenario.image }));
            const label = `${op[1]} #${n} ${when}`;
            expect(replayed, label).toEqual(expected);
            expect(
              [...a.cloudformation.stacks.keys()].filter((k) => k.startsWith('motir-release')),
              label,
            ).toEqual([STACK]);
            expect(a.ecs.services.size, label).toBe(1);
            expect(a.ecs.services.get(APP)!.taskDefinition, label).toBe(
              expected.liveTaskDefinition,
            );
            expect(a.ecs.taskDefinitions.size, label).toBe(clean.ecs.taskDefinitions.size);
          }
        }
      }
      expect(cuts).toBeGreaterThan(10);
    });
  }
});

describe('rollbackContainerRelease', () => {
  it('moves the service to the first revision with no new revision, and a deploy moves it back', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    const second = await deployContainerRelease(input(a, { imageUri: IMAGE_B }));
    expect(second).toMatchObject({
      liveTaskDefinition: revision(2),
      previousTaskDefinition: revision(1),
    });
    const writes = stackWrites(a).length;
    const revisions = a.ecs.taskDefinitions.size;

    const rolled = await rollbackContainerRelease(target(a));
    expect(rolled).toEqual({
      appRef: APP,
      stackName: STACK,
      releaseId: revision(1),
      upstreamAddress: second.upstreamAddress,
      liveTaskDefinition: revision(1),
      previousTaskDefinition: revision(2),
    });
    expect(stackWrites(a)).toHaveLength(writes);
    expect(a.ecs.taskDefinitions.size).toBe(revisions);
    expect(a.ecs.services.get(APP)!.taskDefinition).toBe(revision(1));
    expect(await describeContainerRelease(target(a))).toEqual({
      state: 'healthy',
      releaseId: revision(1),
      previousReleaseId: revision(2),
      upstreamAddress: second.upstreamAddress,
      originCredential: 'origin_secret',
    });

    // Repeated: the same state.
    await rollbackContainerRelease(target(a));
    expect(a.ecs.services.get(APP)!.taskDefinition).toBe(revision(1));
    expect(a.ecs.calls.filter((c) => c.startsWith('updateService'))).toHaveLength(1);

    // A deploy of the image the stack holds: no stack change, the service moves back.
    const again = await deployContainerRelease(input(a, { imageUri: IMAGE_B }));
    expect(stackWrites(a)).toHaveLength(writes);
    expect(again.liveTaskDefinition).toBe(revision(2));
    expect(a.ecs.services.get(APP)!.taskDefinition).toBe(revision(2));
  });

  it('replayed after a cut-off at every call, ends on the first revision', async () => {
    const OPS = [
      ['cloudformation', 'describeStack'],
      ['ecs', 'listTaskDefinitions'],
      ['ecs', 'describeService'],
      ['ecs', 'updateService'],
      ['ecs', 'listTasks'],
      ['elb', 'describeTargetHealth'],
      ['ssm', 'getParameter'],
      ['ssm', 'putParameter'],
    ] as const;
    let cuts = 0;
    for (const [service, op] of OPS) {
      for (const n of [1, 2]) {
        for (const when of ['before', 'after'] as const) {
          const a = await account();
          await deployContainerRelease(input(a));
          await deployContainerRelease(input(a, { imageUri: IMAGE_B }));
          a.advance(100);
          (a[service] as unknown as { failAt: (o: string, n: number, w: string) => void }).failAt(
            op,
            n,
            when,
          );
          let failures = 0;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const ok = await rollbackContainerRelease(target(a)).then(
              () => true,
              () => false,
            );
            if (ok) break;
            failures += 1;
          }
          expect(failures, `${op} #${n} ${when}`).toBeLessThanOrEqual(1);
          cuts += failures;
          expect(a.ecs.services.get(APP)!.taskDefinition, `${op} #${n} ${when}`).toBe(revision(1));
          expect(a.ecs.taskDefinitions.size).toBe(2);
        }
      }
    }
    expect(cuts).toBeGreaterThan(8);
  });

  it('throws a typed error with no previous revision, or no release', async () => {
    const a = await account();
    await expect(rollbackContainerRelease(target(a))).rejects.toBeInstanceOf(
      NoPreviousTaskDefinitionError,
    );
    await deployContainerRelease(input(a));
    await expect(rollbackContainerRelease(target(a))).rejects.toMatchObject({
      code: 'AWS_NO_PREVIOUS_TASK_DEFINITION',
      service: APP,
    });
    await deployContainerRelease(input(a, { imageUri: IMAGE_B }));
    a.ecs.services.delete(APP);
    await expect(rollbackContainerRelease(target(a))).rejects.toBeInstanceOf(
      ContainerRolloutFailedError,
    );
  });
});

describe('describeContainerRelease', () => {
  it('reports origin_secret and the port’s states only', async () => {
    const a = await account();
    expect(await describeContainerRelease(target(a))).toEqual({
      state: 'destroyed',
      releaseId: null,
      previousReleaseId: null,
      upstreamAddress: null,
      originCredential: 'none',
    });
    // Unpublished: the stack exists with no service yet.
    a.cloudformation.failAt('updateStack', 1);
    await expect(deployContainerRelease(input(a))).rejects.toThrow();
    expect(await describeContainerRelease(target(a))).toMatchObject({
      state: 'deploying',
      originCredential: 'origin_secret',
      upstreamAddress: `http://${a.network.albDnsName}`,
    });

    await deployContainerRelease(input(a));
    expect(await describeContainerRelease(target(a))).toMatchObject({
      state: 'healthy',
      originCredential: 'origin_secret',
    });
    a.cloudformation.setStatus(STACK, 'UPDATE_IN_PROGRESS', 5, 'UPDATE_COMPLETE');
    expect((await describeContainerRelease(target(a))).state).toBe('deploying');
    a.cloudformation.setStatus(STACK, 'UPDATE_COMPLETE');

    // A rollout that completed onto a target that never answers.
    a.elb.unhealthy.add(APP);
    expect((await describeContainerRelease(target(a))).state).toBe('unhealthy');
    a.elb.unhealthy.delete(APP);

    // A service the stack says exists, gone.
    a.ecs.services.delete(APP);
    expect((await describeContainerRelease(target(a))).state).toBe('unhealthy');

    a.cloudformation.setStatus(STACK, 'DELETE_IN_PROGRESS', 5, 'DELETE_COMPLETE');
    expect((await describeContainerRelease(target(a))).state).toBe('destroyed');
  });

  it('reads deploying while every target is still in its initial check', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    const svc = a.ecs.services.get(APP)!;
    a.elb.describeTargetHealth = async () => ['initial'];
    expect((await describeContainerRelease(target(a))).state).toBe('deploying');
    a.elb.describeTargetHealth = async () => [];
    expect((await describeContainerRelease(target(a))).state).toBe('unhealthy');
    svc.deployments = [{ ...svc.deployments[0]!, rolloutState: 'FAILED' }];
    expect((await describeContainerRelease(target(a))).state).toBe('unhealthy');
  });

  it('claims no address without the network', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    (a.cloudformation.stacks as Map<string, unknown>).delete('motir-network');
    expect(await describeContainerRelease(target(a))).toMatchObject({
      upstreamAddress: null,
      originCredential: 'none',
    });
  });
});

describe('secret delivery', () => {
  it('secret variables only as task secrets by name, the database by ARN; no value leaks', async () => {
    const a = await account();
    const release = await deployContainerRelease(input(a));
    const stack = a.cloudformation.stacks.get(STACK)!;
    expect(stack.templateBody).toContain('- { Name: NODE_ENV, Value: "production" }');
    expect(stack.templateBody).toContain(
      "- { Name: STRIPE_KEY, ValueFrom: !Sub '${EnvironmentSecret}:STRIPE_KEY::${ConfigHash}' }",
    );
    expect(stack.templateBody).toContain(
      "{ Name: DATABASE_URL, ValueFrom: !Sub '${DatabaseSecretArn}:url::' }",
    );
    const secretArn = stack.outputs['EnvironmentSecretArn']!;
    expect(a.secretsManager.versions.get(`${secretArn}@${stack.parameters['ConfigHash']}`)).toBe(
      JSON.stringify({ STRIPE_KEY: SECRET_VALUE }),
    );

    a.advance(100);
    const visible = JSON.stringify([
      [...a.cloudformation.stacks.values()],
      allCalls(a),
      [...a.ssm.parameters.values()],
      release,
      await describeContainerRelease(target(a)),
      await containerUsageSince({ ...target(a), releaseId: release.releaseId, since: T0 }),
      await rollbackContainerRelease(target(a)).catch((e: Error) => e.message),
      await destroyContainerRelease({ ...target(a), releaseId: release.releaseId }),
    ]);
    expect(visible).not.toContain(SECRET_VALUE);
    expect(visible).not.toMatch(/postgres(ql)?:\/\//);
    expect(a.secretsManager.calls.filter((c) => c.startsWith('getSecretValue'))).toEqual([]);
  });

  it('refuses a variable the task sets itself, naming it and never its value', () => {
    const refuse = (name: string, hasDatabase = true) => {
      try {
        splitContainerVariables([{ name, value: SECRET_VALUE, secret: true }], hasDatabase);
      } catch (err) {
        return err as ReleaseVariableInvalidError;
      }
      throw new Error('accepted');
    };
    for (const name of ['PORT', 'MOTIR_ENVIRONMENT', 'DATABASE_URL', 'NOT-A-NAME']) {
      const err = refuse(name);
      expect(err).toBeInstanceOf(ReleaseVariableInvalidError);
      expect(err.message).not.toContain(SECRET_VALUE);
    }
    expect(
      splitContainerVariables([{ name: 'DATABASE_URL', value: 'x', secret: true }], false),
    ).toEqual({ plain: {}, secret: { DATABASE_URL: 'x' } });
    expect(() =>
      splitContainerVariables(
        [
          { name: 'A', value: '1', secret: false },
          { name: 'A', value: '2', secret: true },
        ],
        false,
      ),
    ).toThrow(/twice/);
  });

  it('writes both lists at the template’s markers', () => {
    const template = readTenantStackTemplate('container-release.yaml');
    expect(template).toContain(CONTAINER_VARIABLES_MARKER);
    expect(template).toContain(CONTAINER_SECRETS_MARKER);
    const rendered = renderContainerTemplate(template, { plain: {}, secret: {} });
    expect(rendered).not.toContain(CONTAINER_VARIABLES_MARKER);
    expect(rendered).not.toContain(CONTAINER_SECRETS_MARKER);
  });
});

describe('usage and destroy', () => {
  it('one medium task that ran 100 s is 50 vCPU-seconds and 100 GB-seconds', async () => {
    const a = await account();
    const release = await deployContainerRelease(input(a));
    a.advance(100);
    const usage = await destroyContainerRelease({ ...target(a), releaseId: release.releaseId });
    expect(usage).toEqual({
      target: 'aws',
      appRef: APP,
      releaseId: release.releaseId,
      since: T0,
      until: new Date(T0.getTime() + 100_000),
      runningSeconds: 100,
      compute: { unit: 'fargate', vcpuSeconds: 50, gbSeconds: 100 },
    });
    expect(a.cloudformation.stacks.has(STACK)).toBe(false);
    expect(a.ssm.parameters.has(PARAMETER)).toBe(false);
    expect(a.ecs.services.has(APP)).toBe(false);
    expect(a.ecs.taskDefinitions.get(revision(1))!.active).toBe(false);
  });

  it('counts tasks a deploy or rollback stopped after they leave the listing, each once', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    a.advance(100);
    await deployContainerRelease(input(a, { imageUri: IMAGE_B })); // stops task 1 at 100 s
    a.advance(50);
    await rollbackContainerRelease(target(a)); // stops task 2 at 150 s
    a.ecs.forgetStoppedTasks();
    a.advance(50);

    const accrual = parseAccrual(a.ssm.parameters.get(PARAMETER)!.value);
    expect(accrual.entries).toHaveLength(2);
    expect(a.ssm.parameters.get(PARAMETER)!.tags).toEqual({
      'motir:organization': ORG,
      'motir:repository': RID,
    });

    // 100 + 50 + 50 task-seconds, medium: 0.5 vCPU, 1 GB.
    const since = await containerUsageSince({ ...target(a), releaseId: 'x', since: T0 });
    expect(since.compute).toEqual({ unit: 'fargate', vcpuSeconds: 100, gbSeconds: 200 });
    const window = await containerUsageSince({
      ...target(a),
      releaseId: 'x',
      since: new Date(T0.getTime() + 120_000),
    });
    expect(window.compute).toEqual({ unit: 'fargate', vcpuSeconds: 40, gbSeconds: 80 });

    const destroyed = await destroyContainerRelease({ ...target(a), releaseId: 'x' });
    expect(destroyed.compute).toEqual({ unit: 'fargate', vcpuSeconds: 100, gbSeconds: 200 });
    // No ECS tag carries usage: the accrual is the parameter and nothing else.
    expect(JSON.stringify([...a.ecs.services.values(), a.ecs.tasks])).not.toContain('vcpu');
  });

  it('counts a task ECS stopped on its own when it is still listed at the next look', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    a.advance(30);
    a.ecs.stopTask(a.ecs.tasks[0]!.taskArn);
    a.advance(30);
    const usage = await containerUsageSince({ ...target(a), releaseId: 'x', since: T0 });
    expect(usage.compute).toEqual({ unit: 'fargate', vcpuSeconds: 15, gbSeconds: 30 });
    a.ecs.forgetStoppedTasks();
    expect(
      (await containerUsageSince({ ...target(a), releaseId: 'x', since: T0 })).compute,
    ).toEqual({ unit: 'fargate', vcpuSeconds: 15, gbSeconds: 30 });
  });

  it('destroying an absent release succeeds with zero usage', async () => {
    const a = await account();
    const usage = await destroyContainerRelease({ ...target(a), releaseId: 'x' });
    expect(usage).toMatchObject({
      since: T0,
      until: T0,
      runningSeconds: 0,
      compute: { unit: 'fargate', vcpuSeconds: 0, gbSeconds: 0 },
    });
  });

  it('a failed usage read deletes nothing', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    a.ecs.failAt('listTasks', 1);
    await expect(destroyContainerRelease({ ...target(a), releaseId: 'x' })).rejects.toBeInstanceOf(
      AwsTenantApiError,
    );
    expect(a.cloudformation.stacks.has(STACK)).toBe(true);
    expect(a.cloudformation.calls.filter((c) => c.startsWith('deleteStack'))).toEqual([]);
  });

  it('replayed after a cut-off at every call, ends gone with the usage returned once', async () => {
    const OPS = [
      ['cloudformation', 'describeStack'],
      ['cloudformation', 'deleteStack'],
      ['ecs', 'listTasks'],
      ['ecs', 'listTaskDefinitions'],
      ['ecs', 'deregisterTaskDefinition'],
      ['ssm', 'getParameter'],
      ['ssm', 'putParameter'],
      ['ssm', 'deleteParameter'],
    ] as const;
    const fresh = async () => {
      const a = await account();
      await deployContainerRelease(input(a));
      a.advance(100);
      await deployContainerRelease(input(a, { imageUri: IMAGE_B }));
      a.advance(100);
      return a;
    };
    const clean = await fresh();
    const expected = await destroyContainerRelease({ ...target(clean), releaseId: 'x' });
    expect(expected.compute).toEqual({ unit: 'fargate', vcpuSeconds: 100, gbSeconds: 200 });
    let cuts = 0;
    for (const [service, op] of OPS) {
      for (const n of [1, 2]) {
        for (const when of ['before', 'after'] as const) {
          const a = await fresh();
          (a[service] as unknown as { failAt: (o: string, n: number, w: string) => void }).failAt(
            op,
            n,
            when,
          );
          const returned: unknown[] = [];
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              returned.push(await destroyContainerRelease({ ...target(a), releaseId: 'x' }));
              break;
            } catch {
              cuts += attempt === 0 ? 1 : 0;
            }
          }
          const label = `${op} #${n} ${when}`;
          expect(returned, label).toEqual([expected]);
          expect(a.cloudformation.stacks.has(STACK), label).toBe(false);
          expect(a.ssm.parameters.has(PARAMETER), label).toBe(false);
        }
      }
    }
    expect(cuts).toBeGreaterThan(10);
  });

  it('the accrual counts each task once and folds its oldest entries', () => {
    const task = (i: number, stop: number): TenantEcsTask => ({
      taskArn: `arn:aws:ecs:r:1:task/c/t${i}`,
      taskDefinition: 'td',
      lastStatus: 'STOPPED',
      startedAt: new Date(stop - 10_000),
      stoppedAt: new Date(stop),
      cpu: 1024,
      memory: 2048,
    });
    const a1 = accrueStoppedTasks(EMPTY_ACCRUAL, [task(1, 10_000), task(2, 10_000)]);
    expect(a1.changed).toBe(true);
    expect(a1.accrual.mark).toEqual({ at: 10_000, tasks: ['t1', 't2'] });
    // A task stopped at the mark's instant and not yet counted is counted.
    const a2 = accrueStoppedTasks(a1.accrual, [task(1, 10_000), task(3, 10_000)]);
    expect(a2.accrual.entries).toHaveLength(3);
    expect(a2.accrual.mark.tasks).toEqual(['t1', 't2', 't3']);
    expect(accrueStoppedTasks(a2.accrual, [task(2, 10_000)]).changed).toBe(false);
    // A stopped task that never started was never billed.
    const never = accrueStoppedTasks(EMPTY_ACCRUAL, [{ ...task(9, 5_000), startedAt: null }]);
    expect(windowUsage(never.accrual, [], new Date(0), new Date(10_000))).toEqual({
      vcpuSeconds: 0,
      gbSeconds: 0,
    });

    let accrual = EMPTY_ACCRUAL;
    for (let i = 1; i <= MAX_ACCRUAL_ENTRIES + 5; i += 1) {
      accrual = accrueStoppedTasks(accrual, [task(i, i * 20_000)]).accrual;
    }
    expect(accrual.entries).toHaveLength(MAX_ACCRUAL_ENTRIES);
    expect(accrual.folded).toEqual({ vcpuSeconds: 50, gbSeconds: 100, untilMs: 100_000 });
    const all = windowUsage(accrual, [], new Date(0), new Date(10_000_000));
    expect(all).toEqual({ vcpuSeconds: 450, gbSeconds: 900 });
    // A window after the folded horizon leaves the folded total out.
    expect(windowUsage(accrual, [], new Date(200_000), new Date(10_000_000)).vcpuSeconds).toBe(
      (MAX_ACCRUAL_ENTRIES + 5 - 10) * 10,
    );
    expect(parseAccrual(null)).toEqual(EMPTY_ACCRUAL);
  });

  it('names and units: revision numbers and Fargate units from the size table', () => {
    expect(taskDefinitionRevision(revision(12))).toBe(12);
    expect(fargateTaskUnits({ vcpu: 0.25, memoryGb: 0.5 })).toEqual({ cpu: '256', memory: '512' });
  });
});

describe('the container shape’s clients', () => {
  it('runs ECS, ELB and SSM on the deploy-role session only', async () => {
    const built: Array<{ service: TenantSdkService; key: string }> = [];
    const clients = createTenantClients({
      management: {
        async assumeTenantDeployRole() {
          return {
            accessKeyId: 'ASIADEPLOY',
            secretAccessKey: 's',
            sessionToken: 't',
            expiration: new Date(Date.now() + 3_600_000),
          };
        },
      },
      accountId: '210987654321',
      region: 'us-east-1',
      sdkClientFactory: (service, config) => ({
        async send() {
          built.push({ service, key: (await config.credentials()).accessKeyId });
          return {};
        },
      }),
    });
    await clients.ecs.describeService(APP, APP);
    await clients.elb.describeTargetHealth('tg');
    await clients.ssm.getParameter(PARAMETER);
    expect(built).toEqual([
      { service: 'ecs', key: 'ASIADEPLOY' },
      { service: 'elasticloadbalancing', key: 'ASIADEPLOY' },
      { service: 'ssm', key: 'ASIADEPLOY' },
    ]);
  });

  function stub(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
    const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
    const client: AwsSdkClient = {
      async send(command) {
        const name = (command as object).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        sent.push({ command: name, input });
        const answer = answers[name];
        if (!answer) throw sdkError('UnexpectedCall');
        return answer(input);
      },
    };
    return { client, sent };
  }
  const sdkError = (name: string, status = 400) =>
    Object.assign(new Error(`${name}: detail`), { name, $metadata: { httpStatusCode: status } });

  it('the ECS client: services, revisions of one family, tasks over pages', async () => {
    let listPage = 0;
    const { client, sent } = stub({
      DescribeServicesCommand: (i) => {
        if (i['cluster'] === 'gone') throw sdkError('ClusterNotFoundException');
        if (i['cluster'] === 'denied') throw sdkError('AccessDeniedException', 403);
        if (i['cluster'] === 'empty') return {};
        return {
          services: [
            { status: 'INACTIVE' },
            {
              status: 'ACTIVE',
              taskDefinition: 'td:2',
              desiredCount: 1,
              runningCount: 1,
              deployments: [
                { taskDefinition: 'td:2', status: 'PRIMARY', rolloutState: 'COMPLETED' },
                {},
              ],
            },
          ],
        };
      },
      UpdateServiceCommand: () => ({}),
      ListTaskDefinitionsCommand: (i) =>
        i['nextToken']
          ? { taskDefinitionArns: ['arn:x:task-definition/mh-a:2'] }
          : {
              taskDefinitionArns: [
                'arn:x:task-definition/mh-a:1',
                'arn:x:task-definition/mh-a-pr1:1',
              ],
              nextToken: 'n',
            },
      DeregisterTaskDefinitionCommand: () => ({}),
      ListTasksCommand: (i) => {
        if (i['cluster'] === 'gone') throw sdkError('ServiceNotFoundException');
        if (i['cluster'] === 'denied') throw sdkError('AccessDeniedException', 403);
        listPage += 1;
        if (i['desiredStatus'] === 'RUNNING') {
          return i['nextToken'] ? { taskArns: ['t2'] } : { taskArns: ['t1'], nextToken: 'p' };
        }
        return {};
      },
      DescribeTasksCommand: (i) => ({
        tasks: (i['tasks'] as string[]).map((arn, k) =>
          k === 0
            ? {
                taskArn: arn,
                taskDefinitionArn: 'td:2',
                lastStatus: 'RUNNING',
                pullStartedAt: new Date(1),
                startedAt: new Date(2),
                cpu: '512',
                memory: '1024',
              }
            : { taskArn: arn, startedAt: new Date(3), stoppedAt: new Date(4) },
        ),
      }),
    });
    const ecs = sdkTenantEcs(client);
    expect(await ecs.describeService('c', 's')).toEqual({
      taskDefinition: 'td:2',
      desiredCount: 1,
      runningCount: 1,
      deployments: [
        { taskDefinition: 'td:2', status: 'PRIMARY', rolloutState: 'COMPLETED' },
        { taskDefinition: '', status: '', rolloutState: 'IN_PROGRESS' },
      ],
    });
    expect(await ecs.describeService('gone', 's')).toBeNull();
    expect(await ecs.describeService('empty', 's')).toBeNull();
    await expect(ecs.describeService('denied', 's')).rejects.toMatchObject({
      service: 'ecs',
      awsCode: 'AccessDeniedException',
    });
    await ecs.updateService('c', 's', 'td:1');
    expect(sent.find((s) => s.command === 'UpdateServiceCommand')!.input).toEqual({
      cluster: 'c',
      service: 's',
      taskDefinition: 'td:1',
    });
    expect(await ecs.listTaskDefinitions('mh-a')).toEqual([
      'arn:x:task-definition/mh-a:1',
      'arn:x:task-definition/mh-a:2',
    ]);
    await ecs.deregisterTaskDefinition('td:1');
    expect(await ecs.listTasks('c', 's')).toEqual([
      {
        taskArn: 't1',
        taskDefinition: 'td:2',
        lastStatus: 'RUNNING',
        startedAt: new Date(1),
        stoppedAt: null,
        cpu: 512,
        memory: 1024,
      },
      {
        taskArn: 't2',
        taskDefinition: '',
        lastStatus: '',
        startedAt: new Date(3),
        stoppedAt: new Date(4),
        cpu: 0,
        memory: 0,
      },
    ]);
    expect(listPage).toBe(3);
    expect(await ecs.listTasks('gone', 's')).toEqual([]);
    await expect(ecs.listTasks('denied', 's')).rejects.toBeInstanceOf(AwsTenantApiError);
    const none = sdkTenantEcs(stub({ ListTasksCommand: () => ({}) }).client);
    expect(await none.listTasks('c', 's')).toEqual([]);
    const bare = sdkTenantEcs(
      stub({ DescribeServicesCommand: () => ({ services: [{ status: 'ACTIVE' }] }) }).client,
    );
    expect(await bare.describeService('c', 's')).toEqual({
      taskDefinition: '',
      desiredCount: 0,
      runningCount: 0,
      deployments: [],
    });
  });

  it('the ELB client: target health and rule priorities over pages', async () => {
    const { client } = stub({
      DescribeTargetHealthCommand: () => ({
        TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }, {}],
      }),
      DescribeRulesCommand: (i) =>
        i['Marker']
          ? { Rules: [{ Priority: '7' }] }
          : { Rules: [{ Priority: 'default' }, { Priority: '3' }], NextMarker: 'm' },
    });
    const elb = sdkTenantElb(client);
    expect(await elb.describeTargetHealth('tg')).toEqual(['healthy', 'unavailable']);
    expect(await elb.listRulePriorities('l')).toEqual([3, 7]);
    const empty = sdkTenantElb(
      stub({ DescribeTargetHealthCommand: () => ({}), DescribeRulesCommand: () => ({}) }).client,
    );
    expect(await empty.describeTargetHealth('tg')).toEqual([]);
    expect(await empty.listRulePriorities('l')).toEqual([]);
  });

  it('the SSM client: a missing parameter is null, put tags it, delete is idempotent', async () => {
    const { client, sent } = stub({
      GetParameterCommand: (i) => {
        if (i['Name'] === 'missing') throw sdkError('ParameterNotFound');
        if (i['Name'] === 'denied') throw sdkError('AccessDeniedException', 403);
        return i['Name'] === 'empty' ? {} : { Parameter: { Value: 'v' } };
      },
      PutParameterCommand: () => ({}),
      AddTagsToResourceCommand: () => ({}),
      DeleteParameterCommand: (i) => {
        if (i['Name'] === 'missing') throw sdkError('ParameterNotFound');
        if (i['Name'] === 'denied') throw sdkError('AccessDeniedException', 403);
        return {};
      },
    });
    const ssm = sdkTenantSsm(client);
    expect(await ssm.getParameter('p')).toBe('v');
    expect(await ssm.getParameter('missing')).toBeNull();
    expect(await ssm.getParameter('empty')).toBeNull();
    await expect(ssm.getParameter('denied')).rejects.toBeInstanceOf(AwsTenantApiError);
    await ssm.putParameter('p', '{}', { 'motir:repository': RID });
    expect(sent.slice(-2).map((s) => s.input)).toEqual([
      { Name: 'p', Value: '{}', Type: 'String', Overwrite: true },
      {
        ResourceType: 'Parameter',
        ResourceId: 'p',
        Tags: [{ Key: 'motir:repository', Value: RID }],
      },
    ]);
    await ssm.deleteParameter('p');
    await ssm.deleteParameter('missing');
    await expect(ssm.deleteParameter('denied')).rejects.toBeInstanceOf(AwsTenantApiError);
  });

  it('the fake ECS refuses a revision it does not hold', async () => {
    const a = await account();
    await deployContainerRelease(input(a));
    await expect(a.ecs.updateService(APP, APP, revision(9))).rejects.toBeInstanceOf(
      AwsTenantApiError,
    );
    expect(await a.ecs.describeService('other', APP)).toBeNull();
    await expect(a.elb.describeTargetHealth('arn:tg/mh-none/g1')).rejects.toBeInstanceOf(
      AwsTenantApiError,
    );
  });

  it('the actions list covers every call the module makes', async () => {
    const CALLS: Record<string, string[]> = {
      describeService: ['ecs:DescribeServices'],
      updateService: ['ecs:UpdateService'],
      listTaskDefinitions: ['ecs:ListTaskDefinitions'],
      deregisterTaskDefinition: ['ecs:DeregisterTaskDefinition'],
      listTasks: ['ecs:ListTasks', 'ecs:DescribeTasks'],
      describeTargetHealth: ['elasticloadbalancing:DescribeTargetHealth'],
      listRulePriorities: ['elasticloadbalancing:DescribeRules'],
      putSecretValue: ['secretsmanager:PutSecretValue'],
      getParameter: ['ssm:GetParameter'],
      putParameter: ['ssm:PutParameter', 'ssm:AddTagsToResource'],
      deleteParameter: ['ssm:DeleteParameter'],
    };
    const a = await account();
    await deployContainerRelease(input(a));
    await deployContainerRelease(input(a, { imageUri: IMAGE_B }));
    await rollbackContainerRelease(target(a));
    await describeContainerRelease(target(a));
    await containerUsageSince({ ...target(a), releaseId: 'x', since: T0 });
    await destroyContainerRelease({ ...target(a), releaseId: 'x' });
    const made = new Set(
      [...a.ecs.calls, ...a.elb.calls, ...a.ssm.calls, ...a.secretsManager.calls].map(
        (c) => c.split(':')[0]!,
      ),
    );
    expect([...made].sort()).toEqual(Object.keys(CALLS).sort());
    for (const call of made) {
      for (const action of CALLS[call]!) expect(AWS_CONTAINER_DEPLOY_ACTIONS).toContain(action);
    }
    for (const action of [
      'ecs:RegisterTaskDefinition',
      'ecs:CreateService',
      'elasticloadbalancing:CreateRule',
      'elasticloadbalancing:CreateTargetGroup',
      'iam:PassRole',
      'secretsmanager:CreateSecret',
    ]) {
      expect(AWS_CONTAINER_DEPLOY_ACTIONS).toContain(action);
    }
    expect(new Set(AWS_CONTAINER_DEPLOY_ACTIONS).size).toBe(AWS_CONTAINER_DEPLOY_ACTIONS.length);
    expect(AWS_CONTAINER_DEPLOY_ACTIONS).not.toContain('elasticloadbalancing:CreateLoadBalancer');
  });

  it('imports no AWS SDK and no Motir database client in the container directory', () => {
    const dir = join(__dirname, '..', 'src', 'adapters', 'aws', 'tenant', 'container');
    const files = readdirSync(dir);
    expect(files).toEqual(
      expect.arrayContaining(['index.ts', 'ecsClient.ts', 'names.ts', 'usage.ts', 'errors.ts']),
    );
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/@aws-sdk\//);
      expect(source, file).not.toMatch(/@prisma|lib\/|prisma/i);
    }
  });
});
