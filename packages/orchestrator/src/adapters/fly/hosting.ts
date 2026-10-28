import { OrchestratorApiError, OrchestratorNotConfiguredError } from '../../errors';
import {
  NoPreviousReleaseError,
  ReleaseArtifactUnsupportedError,
  ReleaseNotFoundError,
  ReleaseRuntimeRefusedError,
} from '../../hosting/errors';
import { hostingAppNames } from '../../hosting/names';
import { deriveOriginSecret } from '../../hosting/originSecret';
import type {
  DeployCredential,
  DeployReleaseInput,
  HostingDeployPort,
  HostingEnvironment,
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
  flyErrorDetail,
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
}

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

function imageOf(input: DeployReleaseInput): string {
  const { artifact } = input;
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

  async function writeMachine(
    app: string,
    existing: { id: string; version: string | null } | null,
    body: Record<string, unknown>,
    region: string,
  ): Promise<string> {
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
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(parsed));
    const machine = toFlyMachine(parsed);
    if (!machine)
      throw new OrchestratorApiError(
        'fly',
        res.status,
        'machine write returned an unexpected shape',
      );
    return machine.id;
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
      const id = await writeMachine(
        input.appRef,
        current ? { id: current.id, version: versionOf(currentRaw?.body) } : null,
        machineConfig(config, input, metadata),
        input.region ?? config.region,
      );
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
      const id = await writeMachine(
        appRef,
        { id: current.id, version: versionOf(raw?.body) },
        restored,
        current.region,
      );
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
  };
}
