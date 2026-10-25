import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_DEPTH_LIMIT } from '@/lib/pages';
import {
  pagePlacementResultSchema,
  type V1Page,
  type V1PagePlacement,
} from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { PAGE_EDITOR, getPageV1, memberCaller, movePageV1 } from '../../fixtures/apiV1PageFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The `/api/v1` PAGE move (Story MOTIR-9486 · MOTIR-9495) — `PATCH
// /api/v1/pages/{pageId}/placement`, end to end through `withV1Route` against
// real Postgres.
//
// What the card asks this file to prove, and where:
//   1  under a page / into a folder / to the root, with the subtree, and a GET
//      shows it                                        → 'moving a page'
//   2  beforeId / afterId land it between siblings; a bad neighbour is 422
//                                                      → 'neighbours'
//   3  every tree refusal by name, nothing moved        → 'refused moves'
//   4  a move to the current place writes nothing        → 'moving a page'
//   5  no page:edit 403; unknown / foreign / unbrowsable one 404, no title
//                                                      → 'who may move'
//   6  a malformed body is refused                       → 'a malformed body'

const SECRET_TITLE = 'Layoff plan — restricted';

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

async function pageCaller(): Promise<V1ProjectCaller> {
  return createV1ProjectCaller({ permissions: PAGE_EDITOR });
}

/** Seed a page through the service, at the root or under a page / folder. */
async function seed(
  caller: V1ProjectCaller,
  title: string,
  parent?: { kind: 'page' | 'folder'; id: string },
): Promise<string> {
  const page = await pagesService.createPage(caller.ctx, {
    projectId: caller.fixture.projectId,
    title,
    ...(parent ? { parent } : {}),
  });
  return page.id;
}

/** Every page row's placement in the project, keyed by id — what a refusal must leave alone. */
async function placements(projectId: string) {
  const rows = await adminDb.page.findMany({
    where: { projectId },
    select: { id: true, parentPageId: true, folderId: true, position: true },
    orderBy: { id: 'asc' },
  });
  return rows;
}

/** The child titles of a page, in tree order. */
async function childTitles(caller: V1ProjectCaller, parentPageId: string) {
  const rows = await adminDb.page.findMany({
    where: { projectId: caller.fixture.projectId, parentPageId },
    select: { title: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => r.title);
}

describe('moving a page', () => {
  it('moves a page with its subtree under a page, into a folder and back to the root', async () => {
    const caller = await pageCaller();
    const target = await seed(caller, 'Target');
    const moving = await seed(caller, 'Moving');
    const child = await seed(caller, 'Child', { kind: 'page', id: moving });
    const folder = await foldersService.createFolder(
      { projectId: caller.fixture.projectId, parentFolderId: null, name: 'Docs' },
      caller.ctx,
    );

    const under = await movePageV1(caller, moving, { parent: { kind: 'page', id: target } });
    expect(under.status).toBe(200);
    const placed = await body<V1PagePlacement>(under);
    expect(pagePlacementResultSchema.safeParse(placed).success).toBe(true);
    expect(placed).toMatchObject({
      id: moving,
      parent: { kind: 'page', id: target },
      ancestorPageIds: [target],
      moved: true,
    });
    // The subtree came along: the child's ancestors now run through the target.
    const childRow = await adminDb.page.findUniqueOrThrow({ where: { id: child } });
    expect(childRow.parentPageId).toBe(moving);
    expect((await body<V1Page>(await getPageV1(caller, moving))).placement).toEqual({
      parentPageId: target,
      folderId: null,
    });

    const intoFolder = await movePageV1(caller, moving, {
      parent: { kind: 'folder', id: folder.id },
    });
    expect(intoFolder.status).toBe(200);
    expect((await body<V1PagePlacement>(intoFolder)).parent).toEqual({
      kind: 'folder',
      id: folder.id,
    });
    expect((await body<V1Page>(await getPageV1(caller, moving))).placement).toEqual({
      parentPageId: null,
      folderId: folder.id,
    });

    const toRoot = await movePageV1(caller, moving, { parent: { kind: 'root' } });
    expect(toRoot.status).toBe(200);
    expect(await body(toRoot)).toMatchObject({ parent: { kind: 'root' }, ancestorPageIds: [] });
    expect((await body<V1Page>(await getPageV1(caller, moving))).placement).toEqual({
      parentPageId: null,
      folderId: null,
    });
  });

  it('a move to where the page already is answers moved: false and writes nothing', async () => {
    const caller = await pageCaller();
    const parent = await seed(caller, 'Parent');
    const page = await seed(caller, 'Page', { kind: 'page', id: parent });
    const before = await placements(caller.fixture.projectId);

    const res = await movePageV1(caller, page, { parent: { kind: 'page', id: parent } });
    expect(res.status).toBe(200);
    expect((await body(res)).moved).toBe(false);
    expect(await placements(caller.fixture.projectId)).toEqual(before);
  });
});

describe('neighbours', () => {
  it('beforeId / afterId land the page between two siblings at the destination', async () => {
    const caller = await pageCaller();
    const parent = await seed(caller, 'Parent');
    const a = await seed(caller, 'A', { kind: 'page', id: parent });
    const c = await seed(caller, 'C', { kind: 'page', id: parent });
    const b = await seed(caller, 'B');

    const res = await movePageV1(caller, b, {
      parent: { kind: 'page', id: parent },
      beforeId: a,
      afterId: c,
    });
    expect(res.status).toBe(200);
    expect(await childTitles(caller, parent)).toEqual(['A', 'B', 'C']);
  });

  it('a neighbour that is the page itself or not at the destination is 422 PAGE_NEIGHBOUR_INVALID and nothing moves', async () => {
    const caller = await pageCaller();
    const parent = await seed(caller, 'Parent');
    await seed(caller, 'A', { kind: 'page', id: parent });
    const stranger = await seed(caller, 'Elsewhere');
    const moving = await seed(caller, 'Moving');
    const before = await placements(caller.fixture.projectId);

    for (const neighbour of [{ beforeId: moving }, { afterId: stranger }]) {
      const res = await movePageV1(caller, moving, {
        parent: { kind: 'page', id: parent },
        ...neighbour,
      });
      expect(res.status, JSON.stringify(neighbour)).toBe(422);
      expect((await body(res)).code).toBe('PAGE_NEIGHBOUR_INVALID');
    }
    expect(await placements(caller.fixture.projectId)).toEqual(before);
  });
});

describe('refused moves', () => {
  it('under itself or one of its own descendants is 422 PAGE_CYCLE, and nothing moves', async () => {
    const caller = await pageCaller();
    const top = await seed(caller, 'Top');
    const mid = await seed(caller, 'Mid', { kind: 'page', id: top });
    const leaf = await seed(caller, 'Leaf', { kind: 'page', id: mid });
    const before = await placements(caller.fixture.projectId);

    for (const target of [top, mid, leaf]) {
      const res = await movePageV1(caller, top, { parent: { kind: 'page', id: target } });
      expect(res.status, target).toBe(422);
      expect((await body(res)).code).toBe('PAGE_CYCLE');
    }
    expect(await placements(caller.fixture.projectId)).toEqual(before);
  });

  it('a parent page or folder in another project is refused by name, and nothing moves', async () => {
    const caller = await pageCaller();
    const other = await projectsService.createProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      name: 'Other',
      identifier: 'OTH',
    });
    const foreignPage = await pagesService.createPage(caller.ctx, {
      projectId: other.id,
      title: SECRET_TITLE,
    });
    const foreignFolder = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      caller.ctx,
    );
    const moving = await seed(caller, 'Moving');
    const before = await placements(caller.fixture.projectId);

    // The move runs narrowed to the moving page's project, so the other
    // project's rows are invisible: each is refused as its own not-found, which
    // never confirms it exists.
    for (const [parent, code] of [
      [{ kind: 'page', id: foreignPage.id }, 'PAGE_NOT_FOUND'],
      [{ kind: 'folder', id: foreignFolder.id }, 'FOLDER_NOT_FOUND'],
    ] as const) {
      const res = await movePageV1(caller, moving, { parent });
      const text = await res.text();
      expect(res.status, text).toBe(404);
      expect(JSON.parse(text).code).toBe(code);
      expect(text).not.toContain(SECRET_TITLE);
    }
    expect(await placements(caller.fixture.projectId)).toEqual(before);
  });

  it('an archived parent page is 422 PAGE_PARENT_ARCHIVED; an archived page is 409 PAGE_ARCHIVED', async () => {
    const caller = await pageCaller();
    const archivedParent = await seed(caller, 'Old parent');
    const archivedPage = await seed(caller, 'Old page');
    const moving = await seed(caller, 'Moving');
    for (const pageId of [archivedParent, archivedPage]) {
      await pagesService.archivePage(caller.ctx, { projectId: caller.fixture.projectId, pageId });
    }
    const before = await placements(caller.fixture.projectId);

    const underArchive = await movePageV1(caller, moving, {
      parent: { kind: 'page', id: archivedParent },
    });
    expect(underArchive.status).toBe(422);
    expect((await body(underArchive)).code).toBe('PAGE_PARENT_ARCHIVED');

    const ofArchive = await movePageV1(caller, archivedPage, {
      parent: { kind: 'page', id: moving },
    });
    expect(ofArchive.status).toBe(409);
    expect((await body(ofArchive)).code).toBe('PAGE_ARCHIVED');

    expect(await placements(caller.fixture.projectId)).toEqual(before);
  });

  it('a parent kind the tree does not take is 422 PAGE_PARENT_NOT_ALLOWED', async () => {
    const caller = await pageCaller();
    const moving = await seed(caller, 'Moving');
    const res = await movePageV1(caller, moving, { parent: { kind: 'work_item', id: 'x' } });
    expect(res.status).toBe(422);
    expect((await body(res)).code).toBe('PAGE_PARENT_NOT_ALLOWED');
  });

  it('nesting past the depth limit is 422 PAGE_DEPTH_EXCEEDED, naming the limit and the level', async () => {
    const caller = await pageCaller();
    // A chain exactly PAGE_DEPTH_LIMIT deep, then one more page to put under its deepest.
    let parent: string | undefined;
    for (let level = 1; level <= PAGE_DEPTH_LIMIT; level += 1) {
      parent = await seed(
        caller,
        `Level ${level}`,
        parent ? { kind: 'page', id: parent } : undefined,
      );
    }
    const moving = await seed(caller, 'Too deep');
    const before = await placements(caller.fixture.projectId);

    const res = await movePageV1(caller, moving, { parent: { kind: 'page', id: parent! } });
    expect(res.status).toBe(422);
    const refusal = await body<{ code: string; error: string }>(res);
    expect(refusal.code).toBe('PAGE_DEPTH_EXCEEDED');
    expect(refusal.error).toContain(String(PAGE_DEPTH_LIMIT));
    expect(refusal.error).toContain(String(PAGE_DEPTH_LIMIT + 1));
    expect(await placements(caller.fixture.projectId)).toEqual(before);
  });
});

describe('who may move', () => {
  it('an unknown id, another project’s page and a page in a project the caller cannot browse are the same 404', async () => {
    const caller = await pageCaller();
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
    const ownPage = await seed(caller, SECRET_TITLE);
    await adminDb.project.update({
      where: { id: caller.fixture.projectId },
      data: { accessMode: 'members' },
    });

    const unknown = await movePageV1(caller, 'cmzzzzzzzzzzzzzzzzzzzzzzz', {
      parent: { kind: 'root' },
    });
    const expected = { status: unknown.status, text: await unknown.text() };
    expect(expected.status).toBe(404);
    expect(JSON.parse(expected.text)).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });

    for (const [who, pageId] of [
      [caller, otherPage.id],
      [member, ownPage],
    ] as const) {
      const res = await movePageV1(who, pageId, { parent: { kind: 'root' } });
      expect({ status: res.status, text: await res.text() }).toEqual(expected);
    }
  });

  it('a member demoted to Viewer is 403 PROJECT_ACCESS_DENIED; a token without page:edit is 403 — nothing moves', async () => {
    const caller = await pageCaller();
    const parent = await seed(caller, 'Parent');
    const page = await seed(caller, SECRET_TITLE);
    const member = await memberCaller(caller, 'demoted', 'member');
    await adminDb.workspaceMembership.updateMany({
      where: { userId: member.user.id, workspaceId: caller.workspace.id },
      data: { workspaceRole: 'viewer' },
    });
    const readOnly = await memberCaller(caller, 'reader', 'member', [
      'project:browse',
      'page:view',
    ]);
    const before = await placements(caller.fixture.projectId);
    const move = { parent: { kind: 'page', id: parent } };

    const demoted = await movePageV1(member, page, move);
    expect(demoted.status).toBe(403);
    const text = await demoted.text();
    expect(JSON.parse(text).code).toBe('PROJECT_ACCESS_DENIED');
    expect(text).not.toContain(SECRET_TITLE);

    const narrowed = await movePageV1(readOnly, page, move);
    expect(narrowed.status).toBe(403);
    expect(await narrowed.text()).not.toContain(SECRET_TITLE);

    expect(await placements(caller.fixture.projectId)).toEqual(before);
  });
});

describe('a malformed body', () => {
  it('bad JSON, no parent, a parent with no id, or a non-string neighbour is 422 INVALID_BODY and nothing moves', async () => {
    const caller = await pageCaller();
    const moving = await seed(caller, 'Moving');
    const before = await placements(caller.fixture.projectId);
    const cases: unknown[] = [
      '{not json',
      {},
      { parent: 'root' },
      { parent: { kind: 'page' } },
      { parent: { kind: 'root' }, beforeId: 7 },
      { parent: { kind: 'root' }, afterId: '' },
      { parent: { kind: 'root' }, extra: true },
    ];
    for (const sent of cases) {
      const res = await movePageV1(caller, moving, sent);
      expect(res.status, JSON.stringify(sent)).toBe(422);
      expect((await body(res)).code).toBe('INVALID_BODY');
    }
    expect(await placements(caller.fixture.projectId)).toEqual(before);
  });
});
