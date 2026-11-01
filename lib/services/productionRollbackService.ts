import {
  NoPreviousReleaseError as PortNoPreviousReleaseError,
  OrchestratorApiError,
  type ReleaseHandle,
} from '@motir/orchestrator';
import type { HostedApplicationDto } from '@/lib/dto/hostedApplications';
import { deployEligibilityRefusal } from '@/lib/hosting/deployEligibility';
import {
  ApplicationNotFoundError,
  CustomerRepositoryNotDeployableError,
  IllegalReleaseTransitionError,
  NoPreviousReleaseError,
  ReleaseInProgressError,
  RollbackFailedError,
  RollbackNotPermittedError,
  type RollbackStep,
} from '@/lib/hosting/errors';
import type { HostedReleaseState } from '@/lib/hosting/vocabulary';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedReleaseUsageService } from '@/lib/services/hostedReleaseUsageService';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import { withSystemContext } from '@/lib/workspaces/context';

// ROLL BACK PRODUCTION (Story MOTIR-9797 · MOTIR-10035): take a Motir
// repository's application back to the release it replaced, in one step, for a
// project administrator.
//
// The order is what decides what is serving when a step fails:
//   1. refuse a customer repository, one with no application, and an actor
//      without the project's administration permission — here, at the service,
//      so no caller can skip it;
//   2. under the application's row lock, refuse a release in flight and an
//      application with no previous release, then let the lock go;
//   3. settle the leaving release's usage and call the deploy port's rollback,
//      with no transaction held — a port failure changes no row, because the
//      release that was serving still is;
//   4. under the row lock again, re-check the pointers, return the previous
//      release to live (its usage window restarted at the restore) and swap the
//      pointers, which moves the leaving release to `rolled_back`.
// Both state changes go through `hostedApplicationService`, so each announces its
// GitHub deployment status after commit (MOTIR-10033) — this service posts none.
//
// Rollbacks of ONE application are serialised by an advisory lock held across
// all four steps, so two at once cannot both ask the port to toggle and then
// disagree with it about which release is serving.
//
// ⚠️ CODE, NEVER SCHEMA. A rollback reverts the running code and its
// environment only: no migration, no database call, no database URL.

/** Budget for the serialising lock transaction: a settle, two port calls and two
 *  short transactions, with room for a slow provider. */
export const ROLLBACK_LOCK_TIMEOUT_MS = 120_000;

export interface RollbackProductionInput {
  projectRepositoryId: string;
  actor: AccessActorContext;
}

/** The releases a rollback swaps, as checked under the row lock. */
interface RollbackPlan {
  currentId: string;
  previousId: string;
  previousState: HostedReleaseState;
  previousProviderReleaseId: string | null;
  previousProviderRef: string | null;
}

/** The states a previous release can be restored from — it was live once. */
const RESTORABLE: readonly HostedReleaseState[] = ['replaced', 'rolled_back'];

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_NAME = /^[A-Za-z]{1,64}$/;

/** The step, status and code of a port failure — nothing else of it. */
function failureOf(applicationId: string, step: RollbackStep, error: unknown): Error {
  if (error instanceof PortNoPreviousReleaseError) return new NoPreviousReleaseError(applicationId);
  const status = error instanceof OrchestratorApiError ? error.status : null;
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : '';
  const causeCode =
    typeof code === 'string' && ERROR_CODE.test(code)
      ? code
      : ERROR_NAME.test(name)
        ? name
        : 'UNKNOWN';
  return new RollbackFailedError(applicationId, step, status, causeCode);
}

async function inStep<T>(
  applicationId: string,
  step: RollbackStep,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw failureOf(applicationId, step, error);
  }
}

async function assertMayRollBack(
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
      throw new RollbackNotPermittedError(projectRepositoryId);
    }
    throw error;
  }
}

/** Under the row lock: what the rollback will swap, or the typed refusal. */
async function planRollback(applicationId: string): Promise<RollbackPlan> {
  return withSystemContext(async (tx) => {
    if (!(await hostedApplicationRepository.lockForUpdate(applicationId, tx))) {
      throw new ApplicationNotFoundError(applicationId);
    }
    const inFlight = await hostedReleaseRepository.findInFlightByApplication(applicationId, tx);
    if (inFlight) throw new ReleaseInProgressError(applicationId, inFlight.id, inFlight.state);
    const app = (await hostedApplicationRepository.findById(applicationId, tx))!;
    const current = app.currentRelease;
    const previous = app.previousRelease;
    if (current?.state !== 'live' || !previous || !RESTORABLE.includes(previous.state)) {
      throw new NoPreviousReleaseError(applicationId);
    }
    return {
      currentId: current.id,
      previousId: previous.id,
      previousState: previous.state,
      previousProviderReleaseId: previous.providerReleaseId,
      previousProviderRef: previous.providerRef,
    };
  });
}

/** The port restored the release the rows say it should: the same provider
 *  release, and the same provider handle when one was stored. */
function restoredTheExpected(plan: RollbackPlan, handle: ReleaseHandle): boolean {
  if (plan.previousProviderReleaseId !== handle.releaseId) return false;
  return plan.previousProviderRef === null || plan.previousProviderRef === handle.providerRef;
}

/** Under the row lock again: the pointers are still the planned ones, then the
 *  restore and the swap in one transaction. */
async function commitRollback(
  applicationId: string,
  plan: RollbackPlan,
  handle: ReleaseHandle,
  actorId: string,
): Promise<HostedApplicationDto> {
  return withSystemContext(async (tx) => {
    if (!(await hostedApplicationRepository.lockForUpdate(applicationId, tx))) {
      throw new ApplicationNotFoundError(applicationId);
    }
    const app = (await hostedApplicationRepository.findById(applicationId, tx))!;
    if (app.currentReleaseId !== plan.currentId || app.previousReleaseId !== plan.previousId) {
      throw new IllegalReleaseTransitionError(
        plan.previousId,
        plan.previousState,
        'live',
        app.previousRelease?.id === plan.previousId ? app.previousRelease.state : null,
      );
    }
    await hostedApplicationService.transitionRelease(
      plan.previousId,
      plan.previousState,
      'live',
      {
        providerReleaseId: handle.releaseId,
        providerRef: handle.providerRef,
        // The restored release's next usage window starts at the restore.
        usageSettledUntil: null,
        restoredById: actorId,
        restoredAt: new Date(),
      },
      tx,
    );
    return hostedApplicationService.swapCurrentRelease(applicationId, plan.previousId, tx, {
      outgoing: 'rolled_back',
    });
  });
}

/** Roll the repository's production application back to its previous release. */
async function rollbackProduction(input: RollbackProductionInput): Promise<HostedApplicationDto> {
  const { projectRepositoryId, actor } = input;
  const repo = await withSystemContext((tx) =>
    projectRepoRepository.findDeployFactsInTx(projectRepositoryId, tx),
  );
  if (!repo) throw new ApplicationNotFoundError(projectRepositoryId);
  if (deployEligibilityRefusal(repo) === 'customer_repository') {
    throw new CustomerRepositoryNotDeployableError(projectRepositoryId);
  }
  const app = await hostedApplicationService.getApplicationForRepositorySystem(projectRepositoryId);
  if (!app) throw new ApplicationNotFoundError(projectRepositoryId);
  await assertMayRollBack(repo.projectId, projectRepositoryId, actor);

  return withSystemContext(
    async (lockTx) => {
      await hostedApplicationRepository.lockRollback(app.id, lockTx);
      const plan = await planRollback(app.id);

      await hostedReleaseUsageService.settleReleaseUsage(plan.currentId);
      const port = getHostingDeployPort(app.target);
      const { appRef } = await inStep(app.id, 'app', () =>
        port.ensureApp({ repositoryId: projectRepositoryId, environment: { kind: 'production' } }),
      );
      const handle = await inStep(app.id, 'rollback', () =>
        port.rollback({ appRef, environment: { kind: 'production' } }),
      );
      if (!restoredTheExpected(plan, handle)) {
        throw new RollbackFailedError(app.id, 'verify', null, 'RESTORED_RELEASE_MISMATCH');
      }
      return commitRollback(app.id, plan, handle, actor.userId);
    },
    { timeout: ROLLBACK_LOCK_TIMEOUT_MS },
  );
}

export const productionRollbackService = { rollbackProduction };
