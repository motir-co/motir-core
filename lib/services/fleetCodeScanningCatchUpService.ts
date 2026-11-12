import 'server-only';

import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import {
  codeScanningDefaultSetupClient,
  isNoRunnerWithLabelRefusal,
  runnerRequests,
} from '@/lib/github/codeScanningDefaultSetup';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { repoVisibilityClient } from '@/lib/github/repoVisibility';
import { platformFleetOrgCiRepository } from '@/lib/repositories/platformFleetOrgCiRepository';

// THE DEFERRED CODEQL MOVE (follow-up to MOTIR-10289).
//
// GitHub moves a CodeQL default setup onto a `labeled` runner only while a
// registered runner carries that label and is assigned to the repository. The
// fleet registers a single-use runner only while a job runs, so turning the
// fleet ON for an idle org leaves each move DEFERRED
// (`fleetOrgCiSettingService`, `isNoRunnerWithLabelRefusal`). This makes the
// move from the boot path, right after a runner for the repository is
// registered: the one moment GitHub accepts it.
//
// ⚠️ SAME RULE AS THE FLIP. Only a repository whose pair is stored ON, that is
// PRIVATE, and whose default setup is CONFIGURED and not already on the fleet
// label is written — the flip's ON moves, nothing else. A repository's CodeQL is
// never configured here.
//
// ⚠️ NEVER FAILS A BOOT. Every failure is logged and dropped; the next boot of
// that repository tries again. A repository read on the fleet is remembered for
// a while so a busy repository does not read GitHub on every boot.

const LOG = '[fleet-codeql-catch-up]';

/** How long a repository seen on the fleet label is not read again. */
export const ON_FLEET_RECHECK_MS = 10 * 60_000;

const seenOnFleet = new Map<string, number>();

/** Test seam: forget what was seen on the fleet. */
export function _resetSeenOnFleet(): void {
  seenOnFleet.clear();
}

export type CatchUpOutcome =
  | 'no_target'
  | 'recently_on_fleet'
  | 'pair_off'
  | 'not_private'
  | 'not_configured'
  | 'already_on_fleet'
  | 'moved'
  | 'still_no_runner'
  | 'failed';

export const fleetCodeScanningCatchUpService = {
  /**
   * After a fleet runner is registered for `owner/repo`: if its pair is ON and
   * its CodeQL default setup is still off the fleet, move it on. Never throws.
   *
   * `target` is the runner's org target; `undefined` (the provisioning org) has
   * no pair to be ON, so nothing is done.
   */
  async afterRunnerRegistered(input: {
    projectId: string;
    owner: string;
    repo: string;
    target: GithubOrgTarget | undefined;
    now?: number;
  }): Promise<CatchUpOutcome> {
    const { projectId, owner, repo, target } = input;
    if (!target) return 'no_target';
    const org = owner.trim().toLowerCase();
    const key = `${org}/${repo.toLowerCase()}`;
    const now = input.now ?? Date.now();
    const seen = seenOnFleet.get(key);
    if (seen !== undefined && now - seen < ON_FLEET_RECHECK_MS) return 'recently_on_fleet';
    try {
      const row = await platformFleetOrgCiRepository.find(projectId, org);
      if (!row?.enabled) return 'pair_off';
      if (!(await repoVisibilityClient.isPrivate(owner, repo, target))) return 'not_private';
      const setup = await codeScanningDefaultSetupClient.get(owner, repo, target);
      if (setup.state !== 'configured') return 'not_configured';
      if (runnerRequests(setup.runner, MOTIR_RUNNER_LABEL)) {
        seenOnFleet.set(key, now);
        return 'already_on_fleet';
      }
      await codeScanningDefaultSetupClient.setRunner(
        owner,
        repo,
        { type: 'labeled', label: MOTIR_RUNNER_LABEL },
        target,
      );
      seenOnFleet.set(key, now);
      console.warn(`${LOG} moved a deferred CodeQL default setup onto the fleet`, {
        projectId,
        org,
        repo,
      });
      return 'moved';
    } catch (err) {
      // GitHub does not count the new runner yet; the next boot tries again.
      if (isNoRunnerWithLabelRefusal(err)) return 'still_no_runner';
      console.warn(`${LOG} could not move a deferred CodeQL default setup`, {
        projectId,
        org,
        repo,
        detail: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  },
};
