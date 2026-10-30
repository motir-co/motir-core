import { OrchestratorApiError } from '../../errors';
import {
  CustomerRepositoryRefusedError,
  IdlePolicyUnsupportedError,
  NoPreviousReleaseError,
  ReleaseNotFoundError,
} from '../../hosting/errors';
import { hostingAppNames, pushNamespaceName, sameEnvironment } from '../../hosting/names';
import { requireReleaseShape } from '../../hosting/shape';
import type {
  DeployReleaseInput,
  HostingDeployPort,
  HostingDeployTarget,
  HostingEnvironment,
  OriginCredentialKind,
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
// was.

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
   *  nothing, for the usage-always rule's error path. */
  failNext(operation: FakeHostingFailure): void;
  /** Whether the organisation's AWS tenant account is ready. Ready unless a test
   *  sets it false; while not ready an `aws` deploy waits in
   *  `waiting_for_account`. */
  setAccountReady(ready: boolean): void;
  /** Point an app's live release at `address` — stored as its ORIGIN, the fact
   *  the gate forwards to — or, with null, back at the template address. Moves
   *  the address only: the release's state and origin credential are unchanged.
   *  Refuses a value that is not an absolute http(s) URL, and an unknown app. */
  setUpstream(appRef: string, address: string | null): void;
  /** Forget every app, release, credential and armed failure — in the shared
   *  store too, so a lane's next spec inherits nothing. */
  reset(): void;
}

/** The operations a test can make fail once at the "provider". */
export type FakeHostingFailure =
  | 'destroy'
  | 'destroyApp'
  | 'ensurePushNamespace'
  | 'revokeDeployCredentials';

export interface FakeHostingOptions {
  readonly target?: HostingDeployTarget;
  readonly appPrefix?: string;
  readonly start?: Date;
  /** Repository ids `ensureApp` refuses as customer repositories (D1). */
  readonly refuseRepositories?: readonly string[];
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

export function createFakeHostingDeployPort(
  options: FakeHostingOptions = {},
): HostingDeployPort & FakeHostingControls {
  const target = options.target ?? 'fly';
  const prefix = options.appPrefix ?? 'mh-';
  const key = fakeHostingPortKey(target, options.appPrefix);
  const refused = new Set(options.refuseRepositories ?? []);
  let state: FakeHostingSlice = emptyFakeHostingSlice(options.start);
  // The take-once failures of an UNSHARED fake; a shared one arms the sidecar.
  const failing = new Set<FakeHostingFailure>();

  /** Under the seam, adopt what the file holds — an empty slice when nothing is
   *  stored, because another process may have reset it; a torn file keeps ours. */
  function load(): FakeHostingSlice {
    if (!fakeHostingStatePath()) return state;
    const stored = readFakeHostingSlice(key);
    if (stored === null) state = emptyFakeHostingSlice(options.start);
    else if (stored !== 'torn') state = stored;
    return state;
  }

  /** Persist the slice after a mutation — a no-op with the seam off. */
  function save(): void {
    saveFakeHostingSlice(key, state);
  }

  function injectedFailure(operation: FakeHostingFailure): void {
    const armed = failing.delete(operation);
    if (!armed && takeArmedFakeHostingFailure(key, operation) === null) return;
    throw new OrchestratorApiError('fake', 503, `injected ${operation} failure`);
  }

  const now = () => new Date(state.clock);

  function appOf(appRef: string): FakeHostedApp {
    const app = state.apps[appRef];
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
    if (shape === 'container' && input.idle.mode === 'suspend') {
      throw new IdlePolicyUnsupportedError(target, shape, input.idle.mode);
    }
    return shape;
  }

  /** A new release id — pid-suffixed under the seam, so two processes reading
   *  one store never mint the same one. */
  function nextReleaseId(): string {
    state.sequence += 1;
    return fakeHostingStatePath()
      ? `rel-${process.pid}-${state.sequence}`
      : `rel-${state.sequence}`;
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

  return {
    target,
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
      save();
    },
    app: (appRef) => load().apps[appRef],
    pushNamespaces: () => [...load().namespaces],
    liveCredentials: (pushNamespace) => load().liveTokens[pushNamespace] ?? 0,
    failNext(operation) {
      if (fakeHostingStatePath()) {
        armFakeHostingFailure(key, operation, `injected ${operation} failure`);
      } else {
        failing.add(operation);
      }
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
      resetFakeHostingSnapshot(key);
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
        save();
        return handleFor(app, next);
      }
      app.pending = null;
      app.previous = app.live;
      app.live = next;
      app.health = 'healthy';
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
        upstreamAddress: app.upstreamOverride ?? upstreamFor(app.appRef, app.live.shape),
        // As the real adapters: a Fly release sits behind the origin-secret
        // guard (MOTIR-9947), a serverless one behind a SigV4-signed function
        // URL (MOTIR-9972), an AWS release behind its shape's credential.
        originCredential: originCredentialFor(target, app.live.shape),
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
      save();
      return result;
    },

    async destroyApp({ appRef }) {
      injectedFailure('destroyApp');
      const { apps, namespaces, liveTokens } = load();
      const app = apps[appRef];
      delete apps[appRef];
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
  };
}
