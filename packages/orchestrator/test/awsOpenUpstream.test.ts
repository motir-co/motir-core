import { describe, expect, it } from 'vitest';
import {
  OrchestratorApiError,
  ReleaseNotFoundError,
  awsProviderRef,
  awsReleaseId,
  createAwsHostingDeployPort,
  createFakeTenantClients,
  deriveOriginSecret,
  frontDoorRevision,
  openParameters,
  originAccessOf,
  type AwsHostingDeps,
  type AwsHostingLogLine,
  type DeployReleaseInput,
  type HostingEnvironment,
  type ReleaseHandle,
  type ReleaseShape,
} from '../src/index';

// THE OPEN MODE (MOTIR-12128), over the seam's fakes: `openUpstream` switches
// ONE production release to answer without Motir's origin secret and returns
// the address it answers at, and every later deploy keeps it open. The fake
// account's request path (`clients.edge`) routes a request the way the release
// stacks do, so "answers" means a request reached the app.

const ORG = 'cmorg1';
const ACCOUNT = '210987654321';
const REGION = 'us-east-1';
const KEY = 'origin-key-do-not-leak';
const FORWARDER = 'arn:aws:iam::576360162297:role/motir-hosting-forwarder';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 4 };
const APP = 'mh-cmrepo1';
const OTHER_APP = 'mh-cmrepo2';
const PREVIEW_APP = 'mh-cmrepo1-pr4';
const STACK = `motir-release-${APP}`;
const SECRET = deriveOriginSecret(KEY, APP);
const SHARED = 'https://d1fake0frontdoor.cloudfront.net';

function harness() {
  const clock = { t: new Date('2026-11-23T00:00:00Z').getTime() };
  const now = () => new Date(clock.t);
  const clients = createFakeTenantClients({ accountId: ACCOUNT, region: REGION, now });
  clients.cloudformation.pollsToSettle = 0;
  const state = { ready: true };
  const logs: AwsHostingLogLine[] = [];
  const deps: AwsHostingDeps = {
    clientsFor: () => clients,
    region: REGION,
    ensureTenantAccount: async () =>
      state.ready ? { ready: true, accountId: ACCOUNT } : { ready: false, accountId: null },
    organizationOf: async () => ORG,
    isCustomerRepository: async () => false,
    githubIdsOf: async () => ({ githubRepositoryId: '7001', githubOwnerId: '9002' }),
    forwarderPrincipalArn: FORWARDER,
    originSecretKey: KEY,
    now,
    sleep: async (ms) => {
      clock.t += ms;
    },
    pollMs: 5_000,
    timeoutMs: 600_000,
    log: (line) => logs.push(line),
  };
  return { port: createAwsHostingDeployPort(deps), clients, state, logs, deps };
}
type Harness = ReturnType<typeof harness>;

function release(
  shape: ReleaseShape,
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
      database: { kind: 'none' },
    },
    env: [{ name: 'NODE_ENV', value: 'production', secret: false }],
    size: 'small',
    idle: shape === 'function' ? { mode: 'suspend', idleSeconds: 300 } : { mode: 'always_on' },
    shape,
    ...overrides,
  };
}

const handleOf = (
  appRef: string,
  shape: ReleaseShape,
  environment: HostingEnvironment = PRODUCTION,
): ReleaseHandle => ({
  target: 'aws',
  appRef,
  environment,
  releaseId: awsReleaseId(appRef, 1),
  providerRef: awsProviderRef(shape, `motir-release-${appRef}`),
});

const writes = (h: Harness) =>
  h.clients.cloudformation.calls.filter((c) => /^(createStack|updateStack):/.test(c));
const params = (h: Harness, stack = STACK) =>
  h.clients.cloudformation.stacks.get(stack)!.parameters;

/** The address Motir's edge reaches the app at, with the secret it sends. */
function motirPath(h: Harness, shape: ReleaseShape): string {
  return shape === 'function'
    ? h.clients.cloudformation.stacks.get(STACK)!.outputs['FrontDoorUrl']!
    : SHARED;
}

describe.each<ReleaseShape>(['function', 'container'])('openUpstream on a %s release', (shape) => {
  it('returns the release’s open address, and a second call applies no stack', async () => {
    const h = harness();
    await h.port.deploy(release(shape));
    expect(originAccessOf(params(h))).toBe('motir_edge');
    const before = writes(h).length;

    const opened = await h.port.openUpstream(handleOf(APP, shape));
    const outputs = h.clients.cloudformation.stacks.get(STACK)!.outputs;
    const expected = shape === 'function' ? outputs['FrontDoorUrl'] : outputs['OpenUpstreamUrl'];
    expect(opened).toEqual({ upstreamAddress: expected });
    expect(opened.upstreamAddress).toMatch(
      shape === 'function'
        ? /\.lambda-url\.us-east-1\.on\.aws\/$/
        : /^https:\/\/d[0-9a-f]+\.cloudfront\.net$/,
    );
    expect(opened.upstreamAddress).not.toBe(SHARED);
    expect(params(h)['OriginAccess']).toBe('open');
    expect(writes(h)).toEqual([...writes(h).slice(0, before), `updateStack:${STACK}`]);

    const again = await h.port.openUpstream(handleOf(APP, shape));
    expect(again).toEqual(opened);
    expect(writes(h)).toHaveLength(before + 1);
    expect(h.logs.map((l) => l.step)).toEqual(
      expect.arrayContaining(['release opened', 'release already open']),
    );
  });

  it('answers at the open address without the secret, and still through Motir’s path with it', async () => {
    const h = harness();
    await h.port.deploy(release(shape));
    // Motir-only before: no secret, no answer.
    expect(h.clients.edge.request(motirPath(h, shape)).status).toBe(403);
    expect(
      h.clients.edge.request(motirPath(h, shape), { 'X-Motir-Origin-Secret': SECRET }),
    ).toMatchObject({
      status: 200,
      appRef: APP,
    });

    const { upstreamAddress } = await h.port.openUpstream(handleOf(APP, shape));
    const open = h.clients.edge.request(upstreamAddress, { Accept: 'text/html' });
    expect(open).toMatchObject({ status: 200, appRef: APP });
    expect(JSON.stringify(open.forwardedHeaders)).not.toContain(SECRET);
    // The motir.site host and customer domains: Motir's edge, with the secret.
    const edge = h.clients.edge.request(motirPath(h, shape), {
      'X-Motir-Origin-Secret': SECRET,
    });
    expect(edge).toMatchObject({ status: 200, appRef: APP });
    expect(edge.forwardedHeaders).not.toHaveProperty(
      shape === 'function' ? 'x-motir-origin-secret' : 'host',
    );
  });

  it('is kept open by every later deploy', async () => {
    const h = harness();
    await h.port.deploy(release(shape));
    const { upstreamAddress } = await h.port.openUpstream(handleOf(APP, shape));
    const opened = { ...params(h) };

    await h.port.deploy(
      release(shape, { artifact: { kind: 'image', ref: 'release-2', digest: 'sha256:bbb' } }),
    );
    expect(params(h)['ImageUri']).toContain('sha256:bbb');
    expect(params(h)['OriginAccess']).toBe('open');
    if (shape === 'container') {
      expect(params(h)['OpenListenerRulePriority']).toBe(opened['OpenListenerRulePriority']);
      expect(params(h)['FrontDoorVpcOriginId']).toBe('vo_fake0frontdoor');
    } else {
      expect(params(h)['FrontDoorRevision']).toBe(opened['FrontDoorRevision']);
    }
    expect(h.clients.edge.request(upstreamAddress)).toMatchObject({ status: 200, appRef: APP });
    expect(await h.port.openUpstream(handleOf(APP, shape))).toEqual({ upstreamAddress });
  });

  it('deploys a stack that carries no OriginAccess as motir_edge', async () => {
    const h = harness();
    await h.port.deploy(release(shape));
    const record = h.clients.cloudformation.stacks.get(STACK)!;
    const { OriginAccess: _dropped, ...older } = record.parameters;
    record.parameters = older;
    await h.port.deploy(
      release(shape, { artifact: { kind: 'image', ref: 'release-2', digest: 'sha256:bbb' } }),
    );
    expect(params(h)['OriginAccess']).toBe('motir_edge');
    expect(h.clients.edge.request(motirPath(h, shape)).status).toBe(403);
  });

  it('re-derives the origin secret, which the stack describes masked (NoEcho)', async () => {
    const h = harness();
    await h.port.deploy(release(shape));
    h.clients.cloudformation.stacks.get(STACK)!.parameters['OriginSecret'] = '****';
    await h.port.openUpstream(handleOf(APP, shape));
    expect(params(h)['OriginSecret']).toBe(SECRET);
    if (shape === 'function') {
      const template = h.clients.cloudformation.stacks.get(STACK)!.templateBody;
      expect(params(h)['FrontDoorRevision']).toBe(frontDoorRevision(SECRET, template, 'open'));
      expect(params(h)['FrontDoorRevision']).not.toBe(
        frontDoorRevision(SECRET, template, 'motir_edge'),
      );
    }
  });

  it('waits out an open apply still in progress and applies nothing new', async () => {
    const h = harness();
    await h.port.deploy(release(shape));
    const opened = await h.port.openUpstream(handleOf(APP, shape));
    const before = writes(h).length;
    h.clients.cloudformation.setStatus(STACK, 'UPDATE_IN_PROGRESS', 1, 'UPDATE_COMPLETE');
    expect(await h.port.openUpstream(handleOf(APP, shape))).toEqual(opened);
    expect(writes(h)).toHaveLength(before);
  });

  it('refuses a stack released before the open mode, applying nothing', async () => {
    const h = harness();
    await h.port.deploy(release(shape));
    const record = h.clients.cloudformation.stacks.get(STACK)!;
    record.templateBody = record.templateBody.replace(/^ {2}OriginAccess:$/m, '  Retired:');
    const before = writes(h).length;
    const err = await h.port.openUpstream(handleOf(APP, shape)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).toMatchObject({ status: 409 });
    expect(writes(h)).toHaveLength(before);
  });
});

describe('openUpstream refusals', () => {
  it('refuses a preview with 409 before any call, and changes no stack', async () => {
    const h = harness();
    await h.port.deploy(release('function', { appRef: PREVIEW_APP, environment: PREVIEW }));
    const calls = h.clients.cloudformation.calls.length;
    const err = await h.port
      .openUpstream(handleOf(PREVIEW_APP, 'function', PREVIEW))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).toMatchObject({ provider: 'aws', status: 409 });
    expect(h.clients.cloudformation.calls).toHaveLength(calls);
    expect(originAccessOf(params(h, `motir-release-${PREVIEW_APP}`))).toBe('motir_edge');
  });

  it('refuses a handle naming another environment with 409', async () => {
    const h = harness();
    const err = await h.port
      .openUpstream(handleOf(APP, 'function', PREVIEW))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect(err).toMatchObject({ status: 409 });
  });

  it('throws ReleaseNotFoundError for a release with no stack, an unpublished one, or no account', async () => {
    const h = harness();
    await expect(h.port.openUpstream(handleOf(APP, 'container'))).rejects.toBeInstanceOf(
      ReleaseNotFoundError,
    );
    await h.port.deploy(release('container'));
    h.clients.cloudformation.stacks.get(STACK)!.parameters['ConfigHash'] = '';
    await expect(h.port.openUpstream(handleOf(APP, 'container'))).rejects.toBeInstanceOf(
      ReleaseNotFoundError,
    );
    h.state.ready = false;
    await expect(h.port.openUpstream(handleOf(APP, 'container'))).rejects.toBeInstanceOf(
      ReleaseNotFoundError,
    );
  });
});

describe('openUpstream on a handing-over account (MOTIR-12131)', () => {
  it('reaches the account through handoverAccountOf while ensureTenantAccount answers not ready', async () => {
    const h = harness();
    await h.port.deploy(release('function'));
    // The takeover has moved the account to `handing_over`: every other caller
    // is told it is not ready, and only the handover reach admits it.
    h.state.ready = false;
    const asked: string[] = [];
    const port = createAwsHostingDeployPort({
      ...h.deps,
      handoverAccountOf: async (organizationId) => {
        asked.push(organizationId);
        return ACCOUNT;
      },
    });
    const opened = await port.openUpstream(handleOf(APP, 'function'));
    expect(asked).toEqual([ORG]);
    expect(opened.upstreamAddress).toBe(
      h.clients.cloudformation.stacks.get(STACK)!.outputs['FrontDoorUrl'],
    );
    expect(params(h)['OriginAccess']).toBe('open');
    // Nothing else reaches it: a deploy-side read still finds no account.
    expect(await port.listReleases({ appRef: APP })).toEqual([]);
  });

  it('falls back to a ready account when no handover holds the organisation', async () => {
    const h = harness();
    await h.port.deploy(release('function'));
    const port = createAwsHostingDeployPort({ ...h.deps, handoverAccountOf: async () => null });
    await expect(port.openUpstream(handleOf(APP, 'function'))).resolves.toMatchObject({
      upstreamAddress: expect.any(String),
    });
    h.state.ready = false;
    await expect(port.openUpstream(handleOf(APP, 'function'))).rejects.toBeInstanceOf(
      ReleaseNotFoundError,
    );
  });
});

describe('the open container path', () => {
  it('takes a free listener priority apart from every rule already on the listener', async () => {
    const h = harness();
    await h.port.deploy(release('container'));
    await h.port.deploy(release('container', { appRef: OTHER_APP }));
    const taken = [...h.clients.elb.rules.values()];
    await h.port.openUpstream(handleOf(APP, 'container'));
    const open = Number(params(h)['OpenListenerRulePriority']);
    expect(open).toBeGreaterThanOrEqual(1);
    expect(taken).not.toContain(open);
    expect(h.clients.elb.openRules.get(APP)).toBe(open);
  });

  it('picks its own app whatever X-Motir-App a viewer sends, and opens no other app', async () => {
    const h = harness();
    await h.port.deploy(release('container'));
    await h.port.deploy(release('container', { appRef: OTHER_APP }));
    const { upstreamAddress } = await h.port.openUpstream(handleOf(APP, 'container'));
    expect(h.clients.edge.request(upstreamAddress, { 'X-Motir-App': OTHER_APP })).toMatchObject({
      status: 200,
      appRef: APP,
    });
    // The other app is still Motir-only, and answers its own secret alone.
    const otherSecret = deriveOriginSecret(KEY, OTHER_APP);
    expect(h.clients.edge.request(SHARED, { 'X-Motir-Origin-Secret': otherSecret })).toMatchObject({
      status: 200,
      appRef: OTHER_APP,
    });
    expect(params(h, `motir-release-${OTHER_APP}`)['OriginAccess']).toBe('motir_edge');
    expect(h.clients.edge.request(SHARED, { 'X-Motir-Origin-Secret': 'wrong' }).status).toBe(403);
    expect(h.clients.edge.request('https://unknown.example').status).toBe(404);
  });

  it('admits no request, secret or none, to a release stack that holds no origin secret', async () => {
    const h = harness();
    await h.port.deploy(release('function'));
    await h.port.deploy(release('container', { appRef: OTHER_APP }));
    for (const stack of [STACK, `motir-release-${OTHER_APP}`]) {
      delete h.clients.cloudformation.stacks.get(stack)!.parameters['OriginSecret'];
    }
    expect(h.clients.edge.request(motirPath(h, 'function')).status).toBe(403);
    expect(h.clients.edge.request(SHARED).status).toBe(403);
  });

  it('carries no value derived from the origin-secret key in its open parameters', async () => {
    const h = harness();
    await h.port.deploy(release('container'));
    await h.port.openUpstream(handleOf(APP, 'container'));
    const { OriginSecret: given, ...rest } = params(h);
    // The secret rule's parameter stays, for Motir's edge.
    expect(given).toBe(SECRET);
    const open = {
      OriginAccess: rest['OriginAccess'],
      OpenListenerRulePriority: rest['OpenListenerRulePriority'],
      FrontDoorVpcOriginId: rest['FrontDoorVpcOriginId'],
      AlbDnsName: rest['AlbDnsName'],
    };
    expect(open).toEqual({
      OriginAccess: 'open',
      OpenListenerRulePriority: expect.stringMatching(/^[1-9][0-9]*$/),
      FrontDoorVpcOriginId: 'vo_fake0frontdoor',
      AlbDnsName: expect.stringContaining('.elb.amazonaws.com'),
    });
    expect(JSON.stringify(open)).not.toContain(SECRET);
  });

  it('sends no open values while a stack is at motir_edge', () => {
    const network = { frontDoorVpcOriginId: 'vo_x', albDnsName: 'internal-x.elb.amazonaws.com' };
    expect(openParameters('motir_edge', '12', network)).toEqual({
      OriginAccess: 'motir_edge',
      OpenListenerRulePriority: '',
      FrontDoorVpcOriginId: '',
      AlbDnsName: '',
    });
    expect(openParameters('open', '12', network)).toEqual({
      OriginAccess: 'open',
      OpenListenerRulePriority: '12',
      FrontDoorVpcOriginId: 'vo_x',
      AlbDnsName: 'internal-x.elb.amazonaws.com',
    });
  });
});

describe('originAccessOf', () => {
  it('is open only when the stack says open', () => {
    expect(originAccessOf({ OriginAccess: 'open' })).toBe('open');
    expect(originAccessOf({ OriginAccess: 'motir_edge' })).toBe('motir_edge');
    expect(originAccessOf({ OriginAccess: 'OPEN' })).toBe('motir_edge');
    expect(originAccessOf({})).toBe('motir_edge');
    expect(originAccessOf(null)).toBe('motir_edge');
    expect(originAccessOf(undefined)).toBe('motir_edge');
  });
});
