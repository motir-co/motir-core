import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// STORY GATE — pages are found by meaning (Story MOTIR-9490 · MOTIR-9576).
//
// Each blocker proved its own piece; this file proves the pieces AGREE, over
// real Postgres, with the whole chain run once:
//
//   write door → post-commit `page/embedding.requested` → the job
//   (`pageEmbeddingsService.embedPage`, run once per captured event) →
//   `page_embedding` row → `pagesService.searchPages` (access, embed, rank,
//   fuse) → the REST presenter and the MCP tool.
//
// THE ONE SEAM STUBBED is the motir-ai client's `embedTexts`, by a deterministic
// TOPIC function: each topic owns one axis, a text's vector is the normalised
// count of its topic words, and a text with none gets an axis of its own. Page
// text and query text use DIFFERENT words of a topic, so a hit by meaning shares
// no token with its query. `embedQuery` runs for real on top of it, so its
// degraded `null` comes from a real transport failure; where a case needs to
// count or order its calls it is spied through.
//
// There is NO similarity threshold (MOTIR-9572): in `merged` mode every embedded
// live page of the project is a semantic candidate. "No longer ranks for the old
// meaning" is therefore asserted as what the ranking actually says — the page's
// cosine distance to the old meaning is 1, nothing in common, and pages that ARE
// about it rank above it.

const { depth, order } = vi.hoisted(() => ({
  depth: { open: 0 },
  order: [] as string[],
}));

vi.mock('@/lib/ai/motirAiClient', () => ({ embedTexts: vi.fn() }));

// Transparent wrappers, so a case can see WHERE the query embed happens: the
// number of `withWorkspaceContext` callbacks on the stack, and whether the
// access check has run.
vi.mock('@/lib/workspaces/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces/context')>();
  return {
    ...actual,
    withWorkspaceContext: ((scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      (
        actual.withWorkspaceContext as (
          s: unknown,
          f: (tx: unknown) => Promise<unknown>,
        ) => Promise<unknown>
      )(scope, async (tx) => {
        depth.open++;
        try {
          return await fn(tx);
        } finally {
          depth.open--;
        }
      })) as typeof actual.withWorkspaceContext,
  };
});
vi.mock('@/lib/pages/pageSearchAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pages/pageSearchAccess')>();
  return {
    ...actual,
    authorizePageSearch: (async (...args: Parameters<typeof actual.authorizePageSearch>) => {
      const scope = await actual.authorizePageSearch(...args);
      order.push('access');
      return scope;
    }) as typeof actual.authorizePageSearch,
  };
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import type { V1PageSearchResult } from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import type { PageSearchResultDto } from '@/lib/dto/pages';
import type { PageEmbeddingRequestedData } from '@/lib/jobs/types';
import { buildMcpServer } from '@/lib/mcp/registry';
import { emptyState, markdownToUpdate, PageLevelCursorInvalidError } from '@/lib/pages';
import { composePageEmbeddingDocument, hashEmbeddingDocument } from '@/lib/pages/embeddingDocument';
import { PageSearchQueryEmptyError, PageSearchQueryTooLongError } from '@/lib/pages/searchErrors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  pageEmbeddingRepository,
  type PageEmbeddingRankRow,
} from '@/lib/repositories/pageEmbeddingRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageEmbeddingsService } from '@/lib/services/pageEmbeddingsService';
import {
  pagesService,
  PAGE_SEARCH_LIMIT,
  PAGE_SEARCH_MODE_MESSAGES,
} from '@/lib/services/pagesService';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { PAGE_EDITOR, memberCaller, searchPagesV1 } from '../../fixtures/apiV1PageFixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureEventPayloads } from '../../helpers/jobs';
import {
  createCustomRoleAs,
  setProjectRoleDefinitionFor,
} from '../../helpers/workspaceRoleFixtures';
import { run as runBackfill, type Out } from '../../../scripts/backfill-page-embeddings';

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;
const SECRET_TITLE = 'Acquisition plan confidential';

// ── The deterministic seam ──────────────────────────────────────────────────

/** Each topic's axis and its words. Pages use some words, queries others. */
const TOPICS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [1, ['overnight', 'incident', 'incidents', 'pager', 'rota', 'woken', 'night']],
  [2, ['budget', 'invoice', 'spend', 'costs', 'money', 'afford']],
  [3, ['hiring', 'candidate', 'interview', 'newcomers', 'join']],
  [4, ['launch', 'rollout', 'release', 'debut']],
  [5, ['flight', 'hotel', 'travel', 'abroad', 'journey']],
  [6, ['security', 'password', 'vault', 'breach', 'attackers']],
];

/** An axis of its own for a text with no topic word, so unrelated texts are orthogonal. */
function ownAxis(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 100 + (h % 1400);
}

function topicVector(text: string): number[] {
  const words = text.toLowerCase().split(/[^a-z]+/);
  const v = Array.from({ length: DIMENSIONS }, () => 0);
  for (const [axis, vocabulary] of TOPICS) {
    v[axis] = words.filter((w) => vocabulary.includes(w)).length;
  }
  if (v.every((x) => x === 0)) v[ownAxis(text)] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const seamAnswers = () =>
  vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
    model: MODEL,
    dimensions: DIMENSIONS,
    embeddings: input.map(topicVector),
  }));

// ── Fixtures ────────────────────────────────────────────────────────────────

let caller: V1ProjectCaller;
let cap: { events: PageEmbeddingRequestedData[]; restore: () => void };
let drained = 0;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "page", "folder" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  resetRateLimitStore();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  seamAnswers();
  order.length = 0;
  cap = captureEventPayloads<PageEmbeddingRequestedData>('page/embedding.requested');
  drained = 0;
  caller = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
});

afterEach(() => {
  cap.restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(embedTexts).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Run the job for every event emitted since the last drain — the worker, in-process. */
async function drain(): Promise<void> {
  while (drained < cap.events.length) {
    await pageEmbeddingsService.embedPage(cap.events[drained++]!);
  }
}

const projectId = () => caller.fixture.projectId;

const create = (title: string, markdown?: string, pid = projectId()) =>
  pagesService.createPageFromMarkdown(caller.ctx, { projectId: pid, title, markdown });

const search = (q: string, cursor: string | null = null, ctx: ServiceContext = caller.ctx) =>
  pagesService.searchPages(ctx, { projectId: projectId(), q, cursor });

const ids = (result: { items: Array<{ id: string }> }) => result.items.map((h) => h.id);

/** The hash of the page's CURRENT composed document, read back from the store. */
async function currentHash(pageId: string): Promise<string> {
  const page = await withWorkspaceServiceContext(caller.workspace.id, (tx) =>
    pageRepository.findEmbeddingSourceById(pageId, tx),
  );
  return hashEmbeddingDocument(
    composePageEmbeddingDocument({ title: page!.title, bodyText: page!.bodyText }),
  );
}

const rowOf = (pageId: string) => adminDb.pageEmbedding.findUnique({ where: { pageId } });

/** Every ranking row `searchPages` read during `act`, in the order it read them. */
async function rankedDuring(act: () => Promise<unknown>): Promise<PageEmbeddingRankRow[]> {
  const spy = vi.spyOn(pageEmbeddingRepository, 'rankByEmbedding');
  await act();
  const rows = (await Promise.all(
    spy.mock.results.map((r) => r.value),
  )) as PageEmbeddingRankRow[][];
  spy.mockRestore();
  return rows.at(-1) ?? [];
}

/** A member of the workspace who can browse the project but whose role confers no `page:view`. */
async function browseOnlyMember(): Promise<ServiceContext> {
  const member = await memberCaller(caller, 'browse', 'member', ['project:browse']);
  const role = await createCustomRoleAs({
    ctx: caller.ctx,
    name: 'Browse only',
    permissions: ['project:browse', 'work_item:view'],
  });
  await setProjectRoleDefinitionFor(member.user.id, projectId(), {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return { userId: member.user.id, workspaceId: caller.workspace.id };
}

async function connectMcp(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function capture(): Out & { lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l) };
}

// ── 1. Every content write door leaves a searchable vector ───────────────────

interface Door {
  door: string;
  /** Drive the door; answer the page it wrote. Setup writes are drained first. */
  act: () => Promise<string>;
  /** A query sharing no word with the page, close to it in meaning. */
  query: string;
}

const DOORS: Door[] = [
  {
    door: 'createPage',
    query: 'who gets woken up at night',
    act: async () =>
      (
        await pagesService.createPage(caller.ctx, {
          projectId: projectId(),
          title: 'Overnight incident pager rota',
        })
      ).id,
  },
  {
    door: 'createPageFromMarkdown',
    query: 'how much money can we afford',
    act: async () => (await create('Quarterly budget', 'Invoice totals and spend.')).id,
  },
  {
    door: 'savePageMarkdown',
    query: 'newcomers who will join',
    act: async () => {
      const page = await create('Draft', 'Nothing yet.');
      await drain();
      const ref = { projectId: projectId(), pageId: page.id };
      const current = await pagesService.getPageMarkdown(caller.ctx, ref);
      await pagesService.savePageMarkdown(caller.ctx, {
        ...ref,
        markdown: 'Every hiring candidate and interview.',
        expectedRevision: current!.revision,
      });
      return page.id;
    },
  },
  {
    door: 'savePageUpdate',
    query: 'the big debut',
    act: async () => {
      const page = await pagesService.createPage(caller.ctx, {
        projectId: projectId(),
        title: 'Notes',
      });
      await drain();
      await pagesService.savePageUpdate(caller.ctx, {
        projectId: projectId(),
        pageId: page.id,
        update: markdownToUpdate(emptyState(), 'Launch rollout steps for the release.'),
      });
      return page.id;
    },
  },
  {
    door: 'renamePage',
    query: 'going abroad on a journey',
    act: async () => {
      const page = await create('Untitled', 'Plain words here.');
      await drain();
      await pagesService.renamePage(caller.ctx, {
        projectId: projectId(),
        pageId: page.id,
        title: 'Flight and hotel travel rules',
      });
      return page.id;
    },
  },
  {
    door: 'restorePageVersion',
    query: 'keeping attackers out',
    act: async () => {
      const page = await create('Wiki', 'Password vault and breach drills for security.');
      const ref = { projectId: projectId(), pageId: page.id };
      // Age the first version out of its editing session, so the next save opens version 2.
      await adminDb.pageVersion.updateMany({
        where: { pageId: page.id },
        data: { startedAt: new Date(0), savedAt: new Date(0) },
      });
      const current = await pagesService.getPageMarkdown(caller.ctx, ref);
      await pagesService.savePageMarkdown(caller.ctx, {
        ...ref,
        markdown: 'Plain words here.',
        expectedRevision: current!.revision,
      });
      await drain();
      const { items } = await pagesService.listPageVersions(caller.ctx, ref);
      const first = Math.min(...items.map((v) => v.number));
      await pagesService.restorePageVersion(caller.ctx, { ...ref, number: first });
      return page.id;
    },
  },
];

describe('every content write door → job → row → search by meaning', () => {
  it.each(DOORS)(
    '$door leaves a row of the current text, found by meaning in merged mode',
    async ({ act, query }) => {
      // A second page on another meaning, so the hit is a ranking and not the only row.
      await create('Garden', 'Compost and seeds.');
      const pageId = await act();
      await drain();

      const row = await rowOf(pageId);
      expect(row).not.toBeNull();
      expect(row!.contentHash).toBe(await currentHash(pageId));
      expect(row!.model).toBe(MODEL);

      const fullText = vi.spyOn(pageRepository, 'searchLiveFullTextIds');
      const result = await search(query);
      expect(await fullText.mock.results[0]!.value).toEqual([]); // no shared word
      expect(result.mode).toBe('merged');
      expect(result.message).toBeNull();
      expect(ids(result)[0]).toBe(pageId);
    },
  );
});

// ── 2. A change of topic moves the page; an unchanged save is free ──────────

describe('the vector follows what the page says', () => {
  it('leaves the old meaning and joins the new one; an unchanged save calls the seam zero times', async () => {
    const aboutBudget = await create('Finance', 'Invoice and spend review.');
    const page = await create('Plan', 'Budget invoice spend.');
    await drain();
    const oldMeaning = 'how much money can we afford';
    const newMeaning = 'going abroad on a journey';

    const before = await rankedDuring(() => search(oldMeaning));
    expect(before.find((r) => r.pageId === page.id)!.distance).toBeCloseTo(0, 6);

    const ref = { projectId: projectId(), pageId: page.id };
    const current = await pagesService.getPageMarkdown(caller.ctx, ref);
    const saved = await pagesService.savePageMarkdown(caller.ctx, {
      ...ref,
      markdown: 'Flight and hotel rules.',
      expectedRevision: current!.revision,
    });
    await drain();

    const after = await rankedDuring(() => search(oldMeaning));
    expect(after.find((r) => r.pageId === page.id)!.distance).toBeCloseTo(1, 6);
    expect(ids(await search(oldMeaning))[0]).toBe(aboutBudget.id);
    expect(ids(await search(newMeaning))[0]).toBe(page.id);

    // The same body and the same title again: every door emits, no job embeds.
    vi.mocked(embedTexts).mockClear();
    await pagesService.savePageMarkdown(caller.ctx, {
      ...ref,
      markdown: 'Flight and hotel rules.',
      expectedRevision: saved.revision,
    });
    await pagesService.renamePage(caller.ctx, { ...ref, title: 'Plan' });
    await drain();
    expect(embedTexts).not.toHaveBeenCalled();
  });
});

// ── 3. Archive and restore, sub-pages included ──────────────────────────────

describe('archive and restore', () => {
  it('removes a page and its sub-page from every mode and drops their rows; restore brings both back', async () => {
    await create('Finance', 'Budget invoice.');
    const parent = await create('Overnight incident', 'Pager rota zephyr.');
    const child = await pagesService.createPageFromMarkdown(caller.ctx, {
      projectId: projectId(),
      title: 'Incident follow-up',
      markdown: 'Pager zephyr notes.',
      parent: { kind: 'page', id: parent.id },
    });
    await drain();
    const set = [parent.id, child.id];
    const meaningOnly = () => search('who gets woken up at night');
    const merged = () => search('zephyr');
    const wordOnly = async () => {
      vi.mocked(embedTexts).mockRejectedValueOnce(new Error('gateway down'));
      const result = await search('zephyr');
      expect(result.mode).toBe('full-text-only');
      return result;
    };
    const everyMode = async () => [
      ...ids(await meaningOnly()),
      ...ids(await merged()),
      ...ids(await wordOnly()),
    ];

    expect(await everyMode()).toEqual(expect.arrayContaining(set));

    await pagesService.archivePage(caller.ctx, { projectId: projectId(), pageId: parent.id });
    await drain();
    for (const id of set) expect(await rowOf(id)).toBeNull();
    const archived = await everyMode();
    for (const id of set) expect(archived).not.toContain(id);

    await pagesService.restorePage(caller.ctx, { projectId: projectId(), pageId: parent.id });
    await drain();
    for (const id of set) expect((await rowOf(id))!.contentHash).toBe(await currentHash(id));
    const restored = await everyMode();
    for (const id of set) expect(restored.filter((x) => x === id)).toHaveLength(3);
  });
});

// ── 4. One access predicate bounds both rankings, end to end ────────────────

describe('the access boundary', () => {
  it("never returns another project's page or a page of a project the caller cannot view, in any mode", async () => {
    const visible = await create('Pager rota', 'Overnight incident zephyr.');
    const other = await createTestProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.fixture.ownerId,
      identifier: 'OTHR',
    });
    const hiddenProject = await createTestProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.fixture.ownerId,
      identifier: 'HIDN',
    });
    // Closest of all in meaning, and full of the word.
    await create(SECRET_TITLE, 'Overnight incident pager rota zephyr zephyr.', other.id);
    await create(
      `${SECRET_TITLE} two`,
      'Overnight incident pager rota zephyr zephyr.',
      hiddenProject.id,
    );
    await drain();
    expect(await adminDb.pageEmbedding.count()).toBe(3);
    // Members-only, and the member is never added: no `page:view` there.
    await adminDb.project.update({
      where: { id: hiddenProject.id },
      data: { accessMode: 'members' },
    });
    const member = await memberCaller(caller, 'one-project', 'member', [
      'project:browse',
      'page:view',
    ]);
    const ctx = { userId: member.user.id, workspaceId: caller.workspace.id };

    const meaningOnly = await search('who gets woken up at night', null, ctx);
    const merged = await search('zephyr', null, ctx);
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error('gateway down'));
    const wordOnly = await search('zephyr', null, ctx);
    for (const result of [meaningOnly, merged, wordOnly]) {
      expect(ids(result)).toEqual([visible.id]);
      expect(result.nextCursor).toBeNull();
      expect(JSON.stringify(result)).not.toContain(SECRET_TITLE);
    }

    const res = await searchPagesV1(member, caller.projectKey, { q: 'who gets woken up at night' });
    const wire = await res.text();
    expect((JSON.parse(wire) as V1PageSearchResult).items.map((h) => h.id)).toEqual([visible.id]);
    expect(wire).not.toContain(SECRET_TITLE);
  });
});

// ── 5. Fusion: a page matching both ways appears once, on top ───────────────

describe('fusion', () => {
  it('ranks a both-match page once and above pages matching one way; each phrase alone finds it', async () => {
    const both = await create('Pager rota', 'The overnight incident pager. Pager first.');
    const wordMostly = await create('Hardware budget', 'Budget invoice spend for one pager.');
    const meaningMostly = await create('Overnight incident rota', 'Shift costs.');
    await drain();

    const result = await search('pager');
    expect(result.mode).toBe('merged');
    expect(ids(result)[0]).toBe(both.id);
    expect(ids(result).filter((id) => id === both.id)).toHaveLength(1);
    expect(new Set(ids(result)).size).toBe(ids(result).length);
    expect(ids(result)).toEqual(expect.arrayContaining([wordMostly.id, meaningMostly.id]));

    expect(ids(await search('who gets woken up at night'))[0]).toBe(both.id);
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error('gateway down'));
    const wordOnly = await search('pager');
    expect(wordOnly.mode).toBe('full-text-only');
    expect(ids(wordOnly)).toContain(both.id);
  });
});

// ── 6–7. The order is the contract ──────────────────────────────────────────

describe('refusals and the order of the call', () => {
  it('refuses no page:view, an empty query, an over-long query and a forged cursor before the seam', async () => {
    await create(SECRET_TITLE, 'zephyr');
    await drain();
    const reader = await browseOnlyMember();
    vi.mocked(embedTexts).mockClear();
    const embed = vi.spyOn(workItemEmbeddingsService, 'embedQuery');

    await expect(search('zephyr', null, reader)).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    await expect(search('   ')).rejects.toBeInstanceOf(PageSearchQueryEmptyError);
    await expect(search('a'.repeat(201))).rejects.toBeInstanceOf(PageSearchQueryTooLongError);
    const forged = await search('zephyr', 'not-a-cursor').catch((e: unknown) => e);
    expect(forged).toBeInstanceOf(PageLevelCursorInvalidError);
    expect((forged as PageLevelCursorInvalidError).code).toBe('PAGE_CURSOR_INVALID');

    expect(embed).not.toHaveBeenCalled();
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('embeds the query after the access check, with no workspace transaction on the stack', async () => {
    await create('Pager rota', 'Overnight incident.');
    await drain();
    const real = workItemEmbeddingsService.embedQuery.bind(workItemEmbeddingsService);
    const openAtEmbed: number[] = [];
    vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockImplementation(async (q) => {
      order.push('embed');
      openAtEmbed.push(depth.open);
      return real(q);
    });
    const rank = vi.spyOn(pageEmbeddingRepository, 'rankByEmbedding');
    order.length = 0;

    const result = await search('who gets woken up at night');

    expect(result.mode).toBe('merged');
    expect(order).toEqual(['access', 'embed']);
    expect(openAtEmbed).toEqual([0]);
    expect(rank).toHaveBeenCalledTimes(1);
  });
});

// ── 8–9. The three modes appear exactly when the seam state says so ─────────

describe('degradation', () => {
  it('reads full-text-only with the word hits and an honest message when the gateway fails — never an error', async () => {
    const page = await create('Roadmap', 'zephyr launch');
    await drain();
    vi.mocked(embedTexts).mockRejectedValue(new Error('gateway down'));

    const withHits = await search('zephyr');
    expect(withHits.mode).toBe('full-text-only');
    expect(ids(withHits)).toEqual([page.id]);
    expect(withHits.message).toBe(PAGE_SEARCH_MODE_MESSAGES['full-text-only']);
    expect(withHits.message).toContain('Semantic search did not run');

    const without = await search('who gets woken up at night');
    expect(without).toMatchObject({ mode: 'full-text-only', items: [], nextCursor: null });
    expect(without.message).toBe(PAGE_SEARCH_MODE_MESSAGES['full-text-only']);
  });

  it('reads not-indexed, with the word hits, while the seam answers and no page has a row', async () => {
    const page = await create('Roadmap', 'zephyr launch');
    // The event is captured and never drained: no job ran, so no row exists.
    expect(await adminDb.pageEmbedding.count()).toBe(0);

    const result = await search('zephyr');
    expect(result.mode).toBe('not-indexed');
    expect(ids(result)).toEqual([page.id]);
    expect(result.message).toBe(PAGE_SEARCH_MODE_MESSAGES['not-indexed']);
    expect(result.message).toContain('No page in this project is indexed');
  });
});

// ── 10. The backfill and the live path write the same rows ──────────────────

describe('the backfill', () => {
  it('embeds pre-existing pages N of N, findable by meaning; a re-run makes zero seam calls and no rows', async () => {
    const pages = [
      await create('Pager rota', 'Overnight incident.'),
      await create('Quarterly budget', 'Invoice spend.'),
      await create('Hiring', 'Candidate interview.'),
    ];
    expect(await adminDb.pageEmbedding.count()).toBe(0);

    const first = capture();
    expect(await runBackfill([`--project=${projectId()}`], { out: first })).toBe(0);
    expect(first.lines).toContain('[backfill-page-embeddings] embedded 3 of 3 live pages.');
    for (const page of pages) {
      expect((await rowOf(page.id))!.contentHash).toBe(await currentHash(page.id));
    }
    expect(ids(await search('who gets woken up at night'))[0]).toBe(pages[0]!.id);
    expect(ids(await search('newcomers who will join'))[0]).toBe(pages[2]!.id);

    // The live path agrees: its jobs find nothing to do on the backfilled rows.
    vi.mocked(embedTexts).mockClear();
    await drain();
    expect(embedTexts).not.toHaveBeenCalled();

    const second = capture();
    expect(await runBackfill([`--project=${projectId()}`], { out: second })).toBe(0);
    expect(embedTexts).not.toHaveBeenCalled();
    expect(await adminDb.pageEmbedding.count()).toBe(3);
    expect(second.lines).toContain('[backfill-page-embeddings] embedded 3 of 3 live pages.');
  });
});

// ── 11. Paging the fused ranking ────────────────────────────────────────────

describe('paging', () => {
  it('pages the fused ranking with nextCursor, never repeating a page, and refuses an unissued cursor', async () => {
    const total = PAGE_SEARCH_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      await create(`Note ${i}`, i % 2 === 0 ? 'zephyr pager' : 'zephyr budget');
    }
    await drain();

    const seen: Array<{ id: string; rank: number }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result: PageSearchResultDto = await search('zephyr pager', cursor);
      expect(result.mode).toBe('merged');
      const last = seen.at(-1);
      const head = result.items[0];
      if (last && head) {
        expect(head.rank < last.rank || (head.rank === last.rank && head.id < last.id)).toBe(true);
      }
      seen.push(...result.items.map((h) => ({ id: h.id, rank: h.rank })));
      cursor = result.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(2);
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((h) => h.id)).size).toBe(total);

    await expect(search('zephyr pager', 'eyJyIjoxLCJpIjoiZm9yZ2VkIn0')).rejects.toBeInstanceOf(
      PageLevelCursorInvalidError,
    );
    const res = await searchPagesV1(caller, caller.projectKey, {
      q: 'zephyr pager',
      cursor: 'forged',
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('PAGE_CURSOR_INVALID');
  });
});

// ── 12. One answer on every surface ─────────────────────────────────────────

describe('service, REST and MCP agree', () => {
  it('returns the same ids, order, mode and message for one query, and OpenAPI lists exactly three modes', async () => {
    await create('Pager rota', 'Overnight incident zephyr.');
    await create('Incident review', 'Pager zephyr.');
    await create('Finance', 'Budget invoice.');
    await drain();
    const q = 'who gets woken up at night';

    const service = await search(q);
    const rest = (await (
      await searchPagesV1(caller, caller.projectKey, { q })
    ).json()) as V1PageSearchResult;
    const client = await connectMcp(caller.ctx);
    const tool = (
      (await client.callTool({
        name: 'search_pages',
        arguments: { projectKey: caller.projectKey, q },
      })) as CallToolResult
    ).structuredContent as unknown as V1PageSearchResult;

    expect(service.mode).toBe('merged');
    expect(service.items).toHaveLength(3);
    for (const surface of [rest, tool]) {
      expect(surface.items.map((h) => h.id)).toEqual(ids(service));
      expect(surface.mode).toBe(service.mode);
      expect(surface.message).toBe(service.message);
      expect(surface.nextCursor).toBe(service.nextCursor);
    }

    const document = emitOpenApiDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const ok = (
      document.paths['/api/v1/projects/{projectKey}/pages/search']!['get']!['responses'] as Record<
        string,
        { content: Record<string, { schema: Record<string, unknown> }> }
      >
    )['200']!;
    let schema = ok.content['application/json']!.schema;
    if (typeof schema['$ref'] === 'string') {
      schema = document.components.schemas[schema['$ref'].split('/').pop()!]!;
    }
    const mode = (schema['properties'] as Record<string, { enum?: string[] }>)['mode']!;
    expect(mode.enum).toEqual(['merged', 'full-text-only', 'not-indexed']);
  });
});

// ── 13. Architecture: one predicate, one access check, leaf repositories ────

describe('architecture', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');

  function searchPagesSource(): string {
    const source = read('lib/services/pagesService.ts');
    const start = source.indexOf('  async searchPages(');
    const end = source.indexOf('\n  /**', start);
    expect(start).toBeGreaterThan(0);
    return source.slice(start, end);
  }

  const SOURCES: Array<[string, () => string]> = [
    ['pageEmbeddingsService', () => read('lib/services/pageEmbeddingsService.ts')],
    ['pageEmbeddingRepository', () => read('lib/repositories/pageEmbeddingRepository.ts')],
    ['pagesService.searchPages', searchPagesSource],
    ['pageEmbeddingBackfillService', () => read('lib/services/pageEmbeddingBackfillService.ts')],
  ];

  it.each(SOURCES)(
    '%s writes no archived, project or page:view predicate of its own',
    (_name, source) => {
      const text = source();
      // SQL and Prisma forms of an archived or project filter.
      expect(text).not.toMatch(/archived_at"?\s+IS\s+(NOT\s+)?NULL/i);
      expect(text).not.toMatch(/archivedAt\s*:\s*(null|\{)/);
      expect(text).not.toMatch(/[a-z]\."project_id"\s*=/);
      expect(text).not.toMatch(/"project_id"\s*=\s*\$\{/);
      expect(text).not.toMatch(/where\s*:\s*\{[^}]*projectId/);
      // Access is decided by `authorizePageSearch` and nothing else.
      expect(text).not.toMatch(/'page:view'/);
      expect(text).not.toMatch(/assertCanViewPages/);
    },
  );

  it('searchPages reads its access through authorizePageSearch and its rows through PAGE_SEARCH_LIVE_IN_PROJECT', () => {
    expect(searchPagesSource().match(/authorizePageSearch\(/g)).toHaveLength(1);
    const repository = read('lib/repositories/pageEmbeddingRepository.ts');
    expect(repository.match(/\$\{PAGE_SEARCH_LIVE_IN_PROJECT\(/g)?.length).toBeGreaterThan(0);
    expect(read('lib/repositories/pageRepository.ts')).toMatch(
      /export function PAGE_SEARCH_LIVE_IN_PROJECT\(/,
    );
  });

  it('no repository on the path calls another: imports from a sibling are SQL fragments and constants only', () => {
    for (const path of [
      'lib/repositories/pageEmbeddingRepository.ts',
      'lib/repositories/pageRepository.ts',
    ]) {
      const text = read(path);
      const sibling = [
        ...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/lib\/repositories\/[^']+'/g),
      ];
      for (const [, names] of sibling) {
        for (const name of names!
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)) {
          expect(name, `${path} imports ${name}`).not.toMatch(/Repository$/);
        }
      }
      // Outside its imports, no call into another repository object.
      const body = text.replace(/^(import|export)\s[^;]*from\s*'[^']+';$/gm, '');
      const own = path.includes('pageEmbedding') ? 'pageEmbeddingRepository' : 'pageRepository';
      const calls = [...body.matchAll(/\b(\w+Repository)\.\w+\(/g)].map((m) => m[1]);
      expect(
        calls.filter((c) => c !== own),
        path,
      ).toEqual([]);
    }
  });
});
