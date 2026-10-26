import { describe, expect, it } from 'vitest';
import type { FleetQuotaRequest, FleetShard } from '@/generated/prisma/client';
import {
  figureSourceFor,
  groupOwnAccounts,
  providerFor,
  type FleetUseFigureKey,
} from '@/lib/billing/fleetUse';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import type { OrgPlanFiguresDTO } from '@/lib/dto/orgPlanFigures';

// THE FLEET USE READ'S PURE RULES (Story MOTIR-9368 · MOTIR-9661) — where a kind
// runs, where a figure comes from, and how own-account rows group into accounts.

const none = new Set<FleetWorkloadKind>();

describe('providerFor — admission’s order', () => {
  it.each([
    [false, none, 'fly'],
    [false, new Set<FleetWorkloadKind>(['ci_runner']), 'fly'],
    [true, none, 'shared_aws_pool'],
    [true, new Set<FleetWorkloadKind>(['hosted_agent']), 'shared_aws_pool'],
    [true, new Set<FleetWorkloadKind>(['ci_runner']), 'own_aws_account'],
  ] as const)('switch on=%s, own kinds %o → %s', (onPool, own, expected) => {
    expect(providerFor('ci_runner', onPool, own)).toBe(expected);
  });
});

const capped = (
  planKey: string,
  ciBurstSource: 'plan' | 'override' | 'unreadable' = 'plan',
): OrgPlanFiguresDTO => ({
  kind: 'capped',
  planKey,
  planName: planKey,
  agentRunsInParallel: 3,
  agentsPerUser: 5,
  agentsRunningPerOrg: 30,
  ciBurstCap: ciBurstSource === 'unreadable' ? null : 10,
  ciBurstSource,
});

describe('figureSourceFor', () => {
  const ALL: FleetUseFigureKey[] = [
    'agentRunsInParallel',
    'agentsRunningInOrg',
    'agentsPerPerson',
    'ciJobsInFlight',
  ];

  it('a plan not read is not_read on every figure', () => {
    for (const key of ALL) {
      expect(figureSourceFor(key, { kind: 'plan_unknown', planKey: null }, none)).toBe('not_read');
    }
  });

  it('a Pro plan is plan on every figure', () => {
    for (const key of ALL) expect(figureSourceFor(key, capped('pro'), none)).toBe('plan');
  });

  it.each([
    ['override', 'staff_override'],
    ['unreadable', 'not_read'],
    ['plan', 'plan'],
  ] as const)('the CI row with source %s reads %s', (source, expected) => {
    expect(figureSourceFor('ciJobsInFlight', capped('pro', source), none)).toBe(expected);
  });

  it('an exempt org reads plan, or staff_override on CI when one is set', () => {
    const exempt = (ciBurstOverride: number | null): OrgPlanFiguresDTO => ({
      kind: 'exempt',
      ciBurstOverride,
    });
    expect(figureSourceFor('ciJobsInFlight', exempt(null), none)).toBe('plan');
    expect(figureSourceFor('ciJobsInFlight', exempt(40), none)).toBe('staff_override');
    expect(figureSourceFor('agentRunsInParallel', exempt(40), none)).toBe('plan');
  });

  it.each([
    ['agentRunsInParallel', none, 'shared_floor'],
    ['agentRunsInParallel', new Set<FleetWorkloadKind>(['hosted_agent']), 'granted_quota'],
    ['agentRunsInParallel', new Set<FleetWorkloadKind>(['ci_runner']), 'shared_floor'],
    ['ciJobsInFlight', new Set<FleetWorkloadKind>(['ci_runner']), 'granted_quota'],
    ['ciJobsInFlight', none, 'shared_floor'],
    ['agentsRunningInOrg', new Set<FleetWorkloadKind>(['hosted_agent']), 'plan'],
    ['agentsPerPerson', none, 'plan'],
  ] as const)('on Host, %s with granted %o reads %s', (key, granted, expected) => {
    expect(figureSourceFor(key, capped('host'), granted)).toBe(expected);
  });

  it('a staff override on Host still reads staff_override', () => {
    expect(figureSourceFor('ciJobsInFlight', capped('host', 'override'), none)).toBe(
      'staff_override',
    );
  });
});

const T0 = new Date('2026-10-26T10:00:00.000Z');
const T1 = new Date('2026-10-26T11:00:00.000Z');

function row(id: string, fleetKind: string, awsAccountId: string, times: Partial<FleetShard> = {}) {
  return {
    id,
    fleetKind,
    awsAccountId,
    createdAt: T0,
    quotaRequestedAt: null,
    grantedAt: null,
    liveAt: null,
    ...times,
  } as FleetShard;
}

function raise(
  shardId: string,
  desiredValue: number,
  grantedValue: number | null,
  status: string,
  createdAt = T0,
) {
  return { shardId, desiredValue, grantedValue, status, createdAt } as FleetQuotaRequest;
}

describe('groupOwnAccounts', () => {
  it('groups the merged account’s two rows into one, ordered ci → agent runner → merged', () => {
    const groups = groupOwnAccounts(
      [
        row('m1', 'code_graph_index', '333', { quotaRequestedAt: T0 }),
        row('m2', 'agent_instance', '333', { quotaRequestedAt: T0 }),
        row('h', 'hosted_agent', '222', { quotaRequestedAt: T0, grantedAt: T1, liveAt: T1 }),
        row('c', 'ci_runner', '111'),
      ],
      [
        raise('m1', 120, null, 'denied'),
        raise('h', 32, 32, 'approved'),
        raise('h', 64, null, 'pending', T1),
      ],
    );
    expect(groups.map((group) => group.accountKind)).toEqual([
      'ci_runner',
      'hosted_agent',
      'indexer_and_hoster',
    ]);
    expect(groups[0]).toMatchObject({
      state: 'created',
      vcpuAsked: null,
      vcpuGranted: null,
      quotaOutcome: null,
      keptIndexSpots: null,
      requestKind: 'ci_runner',
    });
    expect(groups[1]).toMatchObject({
      state: 'live',
      liveAt: T1.toISOString(),
      vcpuAsked: 64,
      vcpuGranted: 32,
      quotaOutcome: 'pending',
    });
    expect(groups[2]).toMatchObject({
      fleetKinds: ['code_graph_index', 'agent_instance'],
      requestKind: 'code_graph_index',
      state: 'quota_requested',
      vcpuAsked: 120,
      vcpuGranted: null,
      quotaOutcome: 'denied',
      keptIndexSpots: 10,
    });
  });

  it('returns no AWS account id or shard id', () => {
    const text = JSON.stringify(
      groupOwnAccounts([row('shard-xyz', 'ci_runner', '987654321098')], []),
    );
    expect(text).not.toContain('987654321098');
    expect(text).not.toContain('shard-xyz');
  });
});
