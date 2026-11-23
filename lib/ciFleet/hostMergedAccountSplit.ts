// THE MERGED HOST ACCOUNT'S AGENT CAP (Story MOTIR-9365 · MOTIR-9589; one row
// since MOTIR-12038). A Host organisation's merged account is ONE AWS account,
// recorded as ONE `agent_instance` row: the container-based indexer that once
// shared it, with spots kept for index containers, left motir-core (MOTIR-11026).
// So the agent hoster takes the whole grant: running agent instances never exceed
// min(`MERGED_AGENT_CEILING`, floor(granted / spot)).
//
// The cap depends on the grant alone, never on how many instances run, so
// admission needs no read beyond the account's granted quota. Pure: no `db`, no
// `process.env`.

/** One spot: every fleet kind boots the same 2 vCPU machine. */
export const MERGED_SPOT_VCPU = 2;
/** The account-side bound on running agent instances. */
export const MERGED_AGENT_CEILING = 50;

export interface MergedAccountSplit {
  agentCap: number;
}

/** The merged account's agent cap from its one granted vCPU. Null or below one
 *  spot ⇒ no agent instance. */
export function mergedAccountSplit(grantedVcpu: number | null): MergedAccountSplit {
  if (grantedVcpu === null || grantedVcpu < MERGED_SPOT_VCPU) return { agentCap: 0 };
  return {
    agentCap: Math.min(MERGED_AGENT_CEILING, Math.floor(grantedVcpu / MERGED_SPOT_VCPU)),
  };
}
