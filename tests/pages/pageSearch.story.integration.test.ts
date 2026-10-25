import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GET as GET_OPENAPI } from '@/app/api/openapi/v1.json/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { pagesService, PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createV1ProjectCaller,
  type V1Caller,
  type V1ProjectCaller,
} from '../fixtures/apiV1Fixtures';
import {
  PAGE_EDITOR,
  createPageV1,
  memberCaller,
  searchPagesV1,
  updatePageV1,
} from '../fixtures/apiV1PageFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { stripComments } from '../helpers/v1RouteAudit';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// The page-search STORY gate (Story MOTIR-9489 · MOTIR-9554), over real
// Postgres and the assembled surface: the REST handler, the MCP tool, the
// service, the write doors and the published contracts. It asserts the seams the
// per-door tests cannot reach on their own:
//
//   1. the two doors AGREE — the same hits in the same order with the same place,
//      snippet and rank, and the same refusal code for the same input;
//   2. every markdown write door (REST, MCP, the service the app uses) is
//      searchable the moment it commits, with no indexing step, and an update or
//      an archive stops a word matching;
//   3. there is ONE access filter (`authorizePageSearch`), checked at the source;
//   4. the published OpenAPI document and the MCP listing carry the search.
//
// Ranking order, the cursor codec and the snippet's form belong to
// `tests/services/pagesService.searchPages.test.ts`; nothing here re-asserts them.

const REPO_ROOT = process.cwd();
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

// ── The two doors, each normalised to the same shape ────────────────────────

interface Hit {
  id: string;
  title: string;
  place: { folderPath: string[]; parentPageTitle: string | null };
  snippet: string;
  rank: number;
}
interface Answer {
  ok: boolean;
  /** The refusal's code on a refusal; `null` on a page of hits. */
  code: string | null;
  items: Hit[];
  nextCursor: string | null;
  /** Everything the caller received, to assert nothing leaked into it. */
  raw: string;
}

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const contextOf = (caller: V1Caller): ServiceContext => ({
  userId: caller.user.id,
  workspaceId: caller.workspace.id,
});

async function viaRest(
  caller: V1Caller,
  projectKey: string,
  query: { q?: string; cursor?: string },
): Promise<Answer> {
  const res = await searchPagesV1(caller, projectKey, query);
  const raw = await res.text();
  const body = JSON.parse(raw) as Record<string, unknown>;
  if (res.status !== 200) {
    return { ok: false, code: String(body.code), items: [], nextCursor: null, raw };
  }
  return {
    ok: true,
    code: null,
    items: body.items as Hit[],
    nextCursor: body.nextCursor as string | null,
    raw,
  };
}

async function viaMcp(
  client: Client,
  projectKey: string,
  query: { q?: string; cursor?: string },
): Promise<Answer> {
  const res = (await client.callTool({
    name: 'search_pages',
    arguments: { projectKey, q: query.q ?? '', ...(query.cursor ? { cursor: query.cursor } : {}) },
  })) as CallToolResult;
  const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  const raw = `${text}\n${JSON.stringify(res.structuredContent ?? null)}`;
  if (res.isError) {
    return { ok: false, code: text.split(':')[0]!, items: [], nextCursor: null, raw };
  }
  const result = res.structuredContent as { items: Hit[]; nextCursor: string | null };
  return { ok: true, code: null, items: result.items, nextCursor: result.nextCursor, raw };
}

/** Both doors, asserted to agree, answering the one agreed result. */
async function bothDoors(
  rest: V1Caller,
  client: Client,
  projectKey: string,
  query: { q?: string; cursor?: string },
): Promise<Answer> {
  const [r, m] = [await viaRest(rest, projectKey, query), await viaMcp(client, projectKey, query)];
  expect({ ok: m.ok, code: m.code, items: m.items, nextCursor: m.nextCursor }).toEqual({
    ok: r.ok,
    code: r.code,
    items: r.items,
    nextCursor: r.nextCursor,
  });
  return r;
}

const ids = (a: Answer) => a.items.map((h) => h.id);

/** A member who can browse the project but whose role does not confer `page:view`. */
async function memberWithRole(owner: V1ProjectCaller, tag: string, permissions: string[]) {
  const member = await memberCaller(owner, tag, 'member', ['project:browse', 'page:view']);
  const role = await createCustomRoleAs({ ctx: owner.ctx, name: `Role ${tag}`, permissions });
  await setProjectRoleDefinitionFor(member.user.id, owner.fixture.projectId, {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return member;
}

// ── 1. Cross-door agreement, and what never appears ─────────────────────────

describe('the REST route and the MCP tool agree', () => {
  it('return the same hits for one corpus, never an archived or a foreign page, and no body', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const { projectId } = owner.fixture;
    const a = await pagesService.createPageFromMarkdown(owner.ctx, {
      projectId,
      title: 'Quarterly roadmap',
      markdown: 'The zephyr launch is in spring.',
    });
    const b = await pagesService.createPageFromMarkdown(owner.ctx, {
      projectId,
      title: 'Zephyr retro',
    });
    const c = await pagesService.createPageFromMarkdown(owner.ctx, {
      projectId,
      title: 'Gone',
      markdown: 'zephyr',
    });
    await pagesService.archivePage(owner.ctx, { projectId, pageId: c.id });
    const other = await createTestProject({
      workspaceId: owner.workspace.id,
      actorUserId: owner.fixture.ownerId,
      identifier: 'OTHR',
    });
    await pagesService.createPageFromMarkdown(owner.ctx, {
      projectId: other.id,
      title: 'Elsewhere',
      markdown: 'zephyr',
    });
    const client = await connect(owner.ctx);

    const answer = await bothDoors(owner, client, owner.projectKey, { q: 'zephyr' });
    expect(new Set(ids(answer))).toEqual(new Set([a.id, b.id]));
    for (const hit of answer.items) {
      expect(Object.keys(hit).sort()).toEqual(['id', 'place', 'rank', 'snippet', 'title']);
    }
    expect(answer.nextCursor).toBeNull();
    const mcp = await viaMcp(client, owner.projectKey, { q: 'zephyr' });
    for (const raw of [answer.raw, mcp.raw]) {
      expect(raw).not.toMatch(/"(markdown|body|bodyText|total|count)"/);
      expect(raw).not.toContain('Gone');
      expect(raw).not.toContain('Elsewhere');
    }
    await client.close();
  });

  it('page 25 hits as 20 then 5 on both doors, with the same ids and no repeat or gap', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const created = new Set<string>();
    for (let i = 0; i < PAGE_SEARCH_LIMIT + 5; i++) {
      const page = await pagesService.createPageFromMarkdown(owner.ctx, {
        projectId: owner.fixture.projectId,
        title: `Spec ${i}`,
        markdown: Array.from({ length: (i % 3) + 1 }, () => 'zephyr').join(' '),
      });
      created.add(page.id);
    }
    const client = await connect(owner.ctx);

    const first = await bothDoors(owner, client, owner.projectKey, { q: 'zephyr' });
    expect(first.items).toHaveLength(PAGE_SEARCH_LIMIT);
    expect(first.nextCursor).not.toBeNull();
    const second = await bothDoors(owner, client, owner.projectKey, {
      q: 'zephyr',
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const seen = [...ids(first), ...ids(second)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(created);
    await client.close();
  });

  it('refuse the same four query inputs by the same code, returning no page', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    await pagesService.createPageFromMarkdown(owner.ctx, {
      projectId: owner.fixture.projectId,
      title: SECRET_TITLE,
      markdown: 'zephyr',
    });
    const client = await connect(owner.ctx);
    const cases: Array<[{ q?: string; cursor?: string }, string]> = [
      [{ q: '' }, 'PAGE_SEARCH_QUERY_EMPTY'],
      [{ q: '   ' }, 'PAGE_SEARCH_QUERY_EMPTY'],
      [{ q: 'a'.repeat(201) }, 'PAGE_SEARCH_QUERY_TOO_LONG'],
      [{ q: 'zephyr', cursor: 'not-a-cursor-we-issued' }, 'PAGE_CURSOR_INVALID'],
    ];
    for (const [query, code] of cases) {
      const res = await searchPagesV1(owner, owner.projectKey, query);
      expect(res.status, `${code} on REST`).toBe(422);
      const answer = await bothDoors(owner, client, owner.projectKey, query);
      expect(answer).toMatchObject({ ok: false, code, items: [] });
      expect(answer.raw).not.toContain(SECRET_TITLE);
    }
    await client.close();
  });
});

// ── 2. Every write door keeps the index current ─────────────────────────────

describe('every markdown write door is searchable at once, on both doors', () => {
  it('the REST create and update routes', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const client = await connect(owner.ctx);
    const created = await createPageV1(owner, owner.projectKey, {
      title: 'Kestrel notes',
      markdown: 'The zephyr launch',
    });
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string; revision: number };

    const found = await bothDoors(owner, client, owner.projectKey, { q: 'zephyr' });
    expect(ids(found)).toEqual([page.id]);
    expect(found.items[0]!.snippet).toContain('zephyr');
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'kestrel' }))).toEqual([
      page.id,
    ]);

    const updated = await updatePageV1(owner, page.id, {
      markdown: 'The mistral launch',
      revision: page.revision,
    });
    expect(updated.status).toBe(200);
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'zephyr' }))).toEqual([]);
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'mistral' }))).toEqual([
      page.id,
    ]);
    await client.close();
  });

  it('the MCP create_page, update_page and rename_page tools', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const client = await connect(owner.ctx);
    const created = (await client.callTool({
      name: 'create_page',
      arguments: { projectKey: owner.projectKey, title: 'Kestrel notes', markdown: 'zephyr' },
    })) as CallToolResult;
    expect(created.isError).toBeFalsy();
    const page = created.structuredContent as { id: string; revision: number };
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'zephyr' }))).toEqual([
      page.id,
    ]);

    const saved = (await client.callTool({
      name: 'update_page',
      arguments: {
        projectKey: owner.projectKey,
        pageId: page.id,
        markdown: 'mistral',
        revision: page.revision,
      },
    })) as CallToolResult;
    expect(saved.isError).toBeFalsy();
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'zephyr' }))).toEqual([]);
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'mistral' }))).toEqual([
      page.id,
    ]);

    const renamed = (await client.callTool({
      name: 'rename_page',
      arguments: { projectKey: owner.projectKey, pageId: page.id, title: 'Osprey notes' },
    })) as CallToolResult;
    expect(renamed.isError).toBeFalsy();
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'kestrel' }))).toEqual([]);
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'osprey' }))).toEqual([
      page.id,
    ]);
    await client.close();
  });

  it('the service the app writes through — body save, rename, then archive', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const { projectId } = owner.fixture;
    const client = await connect(owner.ctx);
    const page = await pagesService.createPageFromMarkdown(owner.ctx, {
      projectId,
      title: 'Kestrel notes',
      markdown: 'zephyr',
    });
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'zephyr' }))).toEqual([
      page.id,
    ]);

    await pagesService.savePageMarkdown(owner.ctx, {
      projectId,
      pageId: page.id,
      markdown: 'mistral',
      expectedRevision: page.revision,
    });
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'zephyr' }))).toEqual([]);
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'mistral' }))).toEqual([
      page.id,
    ]);

    await pagesService.renamePage(owner.ctx, { projectId, pageId: page.id, title: 'Osprey' });
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'kestrel' }))).toEqual([]);
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'osprey' }))).toEqual([
      page.id,
    ]);

    await pagesService.archivePage(owner.ctx, { projectId, pageId: page.id });
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'mistral' }))).toEqual([]);
    expect(ids(await bothDoors(owner, client, owner.projectKey, { q: 'osprey' }))).toEqual([]);
    await client.close();
  });
});

// ── 3. One access filter ────────────────────────────────────────────────────

describe('one access filter, on both doors', () => {
  it('a member without page:view is refused by name before the query or cursor is read', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    await pagesService.createPageFromMarkdown(owner.ctx, {
      projectId: owner.fixture.projectId,
      title: SECRET_TITLE,
      markdown: 'zephyr',
    });
    const member = await memberWithRole(owner, 'noview', ['project:browse', 'work_item:view']);
    const client = await connect(contextOf(member));
    for (const query of [{ q: '', cursor: 'garbage' }, { q: '   ' }, { q: 'zephyr' }]) {
      const res = await searchPagesV1(member, owner.projectKey, query);
      expect(res.status).toBe(403);
      const answer = await bothDoors(member, client, owner.projectKey, query);
      expect(answer).toMatchObject({ ok: false, code: 'PROJECT_ACCESS_DENIED', items: [] });
      const mcp = await viaMcp(client, owner.projectKey, query);
      for (const raw of [answer.raw, mcp.raw]) {
        expect(raw).not.toContain(SECRET_TITLE);
        expect(raw).not.toContain('zephyr');
      }
    }
    await client.close();
  });

  it('a member who cannot browse gets the not-found answer, as get_page gives it', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const page = await pagesService.createPageFromMarkdown(owner.ctx, {
      projectId: owner.fixture.projectId,
      title: SECRET_TITLE,
      markdown: 'zephyr',
    });
    const member = await memberWithRole(owner, 'nobrowse', ['work_item:view']);
    const client = await connect(contextOf(member));

    const rest = await viaRest(member, owner.projectKey, { q: 'zephyr' });
    expect(rest).toMatchObject({ ok: false, code: 'PAGE_NOT_FOUND' });
    const mcp = await viaMcp(client, owner.projectKey, { q: 'zephyr' });
    const read = (await client.callTool({
      name: 'get_page',
      arguments: { projectKey: owner.projectKey, pageId: page.id },
    })) as CallToolResult;
    expect(mcp.ok).toBe(false);
    expect(mcp.raw.split('\n')[0]).toBe(
      (read.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
    );
    for (const raw of [rest.raw, mcp.raw]) expect(raw).not.toContain(SECRET_TITLE);
    await client.close();
  });
});

describe('one access filter, at the source', () => {
  const read = (path: string) => stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'));

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  /** The body of `pagesService.<name>(…)`, from its signature to the next method. */
  function methodBody(source: string, name: string): string {
    const start = source.indexOf(`async ${name}(`);
    expect(start, `pagesService.${name} exists`).toBeGreaterThan(-1);
    const next = source.indexOf('\n  async ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  it('the full-text search reaches assertCanViewPages only through authorizePageSearch', () => {
    const service = read('lib/services/pagesService.ts');
    const search = methodBody(service, 'searchPages');
    expect(search, 'pagesService.searchPages calls authorizePageSearch').toMatch(
      /\bauthorizePageSearch\s*\(/,
    );
    expect(search, 'pagesService.searchPages writes no check of its own').not.toMatch(
      /\bassertCan\w+\s*\(/,
    );
    const repository = read('lib/repositories/pageRepository.ts');
    expect(
      methodBody(repository, 'searchLiveFullText'),
      'pageRepository.searchLiveFullText checks no access',
    ).not.toMatch(/\bassertCan\w+\s*\(/);
    expect(read('lib/pages/pageSearchAccess.ts'), 'authorizePageSearch IS the check').toMatch(
      /\bassertCanViewPages\s*\(/,
    );
    // The title-only searches keep their own calls; they are a different door.
    for (const titleOnly of ['searchPagesForLink', 'searchPagesForMention']) {
      expect(methodBody(service, titleOnly)).toMatch(/\bassertCanViewPages\s*\(/);
    }
  });

  it('the route and the tool call the service and nothing beneath it', () => {
    for (const [file, call] of [
      ['app/api/v1/projects/[projectKey]/pages/search/route.ts', 'pagesService.searchPages'],
      ['lib/mcp/tools/searchPages.ts', 'pagesService.searchPages'],
    ] as const) {
      const source = read(file);
      expect(source, `${file} calls ${call}`).toContain(`${call}(`);
      expect(source, `${file} imports no repository or db`).not.toMatch(
        /from\s+['"]@\/lib\/(db|repositories\/[^'"]+)['"]/,
      );
      expect(source, `${file} spells no SQL`).not.toMatch(/\$queryRaw|Prisma\.sql|Prisma\.raw/);
      expect(source, `${file} writes no access check`).not.toMatch(
        /\bassertCan\w+\s*\(|\bauthorizePageSearch\s*\(/,
      );
    }
  });

  it('the search document is spelled once in application code, in pageRepository', () => {
    const offenders = ['lib', 'app']
      .flatMap((root) => walk(join(REPO_ROOT, root)))
      .map((path) => relative(REPO_ROOT, path).split(sep).join('/'))
      .filter((file) => file !== 'lib/repositories/pageRepository.ts')
      .filter((file) => /\bto_tsvector\s*\(/.test(read(file)));
    expect(offenders, 'files that spell to_tsvector outside pageRepository').toEqual([]);
    expect(read('lib/repositories/pageRepository.ts')).toMatch(
      /export const PAGE_SEARCH_DOCUMENT\s*=\s*Prisma\.sql`to_tsvector\(/,
    );
  });
});

// ── 4. The published contracts ──────────────────────────────────────────────

describe('the published contracts carry the search', () => {
  it('the served OpenAPI document has searchPages with q, cursor and its refusals', async () => {
    const res = await GET_OPENAPI();
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const op = doc.paths['/api/v1/projects/{projectKey}/pages/search']?.get as
      | { operationId: string; parameters: Array<{ name: string; in: string }>; responses: object }
      | undefined;
    expect(op?.operationId).toBe('searchPages');
    expect(op!.parameters.map((p) => `${p.in}:${p.name}`).sort()).toEqual(
      ['path:projectKey', 'query:cursor', 'query:q'].sort(),
    );
    expect(Object.keys(op!.responses)).toEqual(
      expect.arrayContaining(['200', '403', '404', '422']),
    );
  });

  it('the MCP server lists search_pages, gated on page:view', async () => {
    const owner = await createV1ProjectCaller({ permissions: PAGE_EDITOR });
    const client = await connect(owner.ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'search_pages');
    expect(tool).toBeDefined();
    expect(Object.keys((tool!.inputSchema as { properties: object }).properties).sort()).toEqual([
      'cursor',
      'projectKey',
      'q',
    ]);
    expect(TOOL_PERMISSIONS.search_pages).toBe('page:view');
    await client.close();
  });
});
