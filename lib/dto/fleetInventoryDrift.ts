// The verdict of the fleet-inventory drift probe (MOTIR-10211), the ninth probe
// of `system.daily-health-check`. The arms are written out flat so the memoized
// step's pinned shape reads as plain objects.

/** Why an entry no longer describes its repository — `lib/ciFleet/inventoryStaleness.ts`. */
export type FleetInventoryStaleReasonDTO =
  | 'no_fingerprint'
  | 'digest_moved'
  | 'job_moved'
  | 'invalid_yaml';

/** A private repository whose workflows moved past what its entry measured. */
export interface FleetInventoryStaleRepoDTO {
  /** The entry's `owner/name`, as the inventory spells it. */
  repository: string;
  measuredSha: string;
  /** The newest commit on the default branch that touched `.github/workflows`. */
  headSha: string;
  reason: FleetInventoryStaleReasonDTO;
  /** Recorded jobs, `path#jobId`, now on another runner or calling another workflow. */
  movedJobs: string[];
  /** Jobs at the head the entry does not record, `path#jobId` — what a re-measure adds. */
  addedJobs: string[];
}

/** A private repository the probe could not judge. Never counted as current. */
export interface FleetInventoryUnreadableRepoDTO {
  repository: string;
  /** Which read failed: the App's installation on the owner org, the newest
   *  workflow commit, or the workflow files at it. */
  phase: 'installation' | 'head' | 'files';
  /** GitHub's HTTP status when it answered with one; never its message. */
  status: number | null;
}

export type FleetInventoryDriftVerdictDTO =
  | {
      /** The provisioning App is not configured, so no private repository can be read. */
      verdict: 'not_applicable';
      checkedAt: string;
      reason: 'app_not_configured' | 'no_private_entries';
    }
  | {
      /** Every private entry was read and still describes its repository. */
      verdict: 'current';
      checkedAt: string;
      checked: string[];
    }
  | {
      /** Nothing read was stale, but at least one entry could not be read. */
      verdict: 'indeterminate';
      checkedAt: string;
      checked: string[];
      unreadable: FleetInventoryUnreadableRepoDTO[];
    }
  | {
      verdict: 'stale';
      checkedAt: string;
      checked: string[];
      stale: FleetInventoryStaleRepoDTO[];
      unreadable: FleetInventoryUnreadableRepoDTO[];
    };
