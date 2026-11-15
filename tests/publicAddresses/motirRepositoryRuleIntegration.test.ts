import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRepoState, ProjectRepoTakeoverState } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { seedMotirRepository } from '../helpers/motirRepository';

// THE STORY'S INTEGRATION GATE — ADR §8 AMENDMENT 5 (Story MOTIR-11283 ·
// Subtask MOTIR-11290).
//
// One predicate — "a `project_repository` row whose seed source is not
// `organization`, whose state is `created`, and whose takeover is neither
// `awaiting_reinstall` nor `done`" — has THREE readers that are each tested
// alone elsewhere, each mocking or skipping the others:
//
//   * the ROUTE, through the real service, which refuses a claim or rename 409
//     `SUBDOMAIN_REQUIRES_MOTIR_REPOSITORY` (MOTIR-11285);
//   * the PANE's server read, `PublicAddressBody`, which hands the service's
//     `getClaimEligibility` answer to the control (MOTIR-11287);
//   * the stray-claim MIGRATION, which restates the predicate in SQL (MOTIR-11289).
//
// The defects this file exists for are AGREEMENT defects — the SQL selecting a
// different set than the TypeScript, the pane reading a different answer than
// the route enforces — so every case runs the readers against the same rows, in
// real Postgres. The one stub is `getWorkspaceContext` (the route reads the
// session through it; the test environment has no cookies), the real
// RLS-binding `withWorkspaceContext` kept. The migration is the SHIPPED file,
// executed verbatim: a retyped copy would pass while the shipped one drifted.

const ctxRef = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { GET, PUT, DELETE } =
  await import('@/app/api/workspaces/[workspaceId]/public-subdomain/route');
const { PublicAddressBody } =
  await import('@/app/(authed)/settings/workspace/public-address/_components/PublicAddressBody');
const { hostnameReservationHash } = await import('@/lib/publicAddresses/hostnameReservation');
const { createTestWorkspace } = await import('../fixtures');

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261114220000_release_subdomains_without_motir_repository/migration.sql',
  ),
  'utf8',
);
/** The deploy's own replay: the owner role, the file as shipped. */
const runMigration = () => adminDb.$executeRawUnsafe(MIGRATION_SQL);

const BASE = 'motir.example';
const DAY = 24 * 60 * 60 * 1000;
const INELIGIBLE = 'SUBDOMAIN_REQUIRES_MOTIR_REPOSITORY';

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  ctxRef.current = null;
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

type Row = {
  seedSource?: string;
  state?: ProjectRepoState;
  takeoverState?: ProjectRepoTakeoverState | null;
};

interface Shape {
  name: string;
  rows: Row[];
  eligible: boolean;
}

/** The card's seven shapes; only the last is a Motir repository. */
const SHAPES: Shape[] = [
  {
    name: 'only organization rows',
    rows: [
      { seedSource: 'organization', state: 'connected' },
      { seedSource: 'organization', state: 'created' },
    ],
    eligible: false,
  },
  { name: 'only proposed rows', rows: [{ state: 'proposed' }], eligible: false },
  { name: 'only failed rows', rows: [{ state: 'failed' }], eligible: false },
  { name: 'only skipped rows', rows: [{ state: 'skipped' }], eligible: false },
  {
    name: 'a created Motir row at takeover awaiting_reinstall',
    rows: [{ takeoverState: 'awaiting_reinstall' }],
    eligible: false,
  },
  {
    name: 'a created Motir row whose takeover is done',
    rows: [{ takeoverState: 'done' }],
    eligible: false,
  },
  { name: 'a created, untransferred Motir row', rows: [{}], eligible: true },
];

let seq = 0;

/** A workspace with exactly `rows` as its repository rows. */
async function tenant(rows: Row[]) {
  const { workspace, owner } = await createTestWorkspace({ name: `Tenant ${seq++}` });
  for (const row of rows) await seedMotirRepository({ workspaceId: workspace.id, ...row });
  return { workspaceId: workspace.id, ownerId: owner.id };
}

/** A held name, seeded directly (never through `claim`), taken long ago. */
async function holdName(workspaceId: string, label: string) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId,
      kind: 'workspace_subdomain',
      status: 'active',
      hostname: `${label}.${BASE}`,
      createdAt: new Date(Date.now() - 60 * DAY),
    },
  });
}

const addresses = (workspaceId: string) =>
  adminDb.publicAddress.findMany({ where: { workspaceId }, orderBy: { hostname: 'asc' } });

// The route, as a signed-in actor of `t`.
const params = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) });
const req = (method: string, body?: unknown) =>
  new Request('https://app.motir.co/x', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
function as(t: { workspaceId: string; ownerId: string }) {
  ctxRef.current = { userId: t.ownerId, workspaceId: t.workspaceId };
  return {
    put: (label: string) => PUT(req('PUT', { label }), params(t.workspaceId)),
    del: () => DELETE(req('DELETE'), params(t.workspaceId)),
    get: () => GET(req('GET'), params(t.workspaceId)),
  };
}

/** The `eligible` prop the pane's server read hands to `PublicAddressControl`. */
async function paneEligible(t: { workspaceId: string; ownerId: string }): Promise<boolean> {
  const el = (await PublicAddressBody({
    workspaceId: t.workspaceId,
    actorUserId: t.ownerId,
  })) as ReactElement<{ eligible: boolean; loadFailed: boolean }>;
  expect(el.props.loadFailed).toBe(false);
  return el.props.eligible;
}

// ── Route → service ─────────────────────────────────────────────────────────

describe('the route against a workspace with no Motir repository', () => {
  it('refuses a CLAIM of a valid free label 409, and the rows are as they were', async () => {
    const t = await tenant([{ seedSource: 'organization', state: 'connected' }]);
    const before = await addresses(t.workspaceId);

    const res = await as(t).put('acme');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: INELIGIBLE });

    expect(await addresses(t.workspaceId)).toEqual(before);
    expect(before).toEqual([]);
    expect(await (await as(t).get()).json()).toBeNull();
  });

  it('refuses a RENAME to a valid free label 409, and the held name is untouched', async () => {
    const t = await tenant([{ seedSource: 'organization', state: 'connected' }]);
    await holdName(t.workspaceId, 'acme');
    const before = await addresses(t.workspaceId);

    const res = await as(t).put('acme-labs');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: INELIGIBLE });

    expect(await addresses(t.workspaceId)).toEqual(before);
    expect(await adminDb.publicAddress.count({ where: { hostname: `acme-labs.${BASE}` } })).toBe(0);
  });

  it('still RELEASES a held name: 200 with returnsAt, and the address is gone', async () => {
    const t = await tenant([{ seedSource: 'organization', state: 'connected' }]);
    await holdName(t.workspaceId, 'acme');

    const res = await as(t).del();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { returnsAt: string | null };
    expect(typeof body.returnsAt).toBe('string');
    expect(await addresses(t.workspaceId)).toEqual([]);
  });
});

describe('the route against a workspace with a Motir repository — as before the rule', () => {
  it('claims (201), renames (200) and releases (200)', async () => {
    const t = await tenant([{}]);
    const api = as(t);

    const claimed = await api.put('acme');
    expect(claimed.status).toBe(201);
    expect(await claimed.json()).toMatchObject({ hostname: `acme.${BASE}` });

    // A rename right after a first claim is inside the 24-hour grace, so it is
    // not a held change and the 30-day limit does not stop it.
    const renamed = await api.put('acme-labs');
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ label: 'acme-labs' });

    await adminDb.publicSubdomainChange.deleteMany({ where: { workspaceId: t.workspaceId } });
    expect((await api.del()).status).toBe(200);
    expect(await addresses(t.workspaceId)).toEqual([]);
  });
});

// ── One predicate, three readers ────────────────────────────────────────────

describe('getClaimEligibility, the route and the pane agree, shape by shape', () => {
  it.each(SHAPES)('$name → eligible: $eligible', async ({ rows, eligible }) => {
    const t = await tenant(rows);

    const answer = await publicSubdomainService.getClaimEligibility(t.workspaceId, t.ownerId);
    expect(answer).toEqual({ eligible });
    expect(await paneEligible(t)).toBe(eligible);

    const res = await as(t).put('acme');
    if (eligible) {
      expect(res.status).toBe(201);
    } else {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: INELIGIBLE });
    }
  });
});

// ── The migration against the rule ──────────────────────────────────────────

describe('the shipped stray-claim migration', () => {
  /** One held claim per shape, labelled by its index. */
  async function seedAllShapes() {
    const seeded: Array<{ t: { workspaceId: string; ownerId: string }; label: string }> = [];
    for (const [i, shape] of SHAPES.entries()) {
      const t = await tenant(shape.rows);
      const label = `shape-${i}`;
      await holdName(t.workspaceId, label);
      seeded.push({ t, label });
    }
    return seeded;
  }

  it('deletes exactly the claims getClaimEligibility calls ineligible, and writes no hold and no ledger row', async () => {
    const seeded = await seedAllShapes();

    const ineligible = new Set<string>();
    for (const { t, label } of seeded) {
      const { eligible } = await publicSubdomainService.getClaimEligibility(
        t.workspaceId,
        t.ownerId,
      );
      if (!eligible) ineligible.add(label);
    }
    // Only the last shape is a Motir repository.
    expect(ineligible.size).toBe(SHAPES.length - 1);

    await runMigration();

    const survivors = await adminDb.publicAddress.findMany({
      where: { kind: 'workspace_subdomain' },
    });
    const deleted = new Set(
      seeded
        .map((s) => s.label)
        .filter((l) => !survivors.some((r) => r.hostname === `${l}.${BASE}`)),
    );
    // SQL predicate and service predicate select the same workspaces.
    expect(deleted).toEqual(ineligible);
    expect(survivors.map((r) => r.hostname)).toEqual([`shape-${SHAPES.length - 1}.${BASE}`]);

    for (const { t, label } of seeded.filter((s) => ineligible.has(s.label))) {
      expect(
        await adminDb.publicHostnameReservation.count({
          where: { hostnameHash: hostnameReservationHash(`${label}.${BASE}`) },
        }),
      ).toBe(0);
      expect(
        await adminDb.publicSubdomainChange.count({ where: { workspaceId: t.workspaceId } }),
      ).toBe(0);
    }
  });

  it('leaves a deleted label claimable at once by an eligible workspace through the route', async () => {
    const stray = await tenant([{ seedSource: 'organization', state: 'connected' }]);
    await holdName(stray.workspaceId, 'roadmap');
    await runMigration();
    expect(await addresses(stray.workspaceId)).toEqual([]);

    const claimant = await tenant([{}]);
    const res = await as(claimant).put('roadmap');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ hostname: `roadmap.${BASE}` });
  });

  it('changes nothing on a second run', async () => {
    await seedAllShapes();
    await runMigration();
    const after = await adminDb.publicAddress.findMany({ orderBy: { hostname: 'asc' } });
    const holds = await adminDb.publicHostnameReservation.count();

    await runMigration();

    expect(await adminDb.publicAddress.findMany({ orderBy: { hostname: 'asc' } })).toEqual(after);
    expect(await adminDb.publicHostnameReservation.count()).toBe(holds);
  });
});
