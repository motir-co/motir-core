import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pageSchema, type V1Page } from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import {
  PAGE_EDITOR,
  createPageV1,
  getPageV1,
  memberCaller,
  updatePageV1,
} from '../../fixtures/apiV1PageFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The `/api/v1` PAGE update (Story MOTIR-9486 · MOTIR-9494) — `PATCH
// /api/v1/pages/{pageId}` with `{ markdown, revision }`, end to end through
// `withV1Route` against real Postgres.
//
// What the card asks this file to prove, and where:
//   1  the current revision saves: 200, new body, new revision, and a GET agrees
//                                                     → 'a save at the current revision'
//   2  a stale revision is 409 PAGE_REVISION_CONFLICT and changes nothing
//                                                     → 'a stale revision'
//   3  an archived page is refused by name and unchanged → 'an archived page'
//   4  no page:edit, an unknown id and an invisible page are refused, no title
//                                                     → 'who may update'
//   5  a bad body is refused and writes nothing         → 'a malformed body'

const SECRET_TITLE = 'Board minutes — do not circulate';

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

/** A caller and one page it created over REST, with a body. */
async function withPage(): Promise<{ caller: V1ProjectCaller; page: V1Page }> {
  const caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
  const page = await body<V1Page>(
    await createPageV1(caller, caller.projectKey, {
      title: SECRET_TITLE,
      markdown: 'First draft.',
    }),
  );
  return { caller, page };
}

/** The stored row, read past RLS — what a refusal must leave untouched. */
const stored = (id: string) =>
  adminDb.page.findUniqueOrThrow({
    where: { id },
    select: { revision: true, bodyMarkdown: true, title: true },
  });

describe('a save at the current revision', () => {
  it('replaces the body, advances the revision, and a following GET returns the new markdown', async () => {
    const { caller, page } = await withPage();

    const res = await updatePageV1(caller, page.id, {
      markdown: '# Second draft\n\n- [x] reviewed',
      revision: page.revision,
    });
    expect(res.status).toBe(200);
    const saved = await body<V1Page>(res);
    expect(pageSchema.safeParse(saved).success).toBe(true);
    expect(saved.revision).toBeGreaterThan(page.revision);
    expect(saved.markdown).toContain('Second draft');
    expect(saved.title).toBe(SECRET_TITLE);

    const read = await body<V1Page>(await getPageV1(caller, page.id));
    expect(read).toEqual(saved);
  });

  it('chains: each save hands back the revision the next one states', async () => {
    const { caller, page } = await withPage();
    let revision = page.revision;
    for (const text of ['one', 'two', 'three']) {
      const res = await updatePageV1(caller, page.id, { markdown: text, revision });
      expect(res.status).toBe(200);
      revision = (await body<V1Page>(res)).revision;
    }
    expect((await stored(page.id)).bodyMarkdown).toContain('three');
  });
});

describe('a stale revision', () => {
  it('is 409 PAGE_REVISION_CONFLICT, and the body and revision are unchanged', async () => {
    const { caller, page } = await withPage();
    // Someone else saves first.
    await pagesService.savePageMarkdown(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId: page.id,
      markdown: 'Their edit.',
      expectedRevision: page.revision,
    });
    const before = await stored(page.id);

    const res = await updatePageV1(caller, page.id, {
      markdown: 'My edit, written against the old revision.',
      revision: page.revision,
    });
    expect(res.status).toBe(409);
    const refusal = await body(res);
    expect(refusal.code).toBe('PAGE_REVISION_CONFLICT');
    expect(JSON.stringify(refusal)).not.toContain(SECRET_TITLE);

    expect(await stored(page.id)).toEqual(before);
    const read = await body<V1Page>(await getPageV1(caller, page.id));
    expect(read.markdown).toContain('Their edit.');
    expect(read.revision).toBe(before.revision);
  });
});

describe('an archived page', () => {
  it('is refused as 409 PAGE_ARCHIVED and left unchanged', async () => {
    const { caller, page } = await withPage();
    await pagesService.archivePage(caller.ctx, {
      projectId: caller.fixture.projectId,
      pageId: page.id,
    });
    const before = await stored(page.id);

    const res = await updatePageV1(caller, page.id, {
      markdown: 'Edited in the archive.',
      revision: before.revision,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe('PAGE_ARCHIVED');
    expect(await stored(page.id)).toEqual(before);
  });
});

describe('who may update', () => {
  it('an unknown id, another project’s page and a page in a project the caller cannot browse are the same 404', async () => {
    const { caller } = await withPage();
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

    const unknown = await updatePageV1(caller, 'cmzzzzzzzzzzzzzzzzzzzzzzz', {
      markdown: 'x',
      revision: 1,
    });
    const expected = { status: unknown.status, text: await unknown.text() };
    expect(expected.status).toBe(404);
    expect(JSON.parse(expected.text)).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });

    for (const [who, pageId] of [
      [caller, otherPage.id],
      [member, ownPage.id],
    ] as const) {
      const before = await stored(pageId);
      const res = await updatePageV1(who, pageId, { markdown: 'x', revision: 1 });
      expect({ status: res.status, text: await res.text() }).toEqual(expected);
      expect(await stored(pageId)).toEqual(before);
    }
  });

  it('a member demoted to Viewer is 403 PROJECT_ACCESS_DENIED; a token without page:edit is 403 — no title, nothing written', async () => {
    const { caller, page } = await withPage();
    const member = await memberCaller(caller, 'demoted', 'member');
    await adminDb.workspaceMembership.updateMany({
      where: { userId: member.user.id, workspaceId: caller.workspace.id },
      data: { workspaceRole: 'viewer' },
    });
    const readOnly = await memberCaller(caller, 'reader', 'member', [
      'project:browse',
      'page:view',
    ]);
    const before = await stored(page.id);

    const demoted = await updatePageV1(member, page.id, { markdown: 'x', revision: page.revision });
    expect(demoted.status).toBe(403);
    const demotedText = await demoted.text();
    expect(JSON.parse(demotedText).code).toBe('PROJECT_ACCESS_DENIED');
    expect(demotedText).not.toContain(SECRET_TITLE);

    const narrowed = await updatePageV1(readOnly, page.id, {
      markdown: 'x',
      revision: page.revision,
    });
    expect(narrowed.status).toBe(403);
    expect(await narrowed.text()).not.toContain(SECRET_TITLE);

    expect(await stored(page.id)).toEqual(before);
  });
});

describe('a malformed body', () => {
  it('missing markdown or revision, a non-integer or non-positive revision, a title, or bad JSON is 422 and writes nothing', async () => {
    const { caller, page } = await withPage();
    const before = await stored(page.id);
    const cases: unknown[] = [
      '{not json',
      { revision: page.revision },
      { markdown: 'x' },
      { markdown: 'x', revision: 1.5 },
      { markdown: 'x', revision: 0 },
      { markdown: 'x', revision: -1 },
      { markdown: 'x', revision: '1' },
      { markdown: 7, revision: page.revision },
      { markdown: 'x', revision: page.revision, title: 'Renamed' },
    ];
    for (const sent of cases) {
      const res = await updatePageV1(caller, page.id, sent);
      expect(res.status, JSON.stringify(sent)).toBe(422);
      expect((await body(res)).code).toBe('INVALID_BODY');
    }
    expect(await stored(page.id)).toEqual(before);
  });
});
