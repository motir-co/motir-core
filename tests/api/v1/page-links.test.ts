import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { pageLinkPairSchema, type V1PageLinkPair } from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import {
  PAGE_EDITOR,
  linkPageV1,
  memberCaller,
  unlinkPageV1,
} from '../../fixtures/apiV1PageFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The `/api/v1` page ↔ work-item HAND link (Story MOTIR-9488 · MOTIR-9567) —
// `POST /api/v1/pages/{pageId}/work-items` and `DELETE
// /api/v1/pages/{pageId}/work-items/{workItemId}`, end to end through
// `withV1Route` against real Postgres.
//
// What the card asks this file to prove, and where:
//   1  a link answers the pair and both sides list the other   → 'linking'
//   2  a second link is 200, one row                           → 'linking'
//   3  unlink clears both sides; again is PAGE_LINK_NOT_FOUND  → 'unlinking'
//   4  an archived page: link 409, unlink still works          → 'an archived page'
//   5  another project's page is PAGE_NOT_FOUND, no row, no title → 'who may link'
//   6  unknown page / unbrowsable / unknown item / 403s / 422   → 'who may link'
//   7  both operations in the published document               → 'the published contract'

const SECRET_TITLE = 'Pricing review — internal';

const WORK_ITEM_EDITOR = [...PAGE_EDITOR, 'work_item:edit'] as const;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "page_work_item_link", "page", "folder", "work_item_revision", "work_item" RESTART IDENTITY CASCADE',
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

/** A caller, one page and one work item in its project. */
async function withPair(): Promise<{
  caller: V1ProjectCaller;
  pageId: string;
  workItemId: string;
}> {
  const caller = await createV1ProjectCaller({ permissions: [...WORK_ITEM_EDITOR] });
  const page = await pagesService.createPage(caller.ctx, {
    projectId: caller.fixture.projectId,
    title: SECRET_TITLE,
  });
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title: 'Ship the pricing page' },
    caller.ctx,
  );
  return { caller, pageId: page.id, workItemId: item.id };
}

/** The pair's hand-link rows, read past RLS. */
const manualRows = (pageId: string, workItemId: string) =>
  adminDb.pageWorkItemLink.count({ where: { pageId, workItemId, source: 'manual' } });

/** Both sides of the link, as the app reads them. */
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

describe('linking', () => {
  it('answers the pair, and both the page’s work items and the work item’s pages list the other', async () => {
    const { caller, pageId, workItemId } = await withPair();

    const res = await linkPageV1(caller, pageId, { workItemId });
    expect(res.status).toBe(200);
    const pair = await body<V1PageLinkPair>(res);
    expect(pageLinkPairSchema.strict().safeParse(pair).success).toBe(true);
    expect(pair).toEqual({ pageId, workItemId, source: 'manual' });
    expect(await sides(caller, pageId, workItemId)).toEqual({
      pageListsItem: true,
      itemListsPage: true,
    });
  });

  it('is idempotent: a second link answers the same 200 and the table holds one manual row', async () => {
    const { caller, pageId, workItemId } = await withPair();
    const first = await linkPageV1(caller, pageId, { workItemId });
    const second = await linkPageV1(caller, pageId, { workItemId });
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual(await body(first));
    expect(await manualRows(pageId, workItemId)).toBe(1);
  });
});

describe('unlinking', () => {
  it('answers the pair and clears both sides; unlinking again is 404 PAGE_LINK_NOT_FOUND, never a 500', async () => {
    const { caller, pageId, workItemId } = await withPair();
    await linkPageV1(caller, pageId, { workItemId });

    const res = await unlinkPageV1(caller, pageId, workItemId);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ pageId, workItemId, source: 'manual' });
    expect(await manualRows(pageId, workItemId)).toBe(0);
    expect(await sides(caller, pageId, workItemId)).toEqual({
      pageListsItem: false,
      itemListsPage: false,
    });

    const again = await unlinkPageV1(caller, pageId, workItemId);
    expect(again.status).toBe(404);
    expect((await body(again)).code).toBe('PAGE_LINK_NOT_FOUND');
  });
});

describe('an archived page', () => {
  it('cannot be linked — 409 PAGE_ARCHIVED, no row', async () => {
    const { caller, pageId, workItemId } = await withPair();
    await pagesService.archivePage(caller.ctx, { projectId: caller.fixture.projectId, pageId });

    const res = await linkPageV1(caller, pageId, { workItemId });
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe('PAGE_ARCHIVED');
    expect(await manualRows(pageId, workItemId)).toBe(0);
  });

  it('keeps a link made before the archive removable', async () => {
    const { caller, pageId, workItemId } = await withPair();
    await linkPageV1(caller, pageId, { workItemId });
    await pagesService.archivePage(caller.ctx, { projectId: caller.fixture.projectId, pageId });

    const res = await unlinkPageV1(caller, pageId, workItemId);
    expect(res.status).toBe(200);
    expect(await manualRows(pageId, workItemId)).toBe(0);
  });
});

describe('who may link', () => {
  it('a page of another project than the work item is 404 PAGE_NOT_FOUND — the unknown page’s body, no title, no row', async () => {
    const { caller, workItemId } = await withPair();
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

    const unknown = await linkPageV1(caller, 'cmzzzzzzzzzzzzzzzzzzzzzzz', { workItemId });
    const expected = { status: unknown.status, text: await unknown.text() };
    expect(expected.status).toBe(404);
    expect(JSON.parse(expected.text)).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });

    const cross = await linkPageV1(caller, otherPage.id, { workItemId });
    expect({ status: cross.status, text: await cross.text() }).toEqual(expected);
    expect(await manualRows(otherPage.id, workItemId)).toBe(0);

    const crossUnlink = await unlinkPageV1(caller, otherPage.id, workItemId);
    expect({ status: crossUnlink.status, text: await crossUnlink.text() }).toEqual(expected);
  });

  it('an unknown work item is 404 WORK_ITEM_NOT_FOUND on both routes', async () => {
    const { caller, pageId } = await withPair();
    const link = await linkPageV1(caller, pageId, { workItemId: 'cmzzzzzzzzzzzzzzzzzzzzzzz' });
    const unlink = await unlinkPageV1(caller, pageId, 'cmzzzzzzzzzzzzzzzzzzzzzzz');
    for (const res of [link, unlink]) {
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text).code).toBe('WORK_ITEM_NOT_FOUND');
      expect(text).not.toContain(SECRET_TITLE);
    }
  });

  it('a caller who cannot browse the project gets a not-found that names no page, and nothing is written', async () => {
    const { caller, pageId, workItemId } = await withPair();
    const outsider = await memberCaller(caller, 'outsider', 'member', [...WORK_ITEM_EDITOR]);
    await adminDb.project.update({
      where: { id: caller.fixture.projectId },
      data: { accessMode: 'members' },
    });
    for (const res of [
      await linkPageV1(outsider, pageId, { workItemId }),
      await unlinkPageV1(outsider, pageId, workItemId),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(SECRET_TITLE);
    }
    expect(await manualRows(pageId, workItemId)).toBe(0);
  });

  it('a token without page:edit and a user without work_item:edit are 403, naming no page, writing nothing', async () => {
    const { caller, pageId, workItemId } = await withPair();
    const noPageEdit = await memberCaller(caller, 'reader', 'member', [
      'project:browse',
      'page:view',
      'work_item:edit',
    ]);
    const viewer = await memberCaller(caller, 'viewer', 'member', [...WORK_ITEM_EDITOR]);
    await adminDb.workspaceMembership.updateMany({
      where: { userId: viewer.user.id, workspaceId: caller.workspace.id },
      data: { workspaceRole: 'viewer' },
    });

    for (const who of [noPageEdit, viewer]) {
      for (const res of [
        await linkPageV1(who, pageId, { workItemId }),
        await unlinkPageV1(who, pageId, workItemId),
      ]) {
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain(SECRET_TITLE);
      }
    }
    expect(await manualRows(pageId, workItemId)).toBe(0);
  });

  it('a missing, empty or non-string workItemId, or a body that is not JSON, is 422 and writes nothing', async () => {
    const { caller, pageId, workItemId } = await withPair();
    for (const sent of [
      '{not json',
      {},
      { workItemId: '' },
      { workItemId: 7 },
      { workItemId: null },
    ]) {
      const res = await linkPageV1(caller, pageId, sent);
      expect(res.status, JSON.stringify(sent)).toBe(422);
    }
    expect(await manualRows(pageId, workItemId)).toBe(0);
  });

  it('a request without a valid API token is refused by the v1 auth path', async () => {
    const { pageId, workItemId } = await withPair();
    const anonymous = { headers: { authorization: 'Bearer not-a-token' } };
    expect((await linkPageV1(anonymous, pageId, { workItemId })).status).toBe(401);
    expect((await unlinkPageV1(anonymous, pageId, workItemId)).status).toBe(401);
  });
});

describe('the published contract', () => {
  const document = emitOpenApiDocument() as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { schemas: Record<string, unknown> };
  };

  it('publishes linkPageWorkItem and unlinkPageWorkItem with page:edit and their refusals', () => {
    const link = document.paths['/api/v1/pages/{pageId}/work-items']?.['post'];
    const unlink = document.paths['/api/v1/pages/{pageId}/work-items/{workItemId}']?.['delete'];
    expect(link?.['operationId']).toBe('linkPageWorkItem');
    expect(unlink?.['operationId']).toBe('unlinkPageWorkItem');
    for (const operation of [link, unlink]) {
      expect(operation?.['x-motir-permission']).toBe('page:edit');
    }
    expect(link?.['requestBody']).toBeDefined();
    expect(Object.keys(link?.['responses'] as object)).toEqual(
      expect.arrayContaining(['200', '403', '404', '409', '422']),
    );
    expect(Object.keys(unlink?.['responses'] as object)).toEqual(
      expect.arrayContaining(['200', '403', '404']),
    );
    expect(link?.['description']).toContain('IDEMPOTENT');
    expect(link?.['description']).toContain('PAGE_ARCHIVED');
    expect(unlink?.['description']).toContain('PAGE_LINK_NOT_FOUND');
    expect(document.components.schemas['PageLinkPair']).toBeDefined();
  });
});
