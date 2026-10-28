import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWS_MANAGEMENT_ENV, type AwsSessionCredentials } from '@motir/orchestrator';
import {
  FleetShardAccountRefusedError,
  FleetShardProvisioningRefusedError,
} from '@/lib/ciFleet/errors';
import { tenantAccountName, TENANT_OU_NAME } from '@/lib/ciFleet/hostingTenantAccounts';
import { AWS_MEMBER_EMAIL_TEMPLATE_ENV } from '@/lib/fleetShards/awsMemberAccountPlan';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { createOrFindTenantAccount } from '@/lib/services/hostingTenantAccountProvisioningService';
import { withSystemContext } from '@/lib/workspaces/context';
import { FakeOrganization } from '../helpers/addShardFakes';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// CREATE OR FIND THE TENANT AWS ACCOUNT (Story MOTIR-9792 · MOTIR-9940), against
// the real database for the record and the in-memory AWS organization for the
// management calls: one account, one `Tenants` OU, one move, however often a pass
// is cut off — and no fleet row, credential or member email anywhere.

const TEMPLATE = 'tenant-root+{name}@distinctive-template.example';
const SECRETS = {
  managementKey: 'AKIA_MANAGEMENT_never_printed',
  managementSecret: 'MANAGEMENT_SECRET_never_printed',
  sessionKeyId: 'ASIA_SESSION_never_printed',
  sessionSecret: 'SESSION_SECRET_never_printed',
  sessionToken: 'SESSION_TOKEN_never_printed',
};
const SESSION: AwsSessionCredentials = {
  accessKeyId: SECRETS.sessionKeyId,
  secretAccessKey: SECRETS.sessionSecret,
  sessionToken: SECRETS.sessionToken,
  expiration: null,
};
const ENV = {
  [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: TEMPLATE,
  [AWS_MANAGEMENT_ENV.accessKeyId]: SECRETS.managementKey,
  [AWS_MANAGEMENT_ENV.secretAccessKey]: SECRETS.managementSecret,
  [AWS_MANAGEMENT_ENV.roleArn]: 'arn:aws:iam::576360162297:role/motir-add-shard',
};
/** Strings that must never leave the function. */
const FORBIDDEN = [...Object.values(SECRETS), 'distinctive-template.example', 'tenant-root+'];

let organization: FakeOrganization;
let logs: string[];
let orgSeq = 0;

async function seedOrg() {
  orgSeq += 1;
  return adminDb.organization.create({
    data: { name: `Tenant org ${orgSeq}`, slug: `tenant-prov-${orgSeq}-${Date.now()}` },
  });
}

const run = (organizationId: string, env: Record<string, string> = ENV) =>
  createOrFindTenantAccount(organizationId, { management: organization, env });

const recordOf = (organizationId: string) =>
  withSystemContext((tx) =>
    hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
  );

const countOf = (calls: string[], prefix: string) =>
  calls.filter((c) => c.startsWith(prefix)).length;

function expectNoLeak(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
}

beforeEach(async () => {
  await truncateAuthTables();
  organization = new FakeOrganization(SESSION);
  logs = [];
  for (const level of ['info', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('createOrFindTenantAccount', () => {
  it('creates tenant-<org> once, under the Tenants OU, and records it; a replay changes nothing', async () => {
    const org = await seedOrg();
    const shardsBefore = await adminDb.fleetShard.count();
    const quotaBefore = await adminDb.fleetQuotaRequest.count();

    const first = await run(org.id);
    const account = organization.accounts.get(tenantAccountName(org.id))!;
    const ouId = organization.organizationalUnits.get(TENANT_OU_NAME)!;
    expect(first).toEqual({ accountId: account.accountId, ouId, created: true, moved: true });
    expect(countOf(organization.calls, 'createOrganizationAccount')).toBe(1);
    expect(organization.accountParents.get(account.accountId)).toBe(ouId);
    expect(await recordOf(org.id)).toMatchObject({
      awsAccountId: account.accountId,
      ouId,
      state: 'requested',
      refusedCount: 0,
    });

    const callsBefore = organization.calls.length;
    const second = await run(org.id);
    expect(second).toEqual({ accountId: account.accountId, ouId, created: false, moved: false });
    const replay = organization.calls.slice(callsBefore);
    expect(countOf(replay, 'createOrganizationAccount')).toBe(0);
    expect(organization.organizationalUnits.size).toBe(1);
    expect(organization.accounts.size).toBe(1);

    expect(await adminDb.fleetShard.count()).toBe(shardsBefore);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(quotaBefore);
    expect(await adminDb.hostingTenantAccount.count()).toBe(1);
  });

  const cutOffs: Array<[string, () => void]> = [
    [
      'CreateAccount returned',
      () => organization.failAfter.set('createOrganizationAccount', new Error('cut off')),
    ],
    [
      'the OU was created',
      () => organization.failAfter.set('ensureOrganizationalUnit', new Error('cut off')),
    ],
    [
      'the record was written',
      () =>
        void vi.spyOn(organization, 'moveAccountToOu').mockRejectedValueOnce(new Error('cut off')),
    ],
    ['the move', () => organization.failAfter.set('moveAccountToOu', new Error('cut off'))],
  ];

  it.each(cutOffs)('a pass cut off after %s is finished by the next one', async (_, cut) => {
    const org = await seedOrg();
    cut();
    await expect(run(org.id)).rejects.toThrow('cut off');

    const result = await run(org.id);
    const account = organization.accounts.get(tenantAccountName(org.id))!;
    expect(result.accountId).toBe(account.accountId);
    expect(organization.accounts.size).toBe(1);
    expect(organization.organizationalUnits.size).toBe(1);
    expect(countOf(organization.calls, 'createOrganizationAccount')).toBe(1);
    expect(organization.accountParents.get(account.accountId)).toBe(result.ouId);
    expect(await adminDb.hostingTenantAccount.count()).toBe(1);
    expect(await recordOf(org.id)).toMatchObject({
      awsAccountId: account.accountId,
      ouId: result.ouId,
    });
  });

  it('assumes only the member role of the account it found, and returns no session', async () => {
    const org = await seedOrg();
    const result = await run(org.id);
    const assumptions = organization.calls.filter((c) => c.startsWith('assume'));
    expect(assumptions).toEqual([`assumeMemberRole:${result.accountId}`]);
    expect(Object.keys(result).sort()).toEqual(['accountId', 'created', 'moved', 'ouId']);
  });

  it('carries no credential or member email in its result, record or logs', async () => {
    const org = await seedOrg();
    const result = await run(org.id);
    expectNoLeak(result);
    expectNoLeak(await recordOf(org.id));
    expectNoLeak(logs.join('\n'));
  });

  it('surfaces a refused CreateAccount by name and reason, writing nothing', async () => {
    const org = await seedOrg();
    organization.createFailure = 'ACCOUNT_LIMIT_EXCEEDED';
    const err = await run(org.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetShardAccountRefusedError);
    expect((err as Error).message).toContain(tenantAccountName(org.id));
    expect((err as Error).message).toContain('ACCOUNT_LIMIT_EXCEEDED');
    expectNoLeak((err as Error).message);
    expect(await recordOf(org.id)).toBeNull();
  });

  it.each([
    ['no email template', { ...ENV, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: '' }],
    ['a malformed email template', { ...ENV, [AWS_MEMBER_EMAIL_TEMPLATE_ENV]: 'no-placeholder' }],
    ['no management credential', { ...ENV, [AWS_MANAGEMENT_ENV.roleArn]: '' }],
  ])('refuses before any AWS call with %s', async (_, env) => {
    const org = await seedOrg();
    const err = await run(org.id, env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetShardProvisioningRefusedError);
    expectNoLeak((err as Error).message);
    expect(organization.calls).toEqual([]);
  });

  it('refuses rather than overwrite a record holding another account id', async () => {
    const org = await seedOrg();
    await withSystemContext(async (tx) => {
      await hostingTenantAccountRepository.ensureRequestedInTx(org.id, 'us-east-1', tx);
      await hostingTenantAccountRepository.recordAccountInTx(org.id, '999999999999', 'ou-x', tx);
    });
    await expect(run(org.id)).rejects.toBeInstanceOf(FleetShardProvisioningRefusedError);
    expect(await recordOf(org.id)).toMatchObject({ awsAccountId: '999999999999', ouId: 'ou-x' });
    expect(organization.calls.filter((c) => c.startsWith('moveAccountToOu'))).toEqual([]);
  });

  it('reaches none of the fleet shard services or repository', () => {
    for (const file of [
      'lib/services/hostingTenantAccountProvisioningService.ts',
      'tests/services/hostingTenantAccountProvisioning.test.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const imports = source.match(/from '[^']+'/g) ?? [];
      for (const forbidden of [
        'fleetShardService',
        'fleetShardProvisioningService',
        'fleetShardRepository',
      ]) {
        expect(imports.filter((i) => i.includes(forbidden))).toEqual([]);
      }
    }
  });
});
