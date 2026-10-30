import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// THE GUARANTEES COVERAGE CANNOT SEE (Story MOTIR-3878 · MOTIR-4223).
//
// Each is true of the TREE or of the DATABASE rather than of a function, so each
// is asked of the tree or of the database. The story added a table, four routes,
// a background job and a settings room; none of those is covered by a unit test
// of anything.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tracked = (dir: string): string[] =>
  execFileSync('git', ['ls-files', dir], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f));

/** Source with comments stripped — a rule must be asked of the CODE. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const { db } = await import('@/lib/db');

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('THE GUARDS THIS STORY ADDED ACTUALLY RUN', () => {
  it('the port boundary and the cookie guard are in the MAIN lane, not orphaned', () => {
    // ⚠️ EXISTING IS NOT RUNNING. `tests/helpers/structuralGuardLane.ts` is an
    // opt-in list, and the guards lane runs ONLY what it names — so a guard that
    // is in neither the lane nor the default `include` is a file nobody
    // executes. These two are in the ordinary sharded lane, which the default
    // glob covers; this asserts they are still where that glob reaches.
    const config = read('vitest.config.ts');
    const guardLane = read('tests/helpers/structuralGuardLane.ts');
    for (const spec of [
      'tests/publicAddresses/certificatePortBoundary.test.ts',
      'tests/publicAddresses/cookieAttributesUnmoved.test.ts',
    ]) {
      const named = guardLane.includes(spec);
      const excluded = config.includes(spec);
      expect(
        named || !excluded,
        `${spec} is neither in the guards lane nor reachable by the default include`,
      ).toBe(true);
    }
  });

  it('the tenant base domain still has exactly ONE reader', () => {
    // `MOTIR_PUBLIC_TENANT_DOMAIN` decides what every tenant hostname is built
    // on. A second reader is a second place to spell it, and getting it wrong
    // there is silent — every tenant host simply stops resolving.
    // ⚠️ THE NAME IS BOUND TO A CONSTANT AND READ THROUGH IT, so a grep for the
    // literal `process.env['MOTIR_...']` finds NOTHING — including in the module
    // that owns it. The reader is `process.env[<anything>]` paired with the
    // variable's name anywhere in the file, which is what a second reader would
    // have to look like too.
    const readers = [...tracked('lib'), ...tracked('app')].filter((f) => {
      const src = code(f);
      return src.includes('MOTIR_PUBLIC_TENANT_DOMAIN') && /process\.env\[/.test(src);
    });
    expect(readers).toEqual(['lib/publicAddresses/tenantDomain.ts']);
  });

  it('no service or route imports the Fly ADAPTER directly', () => {
    // ADR §6's boundary: the platform is reached through the PORT and chosen by
    // the composition root. A service that imported the adapter would be a
    // service that cannot be tested without Fly, and a second place that knows
    // which vendor we use.
    const offenders = [...tracked('lib/services'), ...tracked('app/api')].filter((f) =>
      code(f).includes('publicAddresses/adapters/'),
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('ROW-LEVEL SECURITY on the new table', () => {
  it('public_address has RLS enabled and all three arms', async () => {
    const [enabled] = await adminDb.$queryRawUnsafe<{ relrowsecurity: boolean }[]>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'public_address'`,
    );
    expect(enabled?.relrowsecurity, 'RLS is not enabled on public_address').toBe(true);

    const policies = await adminDb.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'public_address'`,
    );
    const names = policies.map((p) => p.policyname);
    // ⚠️ THREE ARMS, AND THE SYSTEM ONE WAS ADDED LATE. The cross-tenant sweep
    // could SELECT through the public arm and then UPDATE zero rows, which reads
    // as "nothing was due" rather than as a refusal — the silent-zero failure
    // this table's own migration note records.
    expect(names.length, `public_address has policies: ${names.join(', ')}`).toBeGreaterThanOrEqual(
      3,
    );
    expect(names.some((n) => n.includes('system'))).toBe(true);
  });
});

describe('CROSS-TENANT ISOLATION — a 404, never a 403, and never a leak', () => {
  let a: { workspaceId: string; ownerId: string; projectId: string };
  let b: { workspaceId: string; ownerId: string; projectId: string };

  beforeEach(async () => {
    await truncateAuthTables();
    process.env['MOTIR_CLOUD'] = 'true';
    process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = 'motir.example';
    const { createTestWorkspace } = await import('../fixtures');
    const seed = async (name: string, identifier: string) => {
      const { workspace, owner } = await createTestWorkspace({ name });
      const project = await adminDb.project.create({
        data: {
          workspaceId: workspace.id,
          name,
          slug: identifier.toLowerCase(),
          identifier,
          ...projectAccessData('public'),
        },
      });
      return { workspaceId: workspace.id, ownerId: owner.id, projectId: project.id };
    };
    a = await seed('Acme', 'ACME');
    b = await seed('Beta', 'BETA');
  });

  it('A’s owner cannot READ B’s subdomain — the workspace is not visible', async () => {
    const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
    const { WorkspaceNotVisibleError } = await import('@/lib/publicAddresses/errors');
    await publicSubdomainService.claim(b.workspaceId, 'beta', b.ownerId);

    // ⚠️ THE REFUSAL IS *NOT VISIBLE*, WHICH MAPS TO 404 — the mapper's own
    // choice, and the reason is that a 403 would confirm the workspace exists.
    await expect(
      publicSubdomainService.getForWorkspace(b.workspaceId, a.ownerId),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);
  });

  it('and cannot WRITE it either', async () => {
    const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
    const { WorkspaceNotVisibleError } = await import('@/lib/publicAddresses/errors');
    await expect(
      publicSubdomainService.claim(b.workspaceId, 'stolen', a.ownerId),
    ).rejects.toBeInstanceOf(WorkspaceNotVisibleError);

    // And nothing was written on the way to the refusal.
    const rows = await adminDb.publicAddress.count({ where: { workspaceId: b.workspaceId } });
    expect(rows).toBe(0);
  });

  it('A’s owner cannot list or touch B’s customer domains', async () => {
    const { customDomainService } = await import('@/lib/services/customDomainService');
    const { mapCustomDomainError } = await import('@/lib/publicAddresses/errorResponse');

    // Since MOTIR-9524 the domains are B's WORKSPACE's, addressed by B's
    // workspace id in the path — which A can type, and must learn nothing from.
    //
    // ⚠️ THE CLAIM IS THE STATUS, NOT THE CLASS. Which typed error the service
    // reaches for is its business and it changes; what must never change is what
    // a caller LEARNS, and that is settled by the mapper. Asserting the class
    // would pin an implementation detail and still not prove the property.
    for (const attempt of [
      () => customDomainService.list({ workspaceId: b.workspaceId, actorUserId: a.ownerId }),
      () =>
        customDomainService.add({
          workspaceId: b.workspaceId,
          hostname: 'roadmap.beta.test',
          actorUserId: a.ownerId,
        }),
    ]) {
      const refusal = await attempt().then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal, 'B’s domains were reached by A').not.toBeNull();
      const mapped = mapCustomDomainError(refusal);
      expect(mapped?.status, 'a cross-tenant read must be indistinguishable from absence').toBe(
        404,
      );
    }
    expect(await adminDb.publicAddress.count({ where: { workspaceId: b.workspaceId } })).toBe(0);
  });
});

describe('THE HOST CONTRACT IS ANONYMOUS BY CONSTRUCTION', () => {
  it('reads no session, in the source', () => {
    // There is nothing to observe at run time: a route that read a session would
    // behave identically here and would stop being cacheable in production,
    // where the cost lands. The same assertion the feed route carries.
    const src = code('app/api/public/hosts/[host]/route.ts');
    expect(src).not.toContain('getSession');
    expect(src).not.toContain('@/lib/auth');
  });

  it('and states its own freshness, so the consumer does not have to guess', () => {
    // `motir-marketing`'s router calls this on EVERY request to a tenant host.
    // A route with no `Cache-Control` would make that a per-request round trip.
    expect(code('app/api/public/hosts/[host]/route.ts')).toContain('Cache-Control');
  });
});

describe('EVERY STATUS MAP IS TOTAL', () => {
  it('is written as a `Record` over the enum, in each of the four places', () => {
    // ⚠️ TYPECHECK IS THE PROOF and this is the INVENTORY. A `Record<Status, …>`
    // fails to compile when the enum grows; a list of the interesting values
    // simply would not mention the new one, and it would be swept, drawn or
    // refused by accident. `pnpm typecheck` runs in CI on this diff.
    const maps: [string, string][] = [
      ['lib/services/publicAddressCertificatesService.ts', 'Record<PublicAddressStatus, boolean>'],
      [
        'app/(authed)/settings/project/public-address/_components/CustomDomainsSection.tsx',
        'Record<DomainStatus, StateRow>',
      ],
    ];
    for (const [file, shape] of maps) {
      expect(code(file), `${file} no longer declares ${shape}`).toContain(shape);
    }
  });
});
