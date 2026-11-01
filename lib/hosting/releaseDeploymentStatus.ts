import type { HostedReleaseState } from '@/lib/hosting/vocabulary';

// What GitHub is told about a production release (Story MOTIR-9797 · MOTIR-10033):
// one GitHub deployment per release in environment `production`, and one
// deployment status per state the release reaches. No I/O.

/** The GitHub environment every production release deploys to. */
export const PRODUCTION_DEPLOYMENT_ENVIRONMENT = 'production';

/** The GitHub deployment states a release can be announced in. */
export type ReleaseDeploymentState = 'pending' | 'in_progress' | 'success' | 'failure' | 'inactive';

const FOR_RELEASE: Readonly<Record<HostedReleaseState, ReleaseDeploymentState>> = {
  building: 'pending',
  releasing: 'in_progress',
  live: 'success',
  failed: 'failure',
  replaced: 'inactive',
  rolled_back: 'inactive',
};

/** The GitHub state that announces a release in `state`. Total over the closed list. */
export function deploymentStateForRelease(state: HostedReleaseState): ReleaseDeploymentState {
  return FOR_RELEASE[state];
}

/** The way every release goes live: `building`, then `releasing`, then `live`. */
const FORWARD: readonly ReleaseDeploymentState[] = ['pending', 'in_progress', 'success'];

/**
 * The statuses to post, in order, to bring GitHub from `posted` (the last status
 * posted for the release, or null) to the release's CURRENT `state`.
 *
 * A status job runs after the transaction that moved the release has committed,
 * and a release can move again before it runs — `building` and `releasing` are
 * written in one transaction — so the job posts from what it reads, never from
 * what its event announced:
 *   * nothing when GitHub already shows the current state;
 *   * on the way to `live`, every step of the one path there not yet posted, so
 *     the history reads pending → in progress → success however late it runs;
 *   * a failure as `failure` alone — a release can fail from `building` or from
 *     `releasing`, so no step before it is implied;
 *   * otherwise (`inactive`, or `success` again after a rollback) the current
 *     state alone.
 */
export function statusesToPost(
  posted: ReleaseDeploymentState | null,
  state: HostedReleaseState,
): ReleaseDeploymentState[] {
  const target = deploymentStateForRelease(state);
  if (posted === target) return [];
  const to = FORWARD.indexOf(target);
  const from = posted === null ? -1 : FORWARD.indexOf(posted);
  if (to >= 0 && (posted === null || from >= 0) && from < to) {
    return FORWARD.slice(from + 1, to + 1);
  }
  return [target];
}

/** Whether a stored value is one of the states above. */
export function isReleaseDeploymentState(value: string | null): value is ReleaseDeploymentState {
  return value !== null && (Object.values(FOR_RELEASE) as string[]).includes(value);
}
