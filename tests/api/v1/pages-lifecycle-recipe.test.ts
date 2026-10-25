import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import {
  type V1Page,
  type V1PageArchive,
  type V1PageLinkPair,
  type V1PageRestore,
} from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import type { TokenGrant } from '@/lib/tokens/grant';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  createV1ProjectCaller,
  type V1Caller,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import {
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

// The story's REST LIFECYCLE recipe, as ONE session (Story MOTIR-9488 ·
// MOTIR-9569). An integration developer's steps — archive, the archived
// refusals, restore, link (twice), link while archived, unlink (twice), a
// cross-project link, the refused callers and the published contract — run in
// order on one page and one work item against real Postgres, each step reading
// back what the step before it wrote through GET, the tree read or the link
// reads the app uses. The per-route matrices live in `pages-archive.test.ts`
// and `page-links.test.ts`; the seams in `pages-rest-lifecycle-gate.test.ts`.
//
// Step numbers are the AMENDED recipe's: archive takes no revision, so its
// "stale" step is the state conflicts PAGE_ARCHIVED / PAGE_NOT_ARCHIVED.

const RECIPE_GRANT: TokenGrant = ['page:view', 'page:edit', 'work_item:edit'];

const TITLE = 'Partner contract notes — restricted';
const BODY = '# Partner contract\n\nRenewal terms under negotiation.';

let owner: V1ProjectCaller;
let member: V1Caller;
let viewer: V1Caller;
let outsider: V1ProjectCaller;

// What the seed hands the steps.
let pageId: string;
let subPageId: string;
let workItemId: string;
let foreignWorkItemId: string;
let parkingPageId: string;

beforeAll(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "page_work_item_link", "page", "folder", "work_item_revision", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  resetRateLimitStore();

  owner = await createV1ProjectCaller({ permissions: RECIPE_GRANT });
  member = await memberCaller(owner, 'recipe', 'member', RECIPE_GRANT);
  viewer = await memberCaller(owner, 'viewer', 'member', RECIPE_GRANT);
  await adminDb.workspaceMembership.updateMany({
    where: { userId: viewer.user.id, workspaceId: owner.workspace.id },
    data: { workspaceRole: 'viewer' },
  });
  outsider = await createV1ProjectCaller({
    workspaceName: 'Elsewhere',
    identifier: 'ELS',
    permissions: RECIPE_GRANT,
  });

  const projectId = owner.fixture.projectId;
  pageId = (await pagesService.createPage(owner.ctx, { projectId, title: TITLE })).id;
  subPageId = (
    await pagesService.createPage(owner.ctx, {
      projectId,
      title: 'Renewal timeline',
      parent: { kind: 'page', id: pageId },
    })
  ).id;
  parkingPageId = (await pagesService.createPage(owner.ctx, { projectId, title: 'Archive shelf' }))
    .id;
  workItemId = (
    await workItemsService.createWorkItem(
      { projectId, kind: 'task', title: 'Countersign the renewal' },
      owner.ctx,
    )
  ).id;
  // A second project in the SAME workspace, and a work item in it.
  const other = await projectsService.createProject({
    workspaceId: owner.workspace.id,
    actorUserId: owner.user.id,
    name: 'Partner ops',
    identifier: 'OPS',
  });
  foreignWorkItemId = (
    await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'task', title: 'Elsewhere' },
      owner.ctx,
    )
  ).id;
});

afterAll(async () => {
  await adminDb.$disconnect();
});

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function read(): Promise<V1Page> {
  const res = await getPageV1(member, pageId);
  expect(res.status).toBe(200);
  return body<V1Page>(res);
}

async function rootTreeIds(): Promise<string[]> {
  const level = await pagesService.listTreeLevel(owner.ctx, {
    projectId: owner.fixture.projectId,
    parent: { kind: 'root' },
  });
  return level.rows.map((row) => row.id);
}

/** Does the page list the work item, and the work item the page, as the app reads them? */
async function sides() {
  const [items, pages] = await Promise.all([
    pageLinksService.listWorkItemsForPage(owner.ctx, {
      projectId: owner.fixture.projectId,
      pageId,
    }),
    pageLinksService.listPagesForWorkItem(owner.ctx, { workItemId }),
  ]);
  return {
    pageListsItem: items.rows.some((row) => JSON.stringify(row).includes(workItemId)),
    itemListsPage: pages.rows.some((row) => JSON.stringify(row).includes(pageId)),
  };
}

const linkRows = (forPage: string) =>
  adminDb.pageWorkItemLink.count({ where: { pageId: forPage } });

/** What a refusal must leave alone: the page as GET shows it, and its link rows. */
async function snapshot() {
  return { page: await read(), links: await linkRows(pageId) };
}

describe('the REST lifecycle recipe, in order', () => {
  it('step 1 — archive a page with one sub-page: the set answers, GET reports archivedAt, the tree loses it', async () => {
    expect(await rootTreeIds()).toContain(pageId);

    const res = await archivePageV1(member, pageId);
    expect(res.status).toBe(200);
    expect(await body<V1PageArchive>(res)).toEqual({
      archivedIds: [pageId, subPageId],
      rootId: pageId,
      subPageCount: 1,
    });

    const page = await read();
    expect(page.archivedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(page.archivedAt!))).toBe(false);
    expect(await rootTreeIds()).not.toContain(pageId);
  });

  it('step 2 — archive again, update and move are each 409 PAGE_ARCHIVED; GET shows title, body and revision unchanged', async () => {
    const before = await read();
    const attempts = {
      archive: await archivePageV1(member, pageId),
      update: await updatePageV1(member, pageId, { markdown: 'x', revision: before.revision }),
      move: await movePageV1(member, pageId, { parent: { kind: 'page', id: parkingPageId } }),
    };
    for (const [step, res] of Object.entries(attempts)) {
      expect({ step, status: res.status, code: (await body(res)).code }).toEqual({
        step,
        status: 409,
        code: 'PAGE_ARCHIVED',
      });
    }
    expect(await read()).toEqual(before);
  });

  it('step 3 — restore the archive root: the set and its landing answer; GET, an update and the tree see it live', async () => {
    const res = await restorePageV1(member, pageId);
    expect(res.status).toBe(200);
    const restored = await body<V1PageRestore>(res);
    expect([...restored.restoredIds].sort()).toEqual([pageId, subPageId].sort());
    expect(['original', 'ancestorPage', 'folder', 'root']).toContain(restored.landing.kind);

    const page = await read();
    expect(page.archivedAt).toBeNull();
    const saved = await updatePageV1(member, pageId, {
      markdown: `${BODY}\n\nRestored and editable.`,
      revision: page.revision,
    });
    expect(saved.status).toBe(200);
    expect((await read()).markdown).toContain('Restored and editable.');
    expect(await rootTreeIds()).toContain(pageId);
  });

  it('step 3 (the stale state) — restore a live page is PAGE_NOT_ARCHIVED; restore a non-root sub-page is PAGE_ARCHIVE_ROOT_REQUIRED', async () => {
    const live = await snapshot();
    const notArchived = await restorePageV1(member, pageId);
    expect(notArchived.status).toBe(409);
    expect((await body(notArchived)).code).toBe('PAGE_NOT_ARCHIVED');
    expect(await snapshot()).toEqual(live);

    expect((await archivePageV1(member, pageId)).status).toBe(200);
    const notRoot = await restorePageV1(member, subPageId);
    expect(notRoot.status).toBe(409);
    expect((await body(notRoot)).code).toBe('PAGE_ARCHIVE_ROOT_REQUIRED');
    expect((await read()).archivedAt).not.toBeNull();
    // Back to live for the steps that follow — restored through the root.
    expect((await restorePageV1(member, pageId)).status).toBe(200);
    expect((await read()).archivedAt).toBeNull();
  });

  it('step 4 — link a same-project work item, twice: the same pair both times, both sides list the other, one manual row', async () => {
    const first = await linkPageV1(member, pageId, { workItemId });
    expect(first.status).toBe(200);
    const pair = await body<V1PageLinkPair>(first);
    expect(pair).toEqual({ pageId, workItemId, source: 'manual' });

    const second = await linkPageV1(member, pageId, { workItemId });
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual(pair);

    expect(await sides()).toEqual({ pageListsItem: true, itemListsPage: true });
    expect(
      await adminDb.pageWorkItemLink.count({ where: { pageId, workItemId, source: 'manual' } }),
    ).toBe(1);
  });

  it('step 5 — unlink, twice: the pair answers and neither side lists the other; again is PAGE_LINK_NOT_FOUND', async () => {
    const res = await unlinkPageV1(member, pageId, workItemId);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ pageId, workItemId, source: 'manual' });
    expect(await sides()).toEqual({ pageListsItem: false, itemListsPage: false });
    expect(await linkRows(pageId)).toBe(0);

    const again = await unlinkPageV1(member, pageId, workItemId);
    expect(again.status).toBe(404);
    expect((await body(again)).code).toBe('PAGE_LINK_NOT_FOUND');
  });

  it('step 6 — link while archived is 409 PAGE_ARCHIVED with no row; after restore the same link succeeds', async () => {
    expect((await archivePageV1(member, pageId)).status).toBe(200);
    const refused = await linkPageV1(member, pageId, { workItemId });
    expect(refused.status).toBe(409);
    expect((await body(refused)).code).toBe('PAGE_ARCHIVED');
    expect(await linkRows(pageId)).toBe(0);

    expect((await restorePageV1(member, pageId)).status).toBe(200);
    const linked = await linkPageV1(member, pageId, { workItemId });
    expect(linked.status).toBe(200);
    expect(await sides()).toEqual({ pageListsItem: true, itemListsPage: true });
    expect(await linkRows(pageId)).toBe(1);
  });

  it('step 7 — link a work item of another project: 404 PAGE_NOT_FOUND, no row, no title', async () => {
    const res = await linkPageV1(member, pageId, { workItemId: foreignWorkItemId });
    const text = await res.text();
    expect(res.status).toBe(404);
    expect(JSON.parse(text).code).toBe('PAGE_NOT_FOUND');
    expect(text).not.toContain(TITLE);
    expect(await adminDb.pageWorkItemLink.count({ where: { workItemId: foreignWorkItemId } })).toBe(
      0,
    );
    expect(await linkRows(pageId)).toBe(1);
  });

  it('step 8 — a browse-only member is 403 on archive, restore, link and unlink, naming no page; nothing changes', async () => {
    expect((await getPageV1(viewer, pageId)).status).toBe(200);
    const before = await snapshot();
    const attempts = {
      archive: await archivePageV1(viewer, pageId),
      restore: await restorePageV1(viewer, pageId),
      link: await linkPageV1(viewer, pageId, { workItemId }),
      unlink: await unlinkPageV1(viewer, pageId, workItemId),
    };
    for (const [step, res] of Object.entries(attempts)) {
      const text = await res.text();
      expect({ step, status: res.status, code: JSON.parse(text).code }).toEqual({
        step,
        status: 403,
        code: 'PROJECT_ACCESS_DENIED',
      });
      expect(text).not.toContain(TITLE);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('step 8 — an unknown page id and a page the caller cannot browse answer one identical PAGE_NOT_FOUND, with no title', async () => {
    const before = await snapshot();
    const expected = JSON.stringify({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });
    const attempts = {
      'archive unknown': await archivePageV1(member, 'cmzzzzzzzzzzzzzzzzzzzzzzz'),
      'restore unknown': await restorePageV1(member, 'cmzzzzzzzzzzzzzzzzzzzzzzz'),
      'link unknown': await linkPageV1(member, 'cmzzzzzzzzzzzzzzzzzzzzzzz', { workItemId }),
      'archive unbrowsable': await archivePageV1(outsider, pageId),
      'restore unbrowsable': await restorePageV1(outsider, pageId),
      'link unbrowsable': await linkPageV1(outsider, pageId, { workItemId }),
      'unlink unbrowsable': await unlinkPageV1(outsider, pageId, workItemId),
    };
    for (const [step, res] of Object.entries(attempts)) {
      expect({ step, status: res.status, text: await res.text() }).toEqual({
        step,
        status: 404,
        text: expected,
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('no token and an invalid token are refused on all four routes exactly as GET page refuses them; nothing changes', async () => {
    const before = await snapshot();
    const anonymous: Array<{ headers: Record<string, string> }> = [
      { headers: {} },
      { headers: { authorization: 'Bearer not-a-token' } },
    ];
    for (const who of anonymous) {
      const reference = await getPageV1(who, pageId);
      const expected = { status: reference.status, text: await reference.text() };
      expect(expected.status).toBe(401);
      const attempts = {
        archive: await archivePageV1(who, pageId),
        restore: await restorePageV1(who, pageId),
        link: await linkPageV1(who, pageId, { workItemId }),
        unlink: await unlinkPageV1(who, pageId, workItemId),
      };
      for (const [step, res] of Object.entries(attempts)) {
        expect({ step, status: res.status, text: await res.text() }).toEqual({
          step,
          ...expected,
        });
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('step 9 — the published document carries all four operations, their parameters, schemas and refusals; archive takes no revision', () => {
    const document = emitOpenApiDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operations = [
      ['archivePage', '/api/v1/pages/{pageId}/archive', 'post', ['403', '404', '409']],
      ['restorePage', '/api/v1/pages/{pageId}/restore', 'post', ['403', '404', '409']],
      [
        'linkPageWorkItem',
        '/api/v1/pages/{pageId}/work-items',
        'post',
        ['403', '404', '409', '422'],
      ],
      [
        'unlinkPageWorkItem',
        '/api/v1/pages/{pageId}/work-items/{workItemId}',
        'delete',
        ['403', '404'],
      ],
    ] as const;
    for (const [operationId, path, method, errors] of operations) {
      const operation = document.paths[path]?.[method];
      expect(operation?.['operationId'], path).toBe(operationId);
      const parameters = JSON.stringify(operation?.['parameters'] ?? []);
      expect(parameters, operationId).toContain('"pageId"');
      const responses = operation?.['responses'] as Record<string, unknown>;
      expect(Object.keys(responses), operationId).toEqual(
        expect.arrayContaining(['200', ...errors]),
      );
      expect(JSON.stringify(responses['200']), operationId).toContain('schema');
    }
    expect(
      JSON.stringify(document.paths['/api/v1/pages/{pageId}/work-items/{workItemId}']?.['delete']),
    ).toContain('"workItemId"');
    expect(
      document.paths['/api/v1/pages/{pageId}/work-items']?.['post']?.['requestBody'],
    ).toBeDefined();
    expect(document.paths['/api/v1/pages/{pageId}/archive']?.['post']?.['description']).toContain(
      'NO revision',
    );
  });
});
