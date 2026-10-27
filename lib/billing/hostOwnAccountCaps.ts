import type { PlanCaps } from '@/lib/billing/planCaps';

// AN OWN-ACCOUNTS ORGANISATION'S FIGURES FROM ITS OWN ACCOUNTS (Story MOTIR-9365
// · MOTIR-9587; every plan that carries them — Host and the larger pools on sale —
// MOTIR-9366 · MOTIR-9653). The plan's row (`HOST_FLOOR_CAPS` or
// `LARGER_POOL_FLOOR_CAPS`) is the SHARED FLOOR. Once the org's own account of
// a kind is live, that kind's figure is what the account can hold: its granted
// vCPU ÷ 2 (one fleet machine is 2 vCPU), rounded down —
//   * the agent-runner account → `agentRunsInParallel`;
//   * the CI account           → `ciBurstCap`;
//   * the merged account       → `agentsPerUser` and `agentsRunningPerOrg`, lifted
//     to the own-accounts figures (10 / 50) — never below the floor's — once it
//     is live (MOTIR-9668). How many agents its granted vCPU can hold, with the
//     index spots kept, is the account's own admission bound
//     (`lib/ciFleet/hostMergedAccountSplit.ts`), not a plan figure.
// The three move independently. Pure: no `db`, no `process.env`.

/** The vCPU one fleet machine takes — every kind boots the same class. */
export const VCPU_PER_MACHINE = 2;

/** A user's agents once the org's merged account is live (owner, MOTIR-9357). */
export const OWN_ACCOUNT_AGENTS_PER_USER = 10;
/** The org's running agents once its merged account is live (owner, MOTIR-9357). */
export const OWN_ACCOUNT_AGENTS_RUNNING_PER_ORG = 50;

export interface OwnAccountGranted {
  /** The plan's row — the shared floor. */
  floor: PlanCaps;
  /** The live agent-runner account's granted vCPU; null while not live (or its
   *  kind's switch reads Fly) — the floor figure stands. */
  agentRunnerGrantedVcpu: number | null;
  /** The live CI account's granted vCPU; null as above. */
  ciGrantedVcpu: number | null;
  /** The live merged account's granted vCPU (its agent hoster row); null as
   *  above — the floor's agent figures stand. */
  mergedGrantedVcpu: number | null;
}

const machines = (granted: number) => Math.floor(granted / VCPU_PER_MACHINE);

/** The own-accounts org's figures. */
export function ownAccountCapsFromGranted(input: OwnAccountGranted): PlanCaps {
  const mergedLive = input.mergedGrantedVcpu !== null;
  return Object.freeze({
    ...input.floor,
    agentsPerUser: mergedLive
      ? Math.max(input.floor.agentsPerUser, OWN_ACCOUNT_AGENTS_PER_USER)
      : input.floor.agentsPerUser,
    agentsRunningPerOrg: mergedLive
      ? Math.max(input.floor.agentsRunningPerOrg, OWN_ACCOUNT_AGENTS_RUNNING_PER_ORG)
      : input.floor.agentsRunningPerOrg,
    agentRunsInParallel:
      input.agentRunnerGrantedVcpu === null
        ? input.floor.agentRunsInParallel
        : machines(input.agentRunnerGrantedVcpu),
    ciBurstCap:
      input.ciGrantedVcpu === null ? input.floor.ciBurstCap : machines(input.ciGrantedVcpu),
  });
}
