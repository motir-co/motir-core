import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  FleetPoolValueInvalidError,
  FleetQuotaRequestOpenError,
  FleetShardNotFoundError,
} from '@/lib/ciFleet/errors';
import {
  FLEET_QUOTA_REQUEST_STATUSES,
  FLEET_QUOTA_REQUEST_TERMINAL_STATUSES,
} from '@/lib/mappers/fleetPoolMappers';
import { fleetGrowthEventService } from '@/lib/services/fleetGrowthEventService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardService, type CreateFleetShardInput } from '@/lib/services/fleetShardService';
import { adminDb } from '../helpers/adminDb';

// THE QUOTA-REQUEST AND GROWTH-EVENT RECORDS (Story MOTIR-9362 · MOTIR-9457),
// against real Postgres: idempotent create, terminal reads close a request, the
// status and outcome vocabularies, newest-first events, and the one-in-flight
// query read through the request.

function awsAccount(n: number, overrides: Partial<CreateFleetShardInput> = {}) {
  return fleetShardService.createShard({
    name: `ci-runner-aws-${n}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    state: 'active',
    githubOrg: `motir-shard-${n}`,
    githubInstallationId: `${9000 + n}`,
    awsAccountId: `11111111${String(n).padStart(4, '0')}`,
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_AWS_TEST',
    limits: { vcpuQuota: 64 },
    ...overrides,
  });
}

async function clean() {
  await adminDb.fleetGrowthEvent.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
}

beforeEach(clean);

afterAll(async () => {
  await clean();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a quota request', () => {
  it('is created pending with its account, code, desired value and AWS id', async () => {
    const shard = await awsAccount(1);
    const request = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-abc',
    });
    expect(request).toMatchObject({
      shardId: shard.id,
      fleetKind: 'ci_runner',
      quotaCode: 'L-1216C47A',
      desiredValue: 200,
      awsRequestId: 'req-abc',
      status: 'pending',
      grantedValue: null,
      lastReadAt: null,
      closedAt: null,
    });
  });

  it('is idempotent while open: the same account, code and value answers the existing record', async () => {
    const shard = await awsAccount(1);
    const first = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    const again = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-2',
    });
    expect(again.id).toBe(first.id);
    expect(again.awsRequestId).toBe('req-1');
    expect(await adminDb.fleetQuotaRequest.count()).toBe(1);
  });

  it('refuses a second open request of the same quota for another value', async () => {
    const shard = await awsAccount(1);
    await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    await expect(
      fleetQuotaRequestService.createRequest({
        shardId: shard.id,
        desiredValue: 400,
        awsRequestId: 'req-2',
      }),
    ).rejects.toBeInstanceOf(FleetQuotaRequestOpenError);
  });

  it('the database holds one open request per account and code on its own', async () => {
    const shard = await awsAccount(1);
    const row = {
      shardId: shard.id,
      fleetKind: 'ci_runner',
      quotaCode: 'L-1216C47A',
      desiredValue: 200,
      awsRequestId: 'req-1',
    };
    await adminDb.fleetQuotaRequest.create({ data: row });
    await expect(adminDb.fleetQuotaRequest.create({ data: row })).rejects.toThrow(
      /Unique constraint/i,
    );
  });

  it('refuses an unknown account and a non-positive value', async () => {
    await expect(
      fleetQuotaRequestService.createRequest({
        shardId: 'nope',
        desiredValue: 200,
        awsRequestId: 'r',
      }),
    ).rejects.toBeInstanceOf(FleetShardNotFoundError);
    const shard = await awsAccount(1);
    await expect(
      fleetQuotaRequestService.createRequest({
        shardId: shard.id,
        desiredValue: 0,
        awsRequestId: 'r',
      }),
    ).rejects.toBeInstanceOf(FleetPoolValueInvalidError);
  });

  it('a read stores status, granted value and read time; a non-terminal one stays open', async () => {
    const shard = await awsAccount(1);
    const request = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    const at = new Date('2026-10-24T10:00:00.000Z');
    const read = await fleetQuotaRequestService.recordRead(
      request.id,
      { status: 'case_opened', grantedValue: null },
      () => at,
    );
    expect(read).toMatchObject({
      status: 'case_opened',
      lastReadAt: at.toISOString(),
      closedAt: null,
    });
    expect(
      (await fleetQuotaRequestService.listOpen({ fleetKind: 'ci_runner' })).map((r) => r.id),
    ).toEqual([request.id]);
  });

  it.each(FLEET_QUOTA_REQUEST_TERMINAL_STATUSES)(
    'a %s read closes the request and it leaves the open list',
    async (status) => {
      const shard = await awsAccount(1);
      const request = await fleetQuotaRequestService.createRequest({
        shardId: shard.id,
        desiredValue: 200,
        awsRequestId: 'req-1',
      });
      const at = new Date('2026-10-24T11:00:00.000Z');
      const read = await fleetQuotaRequestService.recordRead(
        request.id,
        { status, grantedValue: status === 'approved' ? 200 : null },
        () => at,
      );
      expect(read.status).toBe(status);
      expect(read.closedAt).toBe(at.toISOString());
      expect(await fleetQuotaRequestService.listOpen({ shardId: shard.id })).toEqual([]);
      expect((await fleetQuotaRequestService.listByShard(shard.id)).map((r) => r.id)).toEqual([
        request.id,
      ]);
    },
  );

  it('an approved read records the granted value', async () => {
    const shard = await awsAccount(1);
    const request = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    const read = await fleetQuotaRequestService.recordRead(request.id, {
      status: 'approved',
      grantedValue: 192,
    });
    expect(read.grantedValue).toBe(192);
  });

  it('a status outside the seven is refused and nothing is written', async () => {
    expect(FLEET_QUOTA_REQUEST_STATUSES).toHaveLength(7);
    const shard = await awsAccount(1);
    const request = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    await expect(
      fleetQuotaRequestService.recordRead(request.id, { status: 'APPROVED', grantedValue: 200 }),
    ).rejects.toBeInstanceOf(FleetPoolValueInvalidError);
    expect(await fleetQuotaRequestService.getRequest(request.id)).toEqual(request);
  });

  it('once closed, a new request for the same quota may be filed', async () => {
    const shard = await awsAccount(1);
    const first = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    await fleetQuotaRequestService.recordRead(first.id, { status: 'denied', grantedValue: null });
    const second = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 400,
      awsRequestId: 'req-2',
    });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
  });
});

describe('a growth event', () => {
  it('stores kind, triggering account, use, granted quota and outcome; listed newest first', async () => {
    const shard = await awsAccount(1);
    const first = await fleetGrowthEventService.recordEvent({
      fleetKind: 'ci_runner',
      triggeringShardId: shard.id,
      vcpuInUse: 45,
      grantedQuota: 64,
      outcome: 'waiting_for_quota',
    });
    const second = await fleetGrowthEventService.recordEvent({
      fleetKind: 'ci_runner',
      triggeringShardId: shard.id,
      vcpuInUse: 50,
      grantedQuota: 64,
      outcome: 'refused',
      reason: 'ConstraintViolationException: account limit reached',
    });
    await fleetGrowthEventService.recordEvent({
      fleetKind: 'hosted_agent',
      triggeringShardId: null,
      vcpuInUse: 1,
      grantedQuota: 32,
      outcome: 'refused',
    });

    const listed = await fleetGrowthEventService.listByKind('ci_runner');
    expect(listed.map((e) => e.id)).toEqual([second.id, first.id]);
    expect(listed[0]).toMatchObject({
      fleetKind: 'ci_runner',
      triggeringShardId: shard.id,
      vcpuInUse: 50,
      grantedQuota: 64,
      outcome: 'refused',
      reason: 'ConstraintViolationException: account limit reached',
    });
  });

  it('refuses an outcome outside the four, and an unknown kind, writing nothing', async () => {
    await expect(
      fleetGrowthEventService.recordEvent({
        fleetKind: 'ci_runner',
        triggeringShardId: null,
        vcpuInUse: 1,
        grantedQuota: 1,
        outcome: 'grown',
      }),
    ).rejects.toBeInstanceOf(FleetPoolValueInvalidError);
    await expect(
      fleetGrowthEventService.recordEvent({
        fleetKind: 'gpu_burst',
        triggeringShardId: null,
        vcpuInUse: 1,
        grantedQuota: 1,
        outcome: 'refused',
      }),
    ).rejects.toBeInstanceOf(FleetPoolValueInvalidError);
    expect(await adminDb.fleetGrowthEvent.count()).toBe(0);
  });
});

describe('the in-flight query', () => {
  it('is false for a kind with no events, or only refused ones', async () => {
    expect(await fleetGrowthEventService.hasUnfinishedGrowth('ci_runner')).toBe(false);
    await fleetGrowthEventService.recordEvent({
      fleetKind: 'ci_runner',
      triggeringShardId: null,
      vcpuInUse: 50,
      grantedQuota: 64,
      outcome: 'refused',
    });
    expect(await fleetGrowthEventService.hasUnfinishedGrowth('ci_runner')).toBe(false);
  });

  it.each(['spare_promoted', 'account_created', 'waiting_for_quota'] as const)(
    'a %s growth is in flight while its new account’s request is open, and not once it closes',
    async (outcome) => {
      const trigger = await awsAccount(1);
      const fresh = await awsAccount(2, { role: 'spare', state: 'provisioning' });
      const request = await fleetQuotaRequestService.createRequest({
        shardId: fresh.id,
        desiredValue: 200,
        awsRequestId: 'req-new',
      });
      await fleetGrowthEventService.recordEvent({
        fleetKind: 'ci_runner',
        triggeringShardId: trigger.id,
        vcpuInUse: 45,
        grantedQuota: 64,
        outcome,
        newShardId: fresh.id,
        quotaRequestId: request.id,
      });

      expect(await fleetGrowthEventService.hasUnfinishedGrowth('ci_runner')).toBe(true);
      expect(await fleetGrowthEventService.hasUnfinishedGrowth('hosted_agent')).toBe(false);

      await fleetQuotaRequestService.recordRead(request.id, {
        status: 'approved',
        grantedValue: 200,
      });
      expect(await fleetGrowthEventService.hasUnfinishedGrowth('ci_runner')).toBe(false);
    },
  );

  it('a refused growth is never in flight, even with an open request beside it', async () => {
    const trigger = await awsAccount(1);
    const request = await fleetQuotaRequestService.createRequest({
      shardId: trigger.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    await fleetGrowthEventService.recordEvent({
      fleetKind: 'ci_runner',
      triggeringShardId: trigger.id,
      vcpuInUse: 45,
      grantedQuota: 64,
      outcome: 'refused',
      quotaRequestId: request.id,
    });
    expect(await fleetGrowthEventService.hasUnfinishedGrowth('ci_runner')).toBe(false);
  });
});

describe('no credential reaches either record', () => {
  it('neither DTO has a credential or secret field', async () => {
    const shard = await awsAccount(1);
    const request = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    const event = await fleetGrowthEventService.recordEvent({
      fleetKind: 'ci_runner',
      triggeringShardId: shard.id,
      vcpuInUse: 1,
      grantedQuota: 64,
      outcome: 'refused',
      reason: 'AccessDenied',
    });
    for (const dto of [request, event]) {
      for (const key of Object.keys(dto)) {
        expect(key).not.toMatch(/credential|secret|token|password|key/i);
      }
    }
    for (const column of [
      ...Object.keys(await adminDb.fleetQuotaRequest.findFirstOrThrow()),
      ...Object.keys(await adminDb.fleetGrowthEvent.findFirstOrThrow()),
    ]) {
      expect(column).not.toMatch(/credential|secret|token|password/i);
    }
  });

  it('both tables are platform-only', async () => {
    const shard = await awsAccount(1);
    await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      desiredValue: 200,
      awsRequestId: 'req-1',
    });
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return [await tx.fleetQuotaRequest.findMany(), await tx.fleetGrowthEvent.findMany()];
    });
    expect(seen).toEqual([[], []]);
  });
});
