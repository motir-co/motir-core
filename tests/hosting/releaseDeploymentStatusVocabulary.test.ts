import { describe, expect, it } from 'vitest';

import {
  deploymentStateForRelease,
  isReleaseDeploymentState,
  PRODUCTION_DEPLOYMENT_ENVIRONMENT,
  statusesToPost,
} from '@/lib/hosting/releaseDeploymentStatus';
import { HOSTED_RELEASE_STATES } from '@/lib/hosting/vocabulary';

// What GitHub is told about a production release (Story MOTIR-9797 ·
// MOTIR-10033) — the pure half: the state map and the statuses a late, repeated
// or retried status job owes GitHub.

describe('deploymentStateForRelease', () => {
  it('is total over the release states and names a GitHub state for each', () => {
    for (const state of HOSTED_RELEASE_STATES) {
      expect(isReleaseDeploymentState(deploymentStateForRelease(state)), state).toBe(true);
    }
  });

  it('maps each release state to the GitHub state that announces it', () => {
    expect(deploymentStateForRelease('building')).toBe('pending');
    expect(deploymentStateForRelease('releasing')).toBe('in_progress');
    expect(deploymentStateForRelease('live')).toBe('success');
    expect(deploymentStateForRelease('failed')).toBe('failure');
    expect(deploymentStateForRelease('replaced')).toBe('inactive');
    expect(deploymentStateForRelease('rolled_back')).toBe('inactive');
  });

  it('deploys to the production environment', () => {
    expect(PRODUCTION_DEPLOYMENT_ENVIRONMENT).toBe('production');
  });
});

describe('statusesToPost', () => {
  it('posts nothing when GitHub already shows the current state', () => {
    for (const state of HOSTED_RELEASE_STATES) {
      expect(statusesToPost(deploymentStateForRelease(state), state), state).toEqual([]);
    }
  });

  it('fills in every forward step not yet posted, however late the job runs', () => {
    expect(statusesToPost(null, 'building')).toEqual(['pending']);
    expect(statusesToPost(null, 'releasing')).toEqual(['pending', 'in_progress']);
    expect(statusesToPost(null, 'live')).toEqual(['pending', 'in_progress', 'success']);
    expect(statusesToPost('pending', 'live')).toEqual(['in_progress', 'success']);
    expect(statusesToPost('in_progress', 'live')).toEqual(['success']);
  });

  it('posts a failure alone, from any point on the way', () => {
    expect(statusesToPost(null, 'failed')).toEqual(['failure']);
    expect(statusesToPost('pending', 'failed')).toEqual(['failure']);
    expect(statusesToPost('in_progress', 'failed')).toEqual(['failure']);
  });

  it('posts the current state alone off the forward path', () => {
    expect(statusesToPost('success', 'replaced')).toEqual(['inactive']);
    expect(statusesToPost('success', 'rolled_back')).toEqual(['inactive']);
    // A rollback revives a replaced release: success again, with no steps implied.
    expect(statusesToPost('inactive', 'live')).toEqual(['success']);
  });
});

describe('isReleaseDeploymentState', () => {
  it('accepts the five GitHub states and nothing else', () => {
    for (const value of ['pending', 'in_progress', 'success', 'failure', 'inactive']) {
      expect(isReleaseDeploymentState(value), value).toBe(true);
    }
    expect(isReleaseDeploymentState(null)).toBe(false);
    expect(isReleaseDeploymentState('queued')).toBe(false);
    expect(isReleaseDeploymentState('')).toBe(false);
  });
});
