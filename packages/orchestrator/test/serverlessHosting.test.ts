import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostingAppNameInvalidError,
  LAMBDA_ENV_LIMIT_BYTES,
  NoPreviousReleaseError,
  OrchestratorApiError,
  ReleaseArtifactUnsupportedError,
  ReleaseNotFoundError,
  ReleaseRuntimeRefusedError,
  SERVERLESS_ENV_SECRET_VAR,
  createServerlessHostingDeployPort,
  serverlessReleaseState,
  signFunctionUrlRequest,
  type DeployReleaseInput,
  type HostingEnvironment,
  type ReleaseEnvVar,
  type ServerlessHostingConfig,
  type ServerlessSdkClientFactory,
} from '../src/index';
import { SIM_ACCOUNT, SIM_REGION, createLambdaSim } from './contract/hostingLambdaSim';

// MOTIR-9972 — the serverless adapter's own cases, the ones the shared deploy
// contract does not cover: what Lambda is told to run, the function-URL
// signature, the overflow secret, usage before delete, the refusals before any
// provider call, the ECR repository's life, and no secret value anywhere the
// adapter answers. Driven through the in-memory account at the SDK seam.

const START = Date.parse('2026-10-28T00:00:00.000Z');
const REGISTRY = `${SIM_ACCOUNT}.dkr.ecr.${SIM_REGION}.amazonaws.com`;
const CONFIG: ServerlessHostingConfig = {
  roleArn: `arn:aws:iam::${SIM_ACCOUNT}:role/motir-hosting-serverless-deploy`,
  accountId: SIM_ACCOUNT,
  region: SIM_REGION,
  appPrefix: 'mh-',
};
const PRODUCTION: HostingEnvironment = { kind: 'production' };

function setup(wrap?: (factory: ServerlessSdkClientFactory) => ServerlessSdkClientFactory) {
  let clock = START;
  const sim = createLambdaSim(() => clock);
  const sleep = vi.fn(async () => {});
  const clientFactory = wrap ? wrap(sim.clientFactory) : sim.clientFactory;
  const deps = { clientFactory, now: () => new Date(clock), sleep };
  const port = createServerlessHostingDeployPort(CONFIG, deps);
  return {
    sim,
    port,
    sleep,
    deps,
    advance(seconds: number) {
      sim.advanceSeconds(seconds);
      clock += seconds * 1000;
    },
  };
}

function release(
  appRef: string,
  overrides: Partial<DeployReleaseInput> = {},
  env: readonly ReleaseEnvVar[] = [],
): DeployReleaseInput {
  return {
    appRef,
    environment: PRODUCTION,
    artifact: { kind: 'image', ref: `${REGISTRY}/mh/r1/production`, digest: 'sha256:one' },
    runtime: {
      port: 3000,
      healthCheck: { path: '/api/health' },
      startCommand: 'node  server.js',
      database: { kind: 'none' },
    },
    env,
    idle: { mode: 'suspend', idleSeconds: 300 },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serverlessReleaseState', () => {
  it.each([
    ['Active', 'Successful', 'healthy'],
    ['Pending', 'InProgress', 'deploying'],
    ['Active', 'InProgress', 'deploying'],
    ['Failed', 'Successful', 'unhealthy'],
    ['Active', 'Failed', 'unhealthy'],
    ['Inactive', 'Successful', 'stopped'],
  ] as const)('%s / %s is %s', (state, update, expected) => {
    expect(serverlessReleaseState(state, update)).toBe(expected);
  });
});

describe('the serverless adapter', () => {
  it('ensureApp makes the ECR repository once and names the units by the decision page', async () => {
    const { port, sim } = setup();
    const production = await port.ensureApp({ repositoryId: 'r1', environment: PRODUCTION });
    expect(production).toEqual({ appRef: 'mh-r1', pushNamespace: 'mh/r1/production' });
    expect(await port.ensureApp({ repositoryId: 'r1', environment: PRODUCTION })).toEqual(
      production,
    );
    const preview = await port.ensureApp({
      repositoryId: 'r1',
      environment: { kind: 'preview', pullRequest: 4 },
    });
    expect(preview).toEqual({ appRef: 'mh-r1-pr4', pushNamespace: 'mh/r1/preview' });
    expect([...sim.repositories].sort()).toEqual(['mh/r1/preview', 'mh/r1/production']);
    expect(sim.calls.some((c) => c.service === 'lambda')).toBe(false);
  });

  it('mints a federated credential naming the push role, and creates nothing', async () => {
    const { port, sim } = setup();
    expect(await port.mintDeployCredential({ pushNamespace: 'mh/r1/preview' })).toEqual({
      kind: 'federated',
      pushNamespace: 'mh/r1/preview',
      subject: `arn:aws:iam::${SIM_ACCOUNT}:role/mh-r1-preview-push`,
    });
    expect(await port.mintDeployCredential({ pushNamespace: 'mh/r1/production' })).toMatchObject({
      subject: expect.stringMatching(/role\/mh-r1-production-push$/),
    });
    await expect(port.mintDeployCredential({ pushNamespace: 'mh-r1' })).rejects.toBeInstanceOf(
      HostingAppNameInvalidError,
    );
    expect(sim.calls).toEqual([]);
  });

  it('deploys: the Web Adapter settings, the image by digest, 1,769 MB x86_64, a version and live', async () => {
    const { port, sim, sleep } = setup();
    const handle = await port.deploy(
      release('mh-r1', {}, [{ name: 'GREETING', value: 'hello', secret: false }]),
    );
    expect(handle).toEqual({
      target: 'serverless',
      appRef: 'mh-r1',
      environment: PRODUCTION,
      releaseId: '1',
      providerRef: 'mh-r1',
    });
    const create = sim.calls.find((c) => c.command === 'CreateFunctionCommand')!.input;
    expect(create).toMatchObject({
      PackageType: 'Image',
      Code: { ImageUri: `${REGISTRY}/mh/r1/production@sha256:one` },
      Architectures: ['x86_64'],
      MemorySize: 1769,
      Role: `arn:aws:iam::${SIM_ACCOUNT}:role/mh-shared-exec`,
      ImageConfig: { Command: ['node', 'server.js'] },
      Environment: {
        Variables: {
          GREETING: 'hello',
          AWS_LWA_PORT: '3000',
          AWS_LWA_READINESS_CHECK_PATH: '/api/health',
          AWS_LWA_INVOKE_MODE: 'response_stream',
        },
      },
    });
    const url = sim.calls.find((c) => c.command === 'CreateFunctionUrlConfigCommand')!.input;
    expect(url).toMatchObject({
      Qualifier: 'live',
      AuthType: 'AWS_IAM',
      InvokeMode: 'RESPONSE_STREAM',
    });
    // It waited for Lambda to finish creating the function before publishing.
    expect(sleep).toHaveBeenCalled();
    const order = sim.calls.map((c) => c.command);
    expect(order.indexOf('PublishVersionCommand')).toBeLessThan(
      order.indexOf('CreateAliasCommand'),
    );
    expect(sim.functions.get('mh-r1')!.aliases.get('live')).toBe('1');
  });

  it('a request signed with signFunctionUrlRequest reaches the release; an unsigned one does not', async () => {
    const { port, sim, deps } = setup();
    const handle = await port.deploy(release('mh-r1'));
    const { upstreamAddress } = await port.describe(handle);
    const address = upstreamAddress!;
    expect(sim.invoke(address, {})).toBe(403);
    const signed = await signFunctionUrlRequest(
      `${address}api/health?x=1`,
      {},
      {
        config: CONFIG,
        ...deps,
      },
    );
    expect(signed.method).toBe('GET');
    expect(sim.invoke(address, signed.headers)).toBe(200);
    expect(sim.invoke('https://nowhere.lambda-url.us-east-1.on.aws/', signed.headers)).toBe(404);
  });

  it('a second deploy keeps the address and the first as previous; rollback swaps them', async () => {
    const { port } = setup();
    const a = await port.deploy(release('mh-r1'));
    const before = await port.describe(a);
    const b = await port.deploy(
      release('mh-r1', { artifact: { kind: 'image', ref: `${REGISTRY}/mh/r1/production:v2` } }),
    );
    expect(b.releaseId).toBe('2');
    const after = await port.describe(a);
    expect(after).toMatchObject({ releaseId: '2', previousReleaseId: '1' });
    expect(after.upstreamAddress).toBe(before.upstreamAddress);

    const back = await port.rollback({ appRef: 'mh-r1', environment: PRODUCTION });
    expect(back.releaseId).toBe('1');
    expect(await port.describe(b)).toMatchObject({
      state: 'healthy',
      releaseId: '1',
      previousReleaseId: '2',
      upstreamAddress: before.upstreamAddress,
    });
  });

  it('a retried deploy of the release already live is a no-op that keeps the previous one', async () => {
    const { port, sim } = setup();
    await port.deploy(release('mh-r1'));
    await port.deploy(
      release('mh-r1', { artifact: { kind: 'image', ref: `${REGISTRY}/mh/r1/production:v2` } }),
    );
    const again = await port.deploy(
      release('mh-r1', { artifact: { kind: 'image', ref: `${REGISTRY}/mh/r1/production:v2` } }),
    );
    expect(again.releaseId).toBe('2');
    expect(sim.functions.get('mh-r1')!.versions).toHaveLength(2);
    expect(await port.describe(again)).toMatchObject({ releaseId: '2', previousReleaseId: '1' });
  });

  it('a deploy that fails after publishing leaves the old release live, and its retry finishes', async () => {
    const { port, sim } = setup();
    await port.deploy(release('mh-r1'));
    sim.failNext('UpdateAliasCommand');
    const v2 = release('mh-r1', {
      artifact: { kind: 'image', ref: `${REGISTRY}/mh/r1/production:v2` },
    });
    await expect(port.deploy(v2)).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(sim.functions.get('mh-r1')!.aliases.get('live')).toBe('1');
    const retried = await port.deploy(v2);
    expect(retried.releaseId).toBe('2');
    expect(await port.describe(retried)).toMatchObject({ releaseId: '2', previousReleaseId: '1' });
  });

  it('rollback: an unknown app is not found; a first deploy has no previous release', async () => {
    const { port } = setup();
    await expect(
      port.rollback({ appRef: 'mh-none', environment: PRODUCTION }),
    ).rejects.toBeInstanceOf(ReleaseNotFoundError);
    await port.deploy(release('mh-r1'));
    await expect(
      port.rollback({ appRef: 'mh-r1', environment: PRODUCTION }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
  });

  it('describes a function with no live alias yet as deploying, and a missing one as destroyed', async () => {
    const { port, sim } = setup();
    sim.failNext('CreateAliasCommand');
    await expect(port.deploy(release('mh-r1'))).rejects.toBeInstanceOf(OrchestratorApiError);
    const handle = {
      target: 'serverless' as const,
      appRef: 'mh-r1',
      environment: PRODUCTION,
      releaseId: '1',
      providerRef: 'mh-r1',
    };
    expect(await port.describe(handle)).toMatchObject({ state: 'deploying', releaseId: null });
    expect(await port.listReleases({ appRef: 'mh-r1' })).toEqual([
      { handle: { ...handle, releaseId: '' }, state: 'deploying' },
    ]);
    expect(await port.describe({ ...handle, appRef: 'mh-gone' })).toEqual({
      state: 'destroyed',
      releaseId: null,
      previousReleaseId: null,
      upstreamAddress: null,
      originCredential: 'none',
    });
    expect(await port.listReleases({ appRef: 'mh-gone' })).toEqual([]);
  });

  it('waits out an update, and fails typed when Lambda reports it failed or never settles', async () => {
    const failed = setup((factory) => (service, options) => {
      const client = factory(service, options);
      return {
        async send(command) {
          const out = (await client.send(command)) as Record<string, unknown>;
          if ((command as object).constructor.name !== 'GetFunctionCommand') return out;
          const c = out['Configuration'] as Record<string, unknown>;
          return { ...out, Configuration: { ...c, State: 'Failed' } };
        },
      };
    });
    await expect(failed.port.deploy(release('mh-r1'))).rejects.toThrow(/function update failed/);

    const stuck = setup((factory) => (service, options) => {
      const client = factory(service, options);
      return {
        async send(command) {
          const out = (await client.send(command)) as Record<string, unknown>;
          if ((command as object).constructor.name !== 'GetFunctionCommand') return out;
          const c = out['Configuration'] as Record<string, unknown>;
          return { ...out, Configuration: { ...c, State: 'Pending' } };
        },
      };
    });
    await expect(stuck.port.deploy(release('mh-r1'))).rejects.toThrow(/did not become active/);
    expect(stuck.sleep).toHaveBeenCalledTimes(59);

    const vanished = setup();
    await vanished.port.deploy(release('mh-r1'));
    // The deploy's own read finds it; the wait's read finds it gone.
    let reads = 0;
    vanished.sim.failNext(
      'GetFunctionCommand',
      () => ++reads === 2,
      'ResourceNotFoundException',
      404,
    );
    await expect(vanished.port.deploy(release('mh-r1'))).rejects.toThrow(/vanished/);
  });

  it('moves every pair to the overflow secret above 4 KB, and destroy removes it with the function', async () => {
    const { port, sim } = setup();
    const big = 'v'.repeat(LAMBDA_ENV_LIMIT_BYTES);
    const env: ReleaseEnvVar[] = [
      { name: 'SMALL', value: 'tiny-value', secret: true },
      { name: 'BIG', value: big, secret: true },
    ];
    const handle = await port.deploy(release('mh-r1', {}, env));
    const variables = sim.liveSnapshot('mh-r1')!.variables;
    expect(variables).toEqual({
      AWS_LWA_PORT: '3000',
      AWS_LWA_READINESS_CHECK_PATH: '/api/health',
      AWS_LWA_INVOKE_MODE: 'response_stream',
      [SERVERLESS_ENV_SECRET_VAR]: 'mh-r1',
    });
    expect(JSON.parse(sim.secrets.get('mh-r1')!)).toEqual({ SMALL: 'tiny-value', BIG: big });
    // A redeploy rewrites the same secret.
    await port.deploy(release('mh-r1', {}, [...env, { name: 'MORE', value: 'm', secret: true }]));
    expect(JSON.parse(sim.secrets.get('mh-r1')!)).toHaveProperty('MORE', 'm');

    await port.destroy(handle, 'retired');
    expect(sim.functions.has('mh-r1')).toBe(false);
    expect(sim.secrets.has('mh-r1')).toBe(false);
    expect(sim.logGroups.has('/aws/lambda/mh-r1')).toBe(false);
  });

  it('destroy reads usage before it deletes anything; a failed read throws and deletes nothing', async () => {
    const { port, sim, advance } = setup();
    const handle = await port.deploy(release('mh-r1'));
    advance(45);
    sim.failNext('GetMetricDataCommand');
    await expect(port.destroy(handle, 'retired')).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(sim.calls.some((c) => c.command.startsWith('Delete'))).toBe(false);
    expect(sim.functions.has('mh-r1')).toBe(true);

    const usage = await port.destroy(handle, 'retired');
    expect(usage).toMatchObject({
      target: 'serverless',
      appRef: 'mh-r1',
      releaseId: '1',
      since: new Date(START),
      runningSeconds: 45,
      invocations: 45,
    });
    const order = sim.calls.map((c) => c.command);
    expect(order.lastIndexOf('GetMetricDataCommand')).toBeLessThan(
      order.indexOf('DeleteFunctionCommand'),
    );
  });

  it('usageSince counts compute and invocations in the window; a gone release has none', async () => {
    const { port, advance } = setup();
    const handle = await port.deploy(release('mh-r1'));
    advance(30);
    advance(60);
    const window = await port.usageSince(handle, new Date(START + 30_000));
    expect(window).toMatchObject({ runningSeconds: 60, invocations: 60 });
    expect(await port.usageSince(handle, new Date(START + 90_000))).toMatchObject({
      runningSeconds: 0,
    });
    const gone = await port.usageSince({ ...handle, appRef: 'mh-gone' }, new Date(START));
    expect(gone).toMatchObject({ runningSeconds: 0, invocations: 0 });
  });

  it('destroyApp deletes the preview repository only with the last preview, production’s with production', async () => {
    const { port, sim } = setup();
    const pr = (n: number): HostingEnvironment => ({ kind: 'preview', pullRequest: n });
    for (const n of [7, 8, 9]) {
      const app = await port.ensureApp({ repositoryId: 'r1', environment: pr(n) });
      await port.deploy(release(app.appRef, { environment: pr(n) }));
    }
    await port.ensureApp({ repositoryId: 'r1', environment: PRODUCTION });
    await port.deploy(release('mh-r1'));

    expect(await port.destroyApp({ appRef: 'mh-r1-pr7' })).toHaveLength(1);
    expect(await port.destroyApp({ appRef: 'mh-r1-pr8' })).toHaveLength(1);
    expect(sim.repositories.has('mh/r1/preview')).toBe(true);
    expect(await port.destroyApp({ appRef: 'mh-r1-pr9' })).toHaveLength(1);
    expect(sim.repositories.has('mh/r1/preview')).toBe(false);
    expect(sim.repositories.has('mh/r1/production')).toBe(true);
    expect(await port.destroyApp({ appRef: 'mh-r1' })).toHaveLength(1);
    expect(sim.repositories.size).toBe(0);
    // Not one of this prefix's units: nothing to remove, no repository guessed.
    expect(await port.destroyApp({ appRef: 'other-r1' })).toEqual([]);
  });

  it.each([
    ['a bundle', { kind: 'bundle', ref: 's3://x' } as const, ReleaseArtifactUnsupportedError],
    [
      'an image outside ECR',
      { kind: 'image', ref: 'docker.io/traefik/whoami', digest: 'sha256:a' } as const,
      ReleaseArtifactUnsupportedError,
    ],
    [
      'another account’s ECR image',
      { kind: 'image', ref: `111111111111.dkr.ecr.${SIM_REGION}.amazonaws.com/x` } as const,
      ReleaseArtifactUnsupportedError,
    ],
  ])('refuses %s before any provider call', async (_label, artifact, error) => {
    const { port, sim } = setup();
    await expect(port.deploy(release('mh-r1', { artifact }))).rejects.toBeInstanceOf(error);
    expect(sim.calls).toEqual([]);
  });

  it('refuses always-on by the field’s name before any provider call', async () => {
    const { port, sim } = setup();
    const refused = port.deploy(release('mh-r1', { idle: { mode: 'always_on' } }));
    await expect(refused).rejects.toBeInstanceOf(ReleaseRuntimeRefusedError);
    await expect(
      port.deploy(release('mh-r1', { idle: { mode: 'always_on' } })),
    ).rejects.toMatchObject({ field: 'idle', target: 'serverless' });
    expect(sim.calls).toEqual([]);
  });

  it('puts no secret value in any handle, description, usage, list entry, tag or error', async () => {
    const SECRET = 'pair-value-must-not-leak-41f2';
    const OVERFLOW_SECRET = 'overflow-value-must-not-leak-9c0d';
    // An AWS message that quotes the request back, as some do.
    const quoting: Parameters<typeof setup>[0] = (factory) => (service, options) => {
      const client = factory(service, options);
      let refused = false;
      return {
        async send(command) {
          const name = (command as object).constructor.name;
          if (name === 'UpdateFunctionConfigurationCommand' && !refused) {
            refused = true;
            throw Object.assign(new Error(`bad value ${JSON.stringify(command)}`), {
              name: 'InvalidParameterValueException',
              $metadata: { httpStatusCode: 400 },
            });
          }
          return client.send(command);
        },
      };
    };
    const { port, sim, advance } = setup(quoting);
    const errors: unknown[] = [];
    const returned: unknown[] = [];
    const env = [{ name: 'DATABASE_URL', value: SECRET, secret: true }];
    const a = await port.deploy(release('mh-r1', {}, env));
    returned.push(a, await port.describe(a));
    await port
      .deploy(
        release(
          'mh-r1',
          { artifact: { kind: 'image', ref: `${REGISTRY}/mh/r1/production:v2` } },
          env,
        ),
      )
      .catch((e: unknown) => errors.push(e));
    const b = await port.deploy(
      release('mh-r1', { artifact: { kind: 'image', ref: `${REGISTRY}/mh/r1/production:v2` } }, [
        ...env,
        { name: 'HUGE', value: `${OVERFLOW_SECRET}${'x'.repeat(5000)}`, secret: true },
      ]),
    );
    returned.push(b, await port.describe(b));
    returned.push(await port.rollback({ appRef: 'mh-r1', environment: PRODUCTION }));
    advance(10);
    returned.push(
      await port.usageSince(a, new Date(START)),
      await port.listReleases({ appRef: 'mh-r1' }),
    );
    sim.failNext('GetMetricDataCommand');
    await port.destroy(a, 'retired').catch((e: unknown) => errors.push(e));
    returned.push(await port.destroy(a, 'retired'), await port.destroyApp({ appRef: 'mh-r1' }));

    expect(errors).toHaveLength(2);
    const tags = sim.calls
      .filter((c) => c.command === 'TagResourceCommand' || c.command === 'CreateFunctionCommand')
      .map((c) => c.input['Tags']);
    const text = [
      ...returned.map((v) => JSON.stringify(v)),
      ...errors.map((e) => `${(e as Error).name} ${(e as Error).message} ${JSON.stringify(e)}`),
      JSON.stringify(tags),
    ].join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OVERFLOW_SECRET);
    // …and the session credentials the role was assumed with are nowhere either.
    for (const n of [1, 2, 3]) expect(text).not.toContain(`sim-session-secret-${n}`);
    expect(
      sim.calls.some((c) => c.service === 'sts' && c.input['RoleArn'] !== CONFIG.roleArn),
    ).toBe(false);
  });
});
