import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  FleetCapacityRequestLinkMismatchError,
  FleetCapacityRequestNotOwnedError,
  FleetCapacityRequestOpenError,
  FleetCapacityRequestStateError,
  FleetPoolValueInvalidError,
} from '@/lib/ciFleet/errors';
import { platformPrincipalForStaffEmail, type PlatformPrincipal } from '@/lib/platform/auth';
import {
  fleetCapacityRequestService,
  type FleetCapacityRequestInput,
} from '@/lib/services/fleetCapacityRequestService';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { usersService } from '@/lib/services/usersService';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A HOST ORGANISATION'S CAPACITY REQUESTS (Story MOTIR-9365 · MOTIR-9583), on
// the real database: the record, its one-active-per-AWS-account rule across a
// merged account's two rows, the ownership check, the link to a quota request
// whose status and granted value the DTO reads at read time, and the
// `fleet-admin` commands with their audit entries.

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);

const NOW = new Date('2026-10-25T12:00:00Z');
const MERGED_ACCOUNT = '400000000003';

let operator: PlatformPrincipal;
let operatorEmail: string;
let userId: string;
let orgId: string;
let otherOrgId: string;
let ids: { ci: string; index: string; hoster: string; shared: string; other: string };

let orgSeq = 0;
async function seedOrg(): Promise<string> {
  orgSeq += 1;
  const org = await adminDb.organization.create({
    data: { name: `Host ${orgSeq}`, slug: `capacity-org-${orgSeq}-${Date.now()}` },
  });
  return org.id;
}

async function account(
  name: string,
  fleetKind: string,
  awsAccountId: string,
  owner: string | null,
  granted: number | null = 32,
) {
  return fleetShardService.createShard({
    name,
    fleetKind,
    provider: 'aws',
    role: owner ? 'org_owned' : 'primary',
    ownerOrganizationId: owner,
    state: 'active',
    githubOrg: 'motir-fleet-use1-1',
    githubInstallationId: '9001',
    awsAccountId,
    awsRegion: 'us-east-1',
    credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
    limits: granted === null ? {} : { vcpuQuota: granted },
  });
}

const ask = (over: Partial<FleetCapacityRequestInput> = {}): FleetCapacityRequestInput => ({
  organizationId: orgId,
  userId,
  shardId: ids.index,
  fleetKind: 'code_graph_index',
  desiredVcpu: 240,
  reason: 'We index forty repositories and the queue backs up every morning.',
  ...over,
});

async function quotaRequestOn(shardId: string, awsRequestId = 'quota-req-1') {
  return fleetQuotaRequestService.createRequest({ shardId, desiredValue: 240, awsRequestId });
}

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin(argv, {
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeEach(async () => {
  await truncateAuthTables();
  sentry.captureException.mockReset();
  const user = await usersService.createUser({
    email: 'fleet-capacity-operator@example.com',
    password: 'hunter2hunter2',
    name: 'Operator',
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'superadmin' } });
  operatorEmail = user.email;
  operator = await platformPrincipalForStaffEmail(operatorEmail, 'superadmin');
  userId = user.id;
  orgId = await seedOrg();
  otherOrgId = await seedOrg();
  const ci = await account('host-a-ci', 'ci_runner', '400000000001', orgId, 200);
  const index = await account('host-a-index', 'code_graph_index', MERGED_ACCOUNT, orgId, 120);
  const hoster = await account('host-a-agent-host', 'agent_instance', MERGED_ACCOUNT, orgId, 120);
  const shared = await account('ci-runner-use1-1', 'ci_runner', '111122223333', null, 640);
  const other = await account('host-b-ci', 'ci_runner', '400000000009', otherOrgId, 200);
  ids = { ci: ci.id, index: index.id, hoster: hoster.id, shared: shared.id, other: other.id };
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('request', () => {
  it('stores one open record and returns its DTO with no outcome', async () => {
    const dto = await fleetCapacityRequestService.request(ask(), () => NOW);

    expect(dto).toMatchObject({
      organizationId: orgId,
      shardId: ids.index,
      awsAccountId: MERGED_ACCOUNT,
      fleetKind: 'code_graph_index',
      quotaCode: 'L-1216C47A',
      desiredVcpu: 240,
      status: 'open',
      requestedByUserId: userId,
      createdAt: NOW.toISOString(),
      outcome: null,
    });
    expect(dto.reasonMd).toContain('forty repositories');
    expect(await adminDb.fleetCapacityRequest.count()).toBe(1);
  });

  it('refuses another organisation’s account, a shared account and an unknown one, writing nothing', async () => {
    for (const shardId of [ids.other, ids.shared, 'no-such-shard']) {
      await expect(
        fleetCapacityRequestService.request(ask({ shardId, fleetKind: 'ci_runner' })),
      ).rejects.toBeInstanceOf(FleetCapacityRequestNotOwnedError);
    }
    expect(await adminDb.fleetCapacityRequest.count()).toBe(0);
  });

  it('refuses a bad figure, a figure not above the granted one, an empty reason and a foreign kind', async () => {
    for (const desiredVcpu of [0, -5, 12.5, 120, 100]) {
      await expect(
        fleetCapacityRequestService.request(ask({ desiredVcpu })),
      ).rejects.toBeInstanceOf(FleetPoolValueInvalidError);
    }
    await expect(fleetCapacityRequestService.request(ask({ reason: '   ' }))).rejects.toMatchObject(
      {
        field: 'reason',
      },
    );
    await expect(
      fleetCapacityRequestService.request(ask({ fleetKind: 'ci_runner' })),
    ).rejects.toMatchObject({ field: 'fleetKind' });
    expect(await adminDb.fleetCapacityRequest.count()).toBe(0);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('answers the active request for the same figure across both merged kinds, and refuses another figure', async () => {
    const first = await fleetCapacityRequestService.request(ask());
    const viaHoster = await fleetCapacityRequestService.request(
      ask({ shardId: ids.hoster, fleetKind: 'agent_instance' }),
    );

    expect(viaHoster.id).toBe(first.id);
    await expect(
      fleetCapacityRequestService.request(
        ask({ shardId: ids.hoster, fleetKind: 'agent_instance', desiredVcpu: 300 }),
      ),
    ).rejects.toBeInstanceOf(FleetCapacityRequestOpenError);
    expect(await adminDb.fleetCapacityRequest.count()).toBe(1);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('two racing asks for one account leave one record', async () => {
    const results = await Promise.allSettled([
      fleetCapacityRequestService.request(ask()),
      fleetCapacityRequestService.request(
        ask({ shardId: ids.hoster, fleetKind: 'agent_instance' }),
      ),
      fleetCapacityRequestService.request(ask()),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(3);
    expect(
      new Set(ok.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id)).size,
    ).toBe(1);
    expect(await adminDb.fleetCapacityRequest.count()).toBe(1);
  });

  it('alerts the platform admin once, per request, with ids only in tags', async () => {
    const dto = await fleetCapacityRequestService.request(ask());

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, context] = sentry.captureException.mock.calls[0]!;
    expect(error.name).toBe('FleetCapacityRequestedError');
    expect(context.fingerprint).toEqual(['fleet-capacity-request', dto.id]);
    expect(context.tags).toMatchObject({
      organization_id: orgId,
      fleet_kind: 'code_graph_index',
      aws_account_id: MERGED_ACCOUNT,
    });
    expect(String(error.message)).toContain(dto.id);
    expect(JSON.stringify(context.tags)).not.toContain('forty repositories');
  });

  it('a failing alert does not fail or roll back the request', async () => {
    sentry.captureException.mockImplementation(() => {
      throw new Error('sentry down');
    });

    const dto = await fleetCapacityRequestService.request(ask());

    expect(dto.status).toBe('open');
    expect(await adminDb.fleetCapacityRequest.count()).toBe(1);
  });
});

describe('linkQuotaRequest and close', () => {
  it('files the request, and its outcome follows later reads of the quota request', async () => {
    const request = await fleetCapacityRequestService.request(ask());
    // A raise filed on the merged account's OTHER row links all the same.
    const quota = await quotaRequestOn(ids.hoster);

    const linked = await fleetCapacityRequestService.linkQuotaRequest(
      { requestId: request.id, quotaRequestId: quota.id },
      operator,
      () => NOW,
    );
    expect(linked).toMatchObject({
      status: 'filed',
      filedAt: NOW.toISOString(),
      outcome: { quotaRequestId: quota.id, status: 'pending', grantedValue: null },
    });

    const before = await adminDb.fleetCapacityRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    await fleetQuotaRequestService.recordRead(quota.id, { status: 'approved', grantedValue: 240 });
    const [read] = await fleetCapacityRequestService.listForOrganization(orgId);
    expect(read!.outcome).toMatchObject({ status: 'approved', grantedValue: 240 });
    const after = await adminDb.fleetCapacityRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('refuses a quota request on another AWS account, and any link on a closed request', async () => {
    const request = await fleetCapacityRequestService.request(ask());
    const elsewhere = await quotaRequestOn(ids.ci);

    await expect(
      fleetCapacityRequestService.linkQuotaRequest(
        { requestId: request.id, quotaRequestId: elsewhere.id },
        operator,
      ),
    ).rejects.toBeInstanceOf(FleetCapacityRequestLinkMismatchError);

    await fleetCapacityRequestService.close({ requestId: request.id, note: 'Declined' }, operator);
    const quota = await quotaRequestOn(ids.index, 'quota-req-2');
    await expect(
      fleetCapacityRequestService.linkQuotaRequest(
        { requestId: request.id, quotaRequestId: quota.id },
        operator,
      ),
    ).rejects.toBeInstanceOf(FleetCapacityRequestStateError);
  });

  it('close marks it closed with the note and frees the account for a new request', async () => {
    const first = await fleetCapacityRequestService.request(ask());
    const closed = await fleetCapacityRequestService.close(
      { requestId: first.id, note: 'Withdrawn by the organisation' },
      operator,
      () => NOW,
    );
    expect(closed).toMatchObject({
      status: 'closed',
      closedNote: 'Withdrawn by the organisation',
      closedAt: NOW.toISOString(),
    });
    await expect(
      fleetCapacityRequestService.close({ requestId: first.id, note: 'again' }, operator),
    ).rejects.toBeInstanceOf(FleetCapacityRequestStateError);

    const second = await fleetCapacityRequestService.request(ask({ desiredVcpu: 300 }));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('open');
  });

  it('the database holds the invariants a direct write could break', async () => {
    const request = await fleetCapacityRequestService.request(ask());
    await expect(
      adminDb.fleetCapacityRequest.update({ where: { id: request.id }, data: { status: 'filed' } }),
    ).rejects.toThrow(/fleet_capacity_request_filed_check/);
    await expect(
      adminDb.fleetCapacityRequest.create({
        data: {
          organizationId: orgId,
          shardId: ids.hoster,
          awsAccountId: MERGED_ACCOUNT,
          fleetKind: 'agent_instance',
          desiredVcpu: 999,
          reasonMd: 'x',
          requestedByUserId: userId,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('fleet-admin capacity-requests, capacity-request-link, capacity-request-close', () => {
  it('list, link and close print ids and figures, and write one audit entry each', async () => {
    const request = await fleetCapacityRequestService.request(ask());
    const quota = await quotaRequestOn(ids.index);

    const listed = await run('capacity-requests', '--operator', operatorEmail);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(request.id);
    expect(listed.out).toContain(`account ${MERGED_ACCOUNT}  code_graph_index`);
    expect(listed.out).toContain('240 vCPU  open');

    const linked = await run(
      'capacity-request-link',
      request.id,
      quota.id,
      '--operator',
      operatorEmail,
    );
    expect(linked.code).toBe(0);
    expect(linked.out).toContain(`filed`);
    expect(linked.out).toContain(`quota request ${quota.id} pending`);

    const closed = await run(
      'capacity-request-close',
      request.id,
      'AWS',
      'declined',
      '--operator',
      operatorEmail,
    );
    expect(closed.code).toBe(0);
    expect(closed.out).toContain('closed');

    const audits = await adminDb.platformAuditLog.findMany({
      where: { action: { startsWith: 'fleet.capacity_request.' } },
      orderBy: { seq: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'fleet.capacity_request.list',
      'fleet.capacity_request.link',
      'fleet.capacity_request.close',
    ]);
    expect(audits[2]!.reason).toBe('AWS declined');
    const printed = JSON.stringify([listed, linked, closed, audits]);
    expect(printed).not.toContain('forty repositories');
    expect(printed).not.toContain('@motir.co');
    expect(printed).not.toMatch(/FLEET_SHARD_[A-Z_]+=/);
  });

  it('refuses an operator who is not a superadmin', async () => {
    const result = await run('capacity-requests', '--operator', 'nobody@example.com');
    expect(result.code).toBe(1);
    expect(result.err).toContain('is not a superadmin');
  });
});
