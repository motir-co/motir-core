import { describe, expect, it } from 'vitest';
import {
  MERGED_AGENT_CEILING,
  MERGED_INDEX_SPOTS,
  MERGED_SPOT_VCPU,
  mergedAccountSplit,
} from '@/lib/ciFleet/hostMergedAccountSplit';

// THE MERGED ACCOUNT'S SPLIT (Story MOTIR-9365 · MOTIR-9589): 10 index spots kept,
// agents min(50, (granted − 20) ÷ 2), never over the one quota.

describe('mergedAccountSplit', () => {
  it('keeps 10 spots of 2 vCPU and bounds agents at 50', () => {
    expect([MERGED_INDEX_SPOTS, MERGED_SPOT_VCPU, MERGED_AGENT_CEILING]).toEqual([10, 2, 50]);
  });

  it.each([
    [null, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [2, 1, 0],
    [19, 9, 0],
    [20, 10, 0],
    [21, 10, 0],
    [22, 10, 1],
    [40, 10, 10],
    [120, 10, 50],
    [121, 10, 50],
    [140, 10, 50],
    [200, 10, 50],
  ])('granted %s → index %i, agents %i', (granted, indexCap, agentCap) => {
    expect(mergedAccountSplit(granted)).toEqual({ indexCap, agentCap });
  });

  it('never exceeds the one quota, for every grant from 0 to 300', () => {
    for (let granted = 0; granted <= 300; granted++) {
      const { indexCap, agentCap } = mergedAccountSplit(granted);
      expect(indexCap + agentCap).toBeLessThanOrEqual(Math.floor(granted / 2));
      expect(indexCap).toBeGreaterThanOrEqual(0);
      expect(agentCap).toBeGreaterThanOrEqual(0);
    }
  });
});
