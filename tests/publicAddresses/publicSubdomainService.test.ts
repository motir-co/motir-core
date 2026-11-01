import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The workspace-subdomain service — Story MOTIR-3878 · Subtask MOTIR-4215.
// Real Postgres throughout (the no-mocks rule); the only toggles are the
// `MOTIR_CLOUD` and `MOTIR_PUBLIC_TENANT_DOMAIN` env vars.

// ⚠️ THE CERTIFICATE PROVIDER IS MOCKED SO A RELEASE'S SILENCE IS ASSERTABLE
// (MOTIR-4454). This service imports nothing from that module today, which is
// exactly the property worth pinning: the nearest neighbour to `release` is
// `customDomainService.remove`, which DOES withdraw a certificate, and a
// subdomain is covered by the wildcard `*.<base>` so there is nothing to
// withdraw. If somebody later copies that shape in, the assertion fires instead
// of Fly answering a question about a hostname it never certificated.
const { certificateProviderSpy } = vi.hoisted(() => ({ certificateProviderSpy: vi.fn() }));
vi.mock('@/lib/publicAddresses/certificateProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  certificateProvider: certificateProviderSpy,
}));

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
const { publicHostnameReservationRepository } =
  await import('@/lib/repositories/publicHostnameReservationRepository');
const { publicAddressesService } = await import('@/lib/services/publicAddressesService');
const { hostnameReservationHash } = await import('@/lib/publicAddresses/hostnameReservation');
const { publicSiteOrigin, publicProjectPath } = await import('@/lib/publicProjects/urls');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { createTestWorkspace, createTestUser, createTestProject } = await import('../fixtures');
const {
  HostnameTakenError,
  NameQuarantinedError,
  NoSubdomainClaimedError,
  PublicAddressesUnavailableError,
  ReservedLabelError,
  SubdomainChangeLimitError,
  SubdomainForbiddenError,
  SubdomainNotFoundError,
  WorkspaceNotVisibleError,
} = await import('@/lib/publicAddresses/errors');
const { TenantDomainNotConfiguredError } = await import('@/lib/publicAddresses/tenantDomain');

const BASE = 'motir.example';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** `ms` after `from`. */
function plus(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}

/**
 * When the workspace took its CURRENT label — the live row's `createdAt`, the
 * clock rule 3's 24 hours run from. Read from the row so the boundary tests are
 * exact to the millisecond, whatever the database clock said at the insert.
 */
async function claimedAtOf(workspaceId: string): Promise<Date> {
  const live = await adminDb.publicAddress.findFirstOrThrow({
    where: { workspaceId, kind: 'workspace_subdomain' },
  });
  return live.createdAt;
}

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
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('claim', () => {
  it('claims a label and composes the address from the configured base', async () => {
    const dto = await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    expect(dto).toMatchObject({
      label: 'acme',
      hostname: `acme.${BASE}`,
      url: `https://acme.${BASE}`,
      nextChangeAllowedAt: null,
    });
  });

  it('reads back as null before a claim, and as the DTO after', async () => {
    expect(await publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId)).toBeNull();
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    expect(await publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId)).toMatchObject({
      hostname: `acme.${BASE}`,
    });
  });

  it('refuses a reserved label, and says WHICH rule refused it', async () => {
    const err = await publicSubdomainService
      .claim(fx.workspaceId, 'admin', fx.ownerId)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReservedLabelError);
    expect((err as InstanceType<typeof ReservedLabelError>).refusal).toBe('reserved');
  });

  it('refuses an invalid label as GRAMMAR, distinctly from reserved', async () => {
    for (const [label, refusal] of [
      ['Acme', 'bad_grammar'],
      ['-acme', 'bad_grammar'],
      ['ac', 'too_short'],
      ['xn--abc', 'structurally_reserved'],
    ] as const) {
      const err = await publicSubdomainService
        .claim(fx.workspaceId, label, fx.ownerId)
        .catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(ReservedLabelError);
      expect((err as InstanceType<typeof ReservedLabelError>).refusal, label).toBe(refusal);
    }
  });

  it('refuses a second claim rather than silently renaming', async () => {
    // A claim is not a rename. Turning one into the other would spend a change
    // from the 30-day limit without the customer asking for it.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme-two', fx.ownerId),
    ).rejects.toBeInstanceOf(HostnameTakenError);
    // And no second row was written — the refusal cost nothing.
    const rows = await adminDb.publicAddress.findMany({ where: { workspaceId: fx.workspaceId } });
    expect(rows).toHaveLength(1);
  });

  it('refuses a label another WORKSPACE already holds', async () => {
    const other = await createTestWorkspace({ name: 'Other' });
    await publicSubdomainService.claim(other.workspace.id, 'acme', other.owner.id);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(HostnameTakenError);
  });

  it('refuses a QUARANTINED label with the date it returns, and admits it once lapsed', async () => {
    // Rule 3 seen from the claimer's side. The refusal is NOT `HostnameTakenError`:
    // a reservation ends on a date, and the claimer is owed it (story rule 5).
    const now = new Date();
    const returnsAt = plus(now, 10 * DAY);
    await adminDb.publicHostnameReservation.create({
      data: {
        hostnameHash: hostnameReservationHash(`held.${BASE}`),
        retiredFromWorkspaceId: fx.workspaceId,
        expiresAt: returnsAt,
      },
    });
    const err = await publicSubdomainService
      .claim(fx.workspaceId, 'held', fx.ownerId, now)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NameQuarantinedError);
    expect((err as InstanceType<typeof NameQuarantinedError>).returnsAt.toISOString()).toBe(
      returnsAt.toISOString(),
    );
    expect(await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);

    // The instant the hold ends, the name is claimable — the sweep has not run.
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'held', fx.ownerId, returnsAt),
    ).resolves.toMatchObject({ hostname: `held.${BASE}` });
  });

  it('does not read or write the change ledger', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
  });
});

describe('rename', () => {
  it('deletes the old row and creates the new one — one name, no alias', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = new Date();
    const dto = await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId, now);

    expect(dto).toEqual({
      label: 'acme-inc',
      hostname: `acme-inc.${BASE}`,
      url: `https://acme-inc.${BASE}`,
      claimedAt: expect.any(String),
      nextChangeAllowedAt: plus(now, 30 * DAY).toISOString(),
    });

    const rows = await adminDb.publicAddress.findMany({ where: { workspaceId: fx.workspaceId } });
    expect(rows.map((r) => [r.hostname, r.kind, r.status])).toEqual([
      [`acme-inc.${BASE}`, 'workspace_subdomain', 'active'],
    ]);
    // Stop serving at once: nothing answers the old hostname any more.
    expect(await adminDb.publicAddress.count({ where: { hostname: `acme.${BASE}` } })).toBe(0);
  });

  it('frees a label held UNDER 24 hours at once — no hold, claimable by anyone', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = plus(await claimedAtOf(fx.workspaceId), DAY - 1);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId, now);

    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    const other = await createTestWorkspace({ name: 'Taker' });
    await expect(
      publicSubdomainService.claim(other.workspace.id, 'acme', other.owner.id, now),
    ).resolves.toMatchObject({ hostname: `acme.${BASE}` });
  });

  it('holds a label held EXACTLY 24 hours for 90 days, against everyone', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = plus(await claimedAtOf(fx.workspaceId), DAY);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId, now);

    const held = await adminDb.publicHostnameReservation.findMany();
    expect(held.map((r) => [r.hostnameHash, r.expiresAt.toISOString()])).toEqual([
      [hostnameReservationHash(`acme.${BASE}`), plus(now, 90 * DAY).toISOString()],
    ]);

    const other = await createTestWorkspace({ name: 'Squatter' });
    await expect(
      publicSubdomainService.claim(other.workspace.id, 'acme', other.owner.id, now),
    ).rejects.toBeInstanceOf(NameQuarantinedError);
  });

  it('refuses a rename on a workspace that never claimed one', async () => {
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(NoSubdomainClaimedError);
  });

  it('refuses renaming to the name already held, and spends no change on it', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(HostnameTakenError);
    expect(await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } })).toBe(1);
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
  });

  it('refuses a second change inside 30 days with its date, and admits it at 30 days', async () => {
    // Both directions: a limit that refused at exactly 30 days would pass a test
    // asserting only the refusal.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const first = new Date();
    await publicSubdomainService.rename(fx.workspaceId, 'acme-one', fx.ownerId, first);

    const err = await publicSubdomainService
      .rename(fx.workspaceId, 'acme-two', fx.ownerId, plus(first, 30 * DAY - 1))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubdomainChangeLimitError);
    expect(
      (err as InstanceType<typeof SubdomainChangeLimitError>).nextAllowedAt.toISOString(),
    ).toBe(plus(first, 30 * DAY).toISOString());
    expect(
      (await adminDb.publicAddress.findMany({ where: { workspaceId: fx.workspaceId } })).map(
        (r) => r.hostname,
      ),
      'the refused rename wrote nothing',
    ).toEqual([`acme-one.${BASE}`]);

    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme-two', fx.ownerId, plus(first, 30 * DAY)),
    ).resolves.toMatchObject({ hostname: `acme-two.${BASE}` });
  });

  it('rolls the whole change back when the new name is quarantined — no change is spent', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = new Date();
    await adminDb.publicHostnameReservation.create({
      data: {
        hostnameHash: hostnameReservationHash(`held.${BASE}`),
        retiredFromWorkspaceId: fx.workspaceId,
        expiresAt: plus(now, DAY),
      },
    });
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'held', fx.ownerId, now),
    ).rejects.toBeInstanceOf(NameQuarantinedError);
    expect(
      (await adminDb.publicAddress.findMany({ where: { workspaceId: fx.workspaceId } })).map(
        (r) => r.hostname,
      ),
      'the old name is still served — the delete rolled back with the refused claim',
    ).toEqual([`acme.${BASE}`]);
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
  });
});

describe("previewChange — the confirm dialog's dated preview", () => {
  it('says what the next release applies, for the same instant, and writes nothing', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = plus(await claimedAtOf(fx.workspaceId), 2 * DAY);

    const preview = await publicSubdomainService.previewChange(fx.workspaceId, fx.ownerId, now);
    expect(preview).toEqual({
      host: `acme.${BASE}`,
      outcome: 'quarantine',
      returnsAt: plus(now, 90 * DAY).toISOString(),
      changeAllowed: true,
      nextChangeAllowedAt: null,
    });
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);

    const released = await publicSubdomainService.release(fx.workspaceId, fx.ownerId, now);
    expect(released.returnsAt).toBe(preview.returnsAt);
    const held = await adminDb.publicHostnameReservation.findFirstOrThrow();
    expect(held.expiresAt.toISOString()).toBe(preview.returnsAt);
  });

  it("says return_now for a fresh label, and the limit's date inside 30 days", async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const changed = new Date();
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId, changed);
    const now = plus(changed, HOUR);

    expect(await publicSubdomainService.previewChange(fx.workspaceId, fx.ownerId, now)).toEqual({
      host: `acme-inc.${BASE}`,
      outcome: 'return_now',
      returnsAt: null,
      changeAllowed: false,
      nextChangeAllowedAt: plus(changed, 30 * DAY).toISOString(),
    });
    const err = await publicSubdomainService
      .release(fx.workspaceId, fx.ownerId, now)
      .catch((e: unknown) => e);
    expect(
      (err as InstanceType<typeof SubdomainChangeLimitError>).nextAllowedAt.toISOString(),
    ).toBe(plus(changed, 30 * DAY).toISOString());
  });

  it('is admin-only, and answers not-found when there is nothing to change', async () => {
    await expect(
      publicSubdomainService.previewChange(fx.workspaceId, fx.ownerId),
    ).rejects.toBeInstanceOf(SubdomainNotFoundError);
    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    await expect(
      publicSubdomainService.previewChange(fx.workspaceId, member.id),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
  });
});

describe('authorisation — a WORKSPACE resource, not a project one', () => {
  it('lets an owner write and a member only read', async () => {
    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);

    await expect(
      publicSubdomainService.getForWorkspace(fx.workspaceId, member.id),
    ).resolves.toMatchObject({ hostname: `acme.${BASE}` });
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme-inc', member.id),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
  });

  it('lets a stored workspace MANAGER write (MOTIR-6462)', async () => {
    const manager = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: manager.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'manager',
      },
    });
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', manager.id),
    ).resolves.toMatchObject({ hostname: `acme.${BASE}` });
  });

  it('refuses a VIEWER the write', async () => {
    const viewer = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: viewer.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'viewer',
      },
    });
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', viewer.id),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
  });

  it('answers a NON-MEMBER with not-found on both read and write', async () => {
    // The no-existence-leak posture: a stranger must not be able to tell an
    // unclaimed workspace from one they cannot see.
    const stranger = await createTestUser();
    await expect(
      publicSubdomainService.getForWorkspace(fx.workspaceId, stranger.id),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', stranger.id),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);
  });
});

describe('the gates', () => {
  it('is ABSENT off-cloud — every method, before any read', async () => {
    delete process.env['MOTIR_CLOUD'];
    await expect(
      publicSubdomainService.getForWorkspace(fx.workspaceId, fx.ownerId),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
    await expect(
      publicSubdomainService.rename(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
  });

  it('refuses when no base domain is configured, rather than guessing one', async () => {
    // There is no default, and that is the opposite choice from
    // `motir-marketing`'s site origin. A guessed base would mint hostnames — in
    // the database, in DNS instructions a customer follows, in a certificate
    // request — under a domain nobody owns.
    delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId),
    ).rejects.toBeInstanceOf(TenantDomainNotConfiguredError);
  });
});

describe('concurrency', () => {
  it('lets exactly ONE of two concurrent claims of the same label win', async () => {
    // TWO WORKSPACES, deliberately. Two claims in ONE workspace contend on the
    // workspace row lock; two in DIFFERENT workspaces lock two different rows,
    // so the row lock cannot see the collision at all and the GLOBAL hostname
    // unique is the only thing standing between them. That is the harder case
    // and the one worth pinning.
    const other = await createTestWorkspace({ name: 'Rival' });
    const results = await Promise.allSettled([
      publicSubdomainService.claim(fx.workspaceId, 'contended', fx.ownerId),
      publicSubdomainService.claim(other.workspace.id, 'contended', other.owner.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HostnameTakenError);

    const rows = await adminDb.publicAddress.findMany({
      where: { hostname: `contended.${BASE}` },
    });
    expect(rows).toHaveLength(1);
  });

  it('lets exactly ONE of two concurrent claims in the SAME workspace win', async () => {
    // Here the workspace row lock is the arbiter, and the second claim must see
    // the first one's row — which is what the re-read INSIDE the lock buys.
    const results = await Promise.allSettled([
      publicSubdomainService.claim(fx.workspaceId, 'first', fx.ownerId),
      publicSubdomainService.claim(fx.workspaceId, 'second', fx.ownerId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const live = await adminDb.publicAddress.count({
      where: { workspaceId: fx.workspaceId, kind: 'workspace_subdomain' },
    });
    expect(live, 'a workspace must never end up with two live subdomains').toBe(1);
  });

  it('lets exactly ONE of two concurrent renames win — the second meets the limit', async () => {
    // The ledger is read UNDER the workspace lock, so the second rename sees the
    // first one's change. Read before the lock, both would pass the limit.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const results = await Promise.allSettled([
      publicSubdomainService.rename(fx.workspaceId, 'acme-one', fx.ownerId),
      publicSubdomainService.rename(fx.workspaceId, 'acme-two', fx.ownerId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SubdomainChangeLimitError);
    expect(await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } })).toBe(1);
  });
});

describe('the repository seam', () => {
  it('never leaves a workspace with two live subdomains after a rename', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId);
    const live = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
      (tx) => publicAddressRepository.findLiveSubdomainForWorkspace(fx.workspaceId, tx),
    );
    expect(live?.hostname).toBe(`acme-inc.${BASE}`);
  });
});

// ── RELEASE (ADR §8 Amendments 2 and 3 · MOTIR-4454, MOTIR-9507) ─────────
//
// A workspace may un-claim its own name. The address stops being served in the
// release's transaction, and the NAME is held for 90 days when it was held 24
// hours or more — which is a claim about ORDER inside one transaction, and only
// a forced failure can assert it.

describe('release', () => {
  it('stops serving the live label and holds its name for 90 days, saying until when', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = plus(await claimedAtOf(fx.workspaceId), 2 * DAY);

    const released = await publicSubdomainService.release(fx.workspaceId, fx.ownerId, now);

    expect(released).toEqual({ returnsAt: plus(now, 90 * DAY).toISOString() });
    expect(await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);
    const reserved = await adminDb.publicHostnameReservation.findMany({
      where: { retiredFromWorkspaceId: fx.workspaceId },
    });
    expect(reserved.map((r) => [r.hostnameHash, r.expiresAt.toISOString()])).toEqual([
      [hostnameReservationHash(`acme.${BASE}`), released.returnsAt],
    ]);
  });

  it('frees a label held under 24 hours at once — no hold, and no date', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = plus(await claimedAtOf(fx.workspaceId), DAY - 1);
    await expect(publicSubdomainService.release(fx.workspaceId, fx.ownerId, now)).resolves.toEqual({
      returnsAt: null,
    });
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
  });

  it('RESERVES BEFORE IT DELETES — a failing reserve leaves the address standing', async () => {
    // A release that commits the delete and loses the reserve hands a held name
    // back to the global namespace, and is unrepairable, because the row that
    // knew the hostname is the one that was deleted.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = plus(await claimedAtOf(fx.workspaceId), 2 * DAY);

    const boom = new Error('reserveMany exploded');
    const spy = vi
      .spyOn(publicHostnameReservationRepository, 'reserveMany')
      .mockRejectedValueOnce(boom);
    try {
      await expect(publicSubdomainService.release(fx.workspaceId, fx.ownerId, now)).rejects.toBe(
        boom,
      );
    } finally {
      spy.mockRestore();
    }

    expect(
      await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } }),
      'the transaction must roll the delete back with the reserve',
    ).toBe(1);
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    expect(await adminDb.publicSubdomainChange.count(), 'and spend no change').toBe(0);
  });

  it('leaves a CUSTOM DOMAIN on the same workspace untouched — still issued, still primary', async () => {
    // `reservesItsHostname` is what chooses the rows, and it excludes a customer
    // domain for a stated reason: that name is theirs, and holding it would be a
    // hostage. A hand-written kind list is the mistake this pins.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const project = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
    });
    const custom = await adminDb.publicAddress.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: project.id,
        kind: 'custom_domain',
        hostname: 'docs.acme.example',
        status: 'issued',
      },
    });
    await adminDb.project.update({
      where: { id: project.id },
      data: { primaryAddressId: custom.id },
    });

    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    const after = await adminDb.publicAddress.findUnique({ where: { id: custom.id } });
    expect(after?.status).toBe('issued');
    expect(
      (await adminDb.project.findUnique({ where: { id: project.id } }))?.primaryAddressId,
      'a promoted custom domain stays the canonical — release changes nothing for it',
    ).toBe(custom.id);
    expect(
      await adminDb.publicHostnameReservation.count({
        where: { hostnameHash: hostnameReservationHash('docs.acme.example') },
      }),
      'reserving a name we do not own is a hostage, not a protection',
    ).toBe(0);
  });

  it('lets a project whose primary WAS the subdomain fall back, with no manual sweep', async () => {
    // `project.primary_address_id` is ON DELETE SET NULL, so the fallback is the
    // database's. Asserted rather than implemented — a hand-run setPrimary(null)
    // would be a second copy of a constraint that already holds.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const project = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
    });
    const live = await adminDb.publicAddress.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, kind: 'workspace_subdomain' },
    });
    await adminDb.project.update({
      where: { id: project.id },
      data: { primaryAddressId: live.id },
    });

    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    const after = await adminDb.project.findUnique({ where: { id: project.id } });
    expect(after, 'the PROJECT must survive its primary address being deleted').not.toBeNull();
    expect(after?.primaryAddressId).toBeNull();
  });

  it('refuses to re-claim a held name — to another workspace AND to itself', async () => {
    // Rule 3 returns the name to the pool only at expiry, so the releasing
    // workspace is refused too.
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const now = plus(await claimedAtOf(fx.workspaceId), 2 * DAY);
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId, now);

    const other = await createTestWorkspace({ name: 'Rival' });
    await expect(
      publicSubdomainService.claim(other.workspace.id, 'acme', other.owner.id, now),
    ).rejects.toBeInstanceOf(NameQuarantinedError);
    await expect(
      publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId, now),
    ).rejects.toBeInstanceOf(NameQuarantinedError);
  });

  it('leaves a DIFFERENT label claimable, so the refusal is specific and not a lock', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);
    const other = await createTestWorkspace({ name: 'Rival' });
    await expect(
      publicSubdomainService.claim(other.workspace.id, 'acme-two', other.owner.id),
    ).resolves.toMatchObject({ hostname: `acme-two.${BASE}` });
  });

  it('makes NO certificate-provider call — the wildcard issued nothing to withdraw', async () => {
    // The obvious mistake is copying `customDomainService.remove`, whose
    // post-commit provider call is right for a customer domain and meaningless
    // for a label the wildcard `*.<base>` already covers (ADR §6).
    certificateProviderSpy.mockClear();
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);
    const renamedAt = new Date();
    await publicSubdomainService.rename(fx.workspaceId, 'acme-inc', fx.ownerId, renamedAt);
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId, plus(renamedAt, 30 * DAY));
    expect(certificateProviderSpy).not.toHaveBeenCalled();
  });

  it('answers NOT-FOUND when the workspace has never claimed one', async () => {
    // A DELETE names a resource, so this is 404 and NOT the rename path's 409 —
    // two typed errors rather than one mapped two ways.
    await expect(publicSubdomainService.release(fx.workspaceId, fx.ownerId)).rejects.toBeInstanceOf(
      SubdomainNotFoundError,
    );
  });

  it('is ADMIN-only, ABSENT off-cloud, and invisible to another workspace', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);

    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    await expect(publicSubdomainService.release(fx.workspaceId, member.id)).rejects.toBeInstanceOf(
      SubdomainForbiddenError,
    );

    const stranger = await createTestUser();
    await expect(
      publicSubdomainService.release(fx.workspaceId, stranger.id),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);

    delete process.env['MOTIR_CLOUD'];
    await expect(publicSubdomainService.release(fx.workspaceId, fx.ownerId)).rejects.toBeInstanceOf(
      PublicAddressesUnavailableError,
    );
    process.env['MOTIR_CLOUD'] = 'true';

    expect(
      await adminDb.publicAddress.count({ where: { workspaceId: fx.workspaceId } }),
      'four refused releases must have deleted nothing',
    ).toBe(1);
  });
});

describe('release and the 30-day limit (rule 4 — renames and releases count alike)', () => {
  it('cannot be bypassed by release then claim: the claim is free, the next change is not', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'a-one', fx.ownerId);
    const releasedAt = new Date();
    await publicSubdomainService.release(fx.workspaceId, fx.ownerId, releasedAt);

    // A first claim is not a change: it is not refused, and it writes no ledger.
    const dto = await publicSubdomainService.claim(
      fx.workspaceId,
      'b-one',
      fx.ownerId,
      plus(releasedAt, HOUR),
    );
    expect(dto.nextChangeAllowedAt).toBe(plus(releasedAt, 30 * DAY).toISOString());
    const ledger = await adminDb.publicSubdomainChange.findFirstOrThrow();
    expect(ledger.lastChangedAt.toISOString()).toBe(releasedAt.toISOString());

    for (const attempt of [
      () =>
        publicSubdomainService.rename(fx.workspaceId, 'b-two', fx.ownerId, plus(releasedAt, HOUR)),
      () => publicSubdomainService.release(fx.workspaceId, fx.ownerId, plus(releasedAt, HOUR)),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(SubdomainChangeLimitError);
    }
    expect(
      (await adminDb.publicAddress.findMany({ where: { workspaceId: fx.workspaceId } })).map(
        (r) => r.hostname,
      ),
    ).toEqual([`b-one.${BASE}`]);
  });

  it('has no cap: a workspace changes as often as the limit allows', async () => {
    await publicSubdomainService.claim(fx.workspaceId, 'e-0', fx.ownerId);
    let at = new Date();
    for (let i = 1; i <= 7; i += 1) {
      await publicSubdomainService.rename(fx.workspaceId, `e-${i}`, fx.ownerId, at);
      at = plus(at, 30 * DAY);
    }
    await expect(publicSubdomainService.release(fx.workspaceId, fx.ownerId, at)).resolves.toEqual({
      returnsAt: expect.any(String),
    });
  });
});

describe('release and how the rest of the system then ADDRESSES the projects', () => {
  it('keeps the projects at motir.co/p/<identifier> before and after, asserted through the services', async () => {
    // Through `publicAddressesService`, never by reading rows: the point is that
    // the RESOLUTION agrees, and a row read would pass while the service did not.
    //
    // ⚠️ `projectAccessData('public')` is load-bearing. `addressesForProject` reads the
    // address rows through the `db` SINGLETON, which is gated by the
    // `public_address_public_read` policy — so on a private project the read
    // returns EMPTY and the service answers the `motir.co` fallback. That is the
    // same value a correct release produces, so seeding a private project here
    // would make the "released" half pass for the wrong reason.
    const project = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Public Project',
        slug: 'pub',
        identifier: 'PUB',
        ...projectAccessData('public'),
      },
    });
    await publicSubdomainService.claim(fx.workspaceId, 'acme', fx.ownerId);

    const claimed = await publicAddressesService.addressesForProject(
      project.id,
      fx.workspaceId,
      project.identifier,
    );
    // MOTIR-9790: a claimed workspace subdomain serves no project, so the
    // project's address is motir.co/p/<id> while claimed AND after release.
    expect(claimed.primary).toBe(`${publicSiteOrigin()}${publicProjectPath(project.identifier)}`);
    expect(claimed.alternates).toEqual([]);
    expect(
      await publicAddressesService.primaryHostsForProjects([
        { id: project.id, workspaceId: fx.workspaceId, identifier: project.identifier },
      ]),
    ).toEqual(new Map());

    await publicSubdomainService.release(fx.workspaceId, fx.ownerId);

    const released = await publicAddressesService.addressesForProject(
      project.id,
      fx.workspaceId,
      project.identifier,
    );
    expect(
      released.primary,
      "§7's default-primary table takes its first row again once nothing is claimed",
    ).toBe(`${publicSiteOrigin()}${publicProjectPath(project.identifier)}`);
    expect(released.alternates).toEqual([]);
    expect(
      await publicAddressesService.primaryHostsForProjects([
        { id: project.id, workspaceId: fx.workspaceId, identifier: project.identifier },
      ]),
      'no host means the per-host sitemap filter matches this project on motir.co again',
    ).toEqual(new Map());
  });
});
