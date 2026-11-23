import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { TENANT_ACCOUNT_REGION } from '@/lib/ciFleet/hostingTenantAccounts';
import { hostingTenantAccountRepository as repo } from '@/lib/repositories/hostingTenantAccountRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE TENANT ACCOUNT RECORD (Story MOTIR-9792 · MOTIR-9939), against the real
// database: one row per organisation, the refusal count and time persisted on the
// row, and no tie to the fleet tables.

let orgSeq = 0;
async function seedOrg() {
  orgSeq += 1;
  return adminDb.organization.create({
    data: { name: `Tenant org ${orgSeq}`, slug: `tenant-org-${orgSeq}-${Date.now()}` },
  });
}

const ensure = (organizationId: string) =>
  withSystemContext((tx) => repo.ensureRequestedInTx(organizationId, TENANT_ACCOUNT_REGION, tx));

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
});

describe('hostingTenantAccountRepository', () => {
  it('ensureRequestedInTx creates one row in requested and returns it unchanged after', async () => {
    const org = await seedOrg();
    const first = await ensure(org.id);
    expect(first).toMatchObject({
      organizationId: org.id,
      state: 'requested',
      awsAccountId: null,
      ouId: null,
      refusedCount: 0,
      lastRefusedAt: null,
      region: 'us-east-1',
    });
    await withSystemContext((tx) => repo.setStateInTx(org.id, 'creating', tx));
    const second = await ensure(org.id);
    expect(second.id).toBe(first.id);
    expect(second.state).toBe('creating');
    expect(await adminDb.hostingTenantAccount.count()).toBe(1);
  });

  it('ensureRequestedInTx called concurrently leaves exactly one row', async () => {
    const org = await seedOrg();
    const rows = await Promise.all(Array.from({ length: 6 }, () => ensure(org.id)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await adminDb.hostingTenantAccount.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it('persists refusals on the row, read back in a new session', async () => {
    const org = await seedOrg();
    await ensure(org.id);
    const at = new Date('2026-10-28T03:00:00Z');
    await withSystemContext((tx) => repo.recordRefusalInTx(org.id, at, tx));
    await withSystemContext((tx) => repo.recordRefusalInTx(org.id, at, tx));
    const read = await withSystemContext((tx) => repo.findByOrganizationId(org.id, tx));
    expect(read).toMatchObject({ refusedCount: 2, lastRefusedAt: at });
    await withSystemContext((tx) => repo.clearRefusalsInTx(org.id, tx));
    const cleared = await withSystemContext((tx) => repo.findByOrganizationId(org.id, tx));
    expect(cleared?.refusedCount).toBe(0);
  });

  it('records the account and OU, and lists only rows not ready', async () => {
    const [a, b] = [await seedOrg(), await seedOrg()];
    await ensure(a.id);
    await ensure(b.id);
    await withSystemContext((tx) =>
      repo.recordAccountInTx(a.id, '111122223333', 'ou-ab12-tenants', tx),
    );
    await withSystemContext((tx) => repo.setStateInTx(a.id, 'ready', tx));
    const unready = await withSystemContext((tx) => repo.listUnreadyInTx(tx));
    expect(unready.map((r) => r.organizationId)).toEqual([b.id]);
    const ready = await withSystemContext((tx) => repo.findByOrganizationId(a.id, tx));
    expect(ready).toMatchObject({ awsAccountId: '111122223333', ouId: 'ou-ab12-tenants' });
  });

  it('lists no row in a handover state as unready, so the bring-up never walks one (MOTIR-9800)', async () => {
    const orgs = [
      await seedOrg(),
      await seedOrg(),
      await seedOrg(),
      await seedOrg(),
      await seedOrg(),
    ];
    for (const org of orgs) await ensure(org.id);
    const handover = ['handing_over', 'awaiting_standalone', 'removing', 'handed_over'] as const;
    for (const [i, state] of handover.entries()) {
      await withSystemContext((tx) => repo.setStateInTx(orgs[i]!.id, state, tx));
    }
    const unready = await withSystemContext((tx) => repo.listUnreadyInTx(tx));
    expect(unready.map((r) => r.organizationId)).toEqual([orgs[4]!.id]);
  });

  it('records the handover owner on the row and returns it from ensure (MOTIR-9800)', async () => {
    const org = await seedOrg();
    const first = await ensure(org.id);
    expect(first).toMatchObject({ handoverOwnerEmail: null, handoverGithubOwner: null });
    const set = await withSystemContext((tx) =>
      repo.setHandoverOwnerInTx(
        org.id,
        { ownerEmail: 'owner@acme.example', githubOwner: 'acme-co' },
        tx,
      ),
    );
    expect(set).toMatchObject({
      handoverOwnerEmail: 'owner@acme.example',
      handoverGithubOwner: 'acme-co',
    });
    expect(await ensure(org.id)).toMatchObject({
      id: first.id,
      handoverOwnerEmail: 'owner@acme.example',
      handoverGithubOwner: 'acme-co',
    });
  });

  it('refuses a state outside the nine at the database', async () => {
    const org = await seedOrg();
    await ensure(org.id);
    await expect(
      adminDb.$executeRaw`UPDATE "hosting_tenant_account" SET "state" = 'closed' WHERE "organization_id" = ${org.id}`,
    ).rejects.toThrow();
  });

  it('marks a row ready with its quota check time, and lists ready rows due a re-check (MOTIR-12011)', async () => {
    const [fresh, stale, never, unready] = [
      await seedOrg(),
      await seedOrg(),
      await seedOrg(),
      await seedOrg(),
    ];
    for (const org of [fresh, stale, never, unready]) await ensure(org.id);
    expect((await ensure(never.id)).quotasCheckedAt).toBeNull();
    const at = new Date('2026-11-22T12:00:00Z');
    const earlier = new Date('2026-11-22T09:00:00Z');

    const marked = await withSystemContext((tx) => repo.markReadyInTx(fresh.id, at, tx));
    expect(marked).toMatchObject({ state: 'ready', quotasCheckedAt: at });
    await withSystemContext((tx) => repo.markReadyInTx(stale.id, at, tx));
    await withSystemContext((tx) => repo.recordQuotasCheckedInTx(stale.id, earlier, tx));
    await withSystemContext((tx) => repo.setStateInTx(never.id, 'ready', tx));

    const due = await withSystemContext((tx) =>
      repo.listReadyQuotaCheckDueInTx(new Date('2026-11-22T11:00:00Z'), tx),
    );
    expect(due.map((r) => r.organizationId)).toEqual([never.id, stale.id]);
    expect((await ensure(stale.id)).quotasCheckedAt).toEqual(earlier);
  });

  it('refuses a state outside the five at the database', async () => {
    const org = await seedOrg();
    await ensure(org.id);
    await expect(
      adminDb.hostingTenantAccount.update({
        where: { organizationId: org.id },
        data: { state: 'active' },
      }),
    ).rejects.toThrow();
  });

  it('is invisible outside the system context', async () => {
    const org = await seedOrg();
    await ensure(org.id);
    expect(await repo.findByOrganizationId(org.id)).toBeNull();
    expect(await db.hostingTenantAccount.count()).toBe(0);
  });
});

describe('the record stays apart from the fleet', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const model = /model HostingTenantAccount \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? '';

  it('has no relation to fleet_shard and no column for a derived email or a credential', () => {
    expect(model).not.toBe('');
    expect(model).not.toMatch(/FleetShard|fleet_shard/);
    // The model's comments name what it must NOT hold, so only fields are read.
    const fields = model
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('///') && !line.startsWith('@@'));
    // The one email the row holds is the handover owner's (MOTIR-9800): the
    // address an administrator types, never the account's derived member email.
    const emailFields = fields.filter((line) => /email/i.test(line));
    expect(emailFields.map((line) => line.split(/\s+/)[0])).toEqual(['handoverOwnerEmail']);
    const others = fields.filter((line) => !/^handoverOwnerEmail\b/.test(line));
    expect(others.join('\n')).not.toMatch(/email|secret|password|token|credential|key\b/i);
    expect(model).toMatch(/organization\s+Organization\s+@relation/);
    expect(schema).toMatch(/hostingTenantAccount\s+HostingTenantAccount\?/);
  });

  it('is read by no admission, headroom, pool-growth or plan-caps code', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    const fleet = [
      ...files('lib/ciFleet'),
      'lib/services/fleetShardAdmissionService.ts',
      'lib/services/fleetPoolGrowthService.ts',
      'lib/services/fleetShardHeadroomService.ts',
      'lib/services/planCapsService.ts',
    ].filter((path) => !/hostingTenantAccounts\.ts$/.test(path));
    const offenders = fleet.filter((path) =>
      /hostingTenantAccountRepository|hostingTenantAccount\b/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
