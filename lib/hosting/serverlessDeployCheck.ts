// The OPERATOR DEPLOY CHECK on the SERVERLESS target (Story MOTIR-9793 ·
// MOTIR-9975) — the steps `pnpm hosting:deploy-check --target serverless` runs:
// create the application's database, build and push the fixture image, deploy it
// with the database's pairs, probe it signed and unsigned, deploy a second
// release, roll back, refuse the worker fixture, and destroy everything while
// printing the release's and the database's usage.
//
// `./deployCheck` parses the command line and dispatches here; the Fly steps stay
// there, and `rollback` and `status` are its shared helpers. Every provider is
// INJECTED — the deploy port, the database port, the signed fetch and the image
// builder — so the same functions run against the fakes in Vitest and against
// Lambda and Neon from a terminal. Nothing here imports a provider type.
//
// State lives on the platform: each step finds the app by its fixed name and the
// database by its application reference, and re-reads the pairs from the
// database port when it needs them. Only pair NAMES are ever printed.

import { createHash } from 'node:crypto';
import type { HostingManifest } from '@/lib/hosting/manifest';
import {
  hostingAppNames,
  ReleaseRuntimeRefusedError,
  type DatabaseHandle,
  type DatabasePort,
  type FakeHostingControls,
  type HostingDeployPort,
  type HostingEnvironment,
} from '@motir/orchestrator';
import {
  DeployCheckProbeFailedError,
  DeployCheckUsageError,
  deployCheckApp,
  readManifest,
  rollbackApp,
  SERVERLESS_DEPLOY_CHECK_APP_PREFIX,
  SERVERLESS_DEPLOY_CHECK_WORKER_MANIFEST,
  servingHandle,
  statusLine,
  statusOf,
  type DeployCheckDeps,
  type DeployCheckOptions,
  type DeployCheckStep,
} from '@/lib/hosting/deployCheck';

export {
  SERVERLESS_DEPLOY_CHECK_APP_PREFIX,
  SERVERLESS_DEPLOY_CHECK_DEFAULT_MANIFEST,
  SERVERLESS_DEPLOY_CHECK_IMAGE_CONTEXT,
  SERVERLESS_DEPLOY_CHECK_WORKER_MANIFEST,
} from '@/lib/hosting/deployCheck';

/** The digest the `refuse` step's placeholder artifact carries. The refusal
 *  fires before any provider call, so nothing ever pulls it. */
export const SERVERLESS_DEPLOY_CHECK_PLACEHOLDER_DIGEST = `sha256:${'0'.repeat(64)}`;

/** An image the builder pushed, pinned by digest. */
export interface PushedImage {
  readonly ref: string;
  readonly digest: string;
}

/** What only the serverless target needs. */
export interface ServerlessDeployCheckDeps {
  /** The serverless port, built with `SERVERLESS_DEPLOY_CHECK_APP_PREFIX`. */
  readonly port: () => HostingDeployPort;
  readonly databasePort: () => DatabasePort;
  /** `fetch` with the request signed for the release's function URL. */
  readonly signedFetch: DeployCheckDeps['fetch'];
  /** Build the fixture image with `label` baked in and push it to the app's
   *  repository; the one place the operator's Docker is used. */
  readonly buildAndPushImage: (input: {
    pushNamespace: string;
    label: string;
  }) => Promise<PushedImage>;
  /** The serverless account's image registry host. */
  readonly registry: () => string;
}

type Deps = Pick<DeployCheckDeps, 'readManifest' | 'print' | 'fetch'> & {
  readonly serverless: ServerlessDeployCheckDeps;
};

/** The registry host a run against the fakes uses: no account is read. */
export const FAKE_SERVERLESS_REGISTRY = '000000000000.dkr.ecr.us-east-1.amazonaws.com';

/** For runs against the fake ports: an image "pushed" to the app's repository,
 *  its digest a hash of the repository and label, so two labels are two
 *  digests. */
export function fakeImageBuilder(registry: string): ServerlessDeployCheckDeps['buildAndPushImage'] {
  return async ({ pushNamespace, label }) => ({
    ref: `${registry}/${pushNamespace}`,
    digest: `sha256:${createHash('sha256').update(`${pushNamespace}:${label}`).digest('hex')}`,
  });
}

/** For runs against the fake ports, whose addresses resolve nowhere: a
 *  stand-in for a release's function URL, as a signed and an unsigned client.
 *  Signed, it answers as the fixture answers — 200 with the live release's
 *  label and `database: reachable` while the app's database exists, 503
 *  otherwise; unsigned, it is refused with 403, as `AuthType AWS_IAM` refuses. */
export function fakeFunctionUrlFetch(
  hosting: Pick<FakeHostingControls, 'app'>,
  databases: () => DatabasePort,
): { signed: DeployCheckDeps['fetch']; unsigned: DeployCheckDeps['fetch'] } {
  const answer = (status: number, statusText: string, body: object | null) =>
    new Response(body ? JSON.stringify(body) : null, { status, statusText });
  return {
    signed: async (url) => {
      const appRef = new URL(url).hostname.split('.')[0]!;
      const release = hosting.app(appRef)?.live?.env.MOTIR_DEPLOY_CHECK_RELEASE;
      const reachable = (await findDatabase(databases(), appRef)) !== null;
      return release && reachable
        ? answer(200, 'OK', { release, database: 'reachable' })
        : answer(503, 'Service Unavailable', { database: 'unreachable' });
    },
    unsigned: async () => answer(403, 'Forbidden', null),
  };
}

/** A step saw the platform in a state it does not accept. */
export class ServerlessDeployCheckFailedError extends Error {
  readonly code = 'DEPLOY_CHECK_FAILED' as const;
  constructor(detail: string) {
    super(`The serverless deploy check failed: ${detail}.`);
    this.name = 'ServerlessDeployCheckFailedError';
  }
}

const ENVIRONMENT: HostingEnvironment = { kind: 'production' };

/** Release `n`'s label, baked into its image, so its probe names it. */
export const releaseLabel = (release: 1 | 2): string => `release-${release}`;

/** The check's serverless app: `--name` refused exactly as for Fly, then named
 *  under the serverless prefix. The app ref is also the database's
 *  application reference. */
export function serverlessCheckApp(appName: string): { repositoryId: string; appRef: string } {
  const { repositoryId } = deployCheckApp(appName);
  const { appRef } = hostingAppNames(SERVERLESS_DEPLOY_CHECK_APP_PREFIX, repositoryId, ENVIRONMENT);
  return { repositoryId, appRef };
}

async function findDatabase(port: DatabasePort, appRef: string): Promise<DatabaseHandle | null> {
  const held = await port.list();
  return held.find((d) => d.handle.applicationRef === appRef)?.handle ?? null;
}

const pairNames = (env: readonly { name: string }[]): string => env.map((v) => v.name).join(', ');

async function database(deps: Deps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = serverlessCheckApp(options.appName);
  const port = deps.serverless.databasePort();
  const existing = await findDatabase(port, appRef);
  const { handle, env } = existing
    ? { handle: existing, env: await port.connectionEnv(existing) }
    : await port.createDatabase({ applicationRef: appRef });
  deps.print('database', {
    app: appRef,
    provider: handle.provider,
    databaseRef: handle.databaseRef,
    created: !existing,
    pairs: pairNames(env),
  });
}

async function image(
  deps: Deps,
  options: DeployCheckOptions,
  release: 1 | 2,
): Promise<PushedImage> {
  const { repositoryId, appRef } = serverlessCheckApp(options.appName);
  const { pushNamespace } = await deps.serverless
    .port()
    .ensureApp({ repositoryId, environment: ENVIRONMENT });
  const label = releaseLabel(release);
  const pushed = await deps.serverless.buildAndPushImage({ pushNamespace, label });
  deps.print('image', { app: appRef, label, repository: pushNamespace, digest: pushed.digest });
  return pushed;
}

async function deployRelease(
  deps: Deps,
  options: DeployCheckOptions,
  release: 1 | 2,
): Promise<void> {
  // Parse FIRST: a refused manifest makes no port call at all.
  const manifest = readManifest(deps, options.manifestPath);
  const { appRef } = serverlessCheckApp(options.appName);
  const databasePort = deps.serverless.databasePort();
  const handle = await findDatabase(databasePort, appRef);
  if (!handle) {
    throw new ServerlessDeployCheckFailedError(`${appRef} has no database: run the database step`);
  }
  const pushed = await image(deps, options, release);
  const env = await databasePort.connectionEnv(handle);
  const port = deps.serverless.port();
  const deployed = await port.deploy({
    appRef,
    environment: ENVIRONMENT,
    artifact: { kind: 'image', ref: pushed.ref, digest: pushed.digest },
    runtime: manifest,
    env: [
      ...env,
      { name: 'MOTIR_DEPLOY_CHECK_RELEASE', value: releaseLabel(release), secret: false },
    ],
    size: 'small',
    idle: { mode: 'suspend', idleSeconds: 300 },
  });
  const description = await port.describe(deployed);
  deps.print(release === 1 ? 'deploy' : 'release2', {
    app: appRef,
    release: releaseLabel(release),
    releaseId: deployed.releaseId,
    state: description.state,
    address: description.upstreamAddress,
    env: pairNames(env),
  });
}

/** GET the health path signed and unsigned. Fails unless the signed call is 200
 *  with `database: reachable` from the release `expected` names (any release
 *  when absent) and the unsigned one is refused. Returns the address probed. */
async function probe(deps: Deps, options: DeployCheckOptions, expected?: 1 | 2): Promise<string> {
  const manifest = readManifest(deps, options.manifestPath);
  const { appRef } = serverlessCheckApp(options.appName);
  const port = deps.serverless.port();
  const handle = await servingHandle(port, appRef);
  const description = handle ? await port.describe(handle) : null;
  if (!description?.upstreamAddress) {
    deps.print('probe', { app: appRef, state: description?.state ?? 'none' });
    throw new DeployCheckProbeFailedError(`${appRef} serves no release`);
  }
  const url = new URL(manifest.healthCheck.path, description.upstreamAddress).toString();
  const signed = await deps.serverless.signedFetch(url, { headers: {} });
  const unsigned = await deps.fetch(url, { headers: {} });
  const body = signed.status === 200 ? await healthBody(signed) : null;
  deps.print('probe', {
    app: appRef,
    url,
    originCredential: description.originCredential,
    signed: statusLine(signed),
    unsigned: statusLine(unsigned),
    release: body?.release ?? null,
    database: body?.database ?? null,
  });
  if (signed.status !== 200) {
    throw new DeployCheckProbeFailedError(`signed, it answered ${signed.status}`);
  }
  if (body?.database !== 'reachable') {
    throw new DeployCheckProbeFailedError(`the release reports its database ${body?.database}`);
  }
  if (expected && body.release !== releaseLabel(expected)) {
    throw new DeployCheckProbeFailedError(
      `${body.release} answered where ${releaseLabel(expected)} was expected`,
    );
  }
  if (unsigned.status !== 403) {
    throw new DeployCheckProbeFailedError(`unsigned, it answered ${unsigned.status}`);
  }
  return url;
}

/** Only the two fields the fixture promises; anything else is never read. */
async function healthBody(res: Response): Promise<{ release?: string; database?: string } | null> {
  try {
    const body = (await res.json()) as { release?: unknown; database?: unknown } | null;
    return {
      ...(typeof body?.release === 'string' ? { release: body.release } : {}),
      ...(typeof body?.database === 'string' ? { database: body.database } : {}),
    };
  } catch {
    return null;
  }
}

async function refuse(deps: Deps, options: DeployCheckOptions): Promise<void> {
  const worker: HostingManifest = readManifest(deps, SERVERLESS_DEPLOY_CHECK_WORKER_MANIFEST);
  const { repositoryId, appRef } = serverlessCheckApp(options.appName);
  const port = deps.serverless.port();
  // The repository the adapter names for the app; any one in the account's own
  // registry passes the artifact check, which is all the placeholder must do.
  const repository = `${SERVERLESS_DEPLOY_CHECK_APP_PREFIX.slice(0, -1)}/${repositoryId}/production`;
  let refusal: unknown = null;
  try {
    await port.deploy({
      appRef,
      environment: ENVIRONMENT,
      artifact: {
        kind: 'image',
        ref: `${deps.serverless.registry()}/${repository}`,
        digest: SERVERLESS_DEPLOY_CHECK_PLACEHOLDER_DIGEST,
      },
      runtime: worker,
      env: [],
      size: 'small',
      idle: { mode: 'suspend', idleSeconds: 300 },
    });
  } catch (err) {
    refusal = err;
  }
  const releases = await port.listReleases({ appRef });
  const databases = await findDatabase(deps.serverless.databasePort(), appRef);
  const error = refusal instanceof Error ? refusal : null;
  const field = refusal instanceof ReleaseRuntimeRefusedError ? refusal.field : null;
  deps.print('refuse', {
    app: appRef,
    manifest: SERVERLESS_DEPLOY_CHECK_WORKER_MANIFEST,
    error: error ? ((error as { code?: string }).code ?? error.name) : 'none (deployed)',
    field,
    message: error?.message ?? null,
    releases: releases.length,
    databases: databases ? 1 : 0,
  });
  if (field !== 'requires.backgroundWork' || !/\bfly\b/.test(error?.message ?? '')) {
    throw new ServerlessDeployCheckFailedError(
      'the worker fixture was not refused by requires.backgroundWork naming the fly target',
    );
  }
  if (releases.length > 0 || databases) {
    throw new ServerlessDeployCheckFailedError(`${appRef} already holds a release or a database`);
  }
}

async function destroy(deps: Deps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = serverlessCheckApp(options.appName);
  const port = deps.serverless.port();
  const databasePort = deps.serverless.databasePort();
  // The release's usage is read by `destroy` itself, before anything goes.
  const handle = await servingHandle(port, appRef);
  const usage = handle
    ? await port.destroy(handle, 'operator')
    : { appRef, runningSeconds: 0, invocations: 0 };
  deps.print('destroy', { app: appRef, usage: JSON.stringify(usage) });
  const remaining = await port.destroyApp({ appRef });
  deps.print('destroyApp', { app: appRef, usage: JSON.stringify(remaining) });
  const database = await findDatabase(databasePort, appRef);
  const databaseUsage = database
    ? await databasePort.deleteDatabase(database)
    : { applicationRef: appRef, computeSeconds: 0, storageBytes: 0 };
  deps.print('deleteDatabase', { app: appRef, usage: JSON.stringify(databaseUsage) });
  const releases = await port.listReleases({ appRef });
  const left = await findDatabase(databasePort, appRef);
  deps.print('destroyed', { app: appRef, releases: releases.length, databases: left ? 1 : 0 });
  if (releases.length > 0 || left) {
    throw new ServerlessDeployCheckFailedError(`${appRef} still holds a release or a database`);
  }
}

async function all(deps: Deps, options: DeployCheckOptions): Promise<void> {
  // Refuse the worker and validate both manifests before anything is created.
  await refuse(deps, options);
  readManifest(deps, options.manifestPath);
  await database(deps, options);
  await deployRelease(deps, options, 1);
  const address = await probe(deps, options, 1);
  await deployRelease(deps, options, 2);
  await probe(deps, options, 2);
  const { appRef } = serverlessCheckApp(options.appName);
  await rollbackApp(deps, deps.serverless.port(), appRef);
  const restored = await probe(deps, options, 1);
  if (restored !== address) {
    throw new DeployCheckProbeFailedError(`after the rollback it answered at ${restored}`);
  }
  await statusOf(deps, deps.serverless.port(), appRef);
  await destroy(deps, options);
}

/** Run one serverless step (or `all` of them in order). */
export async function runServerlessDeployCheckStep(
  step: DeployCheckStep,
  deps: Deps,
  options: DeployCheckOptions,
): Promise<void> {
  switch (step) {
    case 'database':
      return database(deps, options);
    case 'image':
      await image(deps, options, 1);
      return;
    case 'deploy':
      return deployRelease(deps, options, 1);
    case 'release2':
      return deployRelease(deps, options, 2);
    case 'rollback':
      return rollbackApp(deps, deps.serverless.port(), serverlessCheckApp(options.appName).appRef);
    case 'status':
      return statusOf(deps, deps.serverless.port(), serverlessCheckApp(options.appName).appRef);
    case 'probe':
      await probe(deps, options);
      return;
    case 'refuse':
      return refuse(deps, options);
    case 'destroy':
      return destroy(deps, options);
    case 'all':
      return all(deps, options);
    case 'converge':
    case 'push':
    case 'page':
    case 'no-shape':
      throw new DeployCheckUsageError(`${step} runs with --target aws only.`);
  }
}
