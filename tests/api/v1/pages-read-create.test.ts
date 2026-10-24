import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiV1Error } from '@/lib/api/v1/errors';
import { PAGE_ERROR_STATUS, mapPageErrorToV1 } from '@/lib/api/v1/pages/errors';
import { pageSchema, presentPage, type V1Page } from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { PageNotFoundError, PageRevisionConflictError } from '@/lib/pages';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import {
  PAGE_EDITOR,
  createPageV1,
  getPageV1,
  memberCaller,
} from '../../fixtures/apiV1PageFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The `/api/v1` PAGE read and create (Story MOTIR-9486 · MOTIR-9493), end to end
// through `withV1Route` against real Postgres.
//
// What the card asks this file to prove, and where:
//   1  create at the root / in a folder / under a page, 201 with id, title,
//      placement and `revision`             → 'POST /projects/{projectKey}/pages'
//   2  the read equals `pagesService.getPageMarkdown`  → 'GET /pages/{pageId}'
//   3  no `page:edit` refused on create, no `page:view` on read, 403 with no
//      title                                           → 'who may create and read'
//   4  an unknown id, another project's page and a page in a project the caller
//      cannot browse are ONE not-found                 → 'one not-found'
//   5  a parent in another project or archived is refused by name and writes
//      nothing                                         → 'refused parents'
//   6  `mapPageErrorToV1` maps every page code          → 'mapPageErrorToV1'

const SECRET_TITLE = 'Acquisition plan — confidential';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "page", "folder" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function pageCaller(): Promise<V1ProjectCaller> {
  return createV1ProjectCaller({ permissions: PAGE_EDITOR });
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const pageCount = (projectId: string) => adminDb.page.count({ where: { projectId } });

describe('POST /api/v1/projects/{projectKey}/pages', () => {
  it('creates at the project root when no parent is given, with its markdown body and revision', async () => {
    const caller = await pageCaller();
    const res = await createPageV1(caller, caller.projectKey, {
      title: 'Runbook',
      markdown: '# Runbook\n\nRestart the worker.',
    });

    expect(res.status).toBe(201);
    const page = await body<V1Page>(res);
    expect(pageSchema.safeParse(page).success).toBe(true);
    expect(res.headers.get('location')).toBe(`/api/v1/pages/${page.id}`);
    expect(page).toMatchObject({
      title: 'Runbook',
      placement: { parentPageId: null, folderId: null },
      markdown: expect.stringContaining('Restart the worker.'),
    });
    expect(page.revision).toBeGreaterThanOrEqual(1);
    expect(page).not.toHaveProperty('projectId');
  });

  it('creates an empty page when no body is sent, and accepts an explicit root parent', async () => {
    const caller = await pageCaller();
    const res = await createPageV1(caller, caller.projectKey, { parent: { kind: 'root' } });
    expect(res.status).toBe(201);
    expect(await body(res)).toMatchObject({
      title: '',
      markdown: '',
      placement: { parentPageId: null, folderId: null },
    });
  });

  it('creates in a folder and under a page', async () => {
    const caller = await pageCaller();
    const folder = await foldersService.createFolder(
      { projectId: caller.fixture.projectId, parentFolderId: null, name: 'Docs' },
      caller.ctx,
    );
    const inFolder = await body<V1Page>(
      await createPageV1(caller, caller.projectKey, {
        title: 'Filed',
        parent: { kind: 'folder', id: folder.id },
      }),
    );
    expect(inFolder.placement).toEqual({ parentPageId: null, folderId: folder.id });

    const child = await createPageV1(caller, caller.projectKey, {
      title: 'Nested',
      parent: { kind: 'page', id: inFolder.id },
    });
    expect(child.status).toBe(201);
    expect((await body<V1Page>(child)).placement).toEqual({
      parentPageId: inFolder.id,
      folderId: null,
    });
  });

  it('answers the project’s own 404 for a key the caller cannot reach', async () => {
    const caller = await pageCaller();
    const res = await createPageV1(caller, 'NOPE', { title: 'x' });
    expect(res.status).toBe(404);
    expect(await pageCount(caller.fixture.projectId)).toBe(0);
  });

  it('refuses a malformed body or parent as 422 and writes nothing', async () => {
    const caller = await pageCaller();
    const cases: Array<[unknown, string]> = [
      ['{not json', 'INVALID_BODY'],
      [{ title: 7 }, 'INVALID_BODY'],
      [{ title: 'x', extra: true }, 'INVALID_BODY'],
      [{ parent: { kind: 'folder' } }, 'INVALID_BODY'],
      [{ parent: { kind: 'work_item', id: 'abc' } }, 'PAGE_PARENT_NOT_ALLOWED'],
      [{ title: 'x'.repeat(5000) }, 'PAGE_TITLE_TOO_LONG'],
    ];
    for (const [sent, code] of cases) {
      const res = await createPageV1(caller, caller.projectKey, sent);
      expect(res.status, JSON.stringify(sent).slice(0, 60)).toBe(422);
      expect((await body(res)).code).toBe(code);
    }
    expect(await pageCount(caller.fixture.projectId)).toBe(0);
  });
});

describe('refused parents', () => {
  it('a parent page or folder in another project is refused by name, and no page is written', async () => {
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

    // The create runs in a transaction narrowed to the caller's project, so the
    // other project's row is not visible at all: the refusal is the parent's own
    // not-found, by name — which also never confirms the foreign row exists.
    for (const [parent, code] of [
      [{ kind: 'page', id: foreignPage.id }, 'PAGE_NOT_FOUND'],
      [{ kind: 'folder', id: foreignFolder.id }, 'FOLDER_NOT_FOUND'],
    ] as const) {
      const res = await createPageV1(caller, caller.projectKey, { title: 'Stray', parent });
      const text = await res.text();
      expect(res.status, text).toBe(404);
      expect(JSON.parse(text).code).toBe(code);
      expect(text).not.toContain(SECRET_TITLE);
    }
    expect(await pageCount(caller.fixture.projectId)).toBe(0);
  });

  it('an archived parent page is refused as PAGE_PARENT_ARCHIVED, and no page is written', async () => {
    const caller = await pageCaller();
    const parent = await pagesService.createPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      title: 'Old',
    });
    await pagesService.archivePage(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId: parent.id,
    });

    const res = await createPageV1(caller, caller.projectKey, {
      title: 'Under the archive',
      parent: { kind: 'page', id: parent.id },
    });
    expect(res.status).toBe(422);
    expect((await body(res)).code).toBe('PAGE_PARENT_ARCHIVED');
    expect(await pageCount(caller.fixture.projectId)).toBe(1);
  });
});

describe('GET /api/v1/pages/{pageId}', () => {
  it('returns exactly what pagesService.getPageMarkdown returns, presented', async () => {
    const caller = await pageCaller();
    const created = await body<V1Page>(
      await createPageV1(caller, caller.projectKey, {
        title: 'Spec',
        markdown: '- [ ] one\n- [x] two',
      }),
    );

    const res = await getPageV1(caller, created.id);
    expect(res.status).toBe(200);
    const read = await body<V1Page>(res);
    expect(pageSchema.safeParse(read).success).toBe(true);

    const direct = await pagesService.getPageMarkdown(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId: created.id,
    });
    expect(read).toEqual(presentPage(direct));
    expect(read.revision).toBe(created.revision);
    expect(read.latestVersion?.authorId).toBe(caller.user.id);
  });

  it('a page whose history predates versions reads with latestVersion null', async () => {
    const caller = await pageCaller();
    const created = await body<V1Page>(
      await createPageV1(caller, caller.projectKey, { title: 'Old page', markdown: 'Legacy.' }),
    );
    await adminDb.pageVersion.deleteMany({ where: { pageId: created.id } });

    const read = await body<V1Page>(await getPageV1(caller, created.id));
    expect(pageSchema.safeParse(read).success).toBe(true);
    expect(read.latestVersion).toBeNull();
    expect(read.markdown).toContain('Legacy.');
  });
});

describe('one not-found', () => {
  it('an unknown id, another project’s page, another workspace’s page and a page in a project the caller cannot browse answer the same bytes', async () => {
    const caller = await pageCaller();

    // Another project of the same workspace — the token is bound to its own.
    const other = await projectsService.createProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      name: 'Other',
      identifier: 'OTH',
    });
    const otherProjectPage = await pagesService.createPage(caller.ctx, {
      projectId: other.id,
      title: SECRET_TITLE,
    });

    // Another workspace altogether.
    const stranger = await createV1ProjectCaller({
      permissions: PAGE_EDITOR,
      workspaceName: 'Elsewhere',
      identifier: 'ELS',
    });
    const otherWorkspacePage = await pagesService.createPage(stranger.ctx, {
      projectId: stranger.fixture.projectId,
      title: SECRET_TITLE,
    });

    // A member whose project becomes members-only after their token is minted.
    const member = await memberCaller(caller, 'outsider', 'member');
    const ownPage = await pagesService.createPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      title: SECRET_TITLE,
    });
    await adminDb.project.update({
      where: { id: caller.fixture.projectId },
      data: { accessMode: 'members' },
    });

    const unknown = await getPageV1(caller, 'cmzzzzzzzzzzzzzzzzzzzzzzz');
    const expected = { status: unknown.status, text: await unknown.text() };
    expect(expected.status).toBe(404);
    expect(JSON.parse(expected.text)).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });

    for (const [who, pageId] of [
      [caller, otherProjectPage.id],
      [caller, otherWorkspacePage.id],
      [member, ownPage.id],
    ] as const) {
      const res = await getPageV1(who, pageId);
      expect({ status: res.status, text: await res.text() }).toEqual(expected);
    }
  });
});

describe('who may create and read', () => {
  it('a member demoted to Viewer after minting is refused create as 403 PROJECT_ACCESS_DENIED, with no title, and nothing is written', async () => {
    const caller = await pageCaller();
    await pagesService.createPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      title: SECRET_TITLE,
    });
    // A token can only be granted keys its owner's role confers, so the user
    // who LACKS `page:edit` while their token still names it is one whose role
    // was lowered after the token was minted — the service's own gate refuses.
    const member = await memberCaller(caller, 'demoted', 'member');
    await adminDb.workspaceMembership.updateMany({
      where: { userId: member.user.id, workspaceId: caller.workspace.id },
      data: { workspaceRole: 'viewer' },
    });

    const res = await createPageV1(member, caller.projectKey, { title: 'Mine', markdown: 'x' });
    expect(res.status).toBe(403);
    const refusal = await body(res);
    expect(refusal.code).toBe('PROJECT_ACCESS_DENIED');
    expect(JSON.stringify(refusal)).not.toContain(SECRET_TITLE);
    expect(await pageCount(caller.fixture.projectId)).toBe(1);
  });

  it('a Viewer reads a page', async () => {
    const caller = await pageCaller();
    const page = await pagesService.createPage(caller.ctx, {
      projectId: caller.fixture.projectId,
      title: 'Readable',
    });
    const viewer = await memberCaller(caller, 'reader', 'viewer', ['project:browse', 'page:view']);
    const res = await getPageV1(viewer, page.id);
    expect(res.status).toBe(200);
    expect((await body(res)).title).toBe('Readable');
  });

  it('a token minted without page:edit is refused create, one without page:view is refused read — 403, no title', async () => {
    const owner = await pageCaller();
    const page = await pagesService.createPage(owner.ctx, {
      projectId: owner.fixture.projectId,
      title: SECRET_TITLE,
    });
    const browseOnly = await memberCaller(owner, 'browse-only', 'manager', ['project:browse']);

    const create = await createPageV1(browseOnly, owner.projectKey, { title: 'x' });
    expect(create.status).toBe(403);
    expect(await create.text()).not.toContain(SECRET_TITLE);

    const read = await getPageV1(browseOnly, page.id);
    expect(read.status).toBe(403);
    expect(await read.text()).not.toContain(SECRET_TITLE);
    expect(await pageCount(owner.fixture.projectId)).toBe(1);
  });
});

describe('mapPageErrorToV1', () => {
  it('maps every page code to its status, keeping the package’s code and message', () => {
    for (const [code, status] of Object.entries(PAGE_ERROR_STATUS)) {
      const mapped = mapPageErrorToV1(Object.assign(new Error(`refused ${code}`), { code }));
      expect(mapped).toBeInstanceOf(ApiV1Error);
      expect((mapped as ApiV1Error).status).toBe(status);
      expect((mapped as ApiV1Error).code).toBe(code);
    }
  });

  it('a stale revision is 409 PAGE_REVISION_CONFLICT', () => {
    const mapped = mapPageErrorToV1(new PageRevisionConflictError(1, 2)) as ApiV1Error;
    expect([mapped.status, mapped.code]).toEqual([409, 'PAGE_REVISION_CONFLICT']);
  });

  it('a page, project or browse refusal is the one PAGE_NOT_FOUND; a key refusal is 403', () => {
    for (const err of [
      new PageNotFoundError('p1'),
      new ProjectNotFoundError('proj'),
      new ProjectAccessDeniedError('proj', 'browse'),
    ]) {
      const mapped = mapPageErrorToV1(err) as ApiV1Error;
      expect([mapped.status, mapped.code, mapped.message]).toEqual([
        404,
        'PAGE_NOT_FOUND',
        'Page not found.',
      ]);
    }
    const denied = mapPageErrorToV1(new ProjectAccessDeniedError('proj', 'edit')) as ApiV1Error;
    expect([denied.status, denied.code]).toEqual([403, 'PROJECT_ACCESS_DENIED']);
  });

  it('returns anything else unchanged, for the wrapper to classify', () => {
    const raw = new Error('boom');
    expect(mapPageErrorToV1(raw)).toBe(raw);
    const v1 = new ApiV1Error('INVALID_BODY', 422, 'bad');
    expect(mapPageErrorToV1(v1)).toBe(v1);
    const other = Object.assign(new Error('x'), { code: 'WORK_ITEM_NOT_FOUND' });
    expect(mapPageErrorToV1(other)).toBe(other);
  });
});
