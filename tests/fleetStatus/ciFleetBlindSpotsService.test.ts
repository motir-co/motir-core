import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { PlatformRole } from '@/generated/prisma/client';
import type { ReconcileOutcome } from '@/lib/services/ciRunnerReconcileService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET STATUS PAGE'S CI FLEET BLIND SPOTS (MOTIR-11439; design MOTIR-11467)
// against a REAL Postgres, as the non-bypass runtime role: the sweep's write
// under `withSystemContext`, the page's read under `withPlatformRead`, the one
// stored row and the `fleet.status.read` audit row are all real. Faked: the
// platform session gate, and the CI fleet's configuration, chosen per case by the
// orchestrator selector (`fake` boots nothing and is always configured; unset is
// Fly with no Fly variables, which is not configured).

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const {
  ciFleetBlindSpotsService: service,
  orderOrgs,
  toStoredOutcome,
} = await import('@/lib/services/ciFleetBlindSpotsService');
const { ciFleetBlindSpotsRepository } =
  await import('@/lib/repositories/ciFleetBlindSpotsRepository');
const { ciRunnerReconcileService } = await import('@/lib/services/ciRunnerReconcileService');

const TICK = new Date('2026-11-16T19:45:00.000Z');
const MIN = 60_000;

function org(
  name: string,
  over: Partial<ReconcileOutcome['orgs'][number]> = {},
): ReconcileOutcome['orgs'][number] {
  return { org: name, queued: 2, idleRunners: 0, awaiting: 1, added: 1, ...over };
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({
    where: { action: 'fleet.status.read', targetId: 'ci_fleet_blind_spots' },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "ci_fleet_blind_spots"');
  const staff = await createTestUser({ email: `ops+blind-spots-${Date.now()}@example.test` });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'superadmin' };
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "ci_fleet_blind_spots"');
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the stored outcome', () => {
  it('keeps only the drawn fields, with absent lists as empty and no error as null', () => {
    expect(
      toStoredOutcome({
        added: 3,
        orgs: [
          org('acme-labs', {
            undeliveredRepos: ['acme-labs/web'],
            skippedRuns: [
              { repoOwner: 'acme-labs', repoName: 'web', runId: '1', status: 502, detail: 'x' },
            ],
          }),
          org('northwind-data', { error: 'HttpError: Bad credentials (401)' }),
        ],
      }),
    ).toEqual({
      orgs: [
        { org: 'acme-labs', undeliveredRepos: ['acme-labs/web'], unreadableRepos: [], error: null },
        {
          org: 'northwind-data',
          undeliveredRepos: [],
          unreadableRepos: [],
          error: 'HttpError: Bad credentials (401)',
        },
      ],
      error: null,
    });
  });

  it('orders orgs not read, then with blind spots, then seen, each by login', () => {
    const row = (name: string, over: Partial<Parameters<typeof orderOrgs>[0][number]> = {}) => ({
      org: name,
      undeliveredRepos: [],
      unreadableRepos: [],
      error: null,
      ...over,
    });
    expect(
      orderOrgs([
        row('zeta-seen'),
        row('beta-blind', { unreadableRepos: ['beta-blind/a'] }),
        row('alpha-seen'),
        row('omega-failed', { error: 'boom' }),
        row('alpha-blind', { undeliveredRepos: ['alpha-blind/a'] }),
      ]).map((o) => o.org),
    ).toEqual(['omega-failed', 'alpha-blind', 'beta-blind', 'alpha-seen', 'zeta-seen']);
  });
});

describe('the sweep writes the record', () => {
  it('writes ONE row as the runtime role, and a newer tick replaces it', async () => {
    await service.record({ orgs: [org('acme-labs')], added: 1 }, TICK);
    const later = new Date(TICK.getTime() + 5 * MIN);
    await service.record(
      { orgs: [org('acme-labs', { undeliveredRepos: ['acme-labs/web'] })], added: 0 },
      later,
    );

    const rows = await adminDb.ciFleetBlindSpots.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.computedAt.toISOString()).toBe(later.toISOString());
    expect(rows[0]?.outcome).toEqual({
      orgs: [
        { org: 'acme-labs', undeliveredRepos: ['acme-labs/web'], unreadableRepos: [], error: null },
      ],
      error: null,
    });
  });

  it('never moves the record backwards: an older tick written late is ignored', async () => {
    const later = new Date(TICK.getTime() + 5 * MIN);
    await service.record({ orgs: [org('newer')], added: 0 }, later);
    await service.record({ orgs: [org('older')], added: 0 }, TICK);

    const row = await adminDb.ciFleetBlindSpots.findUniqueOrThrow({ where: { id: 'latest' } });
    expect(row.computedAt.toISOString()).toBe(later.toISOString());
    expect(row.outcome).toMatchObject({ orgs: [{ org: 'newer' }] });
  });

  it('is not readable or writable outside the two contexts its policy names', async () => {
    await service.record({ orgs: [org('acme-labs')], added: 0 }, TICK);
    // The runtime role with no context bound sees nothing and cannot write.
    expect(await db.ciFleetBlindSpots.findMany()).toEqual([]);
    await expect(
      db.$transaction((tx) =>
        ciFleetBlindSpotsRepository.replaceIfNewer({ outcome: {}, computedAt: new Date() }, tx),
      ),
    ).rejects.toThrow();
  });
});

describe('the page reads the record', () => {
  it('populated: the outcome ordered, with the tick it was computed at, and one audit row', async () => {
    const reconcile = vi.spyOn(ciRunnerReconcileService, 'reconcile');
    await service.record(
      {
        added: 1,
        orgs: [
          org('fernwood-io'),
          org('motir-co', {
            undeliveredRepos: ['motir-co/motir-codegraph'],
            unreadableRepos: ['motir-co/motir-infra'],
          }),
          org('acme-labs', { undeliveredRepos: ['acme-labs/billing-api', 'acme-labs/web'] }),
        ],
      },
      TICK,
    );

    const block = await service.read(currentPrincipal);

    expect(block).toEqual({
      status: 'ok',
      computedAt: TICK.toISOString(),
      orgs: [
        {
          org: 'acme-labs',
          undeliveredRepos: ['acme-labs/billing-api', 'acme-labs/web'],
          unreadableRepos: [],
          error: null,
        },
        {
          org: 'motir-co',
          undeliveredRepos: ['motir-co/motir-codegraph'],
          unreadableRepos: ['motir-co/motir-infra'],
          error: null,
        },
        { org: 'fernwood-io', undeliveredRepos: [], unreadableRepos: [], error: null },
      ],
    });
    // The page load never runs the reconcile, and so never reaches GitHub.
    expect(reconcile).not.toHaveBeenCalled();
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(currentPrincipal.userId);
  });

  it('empty: every org seen, and no org at all, are both an ok read', async () => {
    await service.record({ orgs: [org('acme-labs'), org('fernwood-io')], added: 0 }, TICK);
    expect(await service.read(currentPrincipal)).toMatchObject({
      status: 'ok',
      orgs: [{ org: 'acme-labs' }, { org: 'fernwood-io' }],
    });

    await service.record({ orgs: [], added: 0 }, new Date(TICK.getTime() + MIN));
    expect(await service.read(currentPrincipal)).toEqual({
      status: 'ok',
      orgs: [],
      computedAt: new Date(TICK.getTime() + MIN).toISOString(),
    });
  });

  it('one org not read: its error verbatim, first, and the other orgs still read', async () => {
    await service.record(
      {
        added: 0,
        orgs: [
          org('acme-labs'),
          org('northwind-data', {
            error: 'HttpError: Bad credentials - https://docs.github.com/rest (401)',
          }),
          org('motir-co', { undeliveredRepos: ['motir-co/motir-codegraph'] }),
        ],
      },
      TICK,
    );

    const block = await service.read(currentPrincipal);
    expect(block.status).toBe('ok');
    if (block.status !== 'ok') return;
    expect(block.orgs.map((o) => [o.org, o.error])).toEqual([
      ['northwind-data', 'HttpError: Bad credentials - https://docs.github.com/rest (401)'],
      ['motir-co', null],
      ['acme-labs', null],
    ]);
  });

  it('unread: a linked repo the credential cannot read is carried under its org', async () => {
    await service.record(
      { added: 0, orgs: [org('northwind-data', { unreadableRepos: ['northwind-data/etl-jobs'] })] },
      TICK,
    );
    expect(await service.read(currentPrincipal)).toMatchObject({
      status: 'ok',
      orgs: [
        {
          org: 'northwind-data',
          undeliveredRepos: [],
          unreadableRepos: ['northwind-data/etl-jobs'],
        },
      ],
    });
  });

  it('reconcile failed: the error and that sweep’s time, and no org list', async () => {
    await service.record({ orgs: [], added: 0, error: 'P2024: connection pool timeout' }, TICK);
    expect(await service.read(currentPrincipal)).toEqual({
      status: 'reconcileFailed',
      error: 'P2024: connection pool timeout',
      computedAt: TICK.toISOString(),
    });
  });

  it('not computed: no sweep has written a record yet', async () => {
    expect(await service.read(currentPrincipal)).toEqual({ status: 'notComputed' });
    expect(await auditRows()).toHaveLength(1);
  });

  it('not configured wins over a stored record: the reconcile serves no org there', async () => {
    await service.record({ orgs: [org('acme-labs')], added: 0 }, TICK);
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    expect(await service.read(currentPrincipal)).toEqual({ status: 'notConfigured' });
  });

  it('read failed: a record that does not parse is unavailable, never an empty list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await adminDb.ciFleetBlindSpots.create({
      data: { id: 'latest', outcome: { orgs: 'not a list' }, computedAt: TICK },
    });
    expect(await service.read(currentPrincipal)).toEqual({ status: 'unavailable' });
  });

  it('read failed: a database that does not answer is unavailable, logged by name only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(ciFleetBlindSpotsRepository, 'findLatest').mockRejectedValue(
      Object.assign(new Error('row data that must not be logged'), { name: 'PrismaClientError' }),
    );
    expect(await service.read(currentPrincipal)).toEqual({ status: 'unavailable' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('blind spots read failed'), {
      error: 'PrismaClientError',
    });

    vi.spyOn(ciFleetBlindSpotsRepository, 'findLatest').mockRejectedValue('not an error');
    expect(await service.read(currentPrincipal)).toEqual({ status: 'unavailable' });
    expect(log).toHaveBeenLastCalledWith(expect.any(String), { error: 'unknown' });
  });

  it('is superadmin only: an operator is refused before anything is read', async () => {
    await service.record({ orgs: [org('acme-labs')], added: 0 }, TICK);
    currentPrincipal = { ...currentPrincipal, role: 'operator' };
    await expect(service.read(currentPrincipal)).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await auditRows()).toHaveLength(0);
  });
});
