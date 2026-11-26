import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// MOTIR STOPS SERVING AN APPLICATION (Story MOTIR-9800 · MOTIR-12129), against
// the real Postgres: `releaseApplicationAddresses` in the caller's transaction,
// then what each address answers through the shipped host contract. The host
// contract reads ANONYMOUSLY, so the workspace has a PUBLIC project (the
// subdomain's public arm) and the customer domains are ISSUED (theirs). The one
// port motir-core cannot reach is stubbed: the certificate provider, which must
// record no withdrawal.

const resolveApplicationTarget = vi.hoisted(() => vi.fn());
vi.mock('@/lib/publicAddresses/applicationTarget', () => ({ resolveApplicationTarget }));

const { db } = await import('@/lib/db');
const { publicAddressesService, PublicHostNotFoundError } =
  await import('@/lib/services/publicAddressesService');
const { hostedApplicationHandoverService: handover } =
  await import('@/lib/services/hostedApplicationHandoverService');
const { releasedSlugOf } = await import('@/lib/repositories/hostedApplicationRepository');
const { ApplicationNotFoundError } = await import('@/lib/hosting/errors');
const providers = await import('@/lib/publicAddresses/providers');
const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');
const { createTestWorkspace } = await import('../fixtures');

const BASE = 'motir.example';
const WORKSPACE_HOST = `acme.${BASE}`;
const UPSTREAM = 'https://d1opened0shop.cloudfront.net';

interface Tenant {
  workspaceId: string;
  projectId: string;
}

let acme: Tenant;
let withdrawn: string[] = [];

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_PUBLIC_TENANT_DOMAIN', BASE);
  resolveApplicationTarget.mockReset();
  resolveApplicationTarget.mockResolvedValue(null);
  withdrawn = [];
  vi.spyOn(providers, 'certificateProvider').mockResolvedValue({
    request: async () => {
      throw new Error('no certificate is requested at a handover');
    },
    check: async () => {
      throw new Error('no certificate is checked at a handover');
    },
    remove: async (hostname: string) => {
      withdrawn.push(hostname);
    },
  });
  acme = await seedTenant();
  await adminDb.publicAddress.create({
    data: {
      workspaceId: acme.workspaceId,
      hostname: WORKSPACE_HOST,
      kind: 'workspace_subdomain',
      status: 'active',
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixtures ───────────────────────────────────────────────────────────────

async function seedTenant(): Promise<Tenant> {
  const { workspace } = await createTestWorkspace({ name: 'Acme' });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: 'Project ACME',
      slug: 'acme',
      identifier: 'ACME',
      ...projectAccessData('public'),
    },
  });
  return { workspaceId: workspace.id, projectId: project.id };
}

let position = 0;
/** A hosted application with a production release, as the host contract serves one. */
async function seedApplication(slug: string, upstreamAddress: string | null = UPSTREAM) {
  position += 1;
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId: acme.workspaceId,
      projectId: acme.projectId,
      role: 'web',
      name: slug,
      position: `a${position}`,
      seedSource: 'initialised',
    },
  });
  const app = await adminDb.hostedApplication.create({
    data: {
      workspaceId: acme.workspaceId,
      projectId: acme.projectId,
      projectRepositoryId: repo.id,
      target: 'aws',
      slug,
      productionAppName: `mh-${slug}`,
      productionAddress: `${slug}--acme.${BASE}`,
      upstreamAddress,
    },
  });
  const release = await adminDb.hostedRelease.create({
    data: {
      workspaceId: acme.workspaceId,
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

function seedDomain(hostname: string, applicationId: string | null) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId: acme.workspaceId,
      applicationId,
      hostname,
      kind: 'custom_domain',
      status: 'issued',
      verificationToken: `motir-verify-${hostname}`,
      issuedAt: new Date('2026-11-01T00:00:00Z'),
      certificateExpiresAt: new Date('2027-02-01T00:00:00Z'),
    },
  });
}

function setDefault(applicationId: string | null) {
  return adminDb.workspace.update({
    where: { id: acme.workspaceId },
    data: { defaultApplicationId: applicationId },
  });
}

const inTx = <T>(fn: Parameters<typeof withWorkspaceServiceContext<T>>[1]) =>
  withWorkspaceServiceContext(acme.workspaceId, fn);

/** Every row the call may touch, as stored. */
async function snapshot(applicationId: string) {
  return {
    application: await adminDb.hostedApplication.findUniqueOrThrow({
      where: { id: applicationId },
    }),
    workspace: await adminDb.workspace.findUniqueOrThrow({ where: { id: acme.workspaceId } }),
    addresses: await adminDb.publicAddress.findMany({
      where: { workspaceId: acme.workspaceId },
      orderBy: { hostname: 'asc' },
    }),
  };
}

const appHost = (slug: string) => `${slug}--acme.${BASE}`;

// ── the release ────────────────────────────────────────────────────────────

describe('releaseApplicationAddresses — the default application', () => {
  it('frees its host and slug, clears the default and unbinds its domains, each answering as released', async () => {
    const shop = await seedApplication('shop');
    await setDefault(shop.id);
    const www = await seedDomain('www.shop.test', shop.id);
    const apex = await seedDomain('shop.test', shop.id);
    // Serving before: the domains name the application (members only, as no
    // access column exists yet), not "no application".
    expect((await publicAddressesService.resolveHost('shop.test')).kind).toBe(
      'members_only_application',
    );

    const answer = await inTx((tx) => handover.releaseApplicationAddresses(shop.id, tx));
    expect(answer).toEqual({
      releasedHost: appHost('shop'),
      wasDefault: true,
      unboundDomains: [
        { host: 'shop.test', upstreamAddress: UPSTREAM },
        { host: 'www.shop.test', upstreamAddress: UPSTREAM },
      ],
    });

    await expect(publicAddressesService.resolveHost(appHost('shop'))).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
    const workspace = await adminDb.workspace.findUniqueOrThrow({
      where: { id: acme.workspaceId },
    });
    expect(workspace.defaultApplicationId).toBeNull();
    await expect(publicAddressesService.resolveHost(WORKSPACE_HOST)).resolves.toEqual({
      kind: 'no_application',
      workspace: { name: 'Acme' },
    });
    for (const domain of [www, apex]) {
      const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: domain.id } });
      expect(row.applicationId).toBeNull();
      await expect(publicAddressesService.resolveHost(domain.hostname)).resolves.toEqual({
        kind: 'no_application',
        workspace: { name: 'Acme' },
      });
    }

    // The freed slug: another application of the workspace takes it.
    const released = await adminDb.hostedApplication.findUniqueOrThrow({ where: { id: shop.id } });
    expect(released).toMatchObject({ slug: releasedSlugOf(shop.id), productionAddress: null });
    const next = await seedApplication('shop-next');
    await expect(
      adminDb.hostedApplication.update({ where: { id: next.id }, data: { slug: 'shop' } }),
    ).resolves.toMatchObject({ slug: 'shop' });
  });

  it('keeps each unbound domain whole: id, workspace, hostname, status and certificate, withdrawing nothing', async () => {
    const shop = await seedApplication('shop');
    const before = await seedDomain('shop.test', shop.id);
    await inTx((tx) => handover.releaseApplicationAddresses(shop.id, tx));
    const after = await adminDb.publicAddress.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toEqual({ ...before, applicationId: null, updatedAt: after.updatedAt });
    expect(after.status).toBe('issued');
    expect(withdrawn).toEqual([]);
  });

  it('keeps the application row with its handover fields exactly as they were', async () => {
    const shop = await seedApplication('shop');
    const fields = {
      state: 'handing_over' as const,
      handedOverAccountId: '400000000123',
      stopsAt: new Date('2026-12-23T12:00:00Z'),
      handedOverAt: new Date('2026-11-23T12:00:00Z'),
    };
    await adminDb.hostedApplication.update({ where: { id: shop.id }, data: fields });
    await inTx((tx) => handover.releaseApplicationAddresses(shop.id, tx));
    const row = await adminDb.hostedApplication.findUnique({ where: { id: shop.id } });
    expect(row).toMatchObject({ ...fields, upstreamAddress: UPSTREAM });
  });
});

describe('releaseApplicationAddresses — an application that is not the default', () => {
  it('leaves the default naming the other application, and the bare host answering as before', async () => {
    const site = await seedApplication('site');
    const shop = await seedApplication('shop');
    await setDefault(site.id);
    const before = await publicAddressesService.resolveHost(WORKSPACE_HOST);

    const answer = await inTx((tx) => handover.releaseApplicationAddresses(shop.id, tx));
    expect(answer).toEqual({
      releasedHost: appHost('shop'),
      wasDefault: false,
      unboundDomains: [],
    });

    const workspace = await adminDb.workspace.findUniqueOrThrow({
      where: { id: acme.workspaceId },
    });
    expect(workspace.defaultApplicationId).toBe(site.id);
    await expect(publicAddressesService.resolveHost(WORKSPACE_HOST)).resolves.toEqual(before);
    // The other application keeps its own host and slug.
    await expect(
      adminDb.hostedApplication.findUniqueOrThrow({ where: { id: site.id } }),
    ).resolves.toMatchObject({ slug: 'site', productionAddress: appHost('site') });
  });
});

describe('releaseApplicationAddresses — idempotent and transactional', () => {
  it('a second call answers nothing changed and leaves every row byte-for-byte', async () => {
    const shop = await seedApplication('shop');
    await setDefault(shop.id);
    await seedDomain('shop.test', shop.id);
    await inTx((tx) => handover.releaseApplicationAddresses(shop.id, tx));
    const first = await snapshot(shop.id);

    const again = await inTx((tx) => handover.releaseApplicationAddresses(shop.id, tx));
    expect(again).toEqual({ releasedHost: null, wasDefault: false, unboundDomains: [] });
    expect(await snapshot(shop.id)).toEqual(first);
  });

  it('rolls back with the caller: address, slug, default and every binding as before', async () => {
    const shop = await seedApplication('shop');
    await setDefault(shop.id);
    await seedDomain('shop.test', shop.id);
    await seedDomain('www.shop.test', shop.id);
    const before = await snapshot(shop.id);

    const stopFailed = new Error('a later step of the stop failed');
    await expect(
      inTx(async (tx) => {
        const answer = await handover.releaseApplicationAddresses(shop.id, tx);
        expect(answer.wasDefault).toBe(true);
        throw stopFailed;
      }),
    ).rejects.toBe(stopFailed);
    expect(await snapshot(shop.id)).toEqual(before);
  });

  it('refuses an application that does not exist, writing nothing', async () => {
    await expect(
      inTx((tx) => handover.releaseApplicationAddresses('cm-no-such-app', tx)),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
    await expect(
      inTx((tx) => handover.listCustomerDomainUpstreams('cm-no-such-app', tx)),
    ).rejects.toBeInstanceOf(ApplicationNotFoundError);
  });
});

describe('listCustomerDomainUpstreams', () => {
  it('lists each bound domain by hostname with the application’s upstream, and none after the release', async () => {
    const shop = await seedApplication('shop');
    const other = await seedApplication('other');
    await seedDomain('zeta.shop.test', shop.id);
    await seedDomain('alpha.shop.test', shop.id);
    await seedDomain('other.test', other.id);
    await seedDomain('loose.test', null);

    expect(await inTx((tx) => handover.listCustomerDomainUpstreams(shop.id, tx))).toEqual([
      { host: 'alpha.shop.test', upstreamAddress: UPSTREAM },
      { host: 'zeta.shop.test', upstreamAddress: UPSTREAM },
    ]);
    await inTx((tx) => handover.releaseApplicationAddresses(shop.id, tx));
    expect(await inTx((tx) => handover.listCustomerDomainUpstreams(shop.id, tx))).toEqual([]);
    // Another application's domain is not touched.
    expect(await inTx((tx) => handover.listCustomerDomainUpstreams(other.id, tx))).toEqual([
      { host: 'other.test', upstreamAddress: UPSTREAM },
    ]);
  });

  it('names every domain with a null upstream for an application with none (serverless, Fly)', async () => {
    const shop = await seedApplication('shop', null);
    await seedDomain('shop.test', shop.id);
    await seedDomain('www.shop.test', shop.id);
    expect(await inTx((tx) => handover.listCustomerDomainUpstreams(shop.id, tx))).toEqual([
      { host: 'shop.test', upstreamAddress: null },
      { host: 'www.shop.test', upstreamAddress: null },
    ]);
  });
});
