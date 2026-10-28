import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TENANT_ACCOUNT_REGION } from '@/lib/ciFleet/hostingTenantAccounts';
import { hostingTenantAccountRepository } from '@/lib/repositories/hostingTenantAccountRepository';
import type { TenantAccountAnswer } from '@/lib/services/hostingTenantAccountService';
import { withSystemContext } from '@/lib/workspaces/context';
import { EXIT_ERROR, EXIT_OK, EXIT_PENDING, runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import { formatTenantAccountAnswer } from '@/scripts/fleet/fleetAdminHostingTenantCommands';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `fleet-admin hosting-tenant ensure <organization id>` (Story MOTIR-9792 ·
// MOTIR-9943): a printer over `ensureForOrganization`, exit 0 when ready and 2
// while the account is built, never a raw database message or a secret.

let out: string[];
let err: string[];
const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
let orgSeq = 0;

async function seedOrg() {
  orgSeq += 1;
  return adminDb.organization.create({
    data: { name: `Tenant org ${orgSeq}`, slug: `tenant-cli-${orgSeq}-${Date.now()}` },
  });
}

const ensure = (organizationId: string, answer?: TenantAccountAnswer | Error) =>
  runFleetAdmin(
    ['hosting-tenant', 'ensure', organizationId],
    io,
    answer === undefined
      ? {}
      : {
          hostingTenant: {
            ensure: async () => {
              if (answer instanceof Error) throw answer;
              return answer;
            },
          },
        },
  );

beforeEach(async () => {
  await truncateAuthTables();
  out = [];
  err = [];
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('fleet-admin hosting-tenant ensure', () => {
  it('requests the account once and reports it pending, the same on a re-run', async () => {
    const org = await seedOrg();
    const shardsBefore = await adminDb.fleetShard.count();

    expect(await ensure(org.id)).toBe(EXIT_PENDING);
    expect(await ensure(org.id)).toBe(EXIT_PENDING);
    expect(out).toEqual([
      `tenant account ${org.id}: requested`,
      `tenant account ${org.id}: requested`,
    ]);
    expect(err).toEqual([]);
    expect(
      await adminDb.hostingTenantAccount.findMany({ where: { organizationId: org.id } }),
    ).toMatchObject([{ state: 'requested' }]);
    expect(await adminDb.fleetShard.count()).toBe(shardsBefore);
  });

  it('prints the account id and exits 0 for a ready row', async () => {
    const org = await seedOrg();
    await withSystemContext(async (tx) => {
      await hostingTenantAccountRepository.ensureRequestedInTx(org.id, TENANT_ACCOUNT_REGION, tx);
      await hostingTenantAccountRepository.recordAccountInTx(org.id, '400000000555', 'ou-1', tx);
      await hostingTenantAccountRepository.setStateInTx(org.id, 'ready', tx);
    });

    expect(await ensure(org.id)).toBe(EXIT_OK);
    expect(out).toEqual([`tenant account ${org.id}: ready  account 400000000555`]);
  });

  it.each(['creating', 'bootstrapping', 'refused'] as const)(
    'prints %s with no unrecorded account id and exits 2',
    async (state) => {
      expect(await ensure('org_x', { state, ready: false, accountId: null })).toBe(EXIT_PENDING);
      expect(out).toEqual([`tenant account org_x: ${state}`]);
    },
  );

  it.each([
    ['no organisation id', ['hosting-tenant', 'ensure']],
    ['a second positional', ['hosting-tenant', 'ensure', 'org_a', 'org_b']],
    ['an unknown subcommand', ['hosting-tenant', 'status', 'org_a']],
    ['no subcommand', ['hosting-tenant']],
  ])('prints the usage and exits 1 for %s', async (_, argv) => {
    expect(await runFleetAdmin(argv, io)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('hosting-tenant ensure <organization id>');
  });

  it('lists the command in the usage', async () => {
    expect(await runFleetAdmin([], io)).toBe(EXIT_ERROR);
    expect(err.join('\n')).toContain('fleet-admin hosting-tenant ensure <organization id>');
  });

  it('refuses an unknown organisation by error type only, writing nothing', async () => {
    expect(await ensure('org_does_not_exist')).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^error: [A-Za-z]+$/);
    expect(err[0]).not.toMatch(/foreign key|constraint|violates|organization_id/i);
    expect(await adminDb.hostingTenantAccount.count()).toBe(0);
  });

  it('never prints a secret an ensure error carries', async () => {
    const secret = 'ghs_DISTINCTIVE_secret_never_printed';
    expect(await ensure('org_a', new Error(`boom ${secret}`))).toBe(EXIT_ERROR);
    expect([...out, ...err].join('\n')).not.toContain(secret);
  });

  it('formats the answer from the state and a recorded account id only', () => {
    expect(
      formatTenantAccountAnswer('org_1', { state: 'bootstrapping', ready: false, accountId: '1' }),
    ).toBe('tenant account org_1: bootstrapping  account 1');
  });

  it('imports no AWS client or fleet shard code', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts/fleet/fleetAdminHostingTenantCommands.ts'),
      'utf8',
    );
    const imports = source.match(/from '[^']+'/g) ?? [];
    expect(imports).toContain("from '@/lib/services/hostingTenantAccountService'");
    for (const forbidden of [
      '@aws-sdk',
      '@motir/orchestrator',
      'fleetShardService',
      'fleetShardProvisioningService',
      'fleetShardRepository',
    ]) {
      expect(imports.filter((i) => i.includes(forbidden))).toEqual([]);
    }
  });
});
