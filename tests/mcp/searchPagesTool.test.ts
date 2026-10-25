import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pageSearchHitSchema } from '@/lib/api/v1/pages/schema';
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
    expect(Object.keys(result).sort()).toEqual(['items', 'nextCursor']);
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

  it('answers an empty list, not an error, when nothing matches', async () => {
    await seed('Roadmap', 'zephyr');
    const client = await connectClient(fx.ctx);
    const res = await search(client, { q: 'mistral' });
    expect(res.isError).toBeFalsy();
    expect((res as CallToolResult).structuredContent).toEqual({ items: [], nextCursor: null });
    expect(textOf(res)).toContain('No live page in PROD matches "mistral"');
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
