import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { pageSchema, type V1Page } from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import {
  PAGE_EDITOR,
  createPageV1,
  getPageV1,
  memberCaller,
  movePageV1,
  updatePageV1,
} from '../../fixtures/apiV1PageFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The PAGE story gate (Story MOTIR-9486 · MOTIR-9496) — the seams BETWEEN the
// four `/api/v1` page routes, each step's output fed into the next and read back
// with GET. The per-route suites prove each route alone; this file proves they
// compose: what create returns is what read returns, a save's revision is the
// one the next save states, a move never touches the body, and a refusal on any
// route leaves the page exactly as GET last showed it.

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

async function read(caller: V1ProjectCaller, pageId: string): Promise<V1Page> {
  const res = await getPageV1(caller, pageId);
  expect(res.status).toBe(200);
  return body<V1Page>(res);
}

async function created(
  caller: V1ProjectCaller,
  input: { title: string; markdown?: string; parent?: unknown },
): Promise<V1Page> {
  const res = await createPageV1(caller, caller.projectKey, input);
  expect(res.status).toBe(201);
  return body<V1Page>(res);
}

describe('create → read', () => {
  it('GET returns exactly what create returned', async () => {
    const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const page = await created(caller, { title: SECRET_TITLE, markdown: '# Plan\n\n- one' });
    expect(pageSchema.safeParse(page).success).toBe(true);
    expect(await read(caller, page.id)).toEqual(page);
  });
});

describe('update → read', () => {
  it('GET returns the saved body and revision; a stale revision after it is 409 and GET is unchanged', async () => {
    const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const page = await created(caller, { title: SECRET_TITLE, markdown: 'First.' });

    const saved = await body<V1Page>(
      await updatePageV1(caller, page.id, { markdown: 'Second.', revision: page.revision }),
    );
    const afterSave = await read(caller, page.id);
    expect(afterSave).toEqual(saved);
    expect(afterSave.markdown).toContain('Second.');

    const stale = await updatePageV1(caller, page.id, {
      markdown: 'Written against the first revision.',
      revision: page.revision,
    });
    expect(stale.status).toBe(409);
    expect((await body(stale)).code).toBe('PAGE_REVISION_CONFLICT');
    expect(await read(caller, page.id)).toEqual(afterSave);
  });
});

describe('move → read', () => {
  it('three moves in a row: GET shows each new place, and the body never changes', async () => {
    const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const parent = await created(caller, { title: 'Parent' });
    const folder = await foldersService.createFolder(
      { projectId: caller.fixture.projectId, parentFolderId: null, name: 'Shelf' },
      caller.ctx,
    );
    const page = await created(caller, { title: SECRET_TITLE, markdown: 'Body stays.' });

    const destinations = [
      [
        { kind: 'page', id: parent.id },
        { parentPageId: parent.id, folderId: null },
      ],
      [
        { kind: 'folder', id: folder.id },
        { parentPageId: null, folderId: folder.id },
      ],
      [{ kind: 'root' }, { parentPageId: null, folderId: null }],
    ] as const;
    for (const [parentRef, placement] of destinations) {
      const res = await movePageV1(caller, page.id, { parent: parentRef });
      expect(res.status, parentRef.kind).toBe(200);
      const now = await read(caller, page.id);
      expect(now.placement).toMatchObject(placement);
      expect(now.markdown).toBe(page.markdown);
      expect(now.revision).toBe(page.revision);
    }
  });

  it('update → move → update: the second save states the revision GET reports after the move', async () => {
    const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const parent = await created(caller, { title: 'Parent' });
    const page = await created(caller, { title: SECRET_TITLE, markdown: 'v1' });

    const first = await updatePageV1(caller, page.id, { markdown: 'v2', revision: page.revision });
    expect(first.status).toBe(200);
    expect(
      (await movePageV1(caller, page.id, { parent: { kind: 'page', id: parent.id } })).status,
    ).toBe(200);

    const fresh = await read(caller, page.id);
    const second = await updatePageV1(caller, page.id, {
      markdown: 'v3',
      revision: fresh.revision,
    });
    expect(second.status).toBe(200);
    const final = await read(caller, page.id);
    expect(final.markdown).toContain('v3');
    expect(final.placement.parentPageId).toBe(parent.id);
  });

  it('a move under its own descendant is 422 PAGE_CYCLE and GET still shows the original place', async () => {
    const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const page = await created(caller, { title: SECRET_TITLE });
    const child = await created(caller, {
      title: 'Child',
      parent: { kind: 'page', id: page.id },
    });
    const before = await read(caller, page.id);

    const res = await movePageV1(caller, page.id, { parent: { kind: 'page', id: child.id } });
    expect(res.status).toBe(422);
    expect((await body(res)).code).toBe('PAGE_CYCLE');
    expect(await read(caller, page.id)).toEqual(before);
  });
});

describe('an archived page', () => {
  it('PATCH body and PATCH placement are both 409 PAGE_ARCHIVED, and the row is unchanged', async () => {
    const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const parent = await created(caller, { title: 'Parent' });
    const page = await created(caller, { title: SECRET_TITLE, markdown: 'Archived body.' });
    await pagesService.archivePage(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId: page.id,
    });
    const row = () =>
      adminDb.page.findUniqueOrThrow({
        where: { id: page.id },
        select: {
          revision: true,
          bodyMarkdown: true,
          parentPageId: true,
          folderId: true,
          position: true,
        },
      });
    const before = await row();

    const save = await updatePageV1(caller, page.id, {
      markdown: 'x',
      revision: before.revision,
    });
    expect(save.status).toBe(409);
    expect((await body(save)).code).toBe('PAGE_ARCHIVED');

    const move = await movePageV1(caller, page.id, { parent: { kind: 'page', id: parent.id } });
    expect(move.status).toBe(409);
    expect((await body(move)).code).toBe('PAGE_ARCHIVED');

    expect(await row()).toEqual(before);
  });
});

describe('the same not-found on all four routes', () => {
  it('an unknown id, another project’s page and an unbrowsable page answer every route identically, with no title', async () => {
    const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const other = await projectsService.createProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      name: 'Other',
      identifier: 'OTH',
    });
    const foreign = await pagesService.createPage(caller.ctx, {
      projectId: other.id,
      title: SECRET_TITLE,
    });
    const own = await pagesService.createPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      title: SECRET_TITLE,
    });
    const outsider = await memberCaller(caller, 'outsider', 'member');
    await adminDb.project.update({
      where: { id: caller.fixture.projectId },
      data: { accessMode: 'members' },
    });

    const routes = {
      get: (who: typeof caller | typeof outsider, id: string) => getPageV1(who, id),
      update: (who: typeof caller | typeof outsider, id: string) =>
        updatePageV1(who, id, { markdown: 'x', revision: 1 }),
      move: (who: typeof caller | typeof outsider, id: string) =>
        movePageV1(who, id, { parent: { kind: 'root' } }),
    };
    const expected = JSON.stringify({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });

    for (const [name, call] of Object.entries(routes)) {
      for (const [who, id] of [
        [caller, 'cmzzzzzzzzzzzzzzzzzzzzzzz'],
        [caller, foreign.id],
        [outsider, own.id],
      ] as const) {
        const res = await call(who, id);
        const text = await res.text();
        expect({ name, status: res.status, text }).toEqual({ name, status: 404, text: expected });
        expect(text).not.toContain(SECRET_TITLE);
      }
    }

    // Create addresses a project, not a page: one the caller cannot browse is a
    // not-found too, and it names no title.
    const create = await createPageV1(outsider, caller.projectKey, { title: 'x' });
    expect(create.status).toBe(404);
    expect(await create.text()).not.toContain(SECRET_TITLE);
  });
});

describe('the published contract', () => {
  it('the OpenAPI document lists all four page operations', () => {
    const document = emitOpenApiDocument() as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const ids = [
      document.paths['/api/v1/projects/{projectKey}/pages']?.['post']?.operationId,
      document.paths['/api/v1/pages/{pageId}']?.['get']?.operationId,
      document.paths['/api/v1/pages/{pageId}']?.['patch']?.operationId,
      document.paths['/api/v1/pages/{pageId}/placement']?.['patch']?.operationId,
    ];
    expect(ids).toEqual(['createPage', 'getPage', 'updatePage', 'movePage']);
  });
});
