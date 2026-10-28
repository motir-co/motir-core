import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwsSessionCredentials } from '@motir/orchestrator';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import {
  TENANT_ACCOUNT_REGION,
  tenantDeployPolicyDocument,
  type HostingTenantAccountState,
} from '@/lib/ciFleet/hostingTenantAccounts';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import { convergeTenantDeployPolicy } from '@/lib/services/hostingTenantAccountBootstrapService';
import { hostingTenantAccountService } from '@/lib/services/hostingTenantAccountService';
import { withSystemContext } from '@/lib/workspaces/context';
import { FakeOrganization } from '../helpers/addShardFakes';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// CONVERGE THE DEPLOY ROLE'S POLICY ON EXISTING TENANT ACCOUNTS (MOTIR-10005),
// against the real database for the records and the in-memory AWS organization:
// a `ready` account never re-runs its bootstrap, so this is how a new policy
// reaches it — written once when it differs, nothing on a replay, one failing
// organisation never stopping the rest, and no credential in anything returned
// or logged.

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
const OLD_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 'ecs:*', Resource: '*' }],
});
const NEW_POLICY = JSON.stringify(tenantDeployPolicyDocument());

let organization: FakeOrganization;
let logs: string[];
let orgSeq = 0;

async function seedAccount(
  accountId: string,
  state: HostingTenantAccountState = 'ready',
): Promise<string> {
  orgSeq += 1;
  const org = await adminDb.organization.create({
    data: { name: `Converge org ${orgSeq}`, slug: `tenant-converge-${orgSeq}-${Date.now()}` },
  });
  await withSystemContext(async (tx) => {
    await hostingTenantAccountRepository.ensureRequestedInTx(org.id, TENANT_ACCOUNT_REGION, tx);
    await hostingTenantAccountRepository.recordAccountInTx(org.id, accountId, 'ou-fake-1', tx);
    await hostingTenantAccountRepository.setStateInTx(org.id, state, tx);
  });
  // The role as an earlier bootstrap left it, with the old policy.
  organization.tenantRoles.set(accountId, OLD_POLICY);
  return org.id;
}

const converge = (organizationId: string) =>
  convergeTenantDeployPolicy(organizationId, { management: organization });

function expectNoLeak(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
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

afterAll(async () => {
  vi.restoreAllMocks();
  await truncateAuthTables();
});

describe('convergeTenantDeployPolicy', () => {
  it('writes the new policy over the old one once, and nothing on a second call', async () => {
    const organizationId = await seedAccount('400000000101');

    expect(await converge(organizationId)).toEqual({ policyChanged: true });
    expect(organization.tenantRoles.get('400000000101')).toBe(NEW_POLICY);

    organization.calls.length = 0;
    expect(await converge(organizationId)).toEqual({ policyChanged: false });
    expect(organization.tenantRoles.get('400000000101')).toBe(NEW_POLICY);
    expect(organization.calls).toEqual([
      'assumeMemberRole:400000000101',
      'ensureTenantDeployRole:400000000101',
    ]);
  });

  it('writes no record state', async () => {
    const organizationId = await seedAccount('400000000102');
    const before = await withSystemContext((tx) =>
      hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
    );

    await converge(organizationId);

    const after = await withSystemContext((tx) =>
      hostingTenantAccountRepository.findByOrganizationId(organizationId, tx),
    );
    expect(after).toEqual(before);
  });

  it('refuses an organisation with no tenant account recorded, calling nothing', async () => {
    const org = await adminDb.organization.create({
      data: { name: 'No account', slug: `tenant-converge-none-${Date.now()}` },
    });

    await expect(converge(org.id)).rejects.toBeInstanceOf(FleetShardProvisioningRefusedError);
    expect(organization.calls).toEqual([]);
  });
});

describe('hostingTenantAccountService.convergeReadyAccounts', () => {
  it('converges every ready account, skips the rest, and carries on past a failure', async () => {
    const first = await seedAccount('400000000201');
    const failing = await seedAccount('400000000202');
    const last = await seedAccount('400000000203');
    await seedAccount('400000000204', 'bootstrapping');
    const assume = organization.assumeMemberRole.bind(organization);
    organization.assumeMemberRole = async (accountId: string) => {
      if (accountId === '400000000202') {
        throw new Error(`AccessDenied for ${SECRETS.sessionKeyId}`);
      }
      return assume(accountId);
    };
    const deps = { converge };

    const summary = await hostingTenantAccountService.convergeReadyAccounts(deps);

    expect(summary).toEqual({
      organizations: [
        { organizationId: first, outcome: 'changed' },
        { organizationId: failing, outcome: 'failed' },
        { organizationId: last, outcome: 'changed' },
      ],
      changed: 2,
      unchanged: 0,
      failures: 1,
    });
    expect(organization.tenantRoles.get('400000000201')).toBe(NEW_POLICY);
    expect(organization.tenantRoles.get('400000000202')).toBe(OLD_POLICY);
    expect(organization.tenantRoles.get('400000000203')).toBe(NEW_POLICY);
    expect(organization.tenantRoles.get('400000000204')).toBe(OLD_POLICY);
    expect(organization.calls.some((c) => c.endsWith('400000000204'))).toBe(false);

    const replay = await hostingTenantAccountService.convergeReadyAccounts(deps);
    expect(replay).toMatchObject({ changed: 0, unchanged: 2, failures: 1 });

    expectNoLeak(summary);
    expectNoLeak(replay);
    expectNoLeak(logs.join('\n'));
    expect(logs.join('\n')).toContain('Error');
  });

  it('answers not_ready for one organisation whose account is still being built', async () => {
    const organizationId = await seedAccount('400000000301', 'bootstrapping');

    expect(
      await hostingTenantAccountService.convergeDeployPolicy(organizationId, { converge }),
    ).toEqual({ organizationId, outcome: 'not_ready' });
    expect(organization.calls).toEqual([]);
  });

  it('answers not_ready for an organisation with no row', async () => {
    const org = await adminDb.organization.create({
      data: { name: 'No row', slug: `tenant-converge-norow-${Date.now()}` },
    });

    expect(await hostingTenantAccountService.convergeDeployPolicy(org.id, { converge })).toEqual({
      organizationId: org.id,
      outcome: 'not_ready',
    });
  });
});
