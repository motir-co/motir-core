import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pageSearchHitSchema, type V1PageSearchResult } from '@/lib/api/v1/pages/schema';
import { renderHits } from '@/lib/mcp/tools/searchPages';
import { pageEmbeddingRepository } from '@/lib/repositories/pageEmbeddingRepository';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import {
  MCP_TOOL_SCHEMAS_FILE,
  generateMcpToolSchemas,
} from '../../scripts/generateMcpToolSchemas';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { PageSearchQueryEmptyError, PageSearchQueryTooLongError } from '@/lib/pages/searchErrors';
import { pagesService, PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// `search_pages` (Story MOTIR-9489 · MOTIR-9553) over real Postgres, driven
// through `buildMcpServer` + an in-memory client — the `getPageTool.test.ts`
// pattern. The tool is a thin adapter over `pagesService.searchPages`, so this
// asserts the adapter half: hits by a body word and a title word in both the
// text and `structuredContent`, the access filter and every named refusal by
// the SAME code `tests/api/v1/pages-search-route.test.ts` asserts on REST, and
// paging by the returned cursor.

const SECRET_TITLE = 'Acquisition plan confidential';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext, grant?: readonly string[]): Promise<Client> {
  const server = grant
    ? buildMcpServer(
        () => ctx,
        () => [...grant] as never,
      )
    : buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

const seed = (title: string, markdown?: string, projectId = fx.projectId) =>
  pagesService.createPageFromMarkdown(fx.ctx, { projectId, title, markdown });

interface SearchResult {
  items: Array<{ id: string; title: string; snippet: string; rank: number }>;
  nextCursor: string | null;
  mode: 'merged' | 'full-text-only' | 'not-indexed';
  message: string | null;
}

async function search(client: Client, args: Record<string, unknown>) {
  return client.callTool({ name: 'search_pages', arguments: { projectKey: 'PROD', ...args } });
}

/** A member who can browse the project but whose role no longer confers `page:view`. */
async function browseOnlyMember(): Promise<ServiceContext> {
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'Browser',
    permissions: ['project:browse', 'work_item:view'],
  });
  const user = await usersService.createUser({
    email: 'search-pages-browse@example.com',
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

describe('search_pages', () => {
  it('finds a page by a body word, in the text and as { id, title, place, snippet, rank }', async () => {
    const page = await seed('Quarterly roadmap', 'The zephyr launch is in spring.');
    const client = await connectClient(fx.ctx);

    const res = await search(client, { q: 'zephyr' });
    expect(res.isError).toBeFalsy();
    const result = (res as CallToolResult).structuredContent as unknown as SearchResult;
    expect(Object.keys(result).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
    expect(result.mode).toBe('full-text-only');
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(1);
    expect(pageSearchHitSchema.strict().safeParse(result.items[0]).success).toBe(true);
    expect(result.items[0]).toMatchObject({ id: page.id, title: 'Quarterly roadmap' });
    expect(result.items[0]!.snippet).toContain('zephyr');

    const text = textOf(res);
    expect(text).toContain(`Quarterly roadmap (${page.id})`);
    expect(text).toContain('project root');
    expect(text).toContain('zephyr launch');
    expect(text).toContain('No more hits.');
    await client.close();
  });

  it('finds a page by a title word', async () => {
    const page = await seed('Zephyr retro');
    const client = await connectClient(fx.ctx);
    const res = await search(client, { q: 'retro' });
    const result = (res as CallToolResult).structuredContent as unknown as SearchResult;
    expect(result.items.map((h) => h.id)).toEqual([page.id]);
    await client.close();
  });

  it("never returns an archived page or another project's page", async () => {
    const live = await seed('Live', 'zephyr');
    const gone = await seed('Gone', 'zephyr');
    await adminDb.page.update({
      where: { id: gone.id },
      data: { archivedAt: new Date(), archiveRootId: gone.id },
    });
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    await seed('Elsewhere', 'zephyr', other.id);
    const client = await connectClient(fx.ctx);

    const res = await search(client, { q: 'zephyr' });
    const result = (res as CallToolResult).structuredContent as unknown as SearchResult;
    expect(result.items.map((h) => h.id)).toEqual([live.id]);
    expect(textOf(res)).not.toContain('Gone');
    expect(textOf(res)).not.toContain('Elsewhere');
    await client.close();
  });

  it('pages by the returned cursor, with no repeat', async () => {
    for (let i = 0; i < PAGE_SEARCH_LIMIT + 3; i++) await seed(`Spec ${i}`, 'zephyr');
    const client = await connectClient(fx.ctx);

    const first = await search(client, { q: 'zephyr' });
    const one = (first as CallToolResult).structuredContent as unknown as SearchResult;
    expect(one.items).toHaveLength(PAGE_SEARCH_LIMIT);
    expect(one.nextCursor).not.toBeNull();
    expect(textOf(first)).toContain(`cursor "${one.nextCursor}"`);

    const second = await search(client, { q: 'zephyr', cursor: one.nextCursor });
    const two = (second as CallToolResult).structuredContent as unknown as SearchResult;
    expect(two.items).toHaveLength(3);
    expect(two.nextCursor).toBeNull();
    const ids = [...one.items, ...two.items].map((h) => h.id);
    expect(new Set(ids).size).toBe(PAGE_SEARCH_LIMIT + 3);
    await client.close();
  });

  it('answers an empty list, not an error, and does not call a degraded miss a verdict', async () => {
    await seed('Roadmap', 'zephyr');
    const client = await connectClient(fx.ctx);
    const res = await search(client, { q: 'mistral' });
    expect(res.isError).toBeFalsy();
    expect((res as CallToolResult).structuredContent).toMatchObject({
      items: [],
      nextCursor: null,
      mode: 'full-text-only',
    });
    const text = textOf(res);
    expect(text).not.toContain('No live page in PROD matches');
    expect(text).toContain('No word match for "mistral" in PROD');
    expect(text).toContain('semantic search did not run');
    await client.close();
  });
});

describe('search_pages refusals — the same codes the REST route returns', () => {
  it('an empty or whitespace query is PAGE_SEARCH_QUERY_EMPTY, with no page', async () => {
    await seed(SECRET_TITLE, 'zephyr');
    const client = await connectClient(fx.ctx);
    expect(new PageSearchQueryEmptyError().code).toBe('PAGE_SEARCH_QUERY_EMPTY');
    for (const q of ['', '   ']) {
      const res = await search(client, { q });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/^PAGE_SEARCH_QUERY_EMPTY: /);
      expect(textOf(res)).not.toContain(SECRET_TITLE);
      expect((res as CallToolResult).structuredContent).toBeUndefined();
    }
    await client.close();
  });

  it('a query over 200 characters is PAGE_SEARCH_QUERY_TOO_LONG', async () => {
    const client = await connectClient(fx.ctx);
    expect(new PageSearchQueryTooLongError().code).toBe('PAGE_SEARCH_QUERY_TOO_LONG');
    const res = await search(client, { q: 'a'.repeat(201) });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^PAGE_SEARCH_QUERY_TOO_LONG: /);
    await client.close();
  });

  it('a cursor the service did not issue is PAGE_CURSOR_INVALID', async () => {
    await seed('Roadmap', 'zephyr');
    const client = await connectClient(fx.ctx);
    const res = await search(client, { q: 'zephyr', cursor: 'garbage' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^PAGE_CURSOR_INVALID: /);
    await client.close();
  });

  it('a member without page:view gets the access refusal, even with an empty query and a garbage cursor', async () => {
    await seed(SECRET_TITLE, 'zephyr');
    const client = await connectClient(await browseOnlyMember());
    for (const args of [{ q: 'zephyr' }, { q: '', cursor: 'garbage' }, { q: '   ' }]) {
      const res = await search(client, args);
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toMatch(/^PROJECT_ACCESS_DENIED: /);
      expect(text).not.toContain(SECRET_TITLE);
      expect(text).not.toContain('zephyr');
      expect((res as CallToolResult).structuredContent).toBeUndefined();
    }
    await client.close();
  });

  it('a grant without page:view is refused by the gate, naming the key', async () => {
    await seed(SECRET_TITLE, 'zephyr');
    const client = await connectClient(fx.ctx, ['project:browse']);
    const res = await search(client, { q: 'zephyr' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('page:view');
    expect(textOf(res)).not.toContain(SECRET_TITLE);
    await client.close();
  });

  it('an unknown project key is the same not-found answer get_page gives', async () => {
    const client = await connectClient(fx.ctx);
    const searched = await search(client, { projectKey: 'NOPE', q: 'zephyr' });
    const read = await client.callTool({
      name: 'get_page',
      arguments: { projectKey: 'NOPE', pageId: 'whatever' },
    });
    expect(searched.isError).toBe(true);
    expect(textOf(searched)).toBe(textOf(read));
    await client.close();
  });

  it('asserts page:view and is a read-only tool', () => {
    expect(TOOL_PERMISSIONS.search_pages).toBe('page:view');
    expect(TOOL_ANNOTATIONS.search_pages).toMatchObject({ readOnlyHint: true });
  });

  it('calls pagesService.searchPages and nothing else: no repository, db, SQL or own check', () => {
    const source = readFileSync('lib/mcp/tools/searchPages.ts', 'utf8');
    expect(source).toMatch(/pagesService\.searchPages\(/);
    expect(source).not.toMatch(/@\/lib\/(db|repositories)/);
    expect(source).not.toMatch(/\$queryRaw|Prisma\.sql|assertCan|PAGE_SEARCH_QUERY_MAX_LENGTH/);
  });
});

const MODEL = 'text-embedding-3-small';

function axis(n: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === n ? 1 : 0));
}

function blend(a: number, b: number, w: number): number[] {
  const v = Array.from({ length: 1536 }, () => 0);
  v[a] = w;
  v[b] = Math.sqrt(1 - w * w);
  return v;
}

async function seedVector(page: { id: string; projectId: string }, embedding: number[]) {
  await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    pageEmbeddingRepository.upsert(
      {
        pageId: page.id,
        workspaceId: fx.workspaceId,
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

const structured = (res: unknown) =>
  (res as CallToolResult).structuredContent as unknown as SearchResult;

describe('search_pages by meaning (MOTIR-9575)', () => {
  it('returns a meaning-only match in merged mode, the same page pagesService returns', async () => {
    const rota = await seed('On-call rota', 'Pager schedule.');
    await seedVector(rota, axis(1));
    answer(axis(1));
    const client = await connectClient(fx.ctx);

    const res = await search(client, { q: 'who gets woken up at night' });
    const result = structured(res);
    expect(Object.keys(result).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
    expect(result).toMatchObject({ mode: 'merged', message: null });
    expect(result.items.map((h) => h.id)).toEqual([rota.id]);
    const service = await pagesService.searchPages(fx.ctx, {
      projectId: fx.projectId,
      q: 'who gets woken up at night',
    });
    expect(service.items.map((h) => h.id)).toEqual([rota.id]);
    const text = textOf(res);
    expect(text).toContain('Mode: merged — results combine meaning and words.');
    expect(text).toMatch(/score \d\.\d{4}/);
    await client.close();
  });

  it('a word-only match is found, and a page matching both ways appears once, first', async () => {
    const both = await seed('Zephyr runbook', 'zephyr');
    const wordOnly = await seed('Zephyr retro', 'zephyr zephyr zephyr');
    const meaningOnly = await seed('Unrelated', 'nothing in common');
    await seedVector(meaningOnly, axis(3));
    await seedVector(both, blend(3, 4, 0.9));
    answer(axis(3));
    const client = await connectClient(fx.ctx);

    const result = structured(await search(client, { q: 'zephyr' }));
    expect(result.items[0]!.id).toBe(both.id);
    expect(result.items.filter((h) => h.id === both.id)).toHaveLength(1);
    expect(new Set(result.items.map((h) => h.id))).toEqual(
      new Set([both.id, wordOnly.id, meaningOnly.id]),
    );
    await client.close();
  });

  it('archived pages, other projects and members-only projects stay out of a meaning-only search', async () => {
    const live = await seed('Live', 'body');
    const gone = await seed('Gone', 'body');
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Hidden',
      identifier: 'HID',
    });
    await adminDb.project.update({ where: { id: other.id }, data: { accessMode: 'members' } });
    const hidden = await seed(SECRET_TITLE, 'secret body words', other.id);
    await seedVector(live, blend(5, 6, 0.5));
    await seedVector(gone, axis(5));
    await seedVector(hidden, axis(5));
    await adminDb.page.update({
      where: { id: gone.id },
      data: { archivedAt: new Date(), archiveRootId: gone.id },
    });
    answer(axis(5));
    const client = await connectClient(fx.ctx);

    const res = await search(client, { q: 'meaning only' });
    expect(structured(res).items.map((h) => h.id)).toEqual([live.id]);
    const text = textOf(res);
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain('secret body words');
    expect(text).not.toContain('Gone');
    await client.close();
  });

  it('is a successful full-text-only result, with the word hits, when the seam does not answer', async () => {
    const page = await seed('Roadmap', 'zephyr');
    vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockResolvedValue(null);
    const client = await connectClient(fx.ctx);

    const res = await search(client, { q: 'zephyr' });
    expect(res.isError).toBeFalsy();
    const result = structured(res);
    expect(result.mode).toBe('full-text-only');
    expect(result.items.map((h) => h.id)).toEqual([page.id]);
    expect(textOf(res)).toContain(result.message!);
    expect(textOf(res)).toMatch(/did not run/);
    expect(textOf(res)).toMatch(/not evidence/);
    await client.close();
  });

  it('is not-indexed when the seam answers and no page is embedded', async () => {
    const page = await seed('Roadmap', 'zephyr');
    answer(axis(9));
    const client = await connectClient(fx.ctx);

    const res = await search(client, { q: 'zephyr' });
    const result = structured(res);
    expect(result.mode).toBe('not-indexed');
    expect(result.items.map((h) => h.id)).toEqual([page.id]);
    expect(textOf(res)).toContain(result.message!);
    expect(textOf(res)).toMatch(/indexed/);
    await client.close();
  });

  it('every refusal lands before the seam: no access, an empty query, a bad cursor', async () => {
    await seed(SECRET_TITLE, 'zephyr');
    const embed = answer(axis(1));
    const denied = await connectClient(await browseOnlyMember());
    expect(textOf(await search(denied, { q: 'zephyr' }))).toMatch(/^PROJECT_ACCESS_DENIED: /);
    await denied.close();
    const client = await connectClient(fx.ctx);
    expect(textOf(await search(client, { q: '' }))).toMatch(/^PAGE_SEARCH_QUERY_EMPTY: /);
    expect(textOf(await search(client, { q: 'zephyr', cursor: 'garbage' }))).toMatch(
      /^PAGE_CURSOR_INVALID: /,
    );
    expect(embed).not.toHaveBeenCalled();
    await client.close();
  });

  it('pages a merged result by its cursor, with no page twice', async () => {
    const total = PAGE_SEARCH_LIMIT + 3;
    for (let i = 0; i < total; i++) {
      const page = await seed(`Spec ${i}`, i % 2 === 0 ? 'zephyr' : 'other');
      await seedVector(page, blend(10, 11, 0.2 + (0.7 * i) / total));
    }
    answer(axis(10));
    const client = await connectClient(fx.ctx);

    const one = structured(await search(client, { q: 'zephyr' }));
    expect(one.mode).toBe('merged');
    expect(one.items).toHaveLength(PAGE_SEARCH_LIMIT);
    const two = structured(await search(client, { q: 'zephyr', cursor: one.nextCursor }));
    expect(two.items).toHaveLength(3);
    expect(new Set([...one.items, ...two.items].map((h) => h.id)).size).toBe(total);
    await client.close();
  });
});

describe('renderHits', () => {
  const hit = {
    id: 'p1',
    title: 'Rota',
    place: { folderPath: [], parentPageTitle: null },
    snippet: 'Pager schedule',
    rank: 0.0325,
  };
  const result = (over: Partial<V1PageSearchResult>): V1PageSearchResult => ({
    items: [hit],
    nextCursor: null,
    mode: 'merged',
    message: null,
    ...over,
  });

  it('names the mode first and prints a score', () => {
    const text = renderHits('PROD', 'night', result({}));
    expect(text.split('\n')[0]).toBe('Mode: merged — results combine meaning and words.');
    expect(text).toContain('score 0.0325');
    expect(text).toContain('No more hits.');
  });

  it('uses the service message verbatim in a degraded mode', () => {
    const message =
      'Semantic search did not run. This is not evidence that no similar page exists.';
    const text = renderHits('PROD', 'night', result({ mode: 'full-text-only', message }));
    expect(text.split('\n')[0]).toBe(`Mode: full-text-only — ${message}`);
  });

  it('never words an empty degraded result as a final no-match', () => {
    for (const mode of ['full-text-only', 'not-indexed'] as const) {
      const text = renderHits('PROD', 'night', result({ items: [], mode, message: 'm' }));
      expect(text).not.toContain('No live page in PROD matches');
      expect(text).toContain('No word match for "night" in PROD');
      expect(text).toContain('not evidence');
    }
    expect(renderHits('PROD', 'night', result({ items: [] }))).toContain(
      'No live page in PROD matches "night".',
    );
  });
});

describe('search_pages documentation', () => {
  it('describes meaning, the merge and the three modes, and keeps the refusals', async () => {
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'search_pages')!;
    for (const phrase of [
      'by what they mean',
      'merged',
      '`full-text-only`',
      '`not-indexed`',
      'not proof',
      'PAGE_SEARCH_QUERY_EMPTY',
      'PAGE_SEARCH_QUERY_TOO_LONG',
      'Archived',
    ]) {
      expect(tool.description).toContain(phrase);
    }
    const q = (tool.inputSchema.properties as Record<string, { description?: string }>)['q'];
    expect(q?.description).toContain('meaning-only phrase');
    await client.close();
  });

  it('the generated tool schema file is current', async () => {
    expect(readFileSync(MCP_TOOL_SCHEMAS_FILE, 'utf8')).toBe(await generateMcpToolSchemas());
  });
});
