import { OrchestratorApiError } from '../../../errors';
import {
  CustomerRepositoryRefusedError,
  NoPreviousReleaseError,
  ReleaseArtifactUnsupportedError,
  ReleaseCommandUnsupportedError,
  ReleaseNotFoundError,
} from '../../../hosting/errors';
import { hostingAppNames, sameEnvironment } from '../../../hosting/names';
import { requireReleaseShape } from '../../../hosting/shape';
import type {
  DeployReleaseInput,
  HostingDeployPort,
  HostingEnvironment,
  ReleaseArtifact,
  ReleaseDescription,
  ReleaseHandle,
  ReleaseShape,
  ReleaseSummary,
  ReleaseUsage,
} from '../../../hosting/types';
import {
  NoPreviousTaskDefinitionError,
  containerReleaseNames,
  containerUsageSince,
  deployContainerRelease,
  describeContainerRelease,
  destroyContainerRelease,
  rollbackContainerRelease,
} from './container';
import {
  destroyApplicationDatabase,
  dropPreviewDatabase,
  ensureEnvironmentDatabase,
  type EnvironmentDatabaseReference,
} from './database';
import type { TenantClientsFactory } from './factory';
import {
  NoPreviousFunctionVersionError,
  deployFunctionRelease,
  describeFunctionRelease,
  destroyFunctionRelease,
  functionReleaseNames,
  functionUsageSince,
  rollbackFunctionRelease,
} from './function';
import { ensureTenantNetwork, type TenantAccountContext } from './network';
import {
  GithubRepositoryIdsMissingError,
  RegistryNotReadyError,
  ensureRegistry,
  parseRegistryPushNamespace,
  registryDeployCredential,
  registryImageReference,
  registryNames,
  registryPushNamespace,
  type GithubRepositoryIdLookup,
  type RegistryEnvironment,
} from './registry';
import {
  AWS_APP_PREFIX,
  FIRST_RELEASE_NUMBER,
  awsProviderRef,
  awsReleaseId,
  originCredentialOf,
  parseAwsAppRef,
  portReleaseId,
  shapeOfProviderRef,
  shapeOfReleaseStack,
  toReleaseDescription,
  type ParsedAppRef,
} from './releaseIds';
import { TAG_REPOSITORY, createStackRunner, type StackRunnerOptions } from './stackRunner';

// THE AWS ADAPTER on the hosting deploy port (MOTIR-10010), to MOTIR-5769 §4. A
// thin router: every AWS detail is in the tenant modules below it (the network,
// the registry, the database and the two shapes), and every fact about Motir's
// own records — which organisation a repository is, whether it is a customer's,
// its GitHub ids, whether the organisation's tenant account is ready — is an
// injected function, so this package reads no database and no environment.
//
// `deploy` runs in one order: the shape, the customer-repository refusal, the
// tenant account, the network, the registry, the database, then the shape
// module. Waiting for the account is a STATE, not an error: the release is held
// with no AWS call, and the same deploy once the account is ready completes it
// as the same release. Every step below is look-before-act and the adapter keeps
// no state of its own — the stacks are the record — so a repeated or resumed
// deploy reaches the same release.

/** Where an organisation's tenant account stands (the tenant account service's
 *  answer, as much of it as the adapter reads). */
export interface AwsTenantAccountAnswer {
  readonly ready: boolean;
  readonly accountId: string | null;
}

/** One step's structured log line — names and outcomes only, never a value. */
export interface AwsHostingLogLine {
  readonly step: string;
  readonly appRef: string;
  readonly detail?: string;
}

export interface AwsHostingDeps {
  /** The tenant account's clients, all under its deploy role. */
  readonly clientsFor: TenantClientsFactory;
  /** The tenant accounts' region. */
  readonly region: string;
  /** Make sure the organisation's tenant account is asked for, and say whether
   *  it is ready (`hostingTenantAccountService.ensureForOrganization`). */
  readonly ensureTenantAccount: (organizationId: string) => Promise<AwsTenantAccountAnswer>;
  /** The organisation a repository row belongs to. */
  readonly organizationOf: (repositoryId: string) => Promise<string>;
  /** Whether the repository is a customer repository (D1), which is never hosted. */
  readonly isCustomerRepository: (repositoryId: string) => Promise<boolean>;
  /** The GitHub ids the push roles' trust binds. */
  readonly githubIdsOf: GithubRepositoryIdLookup;
  /** The forwarder's IAM principal, the one identity a function URL admits. */
  readonly forwarderPrincipalArn: string;
  /** The host the forwarder sends for an app, which a container's listener
   *  rule matches. */
  readonly appHostOf: (appRef: string) => string;
  /** The key an app's origin secret is derived from (`deriveOriginSecret`). */
  readonly originSecretKey: string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The stack runner's and the container rollout's waits. */
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: AwsHostingLogLine) => void;
}

/** A release that has not reached a shape module: no AWS call, no state. */
function zeroUsage(appRef: string, releaseId: string, at: Date): ReleaseUsage {
  return { target: 'aws', appRef, releaseId, since: at, until: at, runningSeconds: 0 };
}

const DESTROYED: ReleaseDescription = {
  state: 'destroyed',
  releaseId: null,
  previousReleaseId: null,
  upstreamAddress: null,
  originCredential: 'none',
};

const registryEnvironment = (environment: HostingEnvironment): RegistryEnvironment =>
  environment.kind === 'preview' ? 'preview' : 'production';

/** The tag or digest an image artifact is pulled by, from its own registry
 *  repository. A bundle is not something either shape runs. */
function imageOf(artifact: ReleaseArtifact): { digest?: string; tag?: string } {
  if (artifact.kind !== 'image') throw new ReleaseArtifactUnsupportedError('aws', artifact.kind);
  if (artifact.digest) return { digest: artifact.digest };
  return { tag: artifact.ref.slice(artifact.ref.lastIndexOf(':') + 1) };
}

export function createAwsHostingDeployPort(deps: AwsHostingDeps): HostingDeployPort {
  const now = deps.now ?? (() => new Date());
  const log = (step: string, appRef: string, detail?: string) =>
    deps.log?.({ step, appRef, ...(detail ? { detail } : {}) });
  // The waits, with only what the caller set (an absent one is the module's
  // default).
  const waits = Object.fromEntries(
    Object.entries({ sleep: deps.sleep, pollMs: deps.pollMs, timeoutMs: deps.timeoutMs }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as Pick<AwsHostingDeps, 'sleep' | 'pollMs' | 'timeoutMs'>;
  const runnerOptions: StackRunnerOptions = { ...waits, now: () => now().getTime() };
  const rollout = { ...waits, now };

  async function refuseCustomer(repositoryId: string): Promise<void> {
    if (await deps.isCustomerRepository(repositoryId)) {
      throw new CustomerRepositoryRefusedError(repositoryId);
    }
  }

  /** The repository's tenant account, or null while it is not ready. */
  async function accountOf(repositoryId: string): Promise<TenantAccountContext | null> {
    const organizationId = await deps.organizationOf(repositoryId);
    const answer = await deps.ensureTenantAccount(organizationId);
    if (!answer.ready || !answer.accountId) return null;
    const clients = deps.clientsFor({ accountId: answer.accountId, region: deps.region });
    return {
      organizationId,
      clients,
      runner: createStackRunner(clients.cloudformation, runnerOptions),
    };
  }

  /** The app's repository and environment, its account, and its release
   *  stack's shape (null when there is no release stack). */
  async function locate(appRef: string) {
    const parsed = parseAwsAppRef(appRef);
    const { stackName } = functionReleaseNames(parsed.repositoryId, parsed.environment);
    const account = await accountOf(parsed.repositoryId);
    if (!account) return { parsed, account: null, shape: null, stackName };
    const stack = await account.runner.describeStack(stackName);
    const shape = stack ? shapeOfReleaseStack(stack.parameters) : null;
    return { parsed, account, shape, stackName };
  }

  function target(account: TenantAccountContext, parsed: ParsedAppRef) {
    return { account, repositoryId: parsed.repositoryId, environment: parsed.environment };
  }

  async function describeOn(
    account: TenantAccountContext,
    parsed: ParsedAppRef,
    shape: ReleaseShape,
    appRef: string,
  ): Promise<ReleaseDescription> {
    const description =
      shape === 'function'
        ? await describeFunctionRelease(target(account, parsed))
        : await describeContainerRelease({ ...target(account, parsed), ...rollout });
    return toReleaseDescription(shape, appRef, description);
  }

  /** Destroy a preview's database, then the environment's release through its
   *  shape. The release goes LAST: a destroy cut off after it was gone would be
   *  replayed with no release to measure, and its usage lost (MOTIR-10012's
   *  cut-off sweep). Usage comes back whatever is already gone. */
  async function destroyOn(
    account: TenantAccountContext,
    parsed: ParsedAppRef,
    shape: ReleaseShape | null,
    appRef: string,
    releaseId: string,
  ): Promise<ReleaseUsage> {
    const input = { ...target(account, parsed), releaseId };
    if (parsed.environment.kind === 'preview') {
      await dropPreviewDatabase(
        account,
        { repositoryId: parsed.repositoryId, pullRequest: parsed.environment.pullRequest },
        waits,
      );
      log('preview database dropped', appRef);
    }
    let usage: ReleaseUsage;
    if (shape === 'function') usage = await destroyFunctionRelease({ ...input, now });
    else if (shape === 'container') usage = await destroyContainerRelease({ ...input, ...rollout });
    else usage = zeroUsage(appRef, releaseId, now());
    log('release destroyed', appRef, shape ?? 'absent');
    return usage;
  }

  return {
    target: 'aws',

    async ensureApp({ repositoryId, environment }) {
      await refuseCustomer(repositoryId);
      const { appRef } = hostingAppNames(AWS_APP_PREFIX, repositoryId, environment);
      const pushNamespace = registryPushNamespace(repositoryId, registryEnvironment(environment));
      const account = await accountOf(repositoryId);
      if (!account) {
        log('waiting for account', appRef);
        return { appRef, pushNamespace };
      }
      // A repository with no GitHub ids fails before any AWS call.
      const ids = await deps.githubIdsOf(repositoryId);
      if (!ids) throw new GithubRepositoryIdsMissingError(repositoryId);
      await ensureTenantNetwork(account);
      log('network ensured', appRef);
      await ensureRegistry({
        runner: account.runner,
        organizationId: account.organizationId,
        repositoryId,
        lookup: async () => ids,
      });
      log('registry ensured', appRef);
      return { appRef, pushNamespace };
    },

    async ensurePushNamespace({ repositoryId, kind }) {
      await refuseCustomer(repositoryId);
      const pushNamespace = registryPushNamespace(repositoryId, kind);
      const account = await accountOf(repositoryId);
      // The registry lives in the tenant account; until it is ready there is no
      // namespace to name, and the caller retries.
      if (!account) throw new RegistryNotReadyError(registryNames(repositoryId).stackName);
      const ids = await deps.githubIdsOf(repositoryId);
      if (!ids) throw new GithubRepositoryIdsMissingError(repositoryId);
      const { outputs } = await ensureRegistry({
        runner: account.runner,
        organizationId: account.organizationId,
        repositoryId,
        lookup: async () => ids,
      });
      const imageRepository =
        outputs[kind === 'preview' ? 'PreviewRepositoryUri' : 'ProductionRepositoryUri'];
      if (!imageRepository) throw new RegistryNotReadyError(registryNames(repositoryId).stackName);
      log('registry ensured', pushNamespace);
      return { pushNamespace, imageRepository };
    },

    /** Federated: the push roles trust the repository's immutable ids, so there
     *  is no static credential to revoke. */
    async revokeDeployCredentials() {
      return { revoked: 0 };
    },

    async mintDeployCredential({ pushNamespace }) {
      const { repositoryId } = parseRegistryPushNamespace(pushNamespace);
      await refuseCustomer(repositoryId);
      const account = await accountOf(repositoryId);
      if (!account) throw new RegistryNotReadyError(registryNames(repositoryId).stackName);
      return registryDeployCredential({ runner: account.runner, pushNamespace });
    },

    async deploy(input: DeployReleaseInput) {
      const shape = requireReleaseShape('aws', input);
      const parsed = parseAwsAppRef(input.appRef);
      const { appRef } = input;
      if (!sameEnvironment(parsed.environment, input.environment)) {
        throw new OrchestratorApiError('aws', 409, `app ${appRef} is another environment's`);
      }
      const { repositoryId, environment } = parsed;
      await refuseCustomer(repositoryId);
      const image = imageOf(input.artifact);
      const { stackName } = functionReleaseNames(repositoryId, environment);
      const handle = (releaseId: string): ReleaseHandle => ({
        target: 'aws',
        appRef,
        environment,
        releaseId,
        providerRef: awsProviderRef(shape, stackName),
      });

      const account = await accountOf(repositoryId);
      if (!account) {
        log('waiting for account', appRef);
        return handle(awsReleaseId(appRef, FIRST_RELEASE_NUMBER));
      }
      const network = await ensureTenantNetwork(account);
      log('network ensured', appRef);
      const registry = await ensureRegistry({
        runner: account.runner,
        organizationId: account.organizationId,
        repositoryId,
        lookup: deps.githubIdsOf,
      });
      log('registry ensured', appRef);
      const imageUri = registryImageReference({
        account: { accountId: account.clients.accountId, region: account.clients.region },
        repositoryName: registry.names.repositories[registryEnvironment(environment)],
        ...image,
      });
      let database: EnvironmentDatabaseReference | null = null;
      if (input.runtime.database.kind === 'postgres') {
        database = await ensureEnvironmentDatabase(account, { repositoryId, environment }, waits);
        log('database ensured', appRef);
      }

      const common = {
        ...target(account, parsed),
        imageUri,
        idle: input.idle,
        runtime: input.runtime,
        env: input.env,
        database,
      };
      const providerRelease =
        shape === 'function'
          ? (
              await deployFunctionRelease({
                ...common,
                network,
                invokePrincipalArn: deps.forwarderPrincipalArn,
              })
            ).releaseId
          : (
              await deployContainerRelease({
                ...common,
                ...rollout,
                ...(input.size ? { size: input.size } : {}),
                network,
                appHost: deps.appHostOf(appRef),
                originSecretKey: deps.originSecretKey,
              })
            ).releaseId;
      log('release deployed', appRef, shape);
      return handle(portReleaseId(shape, appRef, providerRelease)!);
    },

    async describe(handle) {
      const { parsed, account, shape } = await locate(handle.appRef);
      if (!account) {
        const held = shapeOfProviderRef(handle.providerRef);
        return {
          state: 'waiting_for_account',
          releaseId: handle.releaseId,
          previousReleaseId: null,
          upstreamAddress: null,
          originCredential: held ? originCredentialOf(held) : 'none',
        };
      }
      if (!shape) return DESTROYED;
      return describeOn(account, parsed, shape, handle.appRef);
    },

    async rollback({ appRef, environment }) {
      const { parsed, account, shape, stackName } = await locate(appRef);
      if (!sameEnvironment(parsed.environment, environment)) {
        throw new OrchestratorApiError('aws', 409, `app ${appRef} is another environment's`);
      }
      if (!account || !shape) throw new ReleaseNotFoundError(appRef);
      let providerRelease: string;
      try {
        providerRelease =
          shape === 'function'
            ? (await rollbackFunctionRelease(target(account, parsed))).releaseId
            : (await rollbackContainerRelease({ ...target(account, parsed), ...rollout }))
                .releaseId;
      } catch (err) {
        // The port's one name for "nothing to roll back to", whichever shape.
        if (
          err instanceof NoPreviousFunctionVersionError ||
          err instanceof NoPreviousTaskDefinitionError
        ) {
          throw new NoPreviousReleaseError(appRef);
        }
        throw err;
      }
      log('release rolled back', appRef, shape);
      return {
        target: 'aws',
        appRef,
        environment: parsed.environment,
        releaseId: portReleaseId(shape, appRef, providerRelease)!,
        providerRef: awsProviderRef(shape, stackName),
      };
    },

    async usageSince(handle, since) {
      const { parsed, account, shape } = await locate(handle.appRef);
      const routed = shape ?? shapeOfProviderRef(handle.providerRef);
      if (!account || !routed) return zeroUsage(handle.appRef, handle.releaseId, now());
      const input = { ...target(account, parsed), releaseId: handle.releaseId, since };
      return routed === 'function'
        ? functionUsageSince({ ...input, now })
        : containerUsageSince({ ...input, ...rollout });
    },

    async destroy(handle) {
      const { parsed, account, shape } = await locate(handle.appRef);
      if (!account) return zeroUsage(handle.appRef, handle.releaseId, now());
      // A container's recorded total outlives its stack, so a replayed destroy
      // still routes by the handle's shape.
      const routed = shape ?? shapeOfProviderRef(handle.providerRef);
      return destroyOn(account, parsed, routed, handle.appRef, handle.releaseId);
    },

    async destroyApp({ appRef }) {
      const { parsed, account, shape } = await locate(appRef);
      if (!account) return [];
      // The application database first and the release last, as in `destroyOn`:
      // a replay after the release went would have no usage to return.
      if (parsed.environment.kind === 'production') {
        await destroyApplicationDatabase(account, { repositoryId: parsed.repositoryId });
        log('application database destroyed', appRef);
      }
      const first = awsReleaseId(appRef, FIRST_RELEASE_NUMBER);
      if (shape) {
        const live = await describeOn(account, parsed, shape, appRef);
        return [await destroyOn(account, parsed, shape, appRef, live.releaseId ?? first)];
      }
      // A container destroy cut off after its stack went has left its measured
      // total in SSM; finishing it reports that usage. The release is no longer
      // there to name, so the record carries the environment's first id.
      const recorded = await account.clients.ssm.getParameter(
        containerReleaseNames(parsed.repositoryId, parsed.environment).usageParameter,
      );
      if (recorded !== null) return [await destroyOn(account, parsed, 'container', appRef, first)];
      if (parsed.environment.kind === 'preview') {
        await destroyOn(account, parsed, null, appRef, first);
      }
      return [];
    },

    async listReleases({ appRef }): Promise<ReleaseSummary[]> {
      const { parsed, account, shape, stackName } = await locate(appRef);
      if (!account || !shape) return [];
      const stack = await account.clients.cloudformation.describeStack(stackName);
      if (stack?.tags[TAG_REPOSITORY] !== parsed.repositoryId) return [];
      const description = await describeOn(account, parsed, shape, appRef);
      return [
        {
          handle: {
            target: 'aws',
            appRef,
            environment: parsed.environment,
            releaseId: description.releaseId ?? awsReleaseId(appRef, FIRST_RELEASE_NUMBER),
            providerRef: awsProviderRef(shape, stackName),
          },
          state: description.state,
        },
      ];
    },

    // The AWS shapes' one-off task run is their adapter story's; until then a
    // release that needs a migration fails by name (MOTIR-10030).
    async runReleaseCommand() {
      throw new ReleaseCommandUnsupportedError('aws');
    },
  };
}
