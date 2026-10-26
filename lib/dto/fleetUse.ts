import type { FleetWorkloadKind } from '@motir/orchestrator';
import type { FleetQuotaRequestStatusDTO } from '@/lib/dto/fleetPools';
import type { HostAccountState } from '@/lib/ciFleet/hostAccountState';
import type { OrgFleetCapacityRequestDTO } from '@/lib/dto/fleetCapacityRequest';

/**
 * AN ORGANISATION'S FLEET USE (Story MOTIR-9368 · MOTIR-9661) — everything the
 * Fleet use section of Billing & plans shows, for the org's owner or admin only.
 *
 * Every field is the org's OWN: its plan and figures, what it has in flight and
 * waiting, where each kind of its work runs, and on Host its accounts' states.
 * It must NEVER carry an organisation id, AWS account id, shard id, credential
 * ref, quota code, AWS request id, member-account email, user id or member name.
 * It is built field by field (`lib/mappers/fleetUseMappers.ts`), never by
 * spreading a row or a `FleetShardDTO` (which carries `aws.accountId` and
 * `credentialRef`). Codes, never sentences: the page owns every word.
 */

export type FleetUsePlanDTO =
  /** `noFleet`: all four figures are 0 (the Free plan). */
  | { kind: 'limited'; planKey: string; planName: string; noFleet: boolean }
  /** A Motir-owned org (meta or internal billing). */
  | { kind: 'no_plan_limits' }
  /** The plan could not be read, or its key has no caps row. */
  | { kind: 'not_read' };

/** Where a figure comes from. `granted_quota`: a Host org's own live account's
 *  granted vCPU ÷ 2; `shared_floor`: a Host org still at Max's limits for that
 *  kind; `not_read`: the plan, or the CI override, could not be read. */
export type FleetUseFigureSource =
  | 'plan'
  | 'staff_override'
  | 'granted_quota'
  | 'shared_floor'
  | 'not_read';

/** Waiting work behind one figure; the three add up to every waiting job. */
export interface FleetUseWaitingDTO {
  /** Held by the org's own plan figure — what a plan change fixes. */
  planLimit: number;
  /** Held because every account of the kind is full. */
  poolFull: number;
  other: number;
}

export interface FleetUseFigureDTO {
  /** Null under no plan limits, a plan not read, or an unreadable CI override. */
  figure: number | null;
  /** Null when the counts could not be read — never 0 for a failure. */
  inUse: number | null;
  /** Null for a figure that refuses rather than queues, or counts not read. */
  waiting: FleetUseWaitingDTO | null;
  figureSource: FleetUseFigureSource;
}

export type FleetUseProvider = 'fly' | 'shared_aws_pool' | 'own_aws_account';

export interface FleetUseWhereItRunsDTO {
  fleetKind: FleetWorkloadKind;
  provider: FleetUseProvider;
}

/** One of a Host org's own AWS accounts, named by what it runs — never by id. */
export interface FleetUseHostAccountDTO {
  accountKind: 'ci_runner' | 'hosted_agent' | 'indexer_and_hoster';
  fleetKinds: FleetWorkloadKind[];
  /** The kind the Request more capacity POST takes for this account. */
  requestKind: FleetWorkloadKind;
  state: HostAccountState;
  createdAt: string;
  quotaRequestedAt: string | null;
  grantedAt: string | null;
  liveAt: string | null;
  /** The largest vCPU asked of AWS across the account's raises. */
  vcpuAsked: number | null;
  /** The largest vCPU AWS granted across them; null while none is. */
  vcpuGranted: number | null;
  /** AWS's status on the latest raise — a denial reads here, beside `state`. */
  quotaOutcome: FleetQuotaRequestStatusDTO | null;
  onSharedFloor: boolean;
  /** The index spots always kept on the merged account; null elsewhere. */
  keptIndexSpots: number | null;
  /** The org's requests on this account's kinds, newest first. */
  capacityRequests: OrgFleetCapacityRequestDTO[];
}

export interface FleetUseDTO {
  plan: FleetUsePlanDTO;
  /** False when the counts could not be read: every `inUse` and `waiting` is null. */
  countsRead: boolean;
  figures: {
    agentRunsInParallel: FleetUseFigureDTO;
    agentsRunningInOrg: FleetUseFigureDTO;
    agentsPerPerson: FleetUseFigureDTO;
    ciJobsInFlight: FleetUseFigureDTO;
  };
  /** Held to no figure. */
  codeGraphIndex: { inUse: number | null };
  /** One row per fleet kind, in the registry's order. */
  whereItRuns: FleetUseWhereItRunsDTO[];
  /** Null for an org with no own account; `not_read` when the read failed. */
  hostAccounts: FleetUseHostAccountDTO[] | { kind: 'not_read' } | null;
}
