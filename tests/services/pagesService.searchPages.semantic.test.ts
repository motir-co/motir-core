import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PageLevelCursorInvalidError } from '@/lib/pages';
import { PAGE_SEARCH_FUSION_POOL } from '@/lib/pages/pageSearchFusion';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { PageSearchQueryEmptyError, PageSearchQueryTooLongError } from '@/lib/pages/searchErrors';
import { pageEmbeddingRepository } from '@/lib/repositories/pageEmbeddingRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pagesService, PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { EmbeddingDimensionMismatchError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// Page search BY MEANING on real Postgres (Story MOTIR-9490 · MOTIR-9572): the
// query is embedded behind `authorizePageSearch` and outside any transaction,
// ranked by similarity under the one access filter, fused with the full-text
// list by reciprocal-rank fusion, and keyset-paged over the fused list.
//
// The seam is `workItemEmbeddingsService.embedQuery`, spied with deterministic
// 1536-length vectors; page vectors are seeded straight through
// `pageEmbeddingRepository.upsert`, so nothing here depends on the write path.

const MODEL = 'text-embedding-3-small';

/** A unit vector on axis `axis`; two different axes are orthogonal (distance 1). */
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

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PSM' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const newPage = (title: string, markdown?: string, projectId = fx.projectId) =>
  pagesService.createPageFromMarkdown(fx.ctx, { projectId, title, markdown });

async function seedVector(
  page: { id: string; projectId: string },
  embedding: number[],
  model = MODEL,
): Promise<void> {
  await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    pageEmbeddingRepository.upsert(
      {
        pageId: page.id,
        workspaceId: fx.workspaceId,
        projectId: page.projectId,
        model,
        dimensions: embedding.length,
        contentHash: `hash-${page.id}`,
        embeddedAt: new Date(),
        embedding,
      },
      tx,
    ),
  );
}

/** The seam answers `embedding` for every query. */
const answer = (embedding: number[], model = MODEL) =>
  vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockResolvedValue({ embedding, model });

const search = (q: string, cursor: string | null = null, ctx: ServiceContext = fx.ctx) =>
  pagesService.searchPages(ctx, { projectId: fx.projectId, q, cursor });

async function browseOnlyReader(): Promise<ServiceContext> {
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'Browser',
    permissions: ['project:browse', 'work_item:view'],
  });
  const user = await usersService.createUser({
    email: 'page-semantic-browse@example.com',
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

describe('pagesService.searchPages — by meaning', () => {
  it('finds a page that shares no word with the query, in merged mode', async () => {
    const rota = await newPage('On-call rota', 'Pager schedule for the platform team.');
    await seedVector(rota, axis(1));
    answer(axis(1));

    const result = await search('who gets woken up at night');

    expect(result.mode).toBe('merged');
    expect(result.message).toBeNull();
    expect(result.items.map((h) => h.id)).toEqual([rota.id]);
    expect(result.items[0]!.snippet.startsWith('Pager schedule')).toBe(true);
    expect(result.items[0]!.place).toEqual({ folderPath: [], parentPageTitle: null });
  });

  it('still finds a word-only match, and gives an empty-body meaning hit an empty snippet', async () => {
    const worded = await newPage('Zephyr launch', 'zephyr notes');
    const empty = await newPage('Blank');
    await seedVector(empty, axis(2));
    answer(axis(2));

    const { items, mode } = await search('zephyr');

    expect(mode).toBe('merged');
    expect(new Set(items.map((h) => h.id))).toEqual(new Set([worded.id, empty.id]));
    expect(items.find((h) => h.id === empty.id)!.snippet).toBe('');
  });

  it('returns a page matching both lists once, above pages matching one', async () => {
    const both = await newPage('Zephyr runbook', 'zephyr');
    const wordOnly = await newPage('Zephyr retro', 'zephyr zephyr zephyr');
    const meaningOnly = await newPage('Unrelated title', 'nothing in common');
    await seedVector(meaningOnly, axis(3));
    await seedVector(both, blend(3, 4, 0.9));
    answer(axis(3));

    const { items } = await search('zephyr');

    expect(items[0]!.id).toBe(both.id);
    expect(items.filter((h) => h.id === both.id)).toHaveLength(1);
    expect(new Set(items.map((h) => h.id))).toEqual(
      new Set([both.id, wordOnly.id, meaningOnly.id]),
    );
    expect(items[0]!.rank).toBeGreaterThan(items[1]!.rank);
  });

  it("never returns an archived page or another project's page, however close its vector", async () => {
    const live = await newPage('Live', 'body');
    const gone = await newPage('Gone', 'body');
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PSO',
    });
    const elsewhere = await newPage('Elsewhere', 'body', other.id);
    await seedVector(live, blend(5, 6, 0.5));
    await seedVector(gone, axis(5));
    await seedVector(elsewhere, axis(5));
    await adminDb.page.update({
      where: { id: gone.id },
      data: { archivedAt: new Date(), archiveRootId: gone.id },
    });
    answer(axis(5));

    const { items } = await search('meaning only');

    expect(items.map((h) => h.id)).toEqual([live.id]);
  });

  it('falls back to full-text-only, with a message, when the seam does not answer', async () => {
    const page = await newPage('Zephyr', 'zephyr');
    await seedVector(page, axis(7));
    vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockResolvedValue(null);
    const rank = vi.spyOn(pageEmbeddingRepository, 'rankByEmbedding');

    const result = await search('zephyr');

    expect(result.mode).toBe('full-text-only');
    expect(result.message).toMatch(/did not run/);
    expect(result.message).toMatch(/not evidence/);
    expect(result.items.map((h) => h.id)).toEqual([page.id]);
    expect(rank).not.toHaveBeenCalled();
  });

  it('reads not-indexed when no page has a vector in the model the query came back in', async () => {
    const page = await newPage('Zephyr', 'zephyr');
    await seedVector(page, axis(8), 'an-older-model');
    answer(axis(8));

    const result = await search('zephyr');

    expect(result.mode).toBe('not-indexed');
    expect(result.message).toMatch(/indexed/);
    expect(result.message).toMatch(/not evidence/);
    expect(result.items.map((h) => h.id)).toEqual([page.id]);
  });

  it('lets a dimension mismatch from the seam propagate', async () => {
    await newPage('Zephyr', 'zephyr');
    vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockRejectedValue(
      new EmbeddingDimensionMismatchError(1536, 3, MODEL),
    );
    await expect(search('zephyr')).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
  });
});

describe('pagesService.searchPages — the order is the contract', () => {
  it('refuses every bad call before the seam is touched', async () => {
    await newPage('Secret plan', 'zephyr');
    const embed = answer(axis(1));
    const reader = await browseOnlyReader();

    const denied = await search('zephyr', null, reader).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ProjectAccessDeniedError);
    await expect(search('   ')).rejects.toBeInstanceOf(PageSearchQueryEmptyError);
    await expect(search('a'.repeat(201))).rejects.toBeInstanceOf(PageSearchQueryTooLongError);
    await expect(search('zephyr', 'garbage')).rejects.toBeInstanceOf(PageLevelCursorInvalidError);

    expect(embed).not.toHaveBeenCalled();
  });

  it('embeds the query with no transaction open, and ranks in a second one', async () => {
    const page = await newPage('Rota', 'body');
    await seedVector(page, axis(9));
    let openTransactions = -1;
    let rankedAfterEmbed = false;
    let embedded = false;
    vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockImplementation(async () => {
      const rows = await adminDb.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'idle in transaction'`;
      openTransactions = Number(rows[0]?.count ?? -1);
      embedded = true;
      return { embedding: axis(9), model: MODEL };
    });
    const realRank = pageEmbeddingRepository.rankByEmbedding.bind(pageEmbeddingRepository);
    vi.spyOn(pageEmbeddingRepository, 'rankByEmbedding').mockImplementation((input, tx) => {
      rankedAfterEmbed = embedded;
      return realRank(input, tx);
    });

    const { items } = await search('night shift');

    expect(openTransactions).toBe(0);
    expect(rankedAfterEmbed).toBe(true);
    expect(items.map((h) => h.id)).toEqual([page.id]);
  });
});

describe('pagesService.searchPages — paging the fused list', () => {
  it('serves every hit once across pages, cursors strictly after the last (score, id)', async () => {
    const total = PAGE_SEARCH_LIMIT * 2 + 5;
    for (let i = 0; i < total; i++) {
      // Every third page also matches the words; every page has a vector.
      const page = await newPage(`Spec ${i}`, i % 3 === 0 ? 'zephyr' : 'other text');
      await seedVector(page, blend(10, 11, 0.2 + (0.7 * i) / total));
    }
    answer(axis(10));
    const rowsRead = vi.spyOn(pageRepository, 'findSearchRowsByIds');

    const seen: Array<{ id: string; rank: number }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await search('zephyr', cursor);
      expect(page.mode).toBe('merged');
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map((h) => ({ id: h.id, rank: h.rank })));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((h) => h.id)).size).toBe(total);
    const sorted = [...seen].sort((a, b) =>
      b.rank !== a.rank ? b.rank - a.rank : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
    );
    expect(seen).toEqual(sorted);
    // One served-row read per page, never more than a page of ids.
    expect(rowsRead).toHaveBeenCalledTimes(3);
    for (const call of rowsRead.mock.calls) {
      expect(call[1].length).toBeLessThanOrEqual(PAGE_SEARCH_LIMIT);
    }
  });

  it('offers no cursor when the fused hits end exactly at the limit', async () => {
    for (let i = 0; i < PAGE_SEARCH_LIMIT; i++) {
      const page = await newPage(`Spec ${i}`, 'body');
      await seedVector(page, blend(12, 13, 0.1 + i / 40));
    }
    answer(axis(12));
    const page = await search('anything');
    expect(page.items).toHaveLength(PAGE_SEARCH_LIMIT);
    expect(page.nextCursor).toBeNull();
  });

  it('bounds each ranking at the fusion pool', async () => {
    const ids = vi.spyOn(pageRepository, 'searchLiveFullTextIds');
    const rank = vi.spyOn(pageEmbeddingRepository, 'rankByEmbedding');
    const page = await newPage('Zephyr', 'zephyr');
    await seedVector(page, axis(14));
    answer(axis(14));

    await search('zephyr');

    expect(ids.mock.calls[0]![2]).toBe(PAGE_SEARCH_FUSION_POOL);
    expect(rank.mock.calls[0]![0].limit).toBe(PAGE_SEARCH_FUSION_POOL);
  });
});
