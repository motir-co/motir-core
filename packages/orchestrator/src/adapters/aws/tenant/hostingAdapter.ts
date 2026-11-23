import { OrchestratorApiError } from '../../../errors';
import {
  CustomerRepositoryRefusedError,
  NoPreviousReleaseError,
  ReleaseArtifactUnsupportedError,
  ReleaseCommandUnsupportedError,
  ReleaseNotFoundError,
} from '../../../hosting/errors';
import { hostingAppNames, sameEnvironment } from '../../../hosting/names';
import { deriveOriginSecret } from '../../../hosting/originSecret';
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
  OPEN_RULE_SEED_SUFFIX,
  containerReleaseNames,
  containerUsageSince,
  deployContainerRelease,
  describeContainerRelease,
  destroyContainerRelease,
  openParameters,
  pickRulePriority,
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
  frontDoorRevision,
  describeFunctionRelease,
  destroyFunctionRelease,
  functionReleaseNames,
  functionUsageSince,
  rollbackFunctionRelease,
} from './function';
import { ensureTenantNetwork, stackOutput, type TenantAccountContext } from './network';
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
import { ORIGIN_ACCESS_PARAMETER, originAccessOf } from './releaseTemplate';
import {
  TAG_ORGANIZATION,
  TAG_REPOSITORY,
  createStackRunner,
  type StackRunnerOptions,
} from './stackRunner';

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
  /** The organisation's tenant account id while a takeover is handing it over
   *  (`handing_over`), else null (MOTIR-12131). `openUpstream` reaches the
   *  account through it, because `ensureTenantAccount` answers a handing-over
   *  account not ready — on purpose, so nothing else deploys into it. Absent,
   *  `openUpstream` reaches only a ready account. */
  readonly handoverAccountOf?: (organizationId: string) => Promise<string | null>;
  /** The organisation a repository row belongs to. */
  readonly organizationOf: (repositoryId: string) => Promise<string>;
  /** Whether the repository is a customer repository (D1), which is never hosted. */
  readonly isCustomerRepository: (repositoryId: string) => Promise<boolean>;
  /** The GitHub ids the push roles' trust binds. */
  readonly githubIdsOf: GithubRepositoryIdLookup;
  /** The forwarder's IAM principal, the one identity a function URL admits. */
  readonly forwarderPrincipalArn: string;
  /** The key an app's origin secret is derived from (`deriveOriginSecret`). */
  readonly originSecretKey: string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The stack runner's and the container rollout's waits. */
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: AwsHostingLogLine) => void;
}

/** The address an opened production release answers at without Motir's origin
 *  secret (MOTIR-12128). */
export interface OpenUpstreamResult {
  readonly upstreamAddress: string;
}

/** The AWS deploy port, plus the call that opens one production release. */
export interface AwsHostingDeployPort extends HostingDeployPort {
  /**
   * Switch a PRODUCTION release to answer without Motir's origin secret
   * (`OriginAccess=open`), keeping the secret path, so Motir's edge answers
   * too, and return the address it now answers at: a function release's
   * `FrontDoorUrl`, a container release's own `OpenUpstreamUrl`. Look before
   * act: a stack already open is not applied again. A preview is refused
   * (`OrchestratorApiError` 409) and a release with no stack is
   * `ReleaseNotFoundError`. It records nothing; the caller stores the address.
   */
  openUpstream(handle: ReleaseHandle): Promise<OpenUpstreamResult>;
}

/** The output an open release's address is read from, by shape. */
const OPEN_UPSTREAM_OUTPUT: Record<ReleaseShape, string> = {
  function: 'FrontDoorUrl',
  container: 'OpenUpstreamUrl',
};

/** A release stack's template declares the open mode — a stack applied before
 *  MOTIR-12128 does not, and is opened by a deploy first. */
const DECLARES_ORIGIN_ACCESS = new RegExp(`^  ${ORIGIN_ACCESS_PARAMETER}:\\s*$`, 'm');

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

/** The clock, the waits and the log line every release operation in one
 *  account shares — the adapter's, or a caller's that works in an account
 *  directly (the handover, MOTIR-12130). */
export interface AwsReleaseOperationOptions {
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: AwsHostingLogLine) => void;
}

interface ReleaseOps {
  readonly now: () => Date;
  readonly waits: Pick<AwsHostingDeps, 'sleep' | 'pollMs' | 'timeoutMs'>;
  readonly rollout: Pick<AwsHostingDeps, 'sleep' | 'pollMs' | 'timeoutMs'> & {
    now: () => Date;
  };
  readonly runnerOptions: StackRunnerOptions;
  readonly log: (step: string, appRef: string, detail?: string) => void;
}

function releaseOps(options: AwsReleaseOperationOptions): ReleaseOps {
  const now = options.now ?? (() => new Date());
  // The waits, with only what the caller set (an absent one is the module's
  // default).
  const waits = Object.fromEntries(
    Object.entries({
      sleep: options.sleep,
      pollMs: options.pollMs,
      timeoutMs: options.timeoutMs,
    }).filter(([, value]) => value !== undefined),
  ) as Pick<AwsHostingDeps, 'sleep' | 'pollMs' | 'timeoutMs'>;
  return {
    now,
    waits,
    rollout: { ...waits, now },
    runnerOptions: { ...waits, now: () => now().getTime() },
    log: (step, appRef, detail) => options.log?.({ step, appRef, ...(detail ? { detail } : {}) }),
  };
}

function target(account: TenantAccountContext, parsed: ParsedAppRef) {
  return { account, repositoryId: parsed.repositoryId, environment: parsed.environment };
}

async function describeOn(
  ops: ReleaseOps,
  account: TenantAccountContext,
  parsed: ParsedAppRef,
  shape: ReleaseShape,
  appRef: string,
): Promise<ReleaseDescription> {
  const description =
    shape === 'function'
      ? await describeFunctionRelease(target(account, parsed))
      : await describeContainerRelease({ ...target(account, parsed), ...ops.rollout });
  return toReleaseDescription(shape, appRef, description);
}

/** Destroy a preview's database, then the environment's release through its
 *  shape. The release goes LAST: a destroy cut off after it was gone would be
 *  replayed with no release to measure, and its usage lost (MOTIR-10012's
 *  cut-off sweep). Usage comes back whatever is already gone. */
async function destroyOn(
  ops: ReleaseOps,
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
      ops.waits,
    );
    ops.log('preview database dropped', appRef);
  }
  let usage: ReleaseUsage;
  if (shape === 'function') usage = await destroyFunctionRelease({ ...input, now: ops.now });
  else if (shape === 'container') {
    usage = await destroyContainerRelease({ ...input, ...ops.rollout });
  } else usage = zeroUsage(appRef, releaseId, ops.now());
  ops.log('release destroyed', appRef, shape ?? 'absent');
  return usage;
}

/** Destroy one app — an environment's database, then its release — in an
 *  account already open (`destroyApp` after it has found the account). */
async function destroyAppOn(
  ops: ReleaseOps,
  account: TenantAccountContext,
  appRef: string,
): Promise<ReleaseUsage[]> {
  const parsed = parseAwsAppRef(appRef);
  const { stackName } = functionReleaseNames(parsed.repositoryId, parsed.environment);
  const stack = await account.runner.describeStack(stackName);
  const shape = stack ? shapeOfReleaseStack(stack.parameters) : null;
  // The application database first and the release last, as in `destroyOn`:
  // a replay after the release went would have no usage to return.
  if (parsed.environment.kind === 'production') {
    await destroyApplicationDatabase(account, { repositoryId: parsed.repositoryId });
    ops.log('application database destroyed', appRef);
  }
  const first = awsReleaseId(appRef, FIRST_RELEASE_NUMBER);
  if (shape) {
    const live = await describeOn(ops, account, parsed, shape, appRef);
    return [await destroyOn(ops, account, parsed, shape, appRef, live.releaseId ?? first)];
  }
  // A container destroy cut off after its stack went has left its measured
  // total in SSM; finishing it reports that usage. The release is no longer
  // there to name, so the record carries the environment's first id.
  const recorded = await account.clients.ssm.getParameter(
    containerReleaseNames(parsed.repositoryId, parsed.environment).usageParameter,
  );
  if (recorded !== null) {
    return [await destroyOn(ops, account, parsed, 'container', appRef, first)];
  }
  if (parsed.environment.kind === 'preview') {
    await destroyOn(ops, account, parsed, null, appRef, first);
  }
  return [];
}

/** A preview whose app ref is not one (production, or not an app ref at all). */
export class NotAPreviewAppRefError extends Error {
  readonly code = 'AWS_NOT_A_PREVIEW_APP_REF' as const;
  constructor(readonly appRef: string) {
    super(`${appRef} is not a preview app.`);
    this.name = 'NotAPreviewAppRefError';
  }
}

/**
 * Destroy ONE preview in an account the caller has open — its database, then
 * its release, exactly as `destroyApp` does for a preview — and answer the
 * release's usage. What is already gone is not an error, so a replay finishes a
 * destroy that was cut off. A production app ref is refused before any call.
 * The handover's preview teardown calls it for each preview (MOTIR-12130).
 */
export async function destroyAwsPreview(
  account: TenantAccountContext,
  appRef: string,
  options: AwsReleaseOperationOptions = {},
): Promise<ReleaseUsage[]> {
  if (parseAwsAppRef(appRef).environment.kind !== 'preview') {
    throw new NotAPreviewAppRefError(appRef);
  }
  return destroyAppOn(releaseOps(options), account, appRef);
}

/** A stack runner over the account's CloudFormation with these options' waits. */
export function awsReleaseRunner(
  clients: TenantAccountContext['clients'],
  options: AwsReleaseOperationOptions = {},
) {
  return createStackRunner(clients.cloudformation, releaseOps(options).runnerOptions);
}

export function createAwsHostingDeployPort(deps: AwsHostingDeps): AwsHostingDeployPort {
  const ops = releaseOps(deps);
  const { now, waits, rollout, runnerOptions, log } = ops;

  async function refuseCustomer(repositoryId: string): Promise<void> {
    if (await deps.isCustomerRepository(repositoryId)) {
      throw new CustomerRepositoryRefusedError(repositoryId);
    }
  }

  /** The repository's tenant account, or null while it is not ready. */
  async function accountOf(
    repositoryId: string,
    reach: 'ready' | 'handover' = 'ready',
  ): Promise<TenantAccountContext | null> {
    const organizationId = await deps.organizationOf(repositoryId);
    const accountId = await accountIdOf(organizationId, reach);
    if (!accountId) return null;
    const clients = deps.clientsFor({ accountId, region: deps.region });
    return {
      organizationId,
      clients,
      runner: createStackRunner(clients.cloudformation, runnerOptions),
    };
  }

  /** The account id `reach` admits: a ready account's, or — for the handover
   *  (MOTIR-12131) — a handing-over account's first, else a ready one's. Never
   *  calls `ensureTenantAccount` for a handing-over account. */
  async function accountIdOf(
    organizationId: string,
    reach: 'ready' | 'handover',
  ): Promise<string | null> {
    if (reach === 'handover' && deps.handoverAccountOf) {
      const handingOver = await deps.handoverAccountOf(organizationId);
      if (handingOver) return handingOver;
    }
    const answer = await deps.ensureTenantAccount(organizationId);
    return answer.ready && answer.accountId ? answer.accountId : null;
  }

  /** The app's repository and environment, its account, and its release
   *  stack's shape (null when there is no release stack). */
  async function locate(appRef: string, reach: 'ready' | 'handover' = 'ready') {
    const parsed = parseAwsAppRef(appRef);
    const { stackName } = functionReleaseNames(parsed.repositoryId, parsed.environment);
    const account = await accountOf(parsed.repositoryId, reach);
    if (!account) return { parsed, account: null, shape: null, stackName, stack: null };
    const stack = await account.runner.describeStack(stackName);
    const shape = stack ? shapeOfReleaseStack(stack.parameters) : null;
    return { parsed, account, shape, stackName, stack };
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
                originSecretKey: deps.originSecretKey,
              })
            ).releaseId
          : (
              await deployContainerRelease({
                ...common,
                ...rollout,
                ...(input.size ? { size: input.size } : {}),
                network,
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
      return describeOn(ops, account, parsed, shape, handle.appRef);
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
      return destroyOn(ops, account, parsed, routed, handle.appRef, handle.releaseId);
    },

    async destroyApp({ appRef }) {
      const parsed = parseAwsAppRef(appRef);
      const account = await accountOf(parsed.repositoryId);
      if (!account) return [];
      return destroyAppOn(ops, account, appRef);
    },

    async listReleases({ appRef }): Promise<ReleaseSummary[]> {
      const { parsed, account, shape, stackName } = await locate(appRef);
      if (!account || !shape) return [];
      const stack = await account.clients.cloudformation.describeStack(stackName);
      if (stack?.tags[TAG_REPOSITORY] !== parsed.repositoryId) return [];
      const description = await describeOn(ops, account, parsed, shape, appRef);
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

    async openUpstream(handle) {
      const { appRef } = handle;
      const parsed = parseAwsAppRef(appRef);
      // A preview answers through Motir's edge alone: refused before any call.
      if (parsed.environment.kind !== 'production') {
        throw new OrchestratorApiError(
          'aws',
          409,
          `app ${appRef} is a preview; only production opens`,
        );
      }
      if (!sameEnvironment(parsed.environment, handle.environment)) {
        throw new OrchestratorApiError('aws', 409, `app ${appRef} is another environment's`);
      }
      // A handing-over account first: the takeover opens its releases while
      // the account answers not ready to every other caller (MOTIR-12131).
      const { account, shape, stackName, stack } = await locate(appRef, 'handover');
      // Unpublished (no ConfigHash yet) is no release to open either.
      if (!account || !shape || !stack?.parameters['ConfigHash']) {
        throw new ReleaseNotFoundError(appRef);
      }
      const output = OPEN_UPSTREAM_OUTPUT[shape];
      // Already open and settled: nothing to apply. An open stack still in
      // progress (a retried call that was cut off) is applied again below with
      // its own values, which waits for it and changes nothing.
      const settled = !stack.status.endsWith('_IN_PROGRESS');
      if (originAccessOf(stack.parameters) === 'open' && settled && stack.outputs[output]) {
        log('release already open', appRef, shape);
        return { upstreamAddress: stack.outputs[output] };
      }
      // The SAME template the stack runs (its release variables are written
      // into it), with the stack's own parameters. The origin secret is NoEcho,
      // so it is derived again rather than read back.
      const template = await account.clients.cloudformation.getTemplateBody(stackName);
      if (!DECLARES_ORIGIN_ACCESS.test(template)) {
        throw new OrchestratorApiError(
          'aws',
          409,
          `app ${appRef} was released before the open mode; deploy it again first`,
        );
      }
      const originSecret = deriveOriginSecret(deps.originSecretKey, appRef);
      let parameters: Record<string, string> = {
        ...stack.parameters,
        OriginSecret: originSecret,
        [ORIGIN_ACCESS_PARAMETER]: 'open',
      };
      if (shape === 'function') {
        parameters['FrontDoorRevision'] = frontDoorRevision(originSecret, template, 'open');
      } else {
        const network = await ensureTenantNetwork(account);
        // The open rule's priority: the stack's own when it has one, else a
        // free one, seeded apart from the app's secret rule.
        const priority =
          stack.parameters['OpenListenerRulePriority'] ||
          String(
            pickRulePriority(
              `${appRef}${OPEN_RULE_SEED_SUFFIX}`,
              await account.clients.elb.listRulePriorities(network.albListenerArn),
            ),
          );
        parameters = { ...parameters, ...openParameters('open', priority, network) };
      }
      const { outputs } = await account.runner.applyStack({
        stackName,
        template,
        parameters,
        tags: {
          [TAG_ORGANIZATION]: account.organizationId,
          [TAG_REPOSITORY]: parsed.repositoryId,
        },
      });
      log('release opened', appRef, shape);
      return { upstreamAddress: stackOutput(stackName, outputs, output) };
    },

    // The AWS shapes' one-off task run is their adapter story's; until then a
    // release that needs a migration fails by name (MOTIR-10030).
    async runReleaseCommand() {
      throw new ReleaseCommandUnsupportedError('aws');
    },
  };
}
