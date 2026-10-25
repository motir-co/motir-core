import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  createPage,
  emptyState,
  markdownToUpdate,
  pageStoreFor,
  renamePage,
  savePageUpdate,
  systemClock,
} from '@/lib/pages';
import {
  PAGE_SEARCH_BODY_LIMIT,
  PAGE_SEARCH_CONFIG,
  PAGE_SEARCH_DOCUMENT,
} from '@/lib/repositories/pageRepository';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The page SEARCH INDEX on real Postgres (Story MOTIR-9489 · MOTIR-9550):
// `page_search_gin_idx` is a GIN index over the exact expression
// `PAGE_SEARCH_DOCUMENT` spells, so every write door — insert, body save,
// rename — is searchable the moment it commits, with no indexing step, and a
// body larger than a `tsvector` can hold still saves.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function makeTenant(tag: string): Promise<Tenant> {
  const user = await usersService.createUser({
    email: `page-search-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Page Search ${tag}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Page Search ${tag}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: user.id,
    name: `Page Search ${tag}`,
    identifier: `PS${tag.toUpperCase()}`,
  });
  return { userId: user.id, workspaceId: ws.workspace.id, projectId: project.id };
}

const inTenant = <T>(t: Tenant, fn: Parameters<typeof withWorkspaceContext<T>>[1]) =>
  withWorkspaceContext(
    { userId: t.userId, workspaceId: t.workspaceId, projectId: t.projectId },
    fn,
  );

/** Whether `PAGE_SEARCH_DOCUMENT` matches `word` for the page — read straight after the write. */
async function matches(pageId: string, word: string): Promise<boolean> {
  const rows = await adminDb.$queryRaw<Array<{ id: string }>>`
    SELECT p."id" FROM "page" p
    WHERE p."id" = ${pageId}
      AND ${PAGE_SEARCH_DOCUMENT} @@ plainto_tsquery(${Prisma.raw(`'${PAGE_SEARCH_CONFIG}'`)}, ${word})`;
  return rows.length === 1;
}

/** `n` characters of distinct words — the worst case for a `tsvector`'s size. */
function distinctWords(n: number): string {
  let out = '';
  for (let i = 0; out.length < n; i += 1) out += `w${i.toString(36)} `;
  return out.slice(0, n);
}

describe('page_search_gin_idx', () => {
  it('exists as a GIN index on page, and the shared expression is served by it', async () => {
    const [index] = await adminDb.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'page_search_gin_idx'`;
    expect(index?.def).toMatch(/ON public\.page USING gin \(to_tsvector\('simple'::regconfig/);
    expect(index?.def).toContain(`${PAGE_SEARCH_BODY_LIMIT}`);

    const plan = await adminDb.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN SELECT p."id" FROM "page" p
        WHERE ${PAGE_SEARCH_DOCUMENT} @@ plainto_tsquery('simple', ${'zephyr'})`;
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('page_search_gin_idx');
  });

  it('matches a title word and a body word on every write door, with no step between', async () => {
    const t = await makeTenant('doors');
    const page = await inTenant(t, (tx) =>
      createPage(pageStoreFor(tx), systemClock, {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        actorId: t.userId,
        title: 'Quarterly roadmap',
      }),
    );
    expect(await matches(page.id, 'quarterly')).toBe(true);
    expect(await matches(page.id, 'zephyr')).toBe(false);

    await inTenant(t, (tx) =>
      savePageUpdate(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: t.userId,
        update: markdownToUpdate(emptyState(), 'The zephyr launch'),
      }),
    );
    expect(await matches(page.id, 'zephyr')).toBe(true);
    expect(await matches(page.id, 'roadmap')).toBe(true);

    const base = (await adminDb.page.findUniqueOrThrow({ where: { id: page.id } })).bodyState;
    await inTenant(t, (tx) =>
      savePageUpdate(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: t.userId,
        update: markdownToUpdate(new Uint8Array(base), 'The mistral launch'),
      }),
    );
    expect(await matches(page.id, 'zephyr')).toBe(false);
    expect(await matches(page.id, 'mistral')).toBe(true);

    await inTenant(t, (tx) =>
      renamePage(pageStoreFor(tx), { pageId: page.id, actorId: t.userId, title: 'Annual plan' }),
    );
    expect(await matches(page.id, 'annual')).toBe(true);
    expect(await matches(page.id, 'quarterly')).toBe(false);
  });

  it('writes a 2 MiB body through insertPage and updateBody, and finds a word before the cut', async () => {
    const t = await makeTenant('big');
    const big = distinctWords(2 * 1024 * 1024);
    const body = (text: string, revision: number) => ({
      state: emptyState(),
      json: { type: 'doc', content: [{ type: 'paragraph' }] },
      markdown: text,
      text,
      revision,
      updatedById: t.userId,
      updatedAt: new Date(),
    });
    const page = await inTenant(t, (tx) =>
      pageStoreFor(tx).insertPage({
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        title: 'Big',
        parentPageId: null,
        folderId: null,
        position: 'a0',
        ancestorPageIds: [],
        body: body(`zephyr ${big}`, 1),
        createdById: t.userId,
        createdAt: new Date(),
      }),
    );
    expect(await matches(page.id, 'zephyr')).toBe(true);
    // A word inside the first PAGE_SEARCH_BODY_LIMIT characters is found.
    expect(await matches(page.id, 'w100')).toBe(true);

    await inTenant(t, (tx) =>
      pageStoreFor(tx).updateBody(page.id, body(`${big.slice(0, -8)} mistral`, 2)),
    );
    expect(await matches(page.id, 'zephyr')).toBe(false);
    expect(await matches(page.id, 'w100')).toBe(true);
    // The last word of a 2 MiB body is past the cut, so it is not searchable.
    expect(await matches(page.id, 'mistral')).toBe(false);
  });
});
