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
  ApplicationNotFoundError,
  InvalidHostnameError,
  NotACustomerDomainError,
  PublicAddressesUnavailableError,
  SubdomainForbiddenError,
  WorkspaceNotVisibleError,
} = await import('@/lib/publicAddresses/errors');
const {
  CertificateHostnameUnknownError,
  CertificateProviderRefusedError,
  CertificateProviderUnavailableError,
} = await import('@/lib/publicAddresses/certificateProvider');
const { EntitlementExceededError } = await import('@/lib/billing/errors');
const { createTestUser, createTestWorkspace } = await import('../fixtures');

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
/** Hostnames the stubbed edge already holds a certificate for. */
let held: string[] = [];

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
  held = [];
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
      return {
        hostname,
        configured: true,
        issued,
        dnsRequirements: [],
        checkedAt: new Date(),
        expiresAt: null,
      };
    },
    check: async (hostname: string) => {
      trace.push('cert.check');
      // Like Fly: a hostname the edge does not hold is unknown, not "not issued".
      if (!held.includes(hostname)) throw new CertificateHostnameUnknownError(hostname);
      return {
        hostname,
        configured: true,
        issued: true,
        dnsRequirements: [],
        checkedAt: new Date(),
        expiresAt: null,
      };
    },
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
    for (const [ours, reason] of [
      [BASE, 'tenant_base'],
      [`acme.${BASE}`, 'tenant_base'],
      ['motir.co', 'site_origin'],
      ['www.motir.co', 'site_origin'],
    ] as const) {
      expect(() => normaliseCustomHostname(ours), ours).toThrow(NotACustomerDomainError);
      try {
        normaliseCustomHostname(ours);
      } catch (err) {
        // The pane says a different sentence for each (MOTIR-9524).
        expect((err as InstanceType<typeof NotACustomerDomainError>).reason, ours).toBe(reason);
      }
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
      .add({ workspaceId: ctx.workspaceId, hostname: 'capped.acme.test', actorUserId })
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
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
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
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
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
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
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
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
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
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
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
      customDomainService.verify({ workspaceId: ctx.workspaceId, addressId: dto.id, actorUserId }),
    ).rejects.toBeInstanceOf(CertificateProviderUnavailableError);

    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.status, 'an outage must not move the row').toBe('unverified');
  });
});

describe('remove', () => {
  it('deletes the row, THEN withdraws the certificate', async () => {
    const dto = await addDomain();
    trace = [];
    await customDomainService.remove({
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
    });

    expect(await adminDb.publicAddress.findUnique({ where: { id: dto.id } })).toBeNull();
    expect(trace).toEqual(['cert.remove']);
    // ADR MOTIR-9521: the customer owns their hostname, so its removal holds
    // nothing back from them — no reservation is written.
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
  });

  it("a domain is the WORKSPACE's — removing it touches no project", async () => {
    // ADR MOTIR-9521 §1: the row carries no project, so there is nothing for a
    // delete to cascade into or fall back from.
    const dto = await addDomain();
    await customDomainService.remove({
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
    });
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
      customDomainService.remove({ workspaceId: ctx.workspaceId, addressId: sub.id, actorUserId }),
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
      customDomainService.remove({ workspaceId: ctx.workspaceId, addressId: dto.id, actorUserId }),
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
      customDomainService.list({ workspaceId: ctx.workspaceId, actorUserId }),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
    await expect(
      customDomainService.add({ workspaceId: ctx.workspaceId, hostname: HOST, actorUserId }),
    ).rejects.toBeInstanceOf(PublicAddressesUnavailableError);
  });

  it("lists the WORKSPACE's customer domains, unbound until re-pointed", async () => {
    const dto = await addDomain();
    // The domain is the workspace's, not a project's (ADR MOTIR-9521 §1), so
    // the list is keyed by the workspace alone.
    const listed = await customDomainService.list({ workspaceId: ctx.workspaceId, actorUserId });
    expect(listed.map((r) => r.id)).toEqual([dto.id]);
    expect(listed[0]!.applicationId).toBeNull();
  });

  it('lets a MEMBER read, and refuses them every write (MOTIR-9524)', async () => {
    // The workspace ADDRESS gate — the same one the subdomain uses: any member
    // reads, an owner, admin or manager writes.
    const dto = await addDomain();
    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: ctx.workspaceId, workspaceRole: 'member' },
    });
    const scope = { workspaceId: ctx.workspaceId, actorUserId: member.id };

    await expect(customDomainService.list(scope)).resolves.toHaveLength(1);
    await expect(
      customDomainService.add({ ...scope, hostname: 'other.acme.test' }),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
    await expect(
      customDomainService.verify({ ...scope, addressId: dto.id }),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
    await expect(
      customDomainService.remove({ ...scope, addressId: dto.id }),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
    expect(await adminDb.publicAddress.findUnique({ where: { id: dto.id } })).not.toBeNull();
  });

  it('the pane reads the domains, canManage on the WORKSPACE axis, and the tier cap (MOTIR-9529)', async () => {
    await addDomain();
    const owner = await customDomainService.listForPane({
      workspaceId: ctx.workspaceId,
      actorUserId,
    });
    expect(owner.addresses.map((a) => a.hostname)).toEqual([HOST]);
    expect(owner.canManage).toBe(true);
    // The cap is the tier's own number (or null for none), never re-derived.
    expect(owner.maxDomains === null || typeof owner.maxDomains === 'number').toBe(true);

    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: ctx.workspaceId, workspaceRole: 'member' },
    });
    const read = await customDomainService.listForPane({
      workspaceId: ctx.workspaceId,
      actorUserId: member.id,
    });
    expect(read.addresses).toHaveLength(1);
    expect(read.canManage).toBe(false);
  });

  it('answers a NON-MEMBER not-found, on read and write alike', async () => {
    const stranger = await createTestUser();
    const scope = { workspaceId: ctx.workspaceId, actorUserId: stranger.id };
    await expect(customDomainService.list(scope)).rejects.toBeInstanceOf(WorkspaceNotVisibleError);
    await expect(customDomainService.add({ ...scope, hostname: HOST })).rejects.toBeInstanceOf(
      WorkspaceNotVisibleError,
    );
  });
});

describe('the application a domain names (ADR MOTIR-9521 §1)', () => {
  it('names one of the workspace’s applications at add, and re-points or unbinds later', async () => {
    const first = await seedApplication(ctx.workspaceId, projectId, 'shop');
    const second = await seedApplication(ctx.workspaceId, projectId, 'blog');
    const dto = await addDomain(HOST, first);
    expect(dto.applicationId).toBe(first);

    const repointed = await customDomainService.bind({
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
      applicationId: second,
    });
    expect(repointed.applicationId).toBe(second);
    // Ownership and the certificate are the hostname's: a re-point keeps the status.
    expect(repointed.status).toBe(dto.status);

    const unbound = await customDomainService.bind({
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
      applicationId: null,
    });
    expect(unbound.applicationId).toBeNull();
  });

  it('refuses another workspace’s application, on add and on re-point alike', async () => {
    const other = await createTestWorkspace({ name: 'Other' });
    const otherProject = await adminDb.project.create({
      data: {
        workspaceId: other.workspace.id,
        name: 'Other',
        slug: 'other',
        identifier: 'OTHR',
        ...projectAccessData('public'),
      },
    });
    const foreign = await seedApplication(other.workspace.id, otherProject.id, 'theirs');

    await expect(addDomain(HOST, foreign)).rejects.toBeInstanceOf(ApplicationNotFoundError);
    expect(await adminDb.publicAddress.count({ where: { hostname: HOST } })).toBe(0);

    const dto = await addDomain(HOST);
    await expect(
      customDomainService.bind({
        workspaceId: ctx.workspaceId,
        addressId: dto.id,
        actorUserId,
        applicationId: foreign,
      }),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
  });

  it('the pane reads the workspace’s applications by name and slug, and never another’s (MOTIR-9529)', async () => {
    const blog = await seedApplication(ctx.workspaceId, projectId, 'blog');
    const shop = await seedApplication(ctx.workspaceId, projectId, 'shop');
    const other = await createTestWorkspace({ name: 'Elsewhere' });
    const otherProject = await adminDb.project.create({
      data: {
        workspaceId: other.workspace.id,
        name: 'Elsewhere',
        slug: 'elsewhere',
        identifier: 'ELSW',
        ...projectAccessData('public'),
      },
    });
    await seedApplication(other.workspace.id, otherProject.id, 'theirs');

    const pane = await customDomainService.listForPane({
      workspaceId: ctx.workspaceId,
      actorUserId,
    });
    // An application has no name of its own: the picker shows its project's.
    expect(pane.applications).toEqual([
      { id: blog, name: 'Acme', slug: 'blog' },
      { id: shop, name: 'Acme', slug: 'shop' },
    ]);
  });
});

describe('a certificate left behind is the next owner’s (ADR MOTIR-9521 §6)', () => {
  it('a refused request for a hostname the edge already holds counts as requested', async () => {
    const dto = await addDomain();
    txtRecords = [dto.verification!.value];
    held = [HOST];
    onRequest = async () => {
      throw new CertificateProviderRefusedError(422, 'hostname already exists');
    };
    const after = await customDomainService.verify({
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
    });
    expect(after.status).toBe('issued');
    expect(trace).toEqual(['dns', 'cert.request', 'cert.check']);
  });

  it('a removed name can be added again at once, by another workspace', async () => {
    const dto = await addDomain();
    await customDomainService.remove({
      workspaceId: ctx.workspaceId,
      addressId: dto.id,
      actorUserId,
    });

    const other = await createTestWorkspace({ name: 'Second' });
    await adminDb.organization.update({
      where: { id: other.workspace.organizationId },
      data: {
        scaledTrackerSubscription: {
          status: 'active',
          priceId: 'price_test',
          quantity: 1,
        } as never,
      },
    });
    const again = await customDomainService.add({
      workspaceId: other.workspace.id,
      hostname: HOST,
      actorUserId: other.owner.id,
    });
    expect(again.status).toBe('unverified');
    // A FRESH token: the previous owner's TXT proves nothing for the new one.
    expect(again.verification!.value).not.toBe(dto.verification!.value);
  });
});

async function seedApplication(workspaceId: string, onProject: string, slug: string) {
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId,
      projectId: onProject,
      role: 'web',
      name: slug,
      position: 'a0',
      seedSource: 'initialised',
    },
  });
  const app = await adminDb.hostedApplication.create({
    data: { workspaceId, projectId: onProject, projectRepositoryId: repo.id, target: 'fly', slug },
  });
  return app.id;
}

async function addDomain(hostname = HOST, applicationId?: string) {
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
  return customDomainService.add({
    workspaceId: ctx.workspaceId,
    hostname,
    actorUserId,
    applicationId,
  });
}
