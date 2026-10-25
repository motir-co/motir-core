import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageLevelCursorInvalidError } from '@/lib/pages';
import { db } from '@/lib/db';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { encodePageSearchCursor } from '@/lib/pages/pageSearchCursor';
import { PageSearchQueryEmptyError, PageSearchQueryTooLongError } from '@/lib/pages/searchErrors';
import { PAGE_SEARCH_DOCUMENT, pageRepository } from '@/lib/repositories/pageRepository';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService, PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// Full-text page search on real Postgres (Story MOTIR-9489 · MOTIR-9551): a word
// in the title or the body, ranked and keyset-paged, under the ONE access filter
// (`authorizePageSearch`), with the named refusals for an empty query, an
// over-long one and a cursor this service did not issue. No AI backend is
// configured here, so every search below is `full-text-only` and `rank` is the
// fused score over the one full-text list (MOTIR-9572) — the same order.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PFS' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const newPage = (
  title: string,
  markdown?: string,
  opts: { parent?: { kind: 'folder' | 'page'; id: string }; projectId?: string } = {},
) =>
  pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: opts.projectId ?? fx.projectId,
    title,
    markdown,
    parent: opts.parent,
  });

const archive = (id: string) =>
  adminDb.page.update({ where: { id }, data: { archivedAt: new Date(), archiveRootId: id } });

const search = (q: string, cursor: string | null = null, ctx: ServiceContext = fx.ctx) =>
  pagesService.searchPages(ctx, { projectId: fx.projectId, q, cursor });

async function browseOnlyReader(): Promise<ServiceContext> {
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'Browser',
    permissions: ['project:browse', 'work_item:view'],
  });
  const user = await usersService.createUser({
    email: 'page-search-browse@example.com',
    password: 'hunter2hunter2',
    name: 'Browse only',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await setProjectRoleDefinitionFor(user.id, fx.projectId, {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

async function stranger(): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: 'page-search-stranger@example.com',
    password: 'hunter2hunter2',
    name: 'Stranger',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('pagesService.searchPages', () => {
  it('finds a page by a body word and by a title word, as id, title, place, snippet and rank only', async () => {
    const body = await newPage('Quarterly roadmap', 'We plan the zephyr launch for spring.');
    const titled = await newPage('Zephyr retro');

    const byBody = await search('spring');
    expect(byBody.nextCursor).toBeNull();
    expect(byBody.items).toHaveLength(1);
    const [hit] = byBody.items;
    expect(Object.keys(hit!).sort()).toEqual(['id', 'place', 'rank', 'snippet', 'title']);
    expect(hit).toMatchObject({
      id: body.id,
      title: 'Quarterly roadmap',
      place: { folderPath: [], parentPageTitle: null },
    });
    expect(hit!.snippet).toContain('spring');
    expect(hit!.rank).toBeGreaterThan(0);
    expect(byBody.mode).toBe('full-text-only');

    const byTitle = await search('retro');
    expect(byTitle.items.map((r) => r.id)).toEqual([titled.id]);
    expect(byTitle.items[0]!.snippet).toBe('');

    const both = await search('zephyr');
    expect(new Set(both.items.map((r) => r.id))).toEqual(new Set([body.id, titled.id]));
  });

  it("gives a title-only hit the body's leading words as its snippet", async () => {
    await newPage('Roadmap', 'First line of the body text that has nothing to do with it.');
    const [hit] = (await search('roadmap')).items;
    expect(hit!.snippet.startsWith('First line')).toBe(true);
  });

  it('ranks the better match first, id breaking a tie', async () => {
    const once = await newPage('A', 'zephyr');
    const often = await newPage('B', 'zephyr zephyr zephyr zephyr');
    const tieA = await newPage('C', 'zephyr');
    const items = (await search('zephyr')).items;
    expect(items[0]!.id).toBe(often.id);
    const tail = [once.id, tieA.id].sort().reverse();
    expect(items.slice(1).map((r) => r.id)).toEqual(tail);
  });

  it("never returns an archived page or another project's page", async () => {
    const live = await newPage('Live', 'zephyr here');
    await archive((await newPage('Gone', 'zephyr here')).id);
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHS',
    });
    await newPage('Elsewhere', 'zephyr here', { projectId: other.id });
    expect((await search('zephyr')).items.map((r) => r.id)).toEqual([live.id]);
  });

  it("carries each hit's place", async () => {
    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Specs' },
      fx.ctx,
    );
    const filed = await newPage('Filed', 'zephyr', { parent: { kind: 'folder', id: folder.id } });
    const child = await newPage('Child', 'zephyr', { parent: { kind: 'page', id: filed.id } });
    const { items } = await search('zephyr');
    expect(items.find((r) => r.id === filed.id)?.place).toEqual({
      folderPath: ['Specs'],
      parentPageTitle: null,
    });
    expect(items.find((r) => r.id === child.id)?.place).toEqual({
      folderPath: ['Specs'],
      parentPageTitle: 'Filed',
    });
  });

  it('pages through every hit once, in rank then id order, with no empty page', async () => {
    const total = PAGE_SEARCH_LIMIT * 2 + 3;
    // Three distinct ranks, with ties straddling the page boundaries.
    for (let i = 0; i < total; i++) {
      await newPage(`Spec ${i}`, Array.from({ length: (i % 3) + 1 }, () => 'zephyr').join(' '));
    }
    const seen: Array<{ id: string; rank: number }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await search('zephyr', cursor);
      expect(page.items.length).toBeGreaterThan(0);
      if (pages === 0) expect(page.items).toHaveLength(PAGE_SEARCH_LIMIT);
      seen.push(...page.items.map((r) => ({ id: r.id, rank: r.rank })));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(new Set(seen.map((r) => r.id)).size).toBe(total);
    const sorted = [...seen].sort((a, b) =>
      b.rank !== a.rank ? b.rank - a.rank : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
    );
    expect(seen).toEqual(sorted);
  });

  it('offers no cursor when the hits end exactly at the limit', async () => {
    for (let i = 0; i < PAGE_SEARCH_LIMIT; i++) await newPage(`Spec ${i}`, 'zephyr');
    const page = await search('zephyr');
    expect(page.items).toHaveLength(PAGE_SEARCH_LIMIT);
    expect(page.nextCursor).toBeNull();
  });

  it('refuses an empty or whitespace query by name, running no search', async () => {
    await newPage('Roadmap', 'zephyr');
    const read = vi.spyOn(pageRepository, 'searchLiveFullTextIds');
    for (const q of ['', '   ', '\n\t']) {
      await expect(search(q)).rejects.toBeInstanceOf(PageSearchQueryEmptyError);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a query over 200 characters, and accepts one of exactly 200', async () => {
    await expect(search('a'.repeat(201))).rejects.toBeInstanceOf(PageSearchQueryTooLongError);
    await expect(search('a'.repeat(200))).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it('answers an empty list for a query with no words, and treats operators as text', async () => {
    await newPage('Roadmap', 'zephyr');
    expect(await search('!!! ... &&')).toMatchObject({ items: [], nextCursor: null });
    for (const q of ["it's", '100%', 'back\\slash', 'a & b | !c', '"quoted" <-> :*']) {
      await expect(search(q)).resolves.toBeDefined();
    }
    // Operators are dropped as punctuation: `!zephyr&` is the plain word `zephyr`.
    expect((await search('!zephyr&')).items).toHaveLength(1);
  });

  it('refuses a member without page:view as edit, before the query or cursor is read', async () => {
    await newPage('Secret plan', 'zephyr');
    const reader = await browseOnlyReader();
    const read = vi.spyOn(pageRepository, 'searchLiveFullTextIds');
    for (const [q, cursor] of [
      ['zephyr', null],
      ['', null],
      ['zephyr', 'garbage'],
      ['   ', 'garbage'],
    ] as const) {
      const err = await search(q, cursor, reader).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect((err as ProjectAccessDeniedError).kind).toBe('edit');
      expect((err as Error).message).not.toContain('Secret');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a non-member as browse', async () => {
    const err = await search('zephyr', null, await stranger()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe('browse');
  });

  it('refuses a cursor this service did not issue, and accepts one it did', async () => {
    await newPage('Roadmap', 'zephyr');
    const bad = [
      'not base64 json',
      Buffer.from('{"a":1}').toString('base64url'),
      Buffer.from(JSON.stringify([0.5])).toString('base64url'),
      Buffer.from(JSON.stringify(['0.5', 'id'])).toString('base64url'),
      Buffer.from(JSON.stringify([0.5, ''])).toString('base64url'),
      Buffer.from(JSON.stringify([0.5, 'id', 'x'])).toString('base64url'),
    ];
    for (const cursor of bad) {
      await expect(search('zephyr', cursor)).rejects.toBeInstanceOf(PageLevelCursorInvalidError);
    }
    const ok = encodePageSearchCursor({ rank: 1, id: 'zzz' });
    await expect(search('zephyr', ok)).resolves.toBeDefined();
  });

  it("serves searchLiveFullText's match predicate from page_search_gin_idx", async () => {
    const plan = await adminDb.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN SELECT p."id" FROM "page" p
        WHERE ${PAGE_SEARCH_DOCUMENT} @@ plainto_tsquery('simple', ${'zephyr'})`;
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('page_search_gin_idx');
  });
});
