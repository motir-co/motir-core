import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateCodeGraphOffboarding, truncateJobRuns } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE SUBDOMAIN RULES GATE — Story MOTIR-4528 · Subtask MOTIR-9516.
//
// Story rules 1 to 5 (`docs/decisions/public-tenant-addresses.md` §8 Amendment
// 3), asserted end to end against real Postgres and read the way a SECOND
// workspace or an ANONYMOUS host lookup sees them. The units have their own
// tests; this file covers the seams and the cross-rule scenarios none of them
// owns — rename then re-claim, release then delete-and-reclaim against the
// limit, erasure then claim, sweep then claim, and racing writers.
//
// ── How time is driven ──────────────────────────────────────────────────────
//
// Rule 3's clock starts at the live row's `createdAt`, which the DATABASE stamps
// at the insert — a claim's `now` does not set it. So each test reads the claim
// instant back (`claimedAtOf`) and builds every later instant from it with the
// named offsets below, never with a sleep or a fake timer. The offsets are built
// from `nameHold.ts`'s constants, so a change of rule moves the suite with it
// rather than leaving it pinned to the old numbers.
//
// ── What counts as "stops answering" ────────────────────────────────────────
//
// Never a service return value alone: every such assertion is a
// `resolveHost` not-found AND the absence of a `public_address` row.

const ctxRef = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { publicAddressesService, PublicHostNotFoundError } =
  await import('@/lib/services/publicAddressesService');
const { publicHostnameReservationService } =
  await import('@/lib/services/publicHostnameReservationService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { accountDeletionService } = await import('@/lib/services/accountDeletionService');
const { accountErasureSweepService } = await import('@/lib/services/accountErasureSweepService');
const { hostnameReservationHash } = await import('@/lib/publicAddresses/hostnameReservation');
const { GRACE_HOURS, QUARANTINE_DAYS, CHANGE_INTERVAL_DAYS } =
  await import('@/lib/publicAddresses/nameHold');
const { HostnameTakenError, NameQuarantinedError, ReservedLabelError, SubdomainChangeLimitError } =
  await import('@/lib/publicAddresses/errors');
const { GET: previewRoute } =
  await import('@/app/api/workspaces/[workspaceId]/public-subdomain/preview/route');
const { createTestUser, createTestWorkspace } = await import('../fixtures');

const BASE = 'motir.example';
const MS = 1;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GRACE = GRACE_HOURS * HOUR;
const QUARANTINE = QUARANTINE_DAYS * DAY;
const CHANGE_INTERVAL = CHANGE_INTERVAL_DAYS * DAY;

interface Ws {
  workspaceId: string;
  ownerId: string;
  organizationId?: string;
}

let acme: Ws;
let rival: Ws;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await truncateCodeGraphOffboarding();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  acme = await workspace('Acme');
  rival = await workspace('Rival');
});

afterEach(async () => {
  ctxRef.current = null;
  vi.restoreAllMocks();
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures and readers ────────────────────────────────────────────────────

async function workspace(name: string): Promise<Ws> {
  const { workspace: ws, owner } = await createTestWorkspace({ name });
  return { workspaceId: ws.id, ownerId: owner.id };
}

function at(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}

const host = (label: string) => `${label}.${BASE}`;

/** When the workspace took its CURRENT label — rule 3's clock start, read off the row. */
async function claimedAtOf(workspaceId: string): Promise<Date> {
  const live = await adminDb.publicAddress.findFirstOrThrow({
    where: { workspaceId, kind: 'workspace_subdomain' },
  });
  return live.createdAt;
}

async function liveRows(workspaceId: string) {
  return adminDb.publicAddress.findMany({ where: { workspaceId, kind: 'workspace_subdomain' } });
}

async function holdOn(label: string) {
  return adminDb.publicHostnameReservation.findUnique({
    where: { hostnameHash: hostnameReservationHash(host(label)) },
  });
}

async function ledgerOf(workspaceId: string): Promise<Date | null> {
  const row = await adminDb.publicSubdomainChange.findUnique({ where: { workspaceId } });
  return row?.lastChangedAt ?? null;
}

/** The anonymous read AND the row: the two proofs a name has stopped answering. */
async function expectNotAnswering(label: string): Promise<void> {
  await expect(publicAddressesService.resolveHost(host(label))).rejects.toBeInstanceOf(
    PublicHostNotFoundError,
  );
  expect(await adminDb.publicAddress.count({ where: { hostname: host(label) } })).toBe(0);
}

async function refusal(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('rule 1 — one name per workspace, no aliases', () => {
  it('a rename leaves exactly one subdomain row, with the new label, and writes no alias', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);
    const dto = await publicSubdomainService.rename(acme.workspaceId, 'acme-inc', acme.ownerId);

    const rows = await adminDb.publicAddress.findMany({ where: { workspaceId: acme.workspaceId } });
    expect(rows.map((r) => [r.kind, r.hostname])).toEqual([
      ['workspace_subdomain', host('acme-inc')],
    ]);
    expect(Object.keys(dto).sort()).toEqual([
      'claimedAt',
      'hostname',
      'label',
      'nextChangeAllowedAt',
      'url',
    ]);
  });
});

describe('rule 2 — a retired name stops answering at once, with no redirect', () => {
  it('after a rename the old host is not found and has no row; the new one answers', async () => {
    // A workspace host is readable anonymously only while the workspace holds a
    // public project — the `public_address_public_read` arm's rule.
    await adminDb.project.create({
      data: {
        workspaceId: acme.workspaceId,
        name: 'Acme',
        slug: 'acme',
        identifier: 'ACME',
        ...projectAccessData('public'),
      },
    });
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);
    await publicSubdomainService.rename(acme.workspaceId, 'acme-inc', acme.ownerId);

    await expectNotAnswering('acme');
    expect(
      await adminDb.publicAddress.count({ where: { kind: 'workspace_subdomain_alias' } }),
    ).toBe(0);
    await expect(publicAddressesService.resolveHost(host('acme-inc'))).resolves.toEqual({
      kind: 'no_application',
      workspace: { name: 'Acme' },
    });
  });

  it('after a release the released host is not found and has no row', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);
    await publicSubdomainService.release(acme.workspaceId, acme.ownerId);

    await expectNotAnswering('acme');
  });
});

describe('rule 3 — the 24-hour grace and the 90-day quarantine', () => {
  it('a label held 1 ms under the grace returns to the pool at once', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'fresh', acme.ownerId);
    const releasedAt = at(await claimedAtOf(acme.workspaceId), GRACE - MS);

    await expect(
      publicSubdomainService.release(acme.workspaceId, acme.ownerId, releasedAt),
    ).resolves.toEqual({ returnsAt: null });

    expect(await holdOn('fresh')).toBeNull();
    await expect(
      publicSubdomainService.claim(rival.workspaceId, 'fresh', rival.ownerId, releasedAt),
    ).resolves.toMatchObject({ hostname: host('fresh') });
  });

  it('a label held EXACTLY the grace is quarantined until release + 90 days', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'edge', acme.ownerId);
    const releasedAt = at(await claimedAtOf(acme.workspaceId), GRACE);
    const returnsAt = at(releasedAt, QUARANTINE);

    await expect(
      publicSubdomainService.release(acme.workspaceId, acme.ownerId, releasedAt),
    ).resolves.toEqual({ returnsAt: returnsAt.toISOString() });

    expect((await holdOn('edge'))?.expiresAt.getTime()).toBe(returnsAt.getTime());
    const refused = await refusal(
      publicSubdomainService.claim(rival.workspaceId, 'edge', rival.ownerId, releasedAt),
    );
    expect(refused).toBeInstanceOf(NameQuarantinedError);
    expect((refused as InstanceType<typeof NameQuarantinedError>).returnsAt.getTime()).toBe(
      returnsAt.getTime(),
    );
  });

  it('a label held over the grace is quarantined too', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'aged', acme.ownerId);
    const releasedAt = at(await claimedAtOf(acme.workspaceId), GRACE + MS);

    await publicSubdomainService.release(acme.workspaceId, acme.ownerId, releasedAt);

    expect((await holdOn('aged'))?.expiresAt.getTime()).toBe(at(releasedAt, QUARANTINE).getTime());
  });

  it('the quarantine ends exactly at expires_at, and a swept digest is reusable', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'held', acme.ownerId);
    const releasedAt = at(await claimedAtOf(acme.workspaceId), GRACE);
    await publicSubdomainService.release(acme.workspaceId, acme.ownerId, releasedAt);
    const expiresAt = at(releasedAt, QUARANTINE);

    expect(
      await refusal(
        publicSubdomainService.claim(rival.workspaceId, 'held', rival.ownerId, at(expiresAt, -MS)),
      ),
    ).toBeInstanceOf(NameQuarantinedError);

    // … the name is claimable AT expires_at, while the lapsed row still exists …
    await publicSubdomainService.claim(rival.workspaceId, 'held', rival.ownerId, expiresAt);

    // … the sweep at expires_at deletes that lapsed row …
    await expect(
      publicHostnameReservationService.sweepExpiredNameHolds(expiresAt),
    ).resolves.toEqual({ deleted: 1 });
    expect(await holdOn('held')).toBeNull();

    // … and holding it again writes the digest afresh, with no unique-key collision.
    const rereleasedAt = at(expiresAt, CHANGE_INTERVAL + DAY);
    await publicSubdomainService.release(rival.workspaceId, rival.ownerId, rereleasedAt);
    const again = await holdOn('held');
    expect(again?.retiredFromWorkspaceId).toBe(rival.workspaceId);
    expect(again?.expiresAt.getTime()).toBe(at(rereleasedAt, QUARANTINE).getTime());
  });

  it('the workspace that released a quarantined label cannot take it back inside the 90 days', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'mine', acme.ownerId);
    const releasedAt = at(await claimedAtOf(acme.workspaceId), GRACE);
    await publicSubdomainService.release(acme.workspaceId, acme.ownerId, releasedAt);

    expect(
      await refusal(
        publicSubdomainService.claim(acme.workspaceId, 'mine', acme.ownerId, at(releasedAt, DAY)),
      ),
    ).toBeInstanceOf(NameQuarantinedError);
  });
});

describe('rule 4 — one change per 30 days', () => {
  it('a second rename just under the interval is refused and writes nothing; at the interval it succeeds', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'one', acme.ownerId);
    const firstChange = at(await claimedAtOf(acme.workspaceId), HOUR);
    await publicSubdomainService.rename(acme.workspaceId, 'two', acme.ownerId, firstChange);
    const before = {
      rows: await liveRows(acme.workspaceId),
      holds: await adminDb.publicHostnameReservation.findMany(),
      ledger: await ledgerOf(acme.workspaceId),
    };

    const early = await refusal(
      publicSubdomainService.rename(
        acme.workspaceId,
        'three',
        acme.ownerId,
        at(firstChange, CHANGE_INTERVAL - MS),
      ),
    );
    expect(early).toBeInstanceOf(SubdomainChangeLimitError);
    expect((early as InstanceType<typeof SubdomainChangeLimitError>).nextAllowedAt.getTime()).toBe(
      at(firstChange, CHANGE_INTERVAL).getTime(),
    );
    expect(await liveRows(acme.workspaceId)).toEqual(before.rows);
    expect(await adminDb.publicHostnameReservation.findMany()).toEqual(before.holds);
    expect(await ledgerOf(acme.workspaceId)).toEqual(before.ledger);

    await expect(
      publicSubdomainService.rename(
        acme.workspaceId,
        'three',
        acme.ownerId,
        at(firstChange, CHANGE_INTERVAL),
      ),
    ).resolves.toMatchObject({ hostname: host('three') });
  });

  it('release then re-claim is not a free rename: the claim is allowed, the next change is not', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'start', acme.ownerId);
    const releasedAt = at(await claimedAtOf(acme.workspaceId), HOUR);
    await publicSubdomainService.release(acme.workspaceId, acme.ownerId, releasedAt);

    // The first claim after a release is not a change, so the ledger keeps the release.
    await publicSubdomainService.claim(acme.workspaceId, 'next', acme.ownerId, at(releasedAt, DAY));
    expect(await ledgerOf(acme.workspaceId)).toEqual(releasedAt);

    for (const attempt of [
      () =>
        publicSubdomainService.rename(acme.workspaceId, 'later', acme.ownerId, at(releasedAt, DAY)),
      () => publicSubdomainService.release(acme.workspaceId, acme.ownerId, at(releasedAt, DAY)),
    ]) {
      const refused = await refusal(attempt());
      expect(refused).toBeInstanceOf(SubdomainChangeLimitError);
      expect(
        (refused as InstanceType<typeof SubdomainChangeLimitError>).nextAllowedAt.getTime(),
      ).toBe(at(releasedAt, CHANGE_INTERVAL).getTime());
    }
  });

  it('a refused change — limit, taken label or quarantined label — leaves the ledger and holds untouched', async () => {
    await publicSubdomainService.claim(rival.workspaceId, 'taken', rival.ownerId);
    await publicSubdomainService.claim(acme.workspaceId, 'quar', acme.ownerId);
    const releasedAt = at(await claimedAtOf(acme.workspaceId), GRACE);
    await publicSubdomainService.release(acme.workspaceId, acme.ownerId, releasedAt);
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId, releasedAt);

    const free = at(releasedAt, CHANGE_INTERVAL);
    const snapshot = async () => ({
      ledger: await ledgerOf(acme.workspaceId),
      holds: await adminDb.publicHostnameReservation.findMany({ orderBy: { id: 'asc' } }),
      live: await liveRows(acme.workspaceId),
    });
    const before = await snapshot();

    // Thunks, not promises: each attempt starts only after the one before it was
    // judged, so none runs concurrently and none rejects before it is awaited.
    const attempts: Array<[() => Promise<unknown>, unknown]> = [
      [
        () => publicSubdomainService.rename(acme.workspaceId, 'other', acme.ownerId, at(free, -MS)),
        SubdomainChangeLimitError,
      ],
      [
        () => publicSubdomainService.rename(acme.workspaceId, 'taken', acme.ownerId, free),
        HostnameTakenError,
      ],
      [
        () => publicSubdomainService.rename(acme.workspaceId, 'quar', acme.ownerId, free),
        NameQuarantinedError,
      ],
    ];
    for (const [attempt, kind] of attempts) {
      expect(await refusal(attempt())).toBeInstanceOf(kind as new () => Error);
      expect(await snapshot()).toEqual(before);
    }
  });
});

describe('rule 5 — the preview states what the write will do', () => {
  it('for a label held over the grace, the preview equals what the release then stores, and writes nothing', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'dated', acme.ownerId);
    const firstChange = at(await claimedAtOf(acme.workspaceId), GRACE);
    await publicSubdomainService.rename(acme.workspaceId, 'dated-two', acme.ownerId, firstChange);
    const now = at(firstChange, CHANGE_INTERVAL + GRACE);
    const holdsBefore = await adminDb.publicHostnameReservation.count();

    const preview = await publicSubdomainService.previewChange(acme.workspaceId, acme.ownerId, now);
    expect(await adminDb.publicHostnameReservation.count()).toBe(holdsBefore);
    expect(await ledgerOf(acme.workspaceId)).toEqual(firstChange);

    const released = await publicSubdomainService.release(acme.workspaceId, acme.ownerId, now);
    expect(preview).toEqual({
      host: host('dated-two'),
      outcome: 'quarantine',
      returnsAt: released.returnsAt,
      changeAllowed: true,
      nextChangeAllowedAt: null,
    });
    expect((await holdOn('dated-two'))?.expiresAt.toISOString()).toBe(preview.returnsAt);
    expect(await ledgerOf(acme.workspaceId)).toEqual(now);
  });

  it('a label held under the grace previews return_now with no date', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'quick', acme.ownerId);
    const now = at(await claimedAtOf(acme.workspaceId), GRACE - MS);

    await expect(
      publicSubdomainService.previewChange(acme.workspaceId, acme.ownerId, now),
    ).resolves.toMatchObject({ outcome: 'return_now', returnsAt: null });
  });

  it('the preview route answers what previewChange answers, and 404 with no subdomain', async () => {
    ctxRef.current = { userId: acme.ownerId, workspaceId: acme.workspaceId };
    const call = () =>
      previewRoute(new Request('https://app.motir.co/x'), {
        params: Promise.resolve({ workspaceId: acme.workspaceId }),
      });

    expect((await call()).status).toBe(404);

    await publicSubdomainService.claim(acme.workspaceId, 'routed', acme.ownerId);
    const res = await call();
    const body = (await res.json()) as Record<string, unknown>;
    const direct = await publicSubdomainService.previewChange(acme.workspaceId, acme.ownerId);
    expect(res.status).toBe(200);
    // Two clocks a few ms apart: the only field that could move is a
    // quarantine date, and a fresh label returns at once, so they agree whole.
    expect(body).toEqual(direct);
  });
});

describe('concurrency — committed end states, never timings', () => {
  it('two workspaces claiming the same free label: exactly one wins, the other is taken', async () => {
    const results = await Promise.allSettled([
      publicSubdomainService.claim(acme.workspaceId, 'contested', acme.ownerId),
      publicSubdomainService.claim(rival.workspaceId, 'contested', rival.ownerId),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(HostnameTakenError);
    expect(await adminDb.publicAddress.count({ where: { hostname: host('contested') } })).toBe(1);
  });

  it('two renames of ONE workspace at once: one succeeds, the other hits the limit', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'base', acme.ownerId);
    const now = at(await claimedAtOf(acme.workspaceId), HOUR);

    const results = await Promise.allSettled([
      publicSubdomainService.rename(acme.workspaceId, 'left', acme.ownerId, now),
      publicSubdomainService.rename(acme.workspaceId, 'right', acme.ownerId, now),
    ]);

    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(SubdomainChangeLimitError);
    expect(await ledgerOf(acme.workspaceId)).toEqual(now);
    const live = await liveRows(acme.workspaceId);
    expect(live).toHaveLength(1);
    expect([host('left'), host('right')]).toContain(live[0]!.hostname);
  });

  it('a claim racing the holder’s release of the same label ends in one of two consistent states', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'race', acme.ownerId);
    const now = at(await claimedAtOf(acme.workspaceId), GRACE);

    const [released, claimed] = await Promise.allSettled([
      publicSubdomainService.release(acme.workspaceId, acme.ownerId, now),
      publicSubdomainService.claim(rival.workspaceId, 'race', rival.ownerId, now),
    ]);

    expect(released.status).toBe('fulfilled');
    expect(claimed.status).toBe('rejected');
    // Taken, if the claim ran before the release committed; quarantined, if after.
    const reason = (claimed as PromiseRejectedResult).reason as Error;
    expect(reason instanceof HostnameTakenError || reason instanceof NameQuarantinedError).toBe(
      true,
    );
    // Never two live rows, and never a hold on a label that is also live.
    expect(await adminDb.publicAddress.count({ where: { hostname: host('race') } })).toBe(0);
    expect(await holdOn('race')).not.toBeNull();
  });
});

describe('erasure — a workspace delete holds names by the same rule', () => {
  /** A sole-owner workspace holding `label` for `heldMs`, with a ledger row. */
  async function holder(label: string, heldMs: number, email: string): Promise<Ws> {
    const user = await createTestUser({ email });
    const { workspace: ws } = await workspacesService.createWorkspace({
      name: `Holder ${label}`,
      ownerUserId: user.id,
    });
    await publicSubdomainService.claim(ws.id, label, user.id);
    // The delete reads the real clock, so the hold's START is moved instead.
    await adminDb.publicAddress.updateMany({
      where: { workspaceId: ws.id, kind: 'workspace_subdomain' },
      data: { createdAt: new Date(Date.now() - heldMs) },
    });
    await adminDb.publicSubdomainChange.create({
      data: { workspaceId: ws.id, lastChangedAt: new Date(Date.now() - DAY) },
    });
    return { workspaceId: ws.id, ownerId: user.id, organizationId: ws.organizationId };
  }

  function expectHeldFrom(expiresAt: Date | undefined, before: Date, after: Date): void {
    expect(expiresAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() + QUARANTINE);
    expect(expiresAt!.getTime()).toBeLessThanOrEqual(after.getTime() + QUARANTINE);
  }

  it('the direct delete: a fresh label is claimable at once, an aged one is held 90 days, no ledger is left', async () => {
    const fresh = await holder('fresh-del', GRACE - HOUR, 'fresh@example.com');
    const aged = await holder('aged-del', GRACE + HOUR, 'aged@example.com');

    const before = new Date();
    for (const ws of [fresh, aged]) {
      await workspacesService.removeWorkspaceAsOrgAdmin({
        workspaceId: ws.workspaceId,
        actorUserId: ws.ownerId,
      });
    }
    const after = new Date();

    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
    expect(await holdOn('fresh-del')).toBeNull();
    await expect(
      publicSubdomainService.claim(rival.workspaceId, 'fresh-del', rival.ownerId),
    ).resolves.toMatchObject({ hostname: host('fresh-del') });

    const held = await holdOn('aged-del');
    expectHeldFrom(held?.expiresAt, before, after);
    expect(
      await refusal(
        publicSubdomainService.claim(
          acme.workspaceId,
          'aged-del',
          acme.ownerId,
          at(held!.expiresAt, -MS),
        ),
      ),
    ).toBeInstanceOf(NameQuarantinedError);
  });

  it('the account-erasure sweep writes the same hold, and a repeated tick adds none', async () => {
    const leaver = await holder('leaver', GRACE + HOUR, 'leaver@example.com');
    const dto = await accountDeletionService.scheduleAccountDeletion(leaver.ownerId);
    // Overdue: requested long ago, due yesterday. The erasure grace is its own
    // rule, so neither instant is built from this story's constants.
    await adminDb.accountDeletionRequest.update({
      where: { id: dto.id },
      data: {
        requestedAt: new Date(Date.now() - 40 * DAY),
        erasureDueAt: new Date(Date.now() - DAY),
      },
    });

    const before = new Date();
    await expect(accountErasureSweepService.sweep()).resolves.toMatchObject({
      erased: 1,
      failed: 0,
      workspacesDeleted: 1,
    });
    const after = new Date();

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows.map((r) => [r.hostnameHash, r.retiredFromWorkspaceId])).toEqual([
      [hostnameReservationHash(host('leaver')), leaver.workspaceId],
    ]);
    expectHeldFrom(rows[0]!.expiresAt, before, after);

    await expect(accountErasureSweepService.sweep()).resolves.toMatchObject({ failed: 0 });
    expect(await adminDb.publicHostnameReservation.findMany()).toEqual(rows);
  });

  it('organization erasure writes the same hold', async () => {
    const closing = await holder('closing', GRACE + HOUR, 'closing@example.com');
    const request = await adminDb.organizationDeletionRequest.create({
      data: {
        organizationId: closing.organizationId!,
        requestedByUserId: closing.ownerId,
        erasureDueAt: new Date(Date.now() - DAY),
        status: 'erasing',
        erasingStartedAt: new Date(),
      },
    });

    const before = new Date();
    await workspacesService.deleteWorkspaceForOrganizationErasure({
      workspaceId: closing.workspaceId,
      requestId: request.id,
      actorUserId: closing.ownerId,
    });
    const after = new Date();

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows.map((r) => [r.hostnameHash, r.retiredFromWorkspaceId])).toEqual([
      [hostnameReservationHash(host('closing')), closing.workspaceId],
    ]);
    expectHeldFrom(rows[0]!.expiresAt, before, after);
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
  });

  it('no hold row, after rename, release and delete, stores a hostname or label', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'jane-smith', acme.ownerId);
    const renamedAt = at(await claimedAtOf(acme.workspaceId), GRACE);
    await publicSubdomainService.rename(acme.workspaceId, 'john-doe', acme.ownerId, renamedAt);
    const releasedAt = at(renamedAt, CHANGE_INTERVAL + GRACE);
    await publicSubdomainService.release(acme.workspaceId, acme.ownerId, releasedAt);
    const gone = await holder('mary-major', GRACE + HOUR, 'mary@example.com');
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: gone.workspaceId,
      actorUserId: gone.ownerId,
    });

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'expiresAt',
        'hostnameHash',
        'id',
        'retiredAt',
        'retiredFromWorkspaceId',
      ]);
    }
    const dump = JSON.stringify(rows);
    for (const name of ['jane-smith', 'john-doe', 'mary-major', BASE]) {
      expect(dump).not.toContain(name);
    }
  });
});

describe('reserved labels — the rule is not re-opened', () => {
  it('a reserved label is refused before any row, hold or ledger write', async () => {
    expect(
      await refusal(publicSubdomainService.claim(acme.workspaceId, 'www', acme.ownerId)),
    ).toBeInstanceOf(ReservedLabelError);

    expect(await adminDb.publicAddress.count()).toBe(0);
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
  });
});
