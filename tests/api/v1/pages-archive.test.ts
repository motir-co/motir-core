import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  pageArchiveResultSchema,
  pageRestoreResultSchema,
  pageSchema,
  type V1Page,
  type V1PageArchive,
  type V1PageRestore,
} from '@/lib/api/v1/pages/schema';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import {
  PAGE_EDITOR,
  archivePageV1,
  getPageV1,
  memberCaller,
  movePageV1,
  restorePageV1,
  updatePageV1,
} from '../../fixtures/apiV1PageFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The `/api/v1` PAGE archive and restore (Story MOTIR-9488 · MOTIR-9566) —
// `POST /api/v1/pages/{pageId}/archive` and `/restore`, end to end through
// `withV1Route` against real Postgres.
//
// What the card asks this file to prove, and where:
//   1  archive answers the set; a GET reports `archivedAt`; the tree loses it
//                                                     → 'archiving a page'
//   2  restore answers the set and its landing; the page is editable again and
//      a GET reports `archivedAt: null`               → 'restoring a page'
//   3  PAGE_ARCHIVED / PAGE_NOT_ARCHIVED / PAGE_ARCHIVE_ROOT_REQUIRED, each 409
//      and each leaving the state alone              → 'refused by the page’s state'
//   4  an archived page cannot be updated or moved    → 'refused by the page’s state'
//   5  unknown / foreign / unbrowsable is one 404 with no title; no page:edit 403
//                                                     → 'who may archive and restore'
//   6  both in the published document, no revision, 403/404/409, archivedAt on getPage
//                                                     → 'the published contract'

const SECRET_TITLE = 'Acquisition shortlist — confidential';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "page", "folder" RESTART IDENTITY CASCADE');
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

/** A caller, a page and one sub-page under it. */
async function withPages(): Promise<{ caller: V1ProjectCaller; pageId: string; childId: string }> {
  const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
  const page = await pagesService.createPage(caller.ctx, {
    projectId: caller.fixture.projectId,
    title: SECRET_TITLE,
  });
  const child = await pagesService.createPage(caller.ctx, {
    projectId: caller.fixture.projectId,
    title: 'Child notes',
    parent: { kind: 'page', id: page.id },
  });
  return { caller, pageId: page.id, childId: child.id };
}

/** The stored archive state, read past RLS — what a refusal must leave untouched. */
const stored = (id: string) =>
  adminDb.page.findUniqueOrThrow({
    where: { id },
    select: { archivedAt: true, archiveRootId: true, parentPageId: true, revision: true },
  });

/** The ids the app's tree shows at the project root. */
async function rootTreeIds(caller: V1ProjectCaller): Promise<string[]> {
  const level = await pagesService.listTreeLevel(caller.ctx, {
    projectId: caller.fixture.projectId,
    parent: { kind: 'root' },
  });
  return level.rows.map((row) => row.id);
}

describe('archiving a page', () => {
  it('answers the set root first, a following GET reports archivedAt, and the tree no longer shows it', async () => {
    const { caller, pageId, childId } = await withPages();
    expect(await rootTreeIds(caller)).toContain(pageId);
    expect((await body<V1Page>(await getPageV1(caller, pageId))).archivedAt).toBeNull();

    const res = await archivePageV1(caller, pageId);
    expect(res.status).toBe(200);
    const archived = await body<V1PageArchive>(res);
    expect(pageArchiveResultSchema.strict().safeParse(archived).success).toBe(true);
    expect(archived).toEqual({ archivedIds: [pageId, childId], rootId: pageId, subPageCount: 1 });

    const read = await getPageV1(caller, pageId);
    expect(read.status).toBe(200);
    const page = await body<V1Page>(read);
    expect(pageSchema.safeParse(page).success).toBe(true);
    const row = await stored(pageId);
    expect(page.archivedAt).toBe(row.archivedAt!.toISOString());
    expect(await rootTreeIds(caller)).not.toContain(pageId);
  });
});

describe('restoring a page', () => {
  it('answers the restored set and where it landed; the page is readable and updatable again', async () => {
    const { caller, pageId, childId } = await withPages();
    await archivePageV1(caller, pageId);

    const res = await restorePageV1(caller, pageId);
    expect(res.status).toBe(200);
    const restored = await body<V1PageRestore>(res);
    expect(pageRestoreResultSchema.safeParse(restored).success).toBe(true);
    expect([...restored.restoredIds].sort()).toEqual([pageId, childId].sort());
    expect(restored.landing).toEqual({
      kind: 'original',
      parentPageId: null,
      folderId: null,
      title: null,
    });
    expect(JSON.stringify(restored)).not.toContain(SECRET_TITLE);

    const page = await body<V1Page>(await getPageV1(caller, pageId));
    expect(page.archivedAt).toBeNull();
    expect(await rootTreeIds(caller)).toContain(pageId);
    const saved = await updatePageV1(caller, pageId, {
      markdown: 'Back in use.',
      revision: page.revision,
    });
    expect(saved.status).toBe(200);
  });

  it('names the landing parent — never the restored page — when it lands under a page', async () => {
    const { caller, pageId, childId } = await withPages();
    await pagesService.renamePage(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId: childId,
      title: SECRET_TITLE + ' (child)',
    });
    await archivePageV1(caller, childId);

    const restored = await body<V1PageRestore>(await restorePageV1(caller, childId));
    expect(restored.landing).toMatchObject({ kind: 'original', parentPageId: pageId });
    expect(restored.landing.title).toBe(SECRET_TITLE);
  });
});

describe('refused by the page’s state', () => {
  it('archiving an archived page — or a sub-page of an archived set — is 409 PAGE_ARCHIVED, unchanged', async () => {
    const { caller, pageId, childId } = await withPages();
    await archivePageV1(caller, pageId);

    for (const id of [pageId, childId]) {
      const before = await stored(id);
      const res = await archivePageV1(caller, id);
      expect(res.status, id).toBe(409);
      expect((await body(res)).code).toBe('PAGE_ARCHIVED');
      expect(await stored(id)).toEqual(before);
    }
  });

  it('restoring a live page is 409 PAGE_NOT_ARCHIVED, unchanged', async () => {
    const { caller, pageId } = await withPages();
    const before = await stored(pageId);
    const res = await restorePageV1(caller, pageId);
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe('PAGE_NOT_ARCHIVED');
    expect(await stored(pageId)).toEqual(before);
  });

  it('restoring a sub-page that left with its root is 409 PAGE_ARCHIVE_ROOT_REQUIRED, unchanged', async () => {
    const { caller, pageId, childId } = await withPages();
    await archivePageV1(caller, pageId);
    const before = await stored(childId);
    const res = await restorePageV1(caller, childId);
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe('PAGE_ARCHIVE_ROOT_REQUIRED');
    expect(await stored(childId)).toEqual(before);
  });

  it('an archived page cannot be updated or moved — each refusal names PAGE_ARCHIVED', async () => {
    const { caller, pageId } = await withPages();
    await archivePageV1(caller, pageId);
    const before = await stored(pageId);

    const update = await updatePageV1(caller, pageId, { markdown: 'x', revision: before.revision });
    const move = await movePageV1(caller, pageId, { parent: { kind: 'root' } });
    for (const res of [update, move]) {
      expect(res.status).toBe(409);
      expect((await body(res)).code).toBe('PAGE_ARCHIVED');
    }
    expect(await stored(pageId)).toEqual(before);
  });

  it('takes no body and no revision: a request with one is answered the same', async () => {
    const { caller, pageId } = await withPages();
    const res = await archivePageV1(
      { headers: { ...caller.headers, 'content-type': 'application/json' } },
      pageId,
    );
    expect(res.status).toBe(200);
  });
});

describe('who may archive and restore', () => {
  it('an unknown id, another project’s page and a page in a project the caller cannot browse are one 404 with no title', async () => {
    const { caller } = await withPages();
    const other = await projectsService.createProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      name: 'Other',
      identifier: 'OTH',
    });
    const otherPage = await pagesService.createPage(caller.ctx, {
      projectId: other.id,
      title: SECRET_TITLE,
    });
    const member = await memberCaller(caller, 'outsider', 'member');
    const ownPage = await pagesService.createPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      title: SECRET_TITLE,
    });
    await adminDb.project.update({
      where: { id: caller.fixture.projectId },
      data: { accessMode: 'members' },
    });

    for (const call of [archivePageV1, restorePageV1]) {
      const unknown = await call(caller, 'cmzzzzzzzzzzzzzzzzzzzzzzz');
      const expected = { status: unknown.status, text: await unknown.text() };
      expect(expected.status).toBe(404);
      expect(JSON.parse(expected.text)).toEqual({
        code: 'PAGE_NOT_FOUND',
        error: 'Page not found.',
      });
      for (const [who, pageId] of [
        [caller, otherPage.id],
        [member, ownPage.id],
      ] as const) {
        const before = await stored(pageId);
        const res = await call(who, pageId);
        expect({ status: res.status, text: await res.text() }).toEqual(expected);
        expect(await stored(pageId)).toEqual(before);
      }
    }
  });

  it('a member demoted to Viewer is 403 PROJECT_ACCESS_DENIED, and a token without page:edit is 403 — no title, nothing written', async () => {
    const { caller, pageId } = await withPages();
    const member = await memberCaller(caller, 'demoted', 'member');
    await adminDb.workspaceMembership.updateMany({
      where: { userId: member.user.id, workspaceId: caller.workspace.id },
      data: { workspaceRole: 'viewer' },
    });
    const readOnly = await memberCaller(caller, 'reader', 'member', [
      'project:browse',
      'page:view',
    ]);

    // Restore needs an archived page to be refused on permission rather than state.
    const archived = await pagesService.createPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      title: SECRET_TITLE,
    });
    await pagesService.archivePage(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId: archived.id,
    });

    for (const [call, id] of [
      [archivePageV1, pageId],
      [restorePageV1, archived.id],
    ] as const) {
      const before = await stored(id);
      const demoted = await call(member, id);
      expect(demoted.status).toBe(403);
      const text = await demoted.text();
      expect(JSON.parse(text).code).toBe('PROJECT_ACCESS_DENIED');
      expect(text).not.toContain(SECRET_TITLE);

      const narrowed = await call(readOnly, id);
      expect(narrowed.status).toBe(403);
      expect(await narrowed.text()).not.toContain(SECRET_TITLE);
      expect(await stored(id)).toEqual(before);
    }
  });

  it('a request without a valid API token is refused by the v1 auth path', async () => {
    const { pageId } = await withPages();
    for (const call of [archivePageV1, restorePageV1]) {
      const res = await call({ headers: { authorization: 'Bearer not-a-token' } }, pageId);
      expect(res.status).toBe(401);
    }
  });
});

describe('the published contract', () => {
  const document = emitOpenApiDocument() as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };

  it('publishes archivePage and restorePage with page:edit, no body, and their 403/404/409', () => {
    for (const [path, operationId] of [
      ['/api/v1/pages/{pageId}/archive', 'archivePage'],
      ['/api/v1/pages/{pageId}/restore', 'restorePage'],
    ] as const) {
      const operation = document.paths[path]?.['post'];
      expect(operation?.['operationId']).toBe(operationId);
      expect(operation?.['x-motir-permission']).toBe('page:edit');
      expect(operation?.['requestBody']).toBeUndefined();
      expect(Object.keys(operation?.['responses'] as object)).toEqual(
        expect.arrayContaining(['200', '403', '404', '409']),
      );
      expect(operation?.['description']).toContain('NO revision');
    }
    expect(document.paths['/api/v1/pages/{pageId}/archive']?.['post']?.['description']).toContain(
      'PAGE_ARCHIVED',
    );
    const restore = document.paths['/api/v1/pages/{pageId}/restore']?.['post']?.['description'];
    expect(restore).toContain('PAGE_NOT_ARCHIVED');
    expect(restore).toContain('PAGE_ARCHIVE_ROOT_REQUIRED');
    expect(document.components.schemas['PageArchive']).toBeDefined();
    expect(document.components.schemas['PageRestore']).toBeDefined();
  });

  it('the published Page carries archivedAt', () => {
    expect(document.components.schemas['Page']?.properties).toHaveProperty('archivedAt');
  });
});
