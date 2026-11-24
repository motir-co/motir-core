import { describe, expect, it } from 'vitest';
import * as split from '@/lib/ciFleet/hostMergedAccountSplit';
import {
  MERGED_AGENT_CEILING,
  MERGED_SPOT_VCPU,
  mergedAccountSplit,
} from '@/lib/ciFleet/hostMergedAccountSplit';

// THE MERGED ACCOUNT'S AGENT CAP (Story MOTIR-9365 · MOTIR-9589; one row since
// MOTIR-12038): the whole grant in 2 vCPU spots, bounded at 50, no index spots
// kept.

describe('mergedAccountSplit', () => {
  it('counts 2 vCPU spots, bounds agents at 50, and keeps no index spots', () => {
    expect([MERGED_SPOT_VCPU, MERGED_AGENT_CEILING]).toEqual([2, 50]);
    expect(Object.keys(split).sort()).toEqual([
      'MERGED_AGENT_CEILING',
      'MERGED_SPOT_VCPU',
      'mergedAccountSplit',
    ]);
  });

  it.each([
    [null, 0],
    [0, 0],
    [1, 0],
    [2, 1],
    [3, 1],
    [21, 10],
    [40, 20],
    [99, 49],
    [100, 50],
    [120, 50],
    [200, 50],
  ])('granted %s → agents %i', (granted, agentCap) => {
    expect(mergedAccountSplit(granted)).toEqual({ agentCap });
  });

  it('never exceeds the one quota, for every grant from 0 to 300', () => {
    for (let granted = 0; granted <= 300; granted++) {
      const { agentCap } = mergedAccountSplit(granted);
      expect(agentCap).toBeLessThanOrEqual(Math.floor(granted / 2));
      expect(agentCap).toBeGreaterThanOrEqual(0);
      expect(agentCap).toBeLessThanOrEqual(MERGED_AGENT_CEILING);
    }
  });
});
