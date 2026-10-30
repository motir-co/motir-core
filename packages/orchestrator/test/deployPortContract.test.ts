import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustomerRepositoryRefusedError,
  IdlePolicyUnsupportedError,
  NoPreviousReleaseError,
  OrchestratorApiError,
  ReleaseCommandUnsupportedError,
  ReleaseShapeRequiredError,
  type DeployReleaseInput,
  type HostingEnvironment,
  type ReleaseShape,
  type ReleaseUsage,
} from '../src/index';
import {
  ADAPTERS,
  CUSTOMER,
  IMAGE,
  R,
  SUSPEND,
  fakeAwsHarness,
  type HostingHarness,
} from './contract/hostingHarnesses';

// THE HOSTING DEPLOY PORT'S CONTRACT (Story MOTIR-9791 · MOTIR-9806) — one case
// list, run unchanged against every adapter. The preview and production stories
// test against the fake; this suite is what lets them trust it, because every
// assertion below holds for the Fly adapter too (driven through an in-memory
// Machines API, no network). A new adapter (serverless, AWS) joins by adding ONE
// entry to `ADAPTERS`: a port, a clock it advances, a provider failure it can
// inject, and a read of what the provider was told to run.
//
// An AWS adapter joins once per SHAPE (MOTIR-10002): the harness names the shape
// it deploys, the idle policy that shape accepts (a container is always on) and
// the origin credential its releases answer with. `AWS_ADAPTERS` adds the cases
// only a target with shapes has — the refusals, the account wait, compute usage.
//
// The REAL AWS adapter (MOTIR-10012) joins as `aws function` and `aws container`:
// `createAwsHostingDeployPort` over the fake tenant account
// (`contract/awsHostingHarness.ts`), its motir-core lookups answered there. The
// case list holds for it unchanged; what differs per entry is only what the
// harness says — where a release answers, with which credential, and the image
// reference its provider pulls (AWS pulls the tenant registry's copy).
//
// The serverless adapter (MOTIR-9972) joins as `serverless`, over an in-memory
// Lambda account; it runs only an image in its own registry, so its harness
// names the image a release deploys. The harnesses live in
// `./contract/hostingHarnesses.ts`, shared with the serverless story gate.

/** Adapters with shapes, and how a test holds their tenant account back. */
interface AwsHarness extends HostingHarness {
  readonly shape: ReleaseShape;
  setAccountReady(ready: boolean): void;
}

const AWS_ADAPTERS: ReadonlyArray<readonly [string, () => AwsHarness]> = (
  ['function', 'container'] as const
).map((shape) => [
  `fake-aws-${shape}`,
  () => {
    const h = fakeAwsHarness(shape);
    return { ...h, shape, setAccountReady: (ready: boolean) => h.fake.setAccountReady(ready) };
  },
]);

const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 7 };
function release(
  h: Pick<HostingHarness, 'shape' | 'idle' | 'image'>,
  appRef: string,
  environment: HostingEnvironment,
  marker: string,
): DeployReleaseInput {
  return {
    appRef,
    environment,
    artifact: { kind: 'image', ...(h.image ?? IMAGE) },
    runtime: {
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      database: { kind: 'none' },
      // HTTP only: the serverless target refuses a release that does not say so.
      requires: { websockets: false, backgroundWork: false },
    },
    env: [{ name: 'WHOAMI_NAME', value: marker, secret: false }],
    idle: h.idle,
    ...(h.shape ? { shape: h.shape } : {}),
  };
}

/** A usage record, with a duration that is never negative. */
function expectUsage(usage: ReleaseUsage, appRef: string, releaseId: string): void {
  expect(usage).toMatchObject({ appRef, releaseId });
  expect(usage.until.getTime()).toBeGreaterThanOrEqual(usage.since.getTime());
  expect(usage.runningSeconds).toBeGreaterThanOrEqual(0);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(ADAPTERS)('the hosting deploy port contract — %s', (_name, make) => {
  let h: HostingHarness;
  let prod: string;

  beforeEach(async () => {
    h = make();
    prod = (await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION })).appRef;
  });

  it('deploys release A, gives an address, and describes A running with the manifest’s runtime', async () => {
    const a = await h.port.deploy(release(h, prod, PRODUCTION, 'A'));
    expect(a).toMatchObject({ appRef: prod, environment: PRODUCTION });
    const description = await h.port.describe(a);
    expect(description).toMatchObject({
      state: 'healthy',
      releaseId: a.releaseId,
      previousReleaseId: null,
      // Every release is reached only through its target and shape's credential:
      // Fly's guard and an AWS container's listener rule take the origin secret,
      // an AWS function URL a SigV4 signature.
      originCredential: h.originCredential,
    });
    expect(description.upstreamAddress).toMatch(h.upstream(prod));
    expect(h.runtimeOf(prod)).toEqual({
      image: h.runsImage,
      port: 8080,
      healthCheckPath: '/health',
    });
  });

  it('keeps a preview and production side by side; destroying the preview leaves production', async () => {
    const pr = await h.port.ensureApp({ repositoryId: R, environment: PREVIEW });
    expect(pr.appRef).toBe(`${prod}-pr7`);
    // One preview namespace for every pull request of the repository, and
    // never production's (MOTIR-5769 §4).
    const productionApp = await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION });
    const other = await h.port.ensureApp({
      repositoryId: R,
      environment: { kind: 'preview', pullRequest: 8 },
    });
    expect(pr.pushNamespace).not.toBe(productionApp.pushNamespace);
    expect(other.pushNamespace).toBe(pr.pushNamespace);
    const preview = await h.port.deploy(release(h, pr.appRef, PREVIEW, 'P'));
    const production = await h.port.deploy(release(h, prod, PRODUCTION, 'A'));

    const listed = [
      ...(await h.port.listReleases({ appRef: pr.appRef })),
      ...(await h.port.listReleases({ appRef: prod })),
    ];
    expect(listed.map((s) => [s.handle.appRef, s.handle.environment])).toEqual([
      [pr.appRef, PREVIEW],
      [prod, PRODUCTION],
    ]);

    expectUsage(await h.port.destroy(preview, 'pull_request_closed'), pr.appRef, preview.releaseId);
    expect(await h.port.destroyApp({ appRef: pr.appRef })).toEqual([]);
    expect(await h.port.listReleases({ appRef: pr.appRef })).toEqual([]);
    expect(await h.port.describe(production)).toMatchObject({
      state: 'healthy',
      releaseId: production.releaseId,
    });
  });

  it('rolls back to A after B, and refuses a second rollback with nothing earlier', async () => {
    const a = await h.port.deploy(release(h, prod, PRODUCTION, 'A'));
    const b = await h.port.deploy(release(h, prod, PRODUCTION, 'B'));
    expect(await h.port.describe(b)).toMatchObject({
      releaseId: b.releaseId,
      previousReleaseId: a.releaseId,
    });

    const back = await h.port.rollback({ appRef: prod, environment: PRODUCTION });
    expect(back.releaseId).toBe(a.releaseId);
    expect(await h.port.describe(back)).toMatchObject({
      state: 'healthy',
      releaseId: a.releaseId,
      previousReleaseId: b.releaseId,
    });

    // A rollback SWAPS the live and kept releases, so after one there is always
    // an earlier release; what has none is an app with only its first deploy.
    const other = (await h.port.ensureApp({ repositoryId: 'cmrepo2', environment: PRODUCTION }))
      .appRef;
    await h.port.deploy(release(h, other, PRODUCTION, 'only'));
    await expect(
      h.port.rollback({ appRef: other, environment: PRODUCTION }),
    ).rejects.toBeInstanceOf(NoPreviousReleaseError);
  });

  it('destroy returns usage for a running release and for an already-destroyed one', async () => {
    const a = await h.port.deploy(release(h, prod, PRODUCTION, 'A'));
    h.advanceSeconds(120);
    const usage = await h.port.destroy(a, 'retired');
    expectUsage(usage, prod, a.releaseId);
    expect(usage.runningSeconds).toBe(120);
    expect((await h.port.describe(a)).state).toBe('destroyed');

    const again = await h.port.destroy(a, 'retired');
    expectUsage(again, prod, a.releaseId);
    expect(again.runningSeconds).toBe(0);
  });

  it('a destroy the provider refuses throws the typed error and destroys nothing; the retry returns usage', async () => {
    const a = await h.port.deploy(release(h, prod, PRODUCTION, 'A'));
    h.advanceSeconds(30);
    h.failNextDestroy(prod, 'destroy');
    await expect(h.port.destroy(a, 'retired')).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(await h.port.describe(a)).toMatchObject({ state: 'healthy', releaseId: a.releaseId });

    const usage = await h.port.destroy(a, 'retired');
    expectUsage(usage, prod, a.releaseId);
    expect(usage.runningSeconds).toBe(30);
  });

  it('destroy app after two releases returns the usage of the one still running, and leaves list empty', async () => {
    await h.port.deploy(release(h, prod, PRODUCTION, 'A'));
    h.advanceSeconds(10);
    const b = await h.port.deploy(release(h, prod, PRODUCTION, 'B'));
    h.advanceSeconds(20);

    h.failNextDestroy(prod, 'destroyApp');
    await expect(h.port.destroyApp({ appRef: prod })).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(await h.port.listReleases({ appRef: prod })).toHaveLength(1);

    const usage = await h.port.destroyApp({ appRef: prod });
    expect(usage).toHaveLength(1);
    expectUsage(usage[0]!, prod, b.releaseId);
    expect(usage[0]!.runningSeconds).toBe(30);
    expect(await h.port.listReleases({ appRef: prod })).toEqual([]);
    expect(await h.port.destroyApp({ appRef: prod })).toEqual([]);
  });

  it('ensures a push namespace alone — the one every preview of the repository pushes to — idempotently (MOTIR-5775)', async () => {
    const first = await h.port.ensurePushNamespace({ repositoryId: R, kind: 'preview' });
    expect(await h.port.ensurePushNamespace({ repositoryId: R, kind: 'preview' })).toEqual(first);
    const { pushNamespace } = await h.port.ensureApp({ repositoryId: R, environment: PREVIEW });
    expect(first.pushNamespace).toBe(pushNamespace);
    expect(first.imageRepository.endsWith(`/${pushNamespace}`)).toBe(true);
    const production = await h.port.ensurePushNamespace({ repositoryId: R, kind: 'production' });
    expect(production.pushNamespace).not.toBe(first.pushNamespace);
    expect(production.pushNamespace).toBe(
      (await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION })).pushNamespace,
    );
  });

  it('revokes every static push credential of a namespace; a second revoke revokes nothing (MOTIR-5775)', async () => {
    const { pushNamespace } = await h.port.ensurePushNamespace({
      repositoryId: R,
      kind: 'preview',
    });
    const credential = await h.port.mintDeployCredential({ pushNamespace });
    const first = await h.port.revokeDeployCredentials({ pushNamespace });
    expect(first.revoked).toBe(credential.kind === 'secret' ? 1 : 0);
    expect(await h.port.revokeDeployCredentials({ pushNamespace })).toEqual({ revoked: 0 });
  });
});

describe.each(ADAPTERS)(
  'the hosting deploy port contract, release commands — %s',
  (_name, make) => {
    let h: HostingHarness;
    beforeEach(() => {
      h = make();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('runs a release command to its end and reports only its exit status, leaving the live release serving', async () => {
      const app = await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION });
      const a = await h.port.deploy(release(h, app.appRef, PRODUCTION, 'A'));
      const command = {
        appRef: app.appRef,
        artifact: { kind: 'image' as const, ...(h.image ?? IMAGE) },
        command: 'node migrate.js deploy',
        env: [{ name: 'DATABASE_URL', value: 'postgresql://u:p@db/app', secret: true }],
        timeoutSeconds: 600,
      };
      if (!h.commandExits) {
        await expect(h.port.runReleaseCommand(command)).rejects.toBeInstanceOf(
          ReleaseCommandUnsupportedError,
        );
        return;
      }
      expect(await h.port.runReleaseCommand(command)).toEqual({ exitCode: 0, timedOut: false });
      h.commandExits(3);
      expect(await h.port.runReleaseCommand(command)).toEqual({ exitCode: 3, timedOut: false });
      expect(await h.port.describe(a)).toMatchObject({ state: 'healthy', releaseId: a.releaseId });
      expect(await h.port.listReleases({ appRef: app.appRef })).toHaveLength(1);
    });
  },
);

describe.each(AWS_ADAPTERS)('the hosting deploy port contract, AWS shapes — %s', (_name, make) => {
  let h: AwsHarness;
  let prod: string;

  beforeEach(async () => {
    h = make();
    prod = (await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION })).appRef;
  });

  it('refuses a release with no shape by name, creating nothing', async () => {
    const { shape: _shape, ...unshaped } = release(h, prod, PRODUCTION, 'A');
    const refusal = h.port.deploy(unshaped);
    await expect(refusal).rejects.toBeInstanceOf(ReleaseShapeRequiredError);
    await expect(refusal).rejects.toThrow(/"function" or "container"/);
    expect(await h.port.listReleases({ appRef: prod })).toEqual([]);
  });

  it('refuses a customer repository by name', async () => {
    await expect(
      h.port.ensureApp({ repositoryId: CUSTOMER, environment: PRODUCTION }),
    ).rejects.toBeInstanceOf(CustomerRepositoryRefusedError);
    await expect(
      h.port.ensurePushNamespace({ repositoryId: CUSTOMER, kind: 'preview' }),
    ).rejects.toBeInstanceOf(CustomerRepositoryRefusedError);
  });

  it('holds a deploy in waiting_for_account, and the repeat completes the SAME release', async () => {
    h.setAccountReady(false);
    const held = await h.port.deploy(release(h, prod, PRODUCTION, 'A'));
    expect(await h.port.describe(held)).toMatchObject({
      state: 'waiting_for_account',
      releaseId: held.releaseId,
      upstreamAddress: null,
    });
    expect(await h.port.listReleases({ appRef: prod })).toEqual([
      { handle: held, state: 'waiting_for_account' },
    ]);
    expect(h.runtimeOf(prod)).toBeNull();

    h.setAccountReady(true);
    const done = await h.port.deploy(release(h, prod, PRODUCTION, 'A'));
    expect(done.releaseId).toBe(held.releaseId);
    expect(await h.port.describe(done)).toMatchObject({
      state: 'healthy',
      releaseId: held.releaseId,
      originCredential: h.originCredential,
    });
  });

  it('destroying a held release reports zero usage and releases the hold', async () => {
    h.setAccountReady(false);
    const held = await h.port.deploy(release(h, prod, PRODUCTION, 'A'));
    const usage = await h.port.destroy(held, 'retired');
    expectUsage(usage, prod, held.releaseId);
    expect(usage.runningSeconds).toBe(0);
    expect(await h.port.listReleases({ appRef: prod })).toEqual([]);
  });

  it('usage carries the compute units of the shape and size the release ran at', async () => {
    const a = await h.port.deploy({ ...release(h, prod, PRODUCTION, 'A'), size: 'medium' });
    h.advanceSeconds(1024);
    const usage = await h.port.destroy(a, 'retired');
    expect(usage.runningSeconds).toBe(1024);
    expect(usage.compute).toEqual(
      h.shape === 'function'
        ? { unit: 'lambda', gbSeconds: 1769 }
        : { unit: 'fargate', vcpuSeconds: 512, gbSeconds: 1024 },
    );
  });

  it('a preview container runs at the preview size whatever its input says', async () => {
    const pr = await h.port.ensureApp({ repositoryId: R, environment: PREVIEW });
    const p = await h.port.deploy({ ...release(h, pr.appRef, PREVIEW, 'P'), size: 'large' });
    h.advanceSeconds(100);
    const usage = await h.port.destroy(p, 'pull_request_closed');
    expect(usage.compute).toEqual(
      h.shape === 'function'
        ? { unit: 'lambda', gbSeconds: (100 * 1769) / 1024 }
        : { unit: 'fargate', vcpuSeconds: 25, gbSeconds: 50 },
    );
  });

  it('a container refuses the suspend idle policy by name', async () => {
    const suspend = { ...release(h, prod, PRODUCTION, 'A'), idle: SUSPEND };
    if (h.shape === 'container') {
      await expect(h.port.deploy(suspend)).rejects.toBeInstanceOf(IdlePolicyUnsupportedError);
      expect(await h.port.listReleases({ appRef: prod })).toEqual([]);
    } else {
      await expect(h.port.deploy(suspend)).resolves.toMatchObject({ appRef: prod });
    }
  });
});
