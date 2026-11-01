import { vi } from 'vitest';
import {
  createFakeHostingDeployPort,
  createFlyHostingDeployPort,
  createServerlessHostingDeployPort,
  type HostingDeployPort,
  type OriginCredentialKind,
  type ReleaseIdlePolicy,
  type ReleaseShape,
} from '../../src/index';
import { AWS_ACCOUNT, AWS_CUSTOMER, AWS_REGION, awsAdapterHarness } from './awsHostingHarness';
import { createHostingFlySim, flyJson } from './hostingFlySim';
import { SIM_ACCOUNT, SIM_REGION, createLambdaSim, type LambdaSim } from './hostingLambdaSim';

// The hosting deploy port's ADAPTER HARNESSES (MOTIR-9806 · MOTIR-9972 ·
// MOTIR-10012), shared by the contract (`../deployPortContract.test.ts`) and the
// serverless story gate (`../storyGate.test.ts`, MOTIR-9976), which asserts this
// list is exactly the adapters the contract runs. A new adapter joins by adding
// ONE entry to `ADAPTERS`.

/** The repository every contract case deploys. */
export const R = 'cmrepo1';
export const CUSTOMER = AWS_CUSTOMER;
export const IMAGE = { ref: 'docker.io/traefik/whoami', digest: 'sha256:abc' };
const PINNED_IMAGE = `${IMAGE.ref}@${IMAGE.digest}`;
const SERVERLESS_IMAGE = {
  ref: `${SIM_ACCOUNT}.dkr.ecr.${SIM_REGION}.amazonaws.com/mh/${R}/production`,
  digest: 'sha256:abc',
};

/** Fly's and the fake's address: the app's own name under the target's host. */
function namedHost(appRef: string): RegExp {
  return new RegExp(`^https://${appRef}\\.`);
}

export interface ProviderRuntime {
  readonly image: string;
  readonly port: number;
  readonly healthCheckPath: string;
}

export interface HostingHarness {
  readonly port: HostingDeployPort;
  /** How the address of a release of `appRef` reads. */
  upstream(appRef: string): RegExp;
  /** The image a release deploys, where the target runs only its own registry's
   *  (serverless); `IMAGE` otherwise. */
  readonly image?: { readonly ref: string; readonly digest: string };
  /** The image reference the provider runs for that image in `R`'s production. */
  readonly runsImage: string;
  /** The AWS shape every release in this run takes; absent off AWS. */
  readonly shape?: ReleaseShape;
  /** The idle policy this harness's releases ask for. */
  readonly idle: ReleaseIdlePolicy;
  /** What a forwarder must send to reach this harness's releases. */
  readonly originCredential: OriginCredentialKind;
  advanceSeconds(seconds: number): void;
  /** The provider refuses the next destroy (of a release or of an app) for `appRef`
   *  once, destroying nothing. */
  failNextDestroy(appRef: string, operation: 'destroy' | 'destroyApp'): void;
  /** What the provider was told to run in that app now. */
  runtimeOf(appRef: string): ProviderRuntime | null;
  /** The next release command ends with `exitCode` (MOTIR-10030). Absent where
   *  the target runs no release command and refuses it by name. */
  commandExits?(exitCode: number): void;
}

export const START = Date.parse('2026-10-28T00:00:00.000Z');
export const PREFIX = 'mh-';

export const SUSPEND: ReleaseIdlePolicy = { mode: 'suspend', idleSeconds: 300 };

export function fakeHarness(): HostingHarness {
  const fake = createFakeHostingDeployPort({ appPrefix: PREFIX, start: new Date(START) });
  return {
    port: fake,
    upstream: namedHost,
    runsImage: PINNED_IMAGE,
    idle: SUSPEND,
    originCredential: 'origin_secret',
    advanceSeconds: (s) => fake.advanceSeconds(s),
    failNextDestroy: (_appRef, operation) => fake.failNext(operation),
    commandExits: (exitCode) => fake.setReleaseCommandResult({ exitCode, timedOut: false }),
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

export type FakeAwsHarness = HostingHarness & {
  readonly fake: ReturnType<typeof createFakeHostingDeployPort>;
};

/** The fake, built as the AWS target, deploying one shape. */
export function fakeAwsHarness(shape: ReleaseShape): FakeAwsHarness {
  const fake = createFakeHostingDeployPort({
    target: 'aws',
    appPrefix: PREFIX,
    start: new Date(START),
    refuseRepositories: [CUSTOMER],
  });
  return {
    port: fake,
    upstream: namedHost,
    runsImage: PINNED_IMAGE,
    fake,
    shape,
    idle: shape === 'container' ? { mode: 'always_on' } : SUSPEND,
    originCredential: shape === 'function' ? 'aws_sigv4' : 'origin_secret',
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
    upstream: namedHost,
    runsImage: PINNED_IMAGE,
    idle: SUSPEND,
    originCredential: 'origin_secret',
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
    commandExits: (exitCode) => {
      sim.exitCodes.push(exitCode);
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

/** The real AWS adapter on the fake tenant account, deploying one shape. A
 *  provider destroy failure is the release (or database) stack's delete
 *  refused once, before anything is deleted. */
export function awsHarness(shape: ReleaseShape): HostingHarness {
  const h = awsAdapterHarness({ start: new Date(START) });
  return {
    port: h.port,
    shape,
    idle: shape === 'container' ? { mode: 'always_on' } : SUSPEND,
    originCredential: shape === 'function' ? 'aws_sigv4' : 'origin_secret',
    // A function URL is a host AWS generates; a container answers on the
    // account's load balancer.
    upstream: () =>
      shape === 'function'
        ? new RegExp(`^https://[0-9a-f]{32}\\.lambda-url\\.${AWS_REGION}\\.on\\.aws/$`)
        : new RegExp(`^https?://motir-tenant-1\\.${AWS_REGION}\\.elb\\.amazonaws\\.com`),
    runsImage: `${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/mh/${R}/production@${IMAGE.digest}`,
    advanceSeconds: (s) => h.advanceSeconds(s),
    failNextDestroy: () => h.fakes.cloudformation.failAt('deleteStack', 1),
    runtimeOf(appRef) {
      const parameters = h.fakes.cloudformation.stacks.get(`motir-release-${appRef}`)?.parameters;
      if (!parameters?.['ConfigHash']) return null;
      return {
        image: parameters['ImageUri']!,
        port: Number(parameters['Port']),
        healthCheckPath: parameters['HealthCheckPath']!,
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
    // Lambda runs only an image in the serverless account's own registry.
    image: SERVERLESS_IMAGE,
    runsImage: `${SERVERLESS_IMAGE.ref}@${SERVERLESS_IMAGE.digest}`,
    idle: SUSPEND,
    // The upstream is a function URL with IAM auth.
    originCredential: 'aws_sigv4',
    upstream: () => /^https:\/\/[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws\/$/,
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
  ['fake-aws-function', () => fakeAwsHarness('function')],
  ['fake-aws-container', () => fakeAwsHarness('container')],
  ['aws function', () => awsHarness('function')],
  ['aws container', () => awsHarness('container')],
];
