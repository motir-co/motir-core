import { describe, expect, it } from 'vitest';
import { toOrgFleetCapacityRequestDTO } from '@/lib/mappers/fleetCapacityRequestMappers';
import type { FleetCapacityRequestDTO } from '@/lib/dto/fleetCapacityRequest';

// THE TENANT-SAFE PICK (Story MOTIR-9368 · MOTIR-9662) — field by field, so an
// account id, shard id, quota code, quota request id or requester never reaches
// a tenant, with or without the linked AWS raise.

const staff: FleetCapacityRequestDTO = {
  id: 'cr_1',
  organizationId: 'org_1',
  shardId: 'shard_1',
  awsAccountId: '440000000001',
  fleetKind: 'ci_runner',
  quotaCode: 'L-1216C47A',
  desiredVcpu: 300,
  reasonMd: 'nightly matrix',
  status: 'filed',
  requestedByUserId: 'user_1',
  closedNote: null,
  createdAt: '2026-10-26T09:00:00.000Z',
  filedAt: '2026-10-26T10:00:00.000Z',
  closedAt: null,
  outcome: {
    quotaRequestId: 'qr_1',
    status: 'pending',
    grantedValue: null,
    lastReadAt: '2026-10-26T10:05:00.000Z',
  },
};

describe('toOrgFleetCapacityRequestDTO', () => {
  it('keeps the request and the AWS answer, and drops every id a tenant must not see', () => {
    const dto = toOrgFleetCapacityRequestDTO(staff);
    expect(dto).toEqual({
      id: 'cr_1',
      fleetKind: 'ci_runner',
      desiredVcpu: 300,
      reasonMd: 'nightly matrix',
      status: 'filed',
      closedNote: null,
      createdAt: '2026-10-26T09:00:00.000Z',
      filedAt: '2026-10-26T10:00:00.000Z',
      closedAt: null,
      outcome: { status: 'pending', grantedValue: null, lastReadAt: '2026-10-26T10:05:00.000Z' },
    });
    const text = JSON.stringify(dto);
    for (const secret of ['org_1', 'shard_1', '440000000001', 'L-1216C47A', 'user_1', 'qr_1']) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers a null outcome while no raise is linked', () => {
    expect(toOrgFleetCapacityRequestDTO({ ...staff, outcome: null }).outcome).toBeNull();
  });
});
