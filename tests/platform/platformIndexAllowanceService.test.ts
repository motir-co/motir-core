import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { IndexAllowanceSummary } from '@/lib/ciFleet/indexAllowance';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MONITORING · INDEX ALLOWANCE — the service (MOTIR-4595 · Story MOTIR-4335; design
// Panel 13 revision 2), against a REAL Postgres. motir-ai is the boundary leaf and
// the platform gate reads a session, so those two are mocked; the stopped-orgs roll-up,
// its paging, counts and search are real SQL over real rows.
//
// ⚠️ Motir does not charge for code indexing. The allowance is internal.

const summaryMock = vi.fn<(window?: string) => Promise<IndexAllowanceSummary | null>>();
const tiersMock = vi.fn<(ids: string[]) => Promise<Map<string, string | null> | null>>();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  fetchIndexAllowanceSummary: (w?: string) => summaryMock(w),
  fetchOrgTiers: (ids: string[]) => tiersMock(ids),
}));

let currentPrincipal: PlatformPrincipal;
const gate = vi.fn(async () => currentPrincipal);
vi.mock('@/lib/platform/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/auth')>()),
  requirePlatformStaff: () => gate(),
}));

const { platformIndexAllowanceService, readingFor, STOPPED_ORGS_PAGE_SIZE } =
  await import('@/lib/services/platformIndexAllowanceService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');

const DAY = 86_400_000;
const GRAPH = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
let seq = 0;

/** An organisation with `repos` connected repositories; returns its id and repo ids. */
async function seedOrg(name: string, repos = 1) {
  const owner = await createTestUser({ email: `idx-adm-${seq++}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: `inst-idx-${seq++}`,
      accountLogin: `acct${seq}`,
      accountType: 'Organization',
    },
    repos: Array.from({ length: repos }, (_, i) => ({
      providerRepoId: `${1000 + seq * 10 + i}`,
      owner: `acct${seq}`,
      name: `repo${i}`,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  const rows = await adminDb.githubRepo.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { name: 'asc' },
  });
  return { organizationId: workspace.organizationId, repoIds: rows.map((r) => r.id) };
}

async function pause(repoId: string, reason: string, daysAgo: number) {
  await adminDb.githubRepo.update({
    where: { id: repoId },
    data: { indexPausedReason: reason, indexPausedAt: new Date(Date.now() - daysAgo * DAY) },
  });
}

const SUMMARY: IndexAllowanceSummary = {
  window: '2026-09',
  ratio: 0.2,
  untieredOrgs: 0,
  tiers: [
    {
      tierKey: 'free',
      tierName: 'Free',
      cadence: 'one_time',
      allotmentCredits: 300,
      orgs: 1904,
      crossed: null,
      exhausted: 212,
      grantedCreditsPerOrg: 60,
      configured: true,
    },
    {
      tierKey: 'standard',
      tierName: 'Standard',
      cadence: 'monthly',
      allotmentCredits: 2000,
      orgs: 412,
      crossed: 37,
      exhausted: null,
      grantedCreditsPerOrg: 400,
      configured: true,
    },
    {
      tierKey: 'pro',
      tierName: 'Pro',
      cadence: 'monthly',
      allotmentCredits: 8000,
      orgs: 128,
      crossed: 41,
      exhausted: null,
      grantedCreditsPerOrg: 1600,
      configured: true,
    },
    {
      tierKey: 'enterprise',
      tierName: 'Enterprise',
      cadence: 'monthly',
      allotmentCredits: 0,
      orgs: 3,
      crossed: 0,
      exhausted: null,
      grantedCreditsPerOrg: null,
      configured: false,
    },
  ],
};

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  const staff = await createTestUser({ email: `ops+idx${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'support' };
  gate.mockClear();
  summaryMock.mockReset().mockResolvedValue(SUMMARY);
  tiersMock
    .mockReset()
    .mockImplementation(async (ids) => new Map(ids.map((id) => [id, 'standard'])));
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('INDEX_ALLOWANCE_RECALC_THRESHOLD_PCT', '');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function enabled(input: Parameters<typeof platformIndexAllowanceService.read>[1] = {}) {
  const dto = await platformIndexAllowanceService.read(currentPrincipal, input);
  if (dto.meter !== 'enabled') throw new Error('expected the meter enabled');
  return dto;
}

describe('the per-tier table (AC 1)', () => {
  it('computes each rate and reading against the threshold, and the Free row reads its EXHAUSTED count', async () => {
    const dto = await enabled();
    if (dto.summary.state !== 'read') throw new Error('expected a read summary');
    const byKey = Object.fromEntries(dto.summary.tiers.map((t) => [t.tierKey, t]));

    expect(dto.threshold).toEqual({ pct: 25, provisional: true });
    expect(byKey['standard']).toMatchObject({ reading: 'holds' });
    expect(byKey['standard']!.ratePct).toBeCloseTo(8.98, 1);
    expect(byKey['pro']).toMatchObject({ reading: 'recalculate' });
    expect(byKey['pro']!.ratePct).toBeCloseTo(32.03, 1);
    expect(byKey['free']).toMatchObject({ reading: 'hard_stop', crossed: null, exhausted: 212 });
    expect(byKey['enterprise']).toMatchObject({ reading: 'unconfigured' });
    expect(dto.summary).toMatchObject({
      tiersOverThreshold: 1,
      softGatedTiers: 2,
      oneTimeExhausted: 212,
    });
  });

  it('a configured threshold is not provisional, and moves the reading', async () => {
    vi.stubEnv('INDEX_ALLOWANCE_RECALC_THRESHOLD_PCT', '40');
    const dto = await enabled();
    expect(dto.threshold).toEqual({ pct: 40, provisional: false });
    if (dto.summary.state !== 'read') throw new Error('expected a read summary');
    expect(dto.summary.tiersOverThreshold).toBe(0);
  });

  it('a tier with no organisations has no rate and still holds', () => {
    expect(
      readingFor({ cadence: 'monthly', configured: true }, null, { pct: 25, provisional: true }),
    ).toBe('holds');
  });
});

describe('the Stopped orgs list (AC 4) — server-paged, filtered, searched, longest first', () => {
  it('pages 27 stopped orgs 25 + 2, with per-reason counts from the list’s OWN source', async () => {
    const created: { id: string; days: number; reason: string }[] = [];
    for (let i = 0; i < 27; i += 1) {
      const org = await seedOrg(`Stopped ${String(i).padStart(2, '0')}`);
      const reason = i < 7 ? 'paused_index_no_credit' : 'paused_index_allowance_exhausted';
      await pause(org.repoIds[0]!, reason, 30 - i);
      created.push({ id: org.organizationId, days: 30 - i, reason });
    }
    await seedOrg('Never stopped');

    const page1 = await enabled();
    expect(page1.stopped).toMatchObject({
      counts: { all: 27, noCredit: 7, allowanceExhausted: 20 },
      total: 27,
      page: 1,
      pageSize: STOPPED_ORGS_PAGE_SIZE,
      pageCount: 2,
    });
    expect(page1.stopped.rows).toHaveLength(25);
    // Longest-stopped first.
    expect(page1.stopped.rows[0]!.organizationId).toBe(created[0]!.id);
    const since = page1.stopped.rows.map((r) => r.stoppedSince);
    expect([...since].sort()).toEqual(since);

    const page2 = await enabled({ page: '2' });
    expect(page2.stopped.rows.map((r) => r.organizationId)).toEqual([
      created[25]!.id,
      created[26]!.id,
    ]);

    const noCredit = await enabled({ reason: 'no_credit' });
    expect(noCredit.stopped).toMatchObject({ filter: 'no_credit', total: 7, pageCount: 1 });
    expect(noCredit.stopped.rows.every((r) => r.reason === 'no_credit')).toBe(true);
    // The counts do not change with the filter — they are the filter's own labels.
    expect(noCredit.stopped.counts).toEqual(page1.stopped.counts);

    const clamped = await enabled({ page: '99' });
    expect(clamped.stopped.page).toBe(2);
    // The tier lookup is one batch per page, never one call per org.
    expect(tiersMock.mock.calls.every(([ids]) => ids.length <= STOPPED_ORGS_PAGE_SIZE)).toBe(true);
  }, 120_000);

  it('search narrows the page AND the counts to matching organisation names, with LIKE characters literal', async () => {
    await pause((await seedOrg('Hooli Labs')).repoIds[0]!, 'paused_index_allowance_exhausted', 9);
    await pause((await seedOrg('Globex')).repoIds[0]!, 'paused_index_no_credit', 3);
    await pause((await seedOrg('100% Hooli')).repoIds[0]!, 'paused_index_no_credit', 1);

    const hooli = await enabled({ q: 'hooli' });
    expect(hooli.stopped.rows.map((r) => r.organizationName).sort()).toEqual([
      '100% Hooli',
      'Hooli Labs',
    ]);
    expect(hooli.stopped.counts).toEqual({ all: 2, noCredit: 1, allowanceExhausted: 1 });

    const literal = await enabled({ q: '%' });
    expect(literal.stopped.rows.map((r) => r.organizationName)).toEqual(['100% Hooli']);
  }, 60_000);

  it('rolls an org’s paused repos into ONE row: longest pause, latest reason, most-behind CURRENT drift count', async () => {
    const org = await seedOrg('Multi', 3);
    await pause(org.repoIds[0]!, 'paused_index_no_credit', 5);
    await pause(org.repoIds[1]!, 'paused_index_allowance_exhausted', 1);
    await adminDb.githubRepo.update({
      where: { id: org.repoIds[0]! },
      data: {
        indexedHeadSha: GRAPH,
        defaultBranchHeadSha: HEAD,
        commitsBehind: 41,
        commitsBehindBaseSha: GRAPH,
        commitsBehindHeadSha: HEAD,
      },
    });
    // A STALE count — computed for a pair the row no longer has — is not a count.
    await adminDb.githubRepo.update({
      where: { id: org.repoIds[1]! },
      data: {
        indexedHeadSha: GRAPH,
        defaultBranchHeadSha: HEAD,
        commitsBehind: 900,
        commitsBehindBaseSha: 'c'.repeat(40),
        commitsBehindHeadSha: HEAD,
      },
    });
    const unpausedHuge = org.repoIds[2]!;
    await adminDb.githubRepo.update({
      where: { id: unpausedHuge },
      data: {
        indexedHeadSha: GRAPH,
        defaultBranchHeadSha: HEAD,
        commitsBehind: 5000,
        commitsBehindBaseSha: GRAPH,
        commitsBehindHeadSha: HEAD,
      },
    });
    await pause((await seedOrg('Uncounted')).repoIds[0]!, 'paused_index_no_credit', 2);

    const dto = await enabled();
    const multi = dto.stopped.rows.find((r) => r.organizationName === 'Multi')!;
    expect(multi).toMatchObject({ reason: 'allowance_exhausted', pausedRepos: 2, graphBehind: 41 });
    expect(Date.now() - new Date(multi.stoppedSince).getTime()).toBeGreaterThan(4.9 * DAY);
    expect(
      dto.stopped.rows.find((r) => r.organizationName === 'Uncounted')!.graphBehind,
    ).toBeNull();
    expect(dto.stopped.counts.all).toBe(2);
  }, 60_000);

  it('an archived repository’s pause is not a stopped org', async () => {
    const org = await seedOrg('Archived only');
    await pause(org.repoIds[0]!, 'paused_index_no_credit', 4);
    await adminDb.githubRepo.update({ where: { id: org.repoIds[0]! }, data: { archived: true } });
    expect((await enabled()).stopped.counts.all).toBe(0);
  });

  it('a full indexer pool is not a stopped org, and does not move a stopped org’s row (MOTIR-9451)', async () => {
    await pause((await seedOrg('Pool only')).repoIds[0]!, 'paused_index_pool_full', 6);
    const both = await seedOrg('Both', 2);
    await pause(both.repoIds[0]!, 'paused_index_no_credit', 2);
    // Older, and more behind: it would win both columns if it were counted.
    await pause(both.repoIds[1]!, 'paused_index_pool_full', 9);
    await adminDb.githubRepo.update({
      where: { id: both.repoIds[1]! },
      data: {
        indexedHeadSha: GRAPH,
        defaultBranchHeadSha: HEAD,
        commitsBehind: 77,
        commitsBehindBaseSha: GRAPH,
        commitsBehindHeadSha: HEAD,
      },
    });

    const dto = await enabled();
    expect(dto.stopped.rows.map((r) => r.organizationName)).toEqual(['Both']);
    expect(dto.stopped.rows[0]).toMatchObject({
      reason: 'no_credit',
      pausedRepos: 1,
      graphBehind: null,
    });
    expect(Date.now() - new Date(dto.stopped.rows[0]!.stoppedSince).getTime()).toBeLessThan(
      3 * DAY,
    );
    expect(dto.stopped.counts.all).toBe(1);
  });
});

describe('the ways this section can lie (AC 6)', () => {
  it('a failed motir-ai summary reads UNKNOWN, not a table of zeros', async () => {
    summaryMock.mockResolvedValue(null);
    expect((await enabled()).summary).toEqual({ state: 'unknown' });
  });

  it('a failed tier lookup reads each row’s tier as UNKNOWN, apart from an org motir-ai never saw', async () => {
    const org = await seedOrg('Tierless');
    await pause(org.repoIds[0]!, 'paused_index_no_credit', 1);
    tiersMock.mockResolvedValueOnce(null);
    expect((await enabled()).stopped.rows[0]!.tierKey).toBe('unknown');
    tiersMock.mockResolvedValueOnce(new Map([[org.organizationId, null]]));
    expect((await enabled()).stopped.rows[0]!.tierKey).toBeNull();
  });

  it('off-cloud the meter is DISABLED and nothing is read', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    const org = await seedOrg('Selfhosted');
    await pause(org.repoIds[0]!, 'paused_index_no_credit', 1);
    expect(await platformIndexAllowanceService.read(currentPrincipal, {})).toEqual({
      meter: 'disabled',
    });
    expect(summaryMock).not.toHaveBeenCalled();
    expect(tiersMock).not.toHaveBeenCalled();
  });

  it('no stopped org is an empty list with zero counts, not a missing section', async () => {
    const dto = await enabled();
    expect(dto.stopped).toMatchObject({
      counts: { all: 0, noCredit: 0, allowanceExhausted: 0 },
      total: 0,
      rows: [],
    });
  });
});

describe('only platform staff reach it (AC 7)', () => {
  it('re-asserts the staff gate itself and records the cross-tenant read', async () => {
    await platformIndexAllowanceService.read(currentPrincipal, {});
    expect(gate).toHaveBeenCalledTimes(1);
    const audit = await adminDb.platformAuditLog.findMany({
      where: { actorUserId: currentPrincipal.userId },
    });
    expect(audit.map((a) => a.action)).toContain('estate.read');
  });

  it('a principal the gate refuses reads nothing from motir-ai or the estate', async () => {
    gate.mockRejectedValueOnce(new Error('NEXT_NOT_FOUND'));
    await expect(platformIndexAllowanceService.read(currentPrincipal, {})).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(summaryMock).not.toHaveBeenCalled();
    expect(tiersMock).not.toHaveBeenCalled();
  });

  it('the admin index-allowance reads are imported only by the staff-gated service and the admin page', () => {
    const importers = execSync(
      `git grep -l -E "fetchIndexAllowanceSummary|fetchOrgTiers|platformIndexAllowanceService" -- 'app' 'lib' 'components'`,
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(importers).toEqual([
      'app/(admin)/admin/monitoring/_components/IndexAllowanceSection.tsx',
      'app/(admin)/admin/monitoring/page.tsx',
      'lib/ai/motirAiClient.ts',
      'lib/services/platformIndexAllowanceService.ts',
    ]);
  });
});

describe('the words (AC 9)', () => {
  it('no identifier, copy string or test name describes index cost as charged, billed or priced', () => {
    const affirmative = /\b(charg\w*|bill(ed|ing)?|pric(e|ed|ing))\b/i;
    const negated = /\b(not|never|no|nothing|none)\b/i;
    const en = JSON.parse(readFileSync('messages/en.json', 'utf8')).platformAdmin.monitoring;
    const texts = [
      JSON.stringify(en.indexAllowance, null, 1),
      JSON.stringify(en.stopped, null, 1),
      readFileSync('lib/services/platformIndexAllowanceService.ts', 'utf8'),
      readFileSync('app/(admin)/admin/monitoring/_components/IndexAllowanceSection.tsx', 'utf8'),
      readFileSync('app/(admin)/admin/monitoring/_components/StoppedReasonFilter.tsx', 'utf8'),
    ];
    for (const text of texts) {
      // `isCloudBilling` is the deployment switch's name, not a claim about indexing.
      const real = text
        .split('\n')
        .filter(
          (l) => affirmative.test(l) && !negated.test(l) && !/isCloudBilling|lib\/billing/.test(l),
        );
      expect(real).toEqual([]);
    }
  });
});
