import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { PAGE_OPERATIONS } from '@/lib/api/v1/pages/operations';
import {
  type V1Page,
  type V1PageArchive,
  type V1PageLinkPair,
  type V1PageRestore,
} from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import {
  PAGE_EDITOR,
  archivePageV1,
  getPageV1,
  linkPageV1,
  memberCaller,
  movePageV1,
  restorePageV1,
  unlinkPageV1,
  updatePageV1,
} from '../../fixtures/apiV1PageFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { v1RouteFiles } from '../../helpers/v1RouteAudit';
import { findSpecDrift, shippedRouteMethods } from '../../helpers/v1SpecConformance';
import { PAGE_REST_ROOTS, checkPageRestSource } from './pages-service-only-guard.test';

// The REST page LIFECYCLE gate (Story MOTIR-9488 · MOTIR-9568) — the seams
// BETWEEN archive, restore, link and unlink, and between each of them and the
// page routes and service reads that were already there. The per-route suites
// (`pages-archive.test.ts`, `page-links.test.ts`) prove each route alone; this
// file proves the state one route writes is the state the next one reads:
// archive → GET and the tree, archive → every write refused, restore → update,
// link → archive → unlink. The service-only guard and the OpenAPI coverage check
// are the SHIPPED ones, pointed at the four new files rather than written twice.
//
// Archive and restore take no revision: their stale state is the named
// conflicts PAGE_ARCHIVED and PAGE_NOT_ARCHIVED (MOTIR-9566's narrowing), and
// the published description says so.

const SECRET_TITLE = 'Board pack — draft, do not circulate';

const WORK_ITEM_EDITOR = [...PAGE_EDITOR, 'work_item:edit'] as const;

const UNKNOWN_ID = 'cmzzzzzzzzzzzzzzzzzzzzzzz';

const NEW_ROUTE_FILES = [
  'app/api/v1/pages/[pageId]/archive/route.ts',
  'app/api/v1/pages/[pageId]/restore/route.ts',
  'app/api/v1/pages/[pageId]/work-items/route.ts',
  'app/api/v1/pages/[pageId]/work-items/[workItemId]/route.ts',
] as const;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "page_work_item_link", "work_item_revision", "work_item", "page", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A caller, a page with one sub-page, and a work item, all in one project. */
async function withWorld(): Promise<{
  caller: V1ProjectCaller;
  pageId: string;
  childId: string;
  workItemId: string;
}> {
  const caller = await createV1ProjectCaller({ permissions: [...WORK_ITEM_EDITOR] });
  const page = await pagesService.createPage(caller.ctx, {
    projectId: caller.fixture.projectId,
    title: SECRET_TITLE,
  });
  const child = await pagesService.createPage(caller.ctx, {
    projectId: caller.fixture.projectId,
    title: 'Appendix',
    parent: { kind: 'page', id: page.id },
  });
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title: 'Circulate the board pack' },
    caller.ctx,
  );
  return { caller, pageId: page.id, childId: child.id, workItemId: item.id };
}

/** The stored page, read past RLS — what a refusal must leave untouched. */
const stored = (id: string) =>
  adminDb.page.findUniqueOrThrow({
    where: { id },
    select: {
      archivedAt: true,
      archiveRootId: true,
      revision: true,
      bodyMarkdown: true,
      parentPageId: true,
      folderId: true,
      position: true,
    },
  });

const linkRows = (pageId: string, workItemId?: string) =>
  adminDb.pageWorkItemLink.count({ where: { pageId, ...(workItemId ? { workItemId } : {}) } });

/** The ids the app's tree shows at the project root. */
async function rootTreeIds(caller: V1ProjectCaller): Promise<string[]> {
  const level = await pagesService.listTreeLevel(caller.ctx, {
    projectId: caller.fixture.projectId,
    parent: { kind: 'root' },
  });
  return level.rows.map((row) => row.id);
}

/** Both sides of a link, as the app reads them. */
async function sides(caller: V1ProjectCaller, pageId: string, workItemId: string) {
  const [items, pages] = await Promise.all([
    pageLinksService.listWorkItemsForPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId,
    }),
    pageLinksService.listPagesForWorkItem(caller.ctx, { workItemId }),
  ]);
  return {
    pageListsItem: items.rows.some((row) => JSON.stringify(row).includes(workItemId)),
    itemListsPage: pages.rows.some((row) => JSON.stringify(row).includes(pageId)),
  };
}

describe('archive → read', () => {
  it('archive answers the set; GET reports archivedAt; the live tree no longer shows the page', async () => {
    const { caller, pageId, childId } = await withWorld();
    expect(await rootTreeIds(caller)).toContain(pageId);

    const res = await archivePageV1(caller, pageId);
    expect(res.status).toBe(200);
    const archived = await body<V1PageArchive>(res);
    expect(archived.rootId).toBe(pageId);
    expect(archived.archivedIds).toEqual([pageId, childId]);

    const page = await body<V1Page>(await getPageV1(caller, pageId));
    expect(page.archivedAt).toBe((await stored(pageId)).archivedAt!.toISOString());
    expect(await rootTreeIds(caller)).not.toContain(pageId);
  });
});

describe('archive → every write refused', () => {
  it('archive again, update, move and link are each 409 PAGE_ARCHIVED; body, revision, placement and links are unchanged', async () => {
    const { caller, pageId, workItemId } = await withWorld();
    const parent = await pagesService.createPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      title: 'Elsewhere',
    });
    expect((await archivePageV1(caller, pageId)).status).toBe(200);
    const before = await stored(pageId);

    const attempts = {
      archive: await archivePageV1(caller, pageId),
      update: await updatePageV1(caller, pageId, { markdown: 'x', revision: before.revision }),
      move: await movePageV1(caller, pageId, { parent: { kind: 'page', id: parent.id } }),
      link: await linkPageV1(caller, pageId, { workItemId }),
    };
    for (const [name, res] of Object.entries(attempts)) {
      expect({ name, status: res.status, code: (await body(res)).code }).toEqual({
        name,
        status: 409,
        code: 'PAGE_ARCHIVED',
      });
    }
    expect(await stored(pageId)).toEqual(before);
    expect(await linkRows(pageId)).toBe(0);
  });
});

describe('archive → restore → update', () => {
  it('restore answers the set and a landing kind; the page is back in the tree and saves with its current revision', async () => {
    const { caller, pageId, childId } = await withWorld();
    await archivePageV1(caller, pageId);

    const res = await restorePageV1(caller, pageId);
    expect(res.status).toBe(200);
    const restored = await body<V1PageRestore>(res);
    expect([...restored.restoredIds].sort()).toEqual([pageId, childId].sort());
    expect(typeof restored.landing.kind).toBe('string');

    const page = await body<V1Page>(await getPageV1(caller, pageId));
    expect(page.archivedAt).toBeNull();
    expect(await rootTreeIds(caller)).toContain(pageId);
    const saved = await updatePageV1(caller, pageId, {
      markdown: 'Editable again.',
      revision: page.revision,
    });
    expect(saved.status).toBe(200);
    expect((await body<V1Page>(await getPageV1(caller, pageId))).markdown).toContain(
      'Editable again.',
    );
  });

  it('restoring a live page is 409 PAGE_NOT_ARCHIVED; restoring a sub-page of an archived set is 409 PAGE_ARCHIVE_ROOT_REQUIRED; neither moves the state', async () => {
    const { caller, pageId, childId } = await withWorld();
    const live = await stored(pageId);
    const notArchived = await restorePageV1(caller, pageId);
    expect(notArchived.status).toBe(409);
    expect((await body(notArchived)).code).toBe('PAGE_NOT_ARCHIVED');
    expect(await stored(pageId)).toEqual(live);

    await archivePageV1(caller, pageId);
    const [root, child] = [await stored(pageId), await stored(childId)];
    const notRoot = await restorePageV1(caller, childId);
    expect(notRoot.status).toBe(409);
    expect((await body(notRoot)).code).toBe('PAGE_ARCHIVE_ROOT_REQUIRED');
    expect([await stored(pageId), await stored(childId)]).toEqual([root, child]);
  });
});

describe('link → read → archive → unlink', () => {
  it('link answers source manual and both sides list the other; a repeat is the same 200 and one row', async () => {
    const { caller, pageId, workItemId } = await withWorld();
    const first = await linkPageV1(caller, pageId, { workItemId });
    expect(first.status).toBe(200);
    const pair = await body<V1PageLinkPair>(first);
    expect(pair).toEqual({ pageId, workItemId, source: 'manual' });
    expect(await sides(caller, pageId, workItemId)).toEqual({
      pageListsItem: true,
      itemListsPage: true,
    });

    const again = await linkPageV1(caller, pageId, { workItemId });
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual(pair);
    expect(
      await adminDb.pageWorkItemLink.count({ where: { pageId, workItemId, source: 'manual' } }),
    ).toBe(1);
  });

  it('a link made before the archive is still removable after it; neither side lists the other; again is PAGE_LINK_NOT_FOUND', async () => {
    const { caller, pageId, workItemId } = await withWorld();
    expect((await linkPageV1(caller, pageId, { workItemId })).status).toBe(200);
    expect((await archivePageV1(caller, pageId)).status).toBe(200);

    const res = await unlinkPageV1(caller, pageId, workItemId);
    expect(res.status).toBe(200);
    expect(await linkRows(pageId, workItemId)).toBe(0);
    const items = await pageLinksService.listWorkItemsForPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId,
    });
    const pages = await pageLinksService.listPagesForWorkItem(caller.ctx, { workItemId });
    expect(JSON.stringify(items.rows)).not.toContain(workItemId);
    expect(JSON.stringify(pages.rows)).not.toContain(pageId);

    const again = await unlinkPageV1(caller, pageId, workItemId);
    expect(again.status).toBe(404);
    expect((await body(again)).code).toBe('PAGE_LINK_NOT_FOUND');
  });

  it('a work item of another project than the page is the unknown page’s 404, with no title and no row', async () => {
    const { caller, pageId } = await withWorld();
    const other = await projectsService.createProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      name: 'Other',
      identifier: 'OTH',
    });
    const foreignItem = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'task', title: 'Elsewhere' },
      caller.ctx,
    );

    const unknown = await linkPageV1(caller, UNKNOWN_ID, { workItemId: foreignItem.id });
    const expected = { status: unknown.status, text: await unknown.text() };
    expect(expected.status).toBe(404);
    expect(JSON.parse(expected.text).code).toBe('PAGE_NOT_FOUND');

    const cross = await linkPageV1(caller, pageId, { workItemId: foreignItem.id });
    const text = await cross.text();
    expect({ status: cross.status, text }).toEqual(expected);
    expect(text).not.toContain(SECRET_TITLE);
    expect(await linkRows(pageId)).toBe(0);
  });
});

describe('who may call the four routes', () => {
  /** Each new route, called by `who` against `pageId`. */
  const calls = (who: { headers: Record<string, string> }, pageId: string, workItemId: string) => ({
    archive: () => archivePageV1(who, pageId),
    restore: () => restorePageV1(who, pageId),
    link: () => linkPageV1(who, pageId, { workItemId }),
    unlink: () => unlinkPageV1(who, pageId, workItemId),
  });

  it('a browse-only member is 403 on all four — archive and restore PROJECT_ACCESS_DENIED — naming no page, writing nothing', async () => {
    const { caller, pageId, workItemId } = await withWorld();
    await linkPageV1(caller, pageId, { workItemId });
    const browser = await memberCaller(caller, 'browser', 'member', [...WORK_ITEM_EDITOR]);
    await adminDb.workspaceMembership.updateMany({
      where: { userId: browser.user.id, workspaceId: caller.workspace.id },
      data: { workspaceRole: 'viewer' },
    });
    expect((await getPageV1(browser, pageId)).status).toBe(200);
    const before = await stored(pageId);

    for (const [name, call] of Object.entries(calls(browser, pageId, workItemId))) {
      const res = await call();
      const text = await res.text();
      expect({ name, status: res.status }).toEqual({ name, status: 403 });
      expect(text).not.toContain(SECRET_TITLE);
      if (name === 'archive' || name === 'restore') {
        expect(JSON.parse(text).code).toBe('PROJECT_ACCESS_DENIED');
      }
    }
    expect(await stored(pageId)).toEqual(before);
    expect(await linkRows(pageId, workItemId)).toBe(1);
  });

  it('an unknown page id and an outsider answer every route with the same 404 PAGE_NOT_FOUND body, with no title, writing nothing', async () => {
    const { caller, pageId, workItemId } = await withWorld();
    const outsider = await memberCaller(caller, 'outsider', 'member', [...WORK_ITEM_EDITOR]);
    await adminDb.project.update({
      where: { id: caller.fixture.projectId },
      data: { accessMode: 'members' },
    });
    const before = await stored(pageId);
    const expected = JSON.stringify({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });

    for (const [name, call] of Object.entries(calls(caller, UNKNOWN_ID, workItemId))) {
      const res = await call();
      expect({ name, status: res.status, text: await res.text() }).toEqual({
        name,
        status: 404,
        text: expected,
      });
    }

    // The outsider, on every route, the same body — link and unlink resolve the
    // page before the work item's own gate (MOTIR-9579).
    for (const [name, call] of Object.entries(calls(outsider, pageId, workItemId))) {
      const res = await call();
      const text = await res.text();
      expect({ name, status: res.status, text }).toEqual({ name, status: 404, text: expected });
      expect(text).not.toContain(SECRET_TITLE);
    }
    expect(await stored(pageId)).toEqual(before);
    expect(await linkRows(pageId)).toBe(0);
  });

  it('no token and an invalid token are refused by the same /api/v1 auth path as GET page', async () => {
    const { pageId, workItemId } = await withWorld();
    const anonymous: Array<{ headers: Record<string, string> }> = [
      { headers: {} },
      { headers: { authorization: 'Bearer not-a-token' } },
    ];
    for (const who of anonymous) {
      const reference = await getPageV1(who, pageId);
      const expected = { status: reference.status, text: await reference.text() };
      expect(expected.status).toBe(401);
      for (const [name, call] of Object.entries(calls(who, pageId, workItemId))) {
        const res = await call();
        expect({ name, status: res.status, text: await res.text() }).toEqual({ name, ...expected });
      }
    }
  });
});

describe('the shipped service-only guard covers the four routes', () => {
  const REPO_ROOT = process.cwd();

  it('each new route file sits under a root the guard walks, and has no violation', () => {
    for (const file of NEW_ROUTE_FILES) {
      expect(
        PAGE_REST_ROOTS.some((root) => file.startsWith(`${root}/`)),
        file,
      ).toBe(true);
      expect(checkPageRestSource(file, readFileSync(join(REPO_ROOT, file), 'utf8'))).toEqual([]);
    }
  });

  it('each new route file with a database import planted is refused forbidden-import', () => {
    for (const file of NEW_ROUTE_FILES) {
      const planted = `import { db } from '@/lib/db';\n${readFileSync(join(REPO_ROOT, file), 'utf8')}`;
      expect(checkPageRestSource(file, planted), file).toEqual([
        expect.objectContaining({ file, rule: 'forbidden-import' }),
      ]);
    }
  });
});

describe('the published contract for the four operations', () => {
  const document = emitOpenApiDocument() as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const operations = {
    archivePage: ['/api/v1/pages/{pageId}/archive', 'post', ['403', '404', '409']],
    restorePage: ['/api/v1/pages/{pageId}/restore', 'post', ['403', '404', '409']],
    linkPageWorkItem: ['/api/v1/pages/{pageId}/work-items', 'post', ['403', '404', '409', '422']],
    unlinkPageWorkItem: [
      '/api/v1/pages/{pageId}/work-items/{workItemId}',
      'delete',
      ['403', '404'],
    ],
  } as const;

  it('each is published with its response schema and error responses; link carries a request body', () => {
    for (const [operationId, [path, method, errors]] of Object.entries(operations)) {
      const operation = document.paths[path]?.[method];
      expect(operation?.['operationId'], path).toBe(operationId);
      const responses = operation?.['responses'] as Record<string, Record<string, unknown>>;
      expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', ...errors]));
      expect(JSON.stringify(responses['200'])).toContain('schema');
    }
    expect(document.paths[operations.linkPageWorkItem[0]]?.['post']?.['requestBody']).toBeDefined();
  });

  it('the archive and restore descriptions say they take no revision', () => {
    for (const id of ['archivePage', 'restorePage'] as const) {
      const [path, method] = operations[id];
      expect(document.paths[path]?.[method]?.['description']).toContain('NO revision');
    }
  });

  it('dropping any of the four declarations is drift the OpenAPI coverage check reports', () => {
    const sources = new Map(
      v1RouteFiles(process.cwd())
        .filter((file) => NEW_ROUTE_FILES.some((route) => file === route.split('/').join(sep)))
        .map((file) => [file, readFileSync(join(process.cwd(), file), 'utf8')] as const),
    );
    expect(sources.size).toBe(4);
    const shipped = shippedRouteMethods(sources);
    const declared = PAGE_OPERATIONS.filter((op) => op.operationId in operations);
    expect(findSpecDrift(shipped, declared)).toEqual([]);
    for (const dropped of declared) {
      expect(
        findSpecDrift(
          shipped,
          declared.filter((op) => op !== dropped),
        ).length,
        dropped.operationId,
      ).toBeGreaterThan(0);
    }
  });
});
