import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CustomerRepositoryRefusedError,
  GithubRepositoryIdsMissingError,
  HostingAppNameInvalidError,
  IdlePolicyUnsupportedError,
  NoPreviousReleaseError,
  OrchestratorApiError,
  RegistryNotReadyError,
  ReleaseArtifactUnsupportedError,
  ReleaseNotFoundError,
  ReleaseShapeRequiredError,
  awsReleaseId,
  createAwsHostingDeployPort,
  createFakeTenantClients,
  fakeGeneratedPassword,
  hostingAppNames,
  parseAwsAppRef,
  portReleaseId,
  shapeOfProviderRef,
  shapeOfReleaseStack,
  type AwsHostingDeps,
  type AwsHostingLogLine,
  type DeployReleaseInput,
  type HostingEnvironment,
  type ReleaseShape,
} from '../src/index';

// THE AWS ADAPTER on the deploy port (MOTIR-10010), over the seam's fakes: the
// tenant account's CloudFormation, Lambda, ECS, ELB, SSM, Secrets Manager and
// Data API in memory, each able to fail at the Nth call, and the motir-core
// lookups as plain functions. Every client the adapter uses comes through the
// recorded `clientsFor`, so "no AWS call" is "clientsFor was never called".

const ORG = 'cmorg1';
const RID = 'cmrepo1';
const CUSTOMER = 'cmcustomer1';
const ACCOUNT = '210987654321';
const REGION = 'us-east-1';
const KEY = 'origin-key-do-not-leak';
const SECRET_VALUE = 'sk_live_adapter_do_not_leak';
const FORWARDER = 'arn:aws:iam::576360162297:role/motir-hosting-forwarder';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 4 };
const APP = 'mh-cmrepo1';
const PREVIEW_APP = 'mh-cmrepo1-pr4';
const T0 = new Date('2026-10-01T00:00:00Z');
const GITHUB = { githubRepositoryId: '7001', githubOwnerId: '9002' };

function harness(options: { ready?: boolean } = {}) {
  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);
  const clients = createFakeTenantClients({ accountId: ACCOUNT, region: REGION, now });
  clients.cloudformation.pollsToSettle = 0;
  const state = { ready: options.ready ?? true };
  const clientsFor: Array<{ accountId: string; region: string }> = [];
  const accountAsks: string[] = [];
  const organizationAsks: string[] = [];
  const logs: AwsHostingLogLine[] = [];
  const deps: AwsHostingDeps = {
    clientsFor: (target) => {
      clientsFor.push(target);
      return clients;
    },
    region: REGION,
    ensureTenantAccount: async (organizationId) => {
      accountAsks.push(organizationId);
      return state.ready ? { ready: true, accountId: ACCOUNT } : { ready: false, accountId: null };
    },
    organizationOf: async (repositoryId) => {
      organizationAsks.push(repositoryId);
      return ORG;
    },
    isCustomerRepository: async (repositoryId) => repositoryId === CUSTOMER,
    githubIdsOf: async () => GITHUB,
    forwarderPrincipalArn: FORWARDER,
    appHostOf: (appRef) => `${appRef}.apps.motir.test`,
    originSecretKey: KEY,
    now,
    sleep: async (ms) => {
      clock.t += ms;
    },
    pollMs: 5_000,
    timeoutMs: 600_000,
    log: (line) => logs.push(line),
  };
  const port = createAwsHostingDeployPort(deps);
  const advance = (seconds: number) => {
    clock.t += seconds * 1000;
  };
  return { port, deps, clients, state, clientsFor, accountAsks, organizationAsks, logs, advance };
}
type Harness = ReturnType<typeof harness>;

function release(
  shape: ReleaseShape | undefined,
  overrides: Partial<DeployReleaseInput> = {},
): DeployReleaseInput {
  return {
    appRef: APP,
    environment: PRODUCTION,
    artifact: { kind: 'image', ref: 'release-1', digest: 'sha256:aaa' },
    runtime: {
      port: 3000,
      healthCheck: { path: '/healthz' },
      startCommand: 'node server.js',
      database: { kind: 'postgres' },
    },
    env: [
      { name: 'NODE_ENV', value: 'production', secret: false },
      { name: 'STRIPE_KEY', value: SECRET_VALUE, secret: true },
    ],
    size: 'medium',
    idle: shape === 'function' ? { mode: 'suspend', idleSeconds: 300 } : { mode: 'always_on' },
    ...(shape ? { shape } : {}),
    ...overrides,
  };
}

const releaseStack = (appRef = APP) => `motir-release-${appRef}`;
const stackNames = (h: Harness) => [...h.clients.cloudformation.stacks.keys()].sort();
const creates = (h: Harness) =>
  h.clients.cloudformation.calls.filter((c) => c.startsWith('createStack:'));
const writes = (h: Harness) =>
  h.clients.cloudformation.calls.filter((c) => /^(createStack|updateStack):/.test(c));

/** Everything a caller or an operator could see of the adapter's work. */
function expectNoSecret(h: Harness, ...values: unknown[]) {
  const forbidden = [
    SECRET_VALUE,
    KEY,
    ...[...h.clients.secretsManager.values.keys()].map(fakeGeneratedPassword),
    'postgresql://',
  ];
  const text = JSON.stringify([...values, h.logs]);
  for (const secret of forbidden) expect(text).not.toContain(secret);
}

describe.each<ReleaseShape>(['function', 'container'])('the %s shape', (shape) => {
  it('deploys network, registry, database then the release, and describes it healthy', async () => {
    const h = harness();
    const handle = await h.port.deploy(release(shape));

    expect(creates(h)).toEqual([
      'createStack:motir-network',
      'createStack:motir-registry-cmrepo1',
      'createStack:motir-database-cmrepo1',
      `createStack:${releaseStack()}`,
    ]);
    const parameters = h.clients.cloudformation.stacks.get(releaseStack())!.parameters;
    expect(parameters['ImageUri']).toBe(
      `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/mh/cmrepo1/production@sha256:aaa`,
    );
    expect(parameters['DatabaseSecretArn']).toContain('motir/cmrepo1/production/database');
    expect(shapeOfReleaseStack(parameters)).toBe(shape);
    expect(handle).toEqual({
      target: 'aws',
      appRef: APP,
      environment: PRODUCTION,
      releaseId: awsReleaseId(APP, 1),
      providerRef: `${shape}:${releaseStack()}`,
    });

    const description = await h.port.describe(handle);
    expect(description).toMatchObject({
      state: 'healthy',
      releaseId: handle.releaseId,
      previousReleaseId: null,
      originCredential: shape === 'function' ? 'aws_sigv4' : 'origin_secret',
    });
    expect(description.upstreamAddress).toMatch(/^https?:\/\//);
    expect(h.clientsFor.every((c) => c.accountId === ACCOUNT && c.region === REGION)).toBe(true);
    expect(h.organizationAsks.every((r) => r === RID)).toBe(true);
    expectNoSecret(h, handle, description);
  });

  it('rolls a second release back to the first with no stack apply', async () => {
    const h = harness();
    const first = await h.port.deploy(release(shape));
    const second = await h.port.deploy(
      release(shape, { artifact: { kind: 'image', ref: 'release-2', digest: 'sha256:bbb' } }),
    );
    expect(second.releaseId).toBe(awsReleaseId(APP, 2));
    expect(await h.port.describe(second)).toMatchObject({
      releaseId: second.releaseId,
      previousReleaseId: first.releaseId,
    });

    const writesBefore = writes(h).length;
    const rolled = await h.port.rollback({ appRef: APP, environment: PRODUCTION });
    expect(rolled.releaseId).toBe(first.releaseId);
    expect(writes(h)).toHaveLength(writesBefore);
    expect(await h.port.describe(second)).toMatchObject({
      state: 'healthy',
      releaseId: first.releaseId,
    });
  });

  it('holds the release while the account is not ready, and completes it as the same one', async () => {
    const h = harness({ ready: false });
    const held = await h.port.deploy(release(shape));

    expect(held.releaseId).toBe(awsReleaseId(APP, 1));
    expect(await h.port.describe(held)).toEqual({
      state: 'waiting_for_account',
      releaseId: held.releaseId,
      previousReleaseId: null,
      upstreamAddress: null,
      originCredential: shape === 'function' ? 'aws_sigv4' : 'origin_secret',
    });
    expect(h.accountAsks).toEqual([ORG, ORG]);
    expect(h.clientsFor).toEqual([]);
    expect(h.clients.cloudformation.calls).toEqual([]);
    expect(await h.port.listReleases({ appRef: APP })).toEqual([]);
    expect(await h.port.usageSince(held, T0)).toMatchObject({ runningSeconds: 0 });
    expect(await h.port.destroy(held, 'operator')).toMatchObject({ runningSeconds: 0 });
    expect(await h.port.destroyApp({ appRef: APP })).toEqual([]);
    expect(h.clientsFor).toEqual([]);

    h.state.ready = true;
    const done = await h.port.deploy(release(shape));
    expect(done.releaseId).toBe(held.releaseId);
    const description = await h.port.describe(held);
    expect(description.state).toBe('healthy');
    expect(description.upstreamAddress).not.toBeNull();
  });

  it('reaches one of each stack and the same release on a repeat', async () => {
    const h = harness();
    const first = await h.port.deploy(release(shape));
    const again = await h.port.deploy(release(shape));
    expect(again.releaseId).toBe(first.releaseId);
    expect(stackNames(h)).toEqual([
      'motir-database-cmrepo1',
      'motir-network',
      'motir-registry-cmrepo1',
      releaseStack(),
    ]);
  });

  it.each([
    ['network', 1],
    ['registry', 2],
    ['database', 3],
    ['release', 4],
  ])('resumes after a failure at the %s step', async (_, n) => {
    const clean = harness();
    const expected = await clean.port.deploy(release(shape));

    const h = harness();
    h.clients.cloudformation.failAt('createStack', n);
    await expect(h.port.deploy(release(shape))).rejects.toThrow();
    const resumed = await h.port.deploy(release(shape));

    expect(resumed.releaseId).toBe(expected.releaseId);
    expect(stackNames(h)).toEqual(stackNames(clean));
    expect((await h.port.describe(resumed)).state).toBe('healthy');
  });

  it('reports usage, lists the release, and destroys it with its compute usage', async () => {
    const h = harness();
    const handle = await h.port.deploy(release(shape));
    h.clients.cloudwatch.durationSums.set(APP, 100_000);
    h.advance(3_600);

    const usage = await h.port.usageSince(handle, T0);
    expect(usage).toMatchObject({ target: 'aws', appRef: APP, releaseId: handle.releaseId });
    expect(usage.compute?.unit).toBe(shape === 'function' ? 'lambda' : 'fargate');
    expect(await h.port.listReleases({ appRef: APP })).toEqual([
      { handle: { ...handle }, state: 'healthy' },
    ]);
    expect(await h.port.listReleases({ appRef: 'mh-cmother1' })).toEqual([]);

    const destroyed = await h.port.destroy(handle, 'retired');
    expect(destroyed.compute?.unit).toBe(shape === 'function' ? 'lambda' : 'fargate');
    expect(destroyed.runningSeconds).toBeGreaterThan(0);
    expect(h.clients.cloudformation.stacks.has(releaseStack())).toBe(false);
    expect(await h.port.describe(handle)).toMatchObject({ state: 'destroyed', releaseId: null });
    expect(await h.port.destroy(handle, 'retired')).toMatchObject({ releaseId: handle.releaseId });
    expectNoSecret(h, usage, destroyed);
  });

  it("drops a preview's database at its destroy", async () => {
    const h = harness();
    const handle = await h.port.deploy(
      release(shape, { appRef: PREVIEW_APP, environment: PREVIEW }),
    );
    expect(h.clients.cloudformation.stacks.has('motir-database-cmrepo1-pr4')).toBe(true);
    expect(h.clients.rdsData.databases.has('app_pr4')).toBe(true);

    await h.port.destroy(handle, 'pull_request_closed');

    expect(h.clients.cloudformation.stacks.has(releaseStack(PREVIEW_APP))).toBe(false);
    expect(h.clients.cloudformation.stacks.has('motir-database-cmrepo1-pr4')).toBe(false);
    expect(h.clients.rdsData.databases.has('app_pr4')).toBe(false);
    expect(h.clients.cloudformation.stacks.has('motir-database-cmrepo1')).toBe(true);
  });

  it("removes the app's release and database stacks, and succeeds once they are gone", async () => {
    const h = harness();
    const handle = await h.port.deploy(release(shape));
    h.advance(60);

    const usages = await h.port.destroyApp({ appRef: APP });

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ appRef: APP, releaseId: handle.releaseId });
    expect(stackNames(h)).toEqual(['motir-network', 'motir-registry-cmrepo1']);
    expect(await h.port.destroyApp({ appRef: APP })).toEqual([]);
  });
});

describe('refusals before any work', () => {
  it('refuses a release with no shape before the account is asked for', async () => {
    const h = harness();
    await expect(h.port.deploy(release(undefined))).rejects.toMatchObject({
      constructor: ReleaseShapeRequiredError,
      code: 'HOSTING_SHAPE_REQUIRED',
    });
    expect(h.accountAsks).toEqual([]);
    expect(h.clientsFor).toEqual([]);
    expect(h.clients.cloudformation.stacks.size).toBe(0);
  });

  it('refuses a customer repository in ensureApp and deploy, before the account', async () => {
    const h = harness();
    const refused = (promise: Promise<unknown>) =>
      expect(promise).rejects.toMatchObject({
        constructor: CustomerRepositoryRefusedError,
        code: 'HOSTING_CUSTOMER_REPOSITORY_REFUSED',
        repositoryId: CUSTOMER,
      });
    await refused(h.port.ensureApp({ repositoryId: CUSTOMER, environment: PRODUCTION }));
    await refused(h.port.deploy(release('function', { appRef: `mh-${CUSTOMER}` })));
    await refused(h.port.mintDeployCredential({ pushNamespace: `mh/${CUSTOMER}/production` }));
    expect(h.accountAsks).toEqual([]);
    expect(h.clientsFor).toEqual([]);
  });

  it('refuses a suspended container through the container module, with no release stack', async () => {
    const h = harness();
    await expect(
      h.port.deploy(release('container', { idle: { mode: 'suspend', idleSeconds: 60 } })),
    ).rejects.toBeInstanceOf(IdlePolicyUnsupportedError);
    expect(h.clients.cloudformation.stacks.has(releaseStack())).toBe(false);
  });

  it('refuses a bundle, an app ref of another environment and one that is not ours', async () => {
    const h = harness();
    await expect(
      h.port.deploy(release('function', { artifact: { kind: 'bundle', ref: 'b.zip' } })),
    ).rejects.toBeInstanceOf(ReleaseArtifactUnsupportedError);
    await expect(
      h.port.deploy(release('function', { environment: PREVIEW })),
    ).rejects.toBeInstanceOf(OrchestratorApiError);
    await expect(
      h.port.deploy(release('function', { appRef: 'motir-deploy-check-x' })),
    ).rejects.toBeInstanceOf(HostingAppNameInvalidError);
    expect(h.clientsFor).toEqual([]);
  });
});

describe('ensureApp and the push credential', () => {
  it.each([
    [PRODUCTION, APP, 'mh/cmrepo1/production', 'mh-cmrepo1-production-push'],
    [PREVIEW, PREVIEW_APP, 'mh/cmrepo1/preview', 'mh-cmrepo1-preview-push'],
  ] as const)(
    'names the app and namespace and mints a federated credential (%o)',
    async (environment, appRef, pushNamespace, role) => {
      const h = harness();
      const app = await h.port.ensureApp({ repositoryId: RID, environment });

      expect(app).toEqual({ appRef, pushNamespace });
      expect(app.appRef).toBe(hostingAppNames('mh-', RID, environment).appRef);
      expect(parseAwsAppRef(app.appRef)).toEqual({ repositoryId: RID, environment });
      expect(creates(h)).toEqual([
        'createStack:motir-network',
        'createStack:motir-registry-cmrepo1',
      ]);
      expect(
        h.clients.cloudformation.stacks.get('motir-registry-cmrepo1')!.parameters,
      ).toMatchObject({
        GithubRepositoryId: GITHUB.githubRepositoryId,
        GithubOwnerId: GITHUB.githubOwnerId,
      });

      const credential = await h.port.mintDeployCredential({ pushNamespace });
      expect(credential).toEqual({
        kind: 'federated',
        pushNamespace,
        subject: `arn:aws:iam::${ACCOUNT}:role/${role}`,
      });
      expect(credential).not.toHaveProperty('value');
    },
  );

  it('answers the names with no AWS call while the account is not ready', async () => {
    const h = harness({ ready: false });
    expect(await h.port.ensureApp({ repositoryId: RID, environment: PRODUCTION })).toEqual({
      appRef: APP,
      pushNamespace: 'mh/cmrepo1/production',
    });
    await expect(
      h.port.mintDeployCredential({ pushNamespace: 'mh/cmrepo1/production' }),
    ).rejects.toBeInstanceOf(RegistryNotReadyError);
    expect(h.clientsFor).toEqual([]);
  });

  it('fails a repository with no GitHub ids before any AWS call', async () => {
    const h = harness();
    const port = createAwsHostingDeployPort({ ...h.deps, githubIdsOf: async () => null });
    await expect(
      port.ensureApp({ repositoryId: RID, environment: PRODUCTION }),
    ).rejects.toBeInstanceOf(GithubRepositoryIdsMissingError);
    expect(h.clients.cloudformation.calls).toEqual([]);
  });
});

describe('ensurePushNamespace (MOTIR-5775)', () => {
  it('applies the registry alone and answers its repository URI; revoking is a no-op', async () => {
    const h = harness();
    const made = await h.port.ensurePushNamespace({ repositoryId: RID, kind: 'preview' });
    expect(made).toEqual({
      pushNamespace: 'mh/cmrepo1/preview',
      imageRepository: expect.stringMatching(/\.dkr\.ecr\..+\/mh\/cmrepo1\/preview$/),
    });
    expect(creates(h)).toEqual(['createStack:motir-registry-cmrepo1']);
    await expect(
      h.port.revokeDeployCredentials({ pushNamespace: made.pushNamespace }),
    ).resolves.toEqual({ revoked: 0 });
  });

  it('refuses while the account is not ready, with no AWS call', async () => {
    const h = harness({ ready: false });
    await expect(
      h.port.ensurePushNamespace({ repositoryId: RID, kind: 'production' }),
    ).rejects.toBeInstanceOf(RegistryNotReadyError);
    expect(h.clientsFor).toEqual([]);
  });

  it('fails a repository with no GitHub ids, and a registry stack with no repository URI', async () => {
    const h = harness();
    const noIds = createAwsHostingDeployPort({ ...h.deps, githubIdsOf: async () => null });
    await expect(
      noIds.ensurePushNamespace({ repositoryId: RID, kind: 'preview' }),
    ).rejects.toBeInstanceOf(GithubRepositoryIdsMissingError);
    await h.port.ensurePushNamespace({ repositoryId: RID, kind: 'production' });
    const stack = h.clients.cloudformation.stacks.get('motir-registry-cmrepo1')!;
    delete (stack.outputs as Record<string, string>)['ProductionRepositoryUri'];
    await expect(
      h.port.ensurePushNamespace({ repositoryId: RID, kind: 'production' }),
    ).rejects.toBeInstanceOf(RegistryNotReadyError);
  });
});

describe('rollback', () => {
  it('answers NoPreviousReleaseError for a first release and ReleaseNotFoundError for none', async () => {
    const h = harness();
    await expect(h.port.rollback({ appRef: APP, environment: PRODUCTION })).rejects.toBeInstanceOf(
      ReleaseNotFoundError,
    );
    await h.port.deploy(release('function'));
    await expect(h.port.rollback({ appRef: APP, environment: PRODUCTION })).rejects.toBeInstanceOf(
      NoPreviousReleaseError,
    );
    await h.port.deploy(release('container', { appRef: PREVIEW_APP, environment: PREVIEW }));
    await expect(
      h.port.rollback({ appRef: PREVIEW_APP, environment: PREVIEW }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
    await expect(h.port.rollback({ appRef: APP, environment: PREVIEW })).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
  });
});

describe('the edges of routing', () => {
  it('pulls a tag when the artifact has no digest, and skips the database when none is declared', async () => {
    const h = harness();
    await h.port.deploy(
      release('function', {
        artifact: { kind: 'image', ref: 'registry.example/app:v7' },
        runtime: { ...release('function').runtime, database: { kind: 'none' } },
      }),
    );
    const parameters = h.clients.cloudformation.stacks.get(releaseStack())!.parameters;
    expect(parameters['ImageUri']).toBe(
      `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/mh/cmrepo1/production:v7`,
    );
    expect(parameters['DatabaseSecretArn']).toBe('');
    expect(h.clients.cloudformation.stacks.has('motir-database-cmrepo1')).toBe(false);
  });

  it('runs a container with no size given', async () => {
    const h = harness();
    const handle = await h.port.deploy(release('container', { size: undefined }));
    expect((await h.port.describe(handle)).state).toBe('healthy');
  });

  it('treats a ready answer with no account id as not ready', async () => {
    const h = harness();
    const port = createAwsHostingDeployPort({
      ...h.deps,
      ensureTenantAccount: async () => ({ ready: true, accountId: null }),
    });
    const held = await port.deploy(release('function'));
    expect((await port.describe({ ...held, providerRef: 'elsewhere' })).originCredential).toBe(
      'none',
    );
    expect(h.clientsFor).toEqual([]);
  });

  it('works with only the required dependencies', async () => {
    const h = harness();
    const { sleep: _s, pollMs: _p, timeoutMs: _t, log: _l, now: _n, ...required } = h.deps;
    const port = createAwsHostingDeployPort(required);
    await expect(port.deploy(release(undefined))).rejects.toBeInstanceOf(ReleaseShapeRequiredError);
    const app = await port.ensureApp({ repositoryId: RID, environment: PRODUCTION });
    expect(app.appRef).toBe(APP);
  });

  it('lists a release still deploying under its first id, and not a stack of another repository', async () => {
    const h = harness();
    const handle = await h.port.deploy(release('function'));
    const stack = h.clients.cloudformation.stacks.get(releaseStack())!;
    delete stack.outputs['LiveVersion'];
    expect(await h.port.listReleases({ appRef: APP })).toEqual([{ handle, state: 'deploying' }]);
    stack.tags['motir:repository'] = 'cmother1';
    expect(await h.port.listReleases({ appRef: APP })).toEqual([]);
    stack.tags['motir:repository'] = RID;
    expect(await h.port.destroyApp({ appRef: APP })).toMatchObject([
      { releaseId: handle.releaseId },
    ]);
  });

  it('destroys what it cannot route with zero usage, and a bare preview app', async () => {
    const h = harness();
    const usage = await h.port.destroy(
      {
        target: 'aws',
        appRef: APP,
        environment: PRODUCTION,
        releaseId: 'mh-cmrepo1:9',
        providerRef: 'elsewhere',
      },
      'reaped',
    );
    expect(usage).toMatchObject({ releaseId: 'mh-cmrepo1:9', runningSeconds: 0 });
    expect(usage.compute).toBeUndefined();
    expect(
      await h.port.usageSince(
        {
          target: 'aws',
          appRef: APP,
          environment: PRODUCTION,
          releaseId: 'mh-cmrepo1:9',
          providerRef: 'elsewhere',
        },
        T0,
      ),
    ).toMatchObject({ runningSeconds: 0 });
    expect(await h.port.destroyApp({ appRef: PREVIEW_APP })).toEqual([]);
  });

  it('passes a provider failure in a rollback through unchanged', async () => {
    const h = harness();
    await h.port.deploy(release('function'));
    h.clients.lambda.failAt('getAlias', 1);
    await expect(
      h.port.rollback({ appRef: APP, environment: PRODUCTION }),
    ).rejects.not.toBeInstanceOf(NoPreviousReleaseError);
  });
});

describe('the release-id helpers', () => {
  it('maps provider releases to port ids and back to shapes', () => {
    expect(portReleaseId('function', APP, '3')).toBe('mh-cmrepo1:3');
    expect(
      portReleaseId(
        'container',
        APP,
        `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/mh-cmrepo1:12`,
      ),
    ).toBe('mh-cmrepo1:12');
    expect(portReleaseId('function', APP, null)).toBeNull();
    expect(shapeOfProviderRef('container:motir-release-mh-x')).toBe('container');
    expect(shapeOfProviderRef('fake-mh-x')).toBeNull();
    expect(shapeOfReleaseStack({ AppRef: 'x' })).toBeNull();
    expect(() => parseAwsAppRef('mh-CAPS')).toThrow(HostingAppNameInvalidError);
  });

  it('exports no AWS SDK type from the adapter files', () => {
    for (const file of ['hostingAdapter.ts', 'releaseIds.ts']) {
      const source = readFileSync(join(__dirname, '../src/adapters/aws/tenant', file), 'utf8');
      expect(source).not.toMatch(/@aws-sdk/);
    }
  });
});
