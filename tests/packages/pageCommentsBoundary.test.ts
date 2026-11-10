import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE PAGE-COMMENT PACKAGE BOUNDARY (Story MOTIR-10866 · MOTIR-10875) —
// `docs/decisions/app-shell-over-packages.md` and `docs/decisions/pages.md` §2:
// THE SERVICE DECIDES ACCESS; THE PACKAGE DECIDES CONTENT; THE ADAPTER IS THE
// ONLY THING THAT TOUCHES THE TABLE.
//
// Three predicates, each a source scan of what a file SAYS:
//
//   1. no comment ROUTE under `app/api/pages/[pageId]/comments` imports Prisma,
//      the database client or a repository — a route calls the service;
//   2. `lib/services/pageCommentsService.ts` imports neither the database
//      client nor `pageCommentRepository` — it reaches the table only through
//      the `@motir/pages` procedures over `pageStoreFor(tx)`;
//   3. `pageCommentRepository` is imported by production code only under
//      `lib/pages/` (the store adapter). Tests may import it.
//
// Mould: `tests/packages/importDirection.test.ts` — the same walk, the same
// comment stripping, the same mutation and innocence cases, and an explicit
// check that the scan read the files it is about, so it cannot pass by reading
// nothing.

const root = process.cwd();
const ROUTES_DIR = join('app', 'api', 'pages', '[pageId]', 'comments');
const SERVICE = join('lib', 'services', 'pageCommentsService.ts');
const PRODUCTION_ROOTS = ['app', 'lib', 'packages', 'components'];
const ADAPTER_HOME = join('lib', 'pages') + '/';

/** Prisma, the database client, or any repository. */
const ROUTE_FORBIDDEN =
  /\bfrom\s+['"]@\/(?:lib\/db|lib\/repositories\/[^'"]+|generated\/prisma(?:\/[^'"]*)?)['"]|\bimport\(\s*['"]@\/(?:lib\/db|lib\/repositories\/|generated\/prisma)/;
/** The database client, or the comment repository by any path. */
const SERVICE_FORBIDDEN =
  /\bfrom\s+['"](?:@\/lib\/db|[^'"]*pageCommentRepository)['"]|\bimport\(\s*['"](?:@\/lib\/db|[^'"]*pageCommentRepository)['"]/;
/** The comment repository, by any path. */
const REPOSITORY_IMPORT =
  /\bfrom\s+['"][^'"]*\/pageCommentRepository['"]|\bimport\(\s*['"][^'"]*\/pageCommentRepository['"]/;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A test file is not production code, wherever it sits. */
const isTestFile = (rel: string) =>
  /(^|\/)(tests?|__tests__)\//.test(rel) || /\.(test|spec)\.tsx?$/.test(rel);

function hits(files: readonly string[], tell: RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [index, line] of source.split('\n').entries()) {
      if (tell.test(line)) found.push(`${rel}:${index + 1}: ${line.trim().slice(0, 120)}`);
    }
  }
  return found;
}

const routeFiles = () => walk(join(root, ROUTES_DIR));

describe('page comments reach the table only through @motir/pages (MOTIR-10875)', () => {
  it('reads the comment routes and the service — the scan is not vacuous', () => {
    const routes = routeFiles().map((f) => relative(root, f));
    expect(routes.length).toBeGreaterThanOrEqual(4);
    expect(routes).toContain(join(ROUTES_DIR, 'route.ts'));
    expect(routes).toContain(join(ROUTES_DIR, '[commentId]', 'resolution', 'route.ts'));
    expect(statSync(join(root, SERVICE)).isFile()).toBe(true);
    // And the adapter really is the repository's one production importer.
    expect(
      hits([join(root, 'lib', 'pages', 'pageStoreAdapter.ts')], REPOSITORY_IMPORT),
    ).toHaveLength(1);
  });

  it('no comment route imports Prisma, the database client or a repository', () => {
    const found = hits(routeFiles(), ROUTE_FORBIDDEN);
    expect(found, found.join('\n')).toEqual([]);
  });

  it('the service imports neither the database client nor pageCommentRepository', () => {
    const found = hits([join(root, SERVICE)], SERVICE_FORBIDDEN);
    expect(found, found.join('\n')).toEqual([]);
  });

  it('pageCommentRepository is imported by production code only under lib/pages/', () => {
    const files = PRODUCTION_ROOTS.flatMap((dir) => walk(join(root, dir))).filter(
      (file) => !isTestFile(relative(root, file)),
    );
    expect(files.length).toBeGreaterThan(500);
    const found = hits(files, REPOSITORY_IMPORT).filter((hit) => !hit.startsWith(ADAPTER_HOME));
    expect(found, found.join('\n')).toEqual([]);
  });

  it('detects the imports it forbids (mutation check)', () => {
    for (const line of [
      "import { db } from '@/lib/db';",
      "import type { Prisma } from '@/generated/prisma/client';",
      "import { PrismaClient } from '@/generated/prisma';",
      "import { pageCommentRepository } from '@/lib/repositories/pageCommentRepository';",
      "const { db } = await import('@/lib/db');",
    ]) {
      expect(ROUTE_FORBIDDEN.test(line), line).toBe(true);
    }
    for (const line of [
      "import { db } from '@/lib/db';",
      "import { pageCommentRepository } from '@/lib/repositories/pageCommentRepository';",
      "import { pageCommentRepository } from '../repositories/pageCommentRepository';",
    ]) {
      expect(SERVICE_FORBIDDEN.test(line), line).toBe(true);
    }
    for (const line of [
      "import { pageCommentRepository } from '@/lib/repositories/pageCommentRepository';",
      "import { pageCommentRepository } from '../repositories/pageCommentRepository';",
      "const m = await import('@/lib/repositories/pageCommentRepository');",
    ]) {
      expect(REPOSITORY_IMPORT.test(line), line).toBe(true);
    }
    // A planted file under the routes would be read: the scan is over the tree.
    expect(hits(routeFiles(), /\bfrom\s+['"]next\/server['"]/).length).toBeGreaterThan(0);
  });

  it('does not fire on the imports the boundary permits', () => {
    const innocent = [
      "import { pageCommentsService } from '@/lib/services/pageCommentsService';",
      "import { pageCommentErrorResponse } from '@/lib/pages/commentRouteErrors';",
      "import { createPageComment, pageStoreFor } from '@/lib/pages';",
      "import { withWorkspaceContext } from '@/lib/workspaces/context';",
      "import { NextResponse } from 'next/server';",
    ];
    for (const line of innocent) {
      expect(ROUTE_FORBIDDEN.test(line), line).toBe(false);
      expect(SERVICE_FORBIDDEN.test(line), line).toBe(false);
      expect(REPOSITORY_IMPORT.test(line), line).toBe(false);
    }
    // Another repository is the route rule's business, not the comment-repository rule's.
    const otherRepository = "import { pageRepository } from '@/lib/repositories/pageRepository';";
    expect(ROUTE_FORBIDDEN.test(otherRepository)).toBe(true);
    expect(REPOSITORY_IMPORT.test(otherRepository)).toBe(false);
    // A test may import the repository; the production walk skips it.
    expect(isTestFile('tests/integration/pageCommentsStoryGate.test.ts')).toBe(true);
    expect(isTestFile('lib/pages/pageStoreAdapter.ts')).toBe(false);
  });
});
