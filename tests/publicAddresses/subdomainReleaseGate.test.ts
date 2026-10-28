import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE STORY-LEVEL RELEASE GATE — Story MOTIR-4451 · Subtask MOTIR-4456.
//
// ⚠️ WHAT MAKES THIS NOT A SECOND COPY OF `publicSubdomainService.test.ts`.
// That suite is MOTIR-4454's per-card floor and it exercises the SERVICE: it
// calls `publicSubdomainService.release()` directly, with the workspace context
// the service opens for itself. This file drives the same behaviour **through
// the ROUTE**, so what is under test is the assembly — the handler, the service,
// both repositories, the RLS binding a REQUEST establishes, and the address
// resolution — agreeing with each other. Several assertions read alike and none
// of them is redundant: a service can be correct while the route mis-maps its
// error, binds the wrong context, or leaves `GET` answering the old shape.
//
// Real Postgres throughout, per the repo convention: the transaction IS the
// thing under test, so a mocked repository standing in for it would assert the
// fixture rather than the code.
//
// We stub ONLY `getWorkspaceContext` — the session + active-workspace resolver
// the routes read, which the test environment cannot supply (no cookies). The
// mock is PARTIAL (`importOriginal`), so the real `withWorkspaceContext` — the
// RLS-binding transaction every service call below depends on — is preserved
// untouched. Same exception `tests/ready/ready-routes.test.ts` takes, for the
// same reason.

const ctxRef = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

// ⚠️ THE CERTIFICATE PROVIDER, SPIED SO ITS SILENCE IS ASSERTABLE. The nearest
// neighbour to `release` is `customDomainService.remove`, which withdraws a
// certificate; a workspace subdomain is covered by the wildcard `*.<base>`
// (ADR §6), so claiming one issues nothing and releasing one withdraws nothing.
const { certificateProviderSpy } = vi.hoisted(() => ({ certificateProviderSpy: vi.fn() }));
vi.mock('@/lib/publicAddresses/certificateProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  certificateProvider: certificateProviderSpy,
}));

const { db } = await import('@/lib/db');
const { GET, PUT, DELETE } =
  await import('@/app/api/workspaces/[workspaceId]/public-subdomain/route');
const { publicAddressesService } = await import('@/lib/services/publicAddressesService');
const { publicHostnameReservationRepository } =
  await import('@/lib/repositories/publicHostnameReservationRepository');
const { hostnameReservationHash } = await import('@/lib/publicAddresses/hostnameReservation');
const { publicSiteOrigin, publicProjectPath } = await import('@/lib/publicProjects/urls');
const { createTestWorkspace, createTestUser } = await import('../fixtures');

const BASE = 'motir.example';
const ORIGIN = 'https://app.motir.co';

interface Fixture {
  workspaceId: string;
  ownerId: string;
  projectId: string;
  identifier: string;
}

let fx: Fixture;

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  // ⚠️ `projectAccessData('public')`. `addressesForProject` reads the address rows
  // through the `db` SINGLETON, gated by `public_address_public_read` — on a
  // private project that read returns EMPTY and the service answers the
  // `motir.co` fallback, which is the same value a correct release produces. A
  // private fixture would make the released half pass for the wrong reason.
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Roadmap',
      slug: 'roadmap',
      identifier: 'ROADMAP',
      ...projectAccessData('public'),
    },
  });
  fx = {
    workspaceId: workspace.id,
    ownerId: owner.id,
    projectId: project.id,
    identifier: project.identifier,
  };
  ctxRef.current = { userId: owner.id, workspaceId: workspace.id };
  certificateProviderSpy.mockClear();
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
  ctxRef.current = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const params = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) });

function req(method: string, body?: unknown): Request {
  return new Request(`${ORIGIN}/api/workspaces/x/public-subdomain`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Claim through the ROUTE, then rename through it — the assembled setup. */
async function claimAndRename(...labels: readonly string[]): Promise<void> {
  for (const label of labels) {
    const res = await PUT(req('PUT', { label }), params(fx.workspaceId));
    expect([200, 201]).toContain(res.status);
  }
}

/**
 * Age the live subdomain by `days`, so a release holds its name (§8 Amendment 3
 * rule 3: a label held 24 hours or more is quarantined). The route reads the real
 * clock, so the row is moved instead.
 */
async function ageLiveSubdomain(days: number): Promise<void> {
  const live = await adminDb.publicAddress.findFirstOrThrow({
    where: { workspaceId: fx.workspaceId, kind: 'workspace_subdomain' },
  });
  await adminDb.publicAddress.update({
    where: { id: live.id },
    data: { createdAt: new Date(live.createdAt.getTime() - days * 24 * 60 * 60 * 1000) },
  });
}

async function addressRows() {
  return adminDb.publicAddress.findMany({
    where: { workspaceId: fx.workspaceId },
    orderBy: { createdAt: 'asc' },
  });
}

async function reservedHashes(): Promise<string[]> {
  const rows = await adminDb.publicHostnameReservation.findMany({
    where: { retiredFromWorkspaceId: fx.workspaceId },
  });
  return rows.map((r) => r.hostnameHash).sort();
}

describe('the release, driven through DELETE', () => {
  it('answers 204 with no body, stops serving the live label, and holds its name', async () => {
    await claimAndRename('acme');
    await ageLiveSubdomain(2);

    const res = await DELETE(req('DELETE'), params(fx.workspaceId));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    expect(await addressRows()).toHaveLength(0);
    expect(await reservedHashes()).toEqual([hostnameReservationHash(`acme.${BASE}`)]);
  });

  it('RESERVES BEFORE IT DELETES — a failing reserve leaves every row standing', async () => {
    // The assembled form of MOTIR-4454's ordering test: the failure is driven
    // from inside a real request, so it also proves the route does not swallow
    // it into a 2xx. A release that committed the delete and lost the reserve
    // would hand the label back to the global namespace — §8's exact prohibition
    // — and there is no repair, because the row that knew the hostname is gone.
    await claimAndRename('acme');
    await ageLiveSubdomain(2);
    const boom = new Error('reserveMany exploded');
    vi.spyOn(publicHostnameReservationRepository, 'reserveMany').mockRejectedValueOnce(boom);

    await expect(DELETE(req('DELETE'), params(fx.workspaceId))).rejects.toBe(boom);

    expect(await addressRows()).toHaveLength(1);
    expect(await reservedHashes()).toEqual([]);
  });

  it('leaves a CUSTOM DOMAIN untouched — still issued, and still the promoted primary', async () => {
    await claimAndRename('acme');
    const custom = await adminDb.publicAddress.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'custom_domain',
        hostname: 'roadmap.acme.example',
        status: 'issued',
      },
    });
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { primaryAddressId: custom.id },
    });

    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);

    const rows = await addressRows();
    expect(rows.map((r) => r.kind)).toEqual(['custom_domain']);
    expect(rows[0]?.status).toBe('issued');
    expect(
      (await adminDb.project.findUnique({ where: { id: fx.projectId } }))?.primaryAddressId,
      'a promoted custom domain stays the canonical — release changes nothing for it',
    ).toBe(custom.id);
    expect(
      await adminDb.publicHostnameReservation.count({
        where: { hostnameHash: hostnameReservationHash('roadmap.acme.example') },
      }),
      "reserving a name we do not own is a hostage, not a protection (`reservesItsHostname`'s own reason)",
    ).toBe(0);
  });

  it('makes NO certificate-provider call — the wildcard issued nothing to withdraw', async () => {
    await claimAndRename('acme');
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);
    expect(certificateProviderSpy).not.toHaveBeenCalled();
  });
});

describe('what the rest of the system then says — through the SERVICES, never row reads', () => {
  it('returns the projects to the motir.co path, and reports no host for them', async () => {
    // A row read would pass while the resolution disagreed, and the resolution
    // is the thing a visitor meets.
    await claimAndRename('acme');
    expect(
      (
        await publicAddressesService.addressesForProject(
          fx.projectId,
          fx.workspaceId,
          fx.identifier,
        )
      ).primary,
    ).toBe(`https://acme.${BASE}/${fx.identifier}`);

    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);

    const after = await publicAddressesService.addressesForProject(
      fx.projectId,
      fx.workspaceId,
      fx.identifier,
    );
    expect(after.primary, "ADR §7's default-primary table takes its first row again").toBe(
      `${publicSiteOrigin()}${publicProjectPath(fx.identifier)}`,
    );
    expect(after.alternates).toEqual([]);
    expect(
      await publicAddressesService.primaryHostsForProjects([
        { id: fx.projectId, workspaceId: fx.workspaceId, identifier: fx.identifier },
      ]),
      'no host means the per-host sitemap filter matches this project on motir.co again',
    ).toEqual(new Map());
  });
});

describe('the reservation doing its job, through PUT', () => {
  it('refuses a re-claim of a held name with 409 and the date it returns', async () => {
    await claimAndRename('acme');
    await ageLiveSubdomain(2);
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);

    const other = await createTestWorkspace({ name: 'Rival' });
    ctxRef.current = { userId: other.owner.id, workspaceId: other.workspace.id };
    const res = await PUT(req('PUT', { label: 'acme' }), params(other.workspace.id));
    expect(res.status, 'a held name stays unclaimable until its hold ends').toBe(409);
    const body = (await res.json()) as { code: string; returnsAt: string };
    expect(body.code).toBe('NAME_QUARANTINED');
    expect(new Date(body.returnsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves a DIFFERENT label claimable, so the refusal is specific and not a lock', async () => {
    await claimAndRename('acme');
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);
    const other = await createTestWorkspace({ name: 'Rival' });
    ctxRef.current = { userId: other.owner.id, workspaceId: other.workspace.id };
    expect((await PUT(req('PUT', { label: 'acme-two' }), params(other.workspace.id))).status).toBe(
      201,
    );
  });
});

describe('the route contract, and the two verbs it joins', () => {
  it('answers 404 when nothing is claimed — NOT the rename path 409', async () => {
    // Two typed errors, two statuses, one mapping each: a DELETE names a
    // resource, so absent is 404; a PUT that renames refuses a premise.
    const res = await DELETE(req('DELETE'), params(fx.workspaceId));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'SUBDOMAIN_NOT_FOUND' });
  });

  it('gives a member without address management the SAME refusal PUT gives', async () => {
    await claimAndRename('acme');
    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    ctxRef.current = { userId: member.id, workspaceId: fx.workspaceId };

    const del = await DELETE(req('DELETE'), params(fx.workspaceId));
    const put = await PUT(req('PUT', { label: 'acme-inc' }), params(fx.workspaceId));
    expect(del.status).toBe(403);
    expect(put.status).toBe(403);
    expect(await del.json()).toMatchObject({ code: 'SUBDOMAIN_FORBIDDEN' });
    expect(await addressRows(), 'a refused release deletes nothing').toHaveLength(1);
  });

  it('answers a NON-MEMBER with the no-existence-leak 404, and releases nothing', async () => {
    // RLS + the membership gate together: the whole path runs bound, so a member
    // of another workspace cannot reach this one's addresses at all.
    await claimAndRename('acme');
    const stranger = await createTestUser();
    ctxRef.current = { userId: stranger.id, workspaceId: fx.workspaceId };
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(404);
    expect(await addressRows()).toHaveLength(1);
  });

  it('drives claim, rename, the 30-day limit and release through GET, PUT and DELETE', async () => {
    const claim = await PUT(req('PUT', { label: 'acme' }), params(fx.workspaceId));
    expect(claim.status).toBe(201);
    expect(await claim.json()).toMatchObject({
      hostname: `acme.${BASE}`,
      nextChangeAllowedAt: null,
    });

    const rename = await PUT(req('PUT', { label: 'acme-inc' }), params(fx.workspaceId));
    expect(rename.status).toBe(200);
    const renamed = (await rename.json()) as { hostname: string; nextChangeAllowedAt: string };
    expect(renamed.hostname).toBe(`acme-inc.${BASE}`);
    expect(renamed.nextChangeAllowedAt).toEqual(expect.any(String));

    const read = await GET(req('GET'), params(fx.workspaceId));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ hostname: `acme-inc.${BASE}` });

    // A release right after the rename is a second change inside 30 days.
    const early = await DELETE(req('DELETE'), params(fx.workspaceId));
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({
      code: 'SUBDOMAIN_CHANGE_LIMIT',
      nextAllowedAt: renamed.nextChangeAllowedAt,
    });

    await adminDb.publicSubdomainChange.update({
      where: { workspaceId: fx.workspaceId },
      data: { lastChangedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);
    const afterRelease = await GET(req('GET'), params(fx.workspaceId));
    expect(afterRelease.status).toBe(200);
    expect(await afterRelease.json(), 'the pane reads back as unclaimed').toBeNull();
  });
});

describe('the 30-day limit after a release (§8 Amendment 3 rule 4)', () => {
  it('is not reset by release then claim — the claim is free, the next rename is refused', async () => {
    // Asserted through the route, so the refusal the PANE receives is the one
    // under test.
    await claimAndRename('a-one');
    expect((await DELETE(req('DELETE'), params(fx.workspaceId))).status).toBe(204);

    const reclaim = await PUT(req('PUT', { label: 'b-one' }), params(fx.workspaceId));
    expect(reclaim.status).toBe(201);
    expect(await reclaim.json()).toMatchObject({ nextChangeAllowedAt: expect.any(String) });

    const rename = await PUT(req('PUT', { label: 'b-two' }), params(fx.workspaceId));
    expect(rename.status).toBe(409);
    expect(await rename.json()).toMatchObject({ code: 'SUBDOMAIN_CHANGE_LIMIT' });
  });
});
