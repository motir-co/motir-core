import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import {
  figureSourceFor,
  providerFor,
  type FleetUseFigureKey,
  type OwnAccountGroup,
} from '@/lib/billing/fleetUse';
import type { FleetCapacityRequestDTO } from '@/lib/dto/fleetCapacityRequest';
import type {
  FleetUseDTO,
  FleetUseFigureDTO,
  FleetUseHostAccountDTO,
  FleetUsePlanDTO,
  FleetUseWaitingDTO,
} from '@/lib/dto/fleetUse';
import type { OrgPlanFiguresDTO } from '@/lib/dto/orgPlanFigures';
import { toOrgFleetCapacityRequestDTO } from '@/lib/mappers/fleetCapacityRequestMappers';
import type { FleetUseCounts, FleetWaitingCounts } from '@/lib/services/fleetUseCountsService';

// FLEET USE → its tenant DTO (Story MOTIR-9368 · MOTIR-9661). Field by field,
// never a spread: a field added to a row, a count or a request never reaches a
// tenant by default.

export interface FleetUseFacts {
  plan: OrgPlanFiguresDTO;
  /** Null when the counts could not be read. */
  counts: FleetUseCounts | null;
  onPool: Readonly<Record<FleetWorkloadKind, boolean>>;
  /** Kinds admission would place on the org's own live account. */
  ownAccountKinds: ReadonlySet<FleetWorkloadKind>;
  /** Kinds whose Host figure is granted vCPU ÷ 2. */
  grantedKinds: ReadonlySet<FleetWorkloadKind>;
  hostAccounts: FleetUseHostAccountDTO[] | { kind: 'not_read' } | null;
}

export function toFleetUsePlanDTO(plan: OrgPlanFiguresDTO): FleetUsePlanDTO {
  if (plan.kind === 'exempt') return { kind: 'no_plan_limits' };
  if (plan.kind === 'plan_unknown') return { kind: 'not_read' };
  const noFleet =
    plan.agentRunsInParallel === 0 &&
    plan.agentsPerUser === 0 &&
    plan.agentsRunningPerOrg === 0 &&
    plan.ciBurstCap === 0;
  return { kind: 'limited', planKey: plan.planKey, planName: plan.planName, noFleet };
}

function figureOf(plan: OrgPlanFiguresDTO, key: FleetUseFigureKey): number | null {
  if (plan.kind === 'plan_unknown') return null;
  if (plan.kind === 'exempt') return key === 'ciJobsInFlight' ? plan.ciBurstOverride : null;
  switch (key) {
    case 'agentRunsInParallel':
      return plan.agentRunsInParallel;
    case 'agentsRunningInOrg':
      return plan.agentsRunningPerOrg;
    case 'agentsPerPerson':
      return plan.agentsPerUser;
    case 'ciJobsInFlight':
      return plan.ciBurstCap;
  }
}

function toWaiting(waiting: FleetWaitingCounts | null): FleetUseWaitingDTO | null {
  if (!waiting) return null;
  return { planLimit: waiting.planLimit, poolFull: waiting.poolFull, other: waiting.other };
}

function countsOfFigure(
  counts: FleetUseCounts,
  key: FleetUseFigureKey,
): { inUse: number | null; waiting: FleetWaitingCounts | null } {
  switch (key) {
    case 'agentRunsInParallel':
      return { inUse: counts.agentRuns.inFlight, waiting: counts.agentRuns.waiting };
    case 'agentsRunningInOrg':
      return { inUse: counts.agentsRunning.inFlight, waiting: null };
    case 'agentsPerPerson':
      return { inUse: counts.agentsPerUser.membersAtFigure, waiting: null };
    case 'ciJobsInFlight':
      return { inUse: counts.ciJobs.inFlight, waiting: counts.ciJobs.waiting };
  }
}

function toFigure(facts: FleetUseFacts, key: FleetUseFigureKey): FleetUseFigureDTO {
  const use = facts.counts ? countsOfFigure(facts.counts, key) : { inUse: null, waiting: null };
  return {
    figure: figureOf(facts.plan, key),
    inUse: use.inUse,
    waiting: toWaiting(use.waiting),
    figureSource: figureSourceFor(key, facts.plan, facts.grantedKinds),
  };
}

/** One account's DTO: its group, the floor answer and its own requests. */
export function toFleetUseHostAccountDTO(
  group: OwnAccountGroup,
  sharedFloorKinds: readonly FleetWorkloadKind[],
  requests: readonly FleetCapacityRequestDTO[],
): FleetUseHostAccountDTO {
  return {
    accountKind: group.accountKind,
    fleetKinds: [...group.fleetKinds],
    requestKind: group.requestKind,
    state: group.state,
    createdAt: group.createdAt,
    quotaRequestedAt: group.quotaRequestedAt,
    grantedAt: group.grantedAt,
    liveAt: group.liveAt,
    vcpuAsked: group.vcpuAsked,
    vcpuGranted: group.vcpuGranted,
    quotaOutcome: group.quotaOutcome,
    onSharedFloor: group.fleetKinds.some((kind) => sharedFloorKinds.includes(kind)),
    keptIndexSpots: group.keptIndexSpots,
    capacityRequests: requests
      .filter((request) => group.fleetKinds.includes(request.fleetKind))
      .map(toOrgFleetCapacityRequestDTO),
  };
}

export function toFleetUseDTO(facts: FleetUseFacts): FleetUseDTO {
  return {
    plan: toFleetUsePlanDTO(facts.plan),
    countsRead: facts.counts !== null,
    figures: {
      agentRunsInParallel: toFigure(facts, 'agentRunsInParallel'),
      agentsRunningInOrg: toFigure(facts, 'agentsRunningInOrg'),
      agentsPerPerson: toFigure(facts, 'agentsPerPerson'),
      ciJobsInFlight: toFigure(facts, 'ciJobsInFlight'),
    },
    codeGraphIndex: { inUse: facts.counts?.codeGraphIndex.inFlight ?? null },
    whereItRuns: FLEET_WORKLOAD_KINDS.map((fleetKind) => ({
      fleetKind,
      provider: providerFor(fleetKind, facts.onPool[fleetKind], facts.ownAccountKinds),
    })),
    hostAccounts: facts.hostAccounts,
  };
}
