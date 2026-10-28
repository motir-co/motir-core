import { vi } from 'vitest';
import {
  createFakeHostingDeployPort,
  createFlyHostingDeployPort,
  createServerlessHostingDeployPort,
  type HostingApp,
  type HostingDeployPort,
  type OriginCredentialKind,
} from '../../src/index';
import { createHostingFlySim, flyJson } from './hostingFlySim';
import { SIM_ACCOUNT, SIM_REGION, createLambdaSim, type LambdaSim } from './hostingLambdaSim';

// The hosting deploy port's ADAPTER HARNESSES (MOTIR-9806 · MOTIR-9972), shared by
// the contract (`../deployPortContract.test.ts`) and the story gate
// (`../storyGate.test.ts`, MOTIR-9976), which asserts this list is exactly the
// adapters the contract runs. A new adapter joins by adding ONE entry to
// `ADAPTERS`.

export interface ProviderRuntime {
  readonly image: string;
  readonly port: number;
  readonly healthCheckPath: string;
}

/** What differs by target and is not the port's to fix (MOTIR-9972). */
export interface TargetFacts {
  /** An image the target runs: Fly any registry, serverless only its own ECR. */
  readonly image: { readonly ref: string; readonly digest: string };
  /** The id of an app's first release: Fly's are minted, Lambda's are versions. */
  readonly firstReleaseId: string;
  readonly originCredential: OriginCredentialKind;
  /** The address a release of `appRef` is reached at. */
  upstream(appRef: string): RegExp;
  /** The push namespace every preview of the production unit's repository shares. */
  previewNamespace(production: HostingApp): string;
}

export const FLY_FACTS: TargetFacts = {
  image: { ref: 'docker.io/traefik/whoami', digest: 'sha256:abc' },
  firstReleaseId: 'rel-1',
  // Every Fly release is reached only through its origin-secret guard.
  originCredential: 'origin_secret',
  upstream: (appRef) => new RegExp(`^https://${appRef}\\.`),
  previewNamespace: (production) => `${production.appRef}-pv`,
};

export interface HostingHarness {
  readonly port: HostingDeployPort;
  readonly facts: TargetFacts;
  advanceSeconds(seconds: number): void;
  /** The provider refuses the next destroy (of a release or of an app) for `appRef`
   *  once, destroying nothing. */
  failNextDestroy(appRef: string, operation: 'destroy' | 'destroyApp'): void;
  /** What the provider was told to run in that app now. */
  runtimeOf(appRef: string): ProviderRuntime | null;
}

export const START = Date.parse('2026-10-28T00:00:00.000Z');
export const PREFIX = 'mh-';

export function fakeHarness(): HostingHarness {
  const fake = createFakeHostingDeployPort({ appPrefix: PREFIX, start: new Date(START) });
  return {
    port: fake,
    facts: FLY_FACTS,
    advanceSeconds: (s) => fake.advanceSeconds(s),
    failNextDestroy: (_appRef, operation) => fake.failNext(operation),
    runtimeOf(appRef) {
      const live = fake.app(appRef)?.live;
      return live
        ? {
            image: live.image,
            port: live.runtime.port,
            healthCheckPath: live.runtime.healthCheck.path,
          }
        : null;
    },
  };
}

export function flyHarness(): HostingHarness {
  let clock = START;
  let ids = 0;
  const sim = createHostingFlySim(() => clock);
  vi.stubGlobal('fetch', sim.fetch);
  const port = createFlyHostingDeployPort(
    {
      token: 'hosting-token',
      org: 'motir-hosting',
      region: 'iad',
      appPrefix: PREFIX,
      guardImage: 'registry.fly.io/motir-hosting-guard@sha256:guard',
      originSecretKey: 'origin-key',
    },
    { now: () => new Date(clock), newReleaseId: () => `rel-${(ids += 1)}` },
  );
  return {
    port,
    facts: FLY_FACTS,
    advanceSeconds: (s) => {
      clock += s * 1000;
    },
    failNextDestroy(appRef, operation) {
      const target =
        operation === 'destroy'
          ? (path: string) => path.startsWith(`/apps/${appRef}/machines/`)
          : (path: string) => path === `/apps/${appRef}`;
      let pending = true;
      sim.overrides.push((call) => {
        if (!pending || call.method !== 'DELETE' || !target(call.path)) return null;
        pending = false;
        return flyJson(503, { error: 'unavailable' });
      });
    },
    runtimeOf(appRef) {
      const config = sim.apps.get(appRef)?.[0]?.config;
      if (!config) return null;
      // The app container and the port its guard forwards to: the service
      // itself is the guard's (MOTIR-9947), never the app's.
      const containers = config['containers'] as Array<Record<string, unknown>>;
      const app = containers.find((c) => c['name'] === 'app')!;
      const guard = containers.find((c) => c['name'] === 'guard')!;
      const health = (config['checks'] as Record<string, Record<string, unknown>>)['health']!;
      return {
        image: String(app['image']),
        port: Number((guard['env'] as Record<string, string>)['MOTIR_GUARD_APP_PORT']),
        healthCheckPath: String(health['path']),
      };
    },
  };
}

export function serverlessHarness(): HostingHarness & { readonly sim: LambdaSim } {
  let clock = START;
  const sim = createLambdaSim(() => clock);
  const port = createServerlessHostingDeployPort(
    {
      roleArn: `arn:aws:iam::${SIM_ACCOUNT}:role/motir-hosting-serverless-deploy`,
      accountId: SIM_ACCOUNT,
      region: SIM_REGION,
      appPrefix: PREFIX,
    },
    {
      clientFactory: sim.clientFactory,
      now: () => new Date(clock),
      sleep: async () => {},
    },
  );
  return {
    sim,
    port,
    facts: {
      image: {
        ref: `${SIM_ACCOUNT}.dkr.ecr.${SIM_REGION}.amazonaws.com/mh/cmrepo1/production`,
        digest: 'sha256:abc',
      },
      // A release is a published Lambda version.
      firstReleaseId: '1',
      // The upstream is a function URL with IAM auth.
      originCredential: 'aws_sigv4',
      upstream: () => /^https:\/\/[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws\/$/,
      previewNamespace: (production) => production.pushNamespace.replace(/production$/, 'preview'),
    },
    advanceSeconds: (s) => {
      sim.advanceSeconds(s);
      clock += s * 1000;
    },
    failNextDestroy(appRef) {
      // Both a release's and an app's destroy delete the function first.
      sim.failNext('DeleteFunctionCommand', (input) => input['FunctionName'] === appRef);
    },
    runtimeOf(appRef) {
      const live = sim.liveSnapshot(appRef);
      return live
        ? {
            image: live.imageUri,
            port: Number(live.variables['AWS_LWA_PORT']),
            healthCheckPath: String(live.variables['AWS_LWA_READINESS_CHECK_PATH']),
          }
        : null;
    },
  };
}

export const ADAPTERS: ReadonlyArray<readonly [string, () => HostingHarness]> = [
  ['fake', fakeHarness],
  ['fly', flyHarness],
  ['serverless', serverlessHarness],
];
