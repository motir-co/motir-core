import { describe, expect, it } from 'vitest';
import {
  GATEWAY_SATURATION_ALERT_PERCENT,
  judgeGatewaySaturation,
} from '@/lib/capacity/gatewaySaturation';

/**
 * The gateway-saturation judge (MOTIR-9675, design D6): connections in use over
 * created machines × hard limit, alerting at 70 %, integer arithmetic only.
 */

const fleet = (connectionsInUse: number | null) => ({
  connectionsInUse,
  createdMachines: 12,
  hardLimit: 750,
});

describe('judgeGatewaySaturation', () => {
  it('alerts at 70 %', () => {
    expect(GATEWAY_SATURATION_ALERT_PERCENT).toBe(70);
  });

  it('is over the share at exactly 70 % — 6,300 of 12 × 750', () => {
    expect(judgeGatewaySaturation(fleet(6300))).toEqual({
      state: 'over_share',
      sharePercent: 70,
      capacityConnections: 9000,
    });
    expect(judgeGatewaySaturation(fleet(9000)).state).toBe('over_share');
  });

  it('is near the limit in the 10 points below it, and normal under them', () => {
    expect(judgeGatewaySaturation(fleet(6299)).state).toBe('near_limit');
    expect(judgeGatewaySaturation(fleet(5400)).state).toBe('near_limit'); // 60 % exactly
    expect(judgeGatewaySaturation(fleet(5399)).state).toBe('normal');
    expect(judgeGatewaySaturation(fleet(0)).state).toBe('normal');
  });

  it('counts created machines, not running ones', () => {
    // 12 created, 1 running: 700 is 7.8 % of 9,000, not 93 % of 750.
    const judged = judgeGatewaySaturation(fleet(700));
    expect(judged.state).toBe('normal');
    expect(judged.capacityConnections).toBe(9000);
    expect(judged.sharePercent).toBeCloseTo(7.78, 2);
  });

  it('decides on integers, not a rounded float', () => {
    // 69.99 % rounds to 70 but is not over.
    const judged = judgeGatewaySaturation({
      connectionsInUse: 6999,
      createdMachines: 1,
      hardLimit: 10000,
    });
    expect(judged.state).toBe('near_limit');
  });

  it('is unavailable — never 0 % — for a missing input or a capacity of 0', () => {
    for (const input of [
      fleet(null),
      { connectionsInUse: 10, createdMachines: null, hardLimit: 750 },
      { connectionsInUse: 10, createdMachines: 12, hardLimit: null },
      { connectionsInUse: 0, createdMachines: 0, hardLimit: 750 },
      { connectionsInUse: 0, createdMachines: 12, hardLimit: 0 },
      { connectionsInUse: -1, createdMachines: 12, hardLimit: 750 },
      { connectionsInUse: 1.5, createdMachines: 12, hardLimit: 750 },
    ]) {
      const judged = judgeGatewaySaturation(input);
      expect(judged.state).toBe('unavailable');
      expect(judged.sharePercent).toBeNull();
    }
    // The capacity is still reported when its two inputs were read.
    expect(judgeGatewaySaturation(fleet(null)).capacityConnections).toBe(9000);
  });
});
