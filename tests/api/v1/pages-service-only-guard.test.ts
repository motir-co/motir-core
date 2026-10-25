import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The `/api/v1` page routes go THROUGH `pagesService`, never around it (Story
// MOTIR-9486 · MOTIR-9496). Every rule a page write obeys — the revision check,
// the archive refusal, the tree rules, the Yjs canonical body and the markdown
// it derives — lives in the service. A route or helper that reached the
// database, a repository, an MCP tool or the document conversion directly would
// be a second implementation of those rules, and the two would drift.
//
// So this guard reads the SOURCE of every page route and every `lib/api/v1/pages`
// module and refuses:
//   - a value import of the database client, the generated Prisma client or a
//     repository;
//   - an import of an MCP tool (`lib/mcp/tools/*`) — REST and the MCP are
//     siblings over the service, not layered on each other;
//   - an import of the document conversion — `@motir/pages` (markdownToUpdate,
//     parseMarkdown, serializeMarkdown, stateToMarkdown…), `yjs`, `lib/markdown`;
//   - a route file that never calls `pagesService`.

const REPO_ROOT = process.cwd();

/** The trees the guard walks, repo-relative. */
export const PAGE_REST_ROOTS = [
  'app/api/v1/pages',
  'app/api/v1/projects/[projectKey]/pages',
  'lib/api/v1/pages',
] as const;

const FORBIDDEN_IMPORTS: ReadonlyArray<{ test: (specifier: string) => boolean; why: string }> = [
  { test: (s) => s === '@/lib/db' || s.startsWith('@/lib/db/'), why: 'the database client' },
  { test: (s) => s.startsWith('@/generated/prisma'), why: 'the generated Prisma client' },
  { test: (s) => s.startsWith('@/lib/repositories'), why: 'a repository' },
  { test: (s) => s.startsWith('@/lib/mcp/tools'), why: 'an MCP tool' },
  {
    test: (s) => s === '@motir/pages' || s.startsWith('@motir/pages/'),
    why: 'the document conversion (@motir/pages)',
  },
  { test: (s) => s === 'yjs' || s.startsWith('y-'), why: 'the Yjs document' },
  { test: (s) => s.startsWith('@/lib/markdown'), why: 'markdown conversion' },
];

export interface ServiceOnlyViolation {
  file: string;
  rule: 'forbidden-import' | 'route-without-service';
  detail: string;
}

/** Every module specifier a source imports, re-exports or requires, with whether it is type-only. */
function importsOf(source: string): Array<{ specifier: string; typeOnly: boolean }> {
  const found: Array<{ specifier: string; typeOnly: boolean }> = [];
  const statement =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(statement)) {
    found.push({ specifier: match[3]!, typeOnly: Boolean(match[2]) });
  }
  for (const match of source.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ specifier: match[1]!, typeOnly: false });
  }
  return found;
}

/**
 * The service-only violations in one file's source. `file` is repo-relative;
 * a `route.ts` must also call `pagesService`.
 */
export function checkPageRestSource(file: string, source: string): ServiceOnlyViolation[] {
  const violations: ServiceOnlyViolation[] = [];
  for (const { specifier, typeOnly } of importsOf(source)) {
    // A type carries no behaviour; only a value import can bypass the service.
    if (typeOnly) continue;
    const rule = FORBIDDEN_IMPORTS.find((r) => r.test(specifier));
    if (rule) {
      violations.push({ file, rule: 'forbidden-import', detail: `${specifier} — ${rule.why}` });
    }
  }
  const isRoute = file.split(/[\\/]/).at(-1) === 'route.ts';
  if (isRoute && !/\bpagesService\s*\.\s*\w+\s*\(/.test(source)) {
    violations.push({
      file,
      rule: 'route-without-service',
      detail: 'a page route must call pagesService',
    });
  }
  return violations;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The page REST sources on disk, keyed by repo-relative path. */
function pageRestSources(): Map<string, string> {
  return new Map(
    PAGE_REST_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))).map(
      (path) =>
        [relative(REPO_ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')] as const,
    ),
  );
}

describe('the page REST surface goes through pagesService only', () => {
  it('finds the route files and helpers at all — the walk is not silently empty', () => {
    const files = [...pageRestSources().keys()];
    expect(files.filter((f) => f.endsWith('/route.ts'))).toHaveLength(6);
    expect(files).toEqual(
      expect.arrayContaining([
        'lib/api/v1/pages/errors.ts',
        'lib/api/v1/pages/resolve.ts',
        'lib/api/v1/pages/schema.ts',
        'lib/api/v1/pages/operations.ts',
      ]),
    );
  });

  it('no file imports around the service, and every route calls it', () => {
    const violations = [...pageRestSources()].flatMap(([file, source]) =>
      checkPageRestSource(file, source),
    );
    expect(violations).toEqual([]);
  });
});

describe('the checker fails on a violation', () => {
  const PAGES_PACKAGE = ['@motir', 'pages'].join('/');
  const route = 'app/api/v1/pages/[pageId]/route.ts';
  const calls = 'export const GET = () => pagesService.getPageMarkdown(ctx, input);\n';

  it.each([
    ["import { db } from '@/lib/db';", '@/lib/db'],
    ["import { Prisma } from '@/generated/prisma/client';", '@/generated/prisma/client'],
    ["import { pageRepository } from '@/lib/repositories/pageRepository';", 'pageRepository'],
    ["import { getPageTool } from '@/lib/mcp/tools/getPage';", '@/lib/mcp/tools/getPage'],
    // The package name is assembled so `importDirection.test.ts`, which scans
    // test sources for real imports of it, does not read these samples as one.
    [`import { markdownToUpdate } from '${PAGES_PACKAGE}';`, PAGES_PACKAGE],
    [`import { parseMarkdown } from '${PAGES_PACKAGE}/document';`, PAGES_PACKAGE],
    ["import * as Y from 'yjs';", 'yjs'],
    ["export { excerpt } from '@/lib/markdown/excerpt';", '@/lib/markdown'],
    ["const { db } = await import('@/lib/db');", '@/lib/db'],
  ])('flags %s', (line, named) => {
    const violations = checkPageRestSource(route, `${line}\n${calls}`);
    expect(violations).toEqual([
      expect.objectContaining({ rule: 'forbidden-import', detail: expect.stringContaining(named) }),
    ]);
  });

  it('flags a route that never calls pagesService', () => {
    expect(
      checkPageRestSource(route, "import { db } from '@/lib/db';\nexport const GET = () => db;"),
    ).toEqual([
      expect.objectContaining({ rule: 'forbidden-import' }),
      expect.objectContaining({ rule: 'route-without-service' }),
    ]);
  });

  it('allows a type-only import, and a helper that is not a route need not call the service', () => {
    const source = "import type { Page } from '@/generated/prisma/client';\nexport type P = Page;";
    expect(checkPageRestSource('lib/api/v1/pages/schema.ts', source)).toEqual([]);
  });
});
