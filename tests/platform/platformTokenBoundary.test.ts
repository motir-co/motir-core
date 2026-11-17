import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_ROLE_LADDER } from '@/lib/platform/auth';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE TOKEN BOUNDARY (Story MOTIR-7662 · MOTIR-7673, widened by Story
// MOTIR-11455 · MOTIR-11458 · `docs/decisions/platform-staff-auth.md` §2, the
// 2026-10-07 and 2026-11-16 amendments).
//
// The amendments let a staff member's personal access token reach the IDEAS and
// the PLANNER-FINDINGS endpoints and nothing else on the platform. This file is
// what turns "nothing else" from a promise into a failing build, in two halves:
//
//  1. STRUCTURAL — each token gate is imported from its own route tree only
//     (`lib/platform/ideasGate.ts` from `app/api/platform/ideas/**`,
//     `lib/platform/plannerFindingsGate.ts` from
//     `app/api/platform/planner-findings/**`), and the token half they share
//     (`lib/platform/staffTokenPrincipal.ts`) from the two gates only. Any other
//     importer under `app/` or `lib/` fails here, by path.
//  2. BEHAVIOURAL — the ordinary gate, `requirePlatformStaff`, never accepts a
//     token: with a valid superadmin token and no session it refuses at every
//     degree, and every route handler under `app/api/**` that calls it (found by
//     scanning, not by a hand list) refuses a bearer-only request.

const ROOT = process.cwd();

/** A module named by any import spelling: `@/lib/platform/x`, a relative path, or `./x`. */
function moduleImport(name: string): RegExp {
  return new RegExp(
    `['"]@\\/lib\\/platform\\/${name}['"]|['"](\\.{1,2}\\/)+(lib\\/)?platform\\/${name}['"]|['"]\\.\\/${name}['"]`,
  );
}

/** Every token module, the module itself, and the ONLY places allowed to import it. */
const TOKEN_MODULES = [
  {
    file: 'lib/platform/ideasGate.ts',
    pattern: moduleImport('ideasGate'),
    allowed: (file: string) => file.startsWith('app/api/platform/ideas/'),
  },
  {
    file: 'lib/platform/plannerFindingsGate.ts',
    pattern: moduleImport('plannerFindingsGate'),
    allowed: (file: string) => file.startsWith('app/api/platform/planner-findings/'),
  },
  {
    file: 'lib/platform/staffTokenPrincipal.ts',
    pattern: moduleImport('staffTokenPrincipal'),
    allowed: (file: string) =>
      file === 'lib/platform/ideasGate.ts' || file === 'lib/platform/plannerFindingsGate.ts',
  },
] as const;

/** The route trees whose handlers are token doors — left out of the behavioural scan. */
const TOKEN_ROUTE_DIRS = ['app/api/platform/ideas/', 'app/api/platform/planner-findings/'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every `file → module` import of a token module from outside the places allowed
 * to import it. Pure over its input, so the negative case is testable.
 */
function gateImportViolations(files: { file: string; source: string }[]): string[] {
  return files.flatMap(({ file, source }) =>
    TOKEN_MODULES.filter((m) => file !== m.file && !m.allowed(file) && m.pattern.test(source)).map(
      (m) => `${file} -> ${m.file}`,
    ),
  );
}

function sourceTree(): { file: string; source: string }[] {
  return ['app', 'lib'].flatMap((top) =>
    walk(path.join(ROOT, top)).map((full) => ({
      file: path.relative(ROOT, full).split(path.sep).join('/'),
      source: readFileSync(full, 'utf8'),
    })),
  );
}

describe('structural — each token gate is imported from its own route tree only', () => {
  it('has no importer outside the allowed places', () => {
    expect(gateImportViolations(sourceTree())).toEqual([]);
  });

  it('names exactly the two route trees and the two gates as the allowed importers', () => {
    const allowedFor = (file: string) =>
      TOKEN_MODULES.filter((m) => m.allowed(file)).map((m) => m.file);
    expect(allowedFor('app/api/platform/ideas/route.ts')).toEqual(['lib/platform/ideasGate.ts']);
    expect(allowedFor('app/api/platform/planner-findings/records/route.ts')).toEqual([
      'lib/platform/plannerFindingsGate.ts',
    ]);
    expect(allowedFor('lib/platform/ideasGate.ts')).toEqual([
      'lib/platform/staffTokenPrincipal.ts',
    ]);
    expect(allowedFor('lib/platform/plannerFindingsGate.ts')).toEqual([
      'lib/platform/staffTokenPrincipal.ts',
    ]);
    expect(allowedFor('app/api/platform/orgs/route.ts')).toEqual([]);
  });

  it('really imports each gate where it is allowed to (the positive half)', () => {
    const tree = sourceTree();
    for (const m of TOKEN_MODULES) {
      expect(
        tree.some(({ file, source }) => m.allowed(file) && m.pattern.test(source)),
        m.file,
      ).toBe(true);
    }
  });

  it('catches an importer outside them, by any spelling (the negative fixture)', () => {
    const offenders = gateImportViolations([
      {
        file: 'app/api/platform/orgs/route.ts',
        source: "import { x } from '@/lib/platform/ideasGate';",
      },
      { file: 'lib/services/fooService.ts', source: "import { x } from '../platform/ideasGate';" },
      { file: 'lib/platform/other.ts', source: "export * from './ideasGate';" },
      {
        file: 'app/(admin)/admin/ideas/actions.ts',
        source: "await import('@/lib/platform/ideasGate')",
      },
      {
        file: 'app/api/platform/ideas/route.ts',
        source: "import { x } from '@/lib/platform/ideasGate';",
      },
      { file: 'lib/platform/ideasGate.ts', source: "import './ideasGate';" },
      // The planner-findings gate: its own tree is allowed, the ideas tree is not.
      {
        file: 'app/api/platform/planner-findings/records/route.ts',
        source: "import { x } from '@/lib/platform/plannerFindingsGate';",
      },
      {
        file: 'app/api/platform/ideas/runs/route.ts',
        source: "import { x } from '@/lib/platform/plannerFindingsGate';",
      },
      {
        file: 'app/(admin)/admin/planner-findings/actions.ts',
        source: "import { x } from '@/lib/platform/plannerFindingsGate';",
      },
      {
        file: 'app/api/platform/planner-findings/[findingId]/route.ts',
        source: "import { x } from '@/lib/platform/ideasGate';",
      },
      // The shared token half: the two gates only — never a route, never a service.
      { file: 'lib/platform/ideasGate.ts', source: "import { x } from './staffTokenPrincipal';" },
      {
        file: 'lib/platform/plannerFindingsGate.ts',
        source: "import { x } from './staffTokenPrincipal';",
      },
      {
        file: 'app/api/platform/planner-findings/records/[id]/route.ts',
        source: "import { x } from '@/lib/platform/staffTokenPrincipal';",
      },
      {
        file: 'lib/services/plannerFindingsService.ts',
        source: "import { x } from '../platform/staffTokenPrincipal';",
      },
    ]);
    expect(offenders).toEqual([
      'app/api/platform/orgs/route.ts -> lib/platform/ideasGate.ts',
      'lib/services/fooService.ts -> lib/platform/ideasGate.ts',
      'lib/platform/other.ts -> lib/platform/ideasGate.ts',
      'app/(admin)/admin/ideas/actions.ts -> lib/platform/ideasGate.ts',
      'app/api/platform/ideas/runs/route.ts -> lib/platform/plannerFindingsGate.ts',
      'app/(admin)/admin/planner-findings/actions.ts -> lib/platform/plannerFindingsGate.ts',
      'app/api/platform/planner-findings/[findingId]/route.ts -> lib/platform/ideasGate.ts',
      'app/api/platform/planner-findings/records/[id]/route.ts -> lib/platform/staffTokenPrincipal.ts',
      'lib/services/plannerFindingsService.ts -> lib/platform/staffTokenPrincipal.ts',
    ]);
  });
});

// ── Behavioural ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => null),
}));

let token = '';

beforeEach(async () => {
  vi.resetModules();
  await truncateAuthTables();
  const { owner, workspace } = await createTestWorkspace({ name: 'Token boundary' });
  await adminDb.user.update({ where: { id: owner.id }, data: { platformRole: 'superadmin' } });
  ({ token } = await apiTokensService.create(owner.id, workspace.id, {
    label: 'motir-ideas',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  }));
});

afterAll(async () => {
  await truncateAuthTables();
});

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Every route handler under `app/api/` (outside the token trees) that calls `requirePlatformStaff`. */
function platformRoutes(): string[] {
  return walk(path.join(ROOT, 'app/api'))
    .filter((full) => /route\.(ts|tsx)$/.test(full))
    .map((full) => path.relative(ROOT, full).split(path.sep).join('/'))
    .filter((file) => !TOKEN_ROUTE_DIRS.some((dir) => file.startsWith(dir)))
    .filter((file) =>
      /\brequirePlatformStaff\s*\(/.test(readFileSync(path.join(ROOT, file), 'utf8')),
    );
}

describe('behavioural — the ordinary platform gate never accepts a token', () => {
  it.each(PLATFORM_ROLE_LADDER)(
    'requirePlatformStaff(%s) refuses with a superadmin token and no session',
    async (minimum) => {
      const [{ requirePlatformStaff }, { NotPlatformStaffError }] = await Promise.all([
        import('@/lib/platform/auth'),
        import('@/lib/platform/errors'),
      ]);
      expect(token.startsWith('motir_pat_')).toBe(true);
      await expect(requirePlatformStaff(minimum)).rejects.toBeInstanceOf(NotPlatformStaffError);
    },
  );

  it('requirePlatformStaff reads no request header', () => {
    const source = readFileSync(path.join(ROOT, 'lib/platform/auth.ts'), 'utf8');
    expect(source).not.toMatch(/authorization/i);
    expect(source).not.toMatch(/apiTokensService/);
  });

  it('every app/api route that calls requirePlatformStaff refuses a bearer-only request', async () => {
    const routes = platformRoutes();
    const answered: string[] = [];
    for (const file of routes) {
      const mod = (await import(path.join(ROOT, file))) as Record<string, unknown>;
      for (const method of HTTP_METHODS) {
        const handler = mod[method];
        if (typeof handler !== 'function') continue;
        const req = new Request('http://localhost/api/platform/probe', {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
        });
        let status: number;
        try {
          const res = (await handler(req, { params: Promise.resolve({}) })) as Response;
          status = res.status;
        } catch (err) {
          status = (err as { code?: string }).code === 'NOT_PLATFORM_STAFF' ? 404 : 500;
        }
        expect({ file, method, status }).toEqual({ file, method, status: 404 });
        answered.push(`${method} ${file}`);
      }
    }
    // Today no app/api route outside the token trees is platform-gated — the
    // console is server actions behind the (admin) layout. The day one is added,
    // this loop starts probing it without anyone editing this file.
    expect(answered.length).toBeGreaterThanOrEqual(routes.length);
  });
});
