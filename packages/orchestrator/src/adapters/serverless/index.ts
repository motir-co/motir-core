import { OrchestratorApiError } from '../../errors';
import { NoPreviousReleaseError, ReleaseNotFoundError } from '../../hosting/errors';
import type {
  DeployCredential,
  HostingDeployPort,
  ReleaseDescription,
  ReleaseHandle,
  ReleaseState,
  ReleaseSummary,
  ReleaseUsage,
} from '../../hosting/types';
import {
  createServerlessAwsApi,
  type LambdaFunctionView,
  type ServerlessAwsApi,
  type ServerlessClientDeps,
} from './client';
import type { ServerlessHostingConfig } from './config';
import { lambdaEnvironment } from './env';
import {
  SERVERLESS_LIVE_ALIAS,
  SERVERLESS_TAGS,
  environmentLabel,
  environmentOfLabel,
  execRoleArn,
  logGroupName,
  overflowSecretName,
  pushRoleArn,
  serverlessAppNames,
  unitOf,
} from './names';
import { assertServerlessRunnable } from './preflight';
import { computeSecondsOf, metricPeriodSeconds } from './usage';

export * from './config';
export * from './sign';
export { SERVERLESS_TAGS, SERVERLESS_LIVE_ALIAS } from './names';
export { LAMBDA_ENV_LIMIT_BYTES, SERVERLESS_ENV_SECRET_VAR } from './env';
export type {
  ServerlessAwsService,
  ServerlessClientDeps,
  ServerlessSdkClient,
  ServerlessSdkClientFactory,
  ServerlessSourceCredentials,
} from './client';

// The SERVERLESS adapter of the HOSTING DEPLOY PORT (Story MOTIR-9793 ·
// MOTIR-9972), to the decision of record MOTIR-5769 §3–§4 (page
// cmvrcywwc00jkhpr1zvvnike8, v1): AWS Lambda with function URLs in Motir's own
// account `motir-hosting-serverless`, running the repository's one OCI image
// through the AWS Lambda Web Adapter.
//
// The units: function `mh-<rid>` for production and `mh-<rid>-pr<n>` per preview
// (the port's `appRef`); images in ECR `mh/<rid>/production` and
// `mh/<rid>/preview`. A release is a PUBLISHED VERSION of the function and the
// alias `live` is the one thing a request reaches, through the function URL on
// it (`AuthType AWS_IAM`), so the address never changes across releases.
//
// ⚠️ THE ADAPTER HOLDS NO STORE. Rollback state lives on the provider: the
// version `live` points at, and a function tag with the version it replaced. A
// deploy orders its writes so a failure leaves the old release live —
// configuration, then code, then publish, then the tag, and the alias LAST — and
// Lambda publishes nothing new for unchanged code and configuration, so a
// retried deploy that finds its version already live is a no-op.
//
// ⚠️ USAGE IS METERED COMPUTE (`./usage`), not a start/stop history: Lambda keeps
// none. And `destroy` reads it BEFORE it deletes anything — a read that fails
// throws and deletes nothing, so there is no destroy that does not produce usage.

/** The decision page's function size: 1,769 MB, one full vCPU (§4). */
export const SERVERLESS_MEMORY_MB = 1769;
/** The longest a request may run. */
export const SERVERLESS_TIMEOUT_SECONDS = 60;
/** How long a deploy waits for Lambda to finish one update. */
const UPDATE_WAIT_ATTEMPTS = 60;
const UPDATE_WAIT_MS = 2_000;

export interface ServerlessHostingDeps extends ServerlessClientDeps {
  /** The adapter's AWS calls; built from the config when absent. */
  readonly api?: ServerlessAwsApi;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Lambda's function state → the port's closed release state. */
export function serverlessReleaseState(state: string, lastUpdateStatus: string): ReleaseState {
  if (state === 'Failed' || lastUpdateStatus === 'Failed') return 'unhealthy';
  if (state === 'Inactive') return 'stopped';
  if (state === 'Active' && lastUpdateStatus === 'Successful') return 'healthy';
  return 'deploying';
}

/** The start command as the image's argv — no shell, like the Fly target. */
function argvOf(command: string): string[] {
  return command.trim().split(/\s+/);
}

const DESTROYED: ReleaseDescription = {
  state: 'destroyed',
  releaseId: null,
  previousReleaseId: null,
  upstreamAddress: null,
  originCredential: 'none',
};

export function createServerlessHostingDeployPort(
  config: ServerlessHostingConfig,
  deps: ServerlessHostingDeps = {},
): HostingDeployPort {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const api = deps.api ?? createServerlessAwsApi(config, deps);

  /** Waits until Lambda has finished the function's last update. */
  async function settled(name: string): Promise<LambdaFunctionView> {
    for (let attempt = 1; ; attempt += 1) {
      const fn = await api.getFunction(name);
      if (!fn)
        throw new OrchestratorApiError('aws', 404, 'lambda: function vanished during deploy');
      const state = serverlessReleaseState(fn.state, fn.lastUpdateStatus);
      if (state === 'healthy' || state === 'stopped') return fn;
      if (state === 'unhealthy') {
        throw new OrchestratorApiError('aws', null, 'lambda: function update failed');
      }
      if (attempt >= UPDATE_WAIT_ATTEMPTS) {
        throw new OrchestratorApiError('aws', null, 'lambda: function did not become active');
      }
      await sleep(UPDATE_WAIT_MS);
    }
  }

  /** The function, if it is one of this adapter's releases. */
  async function releaseFunction(appRef: string): Promise<LambdaFunctionView | null> {
    const fn = await api.getFunction(appRef);
    return fn && fn.tags[SERVERLESS_TAGS.marker] === 'release' ? fn : null;
  }

  function handleOf(fn: LambdaFunctionView, releaseId: string): ReleaseHandle {
    return {
      target: 'serverless',
      appRef: fn.name,
      environment: environmentOfLabel(fn.tags[SERVERLESS_TAGS.environment]),
      releaseId,
      providerRef: fn.name,
    };
  }

  function createdAtOf(fn: LambdaFunctionView): Date | null {
    const at = Date.parse(fn.tags[SERVERLESS_TAGS.createdAt] ?? '');
    return Number.isNaN(at) ? null : new Date(at);
  }

  async function usageOf(
    handle: ReleaseHandle,
    fn: LambdaFunctionView | null,
    since: Date | null,
  ): Promise<ReleaseUsage> {
    const until = now();
    const from = since ?? (fn ? createdAtOf(fn) : null) ?? until;
    const base = {
      target: 'serverless' as const,
      appRef: handle.appRef,
      releaseId: handle.releaseId,
    };
    if (!fn || until.getTime() <= from.getTime()) {
      return { ...base, since: from, until, runningSeconds: 0, invocations: 0 };
    }
    const sums = await api.metricSums(
      fn.name,
      from,
      until,
      metricPeriodSeconds(from, until, until),
    );
    return {
      ...base,
      since: from,
      until,
      runningSeconds: computeSecondsOf(sums),
      invocations: Math.round(sums.invocations),
    };
  }

  /** Usage first, then the function and everything that is only its. */
  async function destroyFunction(handle: ReleaseHandle): Promise<ReleaseUsage> {
    const fn = await api.getFunction(handle.appRef);
    const usage = await usageOf(handle, fn, null);
    if (!fn) return usage;
    await api.deleteFunction(fn.name);
    await api.deleteLogGroup(logGroupName(fn.name));
    await api.deleteSecret(overflowSecretName(fn.name));
    return usage;
  }

  return {
    target: 'serverless',

    async ensureApp({ repositoryId, environment }) {
      const names = serverlessAppNames(config.appPrefix, repositoryId, environment);
      await api.ensureRepository(names.pushNamespace);
      return names;
    },

    async mintDeployCredential({ pushNamespace }): Promise<DeployCredential> {
      return {
        kind: 'federated',
        pushNamespace,
        subject: pushRoleArn(config.accountId, config.appPrefix, pushNamespace),
      };
    },

    async deploy(input) {
      const imageUri = assertServerlessRunnable(input, config);
      const name = input.appRef;
      const secretName = overflowSecretName(name);
      const environment = lambdaEnvironment(input, secretName);
      if (environment.overflow !== null) await api.putSecret(secretName, environment.overflow);
      const spec = {
        name,
        imageUri,
        roleArn: execRoleArn(config.accountId),
        memoryMb: SERVERLESS_MEMORY_MB,
        timeoutSeconds: SERVERLESS_TIMEOUT_SECONDS,
        command: argvOf(input.runtime.startCommand),
        variables: environment.variables,
      };

      let fn = await api.getFunction(name);
      if (!fn) {
        await api.createFunction(spec, {
          [SERVERLESS_TAGS.marker]: 'release',
          [SERVERLESS_TAGS.environment]: environmentLabel(input.environment),
          [SERVERLESS_TAGS.createdAt]: now().toISOString(),
        });
      } else {
        await settled(name);
        await api.updateFunctionConfiguration(spec);
        await settled(name);
        await api.updateFunctionCode(name, imageUri);
      }
      fn = await settled(name);
      const version = await api.publishVersion(name);
      const live = await api.getAliasVersion(name, SERVERLESS_LIVE_ALIAS);
      if (live !== version) {
        if (live !== null)
          await api.tagFunction(fn.arn, { [SERVERLESS_TAGS.previousVersion]: live });
        await api.putAlias(name, SERVERLESS_LIVE_ALIAS, version, live !== null);
      }
      await api.ensureFunctionUrl(name, SERVERLESS_LIVE_ALIAS);
      return handleOf(fn, version);
    },

    async describe(handle) {
      const fn = await api.getFunction(handle.appRef);
      if (!fn) return DESTROYED;
      const live = await api.getAliasVersion(fn.name, SERVERLESS_LIVE_ALIAS);
      return {
        state: live === null ? 'deploying' : serverlessReleaseState(fn.state, fn.lastUpdateStatus),
        releaseId: live,
        previousReleaseId: fn.tags[SERVERLESS_TAGS.previousVersion] ?? null,
        upstreamAddress: await api.getFunctionUrl(fn.name, SERVERLESS_LIVE_ALIAS),
        originCredential: 'aws_sigv4',
      };
    },

    async rollback({ appRef }) {
      const fn = await releaseFunction(appRef);
      if (!fn) throw new ReleaseNotFoundError(appRef);
      const live = await api.getAliasVersion(appRef, SERVERLESS_LIVE_ALIAS);
      const previous = fn.tags[SERVERLESS_TAGS.previousVersion];
      if (!live || !previous || previous === live) throw new NoPreviousReleaseError(appRef);
      // The swap: the release being replaced becomes the kept one, then `live`
      // moves — the same order as a deploy, so a failure between the two leaves
      // the current release live and a retry finishes the move.
      await api.tagFunction(fn.arn, { [SERVERLESS_TAGS.previousVersion]: live });
      await api.putAlias(appRef, SERVERLESS_LIVE_ALIAS, previous, true);
      return handleOf(fn, previous);
    },

    async usageSince(handle, since) {
      return usageOf(handle, await api.getFunction(handle.appRef), since);
    },

    async destroy(handle) {
      return destroyFunction(handle);
    },

    async destroyApp({ appRef }) {
      const fn = await releaseFunction(appRef);
      const usage = fn
        ? [
            await destroyFunction(
              handleOf(fn, (await api.getAliasVersion(appRef, SERVERLESS_LIVE_ALIAS)) ?? ''),
            ),
          ]
        : [];
      // The ECR repository goes with the last function that runs from it: the
      // production one with production, the preview one with the last preview.
      const unit = unitOf(config.appPrefix, appRef);
      if (unit) {
        const { pushNamespace } = serverlessAppNames(
          config.appPrefix,
          unit.repositoryId,
          unit.environment,
        );
        const previewOf = `${config.appPrefix}${unit.repositoryId}-pr`;
        const sharing =
          unit.environment.kind === 'preview' &&
          (await api.listFunctionNames()).some(
            (name) =>
              name !== appRef &&
              name.startsWith(previewOf) &&
              /^\d+$/.test(name.slice(previewOf.length)),
          );
        if (!sharing) await api.deleteRepository(pushNamespace);
      }
      return usage;
    },

    async listReleases({ appRef }): Promise<ReleaseSummary[]> {
      const fn = await releaseFunction(appRef);
      if (!fn) return [];
      const live = await api.getAliasVersion(appRef, SERVERLESS_LIVE_ALIAS);
      return [
        {
          handle: handleOf(fn, live ?? ''),
          state:
            live === null ? 'deploying' : serverlessReleaseState(fn.state, fn.lastUpdateStatus),
        },
      ];
    },
  };
}
