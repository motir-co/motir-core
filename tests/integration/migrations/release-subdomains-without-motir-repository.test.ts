import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectRepoState, ProjectRepoTakeoverState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { hostnameReservationHash } from '@/lib/publicAddresses/hostnameReservation';
import { publicSubdomainService } from '@/lib/services/publicSubdomainService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { seedMotirRepository } from '../../helpers/motirRepository';
import { createTestWorkspace } from '../../fixtures';

// MOTIR-11289 (Story MOTIR-11283) — the forward, data-only migration that releases
// every motir.site claim held by a workspace with no Motir repository (§8
// Amendment 5). Real Postgres; the SQL is replayed verbatim, as the deploy
// applies it, as the OWNER and as the non-bypass RUNTIME role — the second is
// the case where a subquery blinded by RLS would delete every claim.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261114220000_release_subdomains_without_motir_repository/migration.sql',
  ),
  'utf8',
);

const BASE = 'motir.example';
const DAY = 24 * 60 * 60 * 1000;

/** Replay the migration as the database OWNER — the deploy's role. */
const runAsOwner = () => adminDb.$executeRawUnsafe(MIGRATION_SQL);
/**
 * Replay it as the NON-BYPASS runtime role, so the policies bite. Inside an
 * interactive transaction: the statement runs as the same role either way, and
 * the `app.system_admin` binding the migration sets with `is_local = true` is
 * scoped to that transaction, exactly as `prisma migrate deploy` scopes it.
 */
const runAsAppRole = (sql = MIGRATION_SQL) => db.$transaction((tx) => tx.$executeRawUnsafe(sql));

/** The same migration with its RLS binding removed — the negative control. */
const UNBOUND_SQL = MIGRATION_SQL.replace(/^\s*PERFORM set_config\('app\.system_admin'.*$/gm, '');

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type RowShape = {
  seedSource?: string;
  state?: ProjectRepoState;
  takeoverState?: ProjectRepoTakeoverState | null;
};

let seq = 0;

/** A workspace with the given repository rows, holding `<label>.<base>` taken long ago. */
async function tenantHolding(label: string, rows: RowShape[]) {
  const { workspace, owner } = await createTestWorkspace({ name: `ws-${seq++}` });
  for (const row of rows) await seedMotirRepository({ workspaceId: workspace.id, ...row });
  await adminDb.publicAddress.create({
    data: {
      workspaceId: workspace.id,
      hostname: `${label}.${BASE}`,
      kind: 'workspace_subdomain',
      status: 'active',
      createdAt: new Date(Date.now() - 60 * DAY),
    },
  });
  return { workspaceId: workspace.id, ownerId: owner.id, hostname: `${label}.${BASE}` };
}

async function subdomainHosts(): Promise<string[]> {
  const rows = await adminDb.publicAddress.findMany({
    where: { kind: 'workspace_subdomain' },
    orderBy: { hostname: 'asc' },
  });
  return rows.map((r) => r.hostname);
}

const INELIGIBLE: Array<[string, RowShape[]]> = [
  ['no repository row', []],
  ['only an imported (organization) row', [{ seedSource: 'organization', state: 'connected' }]],
  ['an imported row that reads created', [{ seedSource: 'organization', state: 'created' }]],
  ['a proposed row', [{ state: 'proposed' }]],
  ['a failed row', [{ state: 'failed' }]],
  ['a skipped row', [{ state: 'skipped' }]],
  ['a connected starter-seeded row', [{ state: 'connected' }]],
  ['a created row at awaiting_reinstall', [{ takeoverState: 'awaiting_reinstall' }]],
  ['a created row whose takeover is done', [{ takeoverState: 'done' }]],
];

const ELIGIBLE: Array<[string, RowShape[]]> = [
  ['a created row with no takeover (NULL)', [{}]],
  ['a created row at requested', [{ takeoverState: 'requested' }]],
  ['a created row at transfer_pending', [{ takeoverState: 'transfer_pending' }]],
  ['a created row whose takeover failed', [{ takeoverState: 'failed' }]],
  ['an imported row beside a created Motir row', [{ seedSource: 'organization' }, {}]],
];

describe('the migration file', () => {
  it('cites the rule it applies and changes no schema', () => {
    expect(MIGRATION_SQL).toContain('§8 AMENDMENT 5');
    expect(MIGRATION_SQL).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TYPE|INDEX|POLICY)\b/i);
  });
});

describe('20261114220000_release_subdomains_without_motir_repository', () => {
  it.each(INELIGIBLE)('releases the claim of a workspace with %s', async (_, rows) => {
    await tenantHolding('stray', rows);
    await runAsOwner();
    expect(await subdomainHosts()).toEqual([]);
  });

  it.each(ELIGIBLE)('keeps the claim of a workspace with %s', async (_, rows) => {
    await tenantHolding('kept', rows);
    await runAsOwner();
    expect(await subdomainHosts()).toEqual([`kept.${BASE}`]);
  });

  it('writes no reservation and no ledger row, so an eligible workspace claims the label at once', async () => {
    const stray = await tenantHolding('verify-20261114', []);
    const kept = await tenantHolding('acme', [{}]);

    await runAsOwner();

    expect(await subdomainHosts()).toEqual([kept.hostname]);
    expect(
      await adminDb.publicHostnameReservation.count({
        where: { hostnameHash: hostnameReservationHash(stray.hostname) },
      }),
    ).toBe(0);
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    expect(
      await adminDb.publicSubdomainChange.count({ where: { workspaceId: stray.workspaceId } }),
    ).toBe(0);

    const claimant = await createTestWorkspace({ name: 'Claimant' });
    await seedMotirRepository({ workspaceId: claimant.workspace.id });
    const dto = await publicSubdomainService.claim(
      claimant.workspace.id,
      'verify-20261114',
      claimant.owner.id,
    );
    expect(dto.hostname).toBe(stray.hostname);
  });

  it('deletes exactly the same rows under the non-bypass runtime role', async () => {
    await tenantHolding('stray-a', []);
    await tenantHolding('stray-b', [{ seedSource: 'organization', state: 'connected' }]);
    await tenantHolding('kept-a', [{}]);
    await tenantHolding('kept-b', [{ takeoverState: 'requested' }]);

    await runAsAppRole();

    expect(await subdomainHosts()).toEqual([`kept-a.${BASE}`, `kept-b.${BASE}`]);
  });

  it('owes that agreement to its system-admin binding: unbound, the runtime role releases nothing', async () => {
    expect(UNBOUND_SQL).not.toContain("set_config('app.system_admin'");
    expect(UNBOUND_SQL).not.toBe(MIGRATION_SQL);
    await tenantHolding('stray-a', []);
    await tenantHolding('kept-a', [{}]);

    await runAsAppRole(UNBOUND_SQL);

    // Under FORCE RLS with no binding, the runtime role sees neither
    // `public_address` nor `project_repository`: the DELETE matches nothing and
    // the stray claim SURVIVES — a silent no-op, not the owner's answer. (Were
    // `public_address` visible and `project_repository` not, the same blindness
    // would delete the eligible claim too.) The binding is what makes the
    // runtime role select exactly the owner's set.
    expect(await subdomainHosts()).toEqual([`kept-a.${BASE}`, `stray-a.${BASE}`]);
  });

  it('leaves legacy alias rows and custom domains alone, whatever the repositories', async () => {
    const stray = await tenantHolding('stray', []);
    await adminDb.publicAddress.createMany({
      data: [
        {
          workspaceId: stray.workspaceId,
          hostname: `old-stray.${BASE}`,
          kind: 'workspace_subdomain_alias',
          status: 'active',
        },
        {
          workspaceId: stray.workspaceId,
          hostname: 'roadmap.customer.example',
          kind: 'custom_domain',
          status: 'unverified',
          verificationToken: 'motir-verify-test',
        },
      ],
    });

    await runAsOwner();

    const rows = await adminDb.publicAddress.findMany({ orderBy: { hostname: 'asc' } });
    expect(rows.map((r) => [r.hostname, r.kind])).toEqual([
      [`old-stray.${BASE}`, 'workspace_subdomain_alias'],
      ['roadmap.customer.example', 'custom_domain'],
    ]);
  });

  it('is a no-op on a database with no stray claim, and a second run changes nothing', async () => {
    await tenantHolding('kept', [{}]);
    await runAsOwner();
    const before = await adminDb.publicAddress.findMany();

    await runAsOwner();
    await runAsAppRole();

    expect(await adminDb.publicAddress.findMany()).toEqual(before);
  });
});
