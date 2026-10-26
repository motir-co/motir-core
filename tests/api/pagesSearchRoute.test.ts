import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PAGE_SEARCH_QUERY_MAX_LENGTH } from '@/lib/pages/searchErrors';
import { pageEmbeddingRepository } from '@/lib/repositories/pageEmbeddingRepository';
import { pagesService, PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// `GET /api/pages/search` (Story MOTIR-9491 · MOTIR-9636) — the session door
// over `pagesService.searchPages`, on real Postgres. Only the session gate is
// mocked (and the query-embedding seam in the `merged` case): the access
// filter, the query refusals, the archive and project scoping, the degraded
// `mode` and the cursor are the real service's, read through the route.

const ctxRef = { current: null as ServiceContext | null };
const gateRef = { current: null as Record<string, unknown> | null };

vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantWorkspaceContext: async () =>
    gateRef.current ?? { ok: true, ctx: ctxRef.current },
}));

const { GET } = await import('@/app/api/pages/search/route');

const MODEL = 'text-embedding-3-small';
const axis = (n: number): number[] => Array.from({ length: 1536 }, (_, i) => (i === n ? 1 : 0));

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PSR' });
  ctxRef.current = fx.ctx;
  gateRef.current = null;
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

function call(params: Record<string, string>): Promise<Response> {
  const url = new URL('http://localhost:3000/api/pages/search');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return GET(new Request(url));
}

/** A member of the workspace with no project role: cannot browse the project. */
async function stranger(): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: 'page-search-route-stranger@example.com',
    password: 'hunter2hunter2',
    name: 'Stranger',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

/** A browser of the project whose role does not confer `page:view`. */
async function browseOnlyReader(): Promise<ServiceContext> {
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'Browser',
    permissions: ['project:browse', 'work_item:view'],
  });
  const user = await usersService.createUser({
    email: 'page-search-route-browse@example.com',
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

/** Asserts a refusal body carries no page data at all. */
function expectNoPageData(body: Record<string, unknown>, secretTitle: string): void {
  expect(body).not.toHaveProperty('items');
  expect(body).not.toHaveProperty('snippet');
  expect(JSON.stringify(body)).not.toContain(secretTitle);
}

describe('GET /api/pages/search — hits', () => {
  it('200 with the service DTO, field for field, for a body-only word', async () => {
    const page = await newPage('Quarterly roadmap', 'We plan the zephyr launch.');
    await newPage('Unrelated', 'nothing to see');

    const res = await call({ projectId: fx.projectId, q: 'zephyr' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: page.id,
      title: 'Quarterly roadmap',
      place: { folderPath: [], parentPageTitle: null },
    });
    expect(body.items[0].snippet).toContain('zephyr');
    const direct = await pagesService.searchPages(fx.ctx, {
      projectId: fx.projectId,
      q: 'zephyr',
      cursor: null,
    });
    expect(Object.keys(body).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
    expect(body).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it("never lists an archived page or another project's page", async () => {
    const live = await newPage('Live', 'zephyr here');
    const gone = await newPage('Gone', 'zephyr there');
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PSX',
    });
    await newPage('Elsewhere', 'zephyr elsewhere', other.id);
    await adminDb.page.update({
      where: { id: gone.id },
      data: { archivedAt: new Date(), archiveRootId: gone.id },
    });

    const body = await (await call({ projectId: fx.projectId, q: 'zephyr' })).json();

    expect(body.items.map((h: { id: string }) => h.id)).toEqual([live.id]);
  });

  it('reads full-text-only, with a message, when the embedding seam does not answer', async () => {
    await newPage('Zephyr', 'zephyr');
    const body = await (await call({ projectId: fx.projectId, q: 'zephyr' })).json();
    expect(body.mode).toBe('full-text-only');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('finds a page by meaning alone, in merged mode', async () => {
    const rota = await newPage(
      'On-call rota',
      'Engineers take turns answering overnight incidents.',
    );
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      pageEmbeddingRepository.upsert(
        {
          pageId: rota.id,
          workspaceId: fx.workspaceId,
          projectId: rota.projectId,
          model: MODEL,
          dimensions: 1536,
          contentHash: `hash-${rota.id}`,
          embeddedAt: new Date(),
          embedding: axis(1),
        },
        tx,
      ),
    );
    vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockResolvedValue({
      embedding: axis(1),
      model: MODEL,
    });

    const body = await (
      await call({ projectId: fx.projectId, q: 'who gets woken up when production breaks' })
    ).json();

    expect(body.mode).toBe('merged');
    expect(body.message).toBeNull();
    expect(body.items.map((h: { id: string }) => h.id)).toEqual([rota.id]);
  });
});

describe('GET /api/pages/search — the transport', () => {
  it('400 BAD_REQUEST for a missing projectId, without calling the service', async () => {
    const spy = vi.spyOn(pagesService, 'searchPages');
    const res = await call({ q: 'zephyr' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers the session gate's own response without calling the service", async () => {
    const spy = vi.spyOn(pagesService, 'searchPages');
    gateRef.current = { ok: false, response: new Response(null, { status: 401 }) };
    expect((await call({ projectId: fx.projectId, q: 'zephyr' })).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes `q` to the service untrimmed and unchecked', async () => {
    const spy = vi.spyOn(pagesService, 'searchPages');
    await call({ projectId: fx.projectId, q: '  zephyr  ', cursor: 'c1' });
    await call({ projectId: fx.projectId });
    expect(spy.mock.calls.map((c) => c[1])).toEqual([
      { projectId: fx.projectId, q: '  zephyr  ', cursor: 'c1' },
      { projectId: fx.projectId, q: '', cursor: null },
    ]);
  });
});

describe('GET /api/pages/search — refusals', () => {
  const secret = 'Secret zephyr plan';
  const queries = ['zephyr', '', 'z'.repeat(PAGE_SEARCH_QUERY_MAX_LENGTH + 1)];

  it('404 PAGE_NOT_FOUND for a caller who cannot browse, whatever the query', async () => {
    await newPage(secret, 'zephyr');
    ctxRef.current = await stranger();
    for (const q of queries) {
      const res = await call({ projectId: fx.projectId, q });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });
      expectNoPageData(body, secret);
    }
  });

  it('403 PROJECT_ACCESS_DENIED for a browser without page:view, whatever the query', async () => {
    await newPage(secret, 'zephyr');
    ctxRef.current = await browseOnlyReader();
    for (const q of queries) {
      const res = await call({ projectId: fx.projectId, q });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('PROJECT_ACCESS_DENIED');
      expectNoPageData(body, secret);
    }
  });

  it('422 PAGE_SEARCH_QUERY_TOO_LONG with the limit for a 201-character query', async () => {
    const res = await call({
      projectId: fx.projectId,
      q: ` ${'z'.repeat(PAGE_SEARCH_QUERY_MAX_LENGTH + 1)} `,
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'PAGE_SEARCH_QUERY_TOO_LONG', limit: 200 });
    expect(typeof body.error).toBe('string');
  });

  it('accepts a 200-character query', async () => {
    const res = await call({
      projectId: fx.projectId,
      q: 'z'.repeat(PAGE_SEARCH_QUERY_MAX_LENGTH),
    });
    expect(res.status).toBe(200);
  });

  it('422 PAGE_SEARCH_QUERY_EMPTY for a whitespace or absent query', async () => {
    for (const params of [{ q: '   ' }, {}] as Array<Record<string, string>>) {
      const res = await call({ projectId: fx.projectId, ...params });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('PAGE_SEARCH_QUERY_EMPTY');
      expect(typeof body.error).toBe('string');
    }
  });

  it('400 PAGE_CURSOR_INVALID for a cursor the service did not issue', async () => {
    await newPage('Roadmap', 'zephyr');
    const res = await call({ projectId: fx.projectId, q: 'zephyr', cursor: 'garbage' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PAGE_CURSOR_INVALID');
  });
});

describe('GET /api/pages/search — paging', () => {
  it("serves the next hits for a response's nextCursor, with no id repeated", async () => {
    const total = PAGE_SEARCH_LIMIT + 5;
    for (let i = 0; i < total; i++) await newPage(`Spec ${i}`, `zephyr note ${i}`);

    const first = await (await call({ projectId: fx.projectId, q: 'zephyr' })).json();
    expect(first.items).toHaveLength(PAGE_SEARCH_LIMIT);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await (
      await call({ projectId: fx.projectId, q: 'zephyr', cursor: first.nextCursor })
    ).json();
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.items, ...second.items].map((h: { id: string }) => h.id);
    expect(new Set(ids).size).toBe(total);
  });
});
