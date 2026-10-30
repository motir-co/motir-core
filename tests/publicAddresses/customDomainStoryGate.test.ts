import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE STORY GATE for customer domains on the motir-core side — Story MOTIR-4533
// · MOTIR-9530.
//
// Each code card ships its own focused tests. This file asserts the ASSEMBLED
// behaviour, end to end through the service and repository layers against the
// real Postgres: add → verify → the sweep → the host contract → remove, with the
// tier cap and the two refusals of our own namespaces. Only the two systems
// motir-core cannot reach are stubbed, at their ports — the certificate
// provider and the DNS resolver — exactly as the sweep's own test does.
//
// ⚠️ THE HOST-CONTRACT CASES READ ANONYMOUSLY, with a PRIVATE project in the
// workspace: `findByHostname` runs on the unbound client, where only the
// `public_address_public_read` arm can admit a row. A fixture in which the
// actor saw everything would pass a wrongly scoped read.

const resolveApplicationTarget = vi.hoisted(() => vi.fn());
vi.mock('@/lib/publicAddresses/applicationTarget', () => ({ resolveApplicationTarget }));

const { db } = await import('@/lib/db');
const { customDomainService } = await import('@/lib/services/customDomainService');
const { publicAddressCertificatesService } =
  await import('@/lib/services/publicAddressCertificatesService');
const { publicAddressesService, PublicHostNotFoundError } =
  await import('@/lib/services/publicAddressesService');
const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
const { hostedApplicationRepository } =
  await import('@/lib/repositories/hostedApplicationRepository');
const providers = await import('@/lib/publicAddresses/providers');
const {
  AddressNotFoundError,
  InvalidHostnameError,
  NotACustomerDomainError,
  SubdomainForbiddenError,
  WorkspaceNotVisibleError,
} = await import('@/lib/publicAddresses/errors');
const { EntitlementExceededError } = await import('@/lib/billing/errors');
const { createTestUser, createTestWorkspace } = await import('../fixtures');

const BASE = 'motir.example';
const HOST = 'app.acme.test';
const APEX = 'acme-roadmap.test';
const CNAME_TARGET = 'motir-edge.fly.dev';
const A_RECORD = '66.241.125.1';
const UPSTREAM = {
  origin: 'https://mh-shop.fly.dev',
  appRef: 'mh-shop',
  credential: 'origin_secret',
} as const;

interface Tenant {
  workspaceId: string;
  organizationId: string;
  ownerId: string;
  projectId: string;
}

let acme: Tenant;

/** The TXT records the stubbed resolver holds, by name — or an Error to throw. */
let zone: Record<string, string[] | Error> = {};
/** What the stubbed edge says about a hostname. */
let edge: Record<string, { configured: boolean; issued: boolean }> = {};
/** Whether the stubbed edge's withdrawal fails. */
let removeFails = false;
let requests: string[] = [];

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_PUBLIC_TENANT_DOMAIN', BASE);
  vi.stubEnv('MOTIR_PUBLIC_SITE_URL', 'https://motir.co');
  vi.stubEnv('MOTIR_PUBLIC_ADDRESS_CNAME_TARGET', CNAME_TARGET);
  vi.stubEnv('MOTIR_PUBLIC_ADDRESS_A_RECORDS', A_RECORD);
  vi.stubEnv('FLY_CERTS_TOKEN', 'test-token');
  vi.stubEnv('FLY_CERTS_APP', 'motir-edge');
  zone = {};
  edge = {};
  removeFails = false;
  requests = [];
  resolveApplicationTarget.mockReset();
  resolveApplicationTarget.mockResolvedValue(null);

  acme = await seedTenant('Acme', 'ACME', 'scaled');

  vi.spyOn(providers, 'dnsResolver').mockReturnValue({
    resolveTxt: async (name: string) => {
      const records = zone[name] ?? [];
      if (records instanceof Error) throw records;
      return records;
    },
  });
  vi.spyOn(providers, 'certificateProvider').mockResolvedValue({
    request: async (hostname: string) => {
      requests.push(hostname);
      const state = edge[hostname] ?? { configured: true, issued: true };
      edge[hostname] = state;
      return { hostname, ...state, dnsRequirements: [], checkedAt: new Date() };
    },
    check: async (hostname: string) => {
      const state = edge[hostname] ?? { configured: true, issued: false };
      return { hostname, ...state, dnsRequirements: [], checkedAt: new Date() };
    },
    remove: async (hostname: string) => {
      if (removeFails) throw new Error('edge unreachable');
      delete edge[hostname];
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add — who may, what is written, and what is refused', () => {
  it('a workspace manager adds a domain: unverified, carrying a token, in the workspace, naming no project', async () => {
    const dto = await add(acme, HOST);
    expect(dto.status).toBe('unverified');
    expect(dto.verification?.name).toBe(`_motir-verify.${HOST}`);
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.workspaceId).toBe(acme.workspaceId);
    expect(row.verificationToken).toBe(dto.verification?.value);
    expect(row).not.toHaveProperty('projectId');
  });

  it('a user outside the workspace is refused, and a plain member is refused the write', async () => {
    const stranger = await createTestUser();
    await expect(
      customDomainService.add({
        workspaceId: acme.workspaceId,
        hostname: HOST,
        actorUserId: stranger.id,
      }),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);

    const member = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: member.id, workspaceId: acme.workspaceId, workspaceRole: 'member' },
    });
    await expect(
      customDomainService.add({
        workspaceId: acme.workspaceId,
        hostname: HOST,
        actorUserId: member.id,
      }),
    ).rejects.toBeInstanceOf(SubdomainForbiddenError);
    expect(await adminDb.publicAddress.count()).toBe(0);
  });

  it('refuses a host at or under the TENANT BASE domain as tenant_base', async () => {
    for (const host of [BASE, `acme.${BASE}`]) {
      const err = await add(acme, host).catch((e: unknown) => e);
      expect(err, host).toBeInstanceOf(NotACustomerDomainError);
      expect((err as InstanceType<typeof NotACustomerDomainError>).reason).toBe('tenant_base');
      expect((err as Error).message).toContain(BASE);
    }
    expect(await adminDb.publicAddress.count()).toBe(0);
  });

  it('refuses a host at or under the SITE ORIGIN as site_origin — a different error from the tenant base', async () => {
    for (const host of ['motir.co', 'www.motir.co']) {
      const err = await add(acme, host).catch((e: unknown) => e);
      expect(err, host).toBeInstanceOf(NotACustomerDomainError);
      expect((err as InstanceType<typeof NotACustomerDomainError>).reason).toBe('site_origin');
      expect((err as Error).message).toContain('motir.co');
    }
    expect(await adminDb.publicAddress.count()).toBe(0);
  });

  it('refuses a malformed hostname with InvalidHostnameError', async () => {
    await expect(add(acme, 'https://app.acme.test/x')).rejects.toBeInstanceOf(InvalidHostnameError);
    expect(await adminDb.publicAddress.count()).toBe(0);
  });
});

describe('the tier cap — counted per ORGANIZATION', () => {
  it('free is refused at 0; scaled is refused on the sixth; meta never', async () => {
    const free = await seedTenant('Free', 'FREE', 'free');
    await expect(add(free, 'one.free.test')).rejects.toBeInstanceOf(EntitlementExceededError);

    // Scaled: five, then the sixth is refused. ⚠️ Within ONE workspace: the
    // count runs under the adding workspace's RLS binding, so domains in the
    // org's OTHER workspaces are invisible to it — filed as MOTIR-10116 rather than
    // asserted here, since this gate changes no production code.
    for (const n of [1, 2, 3, 4, 5]) await add(acme, `d${n}.acme.test`);
    await expect(add(acme, 'd6.acme.test')).rejects.toBeInstanceOf(EntitlementExceededError);

    // Meta is Motir's own org and has no cap (the uncapped tier since the
    // enterprise tier was retired).
    const meta = await seedTenant('Meta', 'META', 'meta');
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await add(meta, `m${n}.meta.test`);
    expect(await adminDb.publicAddress.count({ where: { workspaceId: meta.workspaceId } })).toBe(7);
  });
});

describe('verify — the TXT before any certificate', () => {
  it('with no TXT the row stays unverified with a reason and NOTHING is requested; with it, it issues', async () => {
    const dto = await add(acme, HOST);
    const first = await verify(acme, dto.id);
    expect(first.status).toBe('unverified');
    expect(first.failureReason).toBeTruthy();
    expect(requests).toEqual([]);

    zone[`_motir-verify.${HOST}`] = [dto.verification!.value];
    const second = await verify(acme, dto.id);
    expect(['issued', 'pending_certificate']).toContain(second.status);
    expect(requests).toEqual([HOST]);
  });

  it('acts only on a customer domain of THIS workspace', async () => {
    const other = await seedTenant('Other', 'OTHR', 'scaled');
    const theirs = await add(other, 'theirs.other.test');
    const subdomain = await adminDb.publicAddress.create({
      data: {
        workspaceId: acme.workspaceId,
        hostname: `acme.${BASE}`,
        kind: 'workspace_subdomain',
        status: 'active',
      },
    });
    for (const addressId of [theirs.id, subdomain.id]) {
      await expect(verify(acme, addressId)).rejects.toBeInstanceOf(AddressNotFoundError);
      await expect(
        customDomainService.remove({
          workspaceId: acme.workspaceId,
          addressId,
          actorUserId: acme.ownerId,
        }),
      ).rejects.toBeInstanceOf(AddressNotFoundError);
    }
    expect(await adminDb.publicAddress.count()).toBe(2);
  });
});

describe('the sweep — a live domain re-proves its owner’s side', () => {
  it('txt_lost, pointing_lost (CNAME and A) and certificate_lost, in one sweep, never requesting', async () => {
    const txtGone = await issued(acme, 'txt.acme.test');
    const repointed = await issued(acme, 'cname.acme.test');
    const apex = await issued(acme, APEX);
    const certGone = await issued(acme, 'cert.acme.test');
    zone[`_motir-verify.txt.acme.test`] = [];
    edge['cname.acme.test'] = { configured: false, issued: true };
    edge[APEX] = { configured: false, issued: true };
    edge['cert.acme.test'] = { configured: false, issued: false };
    requests = [];
    await makeDue();

    await publicAddressCertificatesService.refreshDueAddresses();

    const read = (id: string) => adminDb.publicAddress.findUniqueOrThrow({ where: { id } });
    const t = await read(txtGone.id);
    expect([t.status, t.failureKind]).toEqual(['failed', 'txt_lost']);
    expect(t.failureReason).toContain('_motir-verify.txt.acme.test');
    expect(t.failureReason).toContain(t.verificationToken!);
    const c = await read(repointed.id);
    expect([c.status, c.failureKind]).toEqual(['failed', 'pointing_lost']);
    expect(c.failureReason).toContain(`CNAME ${CNAME_TARGET}`);
    const a = await read(apex.id);
    expect(a.failureKind).toBe('pointing_lost');
    expect(a.failureReason).toContain(`A ${A_RECORD}`);
    const x = await read(certGone.id);
    expect([x.status, x.failureKind]).toEqual(['expired', 'certificate_lost']);
    expect(requests).toEqual([]);
  });

  it('a resolver ERROR changes nothing on that row, is counted, and the healthy row is still processed', async () => {
    const flaky = await issued(acme, 'flaky.acme.test');
    const healthy = await issued(acme, 'healthy.acme.test');
    zone['_motir-verify.flaky.acme.test'] = new Error('SERVFAIL');
    await makeDue();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await publicAddressCertificatesService.refreshDueAddresses();
    expect(summary.failed).toBe(1);
    const f = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: flaky.id } });
    expect([f.status, f.failureKind]).toEqual(['issued', null]);
    const h = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: healthy.id } });
    expect(h.lastCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a txt_lost row whose TXT is back RECOVERS to issued, kind and reason cleared, issuedAt kept', async () => {
    const dto = await issued(acme, HOST);
    const before = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: dto.id } });
    zone[`_motir-verify.${HOST}`] = [];
    await makeDue();
    await publicAddressCertificatesService.refreshDueAddresses();
    expect(
      (await adminDb.publicAddress.findUniqueOrThrow({ where: { id: dto.id } })).failureKind,
    ).toBe('txt_lost');

    zone[`_motir-verify.${HOST}`] = [before.verificationToken!];
    await makeDue();
    await publicAddressCertificatesService.refreshDueAddresses();
    const after = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: dto.id } });
    expect([after.status, after.failureKind, after.failureReason]).toEqual(['issued', null, null]);
    expect(after.issuedAt?.toISOString()).toBe(before.issuedAt?.toISOString());
  });
});

describe('the host contract — read ANONYMOUSLY, with a private project present', () => {
  it('an issued host answers no_application, then application with its upstream for the edge', async () => {
    const app = await seedApplication(acme);
    const dto = await issued(acme, HOST);
    expect(await publicAddressesService.resolveHost(HOST)).toEqual({
      kind: 'no_application',
      workspace: { name: 'Acme' },
    });

    await customDomainService.bind({
      workspaceId: acme.workspaceId,
      addressId: dto.id,
      actorUserId: acme.ownerId,
      applicationId: app.id,
    });
    resolveApplicationTarget.mockResolvedValue(UPSTREAM);
    vi.spyOn(hostedApplicationRepository, 'findForHostContract').mockImplementation(
      async (id, tx) => {
        // The access setting lands with MOTIR-9817; stand in a PUBLIC app.
        const row = await adminDb.hostedApplication.findUnique({ where: { id } });
        void tx;
        return row
          ? {
              id: row.id,
              workspaceId: row.workspaceId,
              slug: row.slug,
              target: row.target,
              productionAppName: row.productionAppName,
              currentReleaseId: row.currentReleaseId,
              productionAddress: row.productionAddress,
              access: 'public',
            }
          : null;
      },
    );
    expect(await publicAddressesService.resolveHost(HOST, { credentialed: true })).toEqual({
      kind: 'application',
      workspace: { name: 'Acme' },
      application: { id: app.id, slug: 'shop' },
      upstream: UPSTREAM,
    });
  });

  it('every non-issued status, a deleted row and an unknown host refuse with the SAME error', async () => {
    for (const status of ['unverified', 'pending_certificate', 'failed', 'expired'] as const) {
      const host = `${status.replace('_', '-')}.acme.test`;
      await adminDb.publicAddress.create({
        data: {
          workspaceId: acme.workspaceId,
          hostname: host,
          kind: 'custom_domain',
          status,
          verificationToken: `motir-verify-${host}`,
        },
      });
      // The anonymous read itself admits only an ISSUED customer domain.
      expect(await publicAddressRepository.findByHostname(host), host).toBeNull();
      await expect(publicAddressesService.resolveHost(host), host).rejects.toBeInstanceOf(
        PublicHostNotFoundError,
      );
    }
    await expect(publicAddressesService.resolveHost('nobody.acme.test')).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('the motir.site workspace host answers exactly as before the story', async () => {
    await adminDb.project.update({
      where: { id: acme.projectId },
      data: projectAccessData('public'),
    });
    await adminDb.publicAddress.create({
      data: {
        workspaceId: acme.workspaceId,
        hostname: `acme.${BASE}`,
        kind: 'workspace_subdomain',
        status: 'active',
      },
    });
    expect(await publicAddressesService.resolveHost(`acme.${BASE}`)).toEqual({
      kind: 'no_application',
      workspace: { name: 'Acme' },
    });
  });
});

describe('remove — gone everywhere, and nothing held', () => {
  it('deletes the row even when the edge’s withdrawal fails; the host is gone from every read', async () => {
    const dto = await issued(acme, HOST);
    removeFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await customDomainService.remove({
      workspaceId: acme.workspaceId,
      addressId: dto.id,
      actorUserId: acme.ownerId,
    });
    expect(warn.mock.calls[0]?.[0]).toContain(HOST);
    expect(await publicAddressRepository.findByHostname(HOST)).toBeNull();
    await expect(publicAddressesService.resolveHost(HOST)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
  });

  it('a second workspace adds the removed name at once, with a fresh TXT', async () => {
    const dto = await add(acme, HOST);
    await customDomainService.remove({
      workspaceId: acme.workspaceId,
      addressId: dto.id,
      actorUserId: acme.ownerId,
    });
    const other = await seedTenant('Other', 'OTHR', 'scaled');
    const again = await add(other, HOST);
    expect(again.status).toBe('unverified');
    expect(again.verification!.value).not.toBe(dto.verification!.value);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function add(t: Tenant, hostname: string) {
  return customDomainService.add({ workspaceId: t.workspaceId, hostname, actorUserId: t.ownerId });
}

function verify(t: Tenant, addressId: string) {
  return customDomainService.verify({
    workspaceId: t.workspaceId,
    addressId,
    actorUserId: t.ownerId,
  });
}

/** Add, prove and issue a domain through the real lifecycle. */
async function issued(t: Tenant, hostname: string) {
  const dto = await add(t, hostname);
  zone[`_motir-verify.${hostname}`] = [dto.verification!.value];
  const after = await verify(t, dto.id);
  expect(after.status).toBe('issued');
  return after;
}

/** Push every row past the hourly window so the next sweep re-checks it. */
async function makeDue() {
  await adminDb.publicAddress.updateMany({
    data: { lastCheckedAt: new Date(Date.now() - 2 * 3_600_000) },
  });
}

async function seedTenant(
  name: string,
  identifier: string,
  tier: 'free' | 'scaled' | 'meta',
): Promise<Tenant> {
  const { workspace, owner } = await createTestWorkspace({ name });
  // PRIVATE on purpose: the host contract must not depend on project visibility.
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name,
      slug: identifier.toLowerCase(),
      identifier,
      ...projectAccessData('members'),
    },
  });
  if (tier === 'scaled') {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: {
        scaledTrackerSubscription: {
          status: 'active',
          priceId: 'price_test',
          quantity: 1,
        } as never,
      },
    });
  }
  if (tier === 'meta') {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: true },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    ownerId: owner.id,
    projectId: project.id,
  };
}

/** A released hosted application of the tenant. */
async function seedApplication(t: Tenant) {
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      role: 'web',
      name: 'shop',
      position: 'a0',
      seedSource: 'initialised',
    },
  });
  const app = await adminDb.hostedApplication.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      projectRepositoryId: repo.id,
      target: 'fly',
      slug: 'shop',
      productionAppName: 'mh-shop',
    },
  });
  const release = await adminDb.hostedRelease.create({
    data: {
      workspaceId: t.workspaceId,
      applicationId: app.id,
      commitSha: 'a'.repeat(40),
      cause: 'merge',
      state: 'live',
    },
  });
  return adminDb.hostedApplication.update({
    where: { id: app.id },
    data: { currentReleaseId: release.id },
  });
}
