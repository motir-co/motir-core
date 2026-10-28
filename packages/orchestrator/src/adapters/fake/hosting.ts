import { OrchestratorApiError } from '../../errors';
import { NoPreviousReleaseError, ReleaseNotFoundError } from '../../hosting/errors';
import { hostingAppNames, sameEnvironment } from '../../hosting/names';
import type {
  DeployReleaseInput,
  HostingDeployPort,
  HostingDeployTarget,
  HostingEnvironment,
  ReleaseDescription,
  ReleaseHandle,
  ReleaseRuntime,
  ReleaseSummary,
  ReleaseUsage,
} from '../../hosting/types';
import { runningSecondsBetween, type RunTransition } from '../../hosting/usage';

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

export interface FakeHostedRelease {
  readonly releaseId: string;
  readonly environment: HostingEnvironment;
  readonly image: string;
  readonly runtime: ReleaseRuntime;
  readonly env: Readonly<Record<string, string>>;
}

export interface FakeHostedApp {
  readonly appRef: string;
  readonly pushNamespace: string;
  readonly environment: HostingEnvironment;
  live: FakeHostedRelease | null;
  previous: FakeHostedRelease | null;
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
}

export interface FakeHostingOptions {
  readonly target?: HostingDeployTarget;
  readonly appPrefix?: string;
  readonly start?: Date;
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

  function usage(app: FakeHostedApp, releaseId: string, since: Date): ReleaseUsage {
    const until = now();
    return {
      target,
      appRef: app.appRef,
      releaseId,
      since,
      until,
      runningSeconds: runningSecondsBetween(app.transitions, since, until),
    };
  }

  function release(input: DeployReleaseInput): FakeHostedRelease {
    sequence += 1;
    const { artifact } = input;
    const image =
      artifact.kind === 'image' && artifact.digest
        ? `${artifact.ref}@${artifact.digest}`
        : artifact.ref;
    return {
      releaseId: `rel-${sequence}`,
      environment: input.environment,
      image,
      runtime: input.runtime,
      env: Object.fromEntries(input.env.map((v) => [v.name, v.value])),
    };
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

    async ensureApp({ repositoryId, environment }) {
      const names = hostingAppNames(prefix, repositoryId, environment);
      if (!apps.has(names.appRef)) {
        apps.set(names.appRef, {
          ...names,
          environment,
          live: null,
          previous: null,
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
      const app = appOf(input.appRef);
      if (!sameEnvironment(app.environment, input.environment)) {
        throw new OrchestratorApiError('fake', 409, `app ${app.appRef} is another environment's`);
      }
      const next = release(input);
      app.previous = app.live;
      app.live = next;
      app.health = 'healthy';
      setRunning(app, true);
      return handleFor(app, next);
    },

    async describe(handle): Promise<ReleaseDescription> {
      const app = apps.get(handle.appRef);
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
        upstreamAddress: `https://${app.appRef}.fake.invalid`,
        originCredential: 'none',
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
      const app = apps.get(handle.appRef);
      if (!app || !app.live) {
        return {
          target,
          appRef: handle.appRef,
          releaseId: handle.releaseId,
          since: now(),
          until: now(),
          runningSeconds: 0,
        };
      }
      const first = app.transitions[0]?.at ?? now();
      const result = usage(app, handle.releaseId, first);
      setRunning(app, false);
      app.live = null;
      app.previous = null;
      return result;
    },

    async destroyApp({ appRef }) {
      apps.delete(appRef);
    },

    async listReleases({ appRef }): Promise<ReleaseSummary[]> {
      const app = apps.get(appRef);
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
