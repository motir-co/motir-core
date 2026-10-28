import { createHash } from 'node:crypto';
import {
  exitCodeOf,
  flyErrorDetail,
  flyRequest,
  isFlyImagePullRefusal,
  parseFlyDate,
  readFlyJson,
  toFlyMachine,
  type FlyMachine,
} from './flyMachines';
import {
  EXEC_RESPONSE_GRACE_SECONDS,
  OrchestratorApiError,
  OrchestratorImageUnpullableError,
  OrchestratorNotConfiguredError,
} from '../../errors';
import type {
  PersistentAppInventory,
  PersistentContainerHandle,
  PersistentContainerOrchestrator,
  PersistentContainerSpec,
  PersistentContainerState,
  PersistentContainerStatus,
  PersistentMachineEvent,
  PersistentExecResult,
  PersistentLivenessResult,
  PersistentPublicService,
  PersistentTerminalConfig,
  PersistentTerminalEndpoint,
} from '../../types';
import { livenessViaExec } from '../../persistentLiveness';

// The FLY adapter's PERSISTENT half (Story MOTIR-6860 · MOTIR-6869) — a user
// agent instance on Fly Machines, per `docs/decisions/agent-instances.md` §1–§3
// and §7. Still translation only: which instance to boot, when to hibernate it,
// and what a running interval costs all live above the port.
//
// ⚠️ IT NEVER READS `FLY_FLEET_*`. The fleet app is swept by the fleet reaper,
// which destroys every tagged machine older than its cutoff (§7, Context fact 1),
// and it would put a user's shell on the CI runners' private network. So the
// instance lane has its OWN configuration and its own token — a token for the
// fleet Fly ORGANISATION that may create apps — and there is no fallback to the
// fleet's. The CI fleet reaper never lists an instance app; the instance
// reconcile (`listPersistent`) is its equivalent.
//
// ⚠️ ONE APP PER MOTIR ORGANISATION, EACH ON ITS OWN PRIVATE NETWORK (§7).
// Machines in one Fly app share a 6PN, so one shared instances app would let a
// dev server one tenant binds to `0.0.0.0` answer every other tenant. The app is
// created lazily, on the organisation's first instance, with a custom `network`.
//
// ⚠️ NO `suspend` (§1, Rejected): Fly suspends only machines of ≤ 2 GB and the
// one priced agent machine is 8 GB, so hibernate is `stop` and every wake is a
// cold boot of the rootfs with the volume intact.

export interface FlyInstancesConfig {
  readonly token: string;
  readonly region: string;
  readonly appPrefix: string;
  /** The Fly organisation slug the instance apps are created in. */
  readonly org: string;
}

/**
 * The instance lane's configuration, or the typed not-configured error.
 *
 * `FLY_INSTANCES_REGION` defaults to `iad` and `FLY_INSTANCES_APP_PREFIX` to
 * `motir-inst` (§7). `FLY_INSTANCES_ORG` defaults to `motir-fleet` — the fleet
 * organisation §7 boots instances in (`code-graph-index-fleet.md` §3) — because
 * `POST /v1/apps` needs an organisation slug and the token alone does not name
 * one; it is a variable so a different deployment can point elsewhere.
 */
export function flyInstancesConfig(): FlyInstancesConfig {
  const token = process.env['FLY_INSTANCES_API_TOKEN'];
  if (!token) throw new OrchestratorNotConfiguredError('set FLY_INSTANCES_API_TOKEN');
  return {
    token,
    region: process.env['FLY_INSTANCES_REGION']?.trim() || 'iad',
    appPrefix: process.env['FLY_INSTANCES_APP_PREFIX']?.trim() || 'motir-inst',
    org: process.env['FLY_INSTANCES_ORG']?.trim() || 'motir-fleet',
  };
}

/** Is the instance lane wired on this deployment? Never throws. */
export function isFlyInstancesConfigured(): boolean {
  return Boolean(process.env['FLY_INSTANCES_API_TOKEN']);
}

/** Machine metadata naming the instance, so the reconcile can map a machine back to its record. */
export const INSTANCE_METADATA_KEY = 'motir_instance_id';

/**
 * Machine metadata carrying the version of the terminal machine config the
 * machine was last written with (`docs/decisions/agent-terminal.md` Q8). Absent
 * on a machine created before the terminal, which reads as version 0.
 */
export const MACHINE_CONFIG_METADATA_KEY = 'motir_machine_config';

/** Machine metadata carrying the non-secret id of the terminal key the machine holds. */
export const TERMINAL_KEY_ID_METADATA_KEY = 'motir_terminal_key_id';

/** The terminal server's path on the machine (`agent-terminal.md` Q4). */
const TERMINAL_PATH = '/v1/terminal';

/** The version a machine's metadata stamps, or 0 when it carries none (or garbage). */
export function machineConfigVersionOf(metadata: Readonly<Record<string, string>>): number {
  const raw = metadata[MACHINE_CONFIG_METADATA_KEY];
  if (raw === undefined || !/^\d+$/.test(raw)) return 0;
  return Number(raw);
}

/**
 * Is a machine stamped with `metadata` already on `terminal`? A NEWER stamp is
 * left alone (a rollback never rewrites a machine a later build configured); the
 * same version with another key id is not current — the master key was rotated.
 */
export function isMachineConfigCurrent(
  metadata: Readonly<Record<string, string>>,
  terminal: PersistentTerminalConfig,
): boolean {
  const stamped = machineConfigVersionOf(metadata);
  if (stamped !== terminal.version) return stamped > terminal.version;
  return metadata[TERMINAL_KEY_ID_METADATA_KEY] === terminal.keyId;
}

/**
 * The Q2 service in Fly's machine-config vocabulary (`fly.MachineService`,
 * Machines API OpenAPI, read 2026-09-29): `autostart: false` and
 * `autostop: "off"` so the Fly Proxy never wakes nor stops an agent — Motir does.
 */
export function toFlyService(service: PersistentPublicService): Record<string, unknown> {
  return {
    protocol: 'tcp',
    internal_port: service.internalPort,
    ports: service.ports.map((p) => ({ port: p.port, handlers: [...p.handlers] })),
    autostart: service.autostart,
    autostop: service.autostop,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(value) ?? {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * A machine's CURRENT config rewritten to `terminal` (Q8) — the main process, the
 * one public service, the key in the env and the version stamp. Every other field
 * — above all `image` (the pinned digest) and `mounts` (the home volume at
 * `/home/node`) — is carried over from the machine's own config untouched,
 * because Fly's update REPLACES the config: a field not re-sent is a field lost.
 */
export function withTerminalConfig(
  current: Record<string, unknown>,
  terminal: PersistentTerminalConfig,
): Record<string, unknown> {
  return {
    ...current,
    init: { ...(asRecord(current['init']) ?? {}), cmd: [...terminal.command] },
    services: [toFlyService(terminal.service)],
    env: { ...stringRecord(current['env']), ...terminal.env },
    metadata: {
      ...stringRecord(current['metadata']),
      [MACHINE_CONFIG_METADATA_KEY]: String(terminal.version),
      [TERMINAL_KEY_ID_METADATA_KEY]: terminal.keyId,
    },
  };
}

interface FlyIpAssignment {
  ip: string;
  egress: boolean;
  /** Set only on a Flycast (`private_v6`) address. */
  privateNetwork: boolean;
}

function toFlyIpAssignment(entry: unknown): FlyIpAssignment | null {
  const record = asRecord(entry);
  const ip = record?.['ip'];
  if (typeof ip !== 'string' || ip.length === 0) return null;
  return {
    ip,
    egress: record?.['egress'] === true,
    privateNetwork: asRecord(record?.['network']) !== null || /^fdaa:/i.test(ip),
  };
}

/** A public (ingress) IPv4 — shared or dedicated, either answers the relay. */
function isPublicV4(a: FlyIpAssignment): boolean {
  return !a.egress && !a.privateNetwork && !a.ip.includes(':');
}

/** A public (ingress) IPv6 — never a Flycast `fdaa:` address. */
function isPublicV6(a: FlyIpAssignment): boolean {
  return !a.egress && !a.privateNetwork && a.ip.includes(':');
}

/** The first 16 hex digits of a SHA-256 — a stable, collision-resistant label for a name. */
function digest16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** `<prefix>-<hash of the organisation id>` (§7) — the app AND its network name. */
export function instanceAppName(appPrefix: string, orgId: string): string {
  return `${appPrefix}-${digest16(orgId)}`;
}

/**
 * The home volume's name for one instance. Fly volume names are lower-case
 * letters, digits and underscores, at most 30 characters, so the id is hashed
 * rather than embedded — and the reconcile can recompute it from a record.
 */
export function instanceVolumeName(instanceId: string): string {
  return `home_${digest16(instanceId)}`;
}

/** The machine's name — unique within the app because the instance id is. */
export function instanceMachineName(instanceId: string): string {
  return `instance-${instanceId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 63);
}

/** Fly's machine state → the instance vocabulary (§1). `stopped` is NOT terminal. */
export function toPersistentState(flyState: string): PersistentContainerState {
  switch (flyState) {
    case 'created':
    case 'starting':
    case 'replacing':
      return 'starting';
    case 'started':
      return 'running';
    case 'stopping':
    case 'suspending':
      return 'stopping';
    case 'stopped':
    case 'suspended':
      return 'stopped';
    case 'destroying':
    case 'destroyed':
      return 'gone';
    case 'failed':
      return 'failed';
    default:
      // An unrecognised state is treated as still in motion: the sweep asks
      // again in five minutes, where "failed" would act on a guess.
      return 'starting';
  }
}

/**
 * The start and stop instants of the CURRENT run: the latest `start` event, and
 * the latest `stop` / `exit` / `destroy` event at or after it. Never the first
 * start — that would measure an interval across the hibernated hours (§5,
 * Context fact 3).
 */
export function currentRunInstants(machine: FlyMachine): {
  startedAt: Date | null;
  stoppedAt: Date | null;
} {
  let startedAt: Date | null = null;
  for (const event of machine.events) {
    if (event.type !== 'start' || !event.timestamp) continue;
    if (!startedAt || event.timestamp.getTime() > startedAt.getTime()) startedAt = event.timestamp;
  }
  let stoppedAt: Date | null = null;
  for (const event of machine.events) {
    if (event.type !== 'stop' && event.type !== 'exit' && event.type !== 'destroy') continue;
    if (!event.timestamp) continue;
    if (startedAt && event.timestamp.getTime() < startedAt.getTime()) continue;
    if (!stoppedAt || event.timestamp.getTime() > stoppedAt.getTime()) stoppedAt = event.timestamp;
  }
  return { startedAt, stoppedAt };
}

/**
 * The machine's own lifecycle events, oldest first (MOTIR-7396). Pure: an event
 * without a timestamp cannot be placed on a timeline and is skipped; an
 * unrecognised type passes through as its own string. The sort is stable.
 */
export function toPersistentEvents(machine: FlyMachine): PersistentMachineEvent[] {
  const out: PersistentMachineEvent[] = [];
  for (const event of machine.events) {
    if (!event.timestamp) continue;
    out.push({
      type: event.type,
      status: event.status,
      at: event.timestamp,
      ...(event.exitCode !== null ? { exitCode: event.exitCode } : {}),
    });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** How long `destroyPersistent` waits for a destroyed machine to release its volume. */
export const VOLUME_RELEASE_ATTEMPTS = 10;
export const VOLUME_RELEASE_INTERVAL_MS = 1000;

/** The pause between release polls — a module seam so a test need not wait real seconds. */
export const persistentTiming = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

function path(app: string, rest = ''): string {
  return `/apps/${encodeURIComponent(app)}${rest}`;
}

async function fail(res: Response): Promise<never> {
  throw new OrchestratorApiError('fly', res.status, flyErrorDetail(await readFlyJson(res)));
}

interface FlyVolume {
  id: string;
  name: string;
  attachedMachineId: string | null;
  createdAt: Date | null;
}

function toFlyVolume(body: unknown): FlyVolume | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const attached = record['attached_machine_id'];
  return {
    id,
    name: typeof record['name'] === 'string' ? record['name'] : '',
    attachedMachineId: typeof attached === 'string' && attached.length > 0 ? attached : null,
    createdAt: parseFlyDate(record['created_at']),
  };
}

/** The instance app's Machines-API calls, with the INSTANCE token. */
const flyInstancesClient = {
  /** Create the organisation's app with its own network, unless it exists. */
  async ensureApp(config: Pick<FlyInstancesConfig, 'token' | 'org'>, app: string): Promise<void> {
    const existing = await flyRequest(path(app), { method: 'GET', token: config.token });
    if (existing.ok) return;
    if (existing.status !== 404) await fail(existing);
    const res = await flyRequest('/apps', {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({ app_name: app, org_slug: config.org, network: app }),
    });
    // A concurrent first instance of the same organisation may have created it
    // between the read and the write; "already exists" is the end state wanted.
    if (res.ok || res.status === 409) return;
    const body = await readFlyJson(res);
    if (res.status === 422 && /already/i.test(flyErrorDetail(body))) return;
    throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
  },

  /**
   * Give the app the public addresses the relay dials (`agent-terminal.md` Q2):
   * a shared IPv4 and an IPv6, each allocated only when the app has none, so a
   * second ensure allocates nothing.
   *
   * The door is the Machines REST API's IP assignments — `GET` and `POST
   * /v1/apps/{app_name}/ip_assignments`, the POST taking `{ "type": "shared_v4" |
   * "v6" | … }` (Fly, _List IP assignments for app_ and _Assign new IP address to
   * app_, https://docs.fly.io/api/machines/apps/list-ip-assignments-for-app and
   * …/assign-new-ip-address-to-app, from the Machines API OpenAPI
   * https://docs.fly.io/api/machines/openapi.json, read 2026-09-29). The older
   * _Apps resource_ page still says IPs need flyctl or GraphQL
   * (`allocateIpAddress`); the OpenAPI is the newer source, and it keeps this
   * adapter on one API and one token.
   */
  async ensureAddresses(config: Pick<FlyInstancesConfig, 'token'>, app: string): Promise<void> {
    const res = await flyRequest(path(app, '/ip_assignments'), {
      method: 'GET',
      token: config.token,
    });
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    const ips = asRecord(body)?.['ips'];
    const assigned = (Array.isArray(ips) ? ips : []).flatMap((entry) => {
      const parsed = toFlyIpAssignment(entry);
      return parsed ? [parsed] : [];
    });
    const wanted: Array<'shared_v4' | 'v6'> = [];
    if (!assigned.some(isPublicV4)) wanted.push('shared_v4');
    if (!assigned.some(isPublicV6)) wanted.push('v6');
    for (const type of wanted) {
      const created = await flyRequest(path(app, '/ip_assignments'), {
        method: 'POST',
        token: config.token,
        body: JSON.stringify({ type }),
      });
      if (!created.ok) await fail(created);
    }
  },

  async createVolume(
    config: FlyInstancesConfig,
    app: string,
    input: { name: string; region: string; sizeGb: number },
  ): Promise<FlyVolume> {
    const res = await flyRequest(path(app, '/volumes'), {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({ name: input.name, region: input.region, size_gb: input.sizeGb }),
    });
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    const volume = toFlyVolume(body);
    if (!volume)
      throw new OrchestratorApiError(
        'fly',
        res.status,
        'volume create returned an unexpected shape',
      );
    return volume;
  },

  async createMachine(
    config: FlyInstancesConfig,
    app: string,
    spec: PersistentContainerSpec,
    volumeId: string,
  ): Promise<FlyMachine> {
    const res = await flyRequest(path(app, '/machines'), {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({
        name: instanceMachineName(spec.instanceId),
        region: spec.region,
        config: {
          image: spec.image,
          guest: {
            cpu_kind: spec.size.cpuKind,
            cpus: spec.size.cpus,
            memory_mb: spec.size.memoryMb,
          },
          env: { ...spec.env, ...(spec.terminal?.env ?? {}) },
          metadata: {
            [INSTANCE_METADATA_KEY]: spec.instanceId,
            motir_org_id: spec.orgId,
            motir_workspace_id: spec.workspaceId,
            motir_project_id: spec.projectId,
            ...(spec.terminal
              ? {
                  [MACHINE_CONFIG_METADATA_KEY]: String(spec.terminal.version),
                  [TERMINAL_KEY_ID_METADATA_KEY]: spec.terminal.keyId,
                }
              : {}),
          },
          mounts: [{ volume: volumeId, path: spec.mountPath }],
          // agent-terminal.md Q4 + Q2: the terminal server is the MAIN process
          // (the argv replaces the image's CMD under its unchanged ENTRYPOINT),
          // behind the one public service the relay dials. Without a terminal
          // config there is no service, and the main process is the spec's idle
          // command (MOTIR-7336): the image's own CMD is an interactive shell
          // that exits 0 at once with no TTY, which Fly's `on-failure` policy
          // does not restart, so the machine would stop seconds after it starts.
          ...(spec.terminal
            ? {
                init: { cmd: [...spec.terminal.command] },
                services: [toFlyService(spec.terminal.service)],
              }
            : spec.idleCommand
              ? { init: { cmd: [...spec.idleCommand] } }
              : {}),
          // §1: the machine OUTLIVES its process. A crashed main process is
          // restarted by Fly; an explicit stop through the API is not a failure,
          // so a hibernated instance stays stopped.
          auto_destroy: false,
          restart: { policy: 'on-failure' },
        },
      }),
    });
    const body = await readFlyJson(res);
    if (!res.ok) {
      const detail = flyErrorDetail(body);
      if (isFlyImagePullRefusal(detail)) {
        throw new OrchestratorImageUnpullableError('fly', res.status, spec.image, detail);
      }
      throw new OrchestratorApiError('fly', res.status, detail);
    }
    const machine = toFlyMachine(body);
    if (!machine)
      throw new OrchestratorApiError(
        'fly',
        res.status,
        'machine create returned an unexpected shape',
      );
    return machine;
  },

  async getMachine(
    config: FlyInstancesConfig,
    app: string,
    id: string,
  ): Promise<FlyMachine | null> {
    const res = await flyRequest(path(app, `/machines/${encodeURIComponent(id)}`), {
      method: 'GET',
      token: config.token,
    });
    if (res.status === 404) return null;
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    return toFlyMachine(body);
  },

  /** The machine's raw JSON — its FULL config, which an update must re-send. Null when gone. */
  async getMachineRaw(
    config: FlyInstancesConfig,
    app: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const res = await flyRequest(path(app, `/machines/${encodeURIComponent(id)}`), {
      method: 'GET',
      token: config.token,
    });
    if (res.status === 404) return null;
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    return asRecord(body);
  },

  /**
   * `POST /v1/apps/{app}/machines/{id}` — Fly's machine update, with the FULL
   * config, and — by default — `skip_launch: true` so a stopped machine STAYS
   * stopped: the wake starts it afterwards, through the one start door. Without
   * it a RUNNING machine reboots onto the new config (_"If the Machine is running
   * and the request is successful, it will reboot"_, Fly, _Machines resource_,
   * read 2026-10-01 — the image update's running case, MOTIR-6950) (Fly, _Update Machine_,
   * https://docs.fly.io/api/machines/machines/update-machine, read 2026-09-29).
   * `current_version` guards against a concurrent change: a machine changed since
   * the read answers 409 and nothing is written.
   */
  async updateMachine(
    config: FlyInstancesConfig,
    app: string,
    id: string,
    machineConfig: Record<string, unknown>,
    currentVersion: string | null,
    options: { skipLaunch: boolean } = { skipLaunch: true },
  ): Promise<void> {
    const res = await flyRequest(path(app, `/machines/${encodeURIComponent(id)}`), {
      method: 'POST',
      token: config.token,
      body: JSON.stringify({
        config: machineConfig,
        ...(options.skipLaunch ? { skip_launch: true } : {}),
        ...(currentVersion ? { current_version: currentVersion } : {}),
      }),
    });
    if (!res.ok) await fail(res);
  },

  async machineAction(
    config: FlyInstancesConfig,
    app: string,
    id: string,
    action: 'stop' | 'start',
  ): Promise<Response> {
    return flyRequest(path(app, `/machines/${encodeURIComponent(id)}/${action}`), {
      method: 'POST',
      token: config.token,
    });
  },

  async exec(
    config: FlyInstancesConfig,
    app: string,
    id: string,
    command: readonly string[],
    timeoutSeconds: number,
    stdin?: string,
  ): Promise<PersistentExecResult> {
    const res = await flyRequest(path(app, `/machines/${encodeURIComponent(id)}/exec`), {
      method: 'POST',
      token: config.token,
      // Exec is SYNCHRONOUS — Fly answers when the command exits — so the
      // request has to stay open as long as the command may run, not the 30 s
      // every other call gets (MOTIR-7405: a 600 s clone was cut off at 30 s).
      timeoutMs: (timeoutSeconds + EXEC_RESPONSE_GRACE_SECONDS) * 1000,
      // The argv goes in `command`. `cmd` is the Machines API's legacy STRING
      // field: an array there is refused 400 "body is missing command: json:
      // cannot unmarshal array into … machineExecRequestRaw.cmd of type string"
      // (MOTIR-7347). It is not `init.cmd` on a machine config, which IS an
      // array. The API takes NO stdin: a `stdin` field is accepted and never
      // delivered (the command reads zero bytes — MOTIR-8872), so a caller's
      // `stdin` is piped in by a wrapper instead. Its value rides in the wrapper's
      // argv for the life of the one exec — as the clone's token already does —
      // and in no environment variable.
      body: JSON.stringify({
        command: stdin !== undefined ? withStdin(command, stdin) : [...command],
        timeout: timeoutSeconds,
      }),
    });
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    return {
      exitCode: typeof record['exit_code'] === 'number' ? record['exit_code'] : -1,
      stdout: typeof record['stdout'] === 'string' ? record['stdout'] : '',
      stderr: typeof record['stderr'] === 'string' ? record['stderr'] : '',
    };
  },

  async destroyMachine(config: FlyInstancesConfig, app: string, id: string): Promise<void> {
    const res = await flyRequest(path(app, `/machines/${encodeURIComponent(id)}?force=true`), {
      method: 'DELETE',
      token: config.token,
    });
    if (res.ok || res.status === 404) return;
    await fail(res);
  },

  async destroyVolume(config: FlyInstancesConfig, app: string, id: string): Promise<void> {
    const res = await flyRequest(path(app, `/volumes/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      token: config.token,
    });
    if (res.ok || res.status === 404) return;
    await fail(res);
  },

  async list<T>(
    config: FlyInstancesConfig,
    app: string,
    resource: 'machines' | 'volumes',
    parse: (entry: unknown) => T | null,
  ): Promise<T[] | null> {
    const res = await flyRequest(path(app, `/${resource}`), { method: 'GET', token: config.token });
    if (res.status === 404) return null;
    const body = await readFlyJson(res);
    if (!res.ok) throw new OrchestratorApiError('fly', res.status, flyErrorDetail(body));
    return (Array.isArray(body) ? body : []).flatMap((entry) => {
      const parsed = parse(entry);
      return parsed ? [parsed] : [];
    });
  },
};

/**
 * Creating a Fly app on its own network, and giving it public addresses — shared
 * with the HOSTING deploy port (MOTIR-5773), which creates one app per hosted
 * (repository, environment) in its own organisation with its own token. One copy
 * of each call, so the two lanes cannot drift on what "already exists" means.
 */
export const flyAppProvisioning = {
  ensureApp: flyInstancesClient.ensureApp,
  ensureAddresses: flyInstancesClient.ensureAddresses,
};

/**
 * Ask Fly for an action, and treat a refusal as success when the machine is
 * ALREADY where the action would have put it — a stop of a stopped machine, a
 * start of a started one. The refusal's wording is not a contract, so the answer
 * is read from the machine's own state rather than from the error text.
 */
async function actIdempotently(
  config: FlyInstancesConfig,
  handle: PersistentContainerHandle,
  action: 'stop' | 'start',
  settled: readonly PersistentContainerState[],
): Promise<void> {
  const res = await flyInstancesClient.machineAction(config, handle.app, handle.machineId, action);
  if (res.ok) return;
  const detail = flyErrorDetail(await readFlyJson(res));
  const machine = await flyInstancesClient.getMachine(config, handle.app, handle.machineId);
  const state: PersistentContainerState = machine ? toPersistentState(machine.state) : 'gone';
  if (settled.includes(state)) return;
  throw new OrchestratorApiError('fly', res.status, detail);
}

/**
 * `command` with `stdin` fed to its standard input: `printf %s "$1" | exec "$@"`
 * under a root `sh`, the payload a positional so no quoting can reach the shell.
 * The Machines exec API silently drops a `stdin` field (MOTIR-8872).
 */
function withStdin(command: readonly string[], stdin: string): string[] {
  return ['sh', '-c', 'p=$1; shift; printf %s "$p" | exec "$@"', 'sh', stdin, ...command];
}

export const flyPersistentOrchestrator: PersistentContainerOrchestrator = {
  provider: 'fly',

  appNameFor(orgId: string): string {
    return instanceAppName(flyInstancesConfig().appPrefix, orgId);
  },

  defaultRegion(): string {
    return flyInstancesConfig().region;
  },

  async provisionPersistent(spec: PersistentContainerSpec): Promise<PersistentContainerHandle> {
    const config = flyInstancesConfig();
    const app = instanceAppName(config.appPrefix, spec.orgId);
    const region = spec.region || config.region;
    await flyInstancesClient.ensureApp(config, app);
    // Only a machine with a public service needs the app's public addresses.
    if (spec.terminal) await flyInstancesClient.ensureAddresses(config, app);
    const volume = await flyInstancesClient.createVolume(config, app, {
      name: instanceVolumeName(spec.instanceId),
      region,
      sizeGb: spec.volumeSizeGb,
    });
    let machine: FlyMachine;
    try {
      machine = await flyInstancesClient.createMachine(config, app, { ...spec, region }, volume.id);
    } catch (err) {
      // Never leave an untracked volume: the caller never receives its id, so
      // nothing else would ever destroy it.
      try {
        await flyInstancesClient.destroyVolume(config, app, volume.id);
      } catch (cleanup) {
        console.error(
          '[flyPersistentOrchestrator] could not destroy the volume of a failed provision',
          {
            app,
            volumeId: volume.id,
            detail: cleanup instanceof Error ? cleanup.message : 'unknown',
          },
        );
      }
      throw err;
    }
    return {
      provider: 'fly',
      app,
      machineId: machine.id,
      volumeId: volume.id,
      region: machine.region || region,
      createdAt: machine.createdAt ?? new Date(),
    };
  },

  async stop(handle: PersistentContainerHandle): Promise<void> {
    await actIdempotently(flyInstancesConfig(), handle, 'stop', ['stopping', 'stopped']);
  },

  async start(handle: PersistentContainerHandle): Promise<void> {
    await actIdempotently(flyInstancesConfig(), handle, 'start', ['starting', 'running']);
  },

  async describePersistent(handle: PersistentContainerHandle): Promise<PersistentContainerStatus> {
    const config = flyInstancesConfig();
    const machine = await flyInstancesClient.getMachine(config, handle.app, handle.machineId);
    if (!machine) {
      return {
        machineId: handle.machineId,
        state: 'gone',
        providerState: '',
        startedAt: null,
        stoppedAt: null,
        events: [],
      };
    }
    const instants = currentRunInstants(machine);
    return {
      machineId: handle.machineId,
      state: toPersistentState(machine.state),
      providerState: machine.state,
      startedAt: instants.startedAt,
      stoppedAt: instants.stoppedAt,
      // Only an exit of the CURRENT run says anything about it (MOTIR-7336).
      exitCode: instants.stoppedAt ? exitCodeOf(machine) : null,
      events: toPersistentEvents(machine),
      image: machine.image ?? null,
    };
  },

  async destroyPersistent(handle: PersistentContainerHandle): Promise<void> {
    const config = flyInstancesConfig();
    await flyInstancesClient.destroyMachine(config, handle.app, handle.machineId);
    // NEVER the volume while the machine exists: a destroyed machine releases its
    // volume asynchronously, so wait for Fly to report the machine gone first.
    for (let attempt = 0; attempt < VOLUME_RELEASE_ATTEMPTS; attempt += 1) {
      const machine = await flyInstancesClient.getMachine(config, handle.app, handle.machineId);
      if (!machine || toPersistentState(machine.state) === 'gone') {
        await flyInstancesClient.destroyVolume(config, handle.app, handle.volumeId);
        return;
      }
      await persistentTiming.sleep(VOLUME_RELEASE_INTERVAL_MS);
    }
    // The volume is left for the next sweep's reconcile, which destroys a volume
    // no live record owns. Throwing tells the caller the delete is not finished.
    throw new OrchestratorApiError(
      'fly',
      null,
      `machine ${handle.machineId} did not release volume ${handle.volumeId} in time`,
    );
  },

  async listPersistent(app: string): Promise<PersistentAppInventory> {
    const config = flyInstancesConfig();
    const machines = await flyInstancesClient.list(config, app, 'machines', toFlyMachine);
    if (machines === null) return { app, machines: [], volumes: [] };
    const volumes = (await flyInstancesClient.list(config, app, 'volumes', toFlyVolume)) ?? [];
    return {
      app,
      machines: machines.map((m) => ({
        machineId: m.id,
        state: toPersistentState(m.state),
        instanceId: m.metadata[INSTANCE_METADATA_KEY] ?? null,
        createdAt: m.createdAt,
      })),
      volumes: volumes.map((v) => ({
        volumeId: v.id,
        name: v.name,
        attachedMachineId: v.attachedMachineId,
        createdAt: v.createdAt,
      })),
    };
  },

  async destroyVolume(app: string, volumeId: string): Promise<void> {
    await flyInstancesClient.destroyVolume(flyInstancesConfig(), app, volumeId);
  },

  async destroyMachine(app: string, machineId: string): Promise<void> {
    await flyInstancesClient.destroyMachine(flyInstancesConfig(), app, machineId);
  },

  async exec(
    handle: PersistentContainerHandle,
    command: readonly string[],
    options: { timeoutSeconds?: number; stdin?: string } = {},
  ): Promise<PersistentExecResult> {
    return flyInstancesClient.exec(
      flyInstancesConfig(),
      handle.app,
      handle.machineId,
      command,
      options.timeoutSeconds ?? 120,
      options.stdin,
    );
  },

  async ensureMachineConfig(
    handle: PersistentContainerHandle,
    terminal: PersistentTerminalConfig,
  ): Promise<'updated' | 'current'> {
    const config = flyInstancesConfig();
    const raw = await flyInstancesClient.getMachineRaw(config, handle.app, handle.machineId);
    if (!raw) {
      throw new OrchestratorApiError('fly', 404, `machine ${handle.machineId} is gone`);
    }
    const current = asRecord(raw['config']) ?? {};
    if (isMachineConfigCurrent(stringRecord(current['metadata']), terminal)) return 'current';
    // An app made before the terminal has no public address yet.
    await flyInstancesClient.ensureAddresses(config, handle.app);
    const version = raw['version'] ?? raw['instance_id'];
    await flyInstancesClient.updateMachine(
      config,
      handle.app,
      handle.machineId,
      withTerminalConfig(current, terminal),
      typeof version === 'string' && version.length > 0 ? version : null,
    );
    return 'updated';
  },

  async moveImage(
    handle: PersistentContainerHandle,
    image: string,
    options: { launch: boolean },
  ): Promise<void> {
    // agent-image-update.md Q2: Fly's machine update on the SAME machine and
    // volume — a read of the FULL current config with ONLY `image` replaced, so a
    // field Motir does not model is never dropped. Fly cannot change a volume
    // attachment through an update anyway (_Machines resource_, read 2026-10-01).
    const config = flyInstancesConfig();
    const raw = await flyInstancesClient.getMachineRaw(config, handle.app, handle.machineId);
    if (!raw) {
      throw new OrchestratorApiError('fly', 404, `machine ${handle.machineId} is gone`);
    }
    const current = asRecord(raw['config']) ?? {};
    const next: Record<string, unknown> = { ...current, image };
    // The adapter refuses its own mistake rather than detach a home: the mounts it
    // sends are the mounts it read, or nothing is sent at all.
    if (JSON.stringify(next['mounts'] ?? null) !== JSON.stringify(current['mounts'] ?? null)) {
      throw new OrchestratorApiError('fly', null, 'the image move would change the mounts');
    }
    const version = raw['version'] ?? raw['instance_id'];
    await flyInstancesClient.updateMachine(
      config,
      handle.app,
      handle.machineId,
      next,
      typeof version === 'string' && version.length > 0 ? version : null,
      { skipLaunch: !options.launch },
    );
  },

  async checkLiveness(
    handle: PersistentContainerHandle,
    command: readonly string[],
    options: { timeoutSeconds?: number } = {},
  ): Promise<PersistentLivenessResult> {
    return livenessViaExec(
      (h, cmd, opts) => this.exec(h, cmd, opts),
      handle,
      command,
      options.timeoutSeconds,
    );
  },

  terminalEndpoint(handle: PersistentContainerHandle): PersistentTerminalEndpoint {
    // agent-terminal.md Q2: the org app's public service, pinned to the one
    // machine by `fly-force-instance-id` — a header only the relay can set.
    return {
      url: `wss://${handle.app}.fly.dev${TERMINAL_PATH}`,
      headers: { 'fly-force-instance-id': handle.machineId },
    };
  },
};
