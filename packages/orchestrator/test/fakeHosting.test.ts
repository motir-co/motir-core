import { describe, expect, it } from 'vitest';
import {
  HostingAppNameInvalidError,
  NoPreviousReleaseError,
  OrchestratorApiError,
  ReleaseNotFoundError,
  createFakeHostingDeployPort,
  hostingAppNames,
  runningSecondsBetween,
  sameEnvironment,
  type DeployReleaseInput,
  type HostingEnvironment,
} from '../src/index';

// The FAKE hosting deploy port (MOTIR-5773): the state machine the preview and
// production stories test against — one live release per environment, replace
// in place keeping the previous, rollback, idle stop, usage, destroy.

const RID = 'cmrepo1';
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 7 };
const PRODUCTION: HostingEnvironment = { kind: 'production' };

function input(appRef: string, environment: HostingEnvironment, label = 'r'): DeployReleaseInput {
  return {
    appRef,
    environment,
    artifact: { kind: 'image', ref: 'img', digest: 'sha256:1' },
    runtime: {
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      database: { kind: 'none' },
    },
    env: [{ name: 'WHOAMI_NAME', value: label, secret: false }],
    idle: { mode: 'suspend', idleSeconds: 60 },
  };
}

describe('the fake hosting deploy port', () => {
  it('one set of operations serves a preview and production as separate units', async () => {
    const port = createFakeHostingDeployPort();
    const preview = await port.ensureApp({ repositoryId: RID, environment: PREVIEW });
    const production = await port.ensureApp({ repositoryId: RID, environment: PRODUCTION });
    expect(preview).toEqual({ appRef: 'mh-cmrepo1-pr7', pushNamespace: 'mh-cmrepo1-pv' });
    expect(production).toEqual({ appRef: 'mh-cmrepo1', pushNamespace: 'mh-cmrepo1' });
    const p = await port.deploy(input(preview.appRef, PREVIEW));
    const q = await port.deploy(input(production.appRef, PRODUCTION));
    expect((await port.describe(p)).releaseId).toBe(p.releaseId);
    expect((await port.describe(q)).releaseId).toBe(q.releaseId);
    expect(p.releaseId).not.toBe(q.releaseId);
    expect(await port.ensureApp({ repositoryId: RID, environment: PREVIEW })).toEqual(preview);
  });

  it('refuses a deploy to an app that does not exist or belongs to another environment', async () => {
    const port = createFakeHostingDeployPort();
    await expect(port.deploy(input('mh-nope', PRODUCTION))).rejects.toBeInstanceOf(
      OrchestratorApiError,
    );
    const { appRef } = await port.ensureApp({ repositoryId: RID, environment: PRODUCTION });
    await expect(port.deploy(input(appRef, PREVIEW))).rejects.toThrow(/another environment/);
  });

  it('a second deploy replaces the live release and keeps the first as previous', async () => {
    const port = createFakeHostingDeployPort();
    const { appRef } = await port.ensureApp({ repositoryId: RID, environment: PRODUCTION });
    const first = await port.deploy(input(appRef, PRODUCTION, 'one'));
    const second = await port.deploy(input(appRef, PRODUCTION, 'two'));
    expect(await port.describe(second)).toEqual({
      state: 'healthy',
      releaseId: second.releaseId,
      previousReleaseId: first.releaseId,
      upstreamAddress: `https://${appRef}.fake.invalid`,
      // As the Fly adapter: a `fly` release is behind the origin-secret guard.
      originCredential: 'origin_secret',
    });
    expect(await port.listReleases({ appRef })).toEqual([{ handle: second, state: 'healthy' }]);
    expect(port.app(appRef)?.live?.image).toBe('img@sha256:1');
  });

  it('rollback makes the first release live, and is refused when there is none', async () => {
    const port = createFakeHostingDeployPort();
    const { appRef } = await port.ensureApp({ repositoryId: RID, environment: PRODUCTION });
    await expect(port.rollback({ appRef, environment: PRODUCTION })).rejects.toBeInstanceOf(
      ReleaseNotFoundError,
    );
    const first = await port.deploy(input(appRef, PRODUCTION, 'one'));
    await expect(port.rollback({ appRef, environment: PRODUCTION })).rejects.toBeInstanceOf(
      NoPreviousReleaseError,
    );
    const second = await port.deploy(input(appRef, PRODUCTION, 'two'));
    const back = await port.rollback({ appRef, environment: PRODUCTION });
    expect(back.releaseId).toBe(first.releaseId);
    expect(await port.describe(back)).toMatchObject({
      releaseId: first.releaseId,
      previousReleaseId: second.releaseId,
    });
    expect(port.app(appRef)?.live?.env).toEqual({ WHOAMI_NAME: 'one' });
  });

  it('reports health, idle stop and wake', async () => {
    const port = createFakeHostingDeployPort();
    const { appRef } = await port.ensureApp({ repositoryId: RID, environment: PRODUCTION });
    const handle = await port.deploy(input(appRef, PRODUCTION));
    port.setHealth(appRef, 'unhealthy');
    expect((await port.describe(handle)).state).toBe('unhealthy');
    port.idleStop(appRef);
    expect((await port.describe(handle)).state).toBe('stopped');
    expect(await port.listReleases({ appRef })).toEqual([{ handle, state: 'stopped' }]);
    port.wake(appRef);
    port.wake(appRef);
    expect((await port.describe(handle)).state).toBe('unhealthy');
  });

  it('usageSince excludes stopped time; destroy returns the whole life’s usage', async () => {
    const port = createFakeHostingDeployPort({ start: new Date('2026-10-28T00:00:00Z') });
    const { appRef } = await port.ensureApp({ repositoryId: RID, environment: PRODUCTION });
    const handle = await port.deploy(input(appRef, PRODUCTION));
    const since = port.now();
    port.advanceSeconds(60);
    port.idleStop(appRef);
    port.advanceSeconds(600);
    port.wake(appRef);
    port.advanceSeconds(30);
    expect((await port.usageSince(handle, since)).runningSeconds).toBe(90);
    const usage = await port.destroy(handle, 'operator');
    expect(usage).toMatchObject({
      target: 'fly',
      appRef,
      releaseId: handle.releaseId,
      runningSeconds: 90,
    });
    expect(usage.since).toEqual(since);
    expect((await port.describe(handle)).state).toBe('destroyed');
    expect(await port.listReleases({ appRef })).toEqual([]);
    expect((await port.destroy(handle, 'operator')).runningSeconds).toBe(0);
    await port.destroyApp({ appRef });
    expect(port.app(appRef)).toBeUndefined();
    await expect(port.usageSince(handle, since)).rejects.toBeInstanceOf(OrchestratorApiError);
  });

  it('mints a secret credential per push namespace and takes a target', async () => {
    const port = createFakeHostingDeployPort({ target: 'aws', appPrefix: 'x-' });
    expect(port.target).toBe('aws');
    const credential = await port.mintDeployCredential({ pushNamespace: 'x-r-pv' });
    expect(credential).toMatchObject({ kind: 'secret', pushNamespace: 'x-r-pv' });
    expect(port.mintedFor).toEqual(['x-r-pv']);
    expect((await port.ensureApp({ repositoryId: 'r', environment: PRODUCTION })).appRef).toBe(
      'x-r',
    );
    // An AWS release answers with its shape's credential and host.
    const fn = await port.deploy({ ...input('x-r', PRODUCTION), shape: 'function' });
    expect(await port.describe(fn)).toMatchObject({
      originCredential: 'aws_sigv4',
      upstreamAddress: 'https://x-r.lambda-url.fake.invalid',
    });
    const box = await port.deploy({
      ...input('x-r', PRODUCTION),
      shape: 'container',
      idle: { mode: 'always_on' },
    });
    expect(await port.describe(box)).toMatchObject({
      originCredential: 'origin_secret',
      upstreamAddress: 'https://x-r.alb.fake.invalid',
    });
  });

  it('a target with no shapes answers its own credential at the named host', async () => {
    const port = createFakeHostingDeployPort({ target: 'serverless', appPrefix: 'x-' });
    const { appRef } = await port.ensureApp({ repositoryId: 'r', environment: PRODUCTION });
    const http = input(appRef, PRODUCTION);
    const handle = await port.deploy({
      ...http,
      runtime: { ...http.runtime, requires: { websockets: false, backgroundWork: false } },
    });
    expect(await port.describe(handle)).toMatchObject({
      originCredential: 'aws_sigv4',
      upstreamAddress: 'https://x-r.fake.invalid',
    });
    expect((await port.destroy(handle, 'operator')).compute).toBeUndefined();
  });
});

describe('the fake serverless port (MOTIR-9975)', () => {
  it('refuses by the manifest field before looking for the app, as the adapter does', async () => {
    const port = createFakeHostingDeployPort({ target: 'serverless', appPrefix: 'x-' });
    const worker = input('x-r', PRODUCTION);
    const refused = {
      ...worker,
      runtime: { ...worker.runtime, requires: { websockets: false, backgroundWork: true } },
    };
    await expect(port.deploy(refused)).rejects.toMatchObject({
      code: 'HOSTING_RUNTIME_REFUSED',
      field: 'requires.backgroundWork',
    });
    await expect(port.deploy(worker)).rejects.toMatchObject({ field: 'requires' });
    expect(port.app('x-r')).toBeUndefined();
  });

  it('serves an HTTP release behind the SigV4 origin credential', async () => {
    const port = createFakeHostingDeployPort({ target: 'serverless', appPrefix: 'x-' });
    await port.ensureApp({ repositoryId: 'r', environment: PRODUCTION });
    const http = input('x-r', PRODUCTION);
    const handle = await port.deploy({
      ...http,
      runtime: { ...http.runtime, requires: { websockets: false, backgroundWork: false } },
    });
    expect((await port.describe(handle)).originCredential).toBe('aws_sigv4');
  });
});

describe('hostingAppNames', () => {
  it('refuses a name that is not a DNS label, or a pull request that is not a number', () => {
    expect(() => hostingAppNames('mh-', 'Bad_Id', PRODUCTION)).toThrow(HostingAppNameInvalidError);
    expect(() => hostingAppNames('mh-', 'a'.repeat(70), PRODUCTION)).toThrow(
      HostingAppNameInvalidError,
    );
    expect(() => hostingAppNames('mh-', 'r-', PRODUCTION)).toThrow(HostingAppNameInvalidError);
    expect(() => hostingAppNames('mh-', 'r', { kind: 'preview', pullRequest: 0 })).toThrow(
      HostingAppNameInvalidError,
    );
    expect(() => hostingAppNames('mh-', 'r', { kind: 'preview', pullRequest: 1.5 })).toThrow(
      HostingAppNameInvalidError,
    );
    expect(hostingAppNames('motir-deploy-check-', 'default', PRODUCTION).appRef).toBe(
      'motir-deploy-check-default',
    );
  });

  it('sameEnvironment compares kind and pull request', () => {
    expect(sameEnvironment(PRODUCTION, { kind: 'production' })).toBe(true);
    expect(sameEnvironment(PRODUCTION, PREVIEW)).toBe(false);
    expect(sameEnvironment(PREVIEW, { kind: 'preview', pullRequest: 7 })).toBe(true);
    expect(sameEnvironment(PREVIEW, { kind: 'preview', pullRequest: 8 })).toBe(false);
  });
});

describe('runningSecondsBetween', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 28) + s * 1000);

  it('sums running intervals clipped to the window', () => {
    const transitions = [
      { at: t(0), running: true },
      { at: t(100), running: false },
      { at: t(200), running: true },
      { at: t(400), running: false },
    ];
    expect(runningSecondsBetween(transitions, t(50), t(300))).toBe(150);
    expect(runningSecondsBetween(transitions, t(0), t(1000))).toBe(300);
    expect(runningSecondsBetween(transitions, t(500), t(400))).toBe(0);
  });

  it('infers the state before a history that starts inside the window', () => {
    expect(runningSecondsBetween([{ at: t(10), running: false }], t(0), t(20))).toBe(10);
    expect(runningSecondsBetween([{ at: t(10), running: true }], t(0), t(20))).toBe(10);
    expect(runningSecondsBetween([], t(0), t(20))).toBe(0);
  });
});

describe('the fake push namespace and its credentials (MOTIR-5775)', () => {
  it('records each namespace once and counts live credentials until a revoke', async () => {
    const fake = createFakeHostingDeployPort({ refuseRepositories: ['cmcustomer'] });
    const made = await fake.ensurePushNamespace({ repositoryId: RID, kind: 'preview' });
    await fake.ensurePushNamespace({ repositoryId: RID, kind: 'preview' });
    expect(made).toEqual({
      pushNamespace: 'mh-cmrepo1-pv',
      imageRepository: 'registry.fake.invalid/mh-cmrepo1-pv',
    });
    expect(fake.pushNamespaces()).toEqual(['mh-cmrepo1-pv']);
    await fake.mintDeployCredential({ pushNamespace: made.pushNamespace });
    await fake.mintDeployCredential({ pushNamespace: made.pushNamespace });
    expect(fake.liveCredentials(made.pushNamespace)).toBe(2);
    expect(await fake.revokeDeployCredentials(made)).toEqual({ revoked: 2 });
    expect(fake.liveCredentials(made.pushNamespace)).toBe(0);
    await expect(
      fake.ensurePushNamespace({ repositoryId: 'cmcustomer', kind: 'preview' }),
    ).rejects.toMatchObject({ code: 'HOSTING_CUSTOMER_REPOSITORY_REFUSED' });
  });

  it('destroying the namespace app removes the namespace and its credentials (MOTIR-5776)', async () => {
    const fake = createFakeHostingDeployPort();
    const made = await fake.ensurePushNamespace({ repositoryId: RID, kind: 'preview' });
    await fake.mintDeployCredential({ pushNamespace: made.pushNamespace });
    expect(await fake.destroyApp({ appRef: made.pushNamespace })).toEqual([]);
    expect(fake.pushNamespaces()).toEqual([]);
    expect(fake.liveCredentials(made.pushNamespace)).toBe(0);
  });

  it('fails each operation once on request, changing nothing', async () => {
    const fake = createFakeHostingDeployPort();
    fake.failNext('ensurePushNamespace');
    await expect(
      fake.ensurePushNamespace({ repositoryId: RID, kind: 'preview' }),
    ).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(fake.pushNamespaces()).toEqual([]);
    await fake.mintDeployCredential({ pushNamespace: 'mh-cmrepo1-pv' });
    fake.failNext('revokeDeployCredentials');
    await expect(
      fake.revokeDeployCredentials({ pushNamespace: 'mh-cmrepo1-pv' }),
    ).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(fake.liveCredentials('mh-cmrepo1-pv')).toBe(1);
  });
});
