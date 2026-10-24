import { AwsManagementApiError } from '@motir/orchestrator';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  FleetQuotaRequestOpenError,
  QuotaRaiseFilingFailedError,
  QuotaRaiseRefusedError,
  QuotaRequestReadFailedError,
} from '@/lib/ciFleet/errors';
import {
  fleetQuotaRaiseService,
  quotaRequestStatusOf,
  type FleetQuotaRaiseDeps,
  type QuotaRequestRefresh,
} from '@/lib/services/fleetQuotaRaiseService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardService, type CreateFleetShardInput } from '@/lib/services/fleetShardService';
import { adminDb } from '../helpers/adminDb';
import { FakeOrganization } from '../helpers/addShardFakes';

// THE FLEET'S OWN QUOTA RAISES (Story MOTIR-9362 · MOTIR-9459), against real
// Postgres and a fake AWS organization: file once, idempotently; refuse a raise
// that is not one; refresh each open request until AWS closes it, writing an
// approved grant to the account's row; one failure never stops the others.

const SESSION = {
  accessKeyId: 'ASIAFAKEMEMBER',
  secretAccessKey: 'member-secret-do-not-print',
  sessionToken: 'member-session-token-do-not-print',
  expiration: null,
};
const AT = new Date('2026-10-24T15:00:00.000Z');

let org: FakeOrganization;
const deps = (): FleetQuotaRaiseDeps => ({ management: () => org, now: () => AT });

let seq = 0;
function awsAccount(overrides: Partial<CreateFleetShardInput> = {}) {
  seq += 1;
  return fleetShardService.createShard({
    name: `raise-test-${seq}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    state: 'active',
    githubOrg: `motir-raise-${seq}`,
    githubInstallationId: `${8000 + seq}`,
    awsAccountId: `33334444${String(seq).padStart(4, '0')}`,
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_AWS_TEST',
    limits: { vcpuQuota: 64, githubApiPerHour: 15000 },
    limitsSource: { vcpuQuota: 'provider_read', githubApiPerHour: 'documented' },
    ...overrides,
  });
}

const ok = (r: QuotaRequestRefresh) => ('failure' in r ? null : r);

beforeEach(async () => {
  await adminDb.fleetGrowthEvent.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  org = new FakeOrganization(SESSION);
});

afterAll(async () => {
  await adminDb.fleetShard.deleteMany({});
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('fileRaise', () => {
  it('calls AWS once and stores the request with its AWS id, pending', async () => {
    const shard = await awsAccount();
    const request = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());
    expect(request).toMatchObject({
      shardId: shard.id,
      quotaCode: 'L-1216C47A',
      desiredValue: 200,
      awsRequestId: 'quota-req-1',
      status: 'pending',
    });
    expect(org.calls.filter((c) => c.startsWith('requestVcpuQuotaIncrease'))).toEqual([
      `requestVcpuQuotaIncrease:${shard.aws!.accountId}:200`,
    ]);
  });

  it('again for the same account and value answers the open request with no AWS call', async () => {
    const shard = await awsAccount();
    const first = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());
    const callsBefore = org.calls.length;
    const again = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());
    expect(again.id).toBe(first.id);
    expect(org.calls.length).toBe(callsBefore);
  });

  it('another value while one is open is refused before AWS', async () => {
    const shard = await awsAccount();
    await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());
    const callsBefore = org.calls.length;
    await expect(fleetQuotaRaiseService.fileRaise(shard.id, 400, deps())).rejects.toBeInstanceOf(
      FleetQuotaRequestOpenError,
    );
    expect(org.calls.length).toBe(callsBefore);
  });

  it('a desired value not above the granted quota is refused and files nothing', async () => {
    const shard = await awsAccount();
    for (const desired of [64, 32]) {
      await expect(
        fleetQuotaRaiseService.fileRaise(shard.id, desired, deps()),
      ).rejects.toBeInstanceOf(QuotaRaiseRefusedError);
    }
    expect(org.quotaRequests.size).toBe(0);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(0);
  });

  it('works for a provisioning spare with no quota recorded yet', async () => {
    const spare = await awsAccount({ role: 'spare', state: 'provisioning', limits: {} });
    const request = await fleetQuotaRaiseService.fileRaise(spare.id, 200, deps());
    expect(request).toMatchObject({ shardId: spare.id, status: 'pending' });
  });

  it('adopts the open AWS request when an earlier filing was accepted but never stored', async () => {
    const shard = await awsAccount();
    org.quotaRequests.set('quota-req-orphan', {
      accountId: shard.aws!.accountId,
      status: 'CASE_OPENED',
      desiredValue: 200,
    });
    const request = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());
    expect(request).toMatchObject({ awsRequestId: 'quota-req-orphan', status: 'case_opened' });
  });

  it('an AWS refusal is a typed failure with AWS’s code and stores nothing', async () => {
    const shard = await awsAccount();
    org.requestFailure = new AwsManagementApiError('service-quotas', 'QuotaExceededException', 400);
    const err = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps()).catch((e) => e);
    expect(err).toBeInstanceOf(QuotaRaiseFilingFailedError);
    expect(err).toMatchObject({ shardId: shard.id, reason: 'QuotaExceededException' });
    expect(await adminDb.fleetQuotaRequest.count()).toBe(0);
  });
});

describe('refreshOpenRequests', () => {
  it('stores each read; an approved one closes and writes its grant to the row once', async () => {
    const shard = await awsAccount();
    const request = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());

    let [read] = await fleetQuotaRaiseService.refreshOpenRequests(undefined, deps());
    expect(ok(read!)).toMatchObject({ status: 'pending', closed: false, grantedValue: null });

    org.settleQuotaRequest(request.awsRequestId, 'CASE_OPENED');
    [read] = await fleetQuotaRaiseService.refreshOpenRequests('ci_runner', deps());
    expect(ok(read!)).toMatchObject({ status: 'case_opened', closed: false });

    org.settleQuotaRequest(request.awsRequestId, 'APPROVED', 192);
    [read] = await fleetQuotaRaiseService.refreshOpenRequests('ci_runner', deps());
    expect(ok(read!)).toMatchObject({ status: 'approved', grantedValue: 192, closed: true });

    const stored = await fleetQuotaRequestService.getRequest(request.id);
    expect(stored).toMatchObject({
      status: 'approved',
      grantedValue: 192,
      lastReadAt: AT.toISOString(),
      closedAt: AT.toISOString(),
    });
    const row = await fleetShardService.getShard(shard.id);
    expect(row.limits).toMatchObject({ vcpuQuota: 192, githubApiPerHour: 15000 });
    expect(row.limitsSource).toEqual({ vcpuQuota: 'raised', githubApiPerHour: 'documented' });

    expect(await fleetQuotaRaiseService.refreshOpenRequests(undefined, deps())).toEqual([]);
  });

  it.each(['DENIED', 'NOT_APPROVED', 'CASE_CLOSED', 'INVALID_REQUEST'])(
    'a %s request closes and leaves the account’s quota as it was',
    async (awsStatus) => {
      const shard = await awsAccount();
      const request = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());
      org.settleQuotaRequest(request.awsRequestId, awsStatus);

      const [read] = await fleetQuotaRaiseService.refreshOpenRequests(undefined, deps());

      expect(ok(read!)).toMatchObject({ status: quotaRequestStatusOf(awsStatus), closed: true });
      expect((await fleetShardService.getShard(shard.id)).limits.vcpuQuota).toBe(64);
      expect(await fleetQuotaRequestService.listOpen()).toEqual([]);
    },
  );

  it('a failed read is a typed failure, leaves that request, and the others are read', async () => {
    const broken = await awsAccount();
    const fine = await awsAccount();
    const brokenRequest = await fleetQuotaRaiseService.fileRaise(broken.id, 200, deps());
    const fineRequest = await fleetQuotaRaiseService.fileRaise(fine.id, 300, deps());
    org.requestReadFailures.set(
      brokenRequest.awsRequestId,
      new AwsManagementApiError('service-quotas', 'TooManyRequestsException', 429),
    );
    org.settleQuotaRequest(fineRequest.awsRequestId, 'APPROVED');

    const results = await fleetQuotaRaiseService.refreshOpenRequests(undefined, deps());

    const failed = results.find((r) => r.requestId === brokenRequest.id)!;
    expect('failure' in failed && failed.failure).toBeInstanceOf(QuotaRequestReadFailedError);
    expect('failure' in failed && failed.failure).toMatchObject({
      shardId: broken.id,
      reason: 'TooManyRequestsException',
    });
    expect(await fleetQuotaRequestService.getRequest(brokenRequest.id)).toEqual(brokenRequest);
    expect(ok(results.find((r) => r.requestId === fineRequest.id)!)).toMatchObject({
      status: 'approved',
      grantedValue: 300,
    });
  });

  it('an AWS status outside the seven is refused and nothing is written for it', async () => {
    const shard = await awsAccount();
    const request = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());
    org.settleQuotaRequest(request.awsRequestId, 'ESCALATED');

    const [read] = await fleetQuotaRaiseService.refreshOpenRequests(undefined, deps());

    expect('failure' in read! && read.failure.reason).toBe('UnknownStatus:ESCALATED');
    expect(await fleetQuotaRequestService.getRequest(request.id)).toEqual(request);
  });

  it('no credential or session token appears in a result or a failure', async () => {
    const shard = await awsAccount();
    const request = await fleetQuotaRaiseService.fileRaise(shard.id, 200, deps());
    org.requestReadFailures.set(request.awsRequestId, new Error(SESSION.sessionToken));
    const results = await fleetQuotaRaiseService.refreshOpenRequests(undefined, deps());
    const printed = JSON.stringify(results, (_k, v: unknown) =>
      v instanceof Error ? { message: v.message, ...v } : v,
    );
    for (const secret of Object.values(SESSION).filter((v): v is string => !!v)) {
      expect(printed).not.toContain(secret);
    }
  });
});
