import type { PlanCaps } from '@/lib/billing/planCaps';

// AN OWN-ACCOUNTS ORGANISATION'S FIGURES FROM ITS OWN ACCOUNTS (Story MOTIR-9365
// · MOTIR-9587; every plan that carries them — Host and the larger pools on sale —
// MOTIR-9366 · MOTIR-9653). The plan's row (`OWN_ACCOUNT_FLOOR_CAPS`) is the
// SHARED FLOOR. Once the org's own account of
// a kind is live, that kind's figure is what the account can hold: its granted
// vCPU ÷ 2 (one fleet machine is 2 vCPU), rounded down —
//   * the agent-runner account → `agentRunsInParallel`;
//   * the CI account           → `ciBurstCap`.
// The two move independently; `agentsPerUser` and `agentsRunningPerOrg` are the
// floor's. Pure: no `db`, no `process.env`.

/** The vCPU one fleet machine takes — every kind boots the same class. */
export const VCPU_PER_MACHINE = 2;

export interface OwnAccountGranted {
  /** The plan's row — the shared floor. */
  floor: PlanCaps;
  /** The live agent-runner account's granted vCPU; null while not live (or its
   *  kind's switch reads Fly) — the floor figure stands. */
  agentRunnerGrantedVcpu: number | null;
  /** The live CI account's granted vCPU; null as above. */
  ciGrantedVcpu: number | null;
}

const machines = (granted: number) => Math.floor(granted / VCPU_PER_MACHINE);

/** The own-accounts org's figures. */
export function ownAccountCapsFromGranted(input: OwnAccountGranted): PlanCaps {
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
