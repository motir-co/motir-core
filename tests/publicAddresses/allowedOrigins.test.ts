import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The registered-origin set — Story MOTIR-3878 · Subtask MOTIR-4218.
//
// Two shipped modules assumed the public site had ONE origin. This is the set
// that replaces it, and the two properties worth the most are asserted first:
// that a real tenant origin is ADMITTED (a check that refuses everything passes
// every denial test ever written), and that the widening did not weaken the
// ORIGIN-equality posture `returnTarget.ts`'s header defends at length.

const { db } = await import('@/lib/db');
const { isRegisteredPublicOrigin, resetAllowedOriginCache } =
  await import('@/lib/publicAddresses/allowedOrigins');
const { publicCorsHeaders } = await import('@/lib/publicProjects/cors');
const { resolvePublicReturnTarget, resolveHandoffDestination, HANDOFF_FALLBACK_PATH } =
  await import('@/lib/publicProjects/returnTarget');
const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
const { createTestWorkspace } = await import('../fixtures');

let workspaceId: string;

beforeEach(async () => {
  await truncateAuthTables();
  resetAllowedOriginCache();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_SITE_URL'] = 'https://motir.co';
  const { workspace } = await createTestWorkspace({ name: 'Acme' });
  workspaceId = workspace.id;
  await adminDb.project.create({
    data: {
      workspaceId,
      name: 'Acme',
      slug: 'acme',
      identifier: 'ACME',
      ...projectAccessData('public'),
    },
  });
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_SITE_URL'];
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('what is ADMITTED', () => {
  it('the configured public site, with no database read at all', async () => {
    // The pre-cutover behaviour, byte-identical — and free: it short-circuits
    // before the repository, so a deployment with no addresses pays nothing.
    const spy = vi.spyOn(publicAddressRepository, 'findByHostname');
    expect(await isRegisteredPublicOrigin('https://motir.co')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a live workspace subdomain', async () => {
    await seedSubdomain('acme.motir.site');
    expect(await isRegisteredPublicOrigin('https://acme.motir.site')).toBe(true);
  });

  it('an ISSUED custom domain', async () => {
    await seedCustomDomain('roadmap.acme.test', 'issued');
    expect(await isRegisteredPublicOrigin('https://roadmap.acme.test')).toBe(true);
  });
});

describe('what is REFUSED, and why each one matters', () => {
  it('an ALIAS — a redirect is not an actor', async () => {
    // A retired subdomain sends a browser to the live address, which is where
    // it then acts from. Admitting it would let a name nobody uses carry a
    // CORS grant for ever, which is exactly what the never-released rule makes
    // permanent.
    const a = await seedSubdomain('old.motir.site');
    await adminDb.publicAddress.update({
      where: { id: a.id },
      data: { kind: 'workspace_subdomain_alias', status: 'alias' },
    });
    resetAllowedOriginCache();
    expect(await isRegisteredPublicOrigin('https://old.motir.site')).toBe(false);
  });

  it('a custom domain in every NON-ISSUED status', async () => {
    const a = await seedCustomDomain('pending.acme.test', 'unverified');
    for (const status of [
      'unverified',
      'verifying',
      'pending_certificate',
      'failed',
      'expired',
      'revoked',
    ] as const) {
      await adminDb.publicAddress.update({ where: { id: a.id }, data: { status } });
      resetAllowedOriginCache();
      expect(await isRegisteredPublicOrigin('https://pending.acme.test'), status).toBe(false);
    }
  });

  it('an unknown origin', async () => {
    expect(await isRegisteredPublicOrigin('https://evil.example')).toBe(false);
  });

  it('every homograph and near-miss `returnTarget.ts` names — the posture is unchanged', async () => {
    // ⚠️ THE POINT OF THIS CASE. Widening one origin to a SET must not turn an
    // origin-equality test into a prefix or hostname test. Each of these is a
    // separate entry under a deny-list and ONE answer under an origin
    // comparison — which is the argument that module's header makes.
    await seedSubdomain('acme.motir.site');
    for (const bad of [
      'https://acme.motir.site.evil.test',
      'https://evil.test/acme.motir.site',
      'http://acme.motir.site',
      'https://acme.motir.site:8443',
      'https://xn--acme-motir.site',
      'https://ACME.MOTIR.SITE.evil.test',
      '//acme.motir.site',
      'acme.motir.site',
    ]) {
      expect(await isRegisteredPublicOrigin(bad), bad).toBe(false);
    }
  });

  it('refuses plain http even for a REGISTERED host', async () => {
    // Every address this story mints is https. An http origin for a real host
    // is either a downgrade or a spoof, and neither should act.
    await seedSubdomain('acme.motir.site');
    expect(await isRegisteredPublicOrigin('http://acme.motir.site')).toBe(false);
  });
});

describe('the cache — a security control, not a performance one', () => {
  it('performs ONE repository read for N identical UNKNOWN origins', async () => {
    // The negative arm is the one that matters: `Origin` is attacker-controlled
    // and arrives on every cross-origin request, so without it a bot spraying
    // values turns this check into a database read per request.
    const spy = vi.spyOn(publicAddressRepository, 'findByHostname');
    for (let i = 0; i < 25; i += 1) {
      expect(await isRegisteredPublicOrigin('https://sprayed.example')).toBe(false);
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('performs ONE read for N identical KNOWN origins', async () => {
    await seedSubdomain('acme.motir.site');
    resetAllowedOriginCache();
    const spy = vi.spyOn(publicAddressRepository, 'findByHostname');
    for (let i = 0; i < 10; i += 1) {
      expect(await isRegisteredPublicOrigin('https://acme.motir.site')).toBe(true);
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caches per ORIGIN, so one sprayed value cannot poison another', async () => {
    await seedSubdomain('acme.motir.site');
    resetAllowedOriginCache();
    expect(await isRegisteredPublicOrigin('https://sprayed.example')).toBe(false);
    expect(await isRegisteredPublicOrigin('https://acme.motir.site')).toBe(true);
  });
});

describe('the two consumers', () => {
  it('CORS echoes a tenant origin, sets Vary, and NEVER allows credentials', async () => {
    await seedSubdomain('acme.motir.site');
    const headers = await publicCorsHeaders('https://acme.motir.site');
    expect(headers).toEqual({
      'Access-Control-Allow-Origin': 'https://acme.motir.site',
      Vary: 'Origin',
    });
    // AMENDMENT 4 §D — the allow-list is a convenience because no credential can
    // ride the request. The moment this appears, that stops being true.
    expect(headers).not.toHaveProperty('Access-Control-Allow-Credentials');
  });

  it('CORS answers null for an alias and for an unverified domain', async () => {
    const a = await seedSubdomain('old.motir.site');
    await adminDb.publicAddress.update({
      where: { id: a.id },
      data: { kind: 'workspace_subdomain_alias', status: 'alias' },
    });
    await seedCustomDomain('pending.acme.test', 'unverified');
    resetAllowedOriginCache();
    expect(await publicCorsHeaders('https://old.motir.site')).toBeNull();
    expect(await publicCorsHeaders('https://pending.acme.test')).toBeNull();
  });

  it('the hand-off returns a visitor to an ISSUED custom-domain page', async () => {
    await seedCustomDomain('roadmap.acme.test', 'issued');
    await expect(
      resolvePublicReturnTarget('https://roadmap.acme.test/board?tab=open'),
    ).resolves.toBe('https://roadmap.acme.test/board?tab=open');
  });

  it('the hand-off falls back for every non-registered origin', async () => {
    for (const bad of [
      'https://evil.example/p/ACME',
      'https://motir.co@evil.test/',
      '//evil.example',
      'not-a-url',
      undefined,
    ]) {
      await expect(resolveHandoffDestination(bad), String(bad)).resolves.toBe(
        HANDOFF_FALLBACK_PATH,
      );
    }
  });
});

// ── fixtures ───────────────────────────────────────────────────────────────

function seedSubdomain(hostname: string) {
  return adminDb.publicAddress.create({
    data: { workspaceId, hostname, kind: 'workspace_subdomain', status: 'active' },
  });
}

function seedCustomDomain(hostname: string, status: 'unverified' | 'issued') {
  return adminDb.publicAddress.create({
    data: {
      workspaceId,
      hostname,
      kind: 'custom_domain',
      status,
      verificationToken: `motir-verify-${hostname}`,
    },
  });
}
