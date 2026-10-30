// The composition root of the HOSTING DEPLOY PORT. A module of its own, beside
// `./index`, because it loads no database: the operator deploy check
// (`pnpm hosting:deploy-check`, MOTIR-9805) runs from a laptop with only the Fly
// token set. `./index` re-exports everything here.
import {
  AWS_MANAGEMENT_ENV,
  createFakeHostingDeployPort,
  createFlyHostingDeployPort,
  createServerlessHostingDeployPort,
  fakeHostingPortKey,
  flyHostingConfig,
  OrchestratorNotConfiguredError,
  serverlessHostingConfig,
  type FakeHostingControls,
  type HostingDeployPort,
  type HostingDeployTarget,
  type ReleaseUsage,
  type ServerlessSourceCredentials,
} from '@motir/orchestrator';
import { createConfiguredAwsHostingPort } from './awsHosting';
import { selectedOrchestratorProvider } from './provider';

// ── The HOSTING DEPLOY PORT (Story MOTIR-9791 · MOTIR-5773) ─────────────────
//
// One port for a hosted app's releases, keyed by the repository's hosting
// TARGET (MOTIR-9808). The fake while `MOTIR_FLEET_ORCHESTRATOR=fake`, so a suite
// that selects the fake gets every fake; Fly's adapter otherwise, with its OWN
// token (`MOTIR_HOSTING_FLY_API_TOKEN`, read at call time); the serverless one
// with its scoped role (`MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN`, MOTIR-9972); any
// other target through a registry, so the AWS adapter lands as one file and one
// `registerHostingAdapter` call rather than a second port.

/** How a caller narrows the adapter it gets. `appPrefix` replaces the target's
 *  configured app-name prefix, so a caller that owns its own apps (the operator
 *  deploy check, `motir-deploy-check-`) cannot name a tenant's (MOTIR-9805). */
export interface HostingPortOptions {
  readonly appPrefix?: string;
}

/** Builds a target's adapter, at call time. */
export type HostingAdapterFactory = (options: HostingPortOptions) => HostingDeployPort;

const hostingAdapters = new Map<HostingDeployTarget, HostingAdapterFactory>();
const hostingFakes = new Map<string, HostingDeployPort>();

/** Register (or replace) the adapter for a target. */
export function registerHostingAdapter(
  target: HostingDeployTarget,
  factory: HostingAdapterFactory,
): void {
  hostingAdapters.set(target, factory);
}

/** Forget a registration — for tests. */
export function unregisterHostingAdapter(target: HostingDeployTarget): void {
  hostingAdapters.delete(target);
}

/** What the composition root does with the usage a destroyed app returns —
 *  the preview meter's final slice (MOTIR-5777). It must never throw: the app
 *  is already gone when it runs. */
export type HostingDestroyAppObserver = (input: {
  target: HostingDeployTarget;
  appRef: string;
  usage: readonly ReleaseUsage[];
}) => Promise<unknown>;

let destroyAppObserver: HostingDestroyAppObserver | null = null;

/** Bind (or, with null, unbind) the observer of every port's `destroyApp`.
 *  `./index` binds the preview meter; this module loads no database. */
export function observeHostingDestroyApp(observer: HostingDestroyAppObserver | null): void {
  destroyAppObserver = observer;
}

/** Route `port`'s `destroyApp` result through the observer bound at CALL time.
 *  In place, so a cached fake keeps its identity (and a test's spies). */
function observed(target: HostingDeployTarget, port: HostingDeployPort): HostingDeployPort {
  const destroyApp = port.destroyApp.bind(port);
  port.destroyApp = async (input) => {
    const usage = await destroyApp(input);
    if (destroyAppObserver) await destroyAppObserver({ target, appRef: input.appRef, usage });
    return usage;
  };
  return port;
}

/** The deploy port for a target, or the typed not-configured error. */
export function getHostingDeployPort(
  target: HostingDeployTarget,
  options: HostingPortOptions = {},
): HostingDeployPort {
  const { appPrefix } = options;
  if (selectedOrchestratorProvider() === 'fake') {
    // The fake's own store key, so a shared slice and this cache cannot drift.
    const key = fakeHostingPortKey(target, appPrefix);
    let fake = hostingFakes.get(key);
    if (!fake) {
      fake = observed(
        target,
        createFakeHostingDeployPort({ target, ...(appPrefix ? { appPrefix } : {}) }),
      );
      hostingFakes.set(key, fake);
    }
    return fake;
  }
  return observed(target, buildHostingAdapter(target, options));
}

function buildHostingAdapter(
  target: HostingDeployTarget,
  options: HostingPortOptions,
): HostingDeployPort {
  const { appPrefix } = options;
  const registered = hostingAdapters.get(target);
  if (registered) return registered(options);
  if (target === 'fly') {
    return createFlyHostingDeployPort({
      ...flyHostingConfig(),
      ...(appPrefix ? { appPrefix } : {}),
    });
  }
  if (target === 'serverless') {
    return createServerlessHostingDeployPort(
      { ...serverlessHostingConfig(), ...(appPrefix ? { appPrefix } : {}) },
      { sourceCredentials: serverlessSourceCredentials() },
    );
  }
  throw new OrchestratorNotConfiguredError(`no ${target} hosting adapter is registered`);
}

/**
 * Who assumes the serverless account's scoped role. On the app it is Motir's
 * management key and the role it assumes there (`motir-add-shard`), which the
 * scoped role trusts (MOTIR-9970); unset, the SDK's default chain — an operator's
 * own profile on a laptop. Read here, at the composition root, so the adapter
 * itself reads only its role and region.
 */
function serverlessSourceCredentials(): ServerlessSourceCredentials | null {
  const read = (name: string) => process.env[name]?.trim() ?? '';
  const accessKeyId = read(AWS_MANAGEMENT_ENV.accessKeyId);
  const secretAccessKey = read(AWS_MANAGEMENT_ENV.secretAccessKey);
  if (!accessKeyId || !secretAccessKey) return null;
  const roleArn = read(AWS_MANAGEMENT_ENV.roleArn);
  return { accessKeyId, secretAccessKey, ...(roleArn ? { roleArn } : {}) };
}

const ORIGIN_SECRET_KEY_ENV = 'MOTIR_HOSTING_ORIGIN_SECRET_KEY';

/** The key hosted apps' origin secrets are derived from (MOTIR-9947), for a
 *  caller that must send the secret — a forwarder, or the deploy check's
 *  `probe`. Under the fake an unset key is a fixed stand-in, so a fake run needs
 *  no secret; otherwise unset is the typed not-configured error naming it. */
export function hostingOriginSecretKey(): string {
  const key = process.env[ORIGIN_SECRET_KEY_ENV]?.trim();
  if (key) return key;
  if (selectedOrchestratorProvider() === 'fake') return 'fake-origin-secret-key';
  throw new OrchestratorNotConfiguredError(`set ${ORIGIN_SECRET_KEY_ENV}`);
}

/** The `aws` target's adapter (MOTIR-10010), built from this deployment's
 *  configuration at call time; registered below. Its app names are fixed by the
 *  tenant stacks (`mh-`), so a narrowed prefix does not apply to it. */
export const awsHostingAdapter: HostingAdapterFactory = () =>
  createConfiguredAwsHostingPort(hostingOriginSecretKey());

registerHostingAdapter('aws', awsHostingAdapter);

/**
 * The fake this process's port IS, with its controls (Story MOTIR-5766 ·
 * MOTIR-10098) — so an E2E spec arranges and inspects the preview hosting the
 * app server and the job worker act on, through the fake's own API rather than
 * its store file. The very object `getHostingDeployPort` hands back; the typed
 * not-configured error when the orchestrator is not the fake.
 */
export function hostingFakeControls(
  target: HostingDeployTarget,
  options: HostingPortOptions = {},
): HostingDeployPort & FakeHostingControls {
  if (selectedOrchestratorProvider() !== 'fake') {
    throw new OrchestratorNotConfiguredError(
      'hosting fake controls exist only while MOTIR_FLEET_ORCHESTRATOR=fake',
    );
  }
  return getHostingDeployPort(target, options) as HostingDeployPort & FakeHostingControls;
}

/** Drop the per-target fakes — for tests. */
export function resetHostingFakes(): void {
  hostingFakes.clear();
}
