import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { defineOperation, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';
import { PAGE_OPERATIONS } from '@/lib/api/v1/pages/operations';
import { auditV1RouteSource, v1RouteFiles } from '../../helpers/v1RouteAudit';
import {
  findSpecDrift,
  shippedRouteMethods,
  syntheticRouteFile,
} from '../../helpers/v1SpecConformance';

// The PAGE routes ↔ the PAGE operations, both directions (Story MOTIR-9486 ·
// MOTIR-9493).
//
// Discovered by WALKING `app/api/v1` rather than listing files: a page route the
// update or move card adds is checked the moment it exists. A route counts as a
// page route when it serves `/api/v1/pages/…` or `/api/v1/projects/{key}/pages`;
// an operation is a page operation when it is in `PAGE_OPERATIONS`. Each
// direction is also shown to FAIL on a synthetic violation — a guard that has
// never failed is not a guard.

const REPO_ROOT = process.cwd();

/** Is this route file one of the page resource's? */
function isPageRouteFile(file: string): boolean {
  const parts = file.split(sep);
  const v1 = parts.indexOf('v1');
  const rest = parts.slice(v1 + 1);
  return rest[0] === 'pages' || (rest[0] === 'projects' && rest[2] === 'pages');
}

/** The page route sources, keyed by repo-relative path. */
function pageRouteSources(): Map<string, string> {
  return new Map(
    v1RouteFiles(REPO_ROOT)
      .filter(isPageRouteFile)
      .map((file) => [file, readFileSync(join(REPO_ROOT, file), 'utf8')] as const),
  );
}

describe('page routes and page operations agree', () => {
  it('finds the page routes at all — the walk is not silently empty', () => {
    const sources = pageRouteSources();
    expect(sources.size).toBeGreaterThanOrEqual(2);
    expect(shippedRouteMethods(sources).length).toBeGreaterThanOrEqual(PAGE_OPERATIONS.length);
  });

  it('every page route method has a declared page operation, and every page operation a route', () => {
    expect(findSpecDrift(shippedRouteMethods(pageRouteSources()), PAGE_OPERATIONS)).toEqual([]);
  });

  it('every page operation is registered in the v1 document', () => {
    for (const operation of PAGE_OPERATIONS) {
      expect(V1_OPERATIONS).toContain(operation);
    }
  });

  it('every page route passes the v1 route audit', () => {
    for (const [file, source] of pageRouteSources()) {
      expect(auditV1RouteSource(file, source), file).toEqual([]);
    }
  });

  it('FAILS on a page route method no operation declares', () => {
    const sources = pageRouteSources();
    const file = syntheticRouteFile('pages', '[pageId]', 'duplicate');
    sources.set(
      file,
      "export const POST = withV1Route({ permission: 'page:edit' }, async () => null);",
    );
    expect(findSpecDrift(shippedRouteMethods(sources), PAGE_OPERATIONS)).toEqual([
      expect.objectContaining({
        rule: 'route-without-operation',
        subject: 'POST /api/v1/pages/{pageId}/duplicate',
      }),
    ]);
  });

  it('FAILS on a page operation no route serves', () => {
    const orphan: V1Operation = defineOperation({
      method: 'DELETE',
      path: '/api/v1/pages/{pageId}',
      operationId: 'deletePageOrphan',
      summary: 'Orphan',
      description: 'A declaration with no route behind it.',
      permission: 'page:edit',
      parameters: [
        { name: 'pageId', in: 'path', required: true, description: 'id', schema: z.string() },
      ],
      response: { status: 200, body: { kind: 'object', schema: z.object({}) }, description: 'x' },
      errorStatuses: [404],
    });
    expect(
      findSpecDrift(shippedRouteMethods(pageRouteSources()), [...PAGE_OPERATIONS, orphan]),
    ).toEqual([
      expect.objectContaining({
        rule: 'operation-without-route',
        subject: 'DELETE /api/v1/pages/{pageId}',
      }),
    ]);
  });
});

describe('the emitted document describes the page operations', () => {
  const document = emitOpenApiDocument() as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { schemas: Record<string, unknown> };
  };

  it('publishes create and read with their schemas, permission and refusal statuses', () => {
    const create = document.paths['/api/v1/projects/{projectKey}/pages']?.['post'];
    const read = document.paths['/api/v1/pages/{pageId}']?.['get'];
    expect(create?.['operationId']).toBe('createPage');
    expect(read?.['operationId']).toBe('getPage');
    expect(create?.['x-motir-permission']).toBe('page:edit');
    expect(read?.['x-motir-permission']).toBe('page:view');
    expect(create?.['requestBody']).toBeDefined();
    expect(Object.keys(create?.['responses'] as object)).toEqual(
      expect.arrayContaining(['201', '403', '404', '422']),
    );
    expect(Object.keys(read?.['responses'] as object)).toEqual(
      expect.arrayContaining(['200', '403', '404']),
    );
    expect(document.components.schemas['Page']).toBeDefined();
  });

  it('publishes searchPages with its parameters, the hit page, page:view and the empty-query rule', () => {
    const search = document.paths['/api/v1/projects/{projectKey}/pages/search']?.['get'];
    expect(search?.['operationId']).toBe('searchPages');
    expect(search?.['x-motir-permission']).toBe('page:view');
    const parameters = (search?.['parameters'] as Array<{ name: string; in: string }>).map(
      (p) => `${p.in}:${p.name}`,
    );
    expect(parameters).toEqual(
      expect.arrayContaining(['path:projectKey', 'query:q', 'query:cursor']),
    );
    expect(Object.keys(search?.['responses'] as object)).toEqual(
      expect.arrayContaining(['200', '403', '404', '422']),
    );
    expect(search?.['description']).toContain('PAGE_SEARCH_QUERY_EMPTY');
    expect(search?.['description']).toContain('never returns every page');
    expect(document.components.schemas['PageSearchHit']).toBeDefined();
  });

  it('FAILS when searchPages is undeclared while its route exists', () => {
    const without = PAGE_OPERATIONS.filter((op) => op.operationId !== 'searchPages');
    expect(findSpecDrift(shippedRouteMethods(pageRouteSources()), without)).toEqual([
      expect.objectContaining({
        rule: 'route-without-operation',
        subject: 'GET /api/v1/projects/{projectKey}/pages/search',
      }),
    ]);
  });

  it('FAILS when the search route is gone while searchPages is declared', () => {
    const sources = pageRouteSources();
    for (const file of [...sources.keys()])
      if (file.includes(`${sep}search${sep}`)) sources.delete(file);
    expect(findSpecDrift(shippedRouteMethods(sources), PAGE_OPERATIONS)).toEqual([
      expect.objectContaining({
        rule: 'operation-without-route',
        subject: 'GET /api/v1/projects/{projectKey}/pages/search',
      }),
    ]);
  });
});
