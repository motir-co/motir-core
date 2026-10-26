import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { PAGE_SEARCH_QUERY_MAX_LENGTH } from '@/lib/pages/searchErrors';
import { pageEmbeddingRepository } from '@/lib/repositories/pageEmbeddingRepository';
import { pagesService, PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { PageSearchRequestError, searchPages } from '@/components/pages/search/pageSearchClient';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { stripComments } from '../../helpers/v1RouteAudit';
import {
  createCustomRoleAs,
  setProjectRoleDefinitionFor,
} from '../../helpers/workspaceRoleFixtures';

// Story MOTIR-9491 · MOTIR-9639 — the story gate for page search on `/pages`.
// Each build card tests its own side: the route reads its own JSON, the hook
// injects hand-written answers. This gate wires the REAL route handler, on real
// Postgres, as the `fetchImpl` of the REAL client function, so every answer the
// hook's states depend on is checked on the browser side of the seam. No
// response body here is written by hand. The one module mock is the session
// gate, the same one the route test uses (plus the `embedQuery` spy in the
// merged case).
//
// It also holds the route's two story-level promises statically — it writes no
// filter of its own, and `/pages` still refuses before the box renders.

const ctxRef = { current: null as ServiceContext | null };

vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantWorkspaceContext: async () => ({ ok: true, ctx: ctxRef.current }),
}));

const { GET } = await import('@/app/api/pages/search/route');

const ROOT = join(__dirname, '../../..');
const MODEL = 'text-embedding-3-small';
const axis = (n: number): number[] => Array.from({ length: 1536 }, (_, i) => (i === n ? 1 : 0));
const TOO_LONG = 'x'.repeat(PAGE_SEARCH_QUERY_MAX_LENGTH + 1);

let fx: WorkItemFixture;
/** The raw text of every answer the route gave, newest last. */
let bodies: string[];

/** The real route, as the browser's `fetch`. */
const routeFetch = (async (input: RequestInfo | URL) => {
  const res = await GET(new NextRequest(new URL(String(input), 'http://localhost')));
  bodies.push(await res.clone().text());
  return res;
}) as typeof fetch;

const client = (q: string, cursor: string | null = null, projectId = fx.projectId) =>
  searchPages(projectId, q, cursor, { fetchImpl: routeFetch });

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PSG' });
  ctxRef.current = fx.ctx;
  bodies = [];
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

/** A caller with no role on the project: cannot browse it (the route test's stranger). */
async function stranger(): Promise<ServiceContext> {
  const user = await usersService.createUser({
    email: 'page-search-gate-stranger@example.com',
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
    email: 'page-search-gate-browse@example.com',
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

/** The client's typed refusal for `run`, or a failure when it resolves. */
async function refusalOf(run: () => Promise<unknown>): Promise<PageSearchRequestError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(PageSearchRequestError);
    return err as PageSearchRequestError;
  }
  throw new Error('expected the client to throw its typed refusal');
}

describe('Story MOTIR-9491 gate — the route-to-client seam', () => {
  it('a body-word search crosses the seam deep-equal to the service', async () => {
    await newPage('Release plan', 'The zephyr launch moves to May.');
    await newPage('Unrelated', 'Nothing to see.');

    const viaClient = await client('zephyr');
    const direct = await pagesService.searchPages(fx.ctx, {
      projectId: fx.projectId,
      q: 'zephyr',
      cursor: null,
    });

    expect(viaClient).toEqual(direct);
    expect(Object.keys(viaClient).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
    expect(Object.keys(viaClient.items[0]!).sort()).toEqual([
      'id',
      'place',
      'rank',
      'snippet',
      'title',
    ]);
    expect(viaClient.items.map((h) => h.title)).toEqual(['Release plan']);
  });

  it('a degraded answer (no embedding backend) crosses as data, not a refusal', async () => {
    await newPage('Zephyr', 'zephyr notes');
    const result = await client('zephyr');
    expect(result.mode).toBe('full-text-only');
    expect(result.items).toHaveLength(1);
  });

  it('a meaning-only hit crosses in merged mode, and a page matching both ways appears once', async () => {
    const rota = await newPage('On-call rota', 'Pager schedule for the platform team.');
    const both = await newPage('Night shifts', 'who is woken at night');
    await seedVector(rota, axis(1));
    await seedVector(both, axis(1));
    vi.spyOn(workItemEmbeddingsService, 'embedQuery').mockResolvedValue({
      embedding: axis(1),
      model: MODEL,
    });

    const result = await client('woken');

    expect(result.mode).toBe('merged');
    const ids = result.items.map((h) => h.id);
    expect(ids).toContain(rota.id);
    expect(ids.filter((id) => id === both.id)).toHaveLength(1);
  });

  it('pages through nextCursor disjointly to every match, never an archived or foreign page', async () => {
    const seeded: string[] = [];
    for (let i = 0; i < PAGE_SEARCH_LIMIT + 3; i += 1) {
      seeded.push((await newPage(`Gale ${i}`, `gale note ${i}`)).id);
    }
    const gone = await newPage('Gone gale', 'gale');
    await adminDb.page.update({
      where: { id: gone.id },
      data: { archivedAt: new Date(), archiveRootId: gone.id },
    });
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PSX',
    });
    const elsewhere = await newPage('Elsewhere gale', 'gale', other.id);

    const first = await client('gale');
    expect(first.items).toHaveLength(PAGE_SEARCH_LIMIT);
    expect(first.nextCursor).not.toBeNull();
    const second = await client('gale', first.nextCursor);
    expect(second.nextCursor).toBeNull();

    const a = first.items.map((h) => h.id);
    const b = second.items.map((h) => h.id);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect(new Set([...a, ...b])).toEqual(new Set(seeded));
    expect([...a, ...b]).not.toContain(gone.id);
    expect([...a, ...b]).not.toContain(elsewhere.id);
  });

  it('a too-long query throws the typed refusal the tooLong state reads', async () => {
    const err = await refusalOf(() => client(TOO_LONG));
    expect({ status: err.status, code: err.code, limit: err.limit }).toEqual({
      status: 422,
      code: 'PAGE_SEARCH_QUERY_TOO_LONG',
      limit: PAGE_SEARCH_QUERY_MAX_LENGTH,
    });
  });

  it('a cursor the service did not issue throws PAGE_CURSOR_INVALID, the restart code', async () => {
    await newPage('Zephyr', 'zephyr');
    const err = await refusalOf(() => client('zephyr', 'not-a-real-cursor'));
    expect({ status: err.status, code: err.code }).toEqual({
      status: 400,
      code: 'PAGE_CURSOR_INVALID',
    });
  });
});

describe('Story MOTIR-9491 gate — no page data on refusal, as the browser receives it', () => {
  const TITLE = 'Quillwort strategy';
  const WORD = 'quillwort';

  type Who = 'stranger' | 'browser' | 'member';
  const cases: { who: Who; q: string; cursor: string | null; status: number; code: string }[] = [
    ...(['stranger', 'browser'] as const).flatMap((who) =>
      [WORD, '', TOO_LONG].map((q) => ({
        who,
        q,
        cursor: null,
        status: who === 'stranger' ? 404 : 403,
        code: '',
      })),
    ),
    { who: 'member', q: TOO_LONG, cursor: null, status: 422, code: 'PAGE_SEARCH_QUERY_TOO_LONG' },
    { who: 'member', q: '   ', cursor: null, status: 422, code: 'PAGE_SEARCH_QUERY_EMPTY' },
    { who: 'member', q: WORD, cursor: 'forged', status: 400, code: 'PAGE_CURSOR_INVALID' },
  ];

  it.each(cases)('$who · q=$q.length chars · cursor=$cursor → $status', async (c) => {
    await newPage(TITLE, `The ${WORD} plan, in full.`);
    if (c.who === 'stranger') ctxRef.current = await stranger();
    if (c.who === 'browser') ctxRef.current = await browseOnlyReader();

    const err = await refusalOf(() => client(c.q, c.cursor));

    expect(err.status).toBe(c.status);
    if (c.code) expect(err.code).toBe(c.code);
    const raw = bodies.at(-1)!;
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).every((k) => ['code', 'error', 'limit'].includes(k))).toBe(true);
    expect(raw.toLowerCase()).not.toContain(WORD);
    expect(raw).not.toContain(TITLE);
  });
});

describe('Story MOTIR-9491 gate — static guards', () => {
  const route = stripComments(readFileSync(join(ROOT, 'app/api/pages/search/route.ts'), 'utf8'));

  it('the route writes no filter of its own: one service call, no repository, q and result untouched', () => {
    const serviceImports = [
      ...route.matchAll(/import\s+\{([^}]*)\}\s+from\s+'@\/lib\/services[^']*'/g),
    ]
      .flatMap((m) => m[1]!.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    expect(serviceImports).toEqual(['pagesService']);
    expect([...route.matchAll(/pagesService\.(\w+)/g)].map((m) => m[1])).toEqual(['searchPages']);
    expect(route).not.toMatch(/@\/lib\/db|@\/lib\/repositories|Repository/);
    for (const op of ['.trim(', '.length', '.slice(', '.filter(', '.map(']) {
      expect(route, op).not.toContain(op);
    }
  });

  it('/pages still refuses with notFound() before the box renders, and has no loading.tsx', () => {
    const page = stripComments(readFileSync(join(ROOT, 'app/(authed)/pages/page.tsx'), 'utf8'));
    const gate = page.indexOf('notFound()');
    const box = page.indexOf('<PagesSearch');
    expect(gate).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(gate);

    const loading: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === 'loading.tsx') loading.push(p);
      }
    };
    const pagesDir = join(ROOT, 'app/(authed)/pages');
    expect(existsSync(pagesDir)).toBe(true);
    walk(pagesDir);
    expect(loading).toEqual([]);
  });
});
