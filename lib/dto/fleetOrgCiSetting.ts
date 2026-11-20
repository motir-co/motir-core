import type { NotBootableReason } from '@/lib/services/ciRunnerBootService';
import type { FleetReadiness } from '@/lib/services/fleetReadinessService';

// The platform setting "Run Motir's private repositories' CI on the fleet"
// (Story MOTIR-8699 · MOTIR-8714) — what the /admin console reads and is answered.

/** One (project, connected org) pair the console offers the switch for. */
export interface FleetOrgCiTargetDTO {
  projectId: string;
  projectKey: string;
  workspaceId: string;
  organizationId: string;
  /** The org login as the repositories carry it. */
  org: string;
  /** The provisioning App's installation on that org. */
  installationId: string;
}

/** The STORED state of one pair — the operator's intent. */
export interface FleetOrgCiStoredStateDTO {
  enabled: boolean;
  updatedBy: { userId: string; email: string } | null;
  updatedAt: string | null;
  lastReason: string | null;
}

/** The org's `MOTIR_RUNNER` variable as GitHub holds it now — the EFFECT, read
 *  back so a drift from the stored state is visible. */
export type FleetOrgCiVariableDTO =
  | { state: 'present'; value: string; visibility: string }
  | { state: 'absent' }
  | { state: 'unknown'; status: number | null };

/** Where one private repository's CodeQL default setup runs, read back from
 *  GitHub (MOTIR-10289). Its runner is a per-repository setting no workflow
 *  file reads, so the org variable does not move it — the flip does.
 *  `fleet` = labelled with the fleet label; `github_hosted` = `standard`, or a
 *  label that is not the fleet's; `pending_fleet` = the pair is ON and the move
 *  waits for a registered fleet runner (the next boot makes it);
 *  `not_configured` / `unavailable` = no default setup at all; `unknown` = the
 *  read failed. */
export type FleetOrgCiCodeScanningDTO =
  | {
      repo: string;
      state: 'fleet' | 'pending_fleet' | 'github_hosted' | 'not_configured' | 'unavailable';
    }
  | { repo: string; state: 'unknown'; status: number | null };

/** The arm64 Graviton pool's line for one pair (Story MOTIR-11779 · MOTIR-11786).
 *  `ready` = an arm64 runner AMI is pinned on this deployment, so an ON flip also
 *  writes `MOTIR_RUNNER_ARM64`; not ready never refuses the flip — it only skips
 *  that write. `variable` is `MOTIR_RUNNER_ARM64` read back from GitHub. */
export interface FleetOrgCiArm64DTO {
  ready: boolean;
  /** Why the pool is not ready; null when it is. */
  reason: NotBootableReason | null;
  variable: FleetOrgCiVariableDTO;
}

/** The console's full reading of one pair. */
export interface FleetOrgCiStateDTO extends FleetOrgCiStoredStateDTO {
  readiness: FleetReadiness;
  variable: FleetOrgCiVariableDTO;
  /** The arm64 pool and its variable (MOTIR-11786). */
  arm64: FleetOrgCiArm64DTO;
  /** One entry per private repository of the pair, in name order. */
  codeScanning: FleetOrgCiCodeScanningDTO[];
}

/** A private repository whose CodeQL default setup GitHub could not serve when
 *  the flip read it (MOTIR-11933). The flip left it exactly as it was and went
 *  ahead for everything else. `status` = GitHub's HTTP status, `null` when
 *  GitHub could not be reached. */
export interface FleetOrgCiSkippedRepoDTO {
  repo: string;
  status: number | null;
}

/** A default-setup move GitHub accepted but does not confirm when it is read
 *  back after the flip (MOTIR-11933). `to` = where the flip moved it;
 *  `read_failed` = the read-back failed (`status` as above); `mismatch` = the
 *  setting GitHub now holds is not the configured runner the flip wrote. */
export type FleetOrgCiReadBackDTO =
  | { repo: string; to: 'fleet' | 'github_hosted'; problem: 'read_failed'; status: number | null }
  | {
      repo: string;
      to: 'fleet' | 'github_hosted';
      problem: 'mismatch';
      found:
        | { state: 'standard' }
        | { state: 'labeled'; label: string }
        | { state: 'not_configured' }
        | { state: 'unavailable' };
    };

/** What a changed flip did to CodeQL beyond the moves it audited: the
 *  repositories it skipped and the moves GitHub does not confirm. Both empty is
 *  a flip whose every repository read and every move held. */
export interface FleetOrgCiFlipCodeScanningDTO {
  skipped: FleetOrgCiSkippedRepoDTO[];
  unverified: FleetOrgCiReadBackDTO[];
}

/** What a flip answers. `unchanged` = the pair already held the asked state;
 *  nothing was written and no audit row exists. */
export type FleetOrgCiFlipDTO =
  | {
      outcome: 'changed';
      state: FleetOrgCiStoredStateDTO;
      codeScanning: FleetOrgCiFlipCodeScanningDTO;
    }
  | { outcome: 'unchanged'; state: FleetOrgCiStoredStateDTO };
