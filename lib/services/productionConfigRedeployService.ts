import { deployEligibilityRefusal } from '@/lib/hosting/deployEligibility';
import { ReleaseInProgressError } from '@/lib/hosting/errors';
import type { EnvironmentConfigChangedData } from '@/lib/jobs/types';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { withSystemContext } from '@/lib/workspaces/context';

// A PRODUCTION CONFIG CHANGE REDEPLOYS THE CURRENT RELEASE (Story MOTIR-9797 ·
// MOTIR-10032). Saving a production variable or secret of a Motir repository
// emits `environment.config.changed`; this service turns it into a NEW release of
// the commit and image that are live, `cause: 'config_change'`, through the one
// release entry point. The release service resolves the environment at deploy
// time, so the redeploy carries every value saved up to the moment it runs.
//
// Coalescing is the job's (`lib/jobs/definitions/productionConfigRedeploy.ts`):
// the engine debounces one repository's production events into ONE run with the
// latest event, so a burst of saves is one release, not one per save. This
// service decides what a run does:
//   * the event is not for production ⇒ nothing (preview / release are other
//     stories' listeners);
//   * a customer repository, or nothing live yet ⇒ a skipped outcome, no row —
//     the first release reads the new values anyway;
//   * another release in flight ⇒ deferred, and given up after the job's last
//     try with no row (a merge release in flight resolves the environment
//     itself, and a value saved after it resolved re-emits the event);
//   * otherwise the redeploy, whose failure is a failed release recorded by the
//     release service, never retried here.
//
// Ids only: the event carries no value, and nothing here logs or stores one.

/** How many times a redeploy is tried while another release is in flight, the
 *  first try included. */
export const CONFIG_REDEPLOY_MAX_ATTEMPTS = 5;

/** The settle delay: a quiet period this long closes a burst of saves, and is
 *  also the wait between tries while another release is in flight. */
export const CONFIG_REDEPLOY_SETTLE_MS = 30_000;

/** The engine's debounce durations, the same settle delay spelled for
 *  `defineJob`, and the cap on total deferral of a burst that never goes quiet. */
export const CONFIG_REDEPLOY_DEBOUNCE = { period: '30s', timeout: '5m' } as const;

export interface RunProductionRedeployInput {
  projectRepositoryId: string;
  /** Zero-based: the job's try while another release is in flight. */
  attempt: number;
}

export type RunProductionRedeployOutcome =
  | { outcome: 'redeployed'; releaseId: string }
  | { outcome: 'failed_release'; releaseId: string }
  | { outcome: 'skipped_no_live_release' }
  | { outcome: 'skipped_customer_repository' }
  | { outcome: 'deferred_in_progress' }
  | { outcome: 'gave_up_in_progress' };

/** Whether a config-changed event asks for a production redeploy at all. */
function isProductionChange(event: Pick<EnvironmentConfigChangedData, 'environment'>): boolean {
  return event.environment === 'production';
}

async function runProductionRedeploy(
  input: RunProductionRedeployInput,
): Promise<RunProductionRedeployOutcome> {
  const { projectRepositoryId } = input;
  const facts = await withSystemContext((tx) =>
    projectRepoRepository.findDeployFactsInTx(projectRepositoryId, tx),
  );
  if (facts && deployEligibilityRefusal(facts) === 'customer_repository') {
    return { outcome: 'skipped_customer_repository' };
  }
  // The CURRENT release at the moment the run starts — after the settle delay,
  // so a merge that went live during the burst is the one redeployed.
  const app = await hostedApplicationService.getApplicationForRepositorySystem(projectRepositoryId);
  const live = app?.currentRelease ?? null;
  if (!live || live.state !== 'live' || !live.artifactRef) {
    return { outcome: 'skipped_no_live_release' };
  }
  try {
    const release = await productionReleaseService.deployProductionRelease({
      projectRepositoryId,
      commitSha: live.commitSha,
      ref: live.ref,
      artifactRef: live.artifactRef,
      cause: 'config_change',
    });
    return release.state === 'live'
      ? { outcome: 'redeployed', releaseId: release.id }
      : { outcome: 'failed_release', releaseId: release.id };
  } catch (error) {
    if (!(error instanceof ReleaseInProgressError)) throw error;
    return input.attempt + 1 < CONFIG_REDEPLOY_MAX_ATTEMPTS
      ? { outcome: 'deferred_in_progress' }
      : { outcome: 'gave_up_in_progress' };
  }
}

export const productionConfigRedeployService = { isProductionChange, runProductionRedeploy };
