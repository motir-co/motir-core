import { OrchestratorApiError } from '../../errors';
import {
  CustomerRepositoryRefusedError,
  IdlePolicyUnsupportedError,
  NoPreviousReleaseError,
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
  ReleaseDescription,
  ReleaseHandle,
  ReleaseRuntime,
  ReleaseShape,
  ReleaseSize,
  ReleaseSummary,
  ReleaseUsage,
} from '../../hosting/types';
import { computeUsageFor, runningSecondsBetween, type RunTransition } from '../../hosting/usage';

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
   *  nothing, for the usage-always rule's error path. */
  failNext(operation: 'destroy' | 'destroyApp'): void;
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
}

/** The origin credential a forwarder sends to a release of that target and
 *  shape (MOTIR-5769 §4): Fly's guard and an AWS container's load-balancer rule
 *  check the origin secret; an AWS function URL is IAM-authorised (SigV4). */
function originCredentialFor(
  target: HostingDeployTarget,
  shape: ReleaseShape | undefined,
): OriginCredentialKind {
  if (target === 'fly') return 'origin_secret';
  if (target !== 'aws') return 'none';
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
  const failing = new Set<'destroy' | 'destroyApp'>();
  const refused = new Set(options.refuseRepositories ?? []);
  // Every release's shape, kept past its destroy so a repeated destroy still
  // reports usage in the unit of the release it names.
  const shapes = new Map<string, FakeHostedRelease>();
  let accountReady = true;

  function injectedFailure(operation: 'destroy' | 'destroyApp'): void {
    if (!failing.delete(operation)) return;
    throw new OrchestratorApiError('fake', 503, `injected ${operation} failure`);
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

  return {
    target,
    mintedFor,
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
    failNext(operation) {
      failing.add(operation);
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
        // guard (MOTIR-9947); an AWS release behind its shape's credential.
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
  };
}
