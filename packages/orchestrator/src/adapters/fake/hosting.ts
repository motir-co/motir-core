import { existsSync, readFileSync } from 'node:fs';
import { OrchestratorApiError } from '../../errors';
import {
  CustomerRepositoryRefusedError,
  LogsUnavailableError,
  NoPreviousReleaseError,
  ReleaseCommandUnsupportedError,
  ReleaseNotFoundError,
} from '../../hosting/errors';
import { hostingAppNames, pushNamespaceName, sameEnvironment } from '../../hosting/names';
import { assertIdlePolicySupported, requireReleaseShape } from '../../hosting/shape';
import type {
  DeployReleaseInput,
  HostingDeployPort,
  HostingDeployTarget,
  HostingEnvironment,
  OriginCredentialKind,
  ReleaseCommandResult,
  ReleaseDescription,
  ReleaseHandle,
  ReleaseLastExit,
  ReleaseLogLine,
  ReleaseLogPage,
  ReleaseLogQuery,
  ReleaseRuntime,
  ReleaseRuntimeHealth,
  ReleaseShape,
  ReleaseSize,
  ReleaseSummary,
  ReleaseUsage,
} from '../../hosting/types';
import { computeUsageFor, runningSecondsBetween, type RunTransition } from '../../hosting/usage';
import { assertServerlessRuntime } from '../serverless/preflight';
import {
  armFakeHostingFailure,
  emptyFakeHostingSlice,
  fakeHostingPortKey,
  fakeHostingStatePath,
  readFakeHostingSlice,
  resetFakeHostingSnapshot,
  saveFakeHostingSlice,
  takeArmedFakeHostingFailure,
  type FakeHostingSlice,
  type FakeLogLine,
} from './hostingStore';

// The FAKE hosting deploy port (MOTIR-5773) — the second implementation shipped
// beside the Fly adapter, for the reason every port here has one: the preview
// and production stories test against it, and a port with one implementation has
// never been shown to be a port.
//
// It models the observable state machine the Fly adapter is held to: one live
// release per environment, a deploy that replaces it in place and keeps the one
// it replaced, a rollback that swaps them, idle stop and wake, usage that counts
// only running time, and a destroy that returns usage. Its controls arrange what
// a test needs: a clock, a release's health, and an idle stop.
//
// Built with `target: 'aws'` it also models the AWS adapter's two SHAPES
// (MOTIR-10002, to MOTIR-5769 §4): a release with no shape is refused by name, a
// container refuses the `suspend` idle policy, a deploy waits in
// `waiting_for_account` while the tenant account is not ready (and a repeat once
// it is completes the SAME release), each shape answers its own upstream and
// origin credential, and usage carries compute units from the shared size table.
//
// ACROSS PROCESSES (MOTIR-10098): with `MOTIR_FAKE_HOSTING_STATE_PATH` set, its
// whole state is the slice `./hostingStore` keeps in that file — loaded before
// every operation and control, saved after every mutation (reads never save, so a
// read cannot roll back another process's write), armed failures in the store's
// sidecar, release ids pid-suffixed. Unset, it is the in-memory closure it always
// was. Only a fake built with `shareAcrossProcesses` takes the seam — the
// composition root's singleton (MOTIR-10040); a fake a test builds itself stays
// in memory even with the variable set.
//
// THE RUNTIME READS (MOTIR-12099): `readLogs` answers the lines a test appended
// with `appendLogLines`, applying the window, the filter, the limit and the
// newest-first cursor exactly as a real adapter must, and returning every
// message as appended — masking is the caller's. `readHealth` derives the
// running process's state from what the fake already models (a held or
// deploying release, an idle stop, a running release) and from the controls
// that arrange the rest: an exit or a memory kill (`setRuntimeState`), and an
// exit the target already restarted from (`recordRestartedExit`).
//
// The HOLD sidecar (`<path>.hold.json`, `{ "held": ["deploy"] }`) is how a spec
// in a THIRD process keeps a release open long enough to be seen building
// (Story MOTIR-9797 · MOTIR-10040): a held operation waits, before it reads
// anything, until the operation leaves the list — and fails at the "provider"
// after `FAKE_HOSTING_HOLD_LIMIT_MS`, so a hold nobody releases ends the release
// rather than the lane.

export interface FakeHostedRelease {
  readonly releaseId: string;
  readonly environment: HostingEnvironment;
  readonly image: string;
  readonly runtime: ReleaseRuntime;
  readonly env: Readonly<Record<string, string>>;
  /** The AWS shape, when the target has shapes. */
  readonly shape?: ReleaseShape;
  readonly size?: ReleaseSize;
}

export interface FakeHostedApp {
  readonly appRef: string;
  readonly pushNamespace: string;
  readonly environment: HostingEnvironment;
  live: FakeHostedRelease | null;
  previous: FakeHostedRelease | null;
  /** A release held until the tenant account is ready (AWS). */
  pending: FakeHostedRelease | null;
  health: 'deploying' | 'healthy' | 'unhealthy';
  running: boolean;
  transitions: RunTransition[];
  /** Where the live release answers instead of the fake's template address —
   *  an origin a lane points at a stand-in (MOTIR-10100). Null or absent: the
   *  template. */
  upstreamOverride?: string | null;
}

/** The port operations, as the fake's call log names them. */
export type FakeHostingOperation = Exclude<keyof HostingDeployPort, 'target'>;

/** One call the fake received, in order (MOTIR-10030): which operation, on which
 *  app when it names one, and — for a release command — the command it ran. */
export interface FakeHostingCall {
  readonly operation: FakeHostingOperation;
  readonly appRef: string | null;
  readonly command?: string;
  /** The names of the environment it was given — never the values. */
  readonly envNames?: readonly string[];
}

export interface FakeHostingControls {
  /** The fake's clock. */
  now(): Date;
  advanceSeconds(seconds: number): void;
  /** Set the live release's health check result. */
  setHealth(appRef: string, health: 'deploying' | 'healthy' | 'unhealthy'): void;
  /** The provider stopped an idle release / a request woke it. */
  idleStop(appRef: string): void;
  wake(appRef: string): void;
  /** Inspect an app (undefined when none exists). */
  app(appRef: string): FakeHostedApp | undefined;
  /** Every push credential minted, in order. */
  readonly mintedFor: readonly string[];
  /** Every push namespace `ensurePushNamespace` made, in order of creation. */
  pushNamespaces(): readonly string[];
  /** The credentials minted for a namespace and not yet revoked. */
  liveCredentials(pushNamespace: string): number;
  /** The next call of that operation fails at the "provider" with an
   *  `OrchestratorApiError` and changes nothing — a destroy that destroyed
   *  nothing, for the usage-always rule's error path; a deploy or a release
   *  command that never ran. `message` replaces the error's detail, so a test
   *  can make it carry something that must not leak. */
  failNext(operation: FakeHostingFailure, message?: string): void;
  /** Every port call this process made, in order. */
  readonly calls: readonly FakeHostingCall[];
  /** How the next release commands end (default: exit 0). */
  setReleaseCommandResult(result: ReleaseCommandResult): void;
  /** Whether the organisation's AWS tenant account is ready. Ready unless a test
   *  sets it false; while not ready an `aws` deploy waits in
   *  `waiting_for_account`. */
  setAccountReady(ready: boolean): void;
  /** Point an app's live release at `address` — stored as its ORIGIN, the fact
   *  the gate forwards to — or, with null, back at the template address. Moves
   *  the address only: the release's state and origin credential are unchanged.
   *  Refuses a value that is not an absolute http(s) URL, and an unknown app. */
  setUpstream(appRef: string, address: string | null): void;
  /** Append lines to an app's log, as its target would have recorded them. */
  appendLogLines(appRef: string, lines: readonly ReleaseLogLine[]): void;
  /** Make the app's logs unreadable at the target (`readLogs` throws
   *  `LogsUnavailableError` with this reason), or, with null, readable again. */
  setLogsUnavailable(appRef: string, reason: string | null): void;
  /** The release's process exited (with its code) or was killed for memory,
   *  from the fake's clock now; null clears it. `wake`, `deploy` and `rollback`
   *  clear it too. */
  setRuntimeState(appRef: string, state: FakeRuntimeStateInput | null): void;
  /** The target restarted the running release from this exit; null clears it.
   *  `deploy` and `rollback` clear it too. */
  recordRestartedExit(appRef: string, exit: ReleaseLastExit | null): void;
  /** Forget every app, release, credential and armed failure — in the shared
   *  store too, so a lane's next spec inherits nothing. */
  reset(): void;
}

/** The runtime states `setRuntimeState` arranges. */
export type FakeRuntimeStateInput =
  | { readonly state: 'exited'; readonly exitCode: number | null }
  | { readonly state: 'oom_killed' };

/** The operations a test can make fail once at the "provider". */
export type FakeHostingFailure =
  | 'destroy'
  | 'destroyApp'
  | 'deploy'
  | 'runReleaseCommand'
  | 'ensurePushNamespace'
  | 'revokeDeployCredentials';

/** The name MOTIR-10030 gave the failable operations. */
export type FakeFailableOperation = FakeHostingFailure;

/** How long a held operation waits before it fails. */
export const FAKE_HOSTING_HOLD_LIMIT_MS = 120_000;
const HOLD_POLL_MS = 100;

/** The operations the hold sidecar names, or none. A torn read holds nothing. */
function heldOperations(path: string): readonly string[] {
  const hold = `${path}.hold.json`;
  if (!existsSync(hold)) return [];
  try {
    const parsed = JSON.parse(readFileSync(hold, 'utf8')) as { held?: unknown };
    return Array.isArray(parsed.held) ? parsed.held.filter((h) => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

export interface FakeHostingOptions {
  readonly target?: HostingDeployTarget;
  readonly appPrefix?: string;
  readonly start?: Date;
  /** Repository ids `ensureApp` refuses as customer repositories (D1). */
  readonly refuseRepositories?: readonly string[];
  /** Whether the cross-process store seam applies. Only the composition root's
   *  singleton takes it; a fake a test builds itself is in-memory only. */
  readonly shareAcrossProcesses?: boolean;
}

/** The origin credential a forwarder sends to a release of that target
 *  (MOTIR-5769 §4, amended by MOTIR-10128): Fly's guard, an AWS container's
 *  load-balancer rule and an AWS function's front door (MOTIR-10129) check the
 *  origin secret; a serverless release is IAM-authorised (SigV4). */
function originCredentialFor(target: HostingDeployTarget): OriginCredentialKind {
  return target === 'serverless' ? 'aws_sigv4' : 'origin_secret';
}

/** Where the fake says a release answers: the shape's own host on AWS. */
function upstreamFor(appRef: string, shape: ReleaseShape | undefined): string {
  if (shape === 'function') return `https://${appRef}.lambda-url.fake.invalid`;
  if (shape === 'container') return `https://${appRef}.alb.fake.invalid`;
  return `https://${appRef}.fake.invalid`;
}

/** The origin of an absolute http(s) address, or the typed refusal naming the app. */
function originOf(appRef: string, address: string): string {
  let url: URL | null = null;
  try {
    url = new URL(address);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new OrchestratorApiError(
      'fake',
      400,
      `app ${appRef}: an upstream must be an absolute http(s) URL, not "${address}"`,
    );
  }
  return url.origin;
}

/** Where a log page stopped: the last line it returned. Lines strictly older
 *  are the next page, so lines appended meanwhile never shift it. */
interface LogCursor {
  readonly at: number;
  readonly seq: number;
}

function encodeLogCursor(line: FakeLogLine): string {
  return Buffer.from(JSON.stringify({ at: line.at, seq: line.seq })).toString('base64url');
}

function decodeLogCursor(appRef: string, cursor: string): LogCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<LogCursor>;
    if (Number.isFinite(parsed.at) && Number.isInteger(parsed.seq)) {
      return { at: parsed.at as number, seq: parsed.seq as number };
    }
  } catch {
    // fall through to the refusal
  }
  throw new OrchestratorApiError('fake', 400, `app ${appRef}: "${cursor}" is not a log cursor`);
}

/** Newest first: the later instant, and at one instant the later line. */
function newerFirst(a: FakeLogLine, b: FakeLogLine): number {
  return b.at - a.at || b.seq - a.seq;
}

function olderThan(line: FakeLogLine, cursor: LogCursor): boolean {
  return line.at < cursor.at || (line.at === cursor.at && line.seq < cursor.seq);
}

export function createFakeHostingDeployPort(
  options: FakeHostingOptions = {},
): HostingDeployPort & FakeHostingControls {
  const target = options.target ?? 'fly';
  const prefix = options.appPrefix ?? 'mh-';
  const key = fakeHostingPortKey(target, options.appPrefix);
  const refused = new Set(options.refuseRepositories ?? []);
  let state: FakeHostingSlice = emptyFakeHostingSlice(options.start);
  // The take-once failures of an UNSHARED fake; a shared one arms the sidecar.
  const failing = new Map<FakeHostingFailure, string | undefined>();
  const calls: FakeHostingCall[] = [];
  let commandResult: ReleaseCommandResult = { exitCode: 0, timedOut: false };
  /** The shared store's path when this fake takes the seam, else null. */
  const sharedPath = (): string | null =>
    options.shareAcrossProcesses ? fakeHostingStatePath() : null;

  /** Under the seam, adopt what the file holds — an empty slice when nothing is
   *  stored, because another process may have reset it; a torn file keeps ours. */
  function load(): FakeHostingSlice {
    if (!sharedPath()) return state;
    const stored = readFakeHostingSlice(key);
    if (stored === null) state = emptyFakeHostingSlice(options.start);
    else if (stored !== 'torn') state = stored;
    return state;
  }

  /** Persist the slice after a mutation — a no-op with the seam off. */
  function save(): void {
    if (sharedPath()) saveFakeHostingSlice(key, state);
  }

  function injectedFailure(operation: FakeHostingFailure): void {
    let detail: string | null = null;
    if (failing.has(operation)) {
      detail = failing.get(operation) ?? `injected ${operation} failure`;
      failing.delete(operation);
    } else if (sharedPath()) {
      detail = takeArmedFakeHostingFailure(key, operation);
    }
    if (detail === null) return;
    throw new OrchestratorApiError('fake', 503, detail);
  }

  /** Wait while the hold sidecar names `operation`. */
  async function awaitRelease(path: string, operation: FakeHostingOperation): Promise<void> {
    const deadline = Date.now() + FAKE_HOSTING_HOLD_LIMIT_MS;
    while (heldOperations(path).includes(operation)) {
      if (Date.now() >= deadline) {
        throw new OrchestratorApiError('fake', 504, `held ${operation} was never released`);
      }
      await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
    }
  }

  const now = () => new Date(state.clock);

  function appOf(appRef: string): FakeHostedApp {
    const app = state.apps[appRef];
    if (!app) throw new OrchestratorApiError('fake', 404, `app ${appRef} does not exist`);
    return app;
  }

  /** The app a runtime read names, refused when it holds no live or pending
   *  release — as every adapter refuses it. */
  function releasedApp(appRef: string): FakeHostedApp {
    const app = state.apps[appRef];
    if (!app || (!app.live && !app.pending)) throw new ReleaseNotFoundError(appRef);
    return app;
  }

  /** A new process: forget the exit or memory kill a test arranged, and — on a
   *  new or restored release — the exit the old process was restarted from. */
  function clearRuntime(appRef: string, newRelease: boolean): void {
    delete state.runtimeStates[appRef];
    if (newRelease) delete state.restartedExits[appRef];
  }

  /** When the app last started or stopped running, or now. */
  function lastTransitionAt(app: FakeHostedApp, running: boolean): Date {
    const last = [...app.transitions].reverse().find((t) => t.running === running);
    return last ? new Date(last.at) : now();
  }

  function setRunning(app: FakeHostedApp, running: boolean): void {
    if (app.running === running) return;
    app.running = running;
    app.transitions.push({ at: now(), running });
  }

  function handleFor(app: FakeHostedApp, release: FakeHostedRelease): ReleaseHandle {
    return {
      target,
      appRef: app.appRef,
      environment: release.environment,
      releaseId: release.releaseId,
      providerRef: `fake-${app.appRef}`,
    };
  }

  /** Usage of a release, in compute units too when it has an AWS shape. */
  function usageRecord(
    appRef: string,
    releaseId: string,
    since: Date,
    until: Date,
    runningSeconds: number,
  ): ReleaseUsage {
    const base = { target, appRef, releaseId, since, until, runningSeconds };
    const shaped = state.shapes[releaseId];
    if (!shaped?.shape) return base;
    return {
      ...base,
      compute: computeUsageFor(shaped.shape, shaped.size, shaped.environment, runningSeconds),
    };
  }

  function usage(app: FakeHostedApp, releaseId: string, since: Date): ReleaseUsage {
    const until = now();
    return usageRecord(
      app.appRef,
      releaseId,
      since,
      until,
      runningSecondsBetween(app.transitions, since, until),
    );
  }

  /** The AWS refusals, before any state changes: no shape, or a container
   *  asked to suspend when idle. Returns the shape (undefined off AWS). */
  function shapeOf(input: DeployReleaseInput): ReleaseShape | undefined {
    if (target !== 'aws') return undefined;
    const shape = requireReleaseShape(target, input);
    assertIdlePolicySupported(target, shape, input.idle);
    return shape;
  }

  /** A new release id — pid-suffixed under the seam, so two processes reading
   *  one store never mint the same one. */
  function nextReleaseId(): string {
    state.sequence += 1;
    return sharedPath() ? `rel-${process.pid}-${state.sequence}` : `rel-${state.sequence}`;
  }

  function release(
    input: DeployReleaseInput,
    shape: ReleaseShape | undefined,
    releaseId?: string,
  ): FakeHostedRelease {
    const { artifact } = input;
    const image =
      artifact.kind === 'image' && artifact.digest
        ? `${artifact.ref}@${artifact.digest}`
        : artifact.ref;
    const made: FakeHostedRelease = {
      releaseId: releaseId ?? nextReleaseId(),
      environment: input.environment,
      image,
      runtime: input.runtime,
      env: Object.fromEntries(input.env.map((v) => [v.name, v.value])),
      ...(shape ? { shape, ...(input.size ? { size: input.size } : {}) } : {}),
    };
    state.shapes[made.releaseId] = made;
    return made;
  }

  const port: HostingDeployPort & FakeHostingControls = {
    target,
    calls,
    get mintedFor() {
      return load().mintedFor;
    },
    now: () => {
      load();
      return now();
    },
    advanceSeconds(seconds) {
      load().clock += seconds * 1000;
      save();
    },
    setHealth(appRef, health) {
      load();
      appOf(appRef).health = health;
      if (health === 'deploying') state.deployingSince[appRef] = state.clock;
      else delete state.deployingSince[appRef];
      save();
    },
    idleStop(appRef) {
      load();
      setRunning(appOf(appRef), false);
      save();
    },
    wake(appRef) {
      load();
      setRunning(appOf(appRef), true);
      clearRuntime(appRef, false);
      save();
    },
    appendLogLines(appRef, lines) {
      load();
      appOf(appRef);
      const log = (state.logs[appRef] ??= []);
      for (const line of lines) {
        state.logSequence += 1;
        log.push({
          seq: state.logSequence,
          at: line.at.getTime(),
          stream: line.stream,
          message: line.message,
        });
      }
      save();
    },
    setLogsUnavailable(appRef, reason) {
      load();
      appOf(appRef);
      if (reason === null) delete state.logsUnavailable[appRef];
      else state.logsUnavailable[appRef] = reason;
      save();
    },
    setRuntimeState(appRef, runtime) {
      load();
      appOf(appRef);
      if (runtime === null) delete state.runtimeStates[appRef];
      else if (runtime.state === 'exited') {
        state.runtimeStates[appRef] = {
          state: 'exited',
          exitCode: runtime.exitCode,
          since: state.clock,
        };
      } else state.runtimeStates[appRef] = { state: 'oom_killed', since: state.clock };
      save();
    },
    recordRestartedExit(appRef, exit) {
      load();
      appOf(appRef);
      if (exit === null) delete state.restartedExits[appRef];
      else {
        state.restartedExits[appRef] = {
          exitCode: exit.exitCode,
          oomKilled: exit.oomKilled,
          at: exit.at.getTime(),
        };
      }
      save();
    },
    app: (appRef) => load().apps[appRef],
    pushNamespaces: () => [...load().namespaces],
    liveCredentials: (pushNamespace) => load().liveTokens[pushNamespace] ?? 0,
    failNext(operation, message) {
      if (sharedPath()) {
        armFakeHostingFailure(key, operation, message ?? `injected ${operation} failure`);
      } else {
        failing.set(operation, message);
      }
    },
    setReleaseCommandResult(result) {
      commandResult = result;
    },
    setAccountReady(ready) {
      load().accountReady = ready;
      save();
    },
    setUpstream(appRef, address) {
      load();
      const app = appOf(appRef);
      app.upstreamOverride = address === null ? null : originOf(appRef, address);
      save();
    },
    reset() {
      state = emptyFakeHostingSlice(options.start);
      failing.clear();
      if (sharedPath()) resetFakeHostingSnapshot(key);
    },

    async ensureApp({ repositoryId, environment }) {
      if (refused.has(repositoryId)) throw new CustomerRepositoryRefusedError(repositoryId);
      const names = hostingAppNames(prefix, repositoryId, environment);
      const { apps } = load();
      if (!apps[names.appRef]) {
        apps[names.appRef] = {
          ...names,
          environment,
          live: null,
          previous: null,
          pending: null,
          health: 'deploying',
          running: false,
          transitions: [],
        };
        save();
      }
      return names;
    },

    async ensurePushNamespace({ repositoryId, kind }) {
      if (refused.has(repositoryId)) throw new CustomerRepositoryRefusedError(repositoryId);
      injectedFailure('ensurePushNamespace');
      const pushNamespace = pushNamespaceName(prefix, repositoryId, kind);
      const { namespaces } = load();
      if (!namespaces.includes(pushNamespace)) namespaces.push(pushNamespace);
      save();
      return { pushNamespace, imageRepository: `registry.fake.invalid/${pushNamespace}` };
    },

    async revokeDeployCredentials({ pushNamespace }) {
      injectedFailure('revokeDeployCredentials');
      const { liveTokens } = load();
      const revoked = liveTokens[pushNamespace] ?? 0;
      delete liveTokens[pushNamespace];
      save();
      return { revoked };
    },

    async mintDeployCredential({ pushNamespace }) {
      const { mintedFor, liveTokens } = load();
      mintedFor.push(pushNamespace);
      liveTokens[pushNamespace] = (liveTokens[pushNamespace] ?? 0) + 1;
      save();
      return {
        kind: 'secret',
        pushNamespace,
        value: `fake-deploy-token-${pushNamespace}`,
        expiresAt: new Date(state.clock + 90 * 86_400_000),
      };
    },

    async deploy(input) {
      // As the serverless adapter: its manifest refusals come before anything
      // else, so a refused release finds no app and creates nothing.
      injectedFailure('deploy');
      if (target === 'serverless') assertServerlessRuntime(input.runtime);
      const shape = shapeOf(input);
      load();
      const app = appOf(input.appRef);
      if (!sameEnvironment(app.environment, input.environment)) {
        throw new OrchestratorApiError('fake', 409, `app ${app.appRef} is another environment's`);
      }
      // A deploy held for the account resumes as the SAME release: the repeat
      // reuses the held release's id, so a resumed run never makes a second.
      const next = release(input, shape, app.pending?.releaseId);
      if (target === 'aws' && !state.accountReady) {
        app.pending = next;
        state.deployingSince[app.appRef] ??= state.clock;
        save();
        return handleFor(app, next);
      }
      app.pending = null;
      app.previous = app.live;
      app.live = next;
      app.health = 'healthy';
      delete state.deployingSince[app.appRef];
      clearRuntime(app.appRef, true);
      setRunning(app, true);
      save();
      return handleFor(app, next);
    },

    async describe(handle): Promise<ReleaseDescription> {
      const app = load().apps[handle.appRef];
      if (app?.pending) {
        return {
          state: 'waiting_for_account',
          releaseId: app.pending.releaseId,
          previousReleaseId: app.live?.releaseId ?? null,
          upstreamAddress: null,
          originCredential: originCredentialFor(target),
        };
      }
      if (!app || !app.live) {
        return {
          state: 'destroyed',
          releaseId: null,
          previousReleaseId: null,
          upstreamAddress: null,
          originCredential: 'none',
        };
      }
      return {
        state: app.running ? app.health : 'stopped',
        releaseId: app.live.releaseId,
        previousReleaseId: app.previous?.releaseId ?? null,
        upstreamAddress: app.upstreamOverride ?? upstreamFor(app.appRef, app.live.shape),
        // As the real adapters: a Fly release sits behind the origin-secret
        // guard (MOTIR-9947), a serverless one behind a SigV4-signed function
        // URL (MOTIR-9972), an AWS release behind its shape's credential.
        originCredential: originCredentialFor(target),
      };
    },

    async rollback({ appRef }) {
      load();
      const app = appOf(appRef);
      if (!app.live) throw new ReleaseNotFoundError(appRef);
      if (!app.previous) throw new NoPreviousReleaseError(appRef);
      const restored = app.previous;
      app.previous = app.live;
      app.live = restored;
      clearRuntime(appRef, true);
      setRunning(app, true);
      save();
      return handleFor(app, restored);
    },

    async usageSince(handle, since) {
      load();
      return usage(appOf(handle.appRef), handle.releaseId, since);
    },

    async destroy(handle) {
      injectedFailure('destroy');
      const app = load().apps[handle.appRef];
      if (!app || !app.live) {
        if (app) {
          app.pending = null;
          save();
        }
        return usageRecord(handle.appRef, handle.releaseId, now(), now(), 0);
      }
      const first = app.transitions[0]?.at ?? now();
      const result = usage(app, handle.releaseId, first);
      setRunning(app, false);
      app.live = null;
      app.previous = null;
      clearRuntime(app.appRef, true);
      save();
      return result;
    },

    async destroyApp({ appRef }) {
      injectedFailure('destroyApp');
      const { apps, namespaces, liveTokens } = load();
      const app = apps[appRef];
      delete apps[appRef];
      clearRuntime(appRef, true);
      delete state.deployingSince[appRef];
      delete state.logs[appRef];
      delete state.logsUnavailable[appRef];
      // On Fly a push namespace IS an app (`mh-<rid>-pv`), destroyed the same way
      // at takeover (MOTIR-5776).
      state.namespaces = namespaces.filter((n) => n !== appRef);
      delete liveTokens[appRef];
      save();
      if (!app?.live) return [];
      return [usage(app, app.live.releaseId, app.transitions[0]?.at ?? now())];
    },

    async listReleases({ appRef }): Promise<ReleaseSummary[]> {
      const app = load().apps[appRef];
      if (app?.pending) {
        return [{ handle: handleFor(app, app.pending), state: 'waiting_for_account' }];
      }
      if (!app?.live) return [];
      return [
        {
          handle: handleFor(app, app.live),
          state: app.running ? app.health : 'stopped',
        },
      ];
    },

    async runReleaseCommand({ appRef }) {
      // As the real adapters: only Fly runs a one-off command of a release image.
      if (target !== 'fly') throw new ReleaseCommandUnsupportedError(target);
      load();
      appOf(appRef);
      injectedFailure('runReleaseCommand');
      return commandResult;
    },

    async readLogs(handle, query: ReleaseLogQuery): Promise<ReleaseLogPage> {
      load();
      const app = releasedApp(handle.appRef);
      const unavailable = state.logsUnavailable[app.appRef];
      if (unavailable !== undefined) throw new LogsUnavailableError(target, unavailable);
      if (!Number.isInteger(query.limit) || query.limit < 1) {
        throw new OrchestratorApiError('fake', 400, `a log limit must be a positive integer`);
      }
      const cursor = query.cursor ? decodeLogCursor(app.appRef, query.cursor) : null;
      const since = query.since?.getTime() ?? -Infinity;
      const until = query.until?.getTime() ?? Infinity;
      const needle = query.filter ? query.filter.toLowerCase() : null;
      const matching = (state.logs[app.appRef] ?? [])
        .filter(
          (line) =>
            line.at >= since &&
            line.at <= until &&
            (needle === null || line.message.toLowerCase().includes(needle)) &&
            (cursor === null || olderThan(line, cursor)),
        )
        .sort(newerFirst);
      const page = matching.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        lines: page.map((line) => ({
          at: new Date(line.at),
          stream: line.stream,
          message: line.message,
        })),
        cursor: last && matching.length > page.length ? encodeLogCursor(last) : null,
      };
    },

    async readHealth(handle): Promise<ReleaseRuntimeHealth> {
      load();
      const app = releasedApp(handle.appRef);
      const deployingSince = new Date(state.deployingSince[app.appRef] ?? state.clock);
      if (app.pending) return { state: 'deploying', since: deployingSince };
      const runtime = state.runtimeStates[app.appRef];
      if (runtime?.state === 'exited') {
        return { state: 'exited', exitCode: runtime.exitCode, since: new Date(runtime.since) };
      }
      if (runtime?.state === 'oom_killed') {
        return { state: 'oom_killed', since: new Date(runtime.since) };
      }
      if (!app.running) return { state: 'suspended', since: lastTransitionAt(app, false) };
      if (app.health === 'deploying') return { state: 'deploying', since: deployingSince };
      const exit = state.restartedExits[app.appRef];
      return {
        state: 'running',
        since: lastTransitionAt(app, true),
        ...(exit
          ? {
              lastExit: {
                exitCode: exit.exitCode,
                oomKilled: exit.oomKilled,
                at: new Date(exit.at),
              },
            }
          : {}),
      };
    },
  };

  // The call log and the hold wrap every operation, so a test can assert their
  // ORDER — the migration before the deploy — without each operation logging
  // itself, and a held operation waits before it reads the store.
  const operations: FakeHostingOperation[] = [
    'ensureApp',
    'ensurePushNamespace',
    'mintDeployCredential',
    'revokeDeployCredentials',
    'deploy',
    'describe',
    'rollback',
    'usageSince',
    'destroy',
    'destroyApp',
    'listReleases',
    'runReleaseCommand',
    'readLogs',
    'readHealth',
  ];
  const record = port as unknown as Record<FakeHostingOperation, (input: unknown) => unknown>;
  for (const operation of operations) {
    const inner = record[operation].bind(port) as (...args: unknown[]) => unknown;
    record[operation] = (input: unknown, ...rest: unknown[]) => {
      const fields = (input ?? {}) as {
        appRef?: unknown;
        command?: unknown;
        env?: ReadonlyArray<{ name: string }>;
      };
      calls.push({
        operation,
        appRef: typeof fields.appRef === 'string' ? fields.appRef : null,
        ...(typeof fields.command === 'string' ? { command: fields.command } : {}),
        ...(Array.isArray(fields.env) ? { envNames: fields.env.map((v) => v.name) } : {}),
      });
      const path = sharedPath();
      if (!path) return inner(input, ...rest);
      return (async () => {
        await awaitRelease(path, operation);
        return inner(input, ...rest);
      })();
    };
  }
  return port;
}
