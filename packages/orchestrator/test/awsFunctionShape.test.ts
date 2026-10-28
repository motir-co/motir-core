import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AWS_FUNCTION_DEPLOY_ACTIONS,
  AwsTenantApiError,
  FUNCTION_TEMPLATE_VARIABLES,
  FunctionTemplateMarkerMissingError,
  FunctionUsageReadError,
  LAMBDA_ENVIRONMENT_LIMIT_BYTES,
  LIVE_ALIAS,
  NoPreviousFunctionVersionError,
  RELEASE_VARIABLES_MARKER,
  ReleaseVariableInvalidError,
  StackFailedError,
  createFakeTenantClients,
  createStackRunner,
  createTenantClients,
  deployFunctionRelease,
  describeFunctionRelease,
  destroyFunctionRelease,
  functionComputeUsage,
  functionReleaseNames,
  functionUsageSince,
  previousFunctionVersion,
  readTenantStackTemplate,
  releaseConfigHash,
  renderFunctionTemplate,
  rollbackFunctionRelease,
  sdkTenantCloudFormation,
  sdkTenantCloudWatch,
  sdkTenantLambda,
  sdkTenantSecretsManager,
  splitReleaseVariables,
  type AwsSdkClient,
  type DeployFunctionReleaseInput,
  type HostingEnvironment,
  type ReleaseEnvVar,
  type TenantAccountContext,
  type TenantSdkService,
} from '../src/index';

// THE FUNCTION SHAPE (MOTIR-10008), against the seam's fakes: CloudFormation,
// Lambda, CloudWatch and Secrets Manager in memory, each able to fail at the
// Nth call. The fake Lambda is driven by the fake release stack, so a version is
// published exactly when the stack would publish one.

const ORG = 'cmorg1';
const RID = 'cmrepo1';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 7 };
const STACK = 'motir-release-mh-cmrepo1';
const FORWARDER = 'arn:aws:iam::576360162297:role/motir-forwarder';
const IMAGE_A = '210987654321.dkr.ecr.us-east-1.amazonaws.com/mh/cmrepo1/production@sha256:aaa';
const IMAGE_B = '210987654321.dkr.ecr.us-east-1.amazonaws.com/mh/cmrepo1/production@sha256:bbb';
const DATABASE_ARN =
  'arn:aws:secretsmanager:us-east-1:210987654321:secret:motir/cmrepo1/production/database-g1';
const SECRET_VALUE = 'sk_live_do_not_leak_4242';
const noSleep = async () => undefined;

function account(start = new Date('2026-10-01T00:00:00Z')) {
  const clock = { now: start };
  const clients = createFakeTenantClients({ now: () => clock.now });
  clients.cloudformation.pollsToSettle = 0;
  const runner = createStackRunner(clients.cloudformation, { sleep: noSleep });
  const context: TenantAccountContext = { organizationId: ORG, clients, runner };
  return { context, clock, ...clients };
}
type Account = ReturnType<typeof account>;

function input(
  a: Account,
  overrides: Partial<DeployFunctionReleaseInput> = {},
): DeployFunctionReleaseInput {
  return {
    account: a.context,
    repositoryId: RID,
    environment: PRODUCTION,
    imageUri: IMAGE_A,
    idle: { mode: 'suspend', idleSeconds: 300 },
    runtime: { port: 3000, healthCheck: { path: '/healthz' } },
    env: [
      { name: 'NODE_ENV', value: 'production', secret: false },
      { name: 'STRIPE_KEY', value: SECRET_VALUE, secret: true },
    ],
    network: { privateSubnetIds: ['subnet-a', 'subnet-b'], appSecurityGroupId: 'sg-app' },
    invokePrincipalArn: FORWARDER,
    database: { secretArn: DATABASE_ARN, variable: 'DATABASE_URL' },
    ...overrides,
  };
}

const target = (a: Account, environment: HostingEnvironment = PRODUCTION) => ({
  account: a.context,
  repositoryId: RID,
  environment,
});
const stackWrites = (a: Account) =>
  a.cloudformation.calls.filter((c) => /^(create|update)Stack:/.test(c));

describe('deployFunctionRelease', () => {
  it('applies function-release.yaml under the README stack name, tagged, and returns the URL', async () => {
    const a = account();
    const release = await deployFunctionRelease(input(a));
    const fn = a.lambda.functions.get('mh-cmrepo1')!;

    expect(release).toEqual({
      appRef: 'mh-cmrepo1',
      stackName: STACK,
      releaseId: '1',
      upstreamAddress: fn.url,
      liveVersion: '1',
      previousVersion: null,
    });
    expect(release.upstreamAddress).toMatch(
      /^https:\/\/[a-f0-9]+\.lambda-url\.us-east-1\.on\.aws\/$/,
    );
    const stack = a.cloudformation.stacks.get(STACK)!;
    expect(stack.tags).toEqual({ 'motir:organization': ORG, 'motir:repository': RID });
    expect(stack.parameters).toMatchObject({
      OrganizationId: ORG,
      RepositoryId: RID,
      AppRef: 'mh-cmrepo1',
      Environment: 'production',
      ImageUri: IMAGE_A,
      IdlePolicy: 'suspend',
      Port: '3000',
      HealthCheckPath: '/healthz',
      PrivateSubnetIds: 'subnet-a,subnet-b',
      AppSecurityGroupId: 'sg-app',
      DatabaseSecretArn: DATABASE_ARN,
      InvokePrincipalArn: FORWARDER,
    });
    expect(stack.parameters['ConfigHash']).toMatch(/^[a-f0-9]{64}$/);
    // The template it applied: an x86_64 image function of 1,769 MB in the VPC,
    // the Web Adapter's port and readiness path from the parameters.
    const body = stack.templateBody;
    expect(body).toContain('PackageType: Image');
    expect(body).toContain('Architectures: [x86_64]');
    expect(body).toContain('MemorySize: 1769');
    expect(body).toMatch(/SubnetIds: !Ref PrivateSubnetIds/);
    expect(body).toMatch(/- !Ref AppSecurityGroupId/);
    expect(body).toMatch(/AWS_LWA_PORT: !Ref Port/);
    expect(body).toMatch(/AWS_LWA_READINESS_CHECK_PATH: !Ref HealthCheckPath/);
    expect(body).not.toContain(RELEASE_VARIABLES_MARKER);
    expect(a.lambda.functions.size).toBe(1);
    expect(fn.alias).toBe('1');
  });

  it('names a preview function mh-<rid>-pr<n>', async () => {
    const a = account();
    const release = await deployFunctionRelease(input(a, { environment: PREVIEW }));
    expect(release.appRef).toBe('mh-cmrepo1-pr7');
    expect(release.stackName).toBe('motir-release-mh-cmrepo1-pr7');
    expect(a.cloudformation.stacks.get(release.stackName)!.parameters['Environment']).toBe(
      'preview',
    );
    expect(functionReleaseNames(RID, PREVIEW)).toEqual({
      appRef: 'mh-cmrepo1-pr7',
      stackName: 'motir-release-mh-cmrepo1-pr7',
    });
  });

  it('creates the stack unpublished first, then writes the secret, then publishes', async () => {
    const a = account();
    await deployFunctionRelease(input(a));
    const order = [...a.cloudformation.calls.filter((c) => /^(create|update)Stack/.test(c))].map(
      (c) => c.split(':')[0],
    );
    expect(order).toEqual(['createStack', 'updateStack']);
    const secretArn = a.cloudformation.stacks.get(STACK)!.outputs['EnvironmentSecretArn']!;
    const hash = a.cloudformation.stacks.get(STACK)!.parameters['ConfigHash']!;
    expect(a.secretsManager.versions.get(`${secretArn}@${hash}`)).toBe(
      JSON.stringify({ STRIPE_KEY: SECRET_VALUE }),
    );
  });

  it('is a no change when repeated with the same input: one stack, URL and version', async () => {
    const a = account();
    const first = await deployFunctionRelease(input(a));
    const writes = stackWrites(a).length;
    const second = await deployFunctionRelease(input(a));
    expect(second).toEqual(first);
    expect(stackWrites(a)).toHaveLength(writes);
    expect(a.lambda.functions.get('mh-cmrepo1')!.versions.size).toBe(1);
    expect(a.lambda.calls.filter((c) => c.startsWith('updateAlias'))).toEqual([]);
  });

  it('publishes a new version for a changed variable and keeps the old one', async () => {
    const a = account();
    await deployFunctionRelease(input(a));
    const changed = await deployFunctionRelease(
      input(a, { env: [{ name: 'NODE_ENV', value: 'staging', secret: false }] }),
    );
    expect(changed).toMatchObject({ liveVersion: '2', previousVersion: '1' });
  });

  it('recreates, on the next deploy, a create that rolled back', async () => {
    const a = account();
    a.cloudformation.failNextCreate(STACK);
    await expect(deployFunctionRelease(input(a))).rejects.toBeInstanceOf(StackFailedError);
    expect((await deployFunctionRelease(input(a))).liveVersion).toBe('1');
    expect(a.cloudformation.calls.filter((c) => c.startsWith('createStack'))).toHaveLength(2);
    expect(a.cloudformation.stacks.size).toBe(1);
  });

  it('throws the seam’s StackFailedError when the publish fails', async () => {
    const a = account();
    await deployFunctionRelease(input(a));
    a.cloudformation.setStatus(STACK, 'UPDATE_FAILED');
    await expect(deployFunctionRelease(input(a, { imageUri: IMAGE_B }))).rejects.toBeInstanceOf(
      StackFailedError,
    );
  });

  type Op = { service: 'cloudformation' | 'lambda' | 'secretsManager'; op: string };
  const OPS: Op[] = [
    { service: 'cloudformation', op: 'describeStack' },
    { service: 'cloudformation', op: 'getTemplateBody' },
    { service: 'cloudformation', op: 'createStack' },
    { service: 'cloudformation', op: 'updateStack' },
    { service: 'secretsManager', op: 'putSecretValue' },
    { service: 'lambda', op: 'getAlias' },
    { service: 'lambda', op: 'updateAlias' },
    { service: 'lambda', op: 'listVersions' },
  ];
  const callsOf = (a: Account, { service, op }: Op) =>
    service === 'secretsManager'
      ? a.secretsManager.calls.filter((c) => c.startsWith(`${op}:`)).length
      : a[service].calls.filter((c) => c.startsWith(`${op}:`)).length;
  const failAt = (a: Account, { service, op }: Op, n: number, when: 'before' | 'after') =>
    (a[service] as unknown as { failAt: (o: string, n: number, w: string) => void }).failAt(
      op,
      n,
      when,
    );

  /** Each scenario: what runs before (uncut), then the deploy that is cut off. */
  const SCENARIOS: Array<{
    name: string;
    before: (a: Account) => Promise<unknown>;
    image: string;
  }> = [
    { name: 'a first deploy', before: async () => undefined, image: IMAGE_A },
    {
      name: 'a second image',
      before: (a) => deployFunctionRelease(input(a)),
      image: IMAGE_B,
    },
    {
      name: 'a deploy after a rollback',
      before: async (a) => {
        await deployFunctionRelease(input(a));
        await deployFunctionRelease(input(a, { imageUri: IMAGE_B }));
        await rollbackFunctionRelease(target(a));
      },
      image: IMAGE_B,
    },
  ];

  for (const scenario of SCENARIOS) {
    it(`replayed after a cut-off at every call of ${scenario.name}, ends as an uncut run`, async () => {
      const clean = account();
      await scenario.before(clean);
      const baseline = OPS.map((op) => callsOf(clean, op));
      const expected = await deployFunctionRelease(input(clean, { imageUri: scenario.image }));
      const counts = OPS.map((op, i) => callsOf(clean, op) - baseline[i]!);
      expect(counts.reduce((x, y) => x + y)).toBeGreaterThan(4);

      let cuts = 0;
      for (const [i, op] of OPS.entries()) {
        for (let n = 1; n <= counts[i]!; n += 1) {
          for (const when of ['before', 'after'] as const) {
            const a = account();
            await scenario.before(a);
            failAt(a, op, n, when);
            await expect(
              deployFunctionRelease(input(a, { imageUri: scenario.image })),
            ).rejects.toThrow();
            cuts += 1;
            const replayed = await deployFunctionRelease(input(a, { imageUri: scenario.image }));
            const label = `${op.op} #${n} ${when}`;
            expect(replayed, label).toEqual(expected);
            expect(a.cloudformation.stacks.size, label).toBe(1);
            const fn = a.lambda.functions.get('mh-cmrepo1')!;
            expect(fn.alias, label).toBe(expected.liveVersion);
            expect(fn.versions.size, label).toBe(
              clean.lambda.functions.get('mh-cmrepo1')!.versions.size,
            );
          }
        }
      }
      expect(cuts).toBeGreaterThan(8);
    });
  }
});

describe('rollbackFunctionRelease', () => {
  it('points live back at the first version with no stack apply and no image', async () => {
    const a = account();
    await deployFunctionRelease(input(a));
    const second = await deployFunctionRelease(input(a, { imageUri: IMAGE_B }));
    expect(second).toMatchObject({ liveVersion: '2', previousVersion: '1' });
    const fn = a.lambda.functions.get('mh-cmrepo1')!;
    expect([...fn.versions.keys()]).toEqual(['1', '2']);
    expect(fn.alias).toBe('2');

    const writes = stackWrites(a).length;
    const rolled = await rollbackFunctionRelease(target(a));
    expect(rolled).toEqual({
      appRef: 'mh-cmrepo1',
      stackName: STACK,
      releaseId: '1',
      upstreamAddress: second.upstreamAddress,
      liveVersion: '1',
      previousVersion: '2',
    });
    expect(stackWrites(a)).toHaveLength(writes);
    expect(fn.alias).toBe('1');
    expect(await describeFunctionRelease(target(a))).toEqual({
      state: 'healthy',
      releaseId: '1',
      previousReleaseId: '2',
      upstreamAddress: second.upstreamAddress,
      originCredential: 'aws_sigv4',
    });

    // Rolling back again restores the release the rollback replaced.
    expect((await rollbackFunctionRelease(target(a))).liveVersion).toBe('2');
  });

  it('a deploy of the image the stack holds is a no change and still moves live back', async () => {
    const a = account();
    await deployFunctionRelease(input(a));
    await deployFunctionRelease(input(a, { imageUri: IMAGE_B }));
    await rollbackFunctionRelease(target(a));
    const writes = stackWrites(a).length;
    const again = await deployFunctionRelease(input(a, { imageUri: IMAGE_B }));
    expect(stackWrites(a)).toHaveLength(writes);
    expect(again).toMatchObject({ liveVersion: '2', previousVersion: '1' });
    expect(a.lambda.functions.get('mh-cmrepo1')!.alias).toBe('2');
    expect(a.lambda.calls.filter((c) => c.startsWith('updateAlias'))).toHaveLength(2);
  });

  it('throws a typed error with no previous version, or no release', async () => {
    const a = account();
    await expect(rollbackFunctionRelease(target(a))).rejects.toBeInstanceOf(
      NoPreviousFunctionVersionError,
    );
    await deployFunctionRelease(input(a));
    const err = await rollbackFunctionRelease(target(a)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoPreviousFunctionVersionError);
    expect(err).toMatchObject({
      code: 'AWS_NO_PREVIOUS_FUNCTION_VERSION',
      functionName: 'mh-cmrepo1',
    });
  });

  it('works out the previous version from the versions and live', () => {
    expect(previousFunctionVersion([], '1')).toBeNull();
    expect(previousFunctionVersion(['1'], null)).toBeNull();
    expect(previousFunctionVersion(['1'], '1')).toBeNull();
    expect(previousFunctionVersion(['1', '2', '3'], '3')).toBe('2');
    expect(previousFunctionVersion(['1', '3'], '3')).toBe('1');
    expect(previousFunctionVersion(['1', '2', '3'], '1')).toBe('3');
    expect(previousFunctionVersion(['$LATEST', '2', '10'], '10')).toBe('2');
  });
});

describe('describeFunctionRelease', () => {
  it('reports aws_sigv4 and the URL the forwarder signs for, IAM-auth for the forwarder only', async () => {
    const a = account();
    const release = await deployFunctionRelease(input(a));
    expect(await describeFunctionRelease(target(a))).toEqual({
      state: 'healthy',
      releaseId: '1',
      previousReleaseId: null,
      upstreamAddress: release.upstreamAddress,
      originCredential: 'aws_sigv4',
    });
    const template = readTenantStackTemplate('function-release.yaml');
    const url = template.slice(
      template.indexOf('  FunctionUrl:'),
      template.indexOf('  ForwarderInvoke:'),
    );
    expect(url).toContain('AuthType: AWS_IAM');
    expect(url).toContain('Qualifier: live');
    const invoke = template.slice(
      template.indexOf('  ForwarderInvoke:'),
      template.indexOf('Outputs:'),
    );
    expect(invoke).toContain('Action: lambda:InvokeFunctionUrl');
    expect(invoke).toContain('FunctionUrlAuthType: AWS_IAM');
    expect(invoke).toContain('Principal: !Ref InvokePrincipalArn');
    expect(a.cloudformation.stacks.get(STACK)!.parameters['InvokePrincipalArn']).toBe(FORWARDER);
  });

  it('draws its states from the port: deploying, healthy, unhealthy, destroyed', async () => {
    const a = account();
    expect(await describeFunctionRelease(target(a))).toEqual({
      state: 'destroyed',
      releaseId: null,
      previousReleaseId: null,
      upstreamAddress: null,
      originCredential: 'none',
    });
    await deployFunctionRelease(input(a));
    const states = async () => (await describeFunctionRelease(target(a))).state;

    a.lambda.setState('mh-cmrepo1', '1', 'pending');
    expect(await states()).toBe('deploying');
    a.lambda.setState('mh-cmrepo1', '1', 'inactive');
    expect(await states()).toBe('healthy');
    a.lambda.setState('mh-cmrepo1', '1', 'failed');
    expect(await states()).toBe('unhealthy');
    a.lambda.setState('mh-cmrepo1', '1', 'active');

    a.cloudformation.setStatus(STACK, 'UPDATE_IN_PROGRESS', 5, 'UPDATE_COMPLETE');
    expect(await states()).toBe('deploying');
    a.cloudformation.setStatus(STACK, 'UPDATE_ROLLBACK_FAILED');
    const failed = await describeFunctionRelease(target(a));
    expect(failed).toMatchObject({ state: 'unhealthy', releaseId: null });
    a.cloudformation.setStatus(STACK, 'DELETE_IN_PROGRESS', 5, 'DELETE_COMPLETE');
    expect(await states()).toBe('destroyed');

    // A stack that has not published yet.
    const b = account();
    b.cloudformation.failAt('updateStack', 1);
    await expect(deployFunctionRelease(input(b))).rejects.toThrow();
    expect(await describeFunctionRelease(target(b))).toEqual({
      state: 'deploying',
      releaseId: null,
      previousReleaseId: null,
      upstreamAddress: null,
      originCredential: 'none',
    });
  });

  it('falls back to the stack’s version when the alias cannot be found', async () => {
    const a = account();
    await deployFunctionRelease(input(a));
    a.lambda.functions.get('mh-cmrepo1')!.alias = null;
    expect((await describeFunctionRelease(target(a))).releaseId).toBe('1');
  });
});

describe('the idle policy', () => {
  it('suspend configures no provisioned concurrency; always_on sets 1 on live', async () => {
    const template = readTenantStackTemplate('function-release.yaml');
    const alias = template.slice(
      template.indexOf('  LiveAlias:'),
      template.indexOf('  FunctionUrl:'),
    );
    expect(alias).toMatch(
      /ProvisionedConcurrencyConfig: !If\s+- AlwaysOn\s+- ProvisionedConcurrentExecutions: 1\s+- !Ref AWS::NoValue/,
    );
    expect(template).toContain('AlwaysOn: !Equals [!Ref IdlePolicy, always_on]');

    const a = account();
    await deployFunctionRelease(input(a));
    expect(a.cloudformation.stacks.get(STACK)!.parameters['IdlePolicy']).toBe('suspend');
    const b = account();
    await deployFunctionRelease(input(b, { idle: { mode: 'always_on' } }));
    expect(b.cloudformation.stacks.get(STACK)!.parameters['IdlePolicy']).toBe('always_on');
  });
});

describe('secret delivery', () => {
  const big = (n: number) => 'v'.repeat(n);

  it('under 4 KB: plain variables in the function, secret ones only in the secret', async () => {
    const a = account();
    const release = await deployFunctionRelease(input(a));
    const stack = a.cloudformation.stacks.get(STACK)!;
    expect(stack.templateBody).toMatch(/^ {10}NODE_ENV: "production"$/m);
    expect(stack.templateBody).not.toContain('STRIPE_KEY');
    const secretArn = stack.outputs['EnvironmentSecretArn']!;
    expect(JSON.parse(a.secretsManager.values.get(secretArn)!)).toEqual({
      STRIPE_KEY: SECRET_VALUE,
    });

    // The secrecy scan: no parameter, template, output, returned value, call or
    // query holds a secret value; the database secret is passed by ARN and never read.
    const visible = JSON.stringify([
      [...a.cloudformation.stacks.values()],
      a.cloudformation.calls,
      a.lambda.calls,
      a.cloudwatch.queries,
      a.secretsManager.calls,
      release,
      await describeFunctionRelease(target(a)),
      await functionUsageSince({ ...target(a), releaseId: '1', since: new Date(0) }),
    ]);
    expect(visible).not.toContain(SECRET_VALUE);
    expect(visible).not.toMatch(/postgres(ql)?:\/\//);
    expect(stack.parameters['DatabaseSecretArn']).toBe(DATABASE_ARN);
    expect(a.secretsManager.calls.filter((c) => c.startsWith('getSecretValue'))).toEqual([]);
    expect(a.secretsManager.calls.some((c) => c.includes(DATABASE_ARN))).toBe(false);
  });

  it('over 4 KB: the overflow goes to the secret and the function stays under 4 KB', async () => {
    const env: ReleaseEnvVar[] = Array.from({ length: 8 }, (_, i) => ({
      name: `PLAIN_${i}`,
      value: big(700),
      secret: false,
    }));
    const a = account();
    await deployFunctionRelease(input(a, { env }));
    const stack = a.cloudformation.stacks.get(STACK)!;
    const secret = JSON.parse(
      a.secretsManager.values.get(stack.outputs['EnvironmentSecretArn']!)!,
    ) as Record<string, string>;
    const inFunction = env.filter((v) => stack.templateBody.includes(`${v.name}: `));
    expect(inFunction.length).toBeGreaterThan(0);
    expect(Object.keys(secret).length).toBeGreaterThan(0);
    expect(inFunction.length + Object.keys(secret).length).toBe(env.length);

    // The whole function environment, with the template's own variables at
    // their real values, stays under Lambda's limit.
    const fixed = {
      AWS_LWA_PORT: '3000',
      AWS_LWA_READINESS_CHECK_PATH: '/healthz',
      MOTIR_ENVIRONMENT: 'production',
      MOTIR_ENVIRONMENT_SECRET_ARN: stack.outputs['EnvironmentSecretArn']!,
      MOTIR_ENVIRONMENT_SECRET_VERSION: stack.parameters['ConfigHash']!,
      MOTIR_DATABASE_SECRET_ARN: DATABASE_ARN,
    };
    const all = { ...fixed, ...Object.fromEntries(inFunction.map((v) => [v.name, v.value])) };
    expect(Buffer.byteLength(JSON.stringify(all))).toBeLessThanOrEqual(
      LAMBDA_ENVIRONMENT_LIMIT_BYTES,
    );
  });

  it('splits by name, keeps Lambda’s names out of the function and the Web Adapter’s in', () => {
    const split = splitReleaseVariables(
      [
        { name: 'B', value: '2', secret: false },
        { name: 'A', value: '1', secret: false },
        { name: 'S', value: 'x', secret: true },
        { name: 'AWS_REGION', value: 'eu-west-1', secret: false },
        { name: 'LAMBDA_TASK_ROOT', value: '/x', secret: false },
        { name: '_HANDLER', value: 'h', secret: false },
        { name: 'AWS_LWA_ASYNC_INIT', value: 'true', secret: false },
      ],
      {},
    );
    expect(split.plain).toEqual({ A: '1', AWS_LWA_ASYNC_INIT: 'true', B: '2' });
    expect(split.secret).toEqual({
      AWS_REGION: 'eu-west-1',
      LAMBDA_TASK_ROOT: '/x',
      S: 'x',
      _HANDLER: 'h',
    });
  });

  it('refuses a variable no environment can carry, naming it and never its value', () => {
    const refuse = (env: ReleaseEnvVar[]) => {
      try {
        splitReleaseVariables(env, {});
      } catch (err) {
        return err as ReleaseVariableInvalidError;
      }
      throw new Error('accepted');
    };
    const bad = refuse([{ name: 'NOT-A-NAME', value: SECRET_VALUE, secret: true }]);
    expect(bad).toBeInstanceOf(ReleaseVariableInvalidError);
    expect(bad).toMatchObject({ code: 'AWS_RELEASE_VARIABLE_INVALID', variable: 'NOT-A-NAME' });
    expect(bad.message).not.toContain(SECRET_VALUE);
    expect(
      refuse([
        { name: 'A', value: SECRET_VALUE, secret: false },
        { name: 'A', value: SECRET_VALUE, secret: true },
      ]).message,
    ).toMatch(/twice/);
    for (const name of FUNCTION_TEMPLATE_VARIABLES) {
      expect(refuse([{ name, value: 'x', secret: false }]).message).toMatch(/release itself/);
    }
  });

  it('hashes every variable and renders values as quoted YAML at the marker', () => {
    const one = releaseConfigHash({ plain: { A: '1' }, secret: { S: 'x' } });
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(releaseConfigHash({ plain: { A: '1' }, secret: { S: 'y' } })).not.toBe(one);
    expect(releaseConfigHash({ plain: { A: '1' }, secret: { S: 'x' } })).toBe(one);

    const template = `a:\n    ${RELEASE_VARIABLES_MARKER}\nb: 1`;
    expect(renderFunctionTemplate(template, { Z: 'q"\n\u2028', A: '#x: y' })).toBe(
      'a:\n    A: "#x: y"\n    Z: "q\\"\\n\\u2028"\nb: 1',
    );
    expect(renderFunctionTemplate(template, {})).toBe('a:\nb: 1');
    expect(() => renderFunctionTemplate('a: 1', {})).toThrow(FunctionTemplateMarkerMissingError);
  });
});

describe('usage and destroy', () => {
  it('reads GB-seconds from the Duration sum: a 100 s sum is 172.75 GB-seconds (172.7539…)', async () => {
    const a = account();
    await deployFunctionRelease(input(a));
    a.cloudwatch.durationSums.set('mh-cmrepo1', 100_000);
    const since = new Date('2026-10-01T00:00:00Z');
    const now = new Date('2026-10-01T01:00:00Z');
    const usage = await functionUsageSince({ ...target(a), releaseId: '1', since, now: () => now });
    expect(usage).toEqual({
      target: 'aws',
      appRef: 'mh-cmrepo1',
      releaseId: '1',
      since,
      until: now,
      runningSeconds: 3600,
      compute: { unit: 'lambda', gbSeconds: 172.75390625 },
    });
    expect(a.cloudwatch.queries.at(-1)).toEqual({
      namespace: 'AWS/Lambda',
      metricName: 'Duration',
      dimensions: { FunctionName: 'mh-cmrepo1' },
      start: since,
      end: now,
    });
    expect(functionComputeUsage(PRODUCTION, 100_000)).toEqual({
      unit: 'lambda',
      gbSeconds: 172.75390625,
    });
  });

  it('destroy reads the usage from the stack’s creation, then deletes the stack', async () => {
    const a = account(new Date('2026-10-01T00:00:00Z'));
    await deployFunctionRelease(input(a));
    a.cloudwatch.durationSums.set('mh-cmrepo1', 100_000);
    const now = new Date('2026-10-02T00:00:00Z');
    const usage = await destroyFunctionRelease({ ...target(a), releaseId: '1', now: () => now });
    expect(usage).toMatchObject({
      since: new Date('2026-10-01T00:00:00Z'),
      until: now,
      runningSeconds: 86_400,
      compute: { unit: 'lambda', gbSeconds: 172.75390625 },
    });
    expect(a.cloudformation.stacks.has(STACK)).toBe(false);
    expect(a.lambda.functions.has('mh-cmrepo1')).toBe(false);
    expect(await describeFunctionRelease(target(a))).toMatchObject({ state: 'destroyed' });
  });

  it('destroying an absent release succeeds with zero usage', async () => {
    const a = account();
    const now = new Date('2026-10-02T00:00:00Z');
    const usage = await destroyFunctionRelease({ ...target(a), releaseId: '1', now: () => now });
    expect(usage).toMatchObject({
      since: now,
      until: now,
      runningSeconds: 0,
      compute: { unit: 'lambda', gbSeconds: 0 },
    });
    expect(a.cloudwatch.queries).toEqual([]);
  });

  it('a failed usage read throws a typed error and leaves the stack in place', async () => {
    const a = account();
    await deployFunctionRelease(input(a));
    a.cloudwatch.failAt('sumMetric', 1);
    const err = await destroyFunctionRelease({ ...target(a), releaseId: '1' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FunctionUsageReadError);
    expect(err).toMatchObject({ functionName: 'mh-cmrepo1', awsCode: 'InjectedFault' });
    expect(a.cloudformation.stacks.has(STACK)).toBe(true);
    expect(a.cloudformation.calls.filter((c) => c.startsWith('deleteStack'))).toEqual([]);

    a.cloudwatch.sumMetric = async () => {
      throw new Error('not an AWS answer');
    };
    await expect(
      functionUsageSince({ ...target(a), releaseId: '1', since: new Date(0) }),
    ).rejects.toMatchObject({ awsCode: 'UnknownError' });
  });

  it('replayed after a cut-off at every call, ends with the stack gone and usage returned once', async () => {
    const OPS = [
      ['cloudformation', 'describeStack'],
      ['cloudformation', 'deleteStack'],
      ['cloudwatch', 'sumMetric'],
    ] as const;
    const fresh = async () => {
      const a = account(new Date('2026-10-01T00:00:00Z'));
      await deployFunctionRelease(input(a));
      a.cloudwatch.durationSums.set('mh-cmrepo1', 100_000);
      a.cloudformation.calls.length = 0;
      return a;
    };
    const now = () => new Date('2026-10-02T00:00:00Z');
    const clean = await fresh();
    const expected = await destroyFunctionRelease({ ...target(clean), releaseId: '1', now });
    const counts = {
      describeStack: clean.cloudformation.calls.filter((c) => c.startsWith('describeStack')).length,
      deleteStack: 1,
      sumMetric: 1,
    };
    for (const [service, op] of OPS) {
      for (let n = 1; n <= counts[op]; n += 1) {
        for (const when of ['before', 'after'] as const) {
          const a = await fresh();
          (a[service] as unknown as { failAt: (o: string, n: number, w: string) => void }).failAt(
            op,
            n,
            when,
          );
          const label = `${op} #${n} ${when}`;
          const returned: unknown[] = [];
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              returned.push(await destroyFunctionRelease({ ...target(a), releaseId: '1', now }));
              break;
            } catch {
              // cut off — replay
            }
          }
          expect(returned, label).toEqual([expected]);
          expect(a.cloudformation.stacks.has(STACK), label).toBe(false);
        }
      }
    }
  });
});

describe('the function shape’s clients', () => {
  it('runs Lambda and CloudWatch on the deploy-role session only', async () => {
    const built: Array<{ service: TenantSdkService; key: string; command: string }> = [];
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
        async send(command) {
          built.push({
            service,
            key: (await config.credentials()).accessKeyId,
            command: (command as object).constructor.name,
          });
          return {};
        },
      }),
    });
    await clients.lambda.getAlias('mh-cmrepo1', LIVE_ALIAS);
    await clients.cloudwatch.sumMetric({
      namespace: 'AWS/Lambda',
      metricName: 'Duration',
      dimensions: { FunctionName: 'mh-cmrepo1' },
      start: new Date(0),
      end: new Date(60_000),
    });
    expect(built).toEqual([
      { service: 'lambda', key: 'ASIADEPLOY', command: 'GetAliasCommand' },
      { service: 'cloudwatch', key: 'ASIADEPLOY', command: 'GetMetricDataCommand' },
    ]);
  });

  /** A stub SDK client: answers each command by name, records its input. */
  function stub(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
    const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
    const client: AwsSdkClient = {
      async send(command) {
        const name = (command as object).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        sent.push({ command: name, input });
        const answer = answers[name];
        if (!answer) throw new Error(`unexpected ${name}`);
        return answer(input);
      },
    };
    return { client, sent };
  }
  const sdkError = (name: string, status = 400) =>
    Object.assign(new Error(`${name}: arn:aws:secret detail`), {
      name,
      $metadata: { httpStatusCode: status },
    });

  it('the Lambda client: alias, versions over pages, state, and AWS codes only', async () => {
    let page = 0;
    const { client, sent } = stub({
      GetAliasCommand: (i) => {
        if (i['Name'] === 'gone') throw sdkError('ResourceNotFoundException', 404);
        if (i['Name'] === 'denied') throw sdkError('AccessDeniedException', 403);
        return i['Name'] === 'empty' ? {} : { FunctionVersion: '3' };
      },
      UpdateAliasCommand: () => ({}),
      ListVersionsByFunctionCommand: () =>
        (page += 1) === 1
          ? { Versions: [{ Version: '$LATEST' }, { Version: '1' }], NextMarker: 'm' }
          : { Versions: [{ Version: '2' }, {}] },
      GetFunctionConfigurationCommand: (i) => {
        if (i['Qualifier'] === '9') throw sdkError('ResourceNotFoundException', 404);
        if (i['Qualifier'] === '8') throw sdkError('ServiceException', 500);
        return i['Qualifier'] === '7' ? {} : { State: 'Active' };
      },
    });
    const lambda = sdkTenantLambda(client);
    expect(await lambda.getAlias('f', 'live')).toBe('3');
    expect(await lambda.getAlias('f', 'gone')).toBeNull();
    expect(await lambda.getAlias('f', 'empty')).toBeNull();
    const denied = await lambda.getAlias('f', 'denied').catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(AwsTenantApiError);
    expect(denied).toMatchObject({ service: 'lambda', awsCode: 'AccessDeniedException' });
    expect(String((denied as Error).message)).not.toContain('arn:aws:secret');
    await lambda.updateAlias('f', 'live', '2');
    expect(sent.find((s) => s.command === 'UpdateAliasCommand')!.input).toEqual({
      FunctionName: 'f',
      Name: 'live',
      FunctionVersion: '2',
    });
    expect(await lambda.listVersions('f')).toEqual(['1', '2']);
    expect(
      sent.filter((s) => s.command === 'ListVersionsByFunctionCommand').map((s) => s.input),
    ).toEqual([{ FunctionName: 'f' }, { FunctionName: 'f', Marker: 'm' }]);
    expect(await lambda.getFunctionState('f', '1')).toBe('active');
    expect(await lambda.getFunctionState('f', '7')).toBe('pending');
    expect(await lambda.getFunctionState('f', '9')).toBeNull();
    await expect(lambda.getFunctionState('f', '8')).rejects.toMatchObject({
      awsCode: 'ServiceException',
    });

    const failing = sdkTenantLambda(stub({}).client);
    await expect(failing.updateAlias('f', 'live', '1')).rejects.toBeInstanceOf(AwsTenantApiError);
  });

  it('the CloudWatch client sums every page over one hour-multiple period', async () => {
    let page = 0;
    const { client, sent } = stub({
      GetMetricDataCommand: () =>
        (page += 1) === 1
          ? { MetricDataResults: [{ Values: [1000, 500] }], NextToken: 't' }
          : { MetricDataResults: [{}, { Values: [250] }] },
    });
    const cw = sdkTenantCloudWatch(client);
    const start = new Date('2026-10-01T00:00:00Z');
    const end = new Date('2026-10-01T02:30:00Z');
    expect(
      await cw.sumMetric({
        namespace: 'AWS/Lambda',
        metricName: 'Duration',
        dimensions: { FunctionName: 'f' },
        start,
        end,
      }),
    ).toBe(1750);
    expect(sent[0]!.input).toEqual({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        {
          Id: 'sum',
          ReturnData: true,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/Lambda',
              MetricName: 'Duration',
              Dimensions: [{ Name: 'FunctionName', Value: 'f' }],
            },
            Period: 3 * 3600,
            Stat: 'Sum',
          },
        },
      ],
    });
    expect(sent[1]!.input['NextToken']).toBe('t');

    const empty = sdkTenantCloudWatch(stub({ GetMetricDataCommand: () => ({}) }).client);
    expect(
      await empty.sumMetric({
        namespace: 'n',
        metricName: 'm',
        dimensions: {},
        start,
        end: start,
      }),
    ).toBe(0);
    const failing = sdkTenantCloudWatch(stub({}).client);
    await expect(
      failing.sumMetric({ namespace: 'n', metricName: 'm', dimensions: {}, start, end }),
    ).rejects.toMatchObject({ service: 'cloudwatch' });
  });

  it('puts a secret value as a version, and reads a stack’s creation time', async () => {
    const { client, sent } = stub({
      PutSecretValueCommand: () => ({}),
      DescribeStacksCommand: () => ({
        Stacks: [{ StackStatus: 'CREATE_COMPLETE', CreationTime: new Date(5) }],
      }),
    });
    const secrets = sdkTenantSecretsManager(client);
    await secrets.putSecretValue('arn', '{}', 'h'.repeat(64));
    await secrets.putSecretValue('arn', '{}');
    expect(sent.slice(0, 2).map((s) => s.input)).toEqual([
      { SecretId: 'arn', SecretString: '{}', ClientRequestToken: 'h'.repeat(64) },
      { SecretId: 'arn', SecretString: '{}' },
    ]);
    expect((await sdkTenantCloudFormation(client).describeStack('motir-a'))!.createdAt).toEqual(
      new Date(5),
    );
  });

  it('the fake secrets manager ignores the same version and refuses another value under it', async () => {
    const a = account();
    await a.secretsManager.putSecretValue('arn', 'one', 'v1');
    await a.secretsManager.putSecretValue('arn', 'one', 'v1');
    await expect(a.secretsManager.putSecretValue('arn', 'two', 'v1')).rejects.toMatchObject({
      awsCode: 'ResourceExistsException',
    });
  });

  it('the fake Lambda refuses a version or function it does not have', async () => {
    const a = account();
    await expect(a.lambda.listVersions('mh-x')).rejects.toBeInstanceOf(AwsTenantApiError);
    await expect(a.lambda.updateAlias('mh-x', LIVE_ALIAS, '1')).rejects.toBeInstanceOf(
      AwsTenantApiError,
    );
    expect(await a.lambda.getFunctionState('mh-x', '1')).toBeNull();
    a.cloudwatch.durationSums.set('mh-x', 5);
    expect(
      await a.cloudwatch.sumMetric({
        namespace: 'AWS/Lambda',
        metricName: 'Invocations',
        dimensions: { FunctionName: 'mh-x' },
        start: new Date(0),
        end: new Date(1),
      }),
    ).toBe(0);
  });

  it('the actions list covers every call the module makes', async () => {
    const CALLS: Record<string, string> = {
      getAlias: 'lambda:GetAlias',
      updateAlias: 'lambda:UpdateAlias',
      listVersions: 'lambda:ListVersionsByFunction',
      getFunctionState: 'lambda:GetFunctionConfiguration',
      sumMetric: 'cloudwatch:GetMetricData',
      putSecretValue: 'secretsmanager:PutSecretValue',
    };
    const a = account();
    await deployFunctionRelease(input(a));
    await deployFunctionRelease(input(a, { imageUri: IMAGE_B }));
    await rollbackFunctionRelease(target(a));
    await deployFunctionRelease(input(a, { imageUri: IMAGE_B }));
    await describeFunctionRelease(target(a));
    await destroyFunctionRelease({ ...target(a), releaseId: '2' });
    const made = new Set(
      [...a.lambda.calls, ...a.secretsManager.calls].map((c) => c.split(':')[0]!),
    );
    if (a.cloudwatch.queries.length > 0) made.add('sumMetric');
    expect([...made].sort()).toEqual(Object.keys(CALLS).sort());
    for (const call of made) expect(AWS_FUNCTION_DEPLOY_ACTIONS).toContain(CALLS[call]);
    // The stack's resources, too.
    for (const action of [
      'lambda:CreateFunction',
      'lambda:PublishVersion',
      'lambda:CreateAlias',
      'lambda:PutProvisionedConcurrencyConfig',
      'lambda:CreateFunctionUrlConfig',
      'lambda:AddPermission',
      'iam:PassRole',
      'secretsmanager:CreateSecret',
    ]) {
      expect(AWS_FUNCTION_DEPLOY_ACTIONS).toContain(action);
    }
    expect(new Set(AWS_FUNCTION_DEPLOY_ACTIONS).size).toBe(AWS_FUNCTION_DEPLOY_ACTIONS.length);
    expect(AWS_FUNCTION_DEPLOY_ACTIONS).not.toContain('secretsmanager:GetSecretValue');
  });

  it('imports no AWS SDK in the function directory and exports no SDK name', () => {
    const dir = join(__dirname, '..', 'src', 'adapters', 'aws', 'tenant', 'function');
    const files = readdirSync(dir);
    expect(files).toEqual(
      expect.arrayContaining([
        'index.ts',
        'lambdaClient.ts',
        'environment.ts',
        'usage.ts',
        'errors.ts',
      ]),
    );
    for (const file of files) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/@aws-sdk\//);
    }
  });
});
