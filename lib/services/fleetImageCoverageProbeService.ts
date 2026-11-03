import { isGithubAppConfigured } from '@/lib/github/appAuth';
import { configuredFleetRunnerImage } from '@/lib/orchestrator';
import { FleetOrgCiGithubWriteError } from '@/lib/platform/errors';
import { fleetOrgCiSettingService } from '@/lib/services/fleetOrgCiSettingService';
import { fleetReadinessService } from '@/lib/services/fleetReadinessService';
import type {
  FleetImageCoveragePairDTO,
  FleetImageCoverageVerdictDTO,
} from '@/lib/dto/fleetImageCoverage';

// THE FLEET IMAGE-COVERAGE PROBE (MOTIR-10290) — a probe of
// `system.daily-health-check` that fails when a job a connected org sends to the
// fleet cannot run on the runner image this deployment pins.
//
// ⚠️ IT ASKS READINESS'S OWN QUESTION. It does not judge anything itself: for
// every pair the fleet console offers it calls `fleetReadinessService
// .imageCoverageFor`, which reads the private repositories' workflows at their
// newest `.github` commit and compares each fleet job with the pinned image's
// tool list. The page and the probe therefore cannot disagree, and nothing here
// is a snapshot that a workflow change can leave behind (MOTIR-10211 was a probe
// for exactly that drift; with no snapshot there is no drift to probe).
//
// ⚠️ ONLY A DEFINITE GAP IS LOUD: a job the image cannot run, or a pinned image
// that records no tool list. A read GitHub or the registry refused is
// `indeterminate` — a statement about the read — and is on the job_run row either
// way. `not_applicable` is a deployment that runs no fleet: no provisioning App,
// or no runner image pinned.

/** Reason codes of condition 9 that state a gap the image owner must close. */
const GAP_CODES = new Set(['jobs_not_runnable', 'image_tools_unrecorded']);

/** Fold the per-pair answers into the verdict. Pure; exported for its unit test. */
export function judgeCoverage(
  checkedAt: string,
  pairs: FleetImageCoveragePairDTO[],
): FleetImageCoverageVerdictDTO {
  if (pairs.some((p) => p.state === 'unmet' && GAP_CODES.has(p.reasonCode))) {
    return { verdict: 'gap', checkedAt, pairs };
  }
  if (pairs.some((p) => p.state === 'unknown')) {
    return { verdict: 'indeterminate', checkedAt, pairs, targetsUnreadable: null };
  }
  return { verdict: 'runnable', checkedAt, pairs };
}

export const fleetImageCoverageProbeService = {
  /** Judge every offered pair. Never throws on a gap or a refused read — the
   *  caller decides which arms are loud. */
  async check(options: { now?: Date } = {}): Promise<FleetImageCoverageVerdictDTO> {
    const checkedAt = (options.now ?? new Date()).toISOString();
    if (!isGithubAppConfigured('provisioning')) {
      return { verdict: 'not_applicable', checkedAt, reason: 'app_not_configured' };
    }
    if (!configuredFleetRunnerImage()) {
      return { verdict: 'not_applicable', checkedAt, reason: 'runner_image_unset' };
    }
    let targets: Awaited<ReturnType<typeof fleetOrgCiSettingService.systemTargets>>;
    try {
      targets = await fleetOrgCiSettingService.systemTargets();
    } catch (err) {
      if (!(err instanceof FleetOrgCiGithubWriteError)) throw err;
      return {
        verdict: 'indeterminate',
        checkedAt,
        pairs: [],
        targetsUnreadable: { status: err.status },
      };
    }
    if (targets.length === 0) {
      return { verdict: 'not_applicable', checkedAt, reason: 'no_targets' };
    }
    const pairs: FleetImageCoveragePairDTO[] = [];
    for (const target of targets) {
      const c = await fleetReadinessService.imageCoverageFor({
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        org: target.org,
      });
      pairs.push({
        projectKey: target.projectKey,
        org: target.org,
        state: c.state,
        reasonCode: c.reasonCode,
        message: c.message,
      });
    }
    return judgeCoverage(checkedAt, pairs);
  },
};
