import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AwsManagementApi,
  AwsQuotaRef,
  AwsQuotaStatus,
  AwsSessionCredentials,
} from '@motir/orchestrator';
import type { PlatformRole } from '@/generated/prisma/client';
import { TENANT_QUOTA_TARGETS, tenantAccountName } from '@/lib/ciFleet/hostingTenantAccounts';
import type {
  TenantAccountDTO,
  TenantAccountsBlockDTO,
  TenantQuotaDTO,
} from '@/lib/dto/fleetStatusTenantAccounts';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET STATUS PAGE'S TENANT HOSTING ACCOUNTS READ (MOTIR-12014; design
// MOTIR-12013) against a REAL Postgres: the `hosting_tenant_account` rows, their
// organisations, the `platform_aws_read` marks and the `fleet.status.read` audit
// row are real. Faked: the platform session gate and the AWS management port (a
// test double passed in, answering per account and quota).

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const {
  fleetStatusTenantAccountsService: service,
  judgeTenantQuota,
  orderTenantAccounts,
  pageTenantAccounts,
  tenantAccountRank,
  tenantQuotaSubject,
  TENANT_ACCOUNTS_PAGE_SIZE,
} = await import('@/lib/services/fleetStatusTenantAccountsService');

const NOW = new Date('2026-11-22T14:00:00.000Z');
const HOUR = 3_600_000;
const earlier = (ms: number) => new Date(NOW.getTime() - ms);
const [FARGATE, LAMBDA] = TENANT_QUOTA_TARGETS as [
  (typeof TENANT_QUOTA_TARGETS)[number],
  (typeof TENANT_QUOTA_TARGETS)[number],
];
const SECRET = 'SECRET-ACCESS-KEY-NEVER-LOGGED';
let seq = 0;

/** What the fake AWS answers for one account: per quota code, a status or an error. */
type AccountAnswer = { session: 'fails' } | Record<string, AwsQuotaStatus | Error | undefined>;

function fakeManagement(answers: Record<string, AccountAnswer>) {
  let inFlight = 0;
  let peak = 0;
  const regions: string[] = [];
  const api = {
    async assumeMemberRole(accountId: string): Promise<AwsSessionCredentials> {
      const answer = answers[accountId];
      if (!answer || 'session' in answer) {
        throw Object.assign(new Error(`arn:aws:iam::${accountId}:role/x denied ${SECRET}`), {
          name: 'AccessDenied',
        });
      }
      return {
        accessKeyId: accountId,
        secretAccessKey: SECRET,
        sessionToken: 't',
        expiration: null,
      };
    },
    async readQuotaStatus(
      credentials: AwsSessionCredentials,
      region: string,
      quota: AwsQuotaRef,
    ): Promise<AwsQuotaStatus> {
      regions.push(region);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      const answer = (answers[credentials.accessKeyId] as Record<string, AwsQuotaStatus | Error>)[
        quota.quotaCode
      ];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error('no fake answer');
      return answer;
    },
  };
  return { api: api as unknown as AwsManagementApi, peak: () => peak, regions };
}

const atValue = (applied: number | null, openRaise: AwsQuotaStatus['openRaise'] = null) => ({
  applied,
  openRaise,
});

async function tenantAccount(
  organizationName: string,
  row: {
    state?: string;
    awsAccountId?: string | null;
    refusedCount?: number;
    lastRefusedAt?: Date | null;
  } = {},
) {
  seq += 1;
  const fx = await makeWorkItemFixture({ name: `Tenant ${seq}`, identifier: `TA${seq}` });
  const organizationId = fx.workspace.organizationId;
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { name: organizationName },
  });
  await adminDb.hostingTenantAccount.create({
    data: {
      organizationId,
      state: row.state ?? 'ready',
      awsAccountId: row.awsAccountId === undefined ? null : row.awsAccountId,
      refusedCount: row.refusedCount ?? 0,
      lastRefusedAt: row.lastRefusedAt ?? null,
      region: 'us-east-1',
    },
  });
  return { organizationId, accountName: tenantAccountName(organizationId) };
}

const ok = (block: TenantAccountsBlockDTO) => {
  if (block.status !== 'ok') throw new Error('the tenant accounts block did not read');
  return block;
};
const byOrg = (block: TenantAccountsBlockDTO, name: string) =>
  ok(block).accounts.find((a) => a.organizationName === name)!;
const audits = () =>
  adminDb.platformAuditLog.findMany({
    where: { action: 'fleet.status.read' },
    orderBy: { createdAt: 'asc' },
  });

const envRole = process.env.AWS_ORG_ADMIN_ROLE_ARN;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.hostingTenantAccount.deleteMany();
  await adminDb.platformAuditLog.deleteMany();
  await adminDb.platformAwsRead.deleteMany();
  const staff = await createTestUser({ email: `tenant-accounts-${seq++}@example.com` });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'superadmin' } });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'superadmin' };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (envRole === undefined) delete process.env.AWS_ORG_ADMIN_ROLE_ARN;
  else process.env.AWS_ORG_ADMIN_ROLE_ARN = envRole;
  vi.restoreAllMocks();
});

describe('fleetStatusTenantAccountsService.read', () => {
  it('answers an empty block when no tenant account exists, and audits the read', async () => {
    const { api } = fakeManagement({});
    const block = ok(await service.read(currentPrincipal, { now: NOW, management: api }));
    expect(block).toEqual({ status: 'ok', accounts: [], belowTargetCount: 0, notReadCount: 0 });
    const [audit] = await audits();
    expect(audit).toMatchObject({
      targetKind: 'platform',
      targetId: 'fleet_pools.tenant_accounts',
      metadata: { accounts: 0, quotasRead: 0, quotasNotRead: 0 },
    });
  });

  it('is superadmin only', async () => {
    currentPrincipal = { ...currentPrincipal, role: 'support' };
    await expect(service.read(currentPrincipal, { now: NOW })).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(await audits()).toHaveLength(0);
  });

  it('reads each ready account live, flags a missing raise, and orders what to act on first', async () => {
    const filed = earlier(5 * HOUR);
    const acme = await tenantAccount('Acme Robotics', { awsAccountId: '482915370264' });
    const moooon = await tenantAccount('moooon', { awsAccountId: '019602753597' });
    await tenantAccount('Initech', { awsAccountId: '160427395581' });
    await tenantAccount('Northwind Data', { awsAccountId: '735018462209' });
    await tenantAccount('Globex Platform', { state: 'requested' });
    await tenantAccount('Umbrella Labs', {
      state: 'refused',
      refusedCount: 3,
      lastRefusedAt: earlier(2 * HOUR),
    });
    // Initech answered three hours ago; this load its session fails.
    const initechFargate = tenantQuotaSubject('160427395581', FARGATE);
    await adminDb.platformAwsRead.create({
      data: { subject: initechFargate, accountId: '160427395581', readAt: earlier(3 * HOUR) },
    });

    const { api, regions } = fakeManagement({
      '482915370264': { [FARGATE.quotaCode]: atValue(64), [LAMBDA.quotaCode]: atValue(1000) },
      '019602753597': {
        [FARGATE.quotaCode]: atValue(6, {
          requestId: 'q-1',
          status: 'CASE_OPENED',
          desiredValue: 64,
          createdAt: filed,
        }),
        [LAMBDA.quotaCode]: atValue(10),
      },
      '160427395581': { session: 'fails' },
      // Lambda has no applied value in this account: Not read, never the default.
      '735018462209': { [FARGATE.quotaCode]: atValue(64), [LAMBDA.quotaCode]: atValue(null) },
    });

    const block = ok(await service.read(currentPrincipal, { now: NOW, management: api }));

    expect(block.accounts.map((a) => a.organizationName)).toEqual([
      'moooon',
      'Initech',
      'Northwind Data',
      'Umbrella Labs',
      'Acme Robotics',
      'Globex Platform',
    ]);
    expect(block.belowTargetCount).toBe(1);
    expect(block.notReadCount).toBe(2);
    expect(new Set(regions)).toEqual(new Set(['us-east-1']));

    // At target: both quotas read, no raise, no flag.
    expect(byOrg(block, 'Acme Robotics')).toMatchObject({
      accountName: acme.accountName,
      awsAccountId: '482915370264',
      state: 'ready',
      quotas: [
        {
          name: FARGATE.name,
          status: 'ok',
          applied: 64,
          target: 64,
          raise: null,
          belowTarget: false,
        },
        {
          name: LAMBDA.name,
          status: 'ok',
          applied: 1000,
          target: 1000,
          raise: null,
          belowTarget: false,
        },
      ],
    });
    // Below target with a raise open: not flagged. Below target with none: flagged.
    expect(byOrg(block, 'moooon')).toMatchObject({
      accountName: moooon.accountName,
      quotas: [
        {
          status: 'ok',
          applied: 6,
          belowTarget: false,
          raise: { status: 'case_opened', desiredValue: 64, createdAt: filed.toISOString() },
        },
        { status: 'ok', applied: 10, target: 1000, raise: null, belowTarget: true },
      ],
    });
    // The session failed: both quotas Not read, the one read before keeps its time.
    expect(byOrg(block, 'Initech').quotas).toEqual([
      expect.objectContaining({
        status: 'notRead',
        lastReadAt: earlier(3 * HOUR).toISOString(),
      }),
      expect.objectContaining({ status: 'notRead', lastReadAt: null }),
    ]);
    expect(byOrg(block, 'Northwind Data').quotas).toEqual([
      expect.objectContaining({ status: 'ok', applied: 64 }),
      expect.objectContaining({ status: 'notRead', lastReadAt: null }),
    ]);
    // Not ready: nothing read, the refusal carried.
    expect(byOrg(block, 'Globex Platform')).toMatchObject({
      state: 'requested',
      awsAccountId: null,
      quotas: [],
    });
    expect(byOrg(block, 'Umbrella Labs')).toMatchObject({
      state: 'refused',
      refusedCount: 3,
      lastRefusedAt: earlier(2 * HOUR).toISOString(),
      quotas: [],
    });

    // Every good read is marked, in its account; the unread one keeps its old time.
    const marks = await adminDb.platformAwsRead.findMany({ orderBy: { subject: 'asc' } });
    expect(marks.map((m) => [m.subject, m.accountId, m.readAt.toISOString()])).toEqual(
      [
        [tenantQuotaSubject('482915370264', FARGATE), '482915370264', NOW.toISOString()],
        [tenantQuotaSubject('482915370264', LAMBDA), '482915370264', NOW.toISOString()],
        [tenantQuotaSubject('019602753597', FARGATE), '019602753597', NOW.toISOString()],
        [tenantQuotaSubject('019602753597', LAMBDA), '019602753597', NOW.toISOString()],
        [initechFargate, '160427395581', earlier(3 * HOUR).toISOString()],
        [tenantQuotaSubject('735018462209', FARGATE), '735018462209', NOW.toISOString()],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
    const [audit] = await audits();
    expect(audit).toMatchObject({
      targetId: 'fleet_pools.tenant_accounts',
      metadata: { accounts: 6, quotasRead: 5, quotasNotRead: 3 },
    });
    // A failure is logged by its name only: no ARN, no secret.
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain('AccessDenied');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('arn:aws');
  });

  it('marks one quota Not read when only its own read fails', async () => {
    await tenantAccount('Hooli Cloud', { awsAccountId: '310000000001' });
    const { api } = fakeManagement({
      '310000000001': {
        [FARGATE.quotaCode]: atValue(64),
        [LAMBDA.quotaCode]: Object.assign(new Error('throttled'), { name: 'TooManyRequests' }),
      },
    });
    const account = byOrg(
      await service.read(currentPrincipal, { now: NOW, management: api }),
      'Hooli Cloud',
    );
    expect(account.quotas.map((q) => q.status)).toEqual(['ok', 'notRead']);
  });

  it('reads at most four accounts at once', async () => {
    const answers: Record<string, AccountAnswer> = {};
    for (let i = 0; i < 7; i += 1) {
      const id = `31000000010${i}`;
      await tenantAccount(`Org ${i}`, { awsAccountId: id });
      answers[id] = { [FARGATE.quotaCode]: atValue(64), [LAMBDA.quotaCode]: atValue(1000) };
    }
    const { api, peak } = fakeManagement(answers);
    const block = ok(await service.read(currentPrincipal, { now: NOW, management: api }));
    expect(block.accounts).toHaveLength(7);
    expect(block.accounts.every((a) => a.quotas.every((q) => q.status === 'ok'))).toBe(true);
    // Two quotas per account read together, four accounts at a time.
    expect(peak()).toBeLessThanOrEqual(8);
    expect(peak()).toBeGreaterThan(2);
  });

  it('shows every ready account Not read when the deployment has no management credential', async () => {
    delete process.env.AWS_ORG_ADMIN_ROLE_ARN;
    await tenantAccount('Pied Piper', { awsAccountId: '310000000002' });
    await tenantAccount('Fernwood IO', { state: 'creating', awsAccountId: '310000000003' });
    const block = ok(await service.read(currentPrincipal, { now: NOW }));
    expect(byOrg(block, 'Pied Piper').quotas.map((q) => q.status)).toEqual(['notRead', 'notRead']);
    expect(byOrg(block, 'Fernwood IO').quotas).toEqual([]);
    expect(block.notReadCount).toBe(1);
  });

  it('answers the whole block unavailable when the accounts cannot be listed', async () => {
    const { hostingTenantAccountRepository } =
      await import('@/lib/repositories/hostingTenantAccountRepository');
    vi.spyOn(hostingTenantAccountRepository, 'listAllWithOrganizationInTx').mockRejectedValueOnce(
      new Error('down'),
    );
    const { api } = fakeManagement({});
    expect(await service.read(currentPrincipal, { now: NOW, management: api })).toEqual({
      status: 'unavailable',
    });
  });

  it('answers unavailable, logging no reason it cannot name, when the audit write fails', async () => {
    const { platformAwsReadRepository } =
      await import('@/lib/repositories/platformAwsReadRepository');
    await tenantAccount('Kestrel Maps', { awsAccountId: '310000000005' });
    vi.spyOn(platformAwsReadRepository, 'markRead').mockRejectedValueOnce('not an error');
    const { api } = fakeManagement({
      '310000000005': { [FARGATE.quotaCode]: atValue(64), [LAMBDA.quotaCode]: atValue(1000) },
    });
    expect(await service.read(currentPrincipal, { now: NOW, management: api })).toEqual({
      status: 'unavailable',
    });
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      '[admin] fleet status tenant accounts read failed',
      { error: 'unknown' },
    );
  });
});

describe('judgeTenantQuota', () => {
  const fulfilled = (value: AwsQuotaStatus): PromiseSettledResult<AwsQuotaStatus> => ({
    status: 'fulfilled',
    value,
  });

  it('maps PENDING with no filing time, and treats a closed status as no open raise', () => {
    expect(
      judgeTenantQuota(
        LAMBDA,
        fulfilled(
          atValue(10, { requestId: 'r', status: 'PENDING', desiredValue: null, createdAt: null }),
        ),
        null,
      ),
    ).toMatchObject({
      raise: { status: 'pending', desiredValue: null, createdAt: null },
      belowTarget: false,
    });
    expect(
      judgeTenantQuota(
        LAMBDA,
        fulfilled(
          atValue(10, { requestId: 'r', status: 'APPROVED', desiredValue: 1000, createdAt: null }),
        ),
        null,
      ),
    ).toMatchObject({ raise: null, belowTarget: true });
  });

  it('never flags a quota at or above target, raise or not', () => {
    expect(judgeTenantQuota(FARGATE, fulfilled(atValue(128)), null)).toMatchObject({
      status: 'ok',
      belowTarget: false,
    });
  });

  it('is Not read for a rejected read, with the last good read time', () => {
    const at = earlier(HOUR);
    expect(judgeTenantQuota(FARGATE, { status: 'rejected', reason: new Error('x') }, at)).toEqual({
      name: FARGATE.name,
      serviceCode: 'fargate',
      quotaCode: 'L-3032A538',
      target: 64,
      status: 'notRead',
      lastReadAt: at.toISOString(),
    });
  });
});

describe('ordering and paging', () => {
  const quota = (
    over: Partial<Extract<TenantQuotaDTO, { status: 'ok' }>> = {},
  ): TenantQuotaDTO => ({
    name: LAMBDA.name,
    serviceCode: 'lambda',
    quotaCode: 'L-B99A9384',
    target: 1000,
    status: 'ok',
    applied: 1000,
    raise: null,
    belowTarget: false,
    ...over,
  });
  const account = (
    organizationName: string,
    over: Partial<TenantAccountDTO> = {},
  ): TenantAccountDTO => ({
    organizationName,
    accountName: `tenant-${organizationName.toLowerCase().replace(/\W/g, '')}`,
    awsAccountId: '310000000000',
    state: 'ready',
    refusedCount: 0,
    lastRefusedAt: null,
    quotas: [quota()],
    ...over,
  });

  it('ranks below target, then not read, then refused, then the rest', () => {
    expect(
      tenantAccountRank(account('a', { quotas: [quota({ applied: 10, belowTarget: true })] })),
    ).toBe(0);
    expect(
      tenantAccountRank(
        account('b', {
          quotas: [{ ...quota(), status: 'notRead', lastReadAt: null } as TenantQuotaDTO],
        }),
      ),
    ).toBe(1);
    expect(tenantAccountRank(account('c', { state: 'refused', quotas: [] }))).toBe(2);
    expect(tenantAccountRank(account('d'))).toBe(3);
  });

  it('breaks a tie on the organisation name by the account name', () => {
    const ordered = orderTenantAccounts([
      account('Same', { accountName: 'tenant-b' }),
      account('Same', { accountName: 'tenant-a' }),
    ]);
    expect(ordered.map((a) => a.accountName)).toEqual(['tenant-a', 'tenant-b']);
  });

  const many = Array.from({ length: 25 }, (_, i) =>
    account(`Org ${String(i).padStart(2, '0')}`, {
      awsAccountId: `3100000000${String(i).padStart(2, '0')}`,
    }),
  );

  it('pages ten at a time, clamping a page past the last and reading junk as page 1', () => {
    expect(TENANT_ACCOUNTS_PAGE_SIZE).toBe(10);
    expect(pageTenantAccounts(many, {})).toMatchObject({
      page: 1,
      pageCount: 3,
      total: 25,
      from: 1,
      to: 10,
      query: '',
    });
    const last = pageTenantAccounts(many, { page: '9' });
    expect(last).toMatchObject({ page: 3, from: 21, to: 25 });
    expect(last.accounts).toHaveLength(5);
    expect(pageTenantAccounts(many, { page: 'abc' }).page).toBe(1);
    expect(pageTenantAccounts(many, { page: -2 }).page).toBe(1);
    expect(pageTenantAccounts(many, { page: null, query: null }).page).toBe(1);
  });

  it('searches the organisation name, the AWS account id and the account name, ignoring case', () => {
    expect(
      pageTenantAccounts(many, { query: '  org 07 ' }).accounts.map((a) => a.organizationName),
    ).toEqual(['Org 07']);
    expect(pageTenantAccounts(many, { query: '310000000012' }).accounts[0]!.organizationName).toBe(
      'Org 12',
    );
    expect(pageTenantAccounts(many, { query: 'TENANT-ORG24' }).accounts[0]!.organizationName).toBe(
      'Org 24',
    );
    const none = pageTenantAccounts(many, { query: 'wayne' });
    expect(none).toMatchObject({
      accounts: [],
      total: 0,
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
      query: 'wayne',
    });
    expect(pageTenantAccounts([], {})).toMatchObject({ total: 0, pageCount: 1, from: 0 });
  });
});
