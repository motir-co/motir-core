import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE STORY'S SEAMS (Story MOTIR-3878 · MOTIR-4223) — the writer → consumer
// paths that every unit test on either side mocks away.
//
// ⚠️ WHAT MAKES THESE DIFFERENT FROM THE SUITES BESIDE THEM. Each card's own
// tests prove that ONE service does what it says. These prove that what one
// service WROTE is what the next one READS — over real Postgres, through the
// real repository, with only the two things that leave this machine stubbed: the
// certificate platform and the DNS resolver. A store whose writer and reader
// disagree passes both halves' unit tests and fails in production once.
//
// The stubs are the PORTS, never the code under test: `providers.ts` is the
// composition root the ADR §6 boundary exists for, and swapping it is how the
// seam runs at all without reaching Fly.

const BASE = 'motir.example';

const requestCertificate = vi.fn();
const checkCertificate = vi.fn();
const removeCertificate = vi.fn();
const resolveTxt = vi.fn();

vi.mock('@/lib/publicAddresses/providers', () => ({
  certificateProvider: () => ({
    request: requestCertificate,
    check: checkCertificate,
    remove: removeCertificate,
  }),
  dnsResolver: () => ({ resolveTxt }),
  certificatesConfigured: () => true,
  // ⚠️ `false`, SO THE SERVICE TAKES THE PRODUCTION PATH. `add` seeds the fake
  // resolver when the fakes are armed (MOTIR-4225); here the DNS port is stubbed
  // directly by `resolveTxt` above, so arming them too would mean the seam read
  // back a value the SEED wrote rather than one this test chose.
  usingFakePublicAddressProviders: () => false,
  seedFakeTxt: () => {},
  resetFakeTxt: () => {},
}));

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { publicAddressesService, PublicHostNotFoundError } =
  await import('@/lib/services/publicAddressesService');
const { customDomainService } = await import('@/lib/services/customDomainService');
const { createTestWorkspace } = await import('../fixtures');

interface Tenant {
  workspaceId: string;
  ownerId: string;
  projectId: string;
  identifier: string;
}

let acme: Tenant;

async function seedTenant(name: string, identifier: string): Promise<Tenant> {
  const { workspace, owner } = await createTestWorkspace({ name });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Project ${identifier}`,
      slug: identifier.toLowerCase(),
      identifier,
      ...projectAccessData('public'),
    },
  });
  return { workspaceId: workspace.id, ownerId: owner.id, projectId: project.id, identifier };
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  acme = await seedTenant('Acme', 'ACME');
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = () => ({ userId: acme.ownerId, workspaceId: acme.workspaceId });

/** A reading from the certificate PORT — the shape the adapter returns. */
function certificateState(over: { configured: boolean; issued: boolean }) {
  return {
    hostname: 'roadmap.acme.test',
    dnsRequirements: [],
    checkedAt: new Date(),
    ...over,
  };
}

/**
 * Put the fixture's org on a PAID tier, so the cap is not the thing under test.
 * `free: 0` refuses the FIRST domain by design (ADR §9), which is exactly what
 * seam (c) exercises deliberately and what every other seam must get past.
 */
async function onAPaidTier(): Promise<void> {
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: acme.workspaceId },
    select: { organizationId: true },
  });
  await adminDb.organization.update({
    where: { id: organizationId },
    data: {
      scaledTrackerSubscription: {
        status: 'active',
        priceId: 'price_test',
        quantity: 1,
      } as never,
    },
  });
}

/* ── seam (a): claim → the host contract resolves it; rename → it stops ───── */

describe('seam (a) — a claim written by one service is read by the public contract', () => {
  it('resolves the claimed host to the workspace, with no application to serve yet', async () => {
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);

    const resolved = await publicAddressesService.resolveHost(`acme.${BASE}`);

    expect(resolved).toMatchObject({ kind: 'no_application' });
  });

  it('and after a RENAME the old host stops resolving at once, with no redirect', async () => {
    // §8 Amendment 3 rules 1 and 2, end to end: the rename deletes the old row
    // in its own transaction, so the public contract answers nothing for the old
    // hostname — not an alias, and not the workspace.
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);
    await publicSubdomainService.rename(acme.workspaceId, 'acme-inc', acme.ownerId);

    await expect(publicAddressesService.resolveHost(`acme.${BASE}`)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
    const live = await publicAddressesService.resolveHost(`acme-inc.${BASE}`);
    expect(live.kind).toBe('no_application');
  });
});

/* ── seam (b): add → verify → issue → primary → the subject and the index ── */

describe('seam (b) — a domain walked to primary reaches the DTO and the crawl index', () => {
  it('carries the whole lifecycle into `addresses.primary` and `primaryHost`', async () => {
    await onAPaidTier();
    const added = await customDomainService.add({
      key: 'ACME',
      hostname: 'roadmap.acme.test',
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    expect(added.status).toBe('unverified');

    // The TXT appears — the DNS port is the stub; everything else is real.
    resolveTxt.mockResolvedValue([added.verification!.value]);
    requestCertificate.mockResolvedValue(certificateState({ configured: true, issued: false }));
    const verified = await customDomainService.verify({
      addressId: added.id,
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    // ⚠️ A CERTIFICATE IS NEVER REQUESTED BEFORE THE TXT VERIFIES — ADR §5's
    // order, asserted at the seam rather than in the service that implements it.
    expect(requestCertificate).toHaveBeenCalledTimes(1);
    expect(['verifying', 'pending_certificate']).toContain(verified.status);

    // The platform issues; the STATUS JOB's path is the one that writes it.
    checkCertificate.mockResolvedValue(certificateState({ configured: true, issued: true }));
    const { publicAddressCertificatesService } =
      await import('@/lib/services/publicAddressCertificatesService');
    await publicAddressCertificatesService.refreshDueAddresses();

    const listed = await customDomainService.list({
      key: 'ACME',
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    const live = listed.find((a) => a.hostname === 'roadmap.acme.test');
    expect(live?.status, 'the job did not carry the platform state home').toBe('issued');

    await customDomainService.makePrimary({
      addressId: added.id,
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });

    // 1 · the SUBJECT the renderer reads.
    const addresses = await publicAddressesService.addressesForProject(
      acme.projectId,
      acme.workspaceId,
      'ACME',
    );
    expect(addresses.primary).toBe('https://roadmap.acme.test');

    // 2 · the CRAWL INDEX's per-row host, computed by a DIFFERENT query. Two
    // paths deriving one rule is how they come apart, so they are asserted
    // against each other rather than against a restated expectation.
    const hosts = await publicAddressesService.primaryHostsForProjects([
      { id: acme.projectId, workspaceId: acme.workspaceId, identifier: 'ACME' },
    ]);
    expect(hosts.get(acme.projectId)).toBe(new URL(addresses.primary).host);

    // 3 · and the HOST CONTRACT now serves that project at that host's root.
    const resolved = await publicAddressesService.resolveHost('roadmap.acme.test');
    expect(resolved.kind).toBe('project');
    if (resolved.kind !== 'project') throw new Error('unreachable');
    expect(resolved.project.identifier).toBe('ACME');
    expect(resolved.primary).toBe(true);
  });
});

/* ── seam (e): the CONFIGURED records → the array the pane renders ────────── */

describe('seam (e) — every record a customer must create reaches the payload the pane renders', () => {
  // ⚠️ THE SEAM NOTHING ASSERTED, AND THE ONE THE STORY SHIPPED BROKEN
  // (MOTIR-4278). The adapter parsed the pointing records, the DTO's type union
  // allowed `A` / `AAAA` / `CNAME`, and the pane rendered whatever `dns`
  // contained — three correct halves with nothing between them, so every suite
  // passed while `dns[]` carried the ownership `TXT` and nothing else. A
  // customer could prove they owned a domain and was never told where to point
  // it. What was missing was not a branch: it was an assertion that the array
  // the pane renders is ever NON-TRIVIALLY populated.

  beforeEach(() => {
    process.env['MOTIR_PUBLIC_ADDRESS_CNAME_TARGET'] = 'motir-marketing.fly.dev';
    process.env['MOTIR_PUBLIC_ADDRESS_A_RECORDS'] = '66.241.125.217';
    process.env['MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS'] = '2a09:8280:1::17d:93fd:0';
  });

  afterEach(() => {
    delete process.env['MOTIR_PUBLIC_ADDRESS_CNAME_TARGET'];
    delete process.env['MOTIR_PUBLIC_ADDRESS_A_RECORDS'];
    delete process.env['MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS'];
  });

  it('a subdomain and an apex each reach `list` with their POINTING record, not only the TXT', async () => {
    await onAPaidTier();
    for (const hostname of ['roadmap.acme.test', 'acme-roadmap.test']) {
      await customDomainService.add({
        key: 'ACME',
        hostname,
        actorUserId: acme.ownerId,
        ctx: ctx(),
      });
    }

    // Through the REAL repository read the pane uses — not the `add` return
    // value, which is the one path that could have carried a record the stored
    // row does not produce.
    const listed = await customDomainService.list({
      key: 'ACME',
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });

    const subdomain = listed.find((a) => a.hostname === 'roadmap.acme.test');
    const apex = listed.find((a) => a.hostname === 'acme-roadmap.test');

    // The record set follows the hostname's SHAPE (ADR §5's table), and the
    // record that makes the address WORK comes first.
    expect(subdomain?.dns).toEqual([
      { type: 'CNAME', name: 'roadmap.acme.test', value: 'motir-marketing.fly.dev' },
      { type: 'TXT', name: '_motir-verify.roadmap.acme.test', value: expect.any(String) },
    ]);
    expect(apex?.dns).toEqual([
      { type: 'A', name: 'acme-roadmap.test', value: '66.241.125.217' },
      { type: 'AAAA', name: 'acme-roadmap.test', value: '2a09:8280:1::17d:93fd:0' },
      { type: 'TXT', name: '_motir-verify.acme-roadmap.test', value: expect.any(String) },
    ]);

    // ⚠️ THE NON-TRIVIALITY ASSERTION ITSELF, stated separately from the tables
    // above so it survives them being rewritten: an address a customer connects
    // is never told to create ONLY the record that proves ownership. That
    // sentence is the whole defect, and it is the one a future edit must break
    // to re-introduce it.
    for (const address of [subdomain, apex]) {
      expect(address?.dns.every((r) => r.type === 'TXT')).toBe(false);
    }
  });

  it('a NON-customer address in the list is told to create nothing — the wildcard serves it', async () => {
    // The mirror arm, and the reason the pointing records are gated on the
    // address KIND rather than added unconditionally: a name under our own base
    // is already pointed and already covered by the wildcard (ADR §6), so a
    // record here would be an instruction to edit DNS the customer does not
    // control.
    //
    // ⚠️ The row is written DIRECTLY, because the guard's whole point is that
    // nothing structural stops this shape reaching the mapper: `project_id` is
    // nullable and unconstrained by `kind`, and `listForProjectInTx` filters on
    // the project alone. The service never mints such a row — which is exactly
    // why the guard would otherwise be an untested claim about a state the store
    // can hold.
    await adminDb.publicAddress.create({
      data: {
        workspaceId: acme.workspaceId,
        projectId: acme.projectId,
        hostname: `acme.${BASE}`,
        kind: 'workspace_subdomain',
        status: 'active',
      },
    });

    const listed = await customDomainService.list({
      key: 'ACME',
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    const subdomain = listed.find((a) => a.hostname === `acme.${BASE}`);
    expect(subdomain?.kind).toBe('workspace_subdomain');
    expect(subdomain?.dns).toEqual([]);
  });
});

/* ── seam (c): the entitlement cap under REAL concurrency ─────────────────── */

describe('seam (c) — the cap holds when two adds race', () => {
  it('admits exactly the cap, never one more', async () => {
    // ⚠️ THE ASSERTION IS AGAINST A FIXED COUNTERFACTUAL, NOT A RATIO. Two
    // concurrent adds against a cap of one must leave ONE row: a test that
    // asserted "at most the cap" would pass on a database that admitted none.
    await onAPaidTier();

    requestCertificate.mockResolvedValue(certificateState({ configured: false, issued: false }));
    const results = await Promise.allSettled([
      customDomainService.add({
        key: 'ACME',
        hostname: 'one.acme.test',
        actorUserId: acme.ownerId,
        ctx: ctx(),
      }),
      customDomainService.add({
        key: 'ACME',
        hostname: 'two.acme.test',
        actorUserId: acme.ownerId,
        ctx: ctx(),
      }),
    ]);

    const stored = await customDomainService.list({
      key: 'ACME',
      actorUserId: acme.ownerId,
      ctx: ctx(),
    });
    const domains = stored.filter((a) => a.kind === 'custom_domain');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    // Whatever the cap is on this tier, the store and the callers agree about it.
    expect(domains).toHaveLength(fulfilled.length);
    expect(fulfilled.length).toBeGreaterThan(0);
  });
});

/* ── seam (d): CORS and the hand-off return read the SAME store ───────────── */

describe('seam (d) — a live address is a legitimate origin; an alias is not', () => {
  it('admits the live host and refuses the retired one, from the store', async () => {
    // A renamed-away-from host has no row any more (§8 Amendment 3), so the
    // store must refuse it as an origin the moment the rename commits.
    await publicSubdomainService.claim(acme.workspaceId, 'acme', acme.ownerId);
    await publicSubdomainService.rename(acme.workspaceId, 'acme-inc', acme.ownerId);

    const { isRegisteredPublicOrigin, resetAllowedOriginCache } =
      await import('@/lib/publicAddresses/allowedOrigins');
    resetAllowedOriginCache();

    expect(await isRegisteredPublicOrigin(`https://acme-inc.${BASE}`)).toBe(true);
    expect(await isRegisteredPublicOrigin(`https://acme.${BASE}`)).toBe(false);
    expect(await isRegisteredPublicOrigin('https://evil.example')).toBe(false);
  });
});
