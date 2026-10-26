import type { FleetWorkloadKind } from '@motir/orchestrator';
import type { HostAccountState } from '@/lib/ciFleet/hostAccountState';
import type { FleetCapacityRequestStatusDTO } from '@/lib/dto/fleetCapacityRequest';
import type { FleetQuotaRequestStatusDTO } from '@/lib/dto/fleetPools';
import type {
  FleetUseFigureDTO,
  FleetUseFigureSource,
  FleetUseHostAccountDTO,
  FleetUseProvider,
} from '@/lib/dto/fleetUse';
import { fmt } from './billingFormat';

// THE FLEET USE SECTION'S WORDS (Story MOTIR-9368 · MOTIR-9663) — the codes the
// fleet-use read returns, mapped to `billing.fleetUse.*` message keys. Every map is
// a `Record` over its union, so a code added to the DTO is a compile error here
// rather than a blank on the page. Pure: no React, no fetch.

export type FleetUseFigureKey =
  | 'agentRunsInParallel'
  | 'agentsRunningInOrg'
  | 'agentsPerPerson'
  | 'ciJobsInFlight';

/** The design's row order (design/billing § Amendment 2026-10-26, element 3). */
export const FIGURE_KEYS: readonly FleetUseFigureKey[] = [
  'agentRunsInParallel',
  'agentsRunningInOrg',
  'agentsPerPerson',
  'ciJobsInFlight',
];

export type AccountKind = FleetUseHostAccountDTO['accountKind'];

export const FLEET_KIND_KEYS: Record<FleetWorkloadKind, string> = {
  ci_runner: 'kind.ci_runner',
  code_graph_index: 'kind.code_graph_index',
  hosted_agent: 'kind.hosted_agent',
  agent_instance: 'kind.agent_instance',
};

export const PROVIDER_KEYS: Record<FleetUseProvider, string> = {
  fly: 'provider.fly',
  shared_aws_pool: 'provider.shared_aws_pool',
  own_aws_account: 'provider.own_aws_account',
};

export const ACCOUNT_STATE_KEYS: Record<HostAccountState, string> = {
  created: 'accounts.state.created',
  quota_requested: 'accounts.state.quota_requested',
  granted: 'accounts.state.granted',
  live: 'accounts.state.live',
};

export const ACCOUNT_KIND_KEYS: Record<AccountKind, string> = {
  ci_runner: 'accounts.kind.ci_runner',
  hosted_agent: 'accounts.kind.hosted_agent',
  indexer_and_hoster: 'accounts.kind.indexer_and_hoster',
};

export const ACCOUNT_ROLE_KEYS: Record<AccountKind, string> = {
  ci_runner: 'accounts.role.ci_runner',
  hosted_agent: 'accounts.role.hosted_agent',
  indexer_and_hoster: 'accounts.role.indexer_and_hoster',
};

export const SHARED_FLOOR_KEYS: Record<AccountKind, string> = {
  ci_runner: 'accounts.sharedFloor.ci_runner',
  hosted_agent: 'accounts.sharedFloor.hosted_agent',
  indexer_and_hoster: 'accounts.sharedFloor.indexer_and_hoster',
};

export const QUOTA_OUTCOME_KEYS: Record<FleetQuotaRequestStatusDTO, string> = {
  pending: 'quotaOutcome.pending',
  case_opened: 'quotaOutcome.case_opened',
  approved: 'quotaOutcome.approved',
  denied: 'quotaOutcome.denied',
  not_approved: 'quotaOutcome.not_approved',
  case_closed: 'quotaOutcome.case_closed',
  invalid_request: 'quotaOutcome.invalid_request',
};

export const REQUEST_STATUS_KEYS: Record<FleetCapacityRequestStatusDTO, string> = {
  open: 'request.status.open',
  filed: 'request.status.filed',
  closed: 'request.status.closed',
};

/** The source line under a figure; `plan` draws none. Keyed per figure where
 *  the words name the account the figure follows. */
export const FIGURE_SOURCE_KEYS: Record<FleetUseFigureSource, string | null> = {
  plan: null,
  staff_override: 'source.staffOverride',
  granted_quota: 'source.granted',
  shared_floor: 'source.sharedFloor',
  not_read: 'source.notRead',
};

/** A raise AWS refused reads as denied beside the account's state. */
export function isDeniedOutcome(outcome: FleetQuotaRequestStatusDTO | null): boolean {
  return outcome === 'denied' || outcome === 'not_approved';
}

export interface FigureView {
  /** `{ key, values }` for the right-hand reading of the row. */
  reading: { key: string; values: Record<string, string | number> };
  /** 0–100 for the meter, or null when no meter is drawn. */
  pct: number | null;
}

/**
 * How one figure row reads. A null figure or count is NOT READ — never `0` and
 * never "unlimited"; `noLimits` (a Motir-owned org) reads use alone.
 */
export function figureView(
  key: FleetUseFigureKey,
  row: FleetUseFigureDTO,
  locale: string,
  noLimits = false,
): FigureView {
  if (row.inUse === null) return { reading: { key: 'notRead', values: {} }, pct: null };
  const inUse = fmt(row.inUse, locale);
  if (noLimits) return { reading: { key: 'running', values: { count: inUse } }, pct: null };
  if (row.figure === null) return { reading: { key: 'notRead', values: {} }, pct: null };
  const figure = fmt(row.figure, locale);
  if (key === 'agentsPerPerson') {
    return { reading: { key: 'membersAt', values: { count: row.inUse, figure } }, pct: null };
  }
  const pct = row.figure > 0 ? (row.inUse / row.figure) * 100 : 100;
  return { reading: { key: 'inUseOf', values: { inUse, figure } }, pct };
}

/** The source line's key for one figure, or null when it draws none. */
export function figureSourceKey(
  key: FleetUseFigureKey,
  source: FleetUseFigureSource,
): string | null {
  const base = FIGURE_SOURCE_KEYS[source];
  if (base === null) return null;
  if (source === 'granted_quota' || source === 'shared_floor') {
    return key === 'ciJobsInFlight' ? `${base}.ciJobsInFlight` : `${base}.agentRunsInParallel`;
  }
  return base;
}

/** "Oct 26, 09:12" — the instant an account entered its state, in UTC. */
export function fmtDateTime(value: string | null, locale: string): string | null {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  });
}

/** When the account entered the state it is in. */
export function stateSince(account: FleetUseHostAccountDTO): string | null {
  switch (account.state) {
    case 'live':
      return account.liveAt;
    case 'granted':
      return account.grantedAt;
    case 'quota_requested':
      return account.quotaRequestedAt;
    case 'created':
      return account.createdAt;
  }
}

/** A request still open or filed replaces the account's Request button. */
export function activeRequest(account: FleetUseHostAccountDTO) {
  return account.capacityRequests.find((r) => r.status === 'open' || r.status === 'filed') ?? null;
}
