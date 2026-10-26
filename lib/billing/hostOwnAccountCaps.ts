import type { PlanCaps } from '@/lib/billing/planCaps';

// A HOST ORGANISATION'S FIGURES FROM ITS OWN ACCOUNTS (Story MOTIR-9365 ·
// MOTIR-9587). The `host` row is the SHARED FLOOR. Once the org's own account of
// a kind is live, that kind's figure is what the account can hold: its granted
// vCPU ÷ 2 (one fleet machine is 2 vCPU), rounded down —
//   * the agent-runner account → `agentRunsInParallel`;
//   * the CI account           → `ciBurstCap`.
// The two move independently; `agentsPerUser` and `agentsRunningPerOrg` are the
// floor's. Pure: no `db`, no `process.env`.

/** The vCPU one fleet machine takes — every kind boots the same class. */
export const VCPU_PER_MACHINE = 2;

export interface HostGranted {
  /** The `host` row. */
  floor: PlanCaps;
  /** The live agent-runner account's granted vCPU; null while not live (or its
   *  kind's switch reads Fly) — the floor figure stands. */
  agentRunnerGrantedVcpu: number | null;
  /** The live CI account's granted vCPU; null as above. */
  ciGrantedVcpu: number | null;
}

const machines = (granted: number) => Math.floor(granted / VCPU_PER_MACHINE);

/** The Host org's figures. */
export function hostCapsFromGranted(input: HostGranted): PlanCaps {
  return Object.freeze({
    ...input.floor,
    agentRunsInParallel:
      input.agentRunnerGrantedVcpu === null
        ? input.floor.agentRunsInParallel
        : machines(input.agentRunnerGrantedVcpu),
    ciBurstCap:
      input.ciGrantedVcpu === null ? input.floor.ciBurstCap : machines(input.ciGrantedVcpu),
  });
}
