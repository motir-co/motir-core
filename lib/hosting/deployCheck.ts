// The OPERATOR DEPLOY CHECK (Story MOTIR-9791 · MOTIR-9805) — the step logic
// behind `pnpm hosting:deploy-check`. It drives the hosting deploy port end to
// end against a real target (deploy, a second release, rollback, status, destroy)
// for one synthetic production environment, and refuses an invalid manifest
// before the port is touched. The decision of record is MOTIR-5769 (page
// cmvrcywwc00jkhpr1zvvnike8, version 1), which names the command, the
// `motir-deploy-check-` app prefix and the test image.
//
// The port and the manifest reader are INJECTED, so the same functions run
// against the fake in Vitest and against Fly from a terminal; the script is only
// argv around `runDeployCheck`. Nothing here names a provider: the target is
// reached through the composition-root accessor alone.
//
// The `probe` step (MOTIR-9947) proves the release's origin guard: it GETs the
// health path once WITH the app's derived `X-Motir-Origin-Secret` and once
// without, prints both status lines — never the secret — and fails unless the
// first is 2xx and the second 403.
//
// State between steps lives on the platform, not in a local file: each step finds
// the check's app by its fixed name and asks the port which release it serves.
//
// `--target serverless` (MOTIR-9975) runs the serverless target's steps instead,
// from `./serverlessDeployCheck`; this module stays the dispatcher and the Fly
// steps, which `--target fly` (the default) runs unchanged.

import { HostingManifestInvalidError, HostingManifestMissingError } from '@/lib/hosting/errors';
import { parseHostingManifest, type HostingManifest } from '@/lib/hosting/manifest';
// A cycle by design: that module uses this one's helpers, and this one only
// calls into it at run time. Neither touches the other's bindings while loading.
import {
  runServerlessDeployCheckStep,
  type ServerlessDeployCheckDeps,
} from '@/lib/hosting/serverlessDeployCheck';
import {
  deriveOriginSecret,
  hostingAppNames,
  HostingAppNameInvalidError,
  ORIGIN_SECRET_HEADER,
  OrchestratorNotConfiguredError,
  type HostingDeployPort,
  type HostingEnvironment,
  type ReleaseArtifact,
  type ReleaseHandle,
} from '@motir/orchestrator';

/** Every app the check creates starts with this; it refuses any other name, so
 *  `destroy` cannot reach a tenant's app (`mh-…`). */
export const DEPLOY_CHECK_APP_PREFIX = 'motir-deploy-check-';
export const DEPLOY_CHECK_DEFAULT_NAME = `${DEPLOY_CHECK_APP_PREFIX}default`;

/** The record's test image: the public `traefik/whoami`, pinned by its
 *  multi-arch index digest (v1.11.0, read from Docker Hub 2026-10-28). It answers
 *  `GET /health` with 200 and `GET /` with the `WHOAMI_NAME` it was started with,
 *  so opening the address names the release. */
export const DEPLOY_CHECK_IMAGE =
  'docker.io/traefik/whoami@sha256:200689790a0a0ea48ca45992e0450bc26ccab5307375b41c84dfc4f2475937ab';

/** The committed fixture manifest the check deploys by default. */
export const DEPLOY_CHECK_DEFAULT_MANIFEST = 'tests/fixtures/hosting/motir.hosting.json';

/** The serverless target's app prefix (MOTIR-9975): inside the scoped role's
 *  `mh-*`, which a `motir-deploy-check-` function name would fall outside. */
export const SERVERLESS_DEPLOY_CHECK_APP_PREFIX = 'mh-deploy-check-';
/** The serverless fixture, and its worker twin that the target refuses. */
export const SERVERLESS_DEPLOY_CHECK_DEFAULT_MANIFEST =
  'tests/fixtures/hosting/serverless/motir.hosting.json';
export const SERVERLESS_DEPLOY_CHECK_WORKER_MANIFEST =
  'tests/fixtures/hosting/serverless-worker/motir.hosting.json';
/** The directory the serverless fixture image is built from. */
export const SERVERLESS_DEPLOY_CHECK_IMAGE_CONTEXT = 'tests/fixtures/hosting/serverless';

export const DEPLOY_CHECK_STEPS = [
  'deploy',
  'release2',
  'rollback',
  'status',
  'probe',
  'destroy',
  'all',
] as const;

/** The steps only the serverless target has (MOTIR-9975). */
export const SERVERLESS_ONLY_DEPLOY_CHECK_STEPS = ['database', 'image', 'refuse'] as const;
export type DeployCheckStep =
  | (typeof DEPLOY_CHECK_STEPS)[number]
  | (typeof SERVERLESS_ONLY_DEPLOY_CHECK_STEPS)[number];

/** The targets the check drives. */
export const DEPLOY_CHECK_TARGETS = ['fly', 'serverless'] as const;
export type DeployCheckTarget = (typeof DEPLOY_CHECK_TARGETS)[number];

/** The synthetic environment: production-shaped, so it exercises the production
 *  path's sizing and naming without a pull request. */
const ENVIRONMENT: HostingEnvironment = { kind: 'production' };

/** A `--name` the check will not touch. */
export class DeployCheckNameRefusedError extends Error {
  readonly code = 'DEPLOY_CHECK_NAME_REFUSED' as const;
  constructor(readonly appName: string) {
    super(
      `Refused app name ${appName}: the deploy check only touches apps named ` +
        `${DEPLOY_CHECK_APP_PREFIX}<name>.`,
    );
    this.name = 'DeployCheckNameRefusedError';
  }
}

/** The probe did not see a guarded release: no 2xx with the secret, or
 *  anything but 403 without it. */
export class DeployCheckProbeFailedError extends Error {
  readonly code = 'DEPLOY_CHECK_PROBE_FAILED' as const;
  constructor(detail: string) {
    super(`The origin guard probe failed: ${detail}.`);
    this.name = 'DeployCheckProbeFailedError';
  }
}

/** The command line did not say what to do. */
export class DeployCheckUsageError extends Error {
  readonly code = 'DEPLOY_CHECK_USAGE' as const;
  constructor(detail: string) {
    super(`${detail}\n${DEPLOY_CHECK_USAGE}`);
    this.name = 'DeployCheckUsageError';
  }
}

export const DEPLOY_CHECK_USAGE = [
  'Usage: pnpm hosting:deploy-check <step> [--target fly|serverless] [--manifest <path>] [--name <app>] [--image <ref>]',
  `  steps: ${DEPLOY_CHECK_STEPS.join(', ')}`,
  `  serverless-only steps: ${SERVERLESS_ONLY_DEPLOY_CHECK_STEPS.join(', ')}`,
  '  --target    fly (default) or serverless',
  `  --manifest  defaults to ${DEPLOY_CHECK_DEFAULT_MANIFEST} (fly) or ${SERVERLESS_DEPLOY_CHECK_DEFAULT_MANIFEST} (serverless)`,
  `  --name      defaults to ${DEPLOY_CHECK_DEFAULT_NAME}; must start with ${DEPLOY_CHECK_APP_PREFIX}`,
  `  --image     fly only; defaults to ${DEPLOY_CHECK_IMAGE}`,
].join('\n');

export interface DeployCheckOptions {
  readonly manifestPath: string;
  readonly appName: string;
  readonly image: string;
  /** Absent means `fly`. */
  readonly target?: DeployCheckTarget;
}

export interface DeployCheckDeps {
  /** The port, built with `DEPLOY_CHECK_APP_PREFIX` as its app prefix. Called only
   *  once a step is past its refusals, so a refused run builds no port. */
  readonly port: () => HostingDeployPort;
  /** The manifest file's text, or null when the path does not exist. */
  readonly readManifest: (path: string) => string | null;
  /** One labelled block of output. */
  readonly print: (label: string, fields: Record<string, unknown>) => void;
  /** The HTTP client `probe` calls the release with. */
  readonly fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  /** The key app origin secrets are derived from; read only by `probe`, and only
   *  for a release whose origin credential is the secret. */
  readonly originSecretKey: () => string;
  /** What only the serverless target needs; absent, `--target serverless` is
   *  refused as not configured. */
  readonly serverless?: ServerlessDeployCheckDeps;
}

/** A stand-in for a guarded release over HTTP, for runs against the fake port,
 *  whose addresses resolve nowhere: 200 when the request carries the secret the
 *  app's guard would hold, 403 otherwise — the guard's contract
 *  (`packages/hosting-guard`). */
export function fakeGuardedFetch(key: string): DeployCheckDeps['fetch'] {
  return async (url, init) => {
    const appRef = new URL(url).hostname.split('.')[0]!;
    const given = init.headers[ORIGIN_SECRET_HEADER];
    return given === deriveOriginSecret(key, appRef)
      ? new Response('ok', { status: 200, statusText: 'OK' })
      : new Response(null, { status: 403, statusText: 'Forbidden' });
  };
}

/** The check's app, from `--name`, refused unless it carries the prefix and is a
 *  valid app name. Pure: no port call. */
export function deployCheckApp(appName: string): { repositoryId: string; appRef: string } {
  const repositoryId = appName.startsWith(DEPLOY_CHECK_APP_PREFIX)
    ? appName.slice(DEPLOY_CHECK_APP_PREFIX.length)
    : '';
  if (!repositoryId) throw new DeployCheckNameRefusedError(appName);
  try {
    const { appRef } = hostingAppNames(DEPLOY_CHECK_APP_PREFIX, repositoryId, ENVIRONMENT);
    return { repositoryId, appRef };
  } catch (err) {
    if (err instanceof HostingAppNameInvalidError) throw new DeployCheckNameRefusedError(appName);
    throw err;
  }
}

/** `ref@digest` → a pinned image artifact; a bare ref stays unpinned. */
export function imageArtifact(image: string): ReleaseArtifact {
  const at = image.indexOf('@');
  if (at < 0) return { kind: 'image', ref: image };
  return { kind: 'image', ref: image.slice(0, at), digest: image.slice(at + 1) };
}

export function readManifest(
  deps: Pick<DeployCheckDeps, 'readManifest'>,
  path: string,
): HostingManifest {
  return parseHostingManifest(deps.readManifest(path));
}

/** The release the check's app serves now, or null when it has none. */
export async function servingHandle(
  port: HostingDeployPort,
  appRef: string,
): Promise<ReleaseHandle | null> {
  const [first] = await port.listReleases({ appRef });
  return first?.handle ?? null;
}

async function deployRelease(
  deps: DeployCheckDeps,
  options: DeployCheckOptions,
  release: 1 | 2,
): Promise<void> {
  // Parse FIRST: a refused manifest makes no port call at all.
  const manifest = readManifest(deps, options.manifestPath);
  const { repositoryId, appRef } = deployCheckApp(options.appName);
  const port = deps.port();
  if (release === 1) await port.ensureApp({ repositoryId, environment: ENVIRONMENT });
  const handle = await port.deploy({
    appRef,
    environment: ENVIRONMENT,
    artifact: imageArtifact(options.image),
    runtime: manifest,
    env: [
      { name: 'MOTIR_DEPLOY_CHECK_RELEASE', value: String(release), secret: false },
      { name: 'WHOAMI_NAME', value: `${appRef} release ${release}`, secret: false },
      { name: 'WHOAMI_PORT_NUMBER', value: String(manifest.port), secret: false },
    ],
    size: 'small',
    idle: { mode: 'suspend', idleSeconds: 300 },
  });
  const description = await port.describe(handle);
  deps.print(release === 1 ? 'deploy' : 'release2', {
    app: appRef,
    release: release,
    releaseId: handle.releaseId,
    state: description.state,
    address: description.upstreamAddress,
  });
}

async function rollback(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = deployCheckApp(options.appName);
  await rollbackApp(deps, deps.port(), appRef);
}

/** Roll the app back and print which release serves; shared by both targets. */
export async function rollbackApp(
  deps: Pick<DeployCheckDeps, 'print'>,
  port: HostingDeployPort,
  appRef: string,
): Promise<void> {
  const handle = await port.rollback({ appRef, environment: ENVIRONMENT });
  const description = await port.describe(handle);
  deps.print('rollback', {
    app: appRef,
    servingReleaseId: description.releaseId,
    previousReleaseId: description.previousReleaseId,
    address: description.upstreamAddress,
  });
}

async function status(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = deployCheckApp(options.appName);
  await statusOf(deps, deps.port(), appRef);
}

/** Print which release the app serves, from the port; shared by both targets. */
export async function statusOf(
  deps: Pick<DeployCheckDeps, 'print'>,
  port: HostingDeployPort,
  appRef: string,
): Promise<void> {
  const handle = await servingHandle(port, appRef);
  if (!handle) {
    deps.print('status', { app: appRef, state: 'none', servingReleaseId: null });
    return;
  }
  const description = await port.describe(handle);
  deps.print('status', {
    app: appRef,
    state: description.state,
    servingReleaseId: description.releaseId,
    previousReleaseId: description.previousReleaseId,
    address: description.upstreamAddress,
  });
}

export const statusLine = (res: Response): string => `${res.status} ${res.statusText}`.trim();

async function probe(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const manifest = readManifest(deps, options.manifestPath);
  const { appRef } = deployCheckApp(options.appName);
  const port = deps.port();
  const handle = await servingHandle(port, appRef);
  const description = handle ? await port.describe(handle) : null;
  if (!description?.upstreamAddress) {
    deps.print('probe', { app: appRef, state: description?.state ?? 'none' });
    throw new DeployCheckProbeFailedError(`${appRef} serves no release`);
  }
  const url = new URL(manifest.healthCheck.path, description.upstreamAddress).toString();
  const guarded = description.originCredential === 'origin_secret';
  const secret = guarded ? deriveOriginSecret(deps.originSecretKey(), appRef) : null;
  const withSecret = await deps.fetch(url, {
    headers: secret ? { [ORIGIN_SECRET_HEADER]: secret } : {},
  });
  const withoutSecret = await deps.fetch(url, { headers: {} });
  deps.print('probe', {
    app: appRef,
    url,
    originCredential: description.originCredential,
    withSecret: statusLine(withSecret),
    withoutSecret: statusLine(withoutSecret),
  });
  if (!guarded) {
    throw new DeployCheckProbeFailedError(
      `the release's origin credential is ${description.originCredential}, not the origin secret`,
    );
  }
  if (!withSecret.ok) {
    throw new DeployCheckProbeFailedError(`with the secret it answered ${withSecret.status}`);
  }
  if (withoutSecret.status !== 403) {
    throw new DeployCheckProbeFailedError(`without the secret it answered ${withoutSecret.status}`);
  }
}

async function destroy(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = deployCheckApp(options.appName);
  const port = deps.port();
  const handle = await servingHandle(port, appRef);
  const usage = handle ? await port.destroy(handle, 'operator') : null;
  deps.print('destroy', {
    app: appRef,
    usage: usage ? JSON.stringify(usage) : 'none (no release)',
  });
  // Usage of anything still live when the app goes; empty after the destroy above.
  const remaining = await port.destroyApp({ appRef });
  const listing = await port.listReleases({ appRef });
  deps.print('destroyApp', {
    app: appRef,
    usage: JSON.stringify(remaining),
    releases: JSON.stringify(listing),
  });
}

/** Run one step (or `all` of them in order). Throws the typed error a step
 *  refuses with; `runDeployCheck` turns it into output and an exit code. */
export async function runDeployCheckStep(
  step: DeployCheckStep,
  deps: DeployCheckDeps,
  options: DeployCheckOptions,
): Promise<void> {
  if (options.target === 'serverless') {
    if (!deps.serverless) {
      throw new OrchestratorNotConfiguredError('the serverless deploy check has no dependencies');
    }
    return runServerlessDeployCheckStep(step, { ...deps, serverless: deps.serverless }, options);
  }
  switch (step) {
    case 'deploy':
      return deployRelease(deps, options, 1);
    case 'release2':
      return deployRelease(deps, options, 2);
    case 'rollback':
      return rollback(deps, options);
    case 'status':
      return status(deps, options);
    case 'probe':
      return probe(deps, options);
    case 'destroy':
      return destroy(deps, options);
    case 'all':
      // Refuse an invalid manifest or name before the first port call, not
      // halfway through the sequence.
      readManifest(deps, options.manifestPath);
      deployCheckApp(options.appName);
      await deployRelease(deps, options, 1);
      await deployRelease(deps, options, 2);
      await rollback(deps, options);
      await status(deps, options);
      await probe(deps, options);
      return destroy(deps, options);
    case 'database':
    case 'image':
    case 'refuse':
      throw new DeployCheckUsageError(`The ${step} step needs --target serverless.`);
  }
}

/** argv (after the script name) → the step and its options. */
export function parseDeployCheckArgs(argv: readonly string[]): {
  step: DeployCheckStep;
  options: DeployCheckOptions;
} {
  let step: DeployCheckStep | undefined;
  const flags: Record<'manifest' | 'name' | 'image' | 'target', string | undefined> = {
    manifest: undefined,
    name: undefined,
    image: undefined,
    target: undefined,
  };
  const steps: readonly string[] = [...DEPLOY_CHECK_STEPS, ...SERVERLESS_ONLY_DEPLOY_CHECK_STEPS];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const flag = /^--(manifest|name|image|target)(?:=(.*))?$/.exec(arg);
    if (flag) {
      const key = flag[1] as keyof typeof flags;
      const value = flag[2] ?? argv[(i += 1)];
      if (!value) throw new DeployCheckUsageError(`--${key} needs a value.`);
      flags[key] = value;
    } else if (!step && steps.includes(arg)) {
      step = arg as DeployCheckStep;
    } else {
      throw new DeployCheckUsageError(`Unknown argument: ${arg}`);
    }
  }
  if (!step) throw new DeployCheckUsageError('Name a step.');
  const target = flags.target ?? 'fly';
  if (!(DEPLOY_CHECK_TARGETS as readonly string[]).includes(target)) {
    throw new DeployCheckUsageError(`Unknown target: ${target}`);
  }
  if (
    target === 'fly' &&
    (SERVERLESS_ONLY_DEPLOY_CHECK_STEPS as readonly string[]).includes(step)
  ) {
    throw new DeployCheckUsageError(`The ${step} step needs --target serverless.`);
  }
  const serverless = target === 'serverless';
  return {
    step,
    options: {
      manifestPath:
        flags.manifest ??
        (serverless ? SERVERLESS_DEPLOY_CHECK_DEFAULT_MANIFEST : DEPLOY_CHECK_DEFAULT_MANIFEST),
      appName: flags.name ?? DEPLOY_CHECK_DEFAULT_NAME,
      image: flags.image ?? DEPLOY_CHECK_IMAGE,
      ...(serverless ? { target: 'serverless' as const } : {}),
    },
  };
}

/** The whole command: parse argv, run the step, print a refusal as one block.
 *  Returns the process exit code (0 on success, 1 on any refusal or failure). */
export async function runDeployCheck(
  argv: readonly string[],
  deps: DeployCheckDeps,
): Promise<number> {
  let manifestPath: string | undefined;
  try {
    const { step, options } = parseDeployCheckArgs(argv);
    manifestPath = options.manifestPath;
    await runDeployCheckStep(step, deps, options);
    return 0;
  } catch (err) {
    deps.print('refused', refusalFields(err, manifestPath));
    return 1;
  }
}

function refusalFields(err: unknown, manifestPath: string | undefined): Record<string, unknown> {
  if (err instanceof HostingManifestMissingError) {
    return { error: err.code, manifest: manifestPath, reason: 'no such file' };
  }
  if (err instanceof HostingManifestInvalidError) {
    return {
      error: err.code,
      manifest: manifestPath,
      field: err.field ?? '(document)',
      reason: err.reason,
      issues: err.issues.length,
    };
  }
  // A refused name, a bad command line, the accessor's not-configured error, or
  // a port failure: its code (when it has one) and its message.
  const error = err instanceof Error ? err : new Error(String(err));
  const code = (error as { code?: unknown }).code;
  return { error: typeof code === 'string' ? code : error.name, message: error.message };
}
