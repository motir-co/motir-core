import 'server-only';

import { randomUUID } from 'node:crypto';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import {
  codeScanningDefaultSetupClient,
  isNoRunnerWithLabelRefusal,
  runnerRequests,
} from '@/lib/github/codeScanningDefaultSetup';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { repoVisibilityClient } from '@/lib/github/repoVisibility';
import { fleetCodeScanningMoveRepository } from '@/lib/repositories/fleetCodeScanningMoveRepository';
import { platformFleetOrgCiRepository } from '@/lib/repositories/platformFleetOrgCiRepository';
import { withSystemContext } from '@/lib/workspaces/context';

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
// ⚠️ ONE MOVE PER REPOSITORY AT A TIME, ACROSS PROCESSES (MOTIR-12034). A CI
// run that starts ten jobs boots ten runners in the same second, each on its own
// worker, and each used to read the setup, see it off the fleet and PATCH it: ten
// overlapping PATCHes left motir-ai's default setup broken on GitHub. So the move
// is claimed in `fleet_code_scanning_move` first — one statement, a lease that
// outlives a boot that dies holding it — and a boot that does not get the claim
// skips. The setup is read only AFTER the claim, so the holder sees what the last
// move left. A move that lands (or a setup read already on the label) is stored
// for the recheck window, so the rest of the burst neither reads nor PATCHes.
// Nothing is kept in process memory: other workers could not see it.
//
// ⚠️ NEVER FAILS A BOOT. Every failure is logged and dropped; the next boot of
// that repository tries again. The boot does not await it.

const LOG = '[fleet-codeql-catch-up]';

/** How long a repository seen on the fleet label is not read again. */
export const ON_FLEET_RECHECK_MS = 10 * 60_000;

/** How long one boot holds a repository's move. Longer than the three GitHub
 *  calls it makes under it ever take; a boot that dies holding it delays the
 *  next move by at most this. */
export const MOVE_LEASE_MS = 5 * 60_000;

export type CatchUpOutcome =
  | 'no_target'
  | 'recently_on_fleet'
  | 'pair_off'
  | 'move_in_flight'
  | 'not_private'
  | 'not_configured'
  | 'already_on_fleet'
  | 'moved'
  | 'still_no_runner'
  | 'failed';

interface MoveTarget {
  projectId: string;
  owner: string;
  repo: string;
  org: string;
  name: string;
  target: GithubOrgTarget;
}

/** The outcomes that leave the setup on the fleet label — remembered for the
 *  recheck window. */
function landedOnFleet(outcome: CatchUpOutcome): boolean {
  return outcome === 'moved' || outcome === 'already_on_fleet';
}

/** Read the setup and move it — only ever under the repository's claim. Never
 *  throws. */
async function moveUnderClaim(t: MoveTarget): Promise<CatchUpOutcome> {
  const { projectId, owner, repo, org, target } = t;
  try {
    if (!(await repoVisibilityClient.isPrivate(owner, repo, target))) return 'not_private';
    const setup = await codeScanningDefaultSetupClient.get(owner, repo, target);
    if (setup.state !== 'configured') return 'not_configured';
    if (runnerRequests(setup.runner, MOTIR_RUNNER_LABEL)) return 'already_on_fleet';
    await codeScanningDefaultSetupClient.setRunner(
      owner,
      repo,
      { type: 'labeled', label: MOTIR_RUNNER_LABEL },
      target,
    );
    console.warn(`${LOG} moved a deferred CodeQL default setup onto the fleet`, {
      projectId,
      org,
      repo,
    });
    return 'moved';
  } catch (err) {
    // GitHub does not count the new runner yet; the next boot tries again.
    if (isNoRunnerWithLabelRefusal(err)) return 'still_no_runner';
    logFailure(t, err);
    return 'failed';
  }
}

/** Give the claim back, remembering a landed move. Never throws: a lease that
 *  could not be given back expires on its own. */
async function settle(
  t: MoveTarget,
  holder: string,
  now: Date,
  outcome: CatchUpOutcome,
): Promise<void> {
  const onFleetUntil = landedOnFleet(outcome)
    ? new Date(now.getTime() + ON_FLEET_RECHECK_MS)
    : null;
  try {
    await withSystemContext((tx) =>
      fleetCodeScanningMoveRepository.settleInTx(
        { org: t.org, repo: t.name, holder, now, onFleetUntil },
        tx,
      ),
    );
  } catch (err) {
    logFailure(t, err);
  }
}

function logFailure(t: MoveTarget, err: unknown): void {
  console.warn(`${LOG} could not move a deferred CodeQL default setup`, {
    projectId: t.projectId,
    org: t.org,
    repo: t.repo,
    detail: err instanceof Error ? err.message : String(err),
  });
}

/** Everything up to and including the claim, then the move under it. Throws
 *  only on a store failure, which the caller logs. */
async function claimAndMove(t: MoveTarget, now: Date): Promise<CatchUpOutcome> {
  const { org, name } = t;
  const onFleetUntil = await withSystemContext((tx) =>
    fleetCodeScanningMoveRepository.findOnFleetUntilInTx(org, name, tx),
  );
  if (onFleetUntil && onFleetUntil > now) return 'recently_on_fleet';
  const row = await platformFleetOrgCiRepository.find(t.projectId, org);
  if (!row?.enabled) return 'pair_off';
  const holder = randomUUID();
  const heldUntil = new Date(now.getTime() + MOVE_LEASE_MS);
  const claimed = await withSystemContext((tx) =>
    fleetCodeScanningMoveRepository.tryClaimInTx({ org, repo: name, holder, now, heldUntil }, tx),
  );
  if (!claimed) return 'move_in_flight';
  const outcome = await moveUnderClaim(t);
  await settle(t, holder, now, outcome);
  return outcome;
}

export const fleetCodeScanningCatchUpService = {
  /**
   * After a fleet runner is registered for `owner/repo`: if its pair is ON and
   * its CodeQL default setup is still off the fleet, move it on — once per
   * repository however many boots ask at the same moment. Never throws.
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
    const t: MoveTarget = {
      projectId,
      owner,
      repo,
      org: owner.trim().toLowerCase(),
      name: repo.trim().toLowerCase(),
      target,
    };
    try {
      return await claimAndMove(t, new Date(input.now ?? Date.now()));
    } catch (err) {
      logFailure(t, err);
      return 'failed';
    }
  },
};
