import { describe, expect, it } from 'vitest';
import {
  OWN_ACCOUNT_AGENTS_PER_USER,
  OWN_ACCOUNT_AGENTS_RUNNING_PER_ORG,
  ownAccountCapsFromGranted,
  VCPU_PER_MACHINE,
} from '@/lib/billing/hostOwnAccountCaps';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';

// THE HOST FIGURES FROM GRANTED vCPU (Story MOTIR-9365 · MOTIR-9587): granted ÷ 2,
// rounded down, per kind; null keeps the shared floor's figure.

const FLOOR = capsForPlanKey(HOST_PLAN_KEY)!;

describe('ownAccountCapsFromGranted', () => {
  it('a machine is 2 vCPU', () => {
    expect(VCPU_PER_MACHINE).toBe(2);
  });

  it('keeps the floor while no own account is live', () => {
    expect(
      ownAccountCapsFromGranted({
        floor: FLOOR,
        agentRunnerGrantedVcpu: null,
        ciGrantedVcpu: null,
        mergedGrantedVcpu: null,
      }),
    ).toEqual(FLOOR);
  });

  it.each([
    [32, 16],
    [33, 16],
    [64, 32],
    [1, 0],
  ])('agent runner granted %i → %i agent runs', (granted, runs) => {
    const caps = ownAccountCapsFromGranted({
      floor: FLOOR,
      agentRunnerGrantedVcpu: granted,
      ciGrantedVcpu: null,
      mergedGrantedVcpu: null,
    });
    expect(caps.agentRunsInParallel).toBe(runs);
    expect(caps.ciBurstCap).toBe(FLOOR.ciBurstCap);
  });

  it('CI granted 200 → 100 in flight, agent runs on the floor', () => {
    const caps = ownAccountCapsFromGranted({
      floor: FLOOR,
      agentRunnerGrantedVcpu: null,
      ciGrantedVcpu: 200,
      mergedGrantedVcpu: null,
    });
    expect(caps.ciBurstCap).toBe(100);
    expect(caps.agentRunsInParallel).toBe(FLOOR.agentRunsInParallel);
  });

  it('the runner and CI accounts never touch the per-user and per-org agent figures', () => {
    const caps = ownAccountCapsFromGranted({
      floor: FLOOR,
      agentRunnerGrantedVcpu: 64,
      ciGrantedVcpu: 200,
      mergedGrantedVcpu: null,
    });
    expect(caps.agentsPerUser).toBe(FLOOR.agentsPerUser);
    expect(caps.agentsRunningPerOrg).toBe(FLOOR.agentsRunningPerOrg);
  });

  it("a live merged account lifts Host's agents from the floor's 5 / 20 to 10 / 50 (MOTIR-9668)", () => {
    expect([FLOOR.agentsPerUser, FLOOR.agentsRunningPerOrg]).toEqual([5, 20]);
    const caps = ownAccountCapsFromGranted({
      floor: FLOOR,
      agentRunnerGrantedVcpu: null,
      ciGrantedVcpu: null,
      mergedGrantedVcpu: 120,
    });
    expect([caps.agentsPerUser, caps.agentsRunningPerOrg]).toEqual([
      OWN_ACCOUNT_AGENTS_PER_USER,
      OWN_ACCOUNT_AGENTS_RUNNING_PER_ORG,
    ]);
    expect([caps.agentsPerUser, caps.agentsRunningPerOrg]).toEqual([10, 50]);
    expect(caps.agentRunsInParallel).toBe(FLOOR.agentRunsInParallel);
    expect(caps.ciBurstCap).toBe(FLOOR.ciBurstCap);
  });

  it('the lift never lowers a floor already above it', () => {
    const high = { ...FLOOR, agentsPerUser: 12, agentsRunningPerOrg: 60 };
    const caps = ownAccountCapsFromGranted({
      floor: high,
      agentRunnerGrantedVcpu: null,
      ciGrantedVcpu: null,
      mergedGrantedVcpu: 120,
    });
    expect([caps.agentsPerUser, caps.agentsRunningPerOrg]).toEqual([12, 60]);
  });
});
