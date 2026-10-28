import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PM_ENTITLEMENTS, entitlementsFor, pmTierForOrg } from '@/lib/billing/entitlements';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { AuditLogTable } from '@/app/(admin)/admin/audit-log/_components/AuditLogTable';
import { ToastProvider } from '@/components/ui/Toast';
import en from '@/messages/en.json';
import { createTestUser } from '../fixtures/userFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * STORY MOTIR-9385's motir-core INTEGRATION GATE (MOTIR-9390) — what is LEFT once
 * the Contact-sales Enterprise-requests feature (MOTIR-9386) and the `enterprise`
 * PM tier (MOTIR-9388) are gone.
 *
 * Each predecessor proved its own unit suites. This reads the assembled tree —
 * coverage configs, `package.json`, the workflows, every import specifier, the
 * generated client, the locale catalogues — so a deletion cannot leave a dangling
 * reference that a green typecheck does not see, and it reads two seams against
 * real Postgres: an old audit row, and the PM tier over real organisations.
 *
 * It names `enterpriseRequest*`, `story-7602-coverage` and
 * `/admin/enterprise-requests` literally because it asserts their absence.
 *
 * ⚠️ THE TABLE WAS DROPPED IN THREE PHASES. The repository's drop rule
 * (`tests/contract-phase-guard.test.ts`) kept `enterprise_request` and its five
 * enums in `prisma/schema.prisma` for one release, the model `@@ignore`d so the
 * generated client no longer named it; MOTIR-9394's CONTRACT migration then
 * dropped them. So the client's data model is asserted clean here, and the RLS
 * inventory is asserted to agree with the migrated database rather than to omit
 * the table, which holds on either side of that migration.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The platform tier's `getSession` equivalent (no cookies in a test). The stub
    // re-runs the real ladder comparison, so a refusal is the service's own.
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

let currentPrincipal: PlatformPrincipal | null = null;

const ROOT = process.cwd();
const REMOVED = /enterprise[-_]?requests?|platformEnterpriseRequest/i;
const DELETED_MODULES = [
  'enterpriseRequestService',
  'platformEnterpriseRequestService',
  'enterpriseRequestRepository',
  'platformEnterpriseRequest',
  'enterpriseRequestReceived',
  'billing/enterprise-request',
  'admin/enterprise-requests',
];
/** The shared files the story's two PRs edited: a coverage config that measures
 *  one of them is a config the story changed the denominator of. */
const STORY_SHARED_FILES = [
  'lib/mappers/billingMappers.ts',
  'lib/mappers/platformMappers.ts',
  'lib/dto/billing.ts',
  'lib/billing/errors.ts',
  'lib/billing/errorResponse.ts',
  'lib/platform/errors.ts',
  'lib/platform/auditActions.ts',
  'lib/services/emailService.ts',
  'lib/billing/entitlements.ts',
  'lib/billing/catalog.ts',
  'lib/services/aiPlanGateService.ts',
  'lib/services/agentInstanceLifecycleService.ts',
  'lib/repositories/projectRepoRepository.ts',
  'lib/repositories/platformAuditLogRepository.ts',
  'lib/repositories/platformStaffRepository.ts',
  'app/(admin)/_components/AdminShell.tsx',
  'app/(admin)/layout.tsx',
];

// The matcher the coverage provider uses, resolved through vitest itself
// (`tests/helpers/coverageGate.ts`'s reasoning: one source of truth for "does this
// glob reach a file").
const requireFromVitest = createRequire(createRequire(import.meta.url).resolve('vitest'));
const { glob } = requireFromVitest('tinyglobby') as {
  glob: (patterns: string[], options: Record<string, unknown>) => Promise<string[]>;
};

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name === 'generated') {
      continue;
    }
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

/**
 * The module specifiers a file really imports, read from its syntax tree: import /
 * export declarations, `import()`, `require()` and `vi.mock()`. A specifier inside
 * a string, a template or a regex (a fixture's source text, a generator's output, a
 * guard's pattern) is not an import, and a text scan cannot tell the difference.
 */
function importSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [first] = node.arguments;
      const callee = node.expression.getText(source);
      const isLoader =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        callee === 'require' ||
        callee === 'vi.mock';
      if (isLoader && first && ts.isStringLiteral(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

interface CoverageConfigRead {
  file: string;
  patterns: string[];
}

async function readCoverageConfigs(): Promise<CoverageConfigRead[]> {
  const files = readdirSync(ROOT).filter((f) => /^vitest\.coverage\..+\.config\.ts$/.test(f));
  const reads: CoverageConfigRead[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(path.join(ROOT, file)).href)) as {
      default: {
        test?: {
          include?: string[];
          coverage?: { include?: string[]; thresholds?: Record<string, unknown> };
        };
      };
    };
    const test = mod.default.test ?? {};
    const thresholdKeys = Object.keys(test.coverage?.thresholds ?? {}).filter(
      (k) =>
        !['perFile', 'autoUpdate', '100', 'lines', 'functions', 'statements', 'branches'].includes(
          k,
        ),
    );
    reads.push({
      file,
      patterns: [...(test.include ?? []), ...(test.coverage?.include ?? []), ...thresholdKeys],
    });
  }
  return reads;
}

const matches = (pattern: string) => glob([pattern], { cwd: ROOT, ignore: ['node_modules/**'] });

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flattenKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

async function auditRowFromAnOlderBuild(principal: PlatformPrincipal): Promise<void> {
  // `record` refuses a key the vocabulary no longer has, so the row is written
  // with a live action and then given the removed key on the owner client — the
  // state a row an older build wrote sits in.
  await platformAuditService.record(principal, {
    action: 'user.suspend',
    targetKind: 'user',
    targetId: 'user_old',
    targetLabel: 'Old row',
    organizationId: 'org_old',
    reason: 'written before MOTIR-9386',
  });
  await adminDb.platformAuditLog.updateMany({
    where: { seq: 1 },
    data: { action: 'enterprise_request.transition' },
  });
}

beforeAll(async () => {
  // Warm the generated client's data model read once; every tree case below is
  // a cache-free filesystem read.
  await adminDb.$connect();
});

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany({});
  await truncateAuthTables(adminDb);
  const staff = await createTestUser({ email: 'ops+gate-9390@moooon.net', name: 'Gate Op' });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'superadmin' } });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'superadmin' };
});

afterAll(async () => {
  await adminDb.platformAuditLog.deleteMany({});
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('package.json lanes', () => {
  it('names no enterprise-requests config, and every --config a script names exists', () => {
    const missing: string[] = [];
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, name).not.toContain('vitest.coverage.enterprise-requests.config.ts');
      expect(name, name).not.toMatch(REMOVED);
      for (const m of script.matchAll(/--config[= ](\S+)/g)) {
        if (!existsSync(path.join(ROOT, m[1]!))) missing.push(`${name}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('coverage configs', () => {
  it('no glob or threshold key names the removed feature, and every glob in a config measuring a file the story changed reaches a file', async () => {
    const reads = await readCoverageConfigs();
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.map((r) => r.file)).not.toContain('vitest.coverage.enterprise-requests.config.ts');

    const naming = reads.flatMap((r) =>
      r.patterns.filter((p) => REMOVED.test(p)).map((p) => `${r.file}: ${p}`),
    );
    expect(naming).toEqual([]);

    const dead: string[] = [];
    let touched = 0;
    for (const read of reads) {
      const resolved = await Promise.all(read.patterns.map(matches));
      const measuresStoryFile = resolved.some((files) =>
        files.some((f) => STORY_SHARED_FILES.includes(f)),
      );
      if (!measuresStoryFile) continue;
      touched++;
      read.patterns.forEach((p, i) => {
        if (resolved[i]!.length === 0) dead.push(`${read.file}: ${p}`);
      });
    }
    expect(touched).toBeGreaterThan(0);
    expect(dead).toEqual([]);
  }, 120_000);
});

describe('CI workflows', () => {
  it('name no story-7602-coverage job, and every pnpm script a step runs exists', () => {
    // pnpm built-ins and binaries are not scripts.
    const builtIns = new Set([
      'install',
      'i',
      'add',
      'remove',
      'exec',
      'dlx',
      'run',
      'store',
      'fetch',
      'prune',
      'rebuild',
      'why',
      'list',
      'outdated',
      'update',
      'config',
      'env',
      'setup',
      'version',
      'publish',
      'pack',
      'deploy',
    ]);
    const isBinary = (name: string) => existsSync(path.join(ROOT, 'node_modules/.bin', name));
    const unknown: string[] = [];
    const dir = path.join(ROOT, '.github/workflows');
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      expect(text, file).not.toContain('story-7602-coverage');
      for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('#')) continue;
        for (const m of line.matchAll(/\bpnpm\s+(?:run\s+)?([a-z][a-z0-9:_-]*)/g)) {
          const name = m[1]!;
          if (builtIns.has(name) || isBinary(name) || name in pkg.scripts) continue;
          unknown.push(`${file}: pnpm ${name}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe('source imports', () => {
  it('no specifier names a deleted module, and every relative specifier resolves', () => {
    const exts = ['.ts', '.tsx', '.mjs'];
    const files = ['app', 'lib', 'components', 'scripts', 'packages', 'tests'].flatMap((d) =>
      walk(path.join(ROOT, d), exts),
    );
    const candidates = [
      '',
      '.ts',
      '.tsx',
      '.js',
      '.mjs',
      '.json',
      '.d.ts',
      '/index.ts',
      '/index.tsx',
      '/index.js',
    ];
    const resolves = (base: string) =>
      candidates.some((c) => existsSync(base + c)) ||
      // ESM-style `.js` written for a `.ts` source.
      (/\.m?js$/.test(base) &&
        ['.ts', '.tsx', '.mts'].some((c) => existsSync(base.replace(/\.m?js$/, c))));
    const deleted: string[] = [];
    const dangling: string[] = [];
    const self = rel(import.meta.filename ?? '');
    // Every real specifier is a quoted literal, so a file whose quoted relative
    // strings all resolve and that names no deleted module cannot fail either
    // check. Only the rest is parsed: parsing the whole tree overran the timeout on
    // a loaded CI runner.
    const quotedRelative = /(['"])(\.{1,2}\/[^'"\n]*)\1/g;
    for (const file of files) {
      if (rel(file) === self) continue;
      const text = readFileSync(file, 'utf8');
      const suspect =
        DELETED_MODULES.some((d) => text.includes(d)) ||
        [...text.matchAll(quotedRelative)].some(
          (m) => !resolves(path.resolve(path.dirname(file), m[2]!)),
        );
      if (!suspect) continue;
      for (const spec of importSpecifiers(file, text)) {
        if (DELETED_MODULES.some((d) => spec.includes(d))) deleted.push(`${rel(file)}: ${spec}`);
        if (spec.startsWith('.') && !resolves(path.resolve(path.dirname(file), spec))) {
          dangling.push(`${rel(file)}: ${spec}`);
        }
      }
    }
    expect(deleted).toEqual([]);
    expect(dangling).toEqual([]);
  }, 120_000);
});

describe('the generated Prisma client', () => {
  it('has no EnterpriseRequest model, none of its five enums, and no field typed by one', () => {
    const source = readFileSync(path.join(ROOT, 'generated/prisma/internal/class.ts'), 'utf8');
    const literal = source.match(/config\.runtimeDataModel = JSON\.parse\((".*?")\)\n/);
    expect(literal, 'runtimeDataModel literal in the generated client').not.toBeNull();
    const model = JSON.parse(JSON.parse(literal![1]!) as string) as {
      models: Record<string, { fields: { name: string; type: string }[] }>;
      enums: Record<string, unknown>;
    };
    const named = [
      'EnterpriseRequest',
      'EnterpriseRequestStatus',
      'EnterpriseAgentPath',
      'EnterpriseAutonomy',
      'EnterpriseStartWhen',
      'EnterpriseTeamSize',
    ];
    expect(Object.keys(model.models).length).toBeGreaterThan(0);
    expect(Object.keys(model.models).filter((m) => named.includes(m))).toEqual([]);
    expect(Object.keys(model.enums).filter((e) => named.includes(e))).toEqual([]);
    const typed = Object.entries(model.models).flatMap(([name, m]) =>
      m.fields.filter((f) => named.includes(f.type)).map((f) => `${name}.${f.name}`),
    );
    expect(typed).toEqual([]);
    for (const owner of ['Organization', 'User']) {
      expect(model.models[owner]!.fields.map((f) => f.name)).not.toContain('enterpriseRequests');
    }
  });
});

describe('the RLS table inventory', () => {
  it('names enterprise_request exactly while the migrated database still has the table', async () => {
    const inventory = readFileSync(
      path.join(ROOT, 'tests/platform/organizationClassification.test.ts'),
      'utf8',
    );
    const rows = await adminDb.$queryRaw<{ present: boolean }[]>`
      SELECT to_regclass('public.enterprise_request') IS NOT NULL AS present`;
    const present = rows[0]?.present ?? false;
    // The inventory classifies the table exactly while it is migrated; MOTIR-9394's
    // drop removed both together.
    expect(inventory.includes("'enterprise_request'")).toBe(present);
  });
});

describe('the locale catalogues', () => {
  it('carry no key of the removed rail label, console, staff email or audit label', () => {
    const dir = path.join(ROOT, 'messages');
    const leftovers: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const keys = flattenKeys(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
      expect(keys.length, file).toBeGreaterThan(0);
      for (const key of keys) {
        if (/navEnterpriseRequests|enterpriseRequests?|enterprise_request/.test(key)) {
          leftovers.push(`${file}: ${key}`);
        }
      }
    }
    expect(leftovers).toEqual([]);
  });
});

describe('an audit row the removed feature wrote', () => {
  it('searchEntries returns it raw with no filter and with the console default, and the table renders the raw key', async () => {
    await auditRowFromAnOlderBuild(currentPrincipal!);

    const consoleDefault = await platformAuditService.searchEntries(currentPrincipal!);
    const unfiltered = await platformAuditService.searchEntries(currentPrincipal!, {
      writesOnly: false,
    });
    for (const page of [consoleDefault, unfiltered]) {
      const old = page.entries.find((e) => e.seq === 1);
      expect(old).toMatchObject({ action: 'enterprise_request.transition', isWrite: true });
    }

    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <ToastProvider>
          <AuditLogTable
            rows={consoleDefault.entries.map((entry) => ({ entry, chain: 'verified' as const }))}
            initialOpenSeq={null}
            clearHref={null}
          />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
    expect(html).toContain('data-testid="audit-row-1"');
    expect(html).toContain('enterprise_request.transition');
  });
});

describe('the PM tier over real organisations', () => {
  it('PM_ENTITLEMENTS is exactly free, scaled and meta, and three orgs resolve with their caps', async () => {
    expect(Object.keys(PM_ENTITLEMENTS)).toEqual(['free', 'scaled', 'meta']);

    const orgOf = async (name: string) =>
      (await createTestWorkspace({ name })).workspace.organizationId;
    const meta = await orgOf('Meta');
    const scaled = await orgOf('Scaled');
    const free = await orgOf('Free');
    await adminDb.organization.update({ where: { id: meta }, data: { isMeta: true } });
    await adminDb.organization.update({
      where: { id: scaled },
      data: { scaledTrackerSubscription: { status: 'active', seats: 3 } },
    });

    const tierOf = async (orgId: string) =>
      pmTierForOrg(
        await withOrgServiceWriteContext(orgId, (tx) =>
          organizationRepository.findCapContext(orgId, tx),
        ),
      );
    expect([await tierOf(meta), await tierOf(scaled), await tierOf(free)]).toEqual([
      'meta',
      'scaled',
      'free',
    ]);
    // The caps each tier carried before the change.
    expect(entitlementsFor('free')).toMatchObject({
      maxWorkItems: 250,
      maxProjects: 3,
      maxCustomDomains: 0,
    });
    expect(entitlementsFor('scaled')).toMatchObject({ maxWorkItems: null, maxCustomDomains: 5 });
    expect(entitlementsFor('meta')).toMatchObject({
      maxWorkItems: null,
      maxTotalStorageBytes: null,
      maxCustomDomains: null,
    });
  });
});

describe('the removed route and console', () => {
  it('have no directory left on disk', () => {
    expect(
      existsSync(path.join(ROOT, 'app/api/organizations/[orgId]/billing/enterprise-request')),
    ).toBe(false);
    expect(existsSync(path.join(ROOT, 'app/(admin)/admin/enterprise-requests'))).toBe(false);
  });
});
