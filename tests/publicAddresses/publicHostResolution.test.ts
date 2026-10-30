import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import type { ProjectAccessMode } from '@/generated/prisma/client';

// Host resolution — Story MOTIR-3878 · Subtask MOTIR-4217.
//
// The producer end of the integration `motir-marketing`'s router consumes. Two
// properties are worth more than the rest and are asserted first in their
// sections: that each of the two shapes RESOLVES, and that everything else —
// a retired name included (Story MOTIR-4528 · MOTIR-9511) — refuses
// IDENTICALLY. A resolver that refused everything would pass every
// denial test ever written.

const { db } = await import('@/lib/db');
const { publicAddressesService, PublicHostNotFoundError, normaliseHost } =
  await import('@/lib/services/publicAddressesService');
const { PublicAddressesUnavailableError } = await import('@/lib/publicAddresses/errors');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { GET: resolveRoute } = await import('@/app/api/public/hosts/[host]/route');
const { HOST_CONTRACT_CACHE_CONTROL, HOST_CONTRACT_MAX_AGE_SECONDS, NOT_FOUND_CACHE_CONTROL } =
  await import('@/lib/publicAddresses/hostContractCache');
const { createTestWorkspace } = await import('../fixtures');

const BASE = 'motir.example';

interface Tenant {
  workspaceId: string;
  ownerId: string;
  projectId: string;
  identifier: string;
}

let host: Tenant;

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  host = await seedTenant('acme', 'ACME', 'public');
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('normaliseHost — refuses rather than repairs', () => {
  it('accepts a bare hostname and strips a port', () => {
    expect(normaliseHost('acme.motir.example')).toBe('acme.motir.example');
    expect(normaliseHost('ACME.Motir.Example')).toBe('acme.motir.example');
    expect(normaliseHost('acme.motir.example:443')).toBe('acme.motir.example');
  });

  it('refuses anything that is not a hostname', () => {
    // Salvaging a hostile value into "something nearby" is trusting it a
    // little — the argument `returnTarget.ts` makes at length, one surface over.
    for (const bad of [
      'https://acme.motir.example',
      'acme.motir.example/path',
      'acme.motir.example@evil.test',
      'acme motir example',
      '',
      '   ',
      'localhost',
      '-acme.motir.example',
      '..',
    ]) {
      expect(normaliseHost(bad), bad).toBeNull();
    }
  });
});

describe('the two shapes that RESOLVE', () => {
  it('a live workspace subdomain answers no_application, and lists no projects', async () => {
    // The address decision (MOTIR-9790): the bare workspace host belongs to the
    // default application, and there is no application record yet.
    await seedSubdomain(host, `acme.${BASE}`);
    const r = await publicAddressesService.resolveHost(`acme.${BASE}`);
    expect(r).toEqual({ kind: 'no_application', workspace: { name: 'Acme' } });
  });

  it('an ISSUED customer domain names no project — it answers no_application', async () => {
    // ADR MOTIR-9521 §1: a customer domain is the workspace's and names at most
    // one application. The `project` outcome is retired; until the contract
    // carries `application` (MOTIR-9525) the domain has nothing to serve.
    await seedCustomDomain(host, 'roadmap.acme.test', 'issued');
    const r = await publicAddressesService.resolveHost('roadmap.acme.test');
    expect(r).toEqual({ kind: 'no_application', workspace: { name: 'Acme' } });
  });

  it('a port on the Host header does not change the answer', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    await expect(publicAddressesService.resolveHost(`acme.${BASE}:443`)).resolves.toMatchObject({
      kind: 'no_application',
    });
  });
});

describe('everything else refuses IDENTICALLY', () => {
  // ⚠️ The point is not that each refuses — it is that they refuse the SAME
  // way. A caller able to tell "no such tenant" from "a tenant exists but is
  // not serving yet" is a caller for whom walking hostnames is worth the
  // trouble.
  it('an unknown host', async () => {
    await expect(publicAddressesService.resolveHost(`nobody.${BASE}`)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('a leftover legacy ALIAS row — it never redirects, and never reaches the custom-domain branch', async () => {
    // Dormant data from the retired never-released design. The service writes
    // none any more, so the test inserts one.
    const live = await seedSubdomain(host, `old.${BASE}`);
    await adminDb.publicAddress.update({
      where: { id: live.id },
      data: { kind: 'workspace_subdomain_alias', status: 'alias' },
    });
    await seedSubdomain(host, `acme.${BASE}`);
    await expect(publicAddressesService.resolveHost(`old.${BASE}`)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('a renamed-away-from name and a released name stop answering at once', async () => {
    // ADR §8 Amendment 3 rule 2 — and no row is left behind to answer for them.
    const DAY = 24 * 60 * 60 * 1000;
    await publicSubdomainService.claim(host.workspaceId, 'first', host.ownerId);
    await publicSubdomainService.rename(host.workspaceId, 'second', host.ownerId);
    await expect(publicAddressesService.resolveHost(`first.${BASE}`)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
    await expect(publicAddressesService.resolveHost(`second.${BASE}`)).resolves.toMatchObject({
      kind: 'no_application',
    });

    // Past the 30-day limit, so the release is allowed.
    await publicSubdomainService.release(
      host.workspaceId,
      host.ownerId,
      new Date(Date.now() + 31 * DAY),
    );
    await expect(publicAddressesService.resolveHost(`second.${BASE}`)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
    expect(
      await adminDb.publicAddress.count({
        where: { hostname: { in: [`first.${BASE}`, `second.${BASE}`] } },
      }),
    ).toBe(0);
  });

  it('the BASE domain itself', async () => {
    await expect(publicAddressesService.resolveHost(BASE)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('motir.co, which is not a tenant address at all', async () => {
    await expect(publicAddressesService.resolveHost('motir.co')).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('a customer domain in EVERY non-issued status', async () => {
    // One row, walked through the six states that do not serve. A domain that
    // is merely half-configured must not advertise itself.
    const addr = await seedCustomDomain(host, 'pending.acme.test', 'unverified');
    for (const status of [
      'unverified',
      'verifying',
      'pending_certificate',
      'failed',
      'expired',
      'revoked',
    ] as const) {
      await adminDb.publicAddress.update({ where: { id: addr.id }, data: { status } });
      await expect(
        publicAddressesService.resolveHost('pending.acme.test'),
        status,
      ).rejects.toBeInstanceOf(PublicHostNotFoundError);
    }
  });

  it('a subdomain whose workspace holds NO public project', async () => {
    // The RLS public arm is what refuses this, not a check in the service —
    // the row is simply not visible to an unbound read.
    const priv = await seedTenant('priv', 'PRIV', 'members');
    await seedSubdomain(priv, `priv.${BASE}`);
    await expect(publicAddressesService.resolveHost(`priv.${BASE}`)).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('a customer domain of a workspace with no public project', async () => {
    const priv = await seedTenant('priv2', 'PRIV2', 'members');
    await seedCustomDomain(priv, 'secret.acme.test', 'issued');
    await expect(publicAddressesService.resolveHost('secret.acme.test')).rejects.toBeInstanceOf(
      PublicHostNotFoundError,
    );
  });

  it('OFF-CLOUD, every host — the capability is absent, not hidden', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    delete process.env['MOTIR_CLOUD'];
    await expect(publicAddressesService.resolveHost(`acme.${BASE}`)).rejects.toBeInstanceOf(
      PublicAddressesUnavailableError,
    );
  });
});

describe('the route’s cache bound — a retired name answers for 30 seconds at most', () => {
  // Story MOTIR-4528 · MOTIR-9511. The database side of rule 2 is exact; a
  // cached 200 is what could keep a retired name answering, so the header IS
  // the promise.
  const call = (h: string) =>
    resolveRoute(new Request(`https://app.motir.co/api/public/hosts/${h}`), {
      params: Promise.resolve({ host: h }),
    });

  it('a 200 carries exactly `public, max-age=30`, with no revalidate window', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    const res = await call(`acme.${BASE}`);
    expect(res.status).toBe(200);
    expect(HOST_CONTRACT_MAX_AGE_SECONDS).toBe(30);
    expect(res.headers.get('Cache-Control')).toBe(HOST_CONTRACT_CACHE_CONTROL);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(res.headers.get('Cache-Control')).not.toContain('stale-while-revalidate');
  });

  it('a 404 is `no-store`, and a legacy alias gets the same 404 body as an unknown host', async () => {
    const live = await seedSubdomain(host, `old.${BASE}`);
    await adminDb.publicAddress.update({
      where: { id: live.id },
      data: { kind: 'workspace_subdomain_alias', status: 'alias' },
    });
    const alias = await call(`old.${BASE}`);
    const unknown = await call(`nobody.${BASE}`);
    for (const res of [alias, unknown]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe(NOT_FOUND_CACHE_CONTROL);
    }
    expect(await alias.json()).toEqual(await unknown.json());
  });
});

describe('addressesForProject — the ADR §7 default rule', () => {
  it('no address at all → the motir.co URL is primary, and it is never empty', async () => {
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect(a.primary).toContain('/p/ACME');
    expect(a.alternates).toEqual([]);
  });

  it('a subdomain claimed → motir.co stays primary, and the subdomain is not listed at all', async () => {
    // The address decision (MOTIR-9790): the bare workspace host belongs to the
    // workspace's default application and serves no project path, so
    // `acme.<base>/ACME` is a 404. Naming it as a canonical or an alternate would
    // send readers and crawlers to a page that does not exist.
    await seedSubdomain(host, `acme.${BASE}`);
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect(a.primary).toContain('/p/ACME');
    expect(a.alternates).toEqual([]);
  });

  it('an ISSUED custom domain is never a project address — it serves an application', async () => {
    // ADR MOTIR-9521 §1 retires the primary custom domain: a project's canonical
    // is always its motir.co URL, and a customer domain is neither primary nor
    // an alternate of any project.
    await seedSubdomain(host, `acme.${BASE}`);
    await seedCustomDomain(host, 'roadmap.acme.test', 'issued');
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect(a.primary).toContain('/p/ACME');
    expect(a.alternates).toEqual([]);
  });

  it('an ADDED-but-not-issued custom domain is neither primary nor an alternate', async () => {
    // It does not serve, so listing it would put a dead URL in a sitemap.
    await seedCustomDomain(host, 'pending.acme.test', 'pending_certificate');
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect([a.primary, ...a.alternates].some((u) => u.includes('pending.acme.test'))).toBe(false);
  });

  it('an ALIAS is never listed — it is a redirect, not an address', async () => {
    const live = await seedSubdomain(host, `old.${BASE}`);
    await adminDb.publicAddress.update({
      where: { id: live.id },
      data: { kind: 'workspace_subdomain_alias', status: 'alias' },
    });
    await seedSubdomain(host, `acme.${BASE}`);
    const a = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect([a.primary, ...a.alternates].some((u) => u.includes(`old.${BASE}`))).toBe(false);
  });
});

describe('primaryHostsForProjects — the batched crawl read', () => {
  it('agrees with addressesForProject: no project has a host of its own', async () => {
    // Two paths computing one rule is how they come apart. An issued customer
    // domain and a claimed subdomain both present, and neither is a project's.
    await seedSubdomain(host, `acme.${BASE}`);
    await seedCustomDomain(host, 'roadmap.acme.test', 'issued');
    const map = await publicAddressesService.primaryHostsForProjects([
      { id: host.projectId, workspaceId: host.workspaceId, identifier: 'ACME' },
    ]);
    const single = await publicAddressesService.addressesForProject(
      host.projectId,
      host.workspaceId,
      'ACME',
    );
    expect(map.has(host.projectId)).toBe(false);
    expect(single.primary).toContain('/p/ACME');
  });

  it('is empty with a claimed workspace subdomain', async () => {
    await seedSubdomain(host, `acme.${BASE}`);
    const map = await publicAddressesService.primaryHostsForProjects([
      { id: host.projectId, workspaceId: host.workspaceId, identifier: 'ACME' },
    ]);
    expect(map.has(host.projectId)).toBe(false);
  });

  it('handles an empty input without touching the database', async () => {
    await expect(publicAddressesService.primaryHostsForProjects([])).resolves.toEqual(new Map());
  });
});

// ── fixtures ───────────────────────────────────────────────────────────────

function seedSubdomain(t: Tenant, hostname: string) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId: t.workspaceId,
      hostname,
      kind: 'workspace_subdomain',
      status: 'active',
    },
  });
}

function seedCustomDomain(
  t: Tenant,
  hostname: string,
  status: 'unverified' | 'issued' | 'pending_certificate',
) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId: t.workspaceId,
      hostname,
      kind: 'custom_domain',
      status,
      verificationToken: `motir-verify-${hostname}`,
    },
  });
}

async function seedTenant(
  tag: string,
  identifier: string,
  mode: ProjectAccessMode,
): Promise<Tenant> {
  const { workspace, owner } = await createTestWorkspace({ name: tag === 'acme' ? 'Acme' : tag });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Project ${identifier}`,
      slug: identifier.toLowerCase(),
      identifier,
      ...projectAccessData(mode),
    },
  });
  return {
    workspaceId: workspace.id,
    ownerId: owner.id,
    projectId: project.id,
    identifier,
  };
}
