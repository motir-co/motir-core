import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EXEC_RESPONSE_GRACE_SECONDS, OrchestratorApiError } from '../../errors';
import type {
  PersistentAppInventory,
  PersistentContainerHandle,
  PersistentContainerOrchestrator,
  PersistentContainerSpec,
  PersistentContainerState,
  PersistentContainerStatus,
  PersistentExecResult,
  PersistentLivenessResult,
  PersistentMachineEvent,
  PersistentTerminalConfig,
  PersistentTerminalEndpoint,
} from '../../types';
import { livenessViaExec } from '../../persistentLiveness';

// The FAKE adapter's PERSISTENT half (Story MOTIR-6860 · MOTIR-6869) — the
// second implementation of the persistent port, shipped beside the Fly one for
// the reason `./index.ts` gives: a port with one implementation has never been
// shown to be a port. The lifecycle service's tests, the story's seam gate and
// its E2E drive it; none of them can boot a real machine.
//
// It models exactly what the decision relies on (§1, §2): a machine that STOPS
// rather than disappears, a volume that survives the machine, every start a new
// run with its own start instant, and a destroy that takes the machine and then
// the volume. Its controls reach the cases a test must be able to arrange: a
// provider refusal, a start that fails (no capacity on the volume's host), a
// machine destroyed OUTSIDE Motir, a machine stopped behind Motir's back, and a
// clock.
//
// ⚠️ A MODULE SINGLETON, with an OPT-IN file-backed store — the same
// cross-process seam `./index.ts` documents (MOTIR-3828) and for the same
// reason: the E2E lane's web server provisions and its worker sweeps, so the
// two processes must see one fleet. Absent the variable it is an in-memory map.

interface FakeMachineEvent {
  type: string;
  status: string;
  at: string;
  exitCode?: number;
}

function recordEvent(
  machine: FakePersistentMachine,
  type: string,
  status: string,
  at: string,
  exitCode?: number,
): void {
  (machine.events ??= []).push({
    type,
    status,
    at,
    ...(exitCode === undefined ? {} : { exitCode }),
  });
}

interface FakePersistentMachine {
  handle: PersistentContainerHandle;
  spec: PersistentContainerSpec;
  state: PersistentContainerState;
  startedAt: string | null;
  stoppedAt: string | null;
  /** The main process's exit code when it exited on its own (MOTIR-7336); null otherwise. */
  exitCode?: number | null;
  /** The machine's own timeline, oldest first (MOTIR-7396). Absent in an older store file. */
  events?: FakeMachineEvent[];
  starts: number;
  /** The terminal machine-config version the machine was last written with; 0 = none (Q8). */
  configVersion: number;
  /** The key id stamped beside it. */
  keyId?: string | null;
  /** Created by hand outside Motir, with no instance metadata (the reconcile's untracked machine). */
  untracked?: boolean;
}

interface FakeStore {
  apps: string[];
  machines: Record<string, FakePersistentMachine>;
  volumes: Record<
    string,
    {
      app: string;
      name: string;
      attachedMachineId: string | null;
      createdAt: string;
      /** Files a test wrote into the home this volume holds (MOTIR-6954) — path → content. */
      files?: Record<string, string>;
    }
  >;
  sequence: number;
  /**
   * Images whose liveness check fails (MOTIR-6950): the seam a test, the story's
   * integration gate and its E2E drive a rollback through, with no Fly. Kept in
   * the store so the E2E lane's web server and worker see the same answer.
   */
  failingImages?: string[];
}

export interface FakePersistentControls {
  /** Forget every app, machine and volume and every arranged failure. */
  reset(): void;
  /** Make the next `provisionPersistent` throw BEFORE anything is created. */
  failNextProvision(detail?: string): void;
  /** Make the next `provisionPersistent` create the volume and then fail the MACHINE create. */
  failNextMachineCreate(detail?: string): void;
  /** Make the next `start` throw — the volume's host has no capacity. */
  failNextStart(detail?: string): void;
  /** Make the next `stop` throw. */
  failNextStop(detail?: string): void;
  /** Make the next `destroyPersistent` throw. */
  failNextDestroy(detail?: string): void;
  /** The next image move is refused, as Fly refuses an update (MOTIR-6950). */
  failNextMove(detail?: string): void;
  /** New machines boot `running` (default) or stay `starting` until {@link completeBoot}. */
  setBootBehaviour(behaviour: 'start' | 'never_start'): void;
  /** Move a `starting` machine to `running`, stamping its run's start. */
  completeBoot(machineId: string): void;
  /** The machine vanished outside Motir (destroyed in the console, host lost). Its volume stays. */
  destroyOutside(machineId: string): void;
  /**
   * A machine created BY HAND in `app`, outside Motir: running, with no volume and
   * no instance metadata, so `listPersistent` reports it with `instanceId: null`
   * (MOTIR-9467 — the reconcile's untracked machine). Answers its id.
   */
  createOutside(app: string): string;
  /** The machine stopped behind Motir's back (a crash with no restart, an operator). */
  stopOutside(machineId: string): void;
  /**
   * The machine's main process EXITED on its own with `exitCode` (MOTIR-7336: the
   * image's shell exiting at once with no TTY) — the machine is `stopped`, its run
   * started and stopped now unless it had already started.
   */
  exitOutside(machineId: string, exitCode: number): void;
  /** Move the current run's start earlier, so a charge covers measurable seconds. */
  backdateRun(machineId: string, startedAt: Date): void;
  /** The clock every instant is read from. */
  setNow(now: () => Date): void;
  /** Machines that still exist, stopped or not. */
  liveMachineIds(): string[];
  /** Volumes that still exist. */
  liveVolumeIds(): string[];
  /** Apps created so far — one per organisation. */
  appNames(): string[];
  /** Every spec `provisionPersistent` was asked for, in order. */
  readonly persistentSpecs: PersistentContainerSpec[];
  /** Every operation, in order — how a test asserts the SEQUENCE (machine before volume). */
  readonly operations: string[];
  /** Every `exec` command, in order, with the machine it ran on and its stdin (if any). */
  readonly execs: Array<{ machineId: string; command: string[]; stdin?: string }>;
  /** What the next `exec` returns (default: exit 0, empty output). */
  setNextExecResult(result: PersistentExecResult): void;
  /**
   * Answer every `exec` by its command (MOTIR-7026: a boot runs several probes
   * and a start runs its launcher, each wanting its own answer). A one-shot
   * {@link setNextExecResult} still wins for the next call; `null` removes it.
   */
  setExecResponder(
    responder:
      | ((command: readonly string[], stdin: string | undefined) => PersistentExecResult)
      | null,
  ): void;
  /**
   * The base address (`ws://host:port`) every agent's terminal resolves to — a
   * terminal server the test or the E2E lane started locally. Null restores the
   * default: `MOTIR_FAKE_TERMINAL_URL`, else `ws://127.0.0.1:7681`.
   */
  setTerminalAddress(base: string | null): void;
  /** The machine's stamped terminal config version (0 when it carries none). */
  machineConfigVersion(machineId: string): number;
  /** The image a machine's config names now (MOTIR-6950). */
  machineImage(machineId: string): string;
  /** Make every liveness check on a machine running `image` answer not alive (exit 127). */
  markImageFailing(image: string): void;
  /** Write a file into the home a volume holds (MOTIR-6954: it must survive an image update). */
  writeHomeFile(volumeId: string, path: string, content: string): void;
  /** Read a file from the home a volume holds; null when the volume or the file is gone. */
  readHomeFile(volumeId: string, path: string): string | null;
}

const STATE_PATH_ENV = 'MOTIR_FAKE_PERSISTENT_STATE_PATH';
/**
 * THE EXEC BRIDGE (Story MOTIR-6864 · MOTIR-7031): an HTTP endpoint that runs an
 * `exec` on the machine's stand-in and answers its result. When it is set, an
 * `exec` nothing scripted is POSTed there as `{machineId, command, stdin?,
 * timeoutSeconds?}` and answered `{exitCode, stdout, stderr}` — which is how the
 * E2E lane's web server and job worker reach the terminal host the lane runs per
 * fake machine (`tests/e2e/_helpers/agent-terminal/host.ts`), so the launcher,
 * the sign-in query and the stop are the real commands. A scripted answer
 * ({@link FakePersistentControls.setNextExecResult} / `setExecResponder`) still
 * wins; absent both, an exec answers exit 0 with nothing, as before.
 */
const EXEC_URL_ENV = 'MOTIR_FAKE_EXEC_URL';
/** Where agents' terminals resolve, across processes (the E2E web server and its relay). */
const TERMINAL_URL_ENV = 'MOTIR_FAKE_TERMINAL_URL';
const DEFAULT_TERMINAL_BASE = 'ws://127.0.0.1:7681';

let store: FakeStore = { apps: [], machines: {}, volumes: {}, sequence: 0 };
const persistentSpecs: PersistentContainerSpec[] = [];
const operations: string[] = [];
const execs: Array<{ machineId: string; command: string[]; stdin?: string }> = [];
let nextExec: PersistentExecResult | null = null;
let execResponder:
  | ((command: readonly string[], stdin: string | undefined) => PersistentExecResult)
  | null = null;
type FailureKind = 'provision' | 'machine' | 'start' | 'stop' | 'destroy' | 'move';
const failures: Record<FailureKind, string | null> = {
  provision: null,
  machine: null,
  start: null,
  stop: null,
  destroy: null,
  move: null,
};
let bootBehaviour: 'start' | 'never_start' = 'start';
let terminalBase: string | null = null;
let now: () => Date = () => new Date();

function statePath(): string | null {
  const raw = process.env[STATE_PATH_ENV];
  return raw !== undefined && raw !== '' ? raw : null;
}

function load(): void {
  const path = statePath();
  if (!path || !existsSync(path)) return;
  try {
    store = JSON.parse(readFileSync(path, 'utf8')) as FakeStore;
  } catch {
    // A torn read; keep what this process has — the next write replaces it.
  }
}

function save(): void {
  const path = statePath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store), 'utf8');
}

/**
 * Arranged failures also live in a SIDECAR beside a shared state file, so another
 * process sharing the fleet sees them — an E2E runner arms a failure the web
 * server then meets. A sidecar, not a field of the store: reading one must never
 * reload the store mid-operation.
 */
function failuresPath(): string | null {
  const path = statePath();
  return path ? `${path}.failures.json` : null;
}

function readSharedFailures(): Partial<Record<FailureKind, string>> {
  const path = failuresPath();
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<FailureKind, string>>;
  } catch {
    return {};
  }
}

function writeSharedFailures(value: Partial<Record<FailureKind, string>>): void {
  const path = failuresPath();
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

function takeFailure(kind: FailureKind): string | null {
  const shared = readSharedFailures();
  const detail = failures[kind] ?? shared[kind] ?? null;
  failures[kind] = null;
  if (shared[kind] !== undefined) {
    delete shared[kind];
    writeSharedFailures(shared);
  }
  return detail;
}

/** Arm one failure in memory and, when a state file is shared, in its sidecar. */
function armFailure(kind: FailureKind, detail: string): void {
  failures[kind] = detail;
  if (failuresPath()) writeSharedFailures({ ...readSharedFailures(), [kind]: detail });
}

function nextId(prefix: string): string {
  store.sequence += 1;
  return statePath() ? `${prefix}-${process.pid}-${store.sequence}` : `${prefix}-${store.sequence}`;
}

function machineOrThrow(machineId: string): FakePersistentMachine {
  load();
  const machine = store.machines[machineId];
  if (!machine) throw new Error(`fake persistent orchestrator has no machine ${machineId}`);
  return machine;
}

export const fakePersistentOrchestrator: PersistentContainerOrchestrator & FakePersistentControls =
  {
    provider: 'fake',
    persistentSpecs,
    operations,
    execs,

    // ── controls ──────────────────────────────────────────────────────────────

    reset() {
      store = { apps: [], machines: {}, volumes: {}, sequence: 0 };
      save();
      persistentSpecs.length = 0;
      operations.length = 0;
      execs.length = 0;
      nextExec = null;
      execResponder = null;
      for (const key of Object.keys(failures) as Array<keyof typeof failures>) failures[key] = null;
      writeSharedFailures({});
      bootBehaviour = 'start';
      terminalBase = null;
      now = () => new Date();
    },
    failNextProvision(detail = 'the fake refused to provision') {
      armFailure('provision', detail);
    },
    failNextMachineCreate(detail = 'the fake refused to create the machine') {
      armFailure('machine', detail);
    },
    failNextStart(detail = 'no capacity on the volume host') {
      armFailure('start', detail);
    },
    failNextStop(detail = 'the fake refused to stop') {
      armFailure('stop', detail);
    },
    failNextDestroy(detail = 'the fake refused to destroy') {
      armFailure('destroy', detail);
    },
    failNextMove(detail = 'the fake refused to update the machine') {
      armFailure('move', detail);
    },
    setBootBehaviour(behaviour) {
      bootBehaviour = behaviour;
    },
    completeBoot(machineId) {
      const machine = machineOrThrow(machineId);
      if (machine.state === 'starting') {
        machine.state = 'running';
        machine.startedAt = now().toISOString();
        machine.stoppedAt = null;
        recordEvent(machine, 'start', 'started', machine.startedAt);
      }
      save();
    },
    destroyOutside(machineId) {
      load();
      delete store.machines[machineId];
      for (const volume of Object.values(store.volumes)) {
        if (volume.attachedMachineId === machineId) volume.attachedMachineId = null;
      }
      save();
    },
    createOutside(app) {
      load();
      if (!store.apps.includes(app)) store.apps.push(app);
      const machineId = nextId('fake-instance');
      const at = now();
      store.machines[machineId] = {
        handle: { provider: 'fake', app, machineId, volumeId: '', region: 'iad', createdAt: at },
        spec: {
          orgId: '',
          workspaceId: '',
          projectId: '',
          instanceId: '',
          image: '',
          size: { cpuKind: 'shared', cpus: 1, memoryMb: 256 },
          env: {},
          region: 'iad',
          volumeSizeGb: 0,
          mountPath: '',
          terminal: null,
        },
        state: 'running',
        startedAt: at.toISOString(),
        stoppedAt: null,
        starts: 1,
        configVersion: 0,
        untracked: true,
      };
      save();
      return machineId;
    },
    stopOutside(machineId) {
      const machine = machineOrThrow(machineId);
      machine.state = 'stopped';
      machine.stoppedAt = now().toISOString();
      recordEvent(machine, 'stop', 'stopped', machine.stoppedAt);
      save();
    },
    exitOutside(machineId, exitCode) {
      const machine = machineOrThrow(machineId);
      const at = now().toISOString();
      machine.state = 'stopped';
      machine.startedAt ??= at;
      machine.stoppedAt = at;
      machine.exitCode = exitCode;
      recordEvent(machine, 'exit', 'stopped', at, exitCode);
      save();
    },
    backdateRun(machineId, startedAt) {
      const machine = machineOrThrow(machineId);
      machine.startedAt = startedAt.toISOString();
      save();
    },
    setNow(next) {
      now = next;
    },
    setExecResponder(responder) {
      execResponder = responder;
    },
    setNextExecResult(result) {
      nextExec = result;
    },
    setTerminalAddress(base) {
      terminalBase = base;
    },
    machineConfigVersion(machineId) {
      return machineOrThrow(machineId).configVersion ?? 0;
    },
    machineImage(machineId) {
      return machineOrThrow(machineId).spec.image;
    },
    writeHomeFile(volumeId, path, content) {
      load();
      const volume = store.volumes[volumeId];
      if (!volume) throw new OrchestratorApiError('fake', 404, `volume ${volumeId} is gone`);
      volume.files = { ...(volume.files ?? {}), [path]: content };
      save();
    },
    readHomeFile(volumeId, path) {
      load();
      return store.volumes[volumeId]?.files?.[path] ?? null;
    },
    markImageFailing(image) {
      load();
      store.failingImages = [...new Set([...(store.failingImages ?? []), image])];
      save();
    },
    liveMachineIds() {
      load();
      return Object.keys(store.machines);
    },
    liveVolumeIds() {
      load();
      return Object.keys(store.volumes);
    },
    appNames() {
      load();
      return [...store.apps];
    },

    // ── the port ──────────────────────────────────────────────────────────────

    appNameFor(orgId: string): string {
      return `fake-inst-${orgId}`;
    },

    defaultRegion(): string {
      return 'iad';
    },

    async provisionPersistent(spec: PersistentContainerSpec): Promise<PersistentContainerHandle> {
      load();
      persistentSpecs.push(spec);
      const refused = takeFailure('provision');
      if (refused) throw new OrchestratorApiError('fake', 500, refused);

      const app = this.appNameFor(spec.orgId);
      if (!store.apps.includes(app)) {
        store.apps.push(app);
        operations.push(`app:create:${app}`);
      }
      const volumeId = nextId('fake-volume');
      store.volumes[volumeId] = {
        app,
        name: `home_${spec.instanceId}`,
        attachedMachineId: null,
        createdAt: now().toISOString(),
      };
      operations.push(`volume:create:${volumeId}`);

      const machineRefused = takeFailure('machine');
      if (machineRefused) {
        // The Fly adapter's rule: a volume whose machine never came is destroyed
        // before the throw, because nobody else will ever hold its id.
        delete store.volumes[volumeId];
        operations.push(`volume:destroy:${volumeId}`);
        save();
        throw new OrchestratorApiError('fake', 500, machineRefused);
      }

      const machineId = nextId('fake-instance');
      const createdAt = now();
      const handle: PersistentContainerHandle = {
        provider: 'fake',
        app,
        machineId,
        volumeId,
        region: spec.region,
        createdAt,
      };
      const boots = bootBehaviour === 'start';
      store.machines[machineId] = {
        handle,
        spec,
        state: boots ? 'running' : 'starting',
        startedAt: boots ? createdAt.toISOString() : null,
        stoppedAt: null,
        starts: 1,
        configVersion: spec.terminal?.version ?? 0,
        keyId: spec.terminal?.keyId ?? null,
      };
      const created = store.machines[machineId]!;
      recordEvent(created, 'launch', 'created', createdAt.toISOString());
      if (boots) recordEvent(created, 'start', 'started', createdAt.toISOString());
      store.volumes[volumeId]!.attachedMachineId = machineId;
      operations.push(`machine:create:${machineId}`);
      save();
      return handle;
    },

    async stop(handle: PersistentContainerHandle): Promise<void> {
      load();
      const refused = takeFailure('stop');
      if (refused) throw new OrchestratorApiError('fake', 500, refused);
      const machine = store.machines[handle.machineId];
      operations.push(`machine:stop:${handle.machineId}`);
      // Idempotent: a stopped machine stays stopped; a gone one is an answer.
      if (!machine || machine.state === 'stopped') return;
      machine.state = 'stopped';
      machine.stoppedAt = now().toISOString();
      recordEvent(machine, 'stop', 'stopped', machine.stoppedAt);
      recordEvent(machine, 'exit', 'stopped', machine.stoppedAt, 0);
      save();
    },

    async start(handle: PersistentContainerHandle): Promise<void> {
      load();
      const refused = takeFailure('start');
      if (refused) throw new OrchestratorApiError('fake', 500, refused);
      const machine = store.machines[handle.machineId];
      if (!machine)
        throw new OrchestratorApiError('fake', 404, `machine ${handle.machineId} is gone`);
      operations.push(`machine:start:${handle.machineId}`);
      if (machine.state === 'running') return;
      // Every start is a new run: its own start instant, no stop yet.
      machine.state = bootBehaviour === 'start' ? 'running' : 'starting';
      machine.startedAt = bootBehaviour === 'start' ? now().toISOString() : null;
      machine.stoppedAt = null;
      machine.exitCode = null;
      machine.starts += 1;
      if (bootBehaviour === 'start') recordEvent(machine, 'start', 'started', machine.startedAt!);
      save();
    },

    async describePersistent(
      handle: PersistentContainerHandle,
    ): Promise<PersistentContainerStatus> {
      load();
      const machine = store.machines[handle.machineId];
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
      return {
        machineId: handle.machineId,
        state: machine.state,
        providerState: machine.state,
        startedAt: machine.startedAt ? new Date(machine.startedAt) : null,
        stoppedAt: machine.stoppedAt ? new Date(machine.stoppedAt) : null,
        exitCode: machine.state === 'stopped' ? (machine.exitCode ?? null) : null,
        events: (machine.events ?? []).map(
          (e): PersistentMachineEvent => ({
            type: e.type,
            status: e.status,
            at: new Date(e.at),
            ...(e.exitCode === undefined ? {} : { exitCode: e.exitCode }),
          }),
        ),
        image: machine.spec.image,
      };
    },

    async destroyPersistent(handle: PersistentContainerHandle): Promise<void> {
      load();
      const refused = takeFailure('destroy');
      if (refused) throw new OrchestratorApiError('fake', 500, refused);
      if (store.machines[handle.machineId]) {
        delete store.machines[handle.machineId];
        operations.push(`machine:destroy:${handle.machineId}`);
      }
      if (store.volumes[handle.volumeId]) {
        delete store.volumes[handle.volumeId];
        operations.push(`volume:destroy:${handle.volumeId}`);
      }
      save();
    },

    async listPersistent(app: string): Promise<PersistentAppInventory> {
      load();
      return {
        app,
        machines: Object.values(store.machines)
          .filter((m) => m.handle.app === app)
          .map((m) => ({
            machineId: m.handle.machineId,
            state: m.state,
            instanceId: m.untracked ? null : m.spec.instanceId,
            createdAt:
              m.handle.createdAt instanceof Date
                ? m.handle.createdAt
                : new Date(m.handle.createdAt),
          })),
        volumes: Object.entries(store.volumes)
          .filter(([, v]) => v.app === app)
          .map(([volumeId, v]) => ({
            volumeId,
            name: v.name,
            attachedMachineId: v.attachedMachineId,
            createdAt: new Date(v.createdAt),
          })),
      };
    },

    async destroyVolume(_app: string, volumeId: string): Promise<void> {
      load();
      if (store.volumes[volumeId]) {
        delete store.volumes[volumeId];
        operations.push(`volume:destroy:${volumeId}`);
      }
      save();
    },

    async exec(
      handle: PersistentContainerHandle,
      command: readonly string[],
      options: { timeoutSeconds?: number; stdin?: string } = {},
    ): Promise<PersistentExecResult> {
      load();
      const machine = store.machines[handle.machineId];
      if (!machine || machine.state !== 'running') {
        throw new OrchestratorApiError('fake', 412, `machine ${handle.machineId} is not running`);
      }
      execs.push({
        machineId: handle.machineId,
        command: [...command],
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      });
      operations.push(`machine:exec:${handle.machineId}`);
      const scripted = nextExec ?? execResponder?.(command, options.stdin) ?? null;
      nextExec = null;
      if (scripted) return scripted;
      const bridge = process.env[EXEC_URL_ENV];
      if (bridge !== undefined && bridge !== '') {
        return bridgeExec(bridge, handle.machineId, command, options);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },

    async ensureMachineConfig(
      handle: PersistentContainerHandle,
      terminal: PersistentTerminalConfig,
    ): Promise<'updated' | 'current'> {
      load();
      const machine = store.machines[handle.machineId];
      if (!machine)
        throw new OrchestratorApiError('fake', 404, `machine ${handle.machineId} is gone`);
      const stamped = machine.configVersion ?? 0;
      if (stamped > terminal.version) return 'current';
      if (stamped === terminal.version && machine.keyId === terminal.keyId) return 'current';
      // Fly's `skip_launch`: the config changes, the machine's state does not.
      machine.spec = { ...machine.spec, terminal };
      machine.configVersion = terminal.version;
      machine.keyId = terminal.keyId;
      operations.push(`machine:update:${handle.machineId}`);
      save();
      return 'updated';
    },

    async moveImage(
      handle: PersistentContainerHandle,
      image: string,
      options: { launch: boolean },
    ): Promise<void> {
      load();
      const refused = takeFailure('move');
      if (refused) throw new OrchestratorApiError('fake', 409, refused);
      const machine = store.machines[handle.machineId];
      if (!machine)
        throw new OrchestratorApiError('fake', 404, `machine ${handle.machineId} is gone`);
      // Only the image changes: the volume, the handle and every other field stay.
      machine.spec = { ...machine.spec, image };
      if (options.launch && machine.state === 'running') {
        // Fly reboots a running machine onto the new config: a new run begins.
        if (bootBehaviour === 'never_start') {
          machine.state = 'starting';
        } else {
          machine.startedAt = now().toISOString();
          machine.stoppedAt = null;
          machine.starts += 1;
        }
      }
      operations.push(`machine:move:${handle.machineId}:${options.launch ? 'launch' : 'skip'}`);
      save();
    },

    async checkLiveness(
      handle: PersistentContainerHandle,
      command: readonly string[],
      options: { timeoutSeconds?: number } = {},
    ): Promise<PersistentLivenessResult> {
      load();
      operations.push(`machine:liveness:${handle.machineId}`);
      const machine = store.machines[handle.machineId];
      if (machine && (store.failingImages ?? []).includes(machine.spec.image)) {
        return {
          alive: false,
          reason: 'exit',
          exitCode: 127,
          detail: `${command.join(' ')} exited 127 (command not found)`,
        };
      }
      // A scripted exec answer drives the other branches; with none, a running
      // machine is alive — the fake never reaches a real binary.
      if (nextExec || execResponder) {
        return livenessViaExec(
          (h, cmd, opts) => this.exec(h, cmd, opts),
          handle,
          command,
          options.timeoutSeconds,
        );
      }
      if (!machine || machine.state !== 'running') {
        return {
          alive: false,
          reason: 'unreachable',
          detail: `${command.join(' ')} could not be run: machine ${handle.machineId} is not running`,
        };
      }
      return { alive: true };
    },

    terminalEndpoint(handle: PersistentContainerHandle): PersistentTerminalEndpoint {
      const env = process.env[TERMINAL_URL_ENV];
      const base = terminalBase ?? (env !== undefined && env !== '' ? env : DEFAULT_TERMINAL_BASE);
      return {
        url: `${trimTrailingSlashes(base)}/v1/terminal`,
        headers: { 'x-motir-machine-id': handle.machineId },
      };
    },

    async destroyMachine(_app: string, machineId: string): Promise<void> {
      load();
      if (store.machines[machineId]) {
        delete store.machines[machineId];
        operations.push(`machine:destroy:${machineId}`);
        for (const volume of Object.values(store.volumes)) {
          if (volume.attachedMachineId === machineId) volume.attachedMachineId = null;
        }
      }
      save();
    },
  };

/** Run one exec on the bridge (see {@link EXEC_URL_ENV}); its failures are the provider's. */
async function bridgeExec(
  url: string,
  machineId: string,
  command: readonly string[],
  options: { timeoutSeconds?: number; stdin?: string },
): Promise<PersistentExecResult> {
  const timeoutMs = ((options.timeoutSeconds ?? 60) + EXEC_RESPONSE_GRACE_SECONDS) * 1000;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        machineId,
        command,
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new OrchestratorApiError('fake', 502, `the exec bridge did not answer: ${detail}`);
  }
  const text = await res.text();
  if (!res.ok) throw new OrchestratorApiError('fake', res.status, text.slice(0, 300));
  const body = JSON.parse(text) as Partial<PersistentExecResult>;
  return {
    exitCode: typeof body.exitCode === 'number' ? body.exitCode : -1,
    stdout: typeof body.stdout === 'string' ? body.stdout : '',
    stderr: typeof body.stderr === 'string' ? body.stderr : '',
  };
}

/** Strip trailing `/`s without a backtracking regex (CodeQL js/polynomial-redos). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}
