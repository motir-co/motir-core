import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { RawPlatformUsageOrgs, RawSpendRow, SpendListSort } from '@/lib/ai/motirAiClient';

/**
 * The Tenants list (Story MOTIR-727 · MOTIR-7287, design D10) —
 * `platformUsageService.listTenants` over the real database, motir-ai's
 * `/v1/platform/usage/orgs` faked by a stub that keyset-pages like the real route.
 * The stub holds a row ONLY for the organizations it is given, as the real rollup
 * holds one only for an organization that spent something (MOTIR-8978).
 */

let currentPrincipal: PlatformPrincipal | null = null;
const orgsMock = vi.fn<(q: Record<string, unknown>) => Promise<RawPlatformUsageOrgs>>();

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum))
          throw new NotPlatformStaffError();
        return currentPrincipal;
      },
    ),
  };
});

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return { ...actual, getPlatformUsageOrgs: (q: Record<string, unknown>) => orgsMock(q) };
});

const { db } = await import('@/lib/db');
const {
  platformUsageService,
  parseTenantSort,
  decodeTenantCursor,
  zeroSpendRow,
  TENANT_LIST_PAGE,
  TENANT_ZERO_SPEND_SCAN,
} = await import('@/lib/services/platformUsageService');
const { platformOrganizationRepository } =
  await import('@/lib/repositories/platformOrganizationRepository');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

function spendRow(entityId: string, i: number): RawSpendRow {
  return {
    entityId,
    credits: {
      planning_tokens: (i * 7) % 11,
      agent_tokens: i,
      agent_machine: 0,
      agent_instance: 0,
      agent_storage: 0,
      // A sort column whose values TIE across orgs, so the tiebreak is exercised.
      ci: i % 3,
      search: 0,
      hosting_production: 0,
    },
    indexingSeconds: i * 60,
    chargedCredits: ((i * 7) % 11) + i + (i % 3),
    costMicroUsd: (i * 13) % 17,
    cost: {
      planning_tokens: 0,
      agent_tokens: 0,
      agent_machine: 0,
      agent_instance: 0,
      agent_storage: 0,
      ci: 0,
      search: 0,
      hosting_production: 0,
      indexing: 0,
    },
  };
}

const sortValue = (r: RawSpendRow, sort: SpendListSort): number =>
  sort === 'cost'
    ? r.costMicroUsd
    : sort === 'charged'
      ? r.chargedCredits
      : sort === 'indexing'
        ? r.indexingSeconds
        : r.credits[sort];

/** A faithful stub of the route: sort desc, entityId tiebreak, keyset cursor, id filter, estate over ALL. */
function stubRoute(all: RawSpendRow[]) {
  orgsMock.mockImplementation(async (q) => {
    const sort = (q['sort'] as SpendListSort) ?? 'cost';
    const ids = q['coreOrganizationIds'] as string[] | undefined | null;
    const pool = ids ? all.filter((r) => ids.includes(r.entityId)) : all;
    const ordered = [...pool].sort(
      (a, b) => sortValue(b, sort) - sortValue(a, sort) || (a.entityId < b.entityId ? 1 : -1),
    );
    const start = q['cursor'] ? Number(q['cursor']) : 0;
    const limit = q['limit'] as number;
    const items = ordered.slice(start, start + limit);
    const estate = spendRow('platform', 0);
    estate.chargedCredits = all.reduce((s, r) => s + r.chargedCredits, 0);
    estate.costMicroUsd = all.reduce((s, r) => s + r.costMicroUsd, 0);
    return {
      period: q['period'] as string,
      sort,
      items,
      nextCursor: start + limit < ordered.length ? String(start + limit) : null,
      estate,
    };
  });
}

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+tenants@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  orgsMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedOrgs(names: string[]) {
  const orgs: { id: string; name: string }[] = [];
  for (const name of names) {
    const { workspace } = await createTestWorkspace({ name });
    const org = await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { name },
    });
    orgs.push({ id: org.id, name: org.name });
  }
  return orgs;
}

/**
 * Organizations straight into the table — fast enough to seed past the zero-spend
 * tail's scan window — one second apart, except that every org at `i ≡ 1 (mod 4)`
 * shares its predecessor's `createdAt`, so the id tiebreak is exercised. Returned
 * in the tail's own order, newest first.
 */
async function seedBareOrgs(count: number, prefix = 'Bare') {
  const base = Date.UTC(2026, 0, 1);
  await adminDb.organization.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      name: `${prefix} ${i}`,
      slug: `${prefix.toLowerCase()}-${i}`,
      createdAt: new Date(base + (i % 4 === 1 ? i - 1 : i) * 1000),
    })),
  });
  return adminDb.organization.findMany({
    where: { slug: { startsWith: `${prefix.toLowerCase()}-` } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, name: true },
  });
}

/** Every page Show more reaches for one query, with the rows in the order shown. */
async function pageThrough(query: { period: string; sort: SpendListSort; filter?: string }) {
  const ids: string[] = [];
  const estates: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const list = await platformUsageService.listTenants(currentPrincipal!, { ...query, cursor });
    expect(list.unavailable).toBe(false);
    ids.push(...list.rows.map((r) => r.organization!.id));
    estates.push(list.estate);
    cursor = list.nextCursor;
    pages += 1;
  } while (cursor && pages < 50);
  expect(cursor).toBeNull();
  return { ids, estates, pages };
}

describe('platformUsageService.listTenants', () => {
  it('lists every org on arrival — the estate total first, names joined — with ONE estate.read row', async () => {
    const orgs = await seedOrgs(['Acme', 'Bravo', 'Charlie']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));

    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-09',
      sort: 'cost',
    });
    expect(list.unavailable).toBe(false);
    expect(list.estate!.organization).toBeNull();
    expect(list.rows.map((r) => r.organization!.name).sort()).toEqual(['Acme', 'Bravo', 'Charlie']);
    expect(orgsMock).toHaveBeenCalledWith({
      period: '2026-09',
      sort: 'cost',
      limit: TENANT_LIST_PAGE,
      cursor: null,
    });

    const audit = await adminDb.platformAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'platform',
      targetLabel: 'tenants 2026-09',
    });
  });

  it.each<SpendListSort>(['cost', 'charged', 'ci'])(
    'sorted by %s, Show more pages through every org exactly once',
    async (sort) => {
      const orgs = await seedOrgs(
        Array.from({ length: TENANT_LIST_PAGE + 7 }, (_, i) => `Org ${i}`),
      );
      stubRoute(orgs.map((o, i) => spendRow(o.id, i)));

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const list = await platformUsageService.listTenants(currentPrincipal!, {
          period: 'all',
          sort,
          cursor,
        });
        seen.push(...list.rows.map((r) => r.organization!.id));
        cursor = list.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(seen).toHaveLength(orgs.length);
      expect(new Set(seen)).toEqual(new Set(orgs.map((o) => o.id)));
    },
  );

  it('a name/slug filter narrows BEFORE the remote read, and the estate row still describes the whole estate', async () => {
    const orgs = await seedOrgs(['Acme Labs', 'Acme Studio', 'Bravo']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));
    const whole = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-09',
      sort: 'cost',
    });

    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-09',
      sort: 'cost',
      filter: '  acme ',
    });
    const asked = orgsMock.mock.calls.at(-1)![0]['coreOrganizationIds'] as string[];
    expect(new Set(asked)).toEqual(new Set(orgs.slice(0, 2).map((o) => o.id)));
    expect(list.filter).toBe('acme');
    expect(list.rows.map((r) => r.organization!.name).sort()).toEqual(['Acme Labs', 'Acme Studio']);
    expect(list.estate).toEqual(whole.estate);
    expect(await adminDb.platformAuditLog.count()).toBe(2);
  });

  it('a filter matching no organization asks for none, and the estate row still stands', async () => {
    const orgs = await seedOrgs(['Acme']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));
    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-09',
      sort: 'cost',
      filter: 'zzz',
    });
    expect(orgsMock.mock.calls.at(-1)![0]['coreOrganizationIds']).toEqual([]);
    expect(list.rows).toEqual([]);
    expect(list.estate).not.toBeNull();
  });

  it('a one-character filter is no filter', async () => {
    const orgs = await seedOrgs(['Acme', 'Bravo']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));
    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
      filter: 'a',
    });
    expect(list.filter).toBe('');
    expect(list.rows).toHaveLength(2);
  });

  it('motir-ai unreachable is the error state — no throw — on both paths, each view audited once', async () => {
    await seedOrgs(['Acme']);
    orgsMock.mockRejectedValue(new Error('ECONNREFUSED'));
    for (const filter of ['', 'acme']) {
      const list = await platformUsageService.listTenants(currentPrincipal!, {
        period: 'all',
        sort: 'cost',
        filter,
      });
      expect(list).toMatchObject({ unavailable: true, estate: null, rows: [] });
    }
    expect(await adminDb.platformAuditLog.count()).toBe(2);
  });

  it('a read that throws inside the transaction writes no audit row', async () => {
    const orgs = await seedOrgs(['Acme']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));
    const spy = vi
      .spyOn(platformOrganizationRepository, 'findOrganizationsByIds')
      .mockRejectedValueOnce(new Error('boom'));
    await expect(
      platformUsageService.listTenants(currentPrincipal!, { period: 'all', sort: 'cost' }),
    ).rejects.toThrow('boom');
    spy.mockRestore();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('refuses a non-staff caller before reading or auditing', async () => {
    const principal = currentPrincipal!;
    currentPrincipal = null;
    await expect(
      platformUsageService.listTenants(principal, { period: 'all', sort: 'cost' }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(orgsMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('platformUsageService.listTenants — organizations that spent nothing (MOTIR-8978)', () => {
  it('a filter matching an org with no spend shows it at zero — the motir-ai page omits it — in ONE audited view', async () => {
    const orgs = await seedOrgs(['XYZ Labs', 'XYZ Studio', 'Bravo']);
    // Only "XYZ Studio" and "Bravo" spent; motir-ai has no row for "XYZ Labs".
    stubRoute([spendRow(orgs[1]!.id, 3), spendRow(orgs[2]!.id, 5)]);

    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-10',
      sort: 'cost',
      filter: 'xyz',
    });
    expect(list.unavailable).toBe(false);
    expect(list.rows.map((r) => r.organization!.name)).toEqual(['XYZ Studio', 'XYZ Labs']);
    const zero = list.rows[1]!;
    expect(zero).toMatchObject({
      organization: { id: orgs[0]!.id, name: 'XYZ Labs', slug: expect.any(String) },
      chargedCredits: 0,
      costMicroUsd: 0,
      indexingSeconds: 0,
    });
    expect(Object.values(zero.credits).every((v) => v === 0)).toBe(true);
    expect(list.nextCursor).toBeNull();
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('a filter matching ONLY zero-spend orgs still lists them, and the estate total still describes every org', async () => {
    const orgs = await seedOrgs(['Quiet One', 'Quiet Two', 'Loud']);
    stubRoute([spendRow(orgs[2]!.id, 9)]);
    const whole = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'charged',
    });
    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'charged',
      filter: 'quiet',
    });
    expect(list.rows.map((r) => r.organization!.name).sort()).toEqual(['Quiet One', 'Quiet Two']);
    expect(list.estate).toEqual(whole.estate);
    expect(list.estate!.chargedCredits).toBe(spendRow(orgs[2]!.id, 9).chargedCredits);
  });

  it.each<SpendListSort>(['cost', 'ci'])(
    'sorted by %s, Show more reaches every org — spenders first, then the zero-spend tail — each exactly once, one audit row per view',
    async (sort) => {
      const spenders = await seedOrgs(
        Array.from({ length: TENANT_LIST_PAGE + 7 }, (_, i) => `Spender ${i}`),
      );
      const quiet = await seedBareOrgs(TENANT_LIST_PAGE + 13);
      stubRoute(spenders.map((o, i) => spendRow(o.id, i)));

      const { ids, estates, pages } = await pageThrough({ period: '2026-10', sort });
      expect(ids).toHaveLength(spenders.length + quiet.length);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(ids)).toEqual(new Set([...spenders, ...quiet].map((o) => o.id)));
      // The spend run comes first, whole; the seam falls inside page 2.
      expect(new Set(ids.slice(0, spenders.length))).toEqual(new Set(spenders.map((o) => o.id)));
      expect(pages).toBe(3);
      // Every view carries the same estate total, and writes exactly one audit row.
      expect(new Set(estates.map((e) => JSON.stringify(e))).size).toBe(1);
      const audit = await adminDb.platformAuditLog.findMany();
      expect(audit).toHaveLength(pages);
      expect(audit.every((a) => a.action === 'estate.read')).toBe(true);
    },
  );

  it('the tail is newest first, a createdAt tie broken by id, and pages past the scan window without a gap', async () => {
    const quiet = await seedBareOrgs(TENANT_ZERO_SPEND_SCAN + 31);
    // Most of the first scan window SPENT, so a view's window yields few zero rows.
    const spent = quiet.slice(0, TENANT_ZERO_SPEND_SCAN - 10);
    stubRoute(spent.map((o, i) => spendRow(o.id, i + 1)));

    const { ids } = await pageThrough({ period: 'all', sort: 'cost' });
    expect(new Set(ids)).toEqual(new Set(quiet.map((o) => o.id)));
    expect(ids).toHaveLength(quiet.length);

    const spentIds = new Set(spent.map((o) => o.id));
    const tail = ids.filter((id) => !spentIds.has(id));
    const expected = await adminDb.organization.findMany({
      where: { id: { notIn: [...spentIds] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    expect(tail).toEqual(expected.map((o) => o.id));
  });

  it('an estate where nobody spent shows a full first page of zero rows, not an empty list', async () => {
    const quiet = await seedBareOrgs(TENANT_LIST_PAGE + 2);
    stubRoute([]);
    const first = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-10',
      sort: 'cost',
    });
    expect(first.rows).toHaveLength(TENANT_LIST_PAGE);
    expect(first.nextCursor).toMatch(/^z\./);
    const second = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-10',
      sort: 'cost',
      cursor: first.nextCursor,
    });
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(second.estate).toEqual(first.estate);
    expect(new Set([...first.rows, ...second.rows].map((r) => r.organization!.id))).toEqual(
      new Set(quiet.map((o) => o.id)),
    );
  });

  it('a filter matching more zero-spend orgs than a page pages them through Show more', async () => {
    const quiet = await seedBareOrgs(TENANT_LIST_PAGE + 4, 'Hush');
    await seedOrgs(['Other']);
    stubRoute([spendRow(quiet[0]!.id, 4)]);
    const { ids, pages } = await pageThrough({ period: 'all', sort: 'cost', filter: 'hush' });
    expect(pages).toBe(2);
    expect(ids[0]).toBe(quiet[0]!.id);
    expect(new Set(ids)).toEqual(new Set(quiet.map((o) => o.id)));
    expect(ids).toHaveLength(quiet.length);
  });

  it('a full last spend page ends at the tail start only when a zero-spend org remains', async () => {
    const spenders = await seedBareOrgs(TENANT_LIST_PAGE, 'Full');
    stubRoute(spenders.map((o, i) => spendRow(o.id, i + 1)));
    const only = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
    });
    expect(only.rows).toHaveLength(TENANT_LIST_PAGE);
    expect(only.nextCursor).toBeNull();

    const [extra] = await seedBareOrgs(1, 'Late');
    const withExtra = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
    });
    expect(withExtra.rows).toHaveLength(TENANT_LIST_PAGE);
    expect(withExtra.nextCursor).toBe('z.');
    const tail = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
      cursor: withExtra.nextCursor,
    });
    expect(tail.rows.map((r) => r.organization!.id)).toEqual([extra!.id]);
    expect(tail.nextCursor).toBeNull();
  });

  it('motir-ai failing on the tail leaves the spend rows standing and resumes at the tail; failing in the tail is the error state', async () => {
    const orgs = await seedOrgs(['Acme', 'Quiet']);
    stubRoute([spendRow(orgs[0]!.id, 2)]);
    const real = orgsMock.getMockImplementation()!;
    orgsMock.mockImplementationOnce(real).mockRejectedValueOnce(new Error('ECONNRESET'));
    const first = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
    });
    expect(first.rows.map((r) => r.organization!.name)).toEqual(['Acme']);
    expect(first).toMatchObject({ unavailable: false, nextCursor: 'z.' });

    orgsMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const tail = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
      cursor: first.nextCursor,
    });
    expect(tail).toMatchObject({ unavailable: true, estate: null, rows: [], nextCursor: null });

    orgsMock.mockImplementationOnce(real).mockRejectedValueOnce(new Error('ECONNRESET'));
    const filtered = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
      filter: 'ac',
    });
    expect(filtered).toMatchObject({ unavailable: false, nextCursor: 'z.' });
    orgsMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const filteredTail = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
      filter: 'ac',
      cursor: 'z.',
    });
    expect(filteredTail).toMatchObject({ unavailable: true, rows: [], filterCapped: false });
    expect(await adminDb.platformAuditLog.count()).toBe(4);
  });
});

describe("platformUsageService.listTenants — the tail's edges (MOTIR-8978)", () => {
  it('a tail view with no candidate left still reads motir-ai once, for the estate total', async () => {
    const orgs = await seedOrgs(['Acme']);
    stubRoute([spendRow(orgs[0]!.id, 3)]);
    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
      filter: 'zzz',
      cursor: 'z.',
    });
    expect(orgsMock.mock.calls.at(-1)![0]['coreOrganizationIds']).toEqual([]);
    expect(list).toMatchObject({ unavailable: false, rows: [], nextCursor: null });
    expect(list.estate!.chargedCredits).toBe(spendRow(orgs[0]!.id, 3).chargedCredits);
  });

  it('a spend row for an id motir-core does not hold is still listed, named by its id', async () => {
    stubRoute([spendRow('org_gone', 4)]);
    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
    });
    expect(list.rows).toEqual([
      expect.objectContaining({
        organization: {
          id: 'org_gone',
          name: 'org_gone',
          slug: null,
          isMeta: false,
          internalBilling: false,
        },
      }),
    ]);
    expect(list.nextCursor).toBeNull();
  });
});

describe('decodeTenantCursor', () => {
  it('reads both runs, a pre-tail motir-ai cursor as the spend run, and an undecodable tail key as the start', () => {
    expect(decodeTenantCursor(null)).toEqual({ phase: 'spend', remote: null });
    expect(decodeTenantCursor('')).toEqual({ phase: 'spend', remote: null });
    expect(decodeTenantCursor('s.abc')).toEqual({ phase: 'spend', remote: 'abc' });
    expect(decodeTenantCursor('s.')).toEqual({ phase: 'spend', remote: null });
    expect(decodeTenantCursor('legacy-cursor')).toEqual({
      phase: 'spend',
      remote: 'legacy-cursor',
    });
    expect(decodeTenantCursor('z.')).toEqual({ phase: 'zero', after: null });
    const key = Buffer.from('2026-10-19T09:06:36.098Z|org_1').toString('base64url');
    expect(decodeTenantCursor(`z.${key}`)).toEqual({
      phase: 'zero',
      after: { createdAt: new Date('2026-10-19T09:06:36.098Z'), id: 'org_1' },
    });
    for (const bad of [
      'not a date|org_1',
      '2026-10-19T09:06:36.098Z|',
      '2026-10-19T09:06:36.098Z',
      'a|b|c',
    ]) {
      const raw = `z.${Buffer.from(bad).toString('base64url')}`;
      expect(decodeTenantCursor(raw)).toEqual({ phase: 'spend', remote: null });
    }
  });
});

describe('zeroSpendRow', () => {
  it('is zero in every charged category, every cost category and both totals', () => {
    const row = zeroSpendRow('org_1');
    expect(row.entityId).toBe('org_1');
    expect(Object.keys(row.credits)).not.toContain('indexing');
    expect(Object.keys(row.cost)).toContain('indexing');
    expect([...Object.values(row.credits), ...Object.values(row.cost)].every((v) => v === 0)).toBe(
      true,
    );
    expect(row).toMatchObject({ indexingSeconds: 0, chargedCredits: 0, costMicroUsd: 0 });
  });
});

describe('parseTenantSort', () => {
  it('takes cost, charged and the eight categories; anything else is cost', () => {
    expect(parseTenantSort('charged')).toBe('charged');
    expect(parseTenantSort('indexing')).toBe('indexing');
    expect(parseTenantSort('nope')).toBe('cost');
    expect(parseTenantSort(undefined)).toBe('cost');
  });
});
