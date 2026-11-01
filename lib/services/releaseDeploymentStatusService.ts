import { RepoProvisioningApiError } from '@/lib/github/repoProvisioning';
import { repoDeployments } from '@/lib/github/repoDeployments';
import { ReleaseStatusPostError, type ReleaseStatusPostStep } from '@/lib/hosting/errors';
import {
  isReleaseDeploymentState,
  PRODUCTION_DEPLOYMENT_ENVIRONMENT,
  statusesToPost,
  type ReleaseDeploymentState,
} from '@/lib/hosting/releaseDeploymentStatus';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { hostedReleaseRepository } from '@/lib/repositories/hostedReleaseRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { withSystemContext } from '@/lib/workspaces/context';

// EVERY RELEASE POSTS ITS GITHUB DEPLOYMENT STATUS (Story MOTIR-9797 ·
// MOTIR-10033). A release's state change enqueues `hosted-release.status` after
// its transaction commits (`hostedApplicationService`); the job body here creates
// the release's GitHub deployment in environment `production` once, and posts the
// statuses that bring GitHub to the release's CURRENT state
// (`statusesToPost`). The statuses are stored by GitHub's `deployment_status`
// webhook through the shipped `repoDeploymentService.record` — nothing here
// writes `repo_deployment`, so the stored row is exactly what GitHub holds.
//
// ⚠️ ONE POSTER PER RELEASE AT A TIME. Two jobs for one release (its creation
// and its first move are one transaction, so two events land together) would
// otherwise both create a deployment, or post `pending` after `success`. The
// body runs under a transaction-scoped advisory lock on the release, held in a
// transaction that does nothing else, while its reads and writes commit in their
// own — so the handle written before a status post survives that post failing,
// and a retry reuses it instead of creating a second deployment.
//
// A failure is the job's to retry and never the release's: the state change it
// announces committed before the job was enqueued. Errors carry the step and the
// HTTP status only.

/** The lock transaction's budget: three GitHub calls and the writes between them,
 *  with room for a slow host. Past it Prisma expires the transaction and the job
 *  retries, which the stored handle makes safe. */
export const RELEASE_STATUS_LOCK_TIMEOUT_MS = 60_000;

/** The `hosted-release.status` event payload — ids only. */
export interface ReleaseStatusRequestedData {
  workspaceId: string;
  releaseId: string;
}

export type PostReleaseStatusOutcome =
  | { outcome: 'posted'; statuses: ReleaseDeploymentState[] }
  | { outcome: 'up_to_date' }
  | { outcome: 'release_not_found' };

async function inStep<T>(
  releaseId: string,
  step: ReleaseStatusPostStep,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ReleaseStatusPostError) throw error;
    const status = error instanceof RepoProvisioningApiError ? error.status : null;
    throw new ReleaseStatusPostError(releaseId, step, status);
  }
}

async function postUnderLock(releaseId: string): Promise<PostReleaseStatusOutcome> {
  const target = await withSystemContext((tx) =>
    hostedReleaseRepository.findStatusTarget(releaseId, tx),
  );
  if (!target) return { outcome: 'release_not_found' };
  const posted = isReleaseDeploymentState(target.statusPostedState)
    ? target.statusPostedState
    : null;
  const statuses = statusesToPost(posted, target.state);
  if (statuses.length === 0) return { outcome: 'up_to_date' };

  const access = await inStep(releaseId, 'repository', async () => {
    const facts = await withSystemContext((tx) =>
      projectRepoRepository.findDeployFactsInTx(target.projectRepositoryId, tx),
    );
    if (!facts?.githubRepo) throw new ReleaseStatusPostError(releaseId, 'repository', null);
    return hostedRepositoryAccessService.accessFor({
      workspaceId: facts.workspaceId,
      githubRepo: facts.githubRepo,
    });
  });

  let deploymentId = target.githubDeploymentId;
  if (deploymentId === null) {
    const created = await inStep(releaseId, 'deployment', () =>
      repoDeployments.createDeployment(access, {
        ref: target.commitSha,
        environment: PRODUCTION_DEPLOYMENT_ENVIRONMENT,
        description: `Motir production release ${releaseId}`,
      }),
    );
    // BEFORE any status: a retry after a failed post must find it.
    await withSystemContext((tx) =>
      hostedReleaseRepository.setDeploymentHandle(releaseId, { githubDeploymentId: created }, tx),
    );
    deploymentId = created;
  }

  let from = posted;
  for (const state of statuses) {
    const environmentUrl =
      state === 'success' && target.productionAddress
        ? `https://${target.productionAddress}`
        : null;
    await inStep(releaseId, 'status', () =>
      repoDeployments.createDeploymentStatus(access, {
        deploymentId: deploymentId!,
        state,
        environmentUrl,
      }),
    );
    await withSystemContext((tx) =>
      hostedReleaseRepository.markStatusPosted(releaseId, { from, to: state }, tx),
    );
    from = state;
  }
  return { outcome: 'posted', statuses };
}

/** The job body: bring the release's GitHub deployment to its current state. */
async function postReleaseDeploymentStatus(releaseId: string): Promise<PostReleaseStatusOutcome> {
  return withSystemContext(
    async (lockTx) => {
      await hostedReleaseRepository.lockStatusPost(releaseId, lockTx);
      return postUnderLock(releaseId);
    },
    { timeout: RELEASE_STATUS_LOCK_TIMEOUT_MS },
  );
}

/**
 * Ask for the release's status to be posted. Called after the transaction that
 * moved the release commits; best-effort like every enqueue — the next state
 * change of the release enqueues again, and the job posts whatever it is then.
 */
async function enqueueReleaseStatusPost(releaseId: string): Promise<void> {
  const workspaceId = await withSystemContext((tx) =>
    hostedReleaseRepository.findWorkspaceId(releaseId, tx),
  );
  if (!workspaceId) return;
  await sendEvent('hosted-release.status', { workspaceId, releaseId });
}

export const releaseDeploymentStatusService = {
  postReleaseDeploymentStatus,
  enqueueReleaseStatusPost,
};
