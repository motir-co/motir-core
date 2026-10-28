import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AwsManagementApiError, type AwsSessionCredentials } from '@motir/orchestrator';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import {
  TENANT_ACCOUNT_REGION,
  TENANT_ORGANIZATION_TAG_KEY,
  TENANT_QUOTA_TARGETS,
  tenantDeployPolicyDocument,
} from '@/lib/ciFleet/hostingTenantAccounts';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { bootstrapTenantAccount } from '@/lib/services/hostingTenantAccountBootstrapService';
import { withSystemContext } from '@/lib/workspaces/context';
import { FakeOrganization, type FakeOrganizationStep } from '../helpers/addShardFakes';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// BOOTSTRAP THE TENANT AWS ACCOUNT (Story MOTIR-9792 · MOTIR-9941), against the
// real database for the record and the in-memory AWS organization: one deploy
// role, one tag and one raise per quota however often a pass is cut off, and no
// credential, email or fleet row anywhere.

const ACCOUNT_ID = '400000000777';
const SECRETS = {
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
const TEMPLATE_MARK = 'distinctive-template.example';
const FORBIDDEN = [...Object.values(SECRETS), TEMPLATE_MARK];

let organization: FakeOrganization;
let logs: string[];
let orgSeq = 0;

async function seedRecordedOrg(accountId: string | null = ACCOUNT_ID) {
  orgSeq += 1;
  const org = await adminDb.organization.create({
    data: { name: `Tenant org ${orgSeq}`, slug: `tenant-boot-${orgSeq}-${Date.now()}` },
  });
  await withSystemContext(async (tx) => {
    await hostingTenantAccountRepository.ensureRequestedInTx(org.id, TENANT_ACCOUNT_REGION, tx);
    if (accountId) {
      await hostingTenantAccountRepository.recordAccountInTx(org.id, accountId, 'ou-fake-1', tx);
    }
  });
  return org;
}

const run = (organizationId: string) =>
  bootstrapTenantAccount(organizationId, { management: organization });

const recordOf = (organizationId: string) =>
  withSystemContext((tx) =>
    hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
  );

function expectNoLeak(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
}

beforeEach(async () => {
  await truncateAuthTables();
  organization = new FakeOrganization(SESSION);
  vi.stubEnv('FLEET_AWS_MEMBER_EMAIL_TEMPLATE', `root+{name}@${TEMPLATE_MARK}`);
  logs = [];
  for (const level of ['info', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('bootstrapTenantAccount', () => {
  it('makes the role, the tag and both raises once; a replay changes nothing', async () => {
    const org = await seedRecordedOrg();
    const shardsBefore = await adminDb.fleetShard.count();
    const quotaBefore = await adminDb.fleetQuotaRequest.count();
    const recordBefore = await recordOf(org.id);

    expect(await run(org.id)).toEqual({
      roleCreated: true,
      tagged: true,
      quotaRaisesFiled: TENANT_QUOTA_TARGETS.length,
      quotaRaisesPending: TENANT_QUOTA_TARGETS.length,
    });
    expect(organization.tenantRoles.get(ACCOUNT_ID)).toBe(
      JSON.stringify(tenantDeployPolicyDocument()),
    );
    expect(organization.accountTags.get(ACCOUNT_ID)?.get(TENANT_ORGANIZATION_TAG_KEY)).toBe(org.id);
    expect([...organization.openQuotaRaises.keys()].sort()).toEqual(
      TENANT_QUOTA_TARGETS.map((t) => `${ACCOUNT_ID}:${t.quotaCode}`).sort(),
    );

    expect(await run(org.id)).toEqual({
      roleCreated: false,
      tagged: false,
      quotaRaisesFiled: 0,
      quotaRaisesPending: TENANT_QUOTA_TARGETS.length,
    });

    expect(await recordOf(org.id)).toEqual(recordBefore);
    expect(await adminDb.fleetShard.count()).toBe(shardsBefore);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(quotaBefore);
  });

  it.each<FakeOrganizationStep>([
    'tenantRoleCreated',
    'tenantRolePolicyPut',
    'accountTagged',
    'quotaRaiseFiled',
  ])('a pass cut off after %s is finished by the next one', async (step) => {
    const org = await seedRecordedOrg();
    organization.failAfter.set(step, new Error('cut off'));
    await expect(run(org.id)).rejects.toThrow('cut off');

    const result = await run(org.id);
    expect(result.quotaRaisesPending).toBe(TENANT_QUOTA_TARGETS.length);
    expect(organization.tenantRoles.size).toBe(1);
    expect(organization.tenantRoles.get(ACCOUNT_ID)).toBe(
      JSON.stringify(tenantDeployPolicyDocument()),
    );
    expect(organization.accountTags.get(ACCOUNT_ID)?.size).toBe(1);
    expect(organization.openQuotaRaises.size).toBe(TENANT_QUOTA_TARGETS.length);
    expect(await run(org.id)).toMatchObject({
      roleCreated: false,
      tagged: false,
      quotaRaisesFiled: 0,
    });
  });

  it('files nothing for a quota at target and reports an open raise as pending', async () => {
    const org = await seedRecordedOrg();
    const [atTarget, open] = TENANT_QUOTA_TARGETS;
    organization.appliedQuotas.set(`${ACCOUNT_ID}:${atTarget!.quotaCode}`, atTarget!.desiredValue);
    organization.openQuotaRaises.set(`${ACCOUNT_ID}:${open!.quotaCode}`, open!.desiredValue);

    expect(await run(org.id)).toMatchObject({ quotaRaisesFiled: 0, quotaRaisesPending: 1 });
  });

  it('refuses a record with no account id before any AWS call', async () => {
    const org = await seedRecordedOrg(null);
    await expect(run(org.id)).rejects.toBeInstanceOf(FleetShardProvisioningRefusedError);
    expect(organization.calls).toEqual([]);
  });

  it('surfaces an AWS error by its code only', async () => {
    const org = await seedRecordedOrg();
    vi.spyOn(organization, 'ensureAccountTag').mockRejectedValueOnce(
      new AwsManagementApiError('organizations', 'AccessDeniedException', 403),
    );
    const err = await run(org.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsManagementApiError);
    expect((err as AwsManagementApiError).awsCode).toBe('AccessDeniedException');
    expectNoLeak((err as Error).message);
  });

  it('assumes only the member role, returns no session and leaks nothing', async () => {
    const org = await seedRecordedOrg();
    const result = await run(org.id);
    expect(organization.calls.filter((c) => c.startsWith('assume'))).toEqual([
      `assumeMemberRole:${ACCOUNT_ID}`,
    ]);
    expect(Object.keys(result).sort()).toEqual([
      'quotaRaisesFiled',
      'quotaRaisesPending',
      'roleCreated',
      'tagged',
    ]);
    expectNoLeak(result);
    expectNoLeak(organization.calls);
    expectNoLeak(logs.join('\n'));
  });

  it('grants the deploy role no IAM user, key, Organizations or billing action', () => {
    const allowed = tenantDeployPolicyDocument()
      .Statement.filter((s) => s['Effect'] === 'Allow')
      .flatMap((s) => [s['Action']].flat() as string[]);
    expect(allowed.length).toBeGreaterThan(0);
    for (const action of allowed) {
      expect(action).not.toMatch(
        /^\*$|^iam:\*$|^iam:.*(AccessKey|User)|^organizations:|^aws-portal:/,
      );
    }
  });

  it('reaches none of the fleet shard services or repository', () => {
    for (const file of [
      'lib/services/hostingTenantAccountBootstrapService.ts',
      'tests/services/hostingTenantAccountBootstrap.test.ts',
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
