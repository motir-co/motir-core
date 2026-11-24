import { randomUUID } from 'node:crypto';
import type { HostingTenantAccount, HostingTenantHandoverStep } from '@/generated/prisma/client';
import {
  AWS_APP_PREFIX,
  HANDOVER_DEPLOY_ROLE,
  HANDOVER_DEPLOY_ROLE_PATH,
  hostingAppNames,
  type AwsManagementApi,
  type AwsStandaloneReadiness,
  type OpenUpstreamResult,
  type ReleaseHandle,
  type TenantHandover,
} from '@motir/orchestrator';
import {
  isTenantAccountHandoverState,
  TENANT_HANDOVER_STEPS,
  type HostingTenantAccountState,
  type TenantHandoverStep,
  type TenantHandoverStepStatus,
} from '@/lib/ciFleet/hostingTenantAccounts';
import type {
  TenantAccountHandoverDto,
  TenantHandoverApplicationDto,
  TenantHandoverRoomDto,
} from '@/lib/dto/tenantAccountHandover';
import { githubAccountIdOfLogin } from '@/lib/github/repositoryOwnerId';
import {
  HandoverActorMissingError,
  HandoverEmailCodeRefusedError,
  HandoverNothingToRetryError,
  HandoverRepositoryNotRealizedError,
  HandoverStepNotWaitingError,
  HandoverStepOutOfOrderError,
  TenantAccountNotReadyError,
  TenantHandoverAlreadyStartedError,
  TenantHandoverInputError,
  TenantHandoverNotAdminError,
  TenantHandoverNotFoundError,
} from '@/lib/hosting/tenantHandoverErrors';
import { isHandoverGithubOwner, isHandoverOwnerEmail } from '@/lib/hosting/handoverInput';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';
import { GithubIdentityRequiredError } from '@/lib/projectRepos/errors';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { hostingTenantHandoverStepRepository } from '@/lib/repositories/hostingTenantHandoverStepRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { hostedApplicationHandoverService } from '@/lib/services/hostedApplicationHandoverService';
import { assertOrgCapability } from '@/lib/services/organizationAccessService';
import { productionRepositoryConfigService } from '@/lib/services/productionRepositoryConfigService';
import { projectRepoTakeoverService } from '@/lib/services/projectRepoTakeoverService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// HAND AN ORGANISATION'S AWS ACCOUNT OVER, WITH ITS APPS RUNNING (Story
// MOTIR-9800 · MOTIR-12131). At takeover an enterprise tenant's AWS account
// leaves Motir's AWS Organization with its production apps still serving, and
// its repositories move to the organisation's own GitHub. One flow does it, in a
// fixed order of eight steps, one `hosting_tenant_handover_step` row each:
//
//   destroy_previews → create_deploy_role → open_upstream → move_email →
//   await_standalone → remove_access → leave_organization → transfer_repositories
//
// It sequences calls other cards built (the tenant-account calls, `openUpstream`,
// the address release, the shipped repository transfer) and makes no AWS call of
// its own.
//
// ── Each step is CLAIM → ACT → RECORD, and a resume is just `advance` again ──
//
// `advance` takes the first step not `done`, claims its row's lease in a short
// transaction, runs the step's provider calls OUTSIDE any transaction, and
// records the outcome in a second one. Every call it makes looks before it acts,
// so a step cut off anywhere is finished by its next run. A step that is `done`
// enqueues `advance` again; one that waits on the new owner (`waiting_on_you`)
// waits for their answer (`submitEmailCode`, `recheckStandalone`); one that
// throws is `failed` with its typed error's code until `retry`.
//
// ── The order guarantees are CHECKED, not trusted to the array ──────────────
//
// `remove_access` runs only once `await_standalone` is `done` and re-reads AWS's
// readiness first; `leave_organization` only once `remove_access` is `done`;
// `transfer_repositories` only once `leave_organization` is `done`. So Motir's
// access never goes before the account can leave, and no step that needs
// Motir's reach into a repository runs after that repository's transfer. A
// handover abandoned before `remove_access` has changed only previews, the
// deploy role and the upstream mode: production keeps serving through Motir's
// edge, with Motir's access intact.
//
// ── What it never holds ─────────────────────────────────────────────────────
//
// No step stores, logs or returns a payment detail, a root credential or the
// one-time code: the code goes straight to AWS, and `lastError` is a typed
// error's code and message with the owner's address struck out.

const LEASE_MS = 15 * 60_000;
const LAST_ERROR_MAX = 500;

/** What the handover reaches AWS through — the default reads this deployment's
 *  configuration (`createConfiguredAwsHandover`); a test passes fakes. */
export interface TenantHandoverAwsReach {
  readonly handover: Pick<
    TenantHandover,
    'destroyPreviewStacks' | 'createHandoverDeployRole' | 'removeMotirAccess'
  >;
  readonly management: Pick<
    AwsManagementApi,
    | 'startPrimaryEmailUpdate'
    | 'acceptPrimaryEmailUpdate'
    | 'getPrimaryEmail'
    | 'getPrimaryEmailUpdateStatus'
    | 'readStandaloneReadiness'
    | 'removeAccountFromOrganization'
  >;
  openUpstream(handle: ReleaseHandle): Promise<OpenUpstreamResult>;
}

/** A handed-over repository, as the steps read it. */
export type HandoverRepository = Awaited<
  ReturnType<typeof projectRepoRepository.listAwsMotirReposByOrganizationInTx>
>[number];

export interface TenantHandoverDeps {
  aws?: () => Promise<TenantHandoverAwsReach>;
  /** The GitHub account id of a login; the default asks GitHub. */
  githubAccountIdOf?: (login: string) => Promise<string>;
  /** Withdraw the production deploy credential and variables Motir set. */
  removeProductionConfig?: (repo: HandoverRepository) => Promise<void>;
  /** The shipped single-repository transfer saga. */
  requestTakeover?: (rowId: string, newOwner: string, ctx: ServiceContext) => Promise<unknown>;
  enqueueAdvance?: (tenantAccountId: string) => Promise<void>;
  now?: () => Date;
}

type ResolvedDeps = Required<TenantHandoverDeps>;

/** The `hosting.tenant-handover.advance` event: the account's id only. An
 *  account belongs to an organisation, not a workspace, so `workspaceId` is
 *  the literal null. */
export interface TenantHandoverAdvanceData {
  tenantAccountId: string;
  workspaceId: null;
}

/** Who is asking, and in which organisation's name. */
export interface HandoverActor {
  userId: string;
  organizationId: string;
}

/** What one `advance` did. */
export type HandoverAdvanceOutcome =
  /** The account is not being handed over; nothing ran. */
  | { outcome: 'not_in_handover' }
  /** Every step is done. */
  | { outcome: 'complete' }
  /** Another worker holds the step's lease. */
  | { outcome: 'busy'; step: TenantHandoverStep }
  /** The step is `failed` and waits on `retry`. */
  | { outcome: 'failed'; step: TenantHandoverStep }
  /** The step ran and ended with `status`. */
  | { outcome: 'ran'; step: TenantHandoverStep; status: TenantHandoverStepStatus };

/** How one step's turn ended. */
interface StepResult {
  status: 'done' | 'waiting_on_you';
  missing?: readonly string[];
}

/** The account and the step rows, as one turn reads them. */
interface HandoverState {
  account: HostingTenantAccount;
  steps: HostingTenantHandoverStep[];
}

/** Which step must be `done` before each step may run. */
const REQUIRES: Partial<Record<TenantHandoverStep, TenantHandoverStep>> = {
  remove_access: 'await_standalone',
  leave_organization: 'remove_access',
  transfer_repositories: 'leave_organization',
};

/** The steps whose `waiting_on_you` a re-check of AWS's readiness answers. */
const RECHECKED_STEPS: readonly TenantHandoverStep[] = [
  'await_standalone',
  'remove_access',
  'leave_organization',
];

/** A repository past the transfer: the saga issued it, Motir no longer acts. */
const PAST_TRANSFER = new Set(['transfer_pending', 'awaiting_reinstall', 'done']);

async function defaultAws(): Promise<TenantHandoverAwsReach> {
  const [{ createConfiguredAwsHandover }, { hostingOriginSecretKey }] = await Promise.all([
    import('@/lib/orchestrator/awsHosting'),
    import('@/lib/orchestrator/hosting'),
  ]);
  return createConfiguredAwsHandover(hostingOriginSecretKey());
}

function resolve(deps: TenantHandoverDeps): ResolvedDeps {
  return {
    aws: deps.aws ?? defaultAws,
    githubAccountIdOf: deps.githubAccountIdOf ?? githubAccountIdOfLogin,
    removeProductionConfig:
      deps.removeProductionConfig ??
      ((repo) => productionRepositoryConfigService.removeFromRepository(repo)),
    requestTakeover:
      deps.requestTakeover ??
      ((rowId, newOwner, ctx) => projectRepoTakeoverService.requestTakeover(rowId, newOwner, ctx)),
    enqueueAdvance:
      deps.enqueueAdvance ??
      ((tenantAccountId) =>
        sendEvent('hosting.tenant-handover.advance', { tenantAccountId, workspaceId: null })),
    now: deps.now ?? (() => new Date()),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function readState(tenantAccountId: string): Promise<HandoverState | null> {
  return withSystemContext(async (tx) => {
    const account = await hostingTenantAccountRepository.findById(tenantAccountId, tx);
    if (!account) return null;
    const steps = await hostingTenantHandoverStepRepository.listByTenantAccount(account.id, tx);
    return { account, steps };
  });
}

/** The first step not `done`, or null when every step is. */
function currentStep(steps: HostingTenantHandoverStep[]): HostingTenantHandoverStep | null {
  return steps.find((row) => row.status !== 'done') ?? null;
}

const statusOf = (steps: HostingTenantHandoverStep[], step: TenantHandoverStep) =>
  steps.find((row) => row.step === step)?.status ?? 'pending';

const currentLabel = (row: HostingTenantHandoverStep | null) =>
  row ? { step: row.step as TenantHandoverStep, status: row.status } : null;

function requireAccount(account: HostingTenantAccount): {
  accountId: string;
  ownerEmail: string;
  githubOwner: string;
} {
  if (!account.awsAccountId || !account.handoverOwnerEmail || !account.handoverGithubOwner) {
    throw new TenantAccountNotReadyError(account.organizationId, account.state);
  }
  return {
    accountId: account.awsAccountId,
    ownerEmail: account.handoverOwnerEmail,
    githubOwner: account.handoverGithubOwner,
  };
}

const listRepositories = (organizationId: string) =>
  withSystemContext((tx) =>
    projectRepoRepository.listAwsMotirReposByOrganizationInTx(organizationId, tx),
  );

const listApplications = (organizationId: string) =>
  withSystemContext((tx) => hostedApplicationRepository.listAwsByOrganization(organizationId, tx));

const setAccountState = (
  id: string,
  from: readonly HostingTenantAccountState[],
  to: HostingTenantAccountState,
) => withSystemContext((tx) => hostingTenantAccountRepository.setStateIfInTx(id, from, to, tx));

// ── The gate every person-facing call passes ───────────────────────────────

/** The caller administers the organisation, and the account is that
 *  organisation's: a non-member or another organisation's account is 404, a
 *  plain member 403. */
async function assertAdmin(actor: HandoverActor): Promise<void> {
  try {
    await assertOrgCapability(actor.userId, actor.organizationId, 'manageOrgSettings');
  } catch (err) {
    if (err instanceof OrganizationNotFoundError) {
      throw new TenantHandoverNotFoundError(actor.organizationId);
    }
    if (err instanceof OrgForbiddenError)
      throw new TenantHandoverNotAdminError(actor.organizationId);
    throw err;
  }
}

async function gatedState(tenantAccountId: string, actor: HandoverActor): Promise<HandoverState> {
  await assertAdmin(actor);
  const state = await readState(tenantAccountId);
  if (!state || state.account.organizationId !== actor.organizationId) {
    throw new TenantHandoverNotFoundError(tenantAccountId);
  }
  return state;
}

// ── AWS's standalone requirements, as the step reports them ────────────────

/** The requirements the new owner still has to meet or confirm: those AWS says
 *  are not met, and the three the management account can never read. */
function missingOf(readiness: AwsStandaloneReadiness): string[] {
  const missing: string[] = [];
  if (readiness.waitPeriod.status !== 'met') missing.push('wait_period');
  if (readiness.delegatedAdministrator.status !== 'met') missing.push('delegated_administrator');
  // Always `unknown` to the management account (MOTIR-12130): only the owner,
  // or the removal itself, can say.
  missing.push('payment_method', 'support_plan', 'contact_information');
  return missing;
}

/** Readable requirements not met — what blocks the removal outright. */
const blockedOf = (readiness: AwsStandaloneReadiness) =>
  missingOf(readiness).filter((m) => m === 'wait_period' || m === 'delegated_administrator');

// ── The steps ──────────────────────────────────────────────────────────────

interface StepContext {
  state: HandoverState;
  deps: ResolvedDeps;
  aws: TenantHandoverAwsReach;
}

async function destroyPreviews({ state, aws }: StepContext): Promise<StepResult> {
  await aws.handover.destroyPreviewStacks(requireAccount(state.account).accountId);
  return { status: 'done' };
}

async function createDeployRole({ state, deps, aws }: StepContext): Promise<StepResult> {
  const { accountId, githubOwner } = requireAccount(state.account);
  const repositories = (await listRepositories(state.account.organizationId)).map((repo) => {
    if (!repo.githubRepo) throw new HandoverRepositoryNotRealizedError(repo.id);
    return { repositoryId: repo.id, githubRepositoryId: repo.githubRepo.repoId };
  });
  const destinationOwnerId = await deps.githubAccountIdOf(githubOwner);
  await aws.handover.createHandoverDeployRole(accountId, { destinationOwnerId, repositories });
  return { status: 'done' };
}

/** The production release handle `openUpstream` opens, or null when the
 *  application has no current release. */
async function releaseHandleOf(app: {
  workspaceId: string;
  projectRepositoryId: string;
  currentReleaseId: string | null;
}): Promise<ReleaseHandle | null> {
  const { currentReleaseId } = app;
  if (!currentReleaseId) return null;
  const release = await withWorkspaceServiceContext(app.workspaceId, (tx) =>
    hostedReleaseRepository.findById(currentReleaseId, tx),
  );
  if (!release) return null;
  const environment = { kind: 'production' } as const;
  return {
    target: 'aws',
    appRef: hostingAppNames(AWS_APP_PREFIX, app.projectRepositoryId, environment).appRef,
    environment,
    releaseId: release.providerReleaseId ?? release.id,
    providerRef: release.providerRef ?? '',
  };
}

async function openUpstreams({ state, aws }: StepContext): Promise<StepResult> {
  for (const app of await listApplications(state.account.organizationId)) {
    if (app.state !== 'live' && app.state !== 'handing_over') continue;
    const handle = await releaseHandleOf(app);
    const opened = handle ? await aws.openUpstream(handle) : null;
    // One transaction per application: the address and the state together.
    await withWorkspaceServiceContext(app.workspaceId, async (tx) => {
      if (opened) {
        await hostedApplicationRepository.setUpstreamAddress(app.id, opened.upstreamAddress, tx);
      }
      await hostedApplicationRepository.setStateIfIn(
        app.id,
        ['live', 'handing_over'],
        'handing_over',
        {},
        tx,
      );
    });
  }
  return { status: 'done' };
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function moveEmail({ state, aws }: StepContext): Promise<StepResult> {
  const { accountId, ownerEmail } = requireAccount(state.account);
  const update = await aws.management.getPrimaryEmailUpdateStatus(accountId);
  // A resumed step never starts a second update: one already PENDING, ACCEPTED
  // or COMPLETED is the one to finish.
  if (!update || update.status === 'FAILED') {
    await aws.management.startPrimaryEmailUpdate(accountId, ownerEmail);
    return { status: 'waiting_on_you' };
  }
  if (sameAddress(await aws.management.getPrimaryEmail(accountId), ownerEmail)) {
    return { status: 'done' };
  }
  return { status: 'waiting_on_you' };
}

async function awaitStandalone({ state, aws }: StepContext): Promise<StepResult> {
  const { accountId } = requireAccount(state.account);
  await setAccountState(state.account.id, ['handing_over'], 'awaiting_standalone');
  const readiness = await aws.management.readStandaloneReadiness(accountId);
  // Already outside the Organization: nothing is left to wait for.
  if (!readiness.inOrganization) return { status: 'done' };
  // Never `done` on its own: three requirements are unreadable, so the owner
  // confirms them with `recheckStandalone`.
  return { status: 'waiting_on_you', missing: missingOf(readiness) };
}

async function removeAccess({ state, deps, aws }: StepContext): Promise<StepResult> {
  const { accountId } = requireAccount(state.account);
  const readiness = await aws.management.readStandaloneReadiness(accountId);
  const blocked = readiness.inOrganization ? blockedOf(readiness) : [];
  if (blocked.length > 0) {
    await setAccountState(state.account.id, ['removing'], 'awaiting_standalone');
    return { status: 'waiting_on_you', missing: blocked };
  }
  await setAccountState(state.account.id, ['awaiting_standalone'], 'removing');
  for (const repo of await listRepositories(state.account.organizationId)) {
    if (repo.takeoverState && PAST_TRANSFER.has(repo.takeoverState)) continue;
    await deps.removeProductionConfig(repo);
  }
  for (const app of await listApplications(state.account.organizationId)) {
    await withWorkspaceServiceContext(app.workspaceId, (tx) =>
      hostedApplicationHandoverService.releaseApplicationAddresses(app.id, tx),
    );
  }
  await aws.handover.removeMotirAccess(accountId);
  return { status: 'done' };
}

async function leaveOrganization({ state, aws }: StepContext): Promise<StepResult> {
  const { accountId } = requireAccount(state.account);
  const removal = await aws.management.removeAccountFromOrganization(accountId);
  if (removal.outcome === 'not_ready')
    return { status: 'waiting_on_you', missing: removal.missing };
  return { status: 'done' };
}

async function transferRepositories({ state, deps }: StepContext): Promise<StepResult> {
  const { account } = state;
  const { accountId, githubOwner } = requireAccount(account);
  const actor = account.handoverStartedByUserId;
  if (!actor) throw new HandoverActorMissingError(account.id);
  for (const repo of await listRepositories(account.organizationId)) {
    if (repo.takeoverState && PAST_TRANSFER.has(repo.takeoverState)) continue;
    await deps.requestTakeover(repo.id, githubOwner, {
      userId: actor,
      workspaceId: repo.workspaceId,
    });
  }
  const at = deps.now();
  for (const app of await listApplications(account.organizationId)) {
    await withWorkspaceServiceContext(app.workspaceId, (tx) =>
      hostedApplicationRepository.setStateIfIn(
        app.id,
        ['live', 'handing_over'],
        'handed_over',
        { handedOverAt: at, handedOverAccountId: accountId },
        tx,
      ),
    );
  }
  await setAccountState(account.id, ['removing'], 'handed_over');
  return { status: 'done' };
}

const STEP_RUNNERS: Record<TenantHandoverStep, (ctx: StepContext) => Promise<StepResult>> = {
  destroy_previews: destroyPreviews,
  create_deploy_role: createDeployRole,
  open_upstream: openUpstreams,
  move_email: moveEmail,
  await_standalone: awaitStandalone,
  remove_access: removeAccess,
  leave_organization: leaveOrganization,
  transfer_repositories: transferRepositories,
};

// ── One step's turn ────────────────────────────────────────────────────────

/** The typed error's code and message, with the owner's address struck out —
 *  never a raw AWS payload, and never longer than the column shows. */
function lastErrorOf(err: unknown, account: HostingTenantAccount): string {
  const code =
    err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : err instanceof Error
        ? err.name
        : 'UnknownError';
  let message = err instanceof Error ? err.message : '';
  const email = account.handoverOwnerEmail;
  if (email) message = message.split(email).join('[owner email]');
  return `${code}: ${message}`.slice(0, LAST_ERROR_MAX);
}

/**
 * Run ONE step of the handover: its order precondition, its lease, the step,
 * and the record. Exported for the order-guarantee tests; `advance` is the
 * caller.
 *
 * @throws HandoverStepOutOfOrderError when the step it depends on is not done,
 *   before any claim or call.
 */
export async function runHandoverStep(
  tenantAccountId: string,
  step: TenantHandoverStep,
  deps: TenantHandoverDeps = {},
): Promise<HandoverAdvanceOutcome> {
  const resolved = resolve(deps);
  const state = await readState(tenantAccountId);
  if (!state || !isTenantAccountHandoverState(state.account.state)) {
    return { outcome: 'not_in_handover' };
  }
  const requires = REQUIRES[step];
  if (requires && statusOf(state.steps, requires) !== 'done') {
    throw new HandoverStepOutOfOrderError(step, requires);
  }
  const holder = randomUUID();
  const now = resolved.now();
  const claimed = await withSystemContext((tx) =>
    hostingTenantHandoverStepRepository.tryClaim(
      tenantAccountId,
      step,
      holder,
      now,
      new Date(now.getTime() + LEASE_MS),
      tx,
    ),
  );
  if (!claimed) return { outcome: 'busy', step };

  let result: StepResult | { status: 'failed'; lastError: string };
  try {
    result = await STEP_RUNNERS[step]({ state, deps: resolved, aws: await resolved.aws() });
  } catch (err) {
    result = { status: 'failed', lastError: lastErrorOf(err, state.account) };
  }
  await withSystemContext((tx) =>
    hostingTenantHandoverStepRepository.setStatus(tenantAccountId, step, result, holder, tx),
  );
  if (result.status === 'done') await resolved.enqueueAdvance(tenantAccountId);
  return { outcome: 'ran', step, status: result.status };
}

// ── The checklist ──────────────────────────────────────────────────────────

async function applicationsOf(organizationId: string): Promise<TenantHandoverApplicationDto[]> {
  const apps = await listApplications(organizationId);
  const out: TenantHandoverApplicationDto[] = [];
  for (const app of apps) {
    const customerDomains = await withWorkspaceServiceContext(app.workspaceId, (tx) =>
      hostedApplicationHandoverService.listCustomerDomainUpstreams(app.id, tx),
    );
    out.push({
      applicationId: app.id,
      slug: app.slug,
      state: app.state,
      upstreamAddress: app.upstreamAddress,
      customerDomains: customerDomains.map((d) => ({ ...d })),
    });
  }
  return out;
}

async function toDto(state: HandoverState): Promise<TenantAccountHandoverDto> {
  const { account, steps } = state;
  const roleMade = statusOf(steps, 'create_deploy_role') === 'done' && account.awsAccountId;
  return {
    tenantAccountId: account.id,
    organizationId: account.organizationId,
    state: account.state as HostingTenantAccountState,
    awsAccountId: account.awsAccountId,
    deployRoleArn: roleMade
      ? `arn:aws:iam::${account.awsAccountId}:role${HANDOVER_DEPLOY_ROLE_PATH}${HANDOVER_DEPLOY_ROLE}`
      : null,
    steps: TENANT_HANDOVER_STEPS.map((step) => {
      const row = steps.find((s) => s.step === step);
      return {
        step,
        status: (row?.status ?? 'pending') as TenantHandoverStepStatus,
        lastError: row?.lastError ?? null,
        missing: [...(row?.missing ?? [])],
        attempts: row?.attempts ?? 0,
        completedAt: row?.completedAt?.toISOString() ?? null,
      };
    }),
    applications: await applicationsOf(account.organizationId),
  };
}

async function freshDto(tenantAccountId: string): Promise<TenantAccountHandoverDto> {
  const state = await readState(tenantAccountId);
  if (!state) throw new TenantHandoverNotFoundError(tenantAccountId);
  return toDto(state);
}

// ── The service ────────────────────────────────────────────────────────────

function validStart(input: { ownerEmail: string; githubOwner: string }) {
  const ownerEmail = input.ownerEmail.trim();
  const githubOwner = input.githubOwner.trim();
  if (!isHandoverOwnerEmail(ownerEmail)) throw new TenantHandoverInputError('ownerEmail');
  if (!isHandoverGithubOwner(githubOwner)) throw new TenantHandoverInputError('githubOwner');
  return { ownerEmail, githubOwner };
}

/** Claim the handover on the organisation's `ready` account and lay out its
 *  steps, in ONE transaction. */
async function claimStart(
  organizationId: string,
  owner: { ownerEmail: string; githubOwner: string },
  userId: string,
): Promise<string> {
  return withSystemContext(async (tx) => {
    const account = await hostingTenantAccountRepository.findByOrganizationId(organizationId, tx);
    if (!account) throw new TenantAccountNotReadyError(organizationId, null);
    if (isTenantAccountHandoverState(account.state)) {
      throw new TenantHandoverAlreadyStartedError(account.id, account.state);
    }
    if (account.state !== 'ready' || !account.awsAccountId) {
      throw new TenantAccountNotReadyError(organizationId, account.state);
    }
    const started = await hostingTenantAccountRepository.startHandoverInTx(
      account.id,
      { ...owner, startedByUserId: userId },
      tx,
    );
    if (!started) throw new TenantHandoverAlreadyStartedError(account.id, 'handing_over');
    await hostingTenantHandoverStepRepository.createAllPending(account.id, tx);
    return account.id;
  });
}

export const tenantAccountHandoverService = {
  /**
   * Start handing the organisation's AWS account over to `githubOwner` and
   * `ownerEmail`. Organisation admins only, with a connected GitHub identity —
   * the transfers run as them — checked before anything is written.
   */
  async start(
    organizationId: string,
    input: { ownerEmail: string; githubOwner: string },
    actorUserId: string,
    deps: TenantHandoverDeps = {},
  ): Promise<TenantAccountHandoverDto> {
    await assertAdmin({ userId: actorUserId, organizationId });
    const owner = validStart(input);
    const identity = await githubIdentityService.getIdentityForUser(actorUserId);
    if (!identity) throw new GithubIdentityRequiredError();
    const tenantAccountId = await claimStart(organizationId, owner, actorUserId);
    await resolve(deps).enqueueAdvance(tenantAccountId);
    return freshDto(tenantAccountId);
  },

  /** Run the next step not `done` — the job's one call. Never throws for a
   *  step's own failure: that is recorded on the step. */
  async advance(
    tenantAccountId: string,
    deps: TenantHandoverDeps = {},
  ): Promise<HandoverAdvanceOutcome> {
    const state = await readState(tenantAccountId);
    if (!state || !isTenantAccountHandoverState(state.account.state)) {
      return { outcome: 'not_in_handover' };
    }
    const row = currentStep(state.steps);
    if (!row) return { outcome: 'complete' };
    const step = row.step as TenantHandoverStep;
    if (row.status === 'failed') return { outcome: 'failed', step };
    return runHandoverStep(tenantAccountId, step, deps);
  },

  /** The one-time code AWS emailed the new owner. Passed straight to AWS and
   *  never stored, logged or returned. */
  async submitEmailCode(
    tenantAccountId: string,
    code: string,
    actor: HandoverActor,
    deps: TenantHandoverDeps = {},
  ): Promise<TenantAccountHandoverDto> {
    const state = await gatedState(tenantAccountId, actor);
    const row = currentStep(state.steps);
    if (row?.step !== 'move_email' || row.status !== 'waiting_on_you') {
      throw new HandoverStepNotWaitingError(tenantAccountId, ['move_email'], currentLabel(row));
    }
    const trimmed = code.trim();
    if (!trimmed || trimmed.length > 64) throw new TenantHandoverInputError('code');
    const resolved = resolve(deps);
    const aws = await resolved.aws();
    const { accountId, ownerEmail } = requireAccount(state.account);
    const accepted = await aws.management.acceptPrimaryEmailUpdate(accountId, ownerEmail, trimmed);
    if (accepted.outcome === 'code_refused')
      throw new HandoverEmailCodeRefusedError(accepted.reason);
    if (sameAddress(await aws.management.getPrimaryEmail(accountId), ownerEmail)) {
      const moved = await withSystemContext((tx) =>
        hostingTenantHandoverStepRepository.moveUnheld(
          tenantAccountId,
          'move_email',
          ['waiting_on_you'],
          { status: 'done' },
          tx,
        ),
      );
      if (moved) await resolved.enqueueAdvance(tenantAccountId);
    }
    return freshDto(tenantAccountId);
  },

  /** The new owner says they have met AWS's standalone requirements: read
   *  them again, and carry on when nothing readable stands in the way. */
  async recheckStandalone(
    tenantAccountId: string,
    actor: HandoverActor,
    deps: TenantHandoverDeps = {},
  ): Promise<TenantAccountHandoverDto> {
    const state = await gatedState(tenantAccountId, actor);
    const row = currentStep(state.steps);
    const step = row?.step as TenantHandoverStep | undefined;
    if (!row || !step || !RECHECKED_STEPS.includes(step) || row.status !== 'waiting_on_you') {
      throw new HandoverStepNotWaitingError(tenantAccountId, RECHECKED_STEPS, currentLabel(row));
    }
    const resolved = resolve(deps);
    if (step === 'await_standalone') {
      const aws = await resolved.aws();
      const readiness = await aws.management.readStandaloneReadiness(
        requireAccount(state.account).accountId,
      );
      const blocked = readiness.inOrganization ? blockedOf(readiness) : [];
      const to =
        blocked.length > 0
          ? { status: 'waiting_on_you' as const, missing: missingOf(readiness) }
          : { status: 'done' as const };
      await withSystemContext((tx) =>
        hostingTenantHandoverStepRepository.moveUnheld(
          tenantAccountId,
          step,
          ['waiting_on_you'],
          to,
          tx,
        ),
      );
      if (to.status === 'done') await resolved.enqueueAdvance(tenantAccountId);
    } else {
      // `remove_access` re-reads readiness itself; `leave_organization` asks AWS
      // again. Both run on the next `advance`.
      await resolved.enqueueAdvance(tenantAccountId);
    }
    return freshDto(tenantAccountId);
  },

  /** Resume at the `failed` step: it goes back to `pending` and runs again.
   *  Every earlier step stays `done` and is not run again. */
  async retry(
    tenantAccountId: string,
    actor: HandoverActor,
    deps: TenantHandoverDeps = {},
  ): Promise<TenantAccountHandoverDto> {
    const state = await gatedState(tenantAccountId, actor);
    const row = currentStep(state.steps);
    if (row?.status !== 'failed') {
      throw new HandoverNothingToRetryError(tenantAccountId, currentLabel(row));
    }
    const step = row.step as TenantHandoverStep;
    const moved = await withSystemContext((tx) =>
      hostingTenantHandoverStepRepository.moveUnheld(
        tenantAccountId,
        step,
        ['failed'],
        { status: 'pending' },
        tx,
      ),
    );
    if (!moved) throw new HandoverNothingToRetryError(tenantAccountId, currentLabel(row));
    await resolve(deps).enqueueAdvance(tenantAccountId);
    return freshDto(tenantAccountId);
  },

  /**
   * What the Repositories room shows an organisation admin of the AWS hosting
   * (MOTIR-12137): every AWS-target repository of the organisation, handed over
   * together, and the tenant account a handover runs on. Null for anyone who is
   * not an organisation admin — the room then draws neither the entry nor the
   * checklist, and every route keeps its own gate.
   */
  async roomOverview(
    organizationId: string,
    userId: string,
  ): Promise<TenantHandoverRoomDto | null> {
    try {
      await assertAdmin({ userId, organizationId });
    } catch (err) {
      if (
        err instanceof TenantHandoverNotAdminError ||
        err instanceof TenantHandoverNotFoundError
      ) {
        return null;
      }
      throw err;
    }
    return withSystemContext(async (tx) => {
      const [account, repositories] = await Promise.all([
        hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
        projectRepoRepository.listAwsMotirReposByOrganizationInTx(organizationId, tx),
      ]);
      return {
        organizationId,
        tenantAccountId: account?.id ?? null,
        accountState: account ? (account.state as HostingTenantAccountState) : null,
        handoverStarted: account ? isTenantAccountHandoverState(account.state) : false,
        repositories: repositories.map((repo) => ({
          id: repo.id,
          name: repo.name,
          repoRef: repo.githubRepo ? `${repo.githubRepo.owner}/${repo.githubRepo.name}` : null,
          projectName: repo.project.name,
        })),
      };
    });
  },

  /** The checklist: each step's status, error and what it waits on, and each
   *  application's upstream with the customer domains to repoint. */
  async status(tenantAccountId: string, actor: HandoverActor): Promise<TenantAccountHandoverDto> {
    return toDto(await gatedState(tenantAccountId, actor));
  },
};
