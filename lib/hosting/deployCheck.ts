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
// `--target aws` (MOTIR-10011) drives the AWS adapter on a staging tenant
// account: the app is the tenant app `mh-<repositoryId>` of a `--repository`
// made for the check, each release is the fixture app
// (`tests/fixtures/hosting/aws-fixture-app`) pushed by `push` under the
// operator's own AWS profile, `page` reads its `/health` and its database row
// with the release's origin credential, and `no-shape` proves the adapter
// refuses a release with no shape before creating anything. The command runner,
// the convergence and the SigV4 fetch are injected like the port, so Vitest runs
// all of it against the fake with no Docker, AWS or network. `--target fly` (the
// default) is the check as it was.
//
// With `--workspace`, `--repository` and `--environment` on the Fly target (Story
// MOTIR-9795 · MOTIR-9965) the deploying steps take their environment from the
// entries an administrator stored for that repository and environment, through
// the injected `resolveEnvironment`, and default to the env-reporting fixture app;
// the `report` step prints what that app says it received. Only entry NAMES and
// their secret flag are printed — never a value.

import { TENANT_ACCOUNT_REGION } from '@/lib/ciFleet/hostingTenantAccounts';
import {
  ENVIRONMENTS,
  isEnvironmentName,
  type EnvironmentName,
} from '@/lib/environmentConfig/vocabulary';
import { HostingManifestInvalidError, HostingManifestMissingError } from '@/lib/hosting/errors';
import { parseHostingManifest, type HostingManifest } from '@/lib/hosting/manifest';
import {
  AWS_APP_PREFIX,
  deriveOriginSecret,
  hostingAppNames,
  HostingAppNameInvalidError,
  ORIGIN_SECRET_HEADER,
  registryPushNamespace,
  type HostingDeployPort,
  type HostingEnvironment,
  type ReleaseArtifact,
  type ReleaseDescription,
  type ReleaseEnvVar,
  type ReleaseHandle,
  type ReleaseShape,
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

/** The env-reporting fixture app (MOTIR-9965), deployed by default when the check
 *  resolves a stored environment. It runs on the public Node image below through
 *  the manifest's start command — an inline `node -e` program, the same server as
 *  `tests/fixtures/hosting/envReporter/server.mjs` — so no image is published.
 *  `GET /` answers `GREETING=<value>` and `API_KEY: present|absent`: the secret's
 *  presence, never its value. */
export const DEPLOY_CHECK_ENV_REPORT_MANIFEST =
  'tests/fixtures/hosting/motir.hosting.env-report.json';

/** `node:22-alpine`, pinned by its multi-arch index digest (read from Docker Hub
 *  2026-10-28, tag last pushed 2026-10-22). */
export const DEPLOY_CHECK_ENV_REPORT_IMAGE =
  'docker.io/library/node@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914';

/** The AWS check's fixture manifest, the default under `--target aws`. */
export const DEPLOY_CHECK_AWS_MANIFEST = 'tests/fixtures/hosting/motir.hosting.aws.json';

/** The fixture app `push` builds, one image per release. */
export const DEPLOY_CHECK_AWS_FIXTURE_DIR = 'tests/fixtures/hosting/aws-fixture-app';

/** The tenant account's region: where `push` logs in to the registry. */
export const DEPLOY_CHECK_AWS_REGION = TENANT_ACCOUNT_REGION;

export const DEPLOY_CHECK_TARGETS = ['fly', 'aws'] as const;
export type DeployCheckTarget = (typeof DEPLOY_CHECK_TARGETS)[number];

export const DEPLOY_CHECK_STEPS = [
  'deploy',
  'release2',
  'rollback',
  'status',
  'probe',
  'report',
  'destroy',
  'all',
  'converge',
  'push',
  'page',
  'no-shape',
] as const;
export type DeployCheckStep = (typeof DEPLOY_CHECK_STEPS)[number];

/** The steps only the AWS target has. */
const AWS_ONLY_STEPS: readonly DeployCheckStep[] = ['converge', 'push', 'page', 'no-shape'];

/** `page` tries a cold release this many times, this far apart, before it
 *  fails: a function's first invocation and a scale-from-zero database both
 *  answer 5xx while they wake. */
export const DEPLOY_CHECK_PAGE_ATTEMPTS = 6;
export const DEPLOY_CHECK_PAGE_RETRY_MS = 5_000;

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

/** The `report` step did not get a 2xx answer from a serving release. */
export class DeployCheckReportFailedError extends Error {
  readonly code = 'DEPLOY_CHECK_REPORT_FAILED' as const;
  constructor(detail: string) {
    super(`The report failed: ${detail}.`);
    this.name = 'DeployCheckReportFailedError';
  }
}

/** `page` did not read the release: no 2xx health, or no row. */
export class DeployCheckPageFailedError extends Error {
  readonly code = 'DEPLOY_CHECK_PAGE_FAILED' as const;
  constructor(detail: string) {
    super(`The page read failed: ${detail}.`);
    this.name = 'DeployCheckPageFailedError';
  }
}

/** `no-shape` saw the port accept a release with no shape. */
export class DeployCheckShapeNotRefusedError extends Error {
  readonly code = 'DEPLOY_CHECK_SHAPE_NOT_REFUSED' as const;
  constructor(appRef: string) {
    super(`The port accepted a release of ${appRef} with no shape; it must refuse it.`);
    this.name = 'DeployCheckShapeNotRefusedError';
  }
}

/** The deploy-role convergence did not leave the account on today's policy. */
export class DeployCheckConvergeFailedError extends Error {
  readonly code = 'DEPLOY_CHECK_CONVERGE_FAILED' as const;
  constructor(organizationId: string, outcome: string) {
    super(`The deploy role of ${organizationId} did not converge: ${outcome}.`);
    this.name = 'DeployCheckConvergeFailedError';
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
  'Usage: pnpm hosting:deploy-check <step> [--manifest <path>] [--name <app>] [--image <ref>]',
  '       pnpm hosting:deploy-check <step> --target aws --repository <id> [--shape <function|container>]',
  '                                 [--organization <id>] [--aws-profile <profile>] [--image <ref>]',
  '       pnpm hosting:deploy-check <step> --workspace <workspaceId> --repository <projectRepositoryId> --environment <env>',
  `  steps: ${DEPLOY_CHECK_STEPS.join(', ')}`,
  `  ${AWS_ONLY_STEPS.join(', ')}: --target aws only`,
  '  report      GETs / on the serving release and prints what the app answers',
  `  --target    ${DEPLOY_CHECK_TARGETS.join(' or ')}; defaults to fly`,
  `  --manifest  defaults to ${DEPLOY_CHECK_DEFAULT_MANIFEST} (aws: ${DEPLOY_CHECK_AWS_MANIFEST})`,
  `  --name      defaults to ${DEPLOY_CHECK_DEFAULT_NAME}; must start with ${DEPLOY_CHECK_APP_PREFIX} (fly only)`,
  `  --image     defaults to ${DEPLOY_CHECK_IMAGE} (aws: the pushed release-1 / release-2 tag)`,
  '  --repository    aws: the Motir repository the check app is mh-<id> of (required)',
  '  --shape         aws: function or container; absent, the port refuses the deploy',
  '  --organization  aws: the organisation converge brings onto the deploy policy',
  '  --aws-profile   aws: the operator profile push logs Docker in to the registry with',
  '  --workspace     fly, with --repository and --environment (all three or none): deploy with',
  '  --environment   the environment stored for that repository, read from the database; the',
  `                  manifest and image then default to the env-reporting fixture. env: ${ENVIRONMENTS.join(', ')}`,
].join('\n');

/** What `--target aws` adds. */
export interface DeployCheckAwsOptions {
  readonly repositoryId: string;
  /** Absent: the check sends none, and the port refuses by name. */
  readonly shape: ReleaseShape | null;
  readonly organizationId: string | null;
  readonly awsProfile: string | null;
  /** `--image`; absent, each release deploys its pushed tag. */
  readonly image: string | null;
}

/** Which stored environment the deploying steps resolve (all three flags given). */
export interface DeployCheckStoredEnvironment {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly environment: EnvironmentName;
}

export interface DeployCheckOptions {
  readonly manifestPath: string;
  readonly appName: string;
  readonly image: string;
  /** Set when the target is `aws`; absent is the Fly check. */
  readonly aws?: DeployCheckAwsOptions;
  /** Fly only. Absent: the check's own fixed environment, as before MOTIR-9965. */
  readonly stored?: DeployCheckStoredEnvironment;
}

/** One command run, with what it printed. */
export interface DeployCheckExecResult {
  readonly stdout: string;
}

export interface DeployCheckDeps {
  /** The target's port — Fly's built with `DEPLOY_CHECK_APP_PREFIX` as its app
   *  prefix, AWS's with its own `mh-`. Called only once a step is past its
   *  refusals, so a refused run builds no port. */
  readonly port: (target: DeployCheckTarget) => HostingDeployPort;
  /** The manifest file's text, or null when the path does not exist. */
  readonly readManifest: (path: string) => string | null;
  /** One labelled block of output. */
  readonly print: (label: string, fields: Record<string, unknown>) => void;
  /** The HTTP client `probe` calls the release with. */
  readonly fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  /** The key app origin secrets are derived from; read only by `probe`, and only
   *  for a release whose origin credential is the secret. */
  readonly originSecretKey: () => string;
  /** Runs one command (`aws`, `docker`) and answers its stdout; `stdin` is
   *  piped in and is never an argument. Used by `push` alone. */
  readonly exec?: (
    command: string,
    args: readonly string[],
    options?: { stdin?: string },
  ) => Promise<DeployCheckExecResult>;
  /** Brings the organisation's tenant deploy role onto today's policy and
   *  answers the outcome's name (`changed`, `unchanged`, `not_ready`, `failed`). */
  readonly converge?: (organizationId: string) => Promise<string>;
  /** A SigV4-signed GET (service `lambda`), for a release whose origin
   *  credential is `aws_sigv4`. */
  readonly signedFetch?: (url: string) => Promise<Response>;
  /** Waits between `page` attempts; absent is a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** A repository's stored environment in the deploy port's shape
   *  (`lib/environmentConfig/resolveEnvironment.ts`); called only with `stored`. */
  readonly resolveEnvironment?: (
    repositoryId: string,
    environment: EnvironmentName,
    options: { workspaceId: string },
  ) => Promise<readonly ReleaseEnvVar[]>;
}

/** The injected dependency a step needs, or a refusal naming it. */
function wired<K extends 'exec' | 'converge' | 'signedFetch' | 'resolveEnvironment'>(
  deps: DeployCheckDeps,
  key: K,
): NonNullable<DeployCheckDeps[K]> {
  const dep = deps[key];
  if (!dep) throw new Error(`The deploy check was started without its ${key}.`);
  return dep as NonNullable<DeployCheckDeps[K]>;
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

/** The AWS check's app: the tenant app of the given repository. */
export function deployCheckAwsApp(repositoryId: string): { repositoryId: string; appRef: string } {
  const { appRef } = hostingAppNames(AWS_APP_PREFIX, repositoryId, ENVIRONMENT);
  return { repositoryId, appRef };
}

/** The check's app for its target. Pure: no port call. */
function checkApp(options: DeployCheckOptions): { repositoryId: string; appRef: string } {
  return options.aws
    ? deployCheckAwsApp(options.aws.repositoryId)
    : deployCheckApp(options.appName);
}

const portOf = (deps: DeployCheckDeps, options: DeployCheckOptions): HostingDeployPort =>
  deps.port(options.aws ? 'aws' : 'fly');

/** Where `push` puts release `n`, and what `deploy` takes by default: the tag
 *  in the app's push namespace. The adapter resolves its own registry. */
export function awsReleaseImage(repositoryId: string, release: 1 | 2): string {
  return `${registryPushNamespace(repositoryId, 'production')}:release-${release}`;
}

function readManifest(deps: DeployCheckDeps, path: string): HostingManifest {
  return parseHostingManifest(deps.readManifest(path));
}

/** The release the check's app serves now, or null when it has none. */
async function servingHandle(
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
  if (options.aws) return deployAwsRelease(deps, options, options.aws, release);
  // Parse FIRST: a refused manifest makes no port call at all.
  const manifest = readManifest(deps, options.manifestPath);
  const { repositoryId, appRef } = deployCheckApp(options.appName);
  // Resolve before the port too: a refused repository deploys nothing.
  const env = await releaseEnvironment(deps, options, appRef, manifest, release);
  const port = deps.port('fly');
  if (release === 1) await port.ensureApp({ repositoryId, environment: ENVIRONMENT });
  const handle = await port.deploy({
    appRef,
    environment: ENVIRONMENT,
    artifact: imageArtifact(options.image),
    runtime: manifest,
    env,
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

/** The release's environment: the stored entries plus the check's release marker
 *  when `stored` is given (the resolver refuses `MOTIR_*` names, so the two cannot
 *  collide), the check's own fixed three otherwise. */
async function releaseEnvironment(
  deps: DeployCheckDeps,
  options: DeployCheckOptions,
  appRef: string,
  manifest: HostingManifest,
  release: 1 | 2,
): Promise<ReleaseEnvVar[]> {
  const marker = { name: 'MOTIR_DEPLOY_CHECK_RELEASE', value: String(release), secret: false };
  if (!options.stored) {
    return [
      marker,
      { name: 'WHOAMI_NAME', value: `${appRef} release ${release}`, secret: false },
      { name: 'WHOAMI_PORT_NUMBER', value: String(manifest.port), secret: false },
    ];
  }
  const { workspaceId, repositoryId, environment } = options.stored;
  const resolved = await wired(deps, 'resolveEnvironment')(repositoryId, environment, {
    workspaceId,
  });
  // Names and the secret flag only — never a value.
  deps.print('environment', {
    repository: repositoryId,
    environment,
    entries: resolved.length,
    ...Object.fromEntries(resolved.map((v) => [v.name, v.secret ? 'secret' : 'plain'])),
  });
  return [...resolved, marker];
}

/** An AWS release: the shape as given (none when none was), `always_on` (the
 *  container shape refuses `suspend`; a function idles by nature either way),
 *  and by default the image `push` put under the release's tag. */
async function deployAwsRelease(
  deps: DeployCheckDeps,
  options: DeployCheckOptions,
  aws: DeployCheckAwsOptions,
  release: 1 | 2,
): Promise<void> {
  const manifest = readManifest(deps, options.manifestPath);
  const { repositoryId, appRef } = deployCheckAwsApp(aws.repositoryId);
  const port = deps.port('aws');
  // With no shape the port refuses the deploy before it does anything, so the
  // check does not ask for the app first — that would make the tenant account
  // request the refusal is there to show was never made.
  if (release === 1 && aws.shape) {
    await port.ensureApp({ repositoryId, environment: ENVIRONMENT });
  }
  const handle = await port.deploy({
    appRef,
    environment: ENVIRONMENT,
    artifact: imageArtifact(aws.image ?? awsReleaseImage(repositoryId, release)),
    runtime: manifest,
    env: [{ name: 'MOTIR_DEPLOY_CHECK_RELEASE', value: String(release), secret: false }],
    size: 'small',
    idle: { mode: 'always_on' },
    ...(aws.shape ? { shape: aws.shape } : {}),
  });
  const description = await port.describe(handle);
  deps.print(release === 1 ? 'deploy' : 'release2', {
    app: appRef,
    shape: aws.shape,
    release,
    releaseId: handle.releaseId,
    state: description.state,
    address: description.upstreamAddress,
    originCredential: description.originCredential,
  });
  if (release === 2) await page(deps, options);
}

async function rollback(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = checkApp(options);
  const port = portOf(deps, options);
  const handle = await port.rollback({ appRef, environment: ENVIRONMENT });
  const description = await port.describe(handle);
  deps.print('rollback', {
    app: appRef,
    servingReleaseId: description.releaseId,
    previousReleaseId: description.previousReleaseId,
    address: description.upstreamAddress,
  });
  // No push and no build: the previous release's image is already there.
  if (options.aws) await page(deps, options);
}

async function status(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = checkApp(options);
  const port = portOf(deps, options);
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

const statusLine = (res: Response): string => `${res.status} ${res.statusText}`.trim();

async function probe(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const manifest = readManifest(deps, options.manifestPath);
  const { appRef } = checkApp(options);
  const port = portOf(deps, options);
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

/** GET `/` on the serving release (with the origin secret when the release is
 *  guarded) and print the lines the app answers — for the env-reporting fixture,
 *  `GREETING=<value>` and `API_KEY: present|absent`. */
async function report(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = checkApp(options);
  const port = portOf(deps, options);
  const handle = await servingHandle(port, appRef);
  const description = handle ? await port.describe(handle) : null;
  if (!description?.upstreamAddress) {
    deps.print('report', { app: appRef, state: description?.state ?? 'none' });
    throw new DeployCheckReportFailedError(`${appRef} serves no release`);
  }
  const url = new URL('/', description.upstreamAddress).toString();
  const secret =
    description.originCredential === 'origin_secret'
      ? deriveOriginSecret(deps.originSecretKey(), appRef)
      : null;
  const res = await deps.fetch(url, { headers: secret ? { [ORIGIN_SECRET_HEADER]: secret } : {} });
  const lines = (await res.text()).split('\n').filter((line) => line.trim() !== '');
  deps.print('report', {
    app: appRef,
    url,
    status: statusLine(res),
    ...Object.fromEntries(lines.map((line, i) => [`line${i + 1}`, line])),
  });
  if (!res.ok) throw new DeployCheckReportFailedError(`the app answered ${res.status}`);
}

async function destroy(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const { appRef } = checkApp(options);
  const port = portOf(deps, options);
  const handle = await servingHandle(port, appRef);
  const usage = handle ? await port.destroy(handle, 'operator') : null;
  deps.print('destroy', {
    app: appRef,
    usage: usage ? JSON.stringify(usage) : 'none (no release)',
    // An AWS release bills in compute units: Lambda GB-seconds or Fargate
    // vCPU-seconds and GB-seconds.
    ...(options.aws ? { compute: usage?.compute ? JSON.stringify(usage.compute) : 'none' } : {}),
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

/** The AWS options, or a refusal: the step is the AWS target's alone. */
function awsOptions(step: DeployCheckStep, options: DeployCheckOptions): DeployCheckAwsOptions {
  if (!options.aws) throw new DeployCheckUsageError(`${step} runs with --target aws only.`);
  return options.aws;
}

function requireFlag(value: string | null, step: string, flag: string): string {
  if (!value) throw new DeployCheckUsageError(`${step} needs --${flag}.`);
  return value;
}

/** `converge`: the deploy role of the organisation's tenant account onto the
 *  policy this run needs — what `fleet-admin hosting-tenant
 *  converge-deploy-policy --organization <id>` runs. Prints the outcome's name
 *  only. */
async function converge(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const aws = awsOptions('converge', options);
  const organizationId = requireFlag(aws.organizationId, 'converge', 'organization');
  const outcome = await wired(deps, 'converge')(organizationId);
  deps.print('converge', { organization: organizationId, outcome });
  if (outcome !== 'changed' && outcome !== 'unchanged') {
    throw new DeployCheckConvergeFailedError(organizationId, outcome);
  }
}

/** `push`: build the fixture as release 1 and release 2 and push both to the
 *  app's push namespace, under the operator's own profile. It prints the push
 *  credential the port mints — what CI will push as — but cannot use it: that
 *  role trusts only GitHub OIDC from the repository. The registry password is
 *  piped from `aws ecr get-login-password` into `docker login --password-stdin`
 *  and goes nowhere else. */
async function push(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const aws = awsOptions('push', options);
  const profile = requireFlag(aws.awsProfile, 'push', 'aws-profile');
  const exec = wired(deps, 'exec');
  const { repositoryId, appRef } = deployCheckAwsApp(aws.repositoryId);
  const port = deps.port('aws');
  const app = await port.ensureApp({ repositoryId, environment: ENVIRONMENT });
  const credential = await port.mintDeployCredential({ pushNamespace: app.pushNamespace });

  const profileArgs = ['--region', DEPLOY_CHECK_AWS_REGION, '--profile', profile];
  const identity = await exec('aws', [
    'sts',
    'get-caller-identity',
    '--query',
    'Account',
    '--output',
    'text',
    ...profileArgs,
  ]);
  const registry = `${identity.stdout.trim()}.dkr.ecr.${DEPLOY_CHECK_AWS_REGION}.amazonaws.com`;
  const password = await exec('aws', ['ecr', 'get-login-password', ...profileArgs]);
  await exec('docker', ['login', '--username', 'AWS', '--password-stdin', registry], {
    stdin: password.stdout.trim(),
  });

  const digests: string[] = [];
  for (const release of [1, 2] as const) {
    const ref = `${registry}/${awsReleaseImage(repositoryId, release)}`;
    await exec('docker', [
      'build',
      '--platform',
      'linux/amd64',
      '--provenance=false',
      '--build-arg',
      `RELEASE=${release}`,
      '--tag',
      ref,
      DEPLOY_CHECK_AWS_FIXTURE_DIR,
    ]);
    await exec('docker', ['push', ref]);
    const inspected = await exec('docker', [
      'image',
      'inspect',
      '--format',
      '{{index .RepoDigests 0}}',
      ref,
    ]);
    digests.push(inspected.stdout.trim());
  }
  deps.print('push', {
    app: appRef,
    pushNamespace: app.pushNamespace,
    pushesInCiAs:
      credential.kind === 'federated' ? credential.subject : `${credential.kind} credential`,
    registry,
    release1: digests[0],
    release2: digests[1],
  });
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** One GET of the release, sent with what its origin credential names, tried
 *  again while the release (or its database) is waking. */
async function readRelease(
  deps: DeployCheckDeps,
  appRef: string,
  description: ReleaseDescription,
  url: string,
): Promise<Response> {
  const once = (): Promise<Response> => {
    if (description.originCredential === 'aws_sigv4') return wired(deps, 'signedFetch')(url);
    const headers: Record<string, string> =
      description.originCredential === 'origin_secret'
        ? { [ORIGIN_SECRET_HEADER]: deriveOriginSecret(deps.originSecretKey(), appRef) }
        : {};
    return deps.fetch(url, { headers });
  };
  const sleep = deps.sleep ?? wait;
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt >= DEPLOY_CHECK_PAGE_ATTEMPTS;
    try {
      const res = await once();
      if (res.status < 500 || last) return res;
    } catch (err) {
      if (last) throw err;
    }
    await sleep(DEPLOY_CHECK_PAGE_RETRY_MS);
  }
}

async function bodyOf(res: Response): Promise<{ release?: unknown; row?: unknown } | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/** `page`: the serving release's health path and its `/row`, printed with the
 *  release number the image was built as and the row it read. */
async function page(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  awsOptions('page', options);
  const manifest = readManifest(deps, options.manifestPath);
  const { appRef } = checkApp(options);
  const port = deps.port('aws');
  const handle = await servingHandle(port, appRef);
  const description = handle ? await port.describe(handle) : null;
  if (!description?.upstreamAddress) {
    deps.print('page', { app: appRef, state: description?.state ?? 'none' });
    throw new DeployCheckPageFailedError(`${appRef} serves no release`);
  }
  const at = (path: string) => new URL(path, description.upstreamAddress!).toString();
  const health = await readRelease(deps, appRef, description, at(manifest.healthCheck.path));
  const rowRes = await readRelease(deps, appRef, description, at('/row'));
  const body = rowRes.ok ? await bodyOf(rowRes) : null;
  const row = body?.row ?? null;
  deps.print('page', {
    app: appRef,
    address: description.upstreamAddress,
    originCredential: description.originCredential,
    servingReleaseId: description.releaseId,
    health: statusLine(health),
    row: statusLine(rowRes),
    release: body?.release ?? null,
    data: JSON.stringify(row),
  });
  if (!health.ok) throw new DeployCheckPageFailedError(`health answered ${health.status}`);
  if (!row) throw new DeployCheckPageFailedError(`/row answered ${rowRes.status} with no row`);
}

/** `no-shape`: a deploy with no shape, which the port must refuse by name; then
 *  the app's releases, which must be none. The refusal is the step's result. */
async function noShape(deps: DeployCheckDeps, options: DeployCheckOptions): Promise<void> {
  const aws = awsOptions('no-shape', options);
  if (aws.shape) throw new DeployCheckUsageError('no-shape runs without --shape.');
  const manifest = readManifest(deps, options.manifestPath);
  const { repositoryId, appRef } = deployCheckAwsApp(aws.repositoryId);
  const port = deps.port('aws');
  let refusal: unknown = null;
  try {
    await port.deploy({
      appRef,
      environment: ENVIRONMENT,
      artifact: imageArtifact(aws.image ?? awsReleaseImage(repositoryId, 1)),
      runtime: manifest,
      env: [],
      size: 'small',
      idle: { mode: 'always_on' },
    });
  } catch (err) {
    refusal = err;
  }
  const releases = await port.listReleases({ appRef });
  deps.print('no-shape', {
    app: appRef,
    releases: releases.length === 0 ? 'none' : releases.map((r) => r.handle.releaseId).join(', '),
  });
  throw refusal ?? new DeployCheckShapeNotRefusedError(appRef);
}

/** Run one step (or `all` of them in order). Throws the typed error a step
 *  refuses with; `runDeployCheck` turns it into output and an exit code. */
export async function runDeployCheckStep(
  step: DeployCheckStep,
  deps: DeployCheckDeps,
  options: DeployCheckOptions,
): Promise<void> {
  if (!options.aws && AWS_ONLY_STEPS.includes(step)) awsOptions(step, options);
  switch (step) {
    case 'converge':
      return converge(deps, options);
    case 'push':
      return push(deps, options);
    case 'page':
      return page(deps, options);
    case 'no-shape':
      return noShape(deps, options);
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
    case 'report':
      return report(deps, options);
    case 'destroy':
      return destroy(deps, options);
    case 'all':
      if (options.aws) return allAws(deps, options, options.aws);
      // Refuse an invalid manifest or name before the first port call, not
      // halfway through the sequence.
      readManifest(deps, options.manifestPath);
      deployCheckApp(options.appName);
      await deployRelease(deps, options, 1);
      await deployRelease(deps, options, 2);
      await rollback(deps, options);
      await status(deps, options);
      await probe(deps, options);
      await report(deps, options);
      return destroy(deps, options);
  }
}

/** The AWS `all`: converge, push, deploy and page release 1, release 2 (which
 *  pages it), roll back (which pages release 1 again), destroy. */
async function allAws(
  deps: DeployCheckDeps,
  options: DeployCheckOptions,
  aws: DeployCheckAwsOptions,
): Promise<void> {
  // Every refusal the sequence could meet on its way, before its first call.
  readManifest(deps, options.manifestPath);
  requireFlag(aws.organizationId, 'all', 'organization');
  requireFlag(aws.awsProfile, 'all', 'aws-profile');
  await converge(deps, options);
  await push(deps, options);
  await deployRelease(deps, options, 1);
  await page(deps, options);
  await deployRelease(deps, options, 2);
  await rollback(deps, options);
  return destroy(deps, options);
}

const SHAPES: readonly string[] = ['function', 'container'];

/** argv (after the script name) → the step and its options. */
export function parseDeployCheckArgs(argv: readonly string[]): {
  step: DeployCheckStep;
  options: DeployCheckOptions;
} {
  let step: DeployCheckStep | undefined;
  type Flag =
    | 'manifest'
    | 'name'
    | 'image'
    | 'target'
    | 'shape'
    | 'repository'
    | 'organization'
    | 'aws-profile'
    | 'workspace'
    | 'environment';
  const flags: Partial<Record<Flag, string>> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const flag =
      /^--(manifest|name|image|target|shape|repository|organization|aws-profile|workspace|environment)(?:=(.*))?$/.exec(
        arg,
      );
    if (flag) {
      const key = flag[1] as keyof typeof flags;
      const value = flag[2] ?? argv[(i += 1)];
      if (!value) throw new DeployCheckUsageError(`--${key} needs a value.`);
      flags[key] = value;
    } else if (!step && (DEPLOY_CHECK_STEPS as readonly string[]).includes(arg)) {
      step = arg as DeployCheckStep;
    } else {
      throw new DeployCheckUsageError(`Unknown argument: ${arg}`);
    }
  }
  if (!step) throw new DeployCheckUsageError('Name a step.');
  const target = flags.target ?? 'fly';
  if (!(DEPLOY_CHECK_TARGETS as readonly string[]).includes(target)) {
    throw new DeployCheckUsageError(`--target is ${DEPLOY_CHECK_TARGETS.join(' or ')}.`);
  }
  if (target === 'aws') {
    for (const only of ['workspace', 'environment'] as const) {
      if (flags[only]) throw new DeployCheckUsageError(`--${only} is for --target fly only.`);
    }
    if (flags.name) throw new DeployCheckUsageError('--name is refused with --target aws.');
    if (!flags.repository) throw new DeployCheckUsageError('--target aws needs --repository.');
    if (flags.shape && !SHAPES.includes(flags.shape)) {
      throw new DeployCheckUsageError(`--shape is ${SHAPES.join(' or ')}.`);
    }
    return {
      step,
      options: {
        manifestPath: flags.manifest ?? DEPLOY_CHECK_AWS_MANIFEST,
        appName: `${AWS_APP_PREFIX}${flags.repository}`,
        image: flags.image ?? awsReleaseImage(flags.repository, 1),
        aws: {
          repositoryId: flags.repository,
          shape: (flags.shape as ReleaseShape | undefined) ?? null,
          organizationId: flags.organization ?? null,
          awsProfile: flags['aws-profile'] ?? null,
          image: flags.image ?? null,
        },
      },
    };
  }
  for (const only of ['shape', 'organization', 'aws-profile'] as const) {
    if (flags[only]) throw new DeployCheckUsageError(`--${only} is for --target aws only.`);
  }
  // On Fly, `--repository` names the repository whose stored environment the
  // check deploys, and comes with `--workspace` and `--environment`.
  const stored = parseStoredEnvironment(flags);
  return {
    step,
    options: {
      manifestPath:
        flags.manifest ??
        (stored ? DEPLOY_CHECK_ENV_REPORT_MANIFEST : DEPLOY_CHECK_DEFAULT_MANIFEST),
      appName: flags.name ?? DEPLOY_CHECK_DEFAULT_NAME,
      image: flags.image ?? (stored ? DEPLOY_CHECK_ENV_REPORT_IMAGE : DEPLOY_CHECK_IMAGE),
      ...(stored ? { stored } : {}),
    },
  };
}

/** All three of `--workspace`, `--repository`, `--environment`, or none. */
function parseStoredEnvironment(flags: {
  workspace?: string;
  repository?: string;
  environment?: string;
}): DeployCheckStoredEnvironment | undefined {
  const { workspace, repository, environment } = flags;
  if (workspace === undefined && repository === undefined && environment === undefined) {
    return undefined;
  }
  if (workspace === undefined && environment === undefined) {
    throw new DeployCheckUsageError(
      '--repository is for --target aws only, or goes with --workspace and --environment.',
    );
  }
  if (workspace === undefined || repository === undefined || environment === undefined) {
    throw new DeployCheckUsageError(
      '--workspace, --repository and --environment go together: give all three or none.',
    );
  }
  if (!isEnvironmentName(environment)) {
    throw new DeployCheckUsageError(
      `Unknown environment ${environment}: use one of ${ENVIRONMENTS.join(', ')}.`,
    );
  }
  return { workspaceId: workspace, repositoryId: repository, environment };
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
