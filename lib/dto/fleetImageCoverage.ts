// The verdict of the fleet image-coverage probe (MOTIR-10290), the ninth probe of
// `system.daily-health-check`. It is readiness condition 9 (`image_coverage`),
// asked of every pair the fleet console offers. The arms are written out flat so
// the memoized step's pinned shape reads as plain objects.

/** One pair's condition, as the readiness verdict states it. */
export interface FleetImageCoveragePairDTO {
  projectKey: string;
  org: string;
  state: 'met' | 'unmet' | 'unknown';
  reasonCode: string;
  /** English — the condition's own message, naming each job and tool. */
  message: string;
}

export type FleetImageCoverageVerdictDTO =
  | {
      /** Nothing to judge: no provisioning App, no runner image pinned, or no pair offered. */
      verdict: 'not_applicable';
      checkedAt: string;
      reason: 'app_not_configured' | 'runner_image_unset' | 'no_targets';
    }
  | {
      /** Every pair's jobs can run on the pinned image. */
      verdict: 'runnable';
      checkedAt: string;
      pairs: FleetImageCoveragePairDTO[];
    }
  | {
      /** Nothing judged was unmet, but at least one pair could not be judged. */
      verdict: 'indeterminate';
      checkedAt: string;
      pairs: FleetImageCoveragePairDTO[];
      /** Set when the pairs themselves could not be listed: GitHub's status, if any. */
      targetsUnreadable: { status: number | null } | null;
    }
  | {
      /** At least one pair has a job the image cannot run, or the image records no tools. */
      verdict: 'gap';
      checkedAt: string;
      pairs: FleetImageCoveragePairDTO[];
    };
