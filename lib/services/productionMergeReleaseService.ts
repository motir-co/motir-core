import type { NormalizedProductionImageRun } from '@/lib/git/types';
import { isDeployEligible } from '@/lib/hosting/deployEligibility';
import { ReleaseInProgressError } from '@/lib/hosting/errors';
import { productionArtifactRef } from '@/lib/hosting/productionArtifact';
import { PRODUCTION_IMAGE_WORKFLOW } from '@/lib/hosting/productionEnablementNames';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { withSystemContext } from '@/lib/workspaces/context';

// A MERGE STARTS A RELEASE (Story MOTIR-9797 · MOTIR-10031). The starter's
// `production-image` workflow builds and pushes `<image repository>:<sha>` on a
// push to `main`; when GitHub reports that run completed, this service releases
// exactly that commit through the release service, or records the failed build.
//
// Two halves, both here so tests call them directly:
//   * `handleProductionImageRun` — the webhook's: filter the run, resolve the
//     repository, and enqueue one durable job per project repository that has
//     production switched on. Everything it does not release is SILENT: a
//     customer repository, one not switched on, another workflow, a pull-request
//     run, another branch — no row is written and nothing throws.
//   * `runMergeRelease` — the job's body: release on `success`, record a failed
//     release on `failure` / `timed_out`, nothing on `cancelled` / `skipped`.
//
// The run is trusted for the commit and the outcome only: no value of its logs
// or environment is read. Which of two merges is newer is not decided here — the
// workflow's concurrency group runs them in order, and the release service
// refuses a second release while one is in flight (`ReleaseInProgressError`),
// which this service defers and retries a fixed number of times.

/** The conclusions that mean the image was not built. */
const BUILD_FAILED = new Set(['failure', 'timed_out']);

/** How many times a merge release is tried while another release is in flight,
 *  the first try included. */
export const MERGE_RELEASE_MAX_ATTEMPTS = 6;

/** The wait between those tries — a release is a migration plus a deploy. */
export const MERGE_RELEASE_IN_PROGRESS_WAIT_MS = 2 * 60_000;

/** The reason a merge release that never got its turn is recorded with. */
export const IN_PROGRESS_GAVE_UP_REASON = 'another release was in progress';

/** The `hosting/merge-release.requested` event payload. Ids, the commit, what
 *  the merge was and the run's outcome only — never a value. */
export interface MergeReleaseRequestedData {
  /** The repository's tenant. */
  workspaceId: string;
  projectRepositoryId: string;
  /** The commit the run built. */
  headSha: string;
  /** The commit's subject and the pull request it merged (MOTIR-10103).
   *  Optional: an event enqueued before they were carried has neither. */
  commitSubject?: string | null;
  pullRequestNumber?: number | null;
  conclusion: string;
  runId: string;
  runAttempt: number;
  /** `<runId>:<runAttempt>:<projectRepositoryId>` — a redelivered webhook
   *  enqueues nothing new; a re-run of the workflow is a new attempt. */
  idempotencyKey: string;
}

export type HandleProductionImageRunOutcome =
  | {
      outcome: 'ignored';
      reason:
        | 'other_workflow'
        | 'not_a_push'
        | 'unknown_installation'
        | 'unknown_repo'
        | 'not_default_branch'
        | 'not_switched_on';
    }
  | { outcome: 'enqueued'; projectRepositoryIds: string[] };

export interface RunMergeReleaseInput {
  projectRepositoryId: string;
  headSha: string;
  commitSubject?: string | null;
  pullRequestNumber?: number | null;
  conclusion: string;
  /** Zero-based: the job's try while another release is in flight. */
  attempt: number;
}

export type RunMergeReleaseOutcome =
  | { outcome: 'released'; releaseId: string; state: string }
  | { outcome: 'build_failed_recorded'; releaseId: string }
  | { outcome: 'ignored' }
  | { outcome: 'deferred_in_progress' }
  | { outcome: 'gave_up_in_progress'; releaseId: string };

async function handleProductionImageRun(
  run: NormalizedProductionImageRun,
  installationId: string,
): Promise<HandleProductionImageRunOutcome> {
  if (run.workflowName !== PRODUCTION_IMAGE_WORKFLOW) {
    return { outcome: 'ignored', reason: 'other_workflow' };
  }
  if (run.event !== 'push') return { outcome: 'ignored', reason: 'not_a_push' };

  const resolved = await withSystemContext(async (tx) => {
    const installation = await githubInstallationRepository.findByInstallationId(
      installationId,
      tx,
    );
    if (!installation) return 'unknown_installation' as const;
    const repo = await githubRepoRepository.findByInstallationAndRepoId(
      installation.id,
      run.providerRepoId,
      tx,
    );
    if (!repo) return 'unknown_repo' as const;
    if (run.headBranch !== repo.defaultBranch) return 'not_default_branch' as const;
    const rows = await projectRepoRepository.listByGithubRepoId(repo.id, tx);
    return rows.filter(isDeployEligible).map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
    }));
  });
  if (typeof resolved === 'string') return { outcome: 'ignored', reason: resolved };

  const enqueued: string[] = [];
  for (const row of resolved) {
    if (!(await hostedApplicationService.getProductionSwitch(row.id))) continue;
    // POST-read, best-effort like every webhook enqueue: the dispatcher's
    // idempotency index makes a redelivery of this run enqueue nothing new.
    await sendEvent('hosting/merge-release.requested', {
      workspaceId: row.workspaceId,
      projectRepositoryId: row.id,
      headSha: run.headSha,
      commitSubject: run.headCommitSubject,
      pullRequestNumber: run.pullRequestNumber,
      conclusion: run.conclusion,
      runId: run.runId,
      runAttempt: run.runAttempt,
      idempotencyKey: `${run.runId}:${run.runAttempt}:${row.id}`,
    });
    enqueued.push(row.id);
  }
  if (enqueued.length === 0) return { outcome: 'ignored', reason: 'not_switched_on' };
  return { outcome: 'enqueued', projectRepositoryIds: enqueued };
}

async function runMergeRelease(input: RunMergeReleaseInput): Promise<RunMergeReleaseOutcome> {
  const { projectRepositoryId, headSha, conclusion } = input;
  const merge = {
    commitSubject: input.commitSubject ?? null,
    pullRequestNumber: input.pullRequestNumber ?? null,
  };
  if (BUILD_FAILED.has(conclusion)) {
    const failed = await productionReleaseService.recordFailedRelease(
      projectRepositoryId,
      headSha,
      `build ${conclusion}`,
      merge,
    );
    return { outcome: 'build_failed_recorded', releaseId: failed.id };
  }
  if (conclusion !== 'success') return { outcome: 'ignored' };

  // Re-read at run time: production can have been switched off since the
  // webhook, and the app name is what the workflow pushed to.
  const production = await hostedApplicationService.getProductionSwitch(projectRepositoryId);
  if (!production) return { outcome: 'ignored' };
  try {
    const release = await productionReleaseService.deployProductionRelease({
      projectRepositoryId,
      commitSha: headSha,
      artifactRef: productionArtifactRef(production.appName, headSha),
      cause: 'merge',
      ...merge,
    });
    return { outcome: 'released', releaseId: release.id, state: release.state };
  } catch (error) {
    if (!(error instanceof ReleaseInProgressError)) throw error;
    if (input.attempt + 1 < MERGE_RELEASE_MAX_ATTEMPTS) return { outcome: 'deferred_in_progress' };
    const failed = await productionReleaseService.recordFailedRelease(
      projectRepositoryId,
      headSha,
      IN_PROGRESS_GAVE_UP_REASON,
      merge,
    );
    return { outcome: 'gave_up_in_progress', releaseId: failed.id };
  }
}

export const productionMergeReleaseService = { handleProductionImageRun, runMergeRelease };
