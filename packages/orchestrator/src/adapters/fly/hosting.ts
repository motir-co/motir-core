import { OrchestratorApiError, OrchestratorNotConfiguredError } from '../../errors';
import {
  NoPreviousReleaseError,
  ReleaseArtifactUnsupportedError,
  ReleaseNotFoundError,
  ReleaseRuntimeRefusedError,
} from '../../hosting/errors';
import { hostingAppNames, pushNamespaceName } from '../../hosting/names';
import { deriveOriginSecret } from '../../hosting/originSecret';
import type {
  DeployCredential,
  DeployReleaseInput,
  HostingDeployPort,
  HostingEnvironment,
  ReleaseArtifact,
  ReleaseCommandResult,
  ReleaseDescription,
  ReleaseHandle,
  ReleaseIdlePolicy,
  ReleaseSize,
  ReleaseState,
  ReleaseSummary,
  ReleaseUsage,
} from '../../hosting/types';
import { runningSecondsBetween, type RunTransition } from '../../hosting/usage';
import {
  exitCodeOf,
  flyErrorDetail,
  flyGraphqlRequest,
  flyMachinesClientFor,
  flyRequest,
  readFlyJson,
  toFlyMachine,
  type FlyMachine,
} from './flyMachines';
import { flyAppProvisioning } from './persistent';

// The FLY adapter of the HOSTING DEPLOY PORT (Story MOTIR-9791 · MOTIR-5773), to
// the decision of record MOTIR-5769 §4 (page cmvrcywwc00jkhpr1zvvnike8, v1).
//
// ⚠️ ITS OWN ORGANISATION AND TOKEN. Hosted apps live in the Fly org
// `motir-hosting`, reached with `MOTIR_HOSTING_FLY_API_TOKEN` — never the CI
// fleet's or the agent instances' token, so a tenant app can never be created
// in, or reach, either of those organisations' apps.
//
// The units: one app per production (`mh-<rid>`) and one per preview pull request
// (`mh-<rid>-pr<n>`), each created on its OWN private network so no two tenants'
// Machines share a 6PN; previews' images live in `mh-<rid>-pv`, an app with no
// Machines. Each deploy app runs ONE Machine, which a later deploy UPDATES IN
// PLACE. The release a deploy replaced stays readable as one of the Machine's
// config versions (`GET …/versions`), which is what rollback restores — image,
// env and all — rather than a second Machine.
//
// ⚠️ EVERY RELEASE RUNS BEHIND THE GUARD (MOTIR-9947, decision §4 and D-5). The
// Machine runs TWO containers: `motir-hosting-guard` on the service's port 9180,
// which answers 403 to any request without the app's origin secret and proxies
// the rest to the app on 127.0.0.1, and the app itself, whose own port is never
// a service. The guard image and the key the secret is derived from are read
// with the token, and an unset one refuses to build the adapter at all, so no
// release is ever deployed unguarded.
//
// Reused, not copied: the bounded `flyRequest`, its error helpers and the
// machine parser (`./flyMachines`), and app creation and public addresses
// (`./persistent`'s `flyAppProvisioning`). The single-use `createMachine` of the
// fleet client is NOT used: it sets `auto_destroy` and `restart: no`, which is
// exactly wrong for a release that must keep serving.

export interface FlyHostingConfig {
  readonly token: string;
  readonly org: string;
  readonly region: string;
  readonly appPrefix: string;
  /** The guard image, pinned by digest (`registry.fly.io/motir-hosting-guard@sha256:…`). */
  readonly guardImage: string;
  /** The key every app's origin secret is derived from (`deriveOriginSecret`). */
  readonly originSecretKey: string;
}

const TOKEN_ENV = 'MOTIR_HOSTING_FLY_API_TOKEN';
const GUARD_IMAGE_ENV = 'MOTIR_HOSTING_GUARD_IMAGE';
const ORIGIN_SECRET_KEY_ENV = 'MOTIR_HOSTING_ORIGIN_SECRET_KEY';

/** The port the guard listens on in every Machine; a release may not take it. */
export const HOSTING_GUARD_PORT = 9180;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OrchestratorNotConfiguredError(`set ${name}`);
  return value;
}

/** The hosting lane's configuration, read at call time, or the typed
 *  not-configured error naming the first variable that is unset: the token, the
 *  guard image or the origin-secret key. Fail closed — without the guard there is
 *  no adapter. */
export function flyHostingConfig(): FlyHostingConfig {
  const token = requiredEnv(TOKEN_ENV);
  const guardImage = requiredEnv(GUARD_IMAGE_ENV);
  const originSecretKey = requiredEnv(ORIGIN_SECRET_KEY_ENV);
  return {
    token,
    guardImage,
    originSecretKey,
    org: process.env['MOTIR_HOSTING_FLY_ORG']?.trim() || 'motir-hosting',
    region: process.env['MOTIR_HOSTING_FLY_REGION']?.trim() || 'iad',
    appPrefix: process.env['MOTIR_HOSTING_FLY_APP_PREFIX']?.trim() || 'mh-',
  };
}

/** A one-off command polls Fly's wait endpoint in windows of at most this long
 *  (its own ceiling is 60 s). */
const COMMAND_WAIT_WINDOW_SECONDS = 60;

// ⚠️ A RELEASE WRITE IS NOT DONE WHEN FLY ACCEPTS IT (MOTIR-11250). Fly applies a
// Machine create or update ASYNCHRONOUSLY: the Machine is `created` or
// `replacing` for as long as the image is pulled and the new version launched,
// and every other write to it meanwhile is refused `409 aborted: machine is
// replacing: concurrent update in progress`. So `deploy` and `rollback` wait for
// the version they wrote to settle before they return, and a write that meets
// an update already in flight (another caller's, or one whose wait ran out) is
// retried with backoff instead of failing — all inside one bounded budget.

/** How long a deploy waits for its write to settle, retries included: flyctl's
 *  own `fly deploy --wait-timeout` default (5 minutes), since a new image may
 *  have to be pulled first. */
export const FLY_DEPLOY_SETTLE_SECONDS = 300;

/** How long a rollback waits. It restores an image Fly already holds, and it
 *  runs inside the rollback service's 120 s lock (`ROLLBACK_LOCK_TIMEOUT_MS`), so
 *  it is held to one Machines-API wait window. */
export const FLY_ROLLBACK_SETTLE_SECONDS = 60;

/** Each `/wait` call is a window this long — short of Fly's 60 s ceiling
 *  (MOTIR-9206), so a Machine that settles STOPPED rather than started is
 *  noticed within seconds rather than at the end of a full minute. */
const SETTLE_WAIT_WINDOW_SECONDS = 10;

/** The longest pause between retries of a write refused for an update in flight. */
const IN_FLIGHT_RETRY_MAX_SECONDS = 8;

/** Seconds a release write may still spend retrying and settling. */
interface SettleBudget {
  remaining: number;
  readonly total: number;
}

/** Fly's refusal of a write to a Machine whose previous update is still applying. */
const IN_FLIGHT_UPDATE = /machine is replacing|concurrent update/i;

/** A Machine state an applied update can settle in without having started: a
 *  `suspend`-policy release may be stopped or suspended by Fly's proxy, and a
 *  release whose process exits stops. Either way the write is applied. */
const SETTLED_IDLE_STATES = new Set(['stopped', 'suspended']);

/** Machine metadata the adapter reads back. */
export const HOSTING_RELEASE_METADATA = {
  marker: 'motir_hosting',
  releaseId: 'motir_release_id',
  previousReleaseId: 'motir_previous_release_id',
  environment: 'motir_environment',
} as const;

/** App-scoped deploy tokens live 90 days; enablement re-mints under 14 (§4). */
const DEPLOY_TOKEN_EXPIRY = '2160h';
const DEPLOY_TOKEN_TTL_MS = 90 * 86_400_000;

/** Previews run `shared-cpu-1x` 512 MB; production by the row's size (§4). */
const PREVIEW_GUEST = { cpu_kind: 'shared', cpus: 1, memory_mb: 512 };
const PRODUCTION_GUEST: Record<ReleaseSize, { cpu_kind: string; cpus: number; memory_mb: number }> =
  {
    small: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
    medium: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
    large: { cpu_kind: 'shared', cpus: 4, memory_mb: 4096 },
  };

export interface FlyHostingOptions {
  /** The clock usage windows end at. */
  readonly now?: () => Date;
  /** A new release id. */
  readonly newReleaseId?: () => string;
  /** The pause between retries of a write Fly refused for an update in flight —
   *  a seam so a test need not wait real seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Where `docker push` reaches a Fly app's images. */
export const FLY_REGISTRY = 'registry.fly.io';

/** An app's tokens, and the revocation of one (MOTIR-5775). The Machines API
 *  mints a deploy token (`POST /apps/{app}/deploy_token`) but neither lists nor
 *  revokes one; flyctl's `tokens list` / `tokens revoke` use these two calls. */
const APP_TOKENS_QUERY = `query ($appName: String!) {
  app(name: $appName) { limitedAccessTokens { nodes { id revokedAt } } }
}`;
const REVOKE_TOKEN_MUTATION = `mutation ($input: DeleteLimitedAccessTokenInput!) {
  deleteLimitedAccessToken(input: $input) { token }
}`;

/** GraphQL's answer for an app that does not exist. */
const APP_NOT_FOUND = /could not find app|not found/i;

function appPath(app: string, rest = ''): string {
  return `/apps/${encodeURIComponent(app)}${rest}`;
}

async function refuse(res: Response): Promise<never> {
  throw new OrchestratorApiError('fly', res.status, flyErrorDetail(await readFlyJson(res)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function environmentLabel(environment: HostingEnvironment): string {
  return environment.kind === 'production' ? 'production' : `pr-${environment.pullRequest}`;
}

function environmentOf(label: string | undefined): HostingEnvironment {
  const match = /^pr-(\d+)$/.exec(label ?? '');
  return match ? { kind: 'preview', pullRequest: Number(match[1]) } : { kind: 'production' };
}

/** `suspend`: autostop "suspend", autostart, min 0; `always_on`: autostop "off",
 *  min 1. Fly picks the idle window, so `idleSeconds` is not applied (§4). */
function idleService(idle: ReleaseIdlePolicy) {
  return idle.mode === 'suspend'
    ? { autostop: 'suspend', autostart: true, min_machines_running: 0 }
    : { autostop: 'off', autostart: true, min_machines_running: 1 };
}

function imageOf({ artifact }: { artifact: ReleaseArtifact }): string {
  if (artifact.kind !== 'image') throw new ReleaseArtifactUnsupportedError('fly', artifact.kind);
  return artifact.digest ? `${artifact.ref}@${artifact.digest}` : artifact.ref;
}

/** The start command as argv — no shell, so an image without one (`scratch`)
 *  still starts; arguments are separated by whitespace. */
function argvOf(command: string): string[] {
  return command.trim().split(/\s+/);
}

/** The container names in a release Machine. */
export const HOSTING_CONTAINERS = { guard: 'guard', app: 'app' } as const;

/** The guard container for `appRef`: its image by digest, the app's derived
 *  origin secret and the port it forwards to. Rebuilt on every write — deploy
 *  and rollback alike — so a rotated key or a new guard image applies at once. */
function guardContainer(
  config: FlyHostingConfig,
  appRef: string,
  appPort: number,
): Record<string, unknown> {
  return {
    name: HOSTING_CONTAINERS.guard,
    image: config.guardImage,
    env: {
      MOTIR_GUARD_ORIGIN_SECRET: deriveOriginSecret(config.originSecretKey, appRef),
      MOTIR_GUARD_APP_PORT: String(appPort),
    },
  };
}

function machineConfig(
  config: FlyHostingConfig,
  input: DeployReleaseInput,
  metadata: Record<string, string>,
): Record<string, unknown> {
  const { runtime } = input;
  if (runtime.port === HOSTING_GUARD_PORT) {
    throw new ReleaseRuntimeRefusedError(
      'fly',
      'port',
      `${HOSTING_GUARD_PORT} is the hosting guard's port`,
    );
  }
  return {
    // No top-level image: a Machine with `containers` runs each from its own.
    containers: [
      guardContainer(config, input.appRef, runtime.port),
      {
        name: HOSTING_CONTAINERS.app,
        image: imageOf(input),
        exec: argvOf(runtime.startCommand),
        env: Object.fromEntries(input.env.map((v) => [v.name, v.value])),
      },
    ],
    guest:
      input.environment.kind === 'preview'
        ? PREVIEW_GUEST
        : PRODUCTION_GUEST[input.size ?? 'small'],
    services: [
      {
        protocol: 'tcp',
        // The GUARD's port: the app's own port is never a service, so Fly's
        // proxy can reach the app only through the guard.
        internal_port: HOSTING_GUARD_PORT,
        ...idleService(input.idle),
        ports: [
          { port: 80, handlers: ['http'], force_https: true },
          { port: 443, handlers: ['tls', 'http'] },
        ],
      },
    ],
    // A Machine-level check, run by Fly against the app's port inside the
    // Machine — not through the service, so the guard never has to let an
    // unauthenticated probe through.
    checks: {
      health: {
        type: 'http',
        port: runtime.port,
        method: 'GET',
        path: runtime.healthCheck.path,
        interval: '15s',
        timeout: '5s',
        grace_period: '10s',
      },
    },
    metadata,
  };
}

/** The app container of a kept config version and the port its guard forwards
 *  to, or null for a version with no guarded app (one written before the guard),
 *  which rollback refuses rather than restore unguarded. */
function keptAppContainer(
  kept: Record<string, unknown> | null | undefined,
): { container: Record<string, unknown>; port: number } | null {
  const raw = kept?.['containers'];
  const containers = (Array.isArray(raw) ? raw : []).map(asRecord);
  const app = containers.find((c) => c?.['name'] === HOSTING_CONTAINERS.app);
  const guard = containers.find((c) => c?.['name'] === HOSTING_CONTAINERS.guard);
  const port = Number(asRecord(guard?.['env'])?.['MOTIR_GUARD_APP_PORT']);
  return app && Number.isInteger(port) && port > 0 ? { container: app, port } : null;
}

/** The raw machine fields `toFlyMachine` does not keep: the config version and
 *  the health checks' statuses. */
function versionOf(body: unknown): string | null {
  const version = asRecord(body)?.['version'];
  return typeof version === 'string' ? version : null;
}

/** The Machine's current instance — the version a write produced, which
 *  `/wait?instance_id=` waits on. Fly names it `instance_id`; `version` is read
 *  as a fallback, as the persistent adapter does. */
function instanceIdOf(body: unknown): string | null {
  const record = asRecord(body);
  const id = record?.['instance_id'] ?? record?.['version'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function checkStatusesOf(body: unknown): string[] {
  const checks = asRecord(body)?.['checks'];
  return (Array.isArray(checks) ? checks : []).flatMap((c) => {
    const status = asRecord(c)?.['status'];
    return typeof status === 'string' ? [status] : [];
  });
}

/** Fly's machine state and checks → the port's closed release state. */
export function releaseStateOf(
  machineState: string,
  checkStatuses: readonly string[],
): ReleaseState {
  if (machineState === 'destroyed' || machineState === 'destroying') return 'destroyed';
  if (machineState === 'stopped' || machineState === 'suspended' || machineState === 'stopping') {
    return 'stopped';
  }
  if (machineState !== 'started') return 'deploying';
  if (checkStatuses.includes('critical')) return 'unhealthy';
  if (checkStatuses.length > 0 && checkStatuses.every((s) => s === 'passing')) return 'healthy';
  return 'deploying';
}

/** Fly's machine events → running transitions: a `start` begins running; a
 *  `stop`, `suspend`, `exit` or `destroy` ends it. */
export function runTransitionsOf(machine: FlyMachine): RunTransition[] {
  return machine.events.flatMap((event): RunTransition[] => {
    if (!event.timestamp) return [];
    if (event.type === 'start') return [{ at: event.timestamp, running: true }];
    if (['stop', 'suspend', 'exit', 'destroy'].includes(event.type)) {
      return [{ at: event.timestamp, running: false }];
    }
    return [];
  });
}

function defaultReleaseId(): string {
  return `rel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createFlyHostingDeployPort(
  config: FlyHostingConfig,
  options: FlyHostingOptions = {},
): HostingDeployPort {
  const now = options.now ?? (() => new Date());
  const newReleaseId = options.newReleaseId ?? defaultReleaseId;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { token } = config;
  const clientFor = (app: string) => flyMachinesClientFor({ token, app });

  async function readMachine(
    app: string,
    id: string,
  ): Promise<{ body: unknown; machine: FlyMachine } | null> {
    const res = await flyRequest(appPath(app, `/machines/${encodeURIComponent(id)}`), {
      method: 'GET',
      token,
    });
    if (res.status === 404) return null;
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    const machine = toFlyMachine(body);
    return machine ? { body, machine } : null;
  }

  /** The app's release Machine, or null when it has none yet. */
  async function releaseMachine(app: string): Promise<FlyMachine | null> {
    const machines = await clientFor(app).listMachines();
    return (
      machines.find(
        (m) => m.metadata[HOSTING_RELEASE_METADATA.marker] === 'release' && m.state !== 'destroyed',
      ) ?? null
    );
  }

  const budgetOf = (seconds: number): SettleBudget => ({ remaining: seconds, total: seconds });

  function settleTimeout(id: string, budget: SettleBudget): OrchestratorApiError {
    return new OrchestratorApiError(
      'fly',
      408,
      `release Machine ${id} did not finish applying its update within ${budget.total} s`,
    );
  }

  /** Write the release Machine — an update of `existing`, else a create — and
   *  answer the Machine and the instance the write produced. A write Fly refuses
   *  because an earlier update is still applying is retried with doubling pauses
   *  while the budget lasts; any other refusal is thrown at once. */
  async function writeMachine(
    app: string,
    existing: { id: string; version: string | null } | null,
    body: Record<string, unknown>,
    region: string,
    budget: SettleBudget,
  ): Promise<{ id: string; instanceId: string | null }> {
    for (let pause = 1; ; pause = Math.min(pause * 2, IN_FLIGHT_RETRY_MAX_SECONDS)) {
      const res = existing
        ? await flyRequest(appPath(app, `/machines/${encodeURIComponent(existing.id)}`), {
            method: 'POST',
            token,
            body: JSON.stringify({
              config: body,
              ...(existing.version ? { current_version: existing.version } : {}),
            }),
          })
        : await flyRequest(appPath(app, '/machines'), {
            method: 'POST',
            token,
            body: JSON.stringify({ name: 'release', region, config: body }),
          });
      const parsed = await readFlyJson(res);
      if (res.ok) {
        const machine = toFlyMachine(parsed);
        if (!machine)
          throw new OrchestratorApiError(
            'fly',
            res.status,
            'machine write returned an unexpected shape',
          );
        return { id: machine.id, instanceId: instanceIdOf(parsed) };
      }
      const detail = flyErrorDetail(parsed);
      if (res.status !== 409 || !IN_FLIGHT_UPDATE.test(detail)) {
        throw new OrchestratorApiError('fly', res.status, detail);
      }
      if (budget.remaining <= 0) throw new OrchestratorApiError('fly', res.status, detail);
      const wait = Math.min(pause, budget.remaining);
      budget.remaining -= wait;
      await sleep(wait * 1000);
    }
  }

  /** Has the Machine settled at `instanceId` without starting? */
  function settledIdle(read: { body: unknown; machine: FlyMachine }, instanceId: string | null) {
    return (
      SETTLED_IDLE_STATES.has(read.machine.state) &&
      (instanceId === null || instanceIdOf(read.body) === instanceId)
    );
  }

  /** Return once Fly has finished applying the write: its instance `started`
   *  (Fly launches the Machine on every create and update), or — when it settled
   *  idle instead — stopped or suspended at that instance. Waits in windows of
   *  {@link SETTLE_WAIT_WINDOW_SECONDS} and reads the Machine after each window
   *  that ends without `started`; throws once the budget is spent, or when the
   *  wait is refused for any reason other than its window passing. */
  async function settle(
    app: string,
    written: { id: string; instanceId: string | null },
    budget: SettleBudget,
  ): Promise<void> {
    const path = `/machines/${encodeURIComponent(written.id)}`;
    for (;;) {
      const window = Math.min(SETTLE_WAIT_WINDOW_SECONDS, budget.remaining);
      if (window <= 0) throw settleTimeout(written.id, budget);
      const query = new URLSearchParams({ state: 'started', timeout: String(window) });
      if (written.instanceId) query.set('instance_id', written.instanceId);
      const waited = await flyRequest(appPath(app, `${path}/wait?${query.toString()}`), {
        method: 'GET',
        token,
        timeoutMs: (window + 10) * 1000,
      });
      if (waited.ok) return;
      const refusal = waited.status === 408 ? null : await readFlyJson(waited);
      // 408: the window passed and the instance has not started. Spent either way.
      budget.remaining -= window;
      const read = await readMachine(app, written.id);
      if (!read || read.machine.state === 'destroyed') {
        throw new OrchestratorApiError(
          'fly',
          404,
          `release Machine ${written.id} was destroyed while its update applied`,
        );
      }
      if (settledIdle(read, written.instanceId)) return;
      if (refusal !== null) {
        throw new OrchestratorApiError('fly', waited.status, flyErrorDetail(refusal));
      }
    }
  }

  /** The app's release Machines; an app Fly no longer has has none. */
  async function releaseMachines(app: string): Promise<FlyMachine[]> {
    try {
      const machines = await clientFor(app).listMachines();
      return machines.filter((m) => m.metadata[HOSTING_RELEASE_METADATA.marker] === 'release');
    } catch (err) {
      if (err instanceof OrchestratorApiError && err.status === 404) return [];
      throw err;
    }
  }

  function handleOf(app: string, machine: FlyMachine): ReleaseHandle {
    return {
      target: 'fly',
      appRef: app,
      environment: environmentOf(machine.metadata[HOSTING_RELEASE_METADATA.environment]),
      releaseId: machine.metadata[HOSTING_RELEASE_METADATA.releaseId] ?? '',
      providerRef: machine.id,
    };
  }

  async function usageOf(
    handle: ReleaseHandle,
    machine: FlyMachine | null,
    since: Date | null,
  ): Promise<ReleaseUsage> {
    const until = now();
    const from = since ?? machine?.createdAt ?? until;
    return {
      target: 'fly',
      appRef: handle.appRef,
      releaseId: handle.releaseId,
      since: from,
      until,
      runningSeconds: machine ? runningSecondsBetween(runTransitionsOf(machine), from, until) : 0,
    };
  }

  return {
    target: 'fly',

    async ensureApp({ repositoryId, environment }) {
      const names = hostingAppNames(config.appPrefix, repositoryId, environment);
      await flyAppProvisioning.ensureApp(config, names.appRef);
      if (names.pushNamespace !== names.appRef) {
        await flyAppProvisioning.ensureApp(config, names.pushNamespace);
      }
      await flyAppProvisioning.ensureAddresses(config, names.appRef);
      return names;
    },

    async ensurePushNamespace({ repositoryId, kind }) {
      // An app with no Machines and no addresses: it holds images, nothing runs
      // in it, so nothing is reachable through it.
      const pushNamespace = pushNamespaceName(config.appPrefix, repositoryId, kind);
      await flyAppProvisioning.ensureApp(config, pushNamespace);
      return { pushNamespace, imageRepository: `${FLY_REGISTRY}/${pushNamespace}` };
    },

    async revokeDeployCredentials({ pushNamespace }) {
      const listed = await flyGraphqlRequest(APP_TOKENS_QUERY, { appName: pushNamespace }, token);
      const app = asRecord(listed.data?.['app']);
      if (!app) {
        if (listed.errors.length === 0 || listed.errors.every((e) => APP_NOT_FOUND.test(e))) {
          return { revoked: 0 };
        }
        throw new OrchestratorApiError('fly', 200, listed.errors.join('; '));
      }
      const nodes = asRecord(app['limitedAccessTokens'])?.['nodes'];
      const live = (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
        const entry = asRecord(node);
        const id = entry?.['id'];
        return typeof id === 'string' && !entry?.['revokedAt'] ? [id] : [];
      });
      for (const id of live) {
        const revoked = await flyGraphqlRequest(REVOKE_TOKEN_MUTATION, { input: { id } }, token);
        if (revoked.errors.length > 0) {
          throw new OrchestratorApiError('fly', 200, revoked.errors.join('; '));
        }
      }
      return { revoked: live.length };
    },

    async mintDeployCredential({ pushNamespace }): Promise<DeployCredential> {
      const res = await flyRequest(appPath(pushNamespace, '/deploy_token'), {
        method: 'POST',
        token,
        body: JSON.stringify({ expiry: DEPLOY_TOKEN_EXPIRY }),
      });
      const body = await readFlyJson(res);
      if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
      const value = asRecord(body)?.['token'];
      if (typeof value !== 'string' || value.length === 0) {
        throw new OrchestratorApiError('fly', res.status, 'deploy token response carried no token');
      }
      return {
        kind: 'secret',
        pushNamespace,
        value,
        expiresAt: new Date(now().getTime() + DEPLOY_TOKEN_TTL_MS),
      };
    },

    async deploy(input) {
      const current = await releaseMachine(input.appRef);
      const currentRaw = current ? await readMachine(input.appRef, current.id) : null;
      const releaseId = newReleaseId();
      const metadata: Record<string, string> = {
        [HOSTING_RELEASE_METADATA.marker]: 'release',
        [HOSTING_RELEASE_METADATA.releaseId]: releaseId,
        [HOSTING_RELEASE_METADATA.environment]: environmentLabel(input.environment),
      };
      const replaced = current?.metadata[HOSTING_RELEASE_METADATA.releaseId];
      if (replaced) metadata[HOSTING_RELEASE_METADATA.previousReleaseId] = replaced;
      const budget = budgetOf(FLY_DEPLOY_SETTLE_SECONDS);
      const written = await writeMachine(
        input.appRef,
        current ? { id: current.id, version: versionOf(currentRaw?.body) } : null,
        machineConfig(config, input, metadata),
        input.region ?? config.region,
        budget,
      );
      await settle(input.appRef, written, budget);
      const id = written.id;
      return {
        target: 'fly',
        appRef: input.appRef,
        environment: input.environment,
        releaseId,
        providerRef: id,
      };
    },

    async describe(handle): Promise<ReleaseDescription> {
      const read = await readMachine(handle.appRef, handle.providerRef);
      if (!read || read.machine.state === 'destroyed') {
        return {
          state: 'destroyed',
          releaseId: null,
          previousReleaseId: null,
          upstreamAddress: null,
          originCredential: 'none',
        };
      }
      const { machine, body } = read;
      return {
        state: releaseStateOf(machine.state, checkStatusesOf(body)),
        releaseId: machine.metadata[HOSTING_RELEASE_METADATA.releaseId] ?? null,
        previousReleaseId: machine.metadata[HOSTING_RELEASE_METADATA.previousReleaseId] ?? null,
        upstreamAddress: `https://${handle.appRef}.fly.dev`,
        // Every Fly release runs behind the guard (`machineConfig`).
        originCredential: 'origin_secret',
      };
    },

    async rollback({ appRef }) {
      const current = await releaseMachine(appRef);
      if (!current) throw new ReleaseNotFoundError(appRef);
      const previousId = current.metadata[HOSTING_RELEASE_METADATA.previousReleaseId];
      if (!previousId) throw new NoPreviousReleaseError(appRef);
      const res = await flyRequest(
        appPath(appRef, `/machines/${encodeURIComponent(current.id)}/versions`),
        {
          method: 'GET',
          token,
        },
      );
      const body = await readFlyJson(res);
      if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
      const kept = (Array.isArray(body) ? body : [])
        .map((v) => asRecord(asRecord(v)?.['user_config']))
        .find(
          (c) => asRecord(c?.['metadata'])?.[HOSTING_RELEASE_METADATA.releaseId] === previousId,
        );
      const keptApp = keptAppContainer(kept);
      if (!kept || !keptApp) throw new NoPreviousReleaseError(appRef);
      const currentId = current.metadata[HOSTING_RELEASE_METADATA.releaseId] ?? '';
      // The kept release's app, under TODAY's guard: its image and secret are
      // re-derived rather than restored, so a rotated key or a replaced guard
      // image is never rolled back with the release.
      const restored = {
        ...kept,
        containers: [guardContainer(config, appRef, keptApp.port), keptApp.container],
        metadata: {
          ...(asRecord(kept['metadata']) ?? {}),
          [HOSTING_RELEASE_METADATA.previousReleaseId]: currentId,
        },
      };
      const raw = await readMachine(appRef, current.id);
      const budget = budgetOf(FLY_ROLLBACK_SETTLE_SECONDS);
      const written = await writeMachine(
        appRef,
        { id: current.id, version: versionOf(raw?.body) },
        restored,
        current.region,
        budget,
      );
      await settle(appRef, written, budget);
      const id = written.id;
      return {
        target: 'fly',
        appRef,
        environment: environmentOf(current.metadata[HOSTING_RELEASE_METADATA.environment]),
        releaseId: previousId,
        providerRef: id,
      };
    },

    async usageSince(handle, since) {
      const read = await readMachine(handle.appRef, handle.providerRef);
      return usageOf(handle, read?.machine ?? null, since);
    },

    async destroy(handle) {
      const read = await readMachine(handle.appRef, handle.providerRef);
      const usage = await usageOf(handle, read?.machine ?? null, null);
      if (read) await clientFor(handle.appRef).destroyMachine(handle.providerRef);
      return usage;
    },

    async destroyApp({ appRef }) {
      // Settle the live release's usage BEFORE the app goes: deleting a Fly app
      // takes its Machines and their events with it.
      const live = (await releaseMachines(appRef)).filter((m) => m.state !== 'destroyed');
      const usage = await Promise.all(live.map((m) => usageOf(handleOf(appRef, m), m, null)));
      const res = await flyRequest(appPath(appRef), { method: 'DELETE', token });
      if (res.ok || res.status === 404) return usage;
      return refuse(res);
    },

    async listReleases({ appRef }): Promise<ReleaseSummary[]> {
      return (await releaseMachines(appRef)).map((m) => ({
        handle: handleOf(appRef, m),
        state: releaseStateOf(m.state, []),
      }));
    },

    // A one-off Machine of the release image (MOTIR-10030): no service, no guard,
    // never restarted, so it takes no traffic and runs the command once. It is
    // destroyed after its exit status is read — kept until then because a
    // destroyed Machine's events may already be gone.
    async runReleaseCommand({ appRef, artifact, command, env, timeoutSeconds }) {
      const created = await flyRequest(appPath(appRef, '/machines'), {
        method: 'POST',
        token,
        body: JSON.stringify({
          name: `command-${newReleaseId()}`,
          region: config.region,
          config: {
            image: imageOf({ artifact }),
            init: { exec: argvOf(command) },
            env: Object.fromEntries(env.map((v) => [v.name, v.value])),
            guest: PRODUCTION_GUEST.small,
            restart: { policy: 'no' },
            auto_destroy: false,
            metadata: { [HOSTING_RELEASE_METADATA.marker]: 'command' },
          },
        }),
      });
      const parsed = await readFlyJson(created);
      if (!created.ok) {
        throw new OrchestratorApiError('fly', created.status, flyErrorDetail(parsed));
      }
      const machine = toFlyMachine(parsed);
      if (!machine) {
        throw new OrchestratorApiError(
          'fly',
          created.status,
          'machine create returned an unexpected shape',
        );
      }
      const path = `/machines/${encodeURIComponent(machine.id)}`;
      try {
        const deadline = now().getTime() + timeoutSeconds * 1000;
        for (;;) {
          const remaining = Math.ceil((deadline - now().getTime()) / 1000);
          if (remaining <= 0)
            return { exitCode: null, timedOut: true } satisfies ReleaseCommandResult;
          const window = Math.min(COMMAND_WAIT_WINDOW_SECONDS, remaining);
          const waited = await flyRequest(
            appPath(appRef, `${path}/wait?state=stopped&timeout=${window}`),
            { method: 'GET', token, timeoutMs: (window + 10) * 1000 },
          );
          if (waited.ok) break;
          // 408: the window passed with the command still running.
          if (waited.status !== 408) {
            throw new OrchestratorApiError(
              'fly',
              waited.status,
              flyErrorDetail(await readFlyJson(waited)),
            );
          }
        }
        const read = await readMachine(appRef, machine.id);
        return { exitCode: read ? exitCodeOf(read.machine) : null, timedOut: false };
      } finally {
        await flyRequest(appPath(appRef, `${path}?force=true`), { method: 'DELETE', token });
      }
    },
  };
}
