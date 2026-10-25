import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { pageSearchHitSchema, type V1PageSearchResult } from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { pagesService } from '@/lib/services/pagesService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { PAGE_EDITOR, memberCaller, searchPagesV1 } from '../../fixtures/apiV1PageFixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  createCustomRoleAs,
  setProjectRoleDefinitionFor,
} from '../../helpers/workspaceRoleFixtures';

// `GET /api/v1/projects/{projectKey}/pages/search` (Story MOTIR-9489 ·
// MOTIR-9552), driven through the real handler and `withV1Route` against real
// Postgres: hits by a body word and a title word, archived and other projects'
// pages excluded, every named refusal, and no title, snippet or count in any
// refusal body.

const SECRET_TITLE = 'Acquisition plan confidential';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "page", "folder" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const pageCaller = (): Promise<V1ProjectCaller> =>
  createV1ProjectCaller({ permissions: PAGE_EDITOR });

const seed = (caller: V1ProjectCaller, title: string, markdown?: string, projectId?: string) =>
  pagesService.createPageFromMarkdown(caller.ctx, {
    projectId: projectId ?? caller.fixture.projectId,
    title,
    markdown,
  });

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A member whose token names `page:view` while their project role no longer confers it. */
async function roleWithout(caller: V1ProjectCaller, permissions: string[], tag: string) {
  const member = await memberCaller(caller, tag, 'member', ['project:browse', 'page:view']);
  const role = await createCustomRoleAs({ ctx: caller.ctx, name: `Role ${tag}`, permissions });
  await setProjectRoleDefinitionFor(member.user.id, caller.fixture.projectId, {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return member;
}

describe('GET /api/v1/projects/{projectKey}/pages/search', () => {
  it('finds a page by a body word, as id, title, place, snippet and rank only', async () => {
    const caller = await pageCaller();
    const page = await seed(caller, 'Quarterly roadmap', 'The zephyr launch is in spring.');

    const res = await searchPagesV1(caller, caller.projectKey, { q: 'zephyr' });
    expect(res.status).toBe(200);
    const result = await json<V1PageSearchResult>(res);
    expect(Object.keys(result).sort()).toEqual(['items', 'nextCursor']);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(1);
    const [hit] = result.items;
    expect(pageSearchHitSchema.strict().safeParse(hit).success).toBe(true);
    expect(hit).toMatchObject({
      id: page.id,
      title: 'Quarterly roadmap',
      place: { folderPath: [], parentPageTitle: null },
    });
    expect(hit!.snippet).toContain('zephyr');
    expect(JSON.stringify(result)).not.toContain('markdown');
  });

  it('finds a page by a title word, and the project key is case-insensitive', async () => {
    const caller = await pageCaller();
    const page = await seed(caller, 'Zephyr retro');
    const res = await searchPagesV1(caller, caller.projectKey.toLowerCase(), { q: 'retro' });
    expect(res.status).toBe(200);
    expect((await json<V1PageSearchResult>(res)).items.map((h) => h.id)).toEqual([page.id]);
  });

  it("never returns an archived page or another project's page", async () => {
    const caller = await pageCaller();
    const live = await seed(caller, 'Live', 'zephyr');
    const gone = await seed(caller, 'Gone', 'zephyr');
    await adminDb.page.update({
      where: { id: gone.id },
      data: { archivedAt: new Date(), archiveRootId: gone.id },
    });
    const other = await createTestProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.fixture.ownerId,
      identifier: 'OTHR',
    });
    await seed(caller, 'Elsewhere', 'zephyr', other.id);

    const res = await searchPagesV1(caller, caller.projectKey, { q: 'zephyr' });
    expect((await json<V1PageSearchResult>(res)).items.map((h) => h.id)).toEqual([live.id]);
  });

  it('follows nextCursor to the next page', async () => {
    const caller = await pageCaller();
    for (let i = 0; i < PAGE_SEARCH_LIMIT + 2; i++) await seed(caller, `Spec ${i}`, 'zephyr');
    const first = await json<V1PageSearchResult>(
      await searchPagesV1(caller, caller.projectKey, { q: 'zephyr' }),
    );
    expect(first.items).toHaveLength(PAGE_SEARCH_LIMIT);
    expect(first.nextCursor).not.toBeNull();
    const second = await json<V1PageSearchResult>(
      await searchPagesV1(caller, caller.projectKey, { q: 'zephyr', cursor: first.nextCursor! }),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((h) => h.id);
    expect(new Set(ids).size).toBe(PAGE_SEARCH_LIMIT + 2);
  });

  it('refuses an empty, missing or whitespace query as 422 PAGE_SEARCH_QUERY_EMPTY, with no page', async () => {
    const caller = await pageCaller();
    await seed(caller, SECRET_TITLE, 'zephyr');
    for (const q of ['', '   ', undefined]) {
      const res = await searchPagesV1(caller, caller.projectKey, q === undefined ? {} : { q });
      expect(res.status).toBe(422);
      const text = await res.text();
      expect(JSON.parse(text).code).toBe('PAGE_SEARCH_QUERY_EMPTY');
      expect(text).not.toContain(SECRET_TITLE);
    }
  });

  it('refuses a query over 200 characters as 422 PAGE_SEARCH_QUERY_TOO_LONG', async () => {
    const caller = await pageCaller();
    const res = await searchPagesV1(caller, caller.projectKey, { q: 'a'.repeat(201) });
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe('PAGE_SEARCH_QUERY_TOO_LONG');
  });

  it('refuses a cursor it did not issue as 422 PAGE_CURSOR_INVALID', async () => {
    const caller = await pageCaller();
    await seed(caller, 'Roadmap', 'zephyr');
    const res = await searchPagesV1(caller, caller.projectKey, { q: 'zephyr', cursor: 'garbage' });
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe('PAGE_CURSOR_INVALID');
  });
});

describe('who may search', () => {
  it('a member whose role lacks page:view is 403 PROJECT_ACCESS_DENIED, even with an empty query and a garbage cursor', async () => {
    const caller = await pageCaller();
    await seed(caller, SECRET_TITLE, 'zephyr');
    const member = await roleWithout(caller, ['project:browse', 'work_item:view'], 'noview');
    for (const query of [{ q: 'zephyr' }, { q: '', cursor: 'garbage' }, {}]) {
      const res = await searchPagesV1(member, caller.projectKey, query);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).code).toBe('PROJECT_ACCESS_DENIED');
      expect(text).not.toContain(SECRET_TITLE);
      expect(text).not.toContain('zephyr');
    }
  });

  it('a token not granted page:view is refused by withV1Route as 403 INSUFFICIENT_PERMISSION', async () => {
    const caller = await pageCaller();
    await seed(caller, SECRET_TITLE, 'zephyr');
    const browseOnly = await memberCaller(caller, 'browse-only', 'manager', ['project:browse']);
    const res = await searchPagesV1(browseOnly, caller.projectKey, { q: 'zephyr' });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe('INSUFFICIENT_PERMISSION');
    expect(text).not.toContain(SECRET_TITLE);
  });

  it('a caller who cannot browse the project gets the page 404, with no title', async () => {
    const caller = await pageCaller();
    await seed(caller, SECRET_TITLE, 'zephyr');
    const member = await roleWithout(caller, ['work_item:view'], 'nobrowse');
    const res = await searchPagesV1(member, caller.projectKey, { q: 'zephyr' });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'PAGE_NOT_FOUND' });
    expect(text).not.toContain(SECRET_TITLE);
  });
});
