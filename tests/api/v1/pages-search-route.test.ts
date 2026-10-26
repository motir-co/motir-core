import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { pageSearchHitSchema, type V1PageSearchResult } from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { pagesService } from '@/lib/services/pagesService';
import { pageEmbeddingRepository } from '@/lib/repositories/pageEmbeddingRepository';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
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
// refusal body. Since MOTIR-9574 the response carries `mode` and `message`; the
// by-meaning cases stub `workItemEmbeddingsService.embedQuery` with
// deterministic vectors and seed page vectors through the repository.

const SECRET_TITLE = 'Acquisition plan confidential';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "page", "folder" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  resetRateLimitStore();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(Object.keys(result).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
    expect(result.mode).toBe('full-text-only');
    expect(typeof result.message).toBe('string');
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

const MODEL = 'text-embedding-3-small';

/** A unit vector on axis `n`; different axes are orthogonal. */
function axis(n: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === n ? 1 : 0));
}

/** A unit vector between axes `a` and `b`, weighted toward `a` by `w`. */
function blend(a: number, b: number, w: number): number[] {
  const v = Array.from({ length: 1536 }, () => 0);
  v[a] = w;
  v[b] = Math.sqrt(1 - w * w);
  return v;
}

async function seedVector(
  caller: V1ProjectCaller,
  page: { id: string; projectId: string },
  embedding: number[],
): Promise<void> {
  await withWorkspaceServiceContext(caller.workspace.id, (tx) =>
    pageEmbeddingRepository.upsert(
      {
        pageId: page.id,
        workspaceId: caller.workspace.id,
        projectId: page.projectId,
        model: MODEL,
        dimensions: embedding.length,
        contentHash: `hash-${page.id}`,
        embeddedAt: new Date(),
        embedding,
      },
      tx,
    ),
  );
}

const answer = (embedding: number[]) =>
  vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockResolvedValue({ embedding, model: MODEL });

describe('by meaning (MOTIR-9574)', () => {
  it('returns a page that shares no word with the query, in merged mode with no message', async () => {
    const caller = await pageCaller();
    const rota = await seed(caller, 'On-call rota', 'Pager schedule.');
    await seedVector(caller, rota, axis(1));
    answer(axis(1));

    const res = await searchPagesV1(caller, caller.projectKey, { q: 'who gets woken up at night' });
    expect(res.status).toBe(200);
    const result = await json<V1PageSearchResult>(res);
    expect(Object.keys(result).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
    expect(result).toMatchObject({ mode: 'merged', message: null, nextCursor: null });
    expect(result.items.map((h) => h.id)).toEqual([rota.id]);
    for (const hit of result.items) {
      expect(pageSearchHitSchema.strict().safeParse(hit).success).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain('markdown');
  });

  it('returns a word-only match, and a page matching both ways once, above the others', async () => {
    const caller = await pageCaller();
    const both = await seed(caller, 'Zephyr runbook', 'zephyr');
    const wordOnly = await seed(caller, 'Zephyr retro', 'zephyr zephyr zephyr');
    const meaningOnly = await seed(caller, 'Unrelated', 'nothing in common');
    await seedVector(caller, meaningOnly, axis(3));
    await seedVector(caller, both, blend(3, 4, 0.9));
    answer(axis(3));

    const result = await json<V1PageSearchResult>(
      await searchPagesV1(caller, caller.projectKey, { q: 'zephyr' }),
    );
    expect(result.mode).toBe('merged');
    expect(result.items[0]!.id).toBe(both.id);
    expect(result.items.filter((h) => h.id === both.id)).toHaveLength(1);
    expect(new Set(result.items.map((h) => h.id))).toEqual(
      new Set([both.id, wordOnly.id, meaningOnly.id]),
    );
  });

  it("never returns an archived page or another project's page in a meaning-only search", async () => {
    const caller = await pageCaller();
    const live = await seed(caller, 'Live', 'body');
    const gone = await seed(caller, 'Gone', 'body');
    const other = await createTestProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.fixture.ownerId,
      identifier: 'OTHM',
    });
    const elsewhere = await seed(caller, SECRET_TITLE, 'body', other.id);
    await seedVector(caller, live, blend(5, 6, 0.5));
    await seedVector(caller, gone, axis(5));
    await seedVector(caller, elsewhere, axis(5));
    await adminDb.page.update({
      where: { id: gone.id },
      data: { archivedAt: new Date(), archiveRootId: gone.id },
    });
    answer(axis(5));

    const res = await searchPagesV1(caller, caller.projectKey, { q: 'meaning only' });
    const text = await res.text();
    expect((JSON.parse(text) as V1PageSearchResult).items.map((h) => h.id)).toEqual([live.id]);
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain('Gone');
  });

  it('a page in a project the caller may not view pages of is absent, title and all', async () => {
    const caller = await pageCaller();
    const visible = await seed(caller, 'Visible', 'body');
    const hiddenProject = await createTestProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.fixture.ownerId,
      identifier: 'HIDN',
    });
    const hidden = await seed(caller, SECRET_TITLE, 'body', hiddenProject.id);
    // Members-only and the caller was never added: no `page:view` there.
    await adminDb.project.update({
      where: { id: hiddenProject.id },
      data: { accessMode: 'members' },
    });
    const member = await memberCaller(caller, 'one-project', 'member', [
      'project:browse',
      'page:view',
    ]);
    await seedVector(caller, visible, blend(7, 8, 0.5));
    await seedVector(caller, hidden, axis(7));
    answer(axis(7));

    const res = await searchPagesV1(member, caller.projectKey, { q: 'meaning only' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect((JSON.parse(text) as V1PageSearchResult).items.map((h) => h.id)).toEqual([visible.id]);
    expect(text).not.toContain(SECRET_TITLE);
  });

  it('is 200 full-text-only with the word hits when the seam does not answer — never a 500', async () => {
    const caller = await pageCaller();
    const page = await seed(caller, 'Roadmap', 'zephyr');
    vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockResolvedValue(null);

    const res = await searchPagesV1(caller, caller.projectKey, { q: 'zephyr' });
    expect(res.status).toBe(200);
    const result = await json<V1PageSearchResult>(res);
    expect(result.mode).toBe('full-text-only');
    expect(result.message).toMatch(/did not run/);
    expect(result.items.map((h) => h.id)).toEqual([page.id]);
  });

  it('is not-indexed, with the word hits, when the seam answers and no page is embedded', async () => {
    const caller = await pageCaller();
    const page = await seed(caller, 'Roadmap', 'zephyr');
    answer(axis(9));

    const result = await json<V1PageSearchResult>(
      await searchPagesV1(caller, caller.projectKey, { q: 'zephyr' }),
    );
    expect(result.mode).toBe('not-indexed');
    expect(result.message).toMatch(/indexed/);
    expect(result.items.map((h) => h.id)).toEqual([page.id]);
  });

  it('touches the seam on no refusal: no access, an empty query, a bad cursor', async () => {
    const caller = await pageCaller();
    await seed(caller, SECRET_TITLE, 'zephyr');
    const embed = answer(axis(1));
    const member = await roleWithout(caller, ['project:browse', 'work_item:view'], 'noseam');

    const denied = await searchPagesV1(member, caller.projectKey, { q: 'zephyr' });
    expect(denied.status).toBe(403);
    expect((await json(denied)).code).toBe('PROJECT_ACCESS_DENIED');
    const empty = await searchPagesV1(caller, caller.projectKey, { q: '' });
    expect((await json(empty)).code).toBe('PAGE_SEARCH_QUERY_EMPTY');
    const bad = await searchPagesV1(caller, caller.projectKey, { q: 'zephyr', cursor: 'garbage' });
    expect((await json(bad)).code).toBe('PAGE_CURSOR_INVALID');

    expect(embed).not.toHaveBeenCalled();
  });

  it('honours a nextCursor from the fused ranking, with no page on two pages', async () => {
    const caller = await pageCaller();
    const total = PAGE_SEARCH_LIMIT + 3;
    for (let i = 0; i < total; i++) {
      const page = await seed(caller, `Spec ${i}`, i % 2 === 0 ? 'zephyr' : 'other');
      await seedVector(caller, page, blend(10, 11, 0.2 + (0.7 * i) / total));
    }
    answer(axis(10));

    const first = await json<V1PageSearchResult>(
      await searchPagesV1(caller, caller.projectKey, { q: 'zephyr' }),
    );
    expect(first.mode).toBe('merged');
    expect(first.items).toHaveLength(PAGE_SEARCH_LIMIT);
    const second = await json<V1PageSearchResult>(
      await searchPagesV1(caller, caller.projectKey, { q: 'zephyr', cursor: first.nextCursor! }),
    );
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((h) => h.id);
    expect(new Set(ids).size).toBe(total);
  });
});
