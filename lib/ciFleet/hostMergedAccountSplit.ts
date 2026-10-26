// THE MERGED INDEXER + AGENT HOSTER ACCOUNT'S SPLIT (Story MOTIR-9365 ·
// MOTIR-9589). A Host organisation's merged account is ONE AWS account recorded
// as TWO rows (`code_graph_index`, `agent_instance`) sharing ONE granted quota.
// Of it, `MERGED_INDEX_SPOTS` machine spots are always kept for index containers,
// used or not, and running agent instances never exceed
// min(`MERGED_AGENT_CEILING`, floor((granted − kept vCPU) / spot)).
//
// The reservation is STRUCTURAL: the agent cap depends on the grant alone, never
// on how many index containers run, so an idle index spot is never lent to an
// agent and a busy index never eats into the agents' share — and admission needs
// no read of the other kind's count. For every grant,
// indexCap + agentCap <= floor(granted / spot). Pure: no `db`, no `process.env`.

/** The index spots always kept on the merged account. */
export const MERGED_INDEX_SPOTS = 10;
/** One spot: every fleet kind boots the same 2 vCPU machine. */
export const MERGED_SPOT_VCPU = 2;
/** The account-side bound on running agent instances. */
export const MERGED_AGENT_CEILING = 50;

export interface MergedAccountSplit {
  indexCap: number;
  agentCap: number;
}

/** The merged account's two caps from its one granted vCPU. Null or below one
 *  spot ⇒ no job of either kind. */
export function mergedAccountSplit(grantedVcpu: number | null): MergedAccountSplit {
  if (grantedVcpu === null || grantedVcpu < MERGED_SPOT_VCPU) return { indexCap: 0, agentCap: 0 };
  const spots = Math.floor(grantedVcpu / MERGED_SPOT_VCPU);
  return {
    indexCap: Math.min(MERGED_INDEX_SPOTS, spots),
    agentCap: Math.max(0, Math.min(MERGED_AGENT_CEILING, spots - MERGED_INDEX_SPOTS)),
  };
}
