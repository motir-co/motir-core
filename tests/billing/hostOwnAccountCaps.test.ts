import { describe, expect, it } from 'vitest';
import { hostCapsFromGranted, VCPU_PER_MACHINE } from '@/lib/billing/hostOwnAccountCaps';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';

// THE HOST FIGURES FROM GRANTED vCPU (Story MOTIR-9365 · MOTIR-9587): granted ÷ 2,
// rounded down, per kind; null keeps the shared floor's figure.

const FLOOR = capsForPlanKey(HOST_PLAN_KEY)!;

describe('hostCapsFromGranted', () => {
  it('a machine is 2 vCPU', () => {
    expect(VCPU_PER_MACHINE).toBe(2);
  });

  it('keeps the floor while no own account is live', () => {
    expect(
      hostCapsFromGranted({ floor: FLOOR, agentRunnerGrantedVcpu: null, ciGrantedVcpu: null }),
    ).toEqual(FLOOR);
  });

  it.each([
    [32, 16],
    [33, 16],
    [64, 32],
    [1, 0],
  ])('agent runner granted %i → %i agent runs', (granted, runs) => {
    const caps = hostCapsFromGranted({
      floor: FLOOR,
      agentRunnerGrantedVcpu: granted,
      ciGrantedVcpu: null,
    });
    expect(caps.agentRunsInParallel).toBe(runs);
    expect(caps.ciBurstCap).toBe(FLOOR.ciBurstCap);
  });

  it('CI granted 200 → 100 in flight, agent runs on the floor', () => {
    const caps = hostCapsFromGranted({
      floor: FLOOR,
      agentRunnerGrantedVcpu: null,
      ciGrantedVcpu: 200,
    });
    expect(caps.ciBurstCap).toBe(100);
    expect(caps.agentRunsInParallel).toBe(FLOOR.agentRunsInParallel);
  });

  it('never touches the per-user and per-org agent figures', () => {
    const caps = hostCapsFromGranted({
      floor: FLOOR,
      agentRunnerGrantedVcpu: 64,
      ciGrantedVcpu: 200,
    });
    expect(caps.agentsPerUser).toBe(FLOOR.agentsPerUser);
    expect(caps.agentsRunningPerOrg).toBe(FLOOR.agentsRunningPerOrg);
  });
});
