import { idlePolicyRefusal } from '@motir/orchestrator';
import type { HostedApplicationDto } from '@/lib/dto/hostedApplications';
import type { IdlePolicyDto, IdlePolicyRefusalDto } from '@/lib/dto/idlePolicy';
import { deployEligibilityRefusal } from '@/lib/hosting/deployEligibility';
import {
  AlwaysOnRefusedOutOfCreditsError,
  ApplicationNotFoundError,
  CustomerRepositoryNotDeployableError,
  IdlePolicyApplyFailedError,
  IdlePolicyNotPermittedError,
  IdlePolicyUnsupportedForTargetError,
  NoProductionApplicationError,
  ReleaseInProgressError,
} from '@/lib/hosting/errors';
import {
  HOSTED_IDLE_SECONDS_DEFAULT,
  idlePolicyColumns,
  idlePolicyOfRow,
  sameIdlePolicy,
  type HostedIdlePolicy,
} from '@/lib/hosting/idlePolicy';
import type { HostingManifest } from '@/lib/hosting/manifest';
import type { HostingShape, HostingTarget } from '@/lib/hosting/vocabulary';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { productionUsageService } from '@/lib/services/productionUsageService';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// A HOSTED APPLICATION'S IDLE POLICY (Story MOTIR-9799 · MOTIR-12107): read it,
// and change it for a project administrator.
//
// A change of an application with a serving release is APPLIED TO THAT RELEASE
// AT ONCE, with no build: its own commit and image go out again as a new
// release (`cause: 'idle_policy'`) through the one release path, carrying the
// new policy. The release path stores the policy in the same transaction that
// makes the release live, so the stored value changes only once the port has
// accepted it, and a refused or failed redeploy leaves both the stored policy
// and the serving release as they were. Going through the release path (rather
// than redeploying in place) is what keeps the provider's release history and
// the application's pointers in step, so a rollback still restores the release
// it names; it also inherits the release path's lock, its in-flight refusal,
// and the recorded AWS shape (MOTIR-12093).
//
// An application with no serving release has nothing to redeploy: the policy is
// checked against its target and shape and stored, and its first release runs
// it.
//
// ⚠️ WHICH TARGET CAN RUN WHICH POLICY IS THE PORT'S RULE. Both the check before
// there is a release and the check before a redeploy are `idlePolicyRefusal`,
// the function the adapters refuse through, so a refusal is answered before any
// release row is written; the port refusing at deploy anyway (a rule that moved)
// is still mapped to the same typed refusal.
//
// A customer repository has no hosted application and no policy (Decision
// MOTIR-5769, D1): both reads and writes refuse it, and nothing here writes the
// project phase.

export interface IdlePolicyReadInput {
  projectRepositoryId: string;
  /** Whether the viewer may change it — the caller's permission read. */
  isAdministrator: boolean;
}

export interface SetIdlePolicyInput {
  projectRepositoryId: string;
  policy: HostedIdlePolicy;
  actor: AccessActorContext;
}

export interface IdlePolicyDeps {
  /** The hosting manifest at a commit — the release path's own by default. */
  readManifest?: (projectRepositoryId: string, commitSha: string) => Promise<HostingManifest>;
}

interface RepositoryFacts {
  projectId: string;
  target: HostingTarget | null;
  shape: HostingShape | null;
}

/** The repository's hosting facts, refusing an unknown one and a customer one. */
async function repositoryFacts(projectRepositoryId: string): Promise<RepositoryFacts> {
  const repo = await withSystemContext((tx) =>
    projectRepoRepository.findDeployFactsInTx(projectRepositoryId, tx),
  );
  if (!repo) throw new ApplicationNotFoundError(projectRepositoryId);
  if (deployEligibilityRefusal(repo) === 'customer_repository') {
    throw new CustomerRepositoryNotDeployableError(projectRepositoryId);
  }
  return { projectId: repo.projectId, target: repo.hostingTarget, shape: repo.hostingShape };
}

/** The policy the target and shape cannot run, as the read model names it. */
function refusalFor(
  target: HostingTarget,
  shape: HostingShape | null,
): IdlePolicyRefusalDto | null {
  const refused = idlePolicyRefusal(target, shape, {
    mode: 'suspend',
    idleSeconds: HOSTED_IDLE_SECONDS_DEFAULT,
  });
  return refused ? { code: refused.code, target, shape, mode: 'suspend' } : null;
}

/** The repository's application's policy, whether the viewer may change it, and
 *  the policy its target refuses. No application yet ⇒ no policy. */
async function readIdlePolicy(input: IdlePolicyReadInput): Promise<IdlePolicyDto> {
  const facts = await repositoryFacts(input.projectRepositoryId);
  const app = await hostedApplicationService.getApplicationForRepositorySystem(
    input.projectRepositoryId,
  );
  if (!app) return { policy: null, editable: false, refusal: null };
  return {
    policy: app.idlePolicy,
    editable: input.isAdministrator,
    refusal: refusalFor(app.target, facts.shape),
  };
}

async function assertMayChange(
  projectId: string,
  projectRepositoryId: string,
  actor: AccessActorContext,
): Promise<void> {
  try {
    await projectAccessService.assertPermission(projectId, actor, 'project:administer');
  } catch (error) {
    if (
      error instanceof NotProjectAdminError ||
      error instanceof PermissionDeniedError ||
      error instanceof ProjectNotFoundError
    ) {
      throw new IdlePolicyNotPermittedError(projectRepositoryId);
    }
    throw error;
  }
}

/** Under the application's row lock: refuse a release in flight, then either
 *  store the policy (nothing serving) or answer the release to redeploy. */
async function storeOrPlan(
  app: HostedApplicationDto,
  policy: HostedIdlePolicy,
): Promise<
  | { kind: 'stored' }
  | { kind: 'unchanged' }
  | { kind: 'redeploy'; commitSha: string; ref: string | null; artifactRef: string }
> {
  return withSystemContext(async (tx) => {
    if (!(await hostedApplicationRepository.lockForUpdate(app.id, tx))) {
      throw new ApplicationNotFoundError(app.id);
    }
    const inFlight = await hostedReleaseRepository.findInFlightByApplication(app.id, tx);
    if (inFlight) throw new ReleaseInProgressError(app.id, inFlight.id, inFlight.state);
    const row = (await hostedApplicationRepository.findById(app.id, tx))!;
    if (sameIdlePolicy(idlePolicyOfRow(row), policy)) return { kind: 'unchanged' };
    const serving = row.currentRelease;
    if (serving?.state === 'live' && serving.artifactRef) {
      return {
        kind: 'redeploy',
        commitSha: serving.commitSha,
        ref: serving.ref,
        artifactRef: serving.artifactRef,
      };
    }
    // The workspace comes from the stored row, never from input.
    await bindWorkspaceContext(tx, row.workspaceId);
    await hostedApplicationRepository.setIdlePolicy(app.id, idlePolicyColumns(policy), tx);
    return { kind: 'stored' };
  });
}

/** The release path's failure reason for the port's idle-policy refusal. */
const PORT_REFUSED_REASON = 'deploy: HOSTING_IDLE_POLICY_UNSUPPORTED';

/**
 * Change the repository's application's idle policy, for a project
 * administrator, and apply it to the serving release. Answers the policy now
 * stored. Every refusal is typed and changes nothing.
 */
async function setIdlePolicy(
  input: SetIdlePolicyInput,
  deps: IdlePolicyDeps = {},
): Promise<IdlePolicyDto> {
  const { projectRepositoryId, policy, actor } = input;
  const facts = await repositoryFacts(projectRepositoryId);
  const app = await hostedApplicationService.getApplicationForRepositorySystem(projectRepositoryId);
  if (!app) throw new NoProductionApplicationError(projectRepositoryId);
  await assertMayChange(facts.projectId, projectRepositoryId, actor);

  // The port's own rule, before anything is written or deployed.
  const refused = idlePolicyRefusal(app.target, facts.shape, policy);
  if (refused) {
    throw new IdlePolicyUnsupportedForTargetError(app.id, app.target, facts.shape, policy.mode);
  }
  await assertAlwaysOnAffordable(app.id, policy);

  await applyPlan(projectRepositoryId, app, policy, actor.userId, deps);
  return readIdlePolicy({ projectRepositoryId, isAdministrator: true });
}

/**
 * Refuse `always_on` while the organisation is below zero (Decision MOTIR-12100
 * §9), for an application whose target can suspend. The meter's stored state
 * says the organisation went below zero; the balance read live confirms it, so
 * a top-up lifts the refusal at once, and an unreadable balance keeps it.
 */
async function assertAlwaysOnAffordable(
  applicationId: string,
  policy: HostedIdlePolicy,
): Promise<void> {
  if (policy.mode !== 'always_on') return;
  const meter = await withSystemContext((tx) =>
    hostedApplicationRepository.findMeterTarget(applicationId, tx),
  );
  // Only an application the meter has seen below zero is asked about: the
  // live read then confirms it, so a top-up lifts the refusal at once.
  if (!meter?.creditsExhaustedSince || !productionUsageService.canSuspend(meter)) return;
  const { below } = await productionUsageService.isBelowZero(
    meter.organizationId,
    meter.creditsExhaustedSince,
  );
  if (below) throw new AlwaysOnRefusedOutOfCreditsError(applicationId);
}

/** Store the policy, or redeploy the serving release with it. */
async function applyPlan(
  projectRepositoryId: string,
  app: HostedApplicationDto,
  policy: HostedIdlePolicy,
  requestedById: string | null,
  deps: IdlePolicyDeps,
): Promise<'stored' | 'unchanged' | 'applied'> {
  const facts = await repositoryFacts(projectRepositoryId);
  const plan = await storeOrPlan(app, policy);
  if (plan.kind !== 'redeploy') return plan.kind;
  const release = await productionReleaseService.deployProductionRelease(
    {
      projectRepositoryId,
      commitSha: plan.commitSha,
      ref: plan.ref,
      artifactRef: plan.artifactRef,
      requestedById,
      cause: 'idle_policy',
      idle: policy,
    },
    deps,
  );
  if (release.state !== 'live') {
    if (release.failureReason === PORT_REFUSED_REASON) {
      throw new IdlePolicyUnsupportedForTargetError(app.id, app.target, facts.shape, policy.mode);
    }
    throw new IdlePolicyApplyFailedError(app.id, release.id);
  }
  return 'applied';
}

/**
 * Apply a policy with no person behind it — the production meter's switch of an
 * always-on application to suspend when idle after 7 days below zero (Decision
 * MOTIR-12100 §9). The same release path as an administrator's change, so the
 * serving release is redeployed with no build; the target's own rule refuses a
 * policy it cannot run before anything is written. Answers what happened.
 */
async function applyIdlePolicyAsSystem(
  projectRepositoryId: string,
  policy: HostedIdlePolicy,
  deps: IdlePolicyDeps = {},
): Promise<'stored' | 'unchanged' | 'applied'> {
  const facts = await repositoryFacts(projectRepositoryId);
  const app = await hostedApplicationService.getApplicationForRepositorySystem(projectRepositoryId);
  if (!app) throw new NoProductionApplicationError(projectRepositoryId);
  if (idlePolicyRefusal(app.target, facts.shape, policy)) {
    throw new IdlePolicyUnsupportedForTargetError(app.id, app.target, facts.shape, policy.mode);
  }
  return applyPlan(projectRepositoryId, app, policy, null, deps);
}

export const hostedIdlePolicyService = { readIdlePolicy, setIdlePolicy, applyIdlePolicyAsSystem };
