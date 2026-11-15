import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRepoState, ProjectRepoTakeoverState } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { seedMotirRepository } from '../helpers/motirRepository';

// WHO MAY CLAIM OR RENAME A TENANT SUBDOMAIN — §8 Amendment 5, Story MOTIR-11283
// · Subtask MOTIR-11285.
//
// A `motir.site` name serves applications Motir HOSTS, and Motir hosts only
// repositories it created in its own organisation. So `claim` and `rename`
// refuse a workspace with no Motir repository, `getClaimEligibility` answers the
// same predicate to the pane, and `release` is never gated.
//
// Real Postgres throughout (the no-mocks rule): the predicate is a Prisma filter
// with a NULL arm, and only the database can say whether `NOT IN` dropped the
// NULL rows. The route half stubs ONLY `getWorkspaceContext` (no cookies in the
// test environment), keeping the real RLS-binding `withWorkspaceContext`.

const ctxRef = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { PUT } = await import('@/app/api/workspaces/[workspaceId]/public-subdomain/route');
const { createTestWorkspace, createTestUser } = await import('../fixtures');
const {
  ReservedLabelError,
  SubdomainForbiddenError,
  SubdomainRequiresMotirRepositoryError,
  WorkspaceNotVisibleError,
} = await import('@/lib/publicAddresses/errors');

const BASE = 'motir.example';
const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  workspaceId: string;
  ownerId: string;
}

let fx: Fixture;

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  fx = { workspaceId: workspace.id, ownerId: owner.id };
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

/** Everything a refused claim or rename must leave untouched. */
async function snapshot(workspaceId: string) {
  return {
    addresses: await adminDb.publicAddress.findMany({
      where: { workspaceId },
      orderBy: { hostname: 'asc' },
    }),
    reservations: await adminDb.publicHostnameReservation.findMany({
      orderBy: { hostnameHash: 'asc' },
    }),
    ledger: await adminDb.publicSubdomainChange.findMany({ where: { workspaceId } }),
  };
}

/** Seed a held name directly, as the acceptance seeds do — never through `claim`. */
async function holdName(workspaceId: string, label: string, createdAt: Date) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId,
      kind: 'workspace_subdomain',
      status: 'active',
      hostname: `${label}.${BASE}`,
      createdAt,
    },
  });
}

async function refusal(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/** Make `userId` a plain member of the workspace. */
async function addMember(workspaceId: string, userId: string) {
  await adminDb.workspaceMembership.create({
    data: { workspaceId, userId, workspaceRole: 'member' },
  });
}

// ── The predicate, shape by shape ───────────────────────────────────────────

interface Shape {
  name: string;
  rows: Array<{
    seedSource?: string;
    state?: ProjectRepoState;
    takeoverState?: ProjectRepoTakeoverState | null;
  }>;
  eligible: boolean;
}

const SHAPES: Shape[] = [
  { name: 'no repository row at all', rows: [], eligible: false },
  {
    name: 'only an imported (organization) row, created',
    rows: [{ seedSource: 'organization', state: 'created' }],
    eligible: false,
  },
  {
    name: 'only an imported (organization) row, connected',
    rows: [{ seedSource: 'organization', state: 'connected' }],
    eligible: false,
  },
  { name: 'a proposed Motir row', rows: [{ state: 'proposed' }], eligible: false },
  { name: 'a creating Motir row', rows: [{ state: 'creating' }], eligible: false },
  { name: 'a failed Motir row', rows: [{ state: 'failed' }], eligible: false },
  { name: 'a skipped Motir row', rows: [{ state: 'skipped' }], eligible: false },
  {
    name: 'a connected row with a starter seed source (the legacy mislabel)',
    rows: [{ state: 'connected' }],
    eligible: false,
  },
  {
    name: 'a created row transferred to awaiting_reinstall',
    rows: [{ takeoverState: 'awaiting_reinstall' }],
    eligible: false,
  },
  {
    name: 'a created row whose takeover is done',
    rows: [{ takeoverState: 'done' }],
    eligible: false,
  },
  { name: 'a created row with no takeover (NULL)', rows: [{}], eligible: true },
  {
    name: 'a created row whose takeover is only requested',
    rows: [{ takeoverState: 'requested' }],
    eligible: true,
  },
  {
    name: 'a created row whose transfer is pending',
    rows: [{ takeoverState: 'transfer_pending' }],
    eligible: true,
  },
  {
    name: 'a created row whose takeover failed',
    rows: [{ takeoverState: 'failed' }],
    eligible: true,
  },
  {
    name: 'a blank-seeded created row (any non-organization seed source counts)',
    rows: [{ seedSource: 'blank' }],
    eligible: true,
  },
  {
    name: 'an imported row beside a created Motir row',
    rows: [{ seedSource: 'organization', state: 'connected' }, {}],
    eligible: true,
  },
];

describe('the Motir-repository predicate — getClaimEligibility agrees with claim', () => {
  it.each(SHAPES)('$name → eligible: $eligible', async ({ rows, eligible }) => {
    for (const row of rows) await seedMotirRepository({ workspaceId: fx.workspaceId, ...row });

    expect(await publicSubdomainService.getClaimEligibility(fx.workspaceId, fx.ownerId)).toEqual({
      eligible,
    });

    const err = await refusal(publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId));
    if (eligible) {
      expect(err).toBeNull();
    } else {
      expect(err).toBeInstanceOf(SubdomainRequiresMotirRepositoryError);
      expect((err as Error & { code: string }).code).toBe('SUBDOMAIN_REQUIRES_MOTIR_REPOSITORY');
    }
  });

  it('does not count another workspace’s Motir repository', async () => {
    const other = await createTestWorkspace({ name: 'Globex' });
    await seedMotirRepository({ workspaceId: other.workspace.id });
    expect(await publicSubdomainService.getClaimEligibility(fx.workspaceId, fx.ownerId)).toEqual({
      eligible: false,
    });
  });
});

// ── The refusal: claim and rename, whatever the label ───────────────────────

describe('claim and rename on a workspace with no Motir repository', () => {
  beforeEach(async () => {
    await seedMotirRepository({ workspaceId: fx.workspaceId, seedSource: 'organization' });
  });

  it.each([
    ['a valid free label', 'acme'],
    ['a reserved label', 'admin'],
    ['a label the grammar refuses', 'Not A Label!'],
  ])('refuses a claim of %s, and writes nothing', async (_, label) => {
    const before = await snapshot(fx.workspaceId);
    const err = await refusal(publicSubdomainService.claim(fx.workspaceId, label, fx.ownerId));
    expect(err).toBeInstanceOf(SubdomainRequiresMotirRepositoryError);
    expect(err).not.toBeInstanceOf(ReservedLabelError);
    expect(await snapshot(fx.workspaceId)).toEqual(before);
  });

  it('refuses a rename of a held name whatever the label, and writes nothing', async () => {
    const now = new Date();
    await holdName(fx.workspaceId, 'acme', new Date(now.getTime() - 60 * DAY));
    const before = await snapshot(fx.workspaceId);

    for (const label of ['acme-inc', 'admin', 'Not A Label!']) {
      const err = await refusal(
        publicSubdomainService.rename(fx.workspaceId, label, fx.ownerId, now),
      );
      expect(err).toBeInstanceOf(SubdomainRequiresMotirRepositoryError);
    }
    expect(await snapshot(fx.workspaceId)).toEqual(before);
  });

  it('keeps the gates’ order: a non-member reads 404, a member 403', async () => {
    const stranger = await createTestUser();
    expect(
      await refusal(publicSubdomainService.claim(fx.workspaceId, 'acme', stranger.id)),
    ).toBeInstanceOf(WorkspaceNotVisibleError);

    const member = await createTestUser();
    await addMember(fx.workspaceId, member.id);
    expect(
      await refusal(publicSubdomainService.claim(fx.workspaceId, 'acme', member.id)),
    ).toBeInstanceOf(SubdomainForbiddenError);
    expect(
      await refusal(publicSubdomainService.rename(fx.workspaceId, 'acme', member.id)),
    ).toBeInstanceOf(SubdomainForbiddenError);
  });
});

// ── A held name, once the last Motir repository is gone ─────────────────────

describe('a workspace that holds a name and has lost its Motir repository', () => {
  it('still reads the name, is refused a rename, and may release it', async () => {
    const repo = await seedMotirRepository({ workspaceId: fx.workspaceId });
    const claimed = await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);

    // The takeover transfers the repository out of Motir's organisation.
    await adminDb.projectRepo.update({ where: { id: repo.id }, data: { takeoverState: 'done' } });

    expect(await publicSubdomainService.getClaimEligibility(fx.workspaceId, fx.ownerId)).toEqual({
      eligible: false,
    });
    // Nothing deleted the held name because the repository went.
    expect(await publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId)).toMatchObject({
      hostname: claimed.hostname,
    });

    const err = await refusal(
      publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId),
    );
    expect(err).toBeInstanceOf(SubdomainRequiresMotirRepositoryError);

    // Release is not gated (its 30-day limit is untouched: a first claim spends no change).
    const released = await publicSubdomainService.release(fx.workspaceId, fx.ownerId);
    expect(released).toEqual({ returnsAt: null });
    expect(await publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId)).toBeNull();
  });

  it('release still obeys the 30-day limit', async () => {
    await seedMotirRepository({ workspaceId: fx.workspaceId, takeoverState: 'done' });
    const now = new Date();
    await holdName(fx.workspaceId, 'acme', new Date(now.getTime() - 90 * DAY));
    await adminDb.publicSubdomainChange.create({
      data: { workspaceId: fx.workspaceId, lastChangedAt: new Date(now.getTime() - 3 * DAY) },
    });

    const err = (await refusal(
      publicSubdomainService.release(fx.workspaceId, fx.ownerId, now),
    )) as Error & { code?: string };
    expect(err?.code).toBe('SUBDOMAIN_CHANGE_LIMIT');
  });

  it('may still preview a change — advice is not refused on eligibility', async () => {
    await seedMotirRepository({ workspaceId: fx.workspaceId, seedSource: 'organization' });
    const now = new Date();
    await holdName(fx.workspaceId, 'acme', new Date(now.getTime() - 60 * DAY));
    expect(
      await publicSubdomainService.previewChange(fx.workspaceId, fx.ownerId, now),
    ).toMatchObject({
      host: `acme.${BASE}`,
      outcome: 'quarantine',
    });
  });
});

// ── The read the pane uses ──────────────────────────────────────────────────

describe('getClaimEligibility', () => {
  it('answers any member, and writes nothing', async () => {
    await seedMotirRepository({ workspaceId: fx.workspaceId });
    const member = await createTestUser();
    await addMember(fx.workspaceId, member.id);
    const before = await snapshot(fx.workspaceId);
    expect(await publicSubdomainService.getClaimEligibility(fx.workspaceId, member.id)).toEqual({
      eligible: true,
    });
    expect(await snapshot(fx.workspaceId)).toEqual(before);
  });

  it('refuses a non-member with the no-existence-leak 404', async () => {
    const stranger = await createTestUser();
    expect(
      await refusal(publicSubdomainService.getClaimEligibility(fx.workspaceId, stranger.id)),
    ).toBeInstanceOf(WorkspaceNotVisibleError);
  });

  it('is absent off-cloud, like getForWorkspace', async () => {
    delete process.env['MOTIR_CLOUD'];
    const err = (await refusal(
      publicSubdomainService.getClaimEligibility(fx.workspaceId, fx.ownerId),
    )) as Error;
    expect(err?.name).toBe('PublicAddressesUnavailableError');
  });
});

// ── On the wire ─────────────────────────────────────────────────────────────

describe('PUT /api/workspaces/[workspaceId]/public-subdomain', () => {
  const params = () => ({ params: Promise.resolve({ workspaceId: fx.workspaceId }) });
  const put = (label: string) =>
    new Request('https://app.motir.co/x', { method: 'PUT', body: JSON.stringify({ label }) });

  beforeEach(async () => {
    await seedMotirRepository({ workspaceId: fx.workspaceId, seedSource: 'organization' });
  });

  it('answers a claim 409 SUBDOMAIN_REQUIRES_MOTIR_REPOSITORY and creates no row', async () => {
    ctxRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    const res = await PUT(put('acme'), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SUBDOMAIN_REQUIRES_MOTIR_REPOSITORY' });
    expect(await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);
  });

  it('answers a rename 409 SUBDOMAIN_REQUIRES_MOTIR_REPOSITORY and keeps the held name', async () => {
    await holdName(fx.workspaceId, 'acme', new Date(Date.now() - 60 * DAY));
    ctxRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    const res = await PUT(put('acme-inc'), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'SUBDOMAIN_REQUIRES_MOTIR_REPOSITORY' });
    const rows = await adminDb.publicAddress.findMany({ where: { workspaceId: fx.workspaceId } });
    expect(rows.map((r) => r.hostname)).toEqual([`acme.${BASE}`]);
  });

  it('still answers a non-member 404 and a non-Manager member 403', async () => {
    const stranger = await createTestUser();
    ctxRef.current = { userId: stranger.id, workspaceId: fx.workspaceId };
    expect((await PUT(put('acme'), params())).status).toBe(404);

    const member = await createTestUser();
    await addMember(fx.workspaceId, member.id);
    ctxRef.current = { userId: member.id, workspaceId: fx.workspaceId };
    expect((await PUT(put('acme'), params())).status).toBe(403);
  });
});
