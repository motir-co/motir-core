import { ownAccountCapsFromGranted } from '@/lib/billing/hostOwnAccountCaps';
import { planCarriesOwnAccounts } from '@/lib/billing/ownAccountPlans';
import { capsForPlanKey, type PlanCaps } from '@/lib/billing/planCaps';
import { fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { _resetOrgPlanCache, readOrgPlan } from '@/lib/services/orgPlanReader';
import { withSystemContext } from '@/lib/workspaces/context';

// THE PLAN-CAPS LOOKUP (Story MOTIR-9363 · MOTIR-9372) — ONE call answers what an
// organisation's AI plan lets it run on Motir's fleets at once. The figures are
// `lib/billing/planCaps.ts`'s; the direction they come from is the fleet-capacity
// decision record MOTIR-9357, which replaces `fleet-per-org-pool.md` §2's flat
// 500-container pool with per-plan figures.
//
// The read is the paid-plan gate's (`orgPlanReader`): exempt before any remote
// read, 30-second cache, `unknown` never cached. Whether the org may spend at all
// stays the GATE's question, asked first by every door; this answers only HOW
// MUCH. So a canceled subscription whose `planTier` is still present still yields
// its figures, and the gate refuses it first.
//
// The answer is a discriminated union, so no caller can read a number without
// first handling the two non-numeric cases:
//   * `capped`       — the plan's four figures, and `planName` as motir-ai sends
//                      it, which is what a refusal or a deferral names.
//   * `exempt`       — Motir's own organisations, and a build with no billing.
//   * `plan_unknown` — FAIL CLOSED: the org row, the subscription or its plan
//                      tier could not be read, or the key has no row. The key is
//                      CARRIED, never replaced by a plausible default.

//
// An org on a plan with its own accounts — `host` or a larger pool on sale
// (`planCarriesOwnAccounts`, MOTIR-9653) — has two fleet figures that follow its
// OWN accounts (MOTIR-9587): once the
// agent-runner or CI account is live — and that kind's switch reads AWS, as
// admission's does — the figure is the account's granted vCPU ÷ 2, read from its
// quota requests on every call (a later raise shows on the next read, nothing is
// copied). Any failure of that read answers the plan's row, the shared floor —
// never a larger figure.

const AGENT_RUNNER: FleetWorkloadKind = 'hosted_agent';
const CI_RUNNER: FleetWorkloadKind = 'ci_runner';

/** A live own account's granted vCPU per kind — only for a kind on its pool. */
async function ownGranted(
  organizationId: string,
): Promise<Partial<Record<FleetWorkloadKind, number>>> {
  const kinds = new Set<FleetWorkloadKind>();
  for (const kind of [AGENT_RUNNER, CI_RUNNER]) {
    if (await fleetKindOnPool(kind)) kinds.add(kind);
  }
  if (kinds.size === 0) return {};
  return withSystemContext(async (tx) => {
    const granted: Partial<Record<FleetWorkloadKind, number>> = {};
    for (const row of await fleetShardRepository.listLiveOrgOwned(organizationId, tx)) {
      const kind = row.fleetKind as FleetWorkloadKind;
      if (!kinds.has(kind) || !row.awsAccountId) continue;
      const value = await fleetQuotaRequestRepository.maxGrantedForAwsAccountInTx(
        row.awsAccountId,
        tx,
      );
      if (value !== null) granted[kind] = value;
    }
    return granted;
  });
}

/** The plan's floor row, with each live own account's figure in place of the floor's. */
async function ownAccountCaps(organizationId: string, floor: PlanCaps): Promise<PlanCaps> {
  try {
    const granted = await ownGranted(organizationId);
    return ownAccountCapsFromGranted({
      floor,
      agentRunnerGrantedVcpu: granted[AGENT_RUNNER] ?? null,
      ciGrantedVcpu: granted[CI_RUNNER] ?? null,
    });
  } catch (err) {
    console.error(
      '[planCapsService] could not read the own accounts of an org on a plan with its own accounts — the floor',
      {
        organizationId,
        error: err instanceof Error ? err.name : 'UnknownError',
      },
    );
    return floor;
  }
}

export type PlanCapsAnswer =
  | { kind: 'capped'; planKey: string; planName: string; caps: PlanCaps }
  | { kind: 'exempt' }
  | { kind: 'plan_unknown'; planKey: string | null };

export const planCapsService = {
  /** What this organisation's plan lets it run at once. Never throws. */
  async capsFor(organizationId: string): Promise<PlanCapsAnswer> {
    const read = await readOrgPlan(organizationId);
    if (read.kind === 'exempt') return { kind: 'exempt' };
    if (read.kind === 'unknown') return { kind: 'plan_unknown', planKey: null };

    const tier = read.subscription.planTier;
    if (!tier) return { kind: 'plan_unknown', planKey: null };
    const caps = capsForPlanKey(tier.key);
    if (!caps) {
      console.error('[planCapsService] the plan key has no caps row — refusing (fail-closed)', {
        organizationId,
        planKey: tier.key,
      });
      return { kind: 'plan_unknown', planKey: tier.key };
    }
    if (planCarriesOwnAccounts(tier.key)) {
      return {
        kind: 'capped',
        planKey: tier.key,
        planName: tier.name,
        caps: await ownAccountCaps(organizationId, caps),
      };
    }
    return { kind: 'capped', planKey: tier.key, planName: tier.name, caps };
  },
};

/** Test seam: forget every cached read (shared with the paid-plan gate). */
export function _resetPlanCapsCache(): void {
  _resetOrgPlanCache();
}
