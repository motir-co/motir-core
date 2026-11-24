import { describe, expect, it } from 'vitest';
import { FLEET_USE_KINDS, type OwnAccountGroup } from '@/lib/billing/fleetUse';
import type { FleetCapacityRequestDTO } from '@/lib/dto/fleetCapacityRequest';
import type { FleetUseCounts } from '@/lib/services/fleetUseCountsService';
import { toFleetUseDTO, toFleetUseHostAccountDTO } from '@/lib/mappers/fleetUseMappers';

// FLEET USE → its tenant DTO (MOTIR-12039). A capacity request is attached to the
// account it was made on — by the account's SHARD ids, never by the kind it named —
// so a past request that named the retired indexer kind stays on the agent-hoster
// account it sits on, and nothing about the shard or the AWS account leaves.

const SHARD = 'shard-agent-hoster-1';
const OTHER_SHARD = 'shard-ci-1';
const AWS_ACCOUNT = '987654321098';

function group(overrides: Partial<OwnAccountGroup> = {}): OwnAccountGroup {
  return {
    accountKind: 'agent_hoster',
    fleetKinds: ['agent_instance'],
    requestKind: 'agent_instance',
    state: 'live',
    createdAt: '2026-10-01T00:00:00.000Z',
    quotaRequestedAt: '2026-10-02T00:00:00.000Z',
    grantedAt: '2026-10-03T00:00:00.000Z',
    liveAt: '2026-10-04T00:00:00.000Z',
    vcpuAsked: 120,
    vcpuGranted: 96,
    quotaOutcome: 'approved',
    shardIds: new Set([SHARD]),
    ...overrides,
  };
}

function request(
  id: string,
  shardId: string,
  fleetKind: FleetCapacityRequestDTO['fleetKind'],
): FleetCapacityRequestDTO {
  return {
    id,
    organizationId: 'org-1',
    shardId,
    awsAccountId: AWS_ACCOUNT,
    fleetKind,
    quotaCode: 'L-1216C47A',
    desiredVcpu: 128,
    reasonMd: 'More agents',
    status: 'closed',
    requestedByUserId: 'user-1',
    closedNote: null,
    createdAt: '2026-10-05T00:00:00.000Z',
    filedAt: '2026-10-05T01:00:00.000Z',
    closedAt: '2026-10-06T00:00:00.000Z',
    outcome: {
      quotaRequestId: 'quota-req-1',
      status: 'approved',
      grantedValue: 96,
      lastReadAt: '2026-10-06T00:00:00.000Z',
    },
  };
}

describe('toFleetUseHostAccountDTO — requests attach by shard', () => {
  it('lists a past code_graph_index request on the agent-hoster account it sits on', () => {
    const dto = toFleetUseHostAccountDTO(
      group(),
      [],
      [request('past-index', SHARD, 'code_graph_index')],
    );
    expect(dto.accountKind).toBe('agent_hoster');
    expect(dto.capacityRequests.map((r) => r.id)).toEqual(['past-index']);
    expect(dto.capacityRequests[0]).toMatchObject({
      fleetKind: 'code_graph_index',
      desiredVcpu: 128,
      outcome: { status: 'approved', grantedValue: 96 },
    });
  });

  it('leaves out a request on another account’s shard, even one naming this account’s kind', () => {
    const dto = toFleetUseHostAccountDTO(
      group(),
      [],
      [request('mine', SHARD, 'agent_instance'), request('theirs', OTHER_SHARD, 'agent_instance')],
    );
    expect(dto.capacityRequests.map((r) => r.id)).toEqual(['mine']);
  });

  it('carries no shard id, AWS account id or kept index spots — exactly the account fields', () => {
    const dto = toFleetUseHostAccountDTO(
      group(),
      ['agent_instance'],
      [request('past-index', SHARD, 'code_graph_index')],
    );
    const text = JSON.stringify(dto);
    expect(text).not.toContain(SHARD);
    expect(text).not.toContain(AWS_ACCOUNT);
    expect(text).not.toContain('quota-req-1');
    expect(dto).not.toHaveProperty('shardIds');
    expect(Object.keys(dto).sort()).toEqual(
      [
        'accountKind',
        'capacityRequests',
        'createdAt',
        'fleetKinds',
        'grantedAt',
        'liveAt',
        'onSharedFloor',
        'quotaOutcome',
        'quotaRequestedAt',
        'requestKind',
        'state',
        'vcpuAsked',
        'vcpuGranted',
      ].sort(),
    );
    expect(dto.onSharedFloor).toBe(true);
  });
});

describe('toFleetUseDTO — billing’s own kinds', () => {
  const counts: FleetUseCounts = {
    agentRuns: { inFlight: 1, waiting: { planLimit: 0, poolFull: 0, other: 0 } },
    ciJobs: { inFlight: 2, waiting: { planLimit: 0, poolFull: 0, other: 0 } },
    agentsLive: { inFlight: 3, waiting: null },
    agentsPerUser: { membersAtFigure: 0, waiting: null },
  };

  it('lists exactly the three use kinds where it runs, and no indexing count', () => {
    const dto = toFleetUseDTO({
      plan: { kind: 'exempt', ciBurstOverride: null },
      counts,
      onPool: { ci_runner: true, hosted_agent: false, agent_instance: true },
      ownAccountKinds: new Set(['agent_instance']),
      grantedKinds: new Set(),
      hostAccounts: null,
    });
    expect(dto.whereItRuns).toEqual([
      { fleetKind: 'ci_runner', provider: 'shared_aws_pool' },
      { fleetKind: 'hosted_agent', provider: 'fly' },
      { fleetKind: 'agent_instance', provider: 'own_aws_account' },
    ]);
    expect(dto.whereItRuns.map((row) => row.fleetKind)).toEqual([...FLEET_USE_KINDS]);
    expect(Object.keys(dto).sort()).toEqual([
      'countsRead',
      'figures',
      'hostAccounts',
      'plan',
      'whereItRuns',
    ]);
  });
});
