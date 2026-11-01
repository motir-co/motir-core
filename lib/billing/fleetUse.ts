import type { FleetQuotaRequest, FleetShard } from '@/generated/prisma/client';
import { HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { stateFromTimes, type HostAccountState } from '@/lib/ciFleet/hostAccountState';
import { MERGED_INDEX_SPOTS } from '@/lib/ciFleet/hostMergedAccountSplit';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import type { OrgPlanFiguresDTO } from '@/lib/dto/orgPlanFigures';
import type {
  FleetUseFigureSource,
  FleetUseHostAccountDTO,
  FleetUseProvider,
} from '@/lib/dto/fleetUse';

// THE FLEET USE READ'S PURE RULES (Story MOTIR-9368 · MOTIR-9661) — the three
// decisions `fleetUseService` makes over facts it has already read: where a kind
// runs, where a figure comes from, and how a Host org's own-account rows group
// into accounts. Pure: no `db`, no `process.env`. Each is table-tested in
// `tests/billing/fleetUseHelpers.test.ts`.

/**
 * Where a kind of the org's work runs, in ADMISSION'S order
 * (`fleetShardAdmissionService.chooseInTx`): the kind's switch first — off is
 * Fly, even with a live own account — then the org's own live account when
 * admission would place the kind there, else the shared AWS pool.
 */
export function providerFor(
  kind: FleetWorkloadKind,
  onPool: boolean,
  ownAccountKinds: ReadonlySet<FleetWorkloadKind>,
): FleetUseProvider {
  if (!onPool) return 'fly';
  return ownAccountKinds.has(kind) ? 'own_aws_account' : 'shared_aws_pool';
}

/** The four figures of the Fleet use section. */
export type FleetUseFigureKey =
  | 'agentRunsInParallel'
  | 'agentsInOrg'
  | 'agentsPerPerson'
  | 'ciJobsInFlight';

/** The kind whose own account sets a Host org's figure, for the two that follow one. */
const OWN_ACCOUNT_KIND: Partial<Record<FleetUseFigureKey, FleetWorkloadKind>> = {
  agentRunsInParallel: 'hosted_agent',
  ciJobsInFlight: 'ci_runner',
};

/**
 * Where one figure comes from. `grantedKinds` are the kinds whose figure
 * `planCapsService` swapped for granted vCPU ÷ 2 (switch on, own account live, a
 * granted value read) — the same three-part condition, since `capsFor` exposes
 * no source of its own.
 */
export function figureSourceFor(
  key: FleetUseFigureKey,
  plan: OrgPlanFiguresDTO,
  grantedKinds: ReadonlySet<FleetWorkloadKind>,
): FleetUseFigureSource {
  if (plan.kind === 'plan_unknown') return 'not_read';
  if (key === 'ciJobsInFlight') {
    if (plan.kind === 'exempt') return plan.ciBurstOverride === null ? 'plan' : 'staff_override';
    if (plan.ciBurstSource === 'override') return 'staff_override';
    if (plan.ciBurstSource === 'unreadable') return 'not_read';
  }
  if (plan.kind === 'exempt') return 'plan';
  const ownKind = OWN_ACCOUNT_KIND[key];
  if (plan.planKey !== HOST_PLAN_KEY || !ownKind) return 'plan';
  return grantedKinds.has(ownKind) ? 'granted_quota' : 'shared_floor';
}

/** One own AWS account, grouped from its rows; the service adds the floor and requests. */
export type OwnAccountGroup = Omit<FleetUseHostAccountDTO, 'onSharedFloor' | 'capacityRequests'>;

function accountKindOf(kinds: ReadonlySet<string>): FleetUseHostAccountDTO['accountKind'] {
  if (kinds.has('ci_runner')) return 'ci_runner';
  if (kinds.has('hosted_agent')) return 'hosted_agent';
  return 'indexer_and_hoster';
}

const ACCOUNT_ORDER: FleetUseHostAccountDTO['accountKind'][] = [
  'ci_runner',
  'hosted_agent',
  'indexer_and_hoster',
];

function maxOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function earliest(times: readonly (Date | null)[]): Date | null {
  const present = times.filter((at): at is Date => at !== null);
  return present.length > 0 ? new Date(Math.min(...present.map((at) => at.getTime()))) : null;
}

function groupOne(rows: readonly FleetShard[], requests: readonly FleetQuotaRequest[]) {
  const kindSet = new Set<string>(rows.map((row) => row.fleetKind));
  const fleetKinds = FLEET_WORKLOAD_KINDS.filter((kind) => kindSet.has(kind));
  const accountKind = accountKindOf(kindSet);
  const times = {
    quotaRequestedAt: earliest(rows.map((row) => row.quotaRequestedAt)),
    grantedAt: earliest(rows.map((row) => row.grantedAt)),
    liveAt: earliest(rows.map((row) => row.liveAt)),
  };
  const latest = [...requests].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const state: HostAccountState = stateFromTimes(times);
  return {
    accountKind,
    fleetKinds,
    // The merged account's raise sits on its indexer row (`hostAccountPlan`).
    requestKind: fleetKinds.includes('code_graph_index') ? 'code_graph_index' : fleetKinds[0]!,
    state,
    createdAt: earliest(rows.map((row) => row.createdAt))!.toISOString(),
    quotaRequestedAt: times.quotaRequestedAt?.toISOString() ?? null,
    grantedAt: times.grantedAt?.toISOString() ?? null,
    liveAt: times.liveAt?.toISOString() ?? null,
    vcpuAsked: maxOf(requests.map((request) => request.desiredValue)),
    vcpuGranted: maxOf(requests.map((request) => request.grantedValue)),
    quotaOutcome: latest?.status ?? null,
    keptIndexSpots: accountKind === 'indexer_and_hoster' ? MERGED_INDEX_SPOTS : null,
  } satisfies OwnAccountGroup;
}

/**
 * A Host org's own-account rows as ACCOUNTS: grouped by AWS account (the merged
 * indexer + agent hoster account is two rows on one), with the account's times,
 * its largest asked and granted vCPU across every row's raises, and AWS's status
 * on the latest raise. The AWS account id groups and is never returned.
 */
export function groupOwnAccounts(
  rows: readonly FleetShard[],
  quotaRequests: readonly FleetQuotaRequest[],
): OwnAccountGroup[] {
  const byAccount = new Map<string, FleetShard[]>();
  for (const row of rows) {
    const key = row.awsAccountId ?? `row:${row.id}`;
    byAccount.set(key, [...(byAccount.get(key) ?? []), row]);
  }
  const groups = [...byAccount.values()].map((accountRows) => {
    const ids = new Set(accountRows.map((row) => row.id));
    return groupOne(
      accountRows,
      quotaRequests.filter((request) => ids.has(request.shardId)),
    );
  });
  return groups.sort(
    (a, b) => ACCOUNT_ORDER.indexOf(a.accountKind) - ACCOUNT_ORDER.indexOf(b.accountKind),
  );
}
