import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrchestratorApiError } from '../../errors';
import {
  CustomerRepositoryRefusedError,
  IdlePolicyUnsupportedError,
  NoPreviousReleaseError,
  ReleaseCommandUnsupportedError,
  ReleaseNotFoundError,
} from '../../hosting/errors';
import { hostingAppNames, sameEnvironment } from '../../hosting/names';
import { requireReleaseShape } from '../../hosting/shape';
import type {
  DeployReleaseInput,
  HostingDeployPort,
  HostingDeployTarget,
  HostingEnvironment,
  OriginCredentialKind,
  ReleaseCommandResult,
  ReleaseDescription,
  ReleaseHandle,
  ReleaseRuntime,
  ReleaseShape,
  ReleaseSize,
  ReleaseSummary,
  ReleaseUsage,
} from '../../hosting/types';
import { computeUsageFor, runningSecondsBetween, type RunTransition } from '../../hosting/usage';
import { assertServerlessRuntime } from '../serverless/preflight';

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

/** The operations a test can make fail once at the provider. */
export type FakeFailableOperation = 'destroy' | 'destroyApp' | 'deploy' | 'runReleaseCommand';

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
  /** The next call of that operation fails at the "provider" with an
   *  `OrchestratorApiError` and changes nothing — a destroy that destroyed
   *  nothing, for the usage-always rule's error path; a deploy or a release
   *  command that never ran. `message` replaces the error's detail, so a test
   *  can make it carry something that must not leak. */
  failNext(operation: FakeFailableOperation, message?: string): void;
  /** Every port call, in order. */
  readonly calls: readonly FakeHostingCall[];
  /** How the next release commands end (default: exit 0). */
  setReleaseCommandResult(result: ReleaseCommandResult): void;
  /** Whether the organisation's AWS tenant account is ready. Ready unless a test
   *  sets it false; while not ready an `aws` deploy waits in
   *  `waiting_for_account`. */
  setAccountReady(ready: boolean): void;
}

export interface FakeHostingOptions {
  readonly target?: HostingDeployTarget;
  readonly appPrefix?: string;
  readonly start?: Date;
  /** Repository ids `ensureApp` refuses as customer repositories (D1). */
  readonly refuseRepositories?: readonly string[];
  /** Whether the cross-process store seam applies (below). Only the composition
   *  root's singleton takes it; a fake a test builds itself is in-memory only. */
  readonly shareAcrossProcesses?: boolean;
}

// ⚠️ THE CROSS-PROCESS *HOSTING* STORE (Story MOTIR-9797 · MOTIR-10040) — the
// seam `./index.ts` (MOTIR-3828) and `./persistent.ts` carry, for the same
// reason: in the E2E lane a merge's release is DEPLOYED by the job worker and
// ROLLED BACK by the web server, so the two processes must see one provider.
// An in-memory map in each would answer the rollback "no live release" for an
// application the other process just made live.
//
// OPT-IN and file-backed: absent the variable, or for a fake built without
// `shareAcrossProcesses`, this is the in-memory fake every vitest suite drives.
// Under it, every operation reads the file before it runs and writes it after.
//
// The HOLD sidecar (`<path>.hold.json`, `{ "held": ["deploy"] }`) is how a spec
// in a THIRD process keeps a release open long enough to be seen building: a
// held operation waits, before it reads anything, until the operation leaves
// the list — and fails at the "provider" after `FAKE_HOSTING_HOLD_LIMIT_MS`, so
// a hold nobody releases ends the release rather than the lane.
export const FAKE_HOSTING_STATE_PATH_ENV = 'MOTIR_FAKE_HOSTING_STATE_PATH';
/** How long a held operation waits before it fails. */
export const FAKE_HOSTING_HOLD_LIMIT_MS = 120_000;
const HOLD_POLL_MS = 100;

interface PersistedHostedApp extends Omit<FakeHostedApp, 'transitions'> {
  transitions: Array<{ at: string; running: boolean }>;
}

interface PersistedHostingStore {
  clock: number;
  sequence: number;
  apps: PersistedHostedApp[];
  shapes: FakeHostedRelease[];
}

function hostingStatePath(): string | null {
  const raw = process.env[FAKE_HOSTING_STATE_PATH_ENV];
  return raw !== undefined && raw !== '' ? raw : null;
}

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

/** The origin credential a forwarder sends to a release of that target and
 *  shape (MOTIR-5769 §4): Fly's guard and an AWS container's load-balancer rule
 *  check the origin secret; a serverless release and an AWS function URL are
 *  IAM-authorised (SigV4). */
function originCredentialFor(
  target: HostingDeployTarget,
  shape: ReleaseShape | undefined,
): OriginCredentialKind {
  if (target === 'fly') return 'origin_secret';
  if (target === 'serverless') return 'aws_sigv4';
  return shape === 'function' ? 'aws_sigv4' : 'origin_secret';
}

/** Where the fake says a release answers: the shape's own host on AWS. */
function upstreamFor(appRef: string, shape: ReleaseShape | undefined): string {
  if (shape === 'function') return `https://${appRef}.lambda-url.fake.invalid`;
  if (shape === 'container') return `https://${appRef}.alb.fake.invalid`;
  return `https://${appRef}.fake.invalid`;
}

export function createFakeHostingDeployPort(
  options: FakeHostingOptions = {},
): HostingDeployPort & FakeHostingControls {
  const target = options.target ?? 'fly';
  const prefix = options.appPrefix ?? 'mh-';
  let clock = (options.start ?? new Date('2026-01-01T00:00:00Z')).getTime();
  let sequence = 0;
  const apps = new Map<string, FakeHostedApp>();
  const mintedFor: string[] = [];
  const failing = new Map<FakeFailableOperation, string | undefined>();
  const calls: FakeHostingCall[] = [];
  let commandResult: ReleaseCommandResult = { exitCode: 0, timedOut: false };
  const refused = new Set(options.refuseRepositories ?? []);
  // Every release's shape, kept past its destroy so a repeated destroy still
  // reports usage in the unit of the release it names.
  const shapes = new Map<string, FakeHostedRelease>();
  let accountReady = true;
  const sharedPath = (): string | null =>
    options.shareAcrossProcesses ? hostingStatePath() : null;

  /** Read the shared file over this process's state. A no-op when the seam is off. */
  function loadShared(path: string): void {
    if (!existsSync(path)) return;
    let parsed: PersistedHostingStore;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedHostingStore;
    } catch {
      // A half-written file is a torn read: keep what this process has, and the
      // next write replaces it.
      return;
    }
    clock = parsed.clock;
    sequence = parsed.sequence;
    apps.clear();
    for (const app of parsed.apps) {
      apps.set(app.appRef, {
        ...app,
        transitions: app.transitions.map((t) => ({ at: new Date(t.at), running: t.running })),
      });
    }
    shapes.clear();
    for (const made of parsed.shapes) shapes.set(made.releaseId, made);
  }

  /** Write this process's state to the shared file. */
  function saveShared(path: string): void {
    const out: PersistedHostingStore = {
      clock,
      sequence,
      apps: [...apps.values()].map((app) => ({
        ...app,
        transitions: app.transitions.map((t) => ({ at: t.at.toISOString(), running: t.running })),
      })),
      shapes: [...shapes.values()],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(out), 'utf8');
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

  function injectedFailure(operation: FakeFailableOperation): void {
    if (!failing.has(operation)) return;
    const message = failing.get(operation);
    failing.delete(operation);
    throw new OrchestratorApiError('fake', 503, message ?? `injected ${operation} failure`);
  }

  const now = () => new Date(clock);

  function appOf(appRef: string): FakeHostedApp {
    const app = apps.get(appRef);
    if (!app) throw new OrchestratorApiError('fake', 404, `app ${appRef} does not exist`);
    return app;
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
    const shaped = shapes.get(releaseId);
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
    if (shape === 'container' && input.idle.mode === 'suspend') {
      throw new IdlePolicyUnsupportedError(target, shape, input.idle.mode);
    }
    return shape;
  }

  function release(
    input: DeployReleaseInput,
    shape: ReleaseShape | undefined,
    releaseId?: string,
  ): FakeHostedRelease {
    if (!releaseId) sequence += 1;
    const { artifact } = input;
    const image =
      artifact.kind === 'image' && artifact.digest
        ? `${artifact.ref}@${artifact.digest}`
        : artifact.ref;
    const made: FakeHostedRelease = {
      releaseId: releaseId ?? `rel-${sequence}`,
      environment: input.environment,
      image,
      runtime: input.runtime,
      env: Object.fromEntries(input.env.map((v) => [v.name, v.value])),
      ...(shape ? { shape, ...(input.size ? { size: input.size } : {}) } : {}),
    };
    shapes.set(made.releaseId, made);
    return made;
  }

  const port: HostingDeployPort & FakeHostingControls = {
    target,
    mintedFor,
    calls,
    now,
    advanceSeconds(seconds) {
      clock += seconds * 1000;
    },
    setHealth(appRef, health) {
      appOf(appRef).health = health;
    },
    idleStop(appRef) {
      setRunning(appOf(appRef), false);
    },
    wake(appRef) {
      setRunning(appOf(appRef), true);
    },
    app: (appRef) => apps.get(appRef),
    failNext(operation, message) {
      failing.set(operation, message);
    },
    setReleaseCommandResult(result) {
      commandResult = result;
    },
    setAccountReady(ready) {
      accountReady = ready;
    },

    async ensureApp({ repositoryId, environment }) {
      if (refused.has(repositoryId)) throw new CustomerRepositoryRefusedError(repositoryId);
      const names = hostingAppNames(prefix, repositoryId, environment);
      if (!apps.has(names.appRef)) {
        apps.set(names.appRef, {
          ...names,
          environment,
          live: null,
          previous: null,
          pending: null,
          health: 'deploying',
          running: false,
          transitions: [],
        });
      }
      return names;
    },

    async mintDeployCredential({ pushNamespace }) {
      mintedFor.push(pushNamespace);
      return {
        kind: 'secret',
        pushNamespace,
        value: `fake-deploy-token-${pushNamespace}`,
        expiresAt: new Date(clock + 90 * 86_400_000),
      };
    },

    async deploy(input) {
      injectedFailure('deploy');
      // As the serverless adapter: its manifest refusals come before anything
      // else, so a refused release finds no app and creates nothing.
      if (target === 'serverless') assertServerlessRuntime(input.runtime);
      const shape = shapeOf(input);
      const app = appOf(input.appRef);
      if (!sameEnvironment(app.environment, input.environment)) {
        throw new OrchestratorApiError('fake', 409, `app ${app.appRef} is another environment's`);
      }
      // A deploy held for the account resumes as the SAME release: the repeat
      // reuses the held release's id, so a resumed run never makes a second.
      const next = release(input, shape, app.pending?.releaseId);
      if (target === 'aws' && !accountReady) {
        app.pending = next;
        return handleFor(app, next);
      }
      app.pending = null;
      app.previous = app.live;
      app.live = next;
      app.health = 'healthy';
      setRunning(app, true);
      return handleFor(app, next);
    },

    async describe(handle): Promise<ReleaseDescription> {
      const app = apps.get(handle.appRef);
      if (app?.pending) {
        return {
          state: 'waiting_for_account',
          releaseId: app.pending.releaseId,
          previousReleaseId: app.live?.releaseId ?? null,
          upstreamAddress: null,
          originCredential: originCredentialFor(target, app.pending.shape),
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
        upstreamAddress: upstreamFor(app.appRef, app.live.shape),
        // As the real adapters: a Fly release sits behind the origin-secret
        // guard (MOTIR-9947), a serverless one behind a SigV4-signed function
        // URL (MOTIR-9972), an AWS release behind its shape's credential.
        originCredential: originCredentialFor(target, app.live.shape),
      };
    },

    async rollback({ appRef }) {
      const app = appOf(appRef);
      if (!app.live) throw new ReleaseNotFoundError(appRef);
      if (!app.previous) throw new NoPreviousReleaseError(appRef);
      const restored = app.previous;
      app.previous = app.live;
      app.live = restored;
      setRunning(app, true);
      return handleFor(app, restored);
    },

    async usageSince(handle, since) {
      return usage(appOf(handle.appRef), handle.releaseId, since);
    },

    async destroy(handle) {
      injectedFailure('destroy');
      const app = apps.get(handle.appRef);
      if (!app || !app.live) {
        if (app) app.pending = null;
        return usageRecord(handle.appRef, handle.releaseId, now(), now(), 0);
      }
      const first = app.transitions[0]?.at ?? now();
      const result = usage(app, handle.releaseId, first);
      setRunning(app, false);
      app.live = null;
      app.previous = null;
      return result;
    },

    async destroyApp({ appRef }) {
      injectedFailure('destroyApp');
      const app = apps.get(appRef);
      apps.delete(appRef);
      if (!app?.live) return [];
      return [usage(app, app.live.releaseId, app.transitions[0]?.at ?? now())];
    },

    async listReleases({ appRef }): Promise<ReleaseSummary[]> {
      const app = apps.get(appRef);
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
      appOf(appRef);
      injectedFailure('runReleaseCommand');
      return commandResult;
    },
  };

  // The call log wraps every operation, so a test can assert their ORDER — the
  // migration before the deploy — without each operation logging itself.
  const operations: FakeHostingOperation[] = [
    'ensureApp',
    'mintDeployCredential',
    'deploy',
    'describe',
    'rollback',
    'usageSince',
    'destroy',
    'destroyApp',
    'listReleases',
    'runReleaseCommand',
  ];
  const record = port as unknown as Record<FakeHostingOperation, (input: unknown) => unknown>;
  for (const operation of operations) {
    const inner = record[operation].bind(port);
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
      if (!path) return (inner as (...args: unknown[]) => unknown)(input, ...rest);
      return (async () => {
        await awaitRelease(path, operation);
        loadShared(path);
        try {
          return await (inner as (...args: unknown[]) => Promise<unknown>)(input, ...rest);
        } finally {
          saveShared(path);
        }
      })();
    };
  }
  return port;
}
