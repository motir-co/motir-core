import { HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { groupOwnAccounts } from '@/lib/billing/fleetUse';
import { fleetKindOnPool } from '@/lib/ciFleet/shardTargets';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import type { FleetUseDTO, FleetUseHostAccountDTO } from '@/lib/dto/fleetUse';
import type { OrgPlanFiguresDTO } from '@/lib/dto/orgPlanFigures';
import { toFleetUseDTO, toFleetUseHostAccountDTO } from '@/lib/mappers/fleetUseMappers';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { billingService, type OrgActorInput } from '@/lib/services/billingService';
import { fleetCapacityRequestService } from '@/lib/services/fleetCapacityRequestService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetUseCountsService, type FleetUseCounts } from '@/lib/services/fleetUseCountsService';
import { hostAccountStateService } from '@/lib/services/hostAccountStateService';
import { orgPlanFiguresService } from '@/lib/services/orgPlanFiguresService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE FLEET USE READ (Story MOTIR-9368 · MOTIR-9661) — everything the Fleet use
// section of Billing & plans shows, for the org's owner or admin only.
//
// ⚠️ COMPOSE, NEVER RE-DERIVE. Every figure is `orgPlanFiguresService`'s, every
// count `fleetUseCountsService`'s, every account state the stored times', every
// shared-floor answer `hostAccountStateService`'s and every switch
// `fleetKindOnPool`'s — so the page and admission cannot disagree. This service
// only groups, labels and contains failures.
//
// ⚠️ CONTAIN EACH PART. Only the gate refuses the whole read. The plan never
// throws; the counts and the Host accounts each fail to their own not-read state
// and are logged. A failed count is never a 0.
//
// ⚠️ A REPORT. It takes no admission lock and writes nothing.

const LOG = '[fleetUseService]';
/** The kinds whose Host figure follows the own account's grant (`planCapsService`). */
const GRANT_FOLLOWING_KINDS: FleetWorkloadKind[] = ['hosted_agent', 'ci_runner'];

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

async function readCounts(
  organizationId: string,
  plan: OrgPlanFiguresDTO,
  now: Date,
): Promise<FleetUseCounts | null> {
  try {
    const agentsPerUser = plan.kind === 'capped' ? plan.agentsPerUser : null;
    return await fleetUseCountsService.countsFor(organizationId, { agentsPerUser }, now);
  } catch (err) {
    console.error(`${LOG} could not read the organization's fleet use counts`, {
      organizationId,
      error: errorName(err),
    });
    return null;
  }
}

async function readSwitches(): Promise<Record<FleetWorkloadKind, boolean>> {
  const onPool = {} as Record<FleetWorkloadKind, boolean>;
  for (const kind of FLEET_WORKLOAD_KINDS) onPool[kind] = await fleetKindOnPool(kind);
  return onPool;
}

/** The kinds admission would place on the org's own live account — its own
 *  predicate, so an org that left Host reads the shared pool. */
async function ownAccountKinds(
  organizationId: string,
  onPool: Record<FleetWorkloadKind, boolean>,
): Promise<Set<FleetWorkloadKind>> {
  const kinds = new Set<FleetWorkloadKind>();
  await withSystemContext(async (tx) => {
    for (const fleetKind of FLEET_WORKLOAD_KINDS) {
      if (!onPool[fleetKind]) continue;
      const own = await fleetShardAdmissionService.ownAccountInTx(
        { fleetKind, organizationId },
        tx,
      );
      if (own && own !== 'plan_unknown') kinds.add(fleetKind);
    }
  });
  return kinds;
}

/**
 * The kinds whose Host figure is granted vCPU ÷ 2 — `planCapsService.ownGranted`'s
 * three-part condition: the switch on, the own account live, a granted value
 * read. A failed read is the floor, as `capsFor`'s is.
 */
async function grantedKinds(
  organizationId: string,
  plan: OrgPlanFiguresDTO,
  onPool: Record<FleetWorkloadKind, boolean>,
): Promise<Set<FleetWorkloadKind>> {
  const kinds = new Set<FleetWorkloadKind>();
  if (plan.kind !== 'capped' || plan.planKey !== HOST_PLAN_KEY) return kinds;
  try {
    await withSystemContext(async (tx) => {
      for (const row of await fleetShardRepository.listLiveOrgOwned(organizationId, tx)) {
        const kind = row.fleetKind as FleetWorkloadKind;
        if (!GRANT_FOLLOWING_KINDS.includes(kind) || !onPool[kind] || !row.awsAccountId) continue;
        const granted = await fleetQuotaRequestRepository.maxGrantedForAwsAccountInTx(
          row.awsAccountId,
          tx,
        );
        if (granted !== null) kinds.add(kind);
      }
    });
  } catch (err) {
    console.error(`${LOG} could not read a Host org's grants — the floor`, {
      organizationId,
      error: errorName(err),
    });
    kinds.clear();
  }
  return kinds;
}

async function readHostAccounts(
  organizationId: string,
): Promise<FleetUseHostAccountDTO[] | { kind: 'not_read' } | null> {
  try {
    const { rows, quotaRequests } = await withSystemContext(async (tx) => {
      const rows = await fleetShardRepository.listOrgOwnedInTx(organizationId, tx);
      const quotaRequests = await fleetQuotaRequestRepository.listByShardIdsInTx(
        rows.map((row) => row.id),
        tx,
      );
      return { rows, quotaRequests };
    });
    if (rows.length === 0) return null;
    const floor = await hostAccountStateService.sharedFloorKinds(organizationId);
    const requests = await fleetCapacityRequestService.listForOrganization(organizationId);
    return groupOwnAccounts(rows, quotaRequests).map((group) =>
      toFleetUseHostAccountDTO(group, floor, requests),
    );
  } catch (err) {
    console.error(`${LOG} could not read the organization's own accounts`, {
      organizationId,
      error: errorName(err),
    });
    return { kind: 'not_read' };
  }
}

export const fleetUseService = {
  /**
   * The org's fleet use. Owner or admin only — Billing & plans' own view gate:
   * BillingNotAvailableError off-cloud, OrganizationNotFoundError for a
   * non-member, BillingForbiddenError for a plain member, all before any read.
   */
  async readForOrganization(input: OrgActorInput, now = new Date()): Promise<FleetUseDTO> {
    await billingService.assertCanViewBilling(input);
    const { organizationId } = input;
    const plan = await orgPlanFiguresService.figuresFor(organizationId);
    const counts = await readCounts(organizationId, plan, now);
    const onPool = await readSwitches();
    return toFleetUseDTO({
      plan,
      counts,
      onPool,
      ownAccountKinds: await ownAccountKinds(organizationId, onPool),
      grantedKinds: await grantedKinds(organizationId, plan, onPool),
      hostAccounts: await readHostAccounts(organizationId),
    });
  },
};
