import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The customer-domain lifecycle — Story MOTIR-3878 · Subtask MOTIR-4216.
// Real Postgres; the two systems it cannot reach (DNS, Fly) go through their
// ports, which is the whole reason they ARE ports.

const { db } = await import('@/lib/db');
const { customDomainService, normaliseCustomHostname } =
  await import('@/lib/services/customDomainService');
const providers = await import('@/lib/publicAddresses/providers');
const {
  AddressNotFoundError,
  InvalidHostnameError,
  NotACustomerDomainError,
  PublicAddressesUnavailableError,
} = await import('@/lib/publicAddresses/errors');
const { CertificateProviderRefusedError, CertificateProviderUnavailableError } =
  await import('@/lib/publicAddresses/certificateProvider');
const { EntitlementExceededError } = await import('@/lib/billing/errors');
const { createTestWorkspace } = await import('../fixtures');

const BASE = 'motir.example';
const HOST = 'roadmap.acme.test';
/** An APEX customer domain — two labels, so it cannot take a CNAME (ADR §5). */
const APEX = 'acme-roadmap.test';
const CNAME_TARGET = 'motir-marketing.fly.dev';
const A_RECORD = '66.241.125.217';
const AAAA_RECORD = '2a09:8280:1::17d:93fd:0';

let ctx: { workspaceId: string };
let actorUserId: string;
let projectId: string;
let organizationId: string;

/** What the stubbed DNS returns for the ownership lookup. */
let txtRecords: string[] = [];
/** What the stubbed certificate port does on `request`. */
let onRequest: () => Promise<{ issued: boolean }> = async () => ({ issued: false });
/** Every side effect, in order — the ordering assertions read this. */
let trace: string[] = [];

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  process.env['MOTIR_PUBLIC_SITE_URL'] = 'https://motir.co';
  // ⚠️ SET, because a CONFIGURED deployment is the production path (MOTIR-4278,
  // ADR §10 AMENDMENT 1). This suite ran with them absent — necessarily, since
  // they did not exist — and every assertion about `dns` was therefore an
  // assertion about the unconfigured arm while reading as one about the feature.
  process.env['MOTIR_PUBLIC_ADDRESS_CNAME_TARGET'] = CNAME_TARGET;
  process.env['MOTIR_PUBLIC_ADDRESS_A_RECORDS'] = A_RECORD;
  process.env['MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS'] = AAAA_RECORD;
  trace = [];
  txtRecords = [];
  onRequest = async () => ({ issued: false });

  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  ctx = { workspaceId: workspace.id };
  actorUserId = owner.id;
  organizationId = workspace.organizationId;
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Acme',
      slug: 'acme',
      identifier: 'ACME',
      ...projectAccessData('public'),
    },
  });
  projectId = project.id;

  vi.spyOn(providers, 'dnsResolver').mockReturnValue({
    resolveTxt: async () => {
      trace.push('dns');
      return txtRecords;
    },
  });
  vi.spyOn(providers, 'certificateProvider').mockResolvedValue({
    request: async (hostname: string) => {
      trace.push('cert.request');
      const { issued } = await onRequest();
      return { hostname, configured: true, issued, dnsRequirements: [], checkedAt: new Date() };
    },
    check: async (hostname: string) => ({
      hostname,
      configured: true,
      issued: false,
      dnsRequirements: [],
      checkedAt: new Date(),
    }),
    remove: async () => {
      trace.push('cert.remove');
    },
  });
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
  delete process.env['MOTIR_PUBLIC_SITE_URL'];
  delete process.env['MOTIR_PUBLIC_ADDRESS_CNAME_TARGET'];
  delete process.env['MOTIR_PUBLIC_ADDRESS_A_RECORDS'];
  delete process.env['MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS'];
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('normaliseCustomHostname — refuses OUR addresses with their own error', () => {
  it('accepts a customer hostname and lowercases it', () => {
    expect(normaliseCustomHostname('Roadmap.Acme.TEST')).toBe('roadmap.acme.test');
    expect(normaliseCustomHostname('roadmap.acme.test.')).toBe('roadmap.acme.test');
  });

  it('refuses a non-hostname', () => {
    for (const bad of ['https://acme.test', 'acme.test/path', 'acme test', '', 'acme.test:443']) {
      expect(() => normaliseCustomHostname(bad), bad).toThrow(InvalidHostnameError);
    }
  });

  it('refuses the tenant base domain and anything under it — a DIFFERENT error', () => {
    // Not "taken": the customer already HAS this address, and the wildcard
    // already serves it. A certificate request for it would collide with the
    // wildcard or sit pending for ever.
    for (const ours of [BASE, `acme.${BASE}`, 'motir.co', 'www.motir.co']) {
      expect(() => normaliseCustomHostname(ours), ours).toThrow(NotACustomerDomainError);
    }
  });
});

describe('add', () => {
  it('creates an UNVERIFIED row carrying its ownership TXT', async () => {
    const dto = await addDomain();
    expect(dto).toMatchObject({ hostname: HOST, status: 'unverified', applicationId: null });
    expect(dto.verification?.name).toBe(`_motir-verify.${HOST}`);
    expect(dto.verification?.value).toMatch(/^motir-verify-/);
    // ⚠️ BOTH RECORDS, AND THE POINTING ONE FIRST (MOTIR-4278). This assertion
    // read `[TXT]` and passed for as long as the pointing record did not exist —
    // a customer could prove they owned a domain and was never told where to
    // point it. ADR §5's order of operations has them create BOTH at step 2,
    // before *Verify*, so both have to be on the payload the pane renders from
    // the moment the address is created.
    expect(dto.dns).toEqual([
      { type: 'CNAME', name: HOST, value: CNAME_TARGET },
      { type: 'TXT', name: `_motir-verify.${HOST}`, value: dto.verification!.value },
    ]);
  });

  it('an APEX is given A + AAAA instead — it cannot take a CNAME (RFC 1034 §3.6.2)', async () => {
    const dto = await addDomain(APEX);
    expect(dto.dns).toEqual([
      { type: 'A', name: APEX, value: A_RECORD },
      { type: 'AAAA', name: APEX, value: AAAA_RECORD },
      { type: 'TXT', name: `_motir-verify.${APEX}`, value: dto.verification!.value },
    ]);
    // The pane draws its apex caveat off the presence of an address record, so
    // this is also what makes that note appear for exactly the right customers.
    expect(dto.dns.some((r) => r.type === 'CNAME')).toBe(false);
  });

  it('an UNCONFIGURED deployment shows the ownership record ALONE, never a guess', async () => {
    // The honest degraded state, and the one production was in until the
    // variables were provisioned: a value copied into a customer's own zone must
    // never be invented (`tenantDomain.ts`'s rule).
    delete process.env['MOTIR_PUBLIC_ADDRESS_CNAME_TARGET'];
    delete process.env['MOTIR_PUBLIC_ADDRESS_A_RECORDS'];
    delete process.env['MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS'];
    const dto = await addDomain('unconfigured.acme.test');
    expect(dto.dns).toEqual([
      { type: 'TXT', name: '_motir-verify.unconfigured.acme.test', value: dto.verification!.value },
    ]);
  });

  it('mints a DIFFERENT token per address', async () => {
    const a = await addDomain();
    const b = await addDomain('status.acme.test');
    expect(a.verification!.value).not.toBe(b.verification!.value);
  });

  it('surfaces the entitlement cap in the billing surface’s own shape', async () => {
    // `free: 0` refuses the FIRST domain, which is what makes the refusal the
    // upgrade prompt's trigger rather than an empty state.
    //
    // ⚠️ Calls the service DIRECTLY rather than through `addDomain`, which
    // upgrades the org to the paid tier — going through the helper would have
    // tested the paid path while claiming to test the cap.
    const err = await customDomainService
      .add({ key: 'ACME', hostname: 'capped.acme.test', actorUserId, ctx })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntitlementExceededError);
    expect((err as InstanceType<typeof EntitlementExceededError>).entitlement).toBe(
      'custom_domains',
    );
  });
});

describe('verify — the side effects happen OUTSIDE any transaction, in order', () => {
  it('DNS then the certificate request, and only then a write', async () => {
    // ⚠️ The ORDER is the assertion, not the outcome. Holding a Postgres
    // transaction across a DNS lookup and a third party's certificate API means
    // holding a row lock across their latency.
    const dto = await addDomain();
    txtRecords = [dto.verification!.value];
    onRequest = async () => ({ issued: false });

    const after = await customDomainService.verify({
      key: 'ACME',
      addressId: dto.id,
      actorUserId,
      ctx,
    });

    expect(trace).toEqual(['dns', 'cert.request']);
    expect(after.status).toBe('pending_certificate');
    expect(after.failureReason).toBeNull();
  });

  it('goes straight to ISSUED when the platform says so', async () => {
    const dto = await addDomain();
    txtRecords = [dto.verification!.value];
    onRequest = async () => ({ issued: true });

    const after = await customDomainService.verify({
      key: 'ACME',
      addressId: dto.id,
      actorUserId,
      ctx,
    });
    expect(after.status).toBe('issued');
    expect(after.issuedAt).not.toBeNull();
    // The ownership record stops being shown once it is no longer owed.
    expect(after.verification).toBeNull();
    // ⚠️ THE POINTING RECORD DOES NOT (MOTIR-4278). The two are dropped on
    // opposite rules: the TXT is a task the customer has finished, and the CNAME
    // is the live configuration — deleting it from their zone would take the
    // address down, so it stays on the payload for the customer auditing their
    // records months later.
    expect(after.dns).toEqual([{ type: 'CNAME', name: HOST, value: CNAME_TARGET }]);
  });

  it('a MISSING record leaves it unverified with an actionable reason', async () => {
    // NOT `failed`: failed means we asked and were refused. This means the
    // customer has not finished, which is an ordinary state on the way in.
    const dto = await addDomain();
    txtRecords = [];

    const after = await customDomainService.verify({
      key: 'ACME',
      addressId: dto.id,
      actorUserId,
      ctx,
    });
    expect(after.status).toBe('unverified');
    expect(after.failureReason).toContain('No _motir-verify TXT record');
    // And no certificate was requested for an unproven hostname — the ADR §5
    // order, which is a security property rather than a nicety.
    expect(trace).toEqual(['dns']);
  });

  it('a WRONG value is reported differently from a missing one', async () => {
    const dto = await addDomain();
    txtRecords = ['motir-verify-somebody-elses'];
    const after = await customDomainService.verify({
      key: 'ACME',
      addressId: dto.id,
      actorUserId,
      ctx,
    });
    expect(after.status).toBe('unverified');
    expect(after.failureReason).toContain('not the expected value');
    expect(trace).toEqual(['dns']);
  });

  it('a platform REFUSAL moves it to failed, carrying the platform’s reason', async () => {
    const dto = await addDomain();
    txtRecords = [dto.verification!.value];
    onRequest = async () => {
      throw new CertificateProviderRefusedError(422, 'hostname is not pointed at this app');
    };
    const after = await customDomainService.verify({
      key: 'ACME',
      addressId: dto.id,
      actorUserId,
      ctx,
    });
    expect(after.status).toBe('failed');
    expect(after.failureReason).toBe('hostname is not pointed at this app');
  });

  it('a platform OUTAGE changes nothing and rethrows — retrying is the answer', async () => {
    // The opposite disposition from a refusal: nothing about the customer's
    // input caused it, so the row must not be moved to a state they would then
    // try to fix.
    const dto = await addDomain();
    txtRecords = [dto.verification!.value];
    onRequest = async () => {
      throw new CertificateProviderUnavailableError('503 upstream');
    };
    await expect(
      customDomainService.verify({ key: 'ACME', addressId: dto.id, actorUserId, ctx }),
    ).rejects.toBeInstanceOf(CertificateProviderUnavailableError);

    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.status, 'an outage must not move the row').toBe('unverified');
  });
});

describe('remove', () => {
  it('deletes the row, THEN withdraws the certificate', async () => {
    const dto = await addDomain();
    trace = [];
    await customDomainService.remove({ key: 'ACME', addressId: dto.id, actorUserId, ctx });

    expect(await adminDb.publicAddress.findUnique({ where: { id: dto.id } })).toBeNull();
    expect(trace).toEqual(['cert.remove']);
  });

  it("a domain is the WORKSPACE's — removing it touches no project", async () => {
    // ADR MOTIR-9521 §1: the row carries no project, so there is nothing for a
    // delete to cascade into or fall back from.
    const dto = await addDomain();
    await customDomainService.remove({ key: 'ACME', addressId: dto.id, actorUserId, ctx });
    expect(await adminDb.project.findUnique({ where: { id: projectId } })).not.toBeNull();
  });

  it('refuses an id that is not a customer domain of this workspace', async () => {
    // A workspace subdomain shares the table; the lifecycle must not reach it.
    const sub = await adminDb.publicAddress.create({
      data: {
        workspaceId: ctx.workspaceId,
        hostname: `acme.${BASE}`,
        kind: 'workspace_subdomain',
        status: 'active',
      },
    });
    await expect(
      customDomainService.remove({ key: 'ACME', addressId: sub.id, actorUserId, ctx }),
    ).rejects.toBeInstanceOf(AddressNotFoundError);
    expect(await adminDb.publicAddress.findUnique({ where: { id: sub.id } })).not.toBeNull();
  });

  it('still succeeds when the platform withdrawal FAILS', async () => {
    // The row is the source of truth for what we serve. Once it is gone the
    // address answers nothing, so a certificate left on the platform protects
    // nothing — failing the customer's request over it would report a cleanup
    // problem as a user error.
    const dto = await addDomain();
    vi.spyOn(providers, 'certificateProvider').mockResolvedValue({
      request: async () => {
        throw new Error('unused');
      },
      check: async () => {
        throw new Error('unused');
      },
      remove: async () => {
        throw new CertificateProviderUnavailableError('503');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      customDomainService.remove({ key: 'ACME', addressId: dto.id, actorUserId, ctx }),
    ).resolves.toBeUndefined();
    expect(await adminDb.publicAddress.findUnique({ where: { id: dto.id } })).toBeNull();
    // Logged with the hostname, so the leftover is findable.
    expect(warn.mock.calls[0]?.[0]).toContain(HOST);
  });
});

describe('the gates', () => {
  it('is ABSENT off-cloud, on every operation', async () => {
    delete process.env['MOTIR_CLOUD'];
    await expect(
      customDomainService.list({ key: 'ACME', actorUserId, ctx }),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
    await expect(
      customDomainService.add({ key: 'ACME', hostname: HOST, actorUserId, ctx }),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
  });

  it("lists the WORKSPACE's customer domains, unbound until re-pointed", async () => {
    const dto = await addDomain();
    // A second project in the same workspace sees the same domains — they are
    // the workspace's, not the project's (ADR MOTIR-9521 §1).
    await adminDb.project.create({
      data: {
        workspaceId: ctx.workspaceId,
        name: 'Beta',
        slug: 'beta',
        identifier: 'BETA',
        ...projectAccessData('public'),
      },
    });
    const fromAcme = await customDomainService.list({ key: 'ACME', actorUserId, ctx });
    const fromBeta = await customDomainService.list({ key: 'BETA', actorUserId, ctx });
    expect(fromAcme.map((r) => r.hostname)).toEqual([HOST]);
    expect(fromBeta.map((r) => r.id)).toEqual([dto.id]);
    expect(fromAcme[0]!.applicationId).toBeNull();
  });
});

async function addDomain(hostname = HOST) {
  // Paid tier, so the cap is not the thing under test unless a case says so.
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
  return customDomainService.add({ key: 'ACME', hostname, actorUserId, ctx });
}
