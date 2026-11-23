import { describe, expect, it } from 'vitest';
import type { FleetQuotaRequest, FleetShard } from '@/generated/prisma/client';
import {
  FLEET_USE_KINDS,
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
  agentsPerOrg: 30,
  ciBurstCap: ciBurstSource === 'unreadable' ? null : 10,
  ciBurstSource,
});

describe('figureSourceFor', () => {
  const ALL: FleetUseFigureKey[] = [
    'agentRunsInParallel',
    'agentsInOrg',
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
    ['agentsInOrg', new Set<FleetWorkloadKind>(['hosted_agent']), 'plan'],
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
  it('groups rows by AWS account, ordered ci → agent runner → agent hoster', () => {
    const groups = groupOwnAccounts(
      [
        // The merged account as MOTIR-12038 left it: one `agent_instance` row,
        // its past raise re-pointed at that row.
        row('m2', 'agent_instance', '333', { quotaRequestedAt: T0 }),
        row('h', 'hosted_agent', '222', { quotaRequestedAt: T0, grantedAt: T1, liveAt: T1 }),
        row('c', 'ci_runner', '111'),
      ],
      [
        raise('m2', 120, null, 'denied'),
        raise('h', 32, 32, 'approved'),
        raise('h', 64, null, 'pending', T1),
      ],
    );
    expect(groups.map((group) => group.accountKind)).toEqual([
      'ci_runner',
      'hosted_agent',
      'agent_hoster',
    ]);
    expect(groups[0]).toMatchObject({
      state: 'created',
      vcpuAsked: null,
      vcpuGranted: null,
      quotaOutcome: null,
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
      fleetKinds: ['agent_instance'],
      requestKind: 'agent_instance',
      state: 'quota_requested',
      vcpuAsked: 120,
      vcpuGranted: null,
      quotaOutcome: 'denied',
    });
    // No kept-spots figure on any account group (MOTIR-12039).
    for (const group of groups) {
      expect(Object.keys(group).sort()).toEqual(
        [
          'accountKind',
          'createdAt',
          'fleetKinds',
          'grantedAt',
          'liveAt',
          'quotaOutcome',
          'quotaRequestedAt',
          'requestKind',
          'shardIds',
          'state',
          'vcpuAsked',
          'vcpuGranted',
        ].sort(),
      );
    }
  });

  it('keeps each account’s shard ids on the group, for the mapper to attach history by', () => {
    const groups = groupOwnAccounts(
      [
        row('a1', 'agent_instance', '333'),
        row('a2', 'agent_instance', '333'),
        row('c', 'ci_runner', '111'),
      ],
      [],
    );
    expect(groups.map((group) => [...group.shardIds].sort())).toEqual([['c'], ['a1', 'a2']]);
  });

  it('lists no account whose rows run none of billing’s kinds', () => {
    // A row left on a kind billing does not describe (the retired indexer) is no
    // account on Billing & plans — never an "indexer" account by another name.
    const groups = groupOwnAccounts(
      [row('x', 'code_graph_index', '444'), row('c', 'ci_runner', '111')],
      [raise('x', 8, null, 'pending')],
    );
    expect(groups.map((group) => group.accountKind)).toEqual(['ci_runner']);
  });

  it('describes only billing’s own kinds on an account', () => {
    const [group] = groupOwnAccounts(
      [row('x', 'code_graph_index', '333'), row('a', 'agent_instance', '333')],
      [],
    );
    expect(group).toMatchObject({ accountKind: 'agent_hoster', fleetKinds: ['agent_instance'] });
  });

  it('returns no AWS account id', () => {
    const text = JSON.stringify(
      groupOwnAccounts([row('shard-xyz', 'ci_runner', '987654321098')], []),
    );
    expect(text).not.toContain('987654321098');
  });
});

describe('FLEET_USE_KINDS', () => {
  it('is billing’s own list: CI runner, agent runner, agent hoster', () => {
    expect(FLEET_USE_KINDS).toEqual(['ci_runner', 'hosted_agent', 'agent_instance']);
  });
});
