import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { pagesService, PAGE_SEARCH_LIMIT } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { GET as SEARCH } from '@/app/api/internal/ai/pages/route';
import { GET as READ } from '@/app/api/internal/ai/pages/[pageId]/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../../../fixtures/workItemFixtures';
import { adminDb } from '../../../helpers/adminDb';
import { truncateAuthTables } from '../../../helpers/db';
import {
  createCustomRoleAs,
  setProjectRoleDefinitionFor,
} from '../../../helpers/workspaceRoleFixtures';

// MOTIR-10238 — the planner's page reads through the REAL route handlers against
// a real Postgres: the two §4 grants, the token's OWN project as the only scope,
// and every absence as a NAMED outcome at 200. The service under both routes is
// the one `search_pages` / `get_page` call, so these assert the TRANSPORT half:
// the outcome names, the not-found bytes, and that a read writes nothing.

const SERVICE_SECRET = 'core-callback-secret-test';

let fx: WorkItemFixture;
let token: string;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  token = tokenFor(fx.ctx, fx.projectId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function tokenFor(ctx: ServiceContext, projectId: string): string {
  return mintJobToken({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId });
}

function req(path: string, opts: { bearer?: string; token?: string } = {}): Request {
  const headers: Record<string, string> = {};
  const bearer = 'bearer' in opts ? opts.bearer : SERVICE_SECRET;
  const tok = 'token' in opts ? opts.token : token;
  if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
  if (tok !== undefined) headers['x-motir-job-token'] = tok;
  return new Request(`http://core${path}`, { headers });
}

const search = (query: string, opts?: { bearer?: string; token?: string }) =>
  SEARCH(req(`/api/internal/ai/pages${query}`, opts));
const read = (pageId: string, query = '', opts?: { bearer?: string; token?: string }) =>
  READ(req(`/api/internal/ai/pages/${pageId}${query}`, opts), {
    params: Promise.resolve({ pageId }),
  });

const seed = (title: string, markdown?: string, projectId = fx.projectId, ctx = fx.ctx) =>
  pagesService.createPageFromMarkdown(ctx, { projectId, title, markdown });

/** A page with three versions; each save pushed back an hour so the next one opens a new version. */
async function threeVersionPage() {
  const page = await pagesService.createPage(fx.ctx, {
    projectId: fx.projectId,
    title: 'Decision',
  });
  for (let n = 1; n <= 3; n++) {
    const current = await pagesService.getPageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
    });
    if (current.latestVersion) {
      const back = new Date(Date.now() - 3_600_000 * (4 - n));
      await adminDb.pageVersion.updateMany({
        where: { pageId: page.id },
        data: { startedAt: back, savedAt: back },
      });
    }
    await pagesService.savePageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
      markdown: `Body number ${n}`,
      expectedRevision: current.revision,
    });
  }
  const versions = await adminDb.pageVersion.findMany({
    where: { pageId: page.id },
    orderBy: { number: 'asc' },
  });
  return { page, versions };
}

/** A member who can browse the project but whose role confers no `page:view`. */
async function browseOnlyMember(): Promise<ServiceContext> {
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'Browser',
    permissions: ['project:browse', 'work_item:view'],
  });
  const user = await usersService.createUser({
    email: 'pages-route-browse@example.com',
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

describe('the internal page routes — auth and validation', () => {
  it('both refuse a missing / wrong service bearer and a missing / tampered job token with 401', async () => {
    for (const call of [
      (o: { bearer?: string; token?: string }) => search('?q=zephyr', o),
      (o: { bearer?: string; token?: string }) => read('pg_x', '', o),
    ]) {
      const noBearer = await call({ bearer: undefined });
      expect(noBearer.status).toBe(401);
      expect(await noBearer.json()).toMatchObject({ code: 'service_unauthorized' });
      expect((await call({ bearer: 'wrong' })).status).toBe(401);
      const noToken = await call({ token: undefined });
      expect(noToken.status).toBe(401);
      expect(await noToken.json()).toMatchObject({ code: 'token_invalid' });
      expect((await call({ token: 'not-a-real-token' })).status).toBe(401);
    }
  });

  it('a non-integer version is 400 validation_error', async () => {
    const page = await seed('Spec', 'zephyr');
    for (const v of ['abc', '0', '-1', '1.5']) {
      const res = await read(page.id, `?version=${v}`);
      expect(res.status, v).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'validation_error' });
    }
  });
});

describe('GET /api/internal/ai/pages — search', () => {
  it('finds a live page of the token’s project with id, title, place, snippet, mode and cursor', async () => {
    const page = await seed('Quarterly roadmap', 'The zephyr launch is in spring.');
    const res = await search('?q=zephyr');
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result).toMatchObject({ outcome: 'ok', mode: 'full-text-only', nextCursor: null });
    expect(typeof result.message).toBe('string');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: page.id,
      title: 'Quarterly roadmap',
      place: { folderPath: [], parentPageTitle: null },
    });
    expect(result.items[0].snippet).toContain('zephyr');
  });

  it('pages by the returned cursor, with no repeat', async () => {
    for (let i = 0; i < PAGE_SEARCH_LIMIT + 3; i++) await seed(`Spec ${i}`, 'zephyr');
    const one = (await (await search('?q=zephyr')).json()).result;
    expect(one.items).toHaveLength(PAGE_SEARCH_LIMIT);
    expect(one.nextCursor).toEqual(expect.any(String));
    const two = (
      await (await search(`?q=zephyr&cursor=${encodeURIComponent(one.nextCursor)}`)).json()
    ).result;
    expect(two).toMatchObject({ outcome: 'ok', nextCursor: null });
    const ids = [...one.items, ...two.items].map((h: { id: string }) => h.id);
    expect(new Set(ids).size).toBe(PAGE_SEARCH_LIMIT + 3);
  });

  it('never returns an archived page, a page of another project, or one of another workspace', async () => {
    const live = await seed('Live', 'zephyr');
    const gone = await seed('Gone', 'zephyr');
    await adminDb.page.update({
      where: { id: gone.id },
      data: { archivedAt: new Date(), archiveRootId: gone.id },
    });
    const sibling = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    await seed('Sibling', 'zephyr', sibling.id);
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    await seed('Rival', 'zephyr', rival.projectId, rival.ctx);

    const body = await (await search('?q=zephyr')).text();
    const { result } = JSON.parse(body);
    expect(result.items.map((h: { id: string }) => h.id)).toEqual([live.id]);
    expect(body).not.toContain('Gone');
    expect(body).not.toContain('Sibling');
    expect(body).not.toContain('Rival');
  });

  it('no hits is ok with empty items, carrying the degraded mode’s message', async () => {
    await seed('Spec', 'zephyr');
    const { result } = await (await search('?q=nothingmatchesthis')).json();
    expect(result).toMatchObject({ outcome: 'ok', items: [], mode: 'full-text-only' });
    expect(result.message).toMatch(/\S/);
  });

  it('names every refused query: query_empty, query_too_long, cursor_invalid — all at 200', async () => {
    for (const [q, outcome] of [
      ['', 'query_empty'],
      ['?q=', 'query_empty'],
      ['?q=%20%20', 'query_empty'],
      [`?q=${'a'.repeat(201)}`, 'query_too_long'],
      ['?q=zephyr&cursor=garbage', 'cursor_invalid'],
    ] as const) {
      const res = await search(q);
      expect(res.status, q).toBe(200);
      expect((await res.json()).result.outcome, q).toBe(outcome);
    }
    const tooLong = (await (await search(`?q=${'a'.repeat(201)}`)).json()).result;
    expect(tooLong.limit).toBe(200);
  });

  it('a token whose user cannot read pages is 403; one whose user cannot browse is 404', async () => {
    const browse = await browseOnlyMember();
    const res = await search('?q=zephyr', { token: tokenFor(browse, fx.projectId) });
    expect(res.status).toBe(403);

    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const crossed = mintJobToken({
      userId: rival.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const denied = await search('?q=zephyr', { token: crossed });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});

describe('GET /api/internal/ai/pages/{pageId} — read', () => {
  it('reads a page of the token’s project as markdown with its title, placement, revision and newest version', async () => {
    const page = await seed('Requirement', '# Heading\n\nThe zephyr rule.');
    const res = await read(page.id);
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result.outcome).toBe('found');
    expect(result.page).toMatchObject({ id: page.id, title: 'Requirement' });
    expect(result.page.markdown).toContain('The zephyr rule.');
    expect(result.page).toHaveProperty('placement');
    expect(result.page).toHaveProperty('revision');
    expect(result.page).toHaveProperty('latestVersion');
  });

  it('reads one saved version, with its metadata, never the current body', async () => {
    const { page, versions } = await threeVersionPage();
    const first = versions.find((v) => v.bodyMarkdown.includes('Body number 1'))!;
    const { result } = await (await read(page.id, `?version=${first.number}`)).json();
    expect(result.outcome).toBe('found');
    expect(result.page.markdown).toContain('Body number 1');
    expect(result.page.markdown).not.toContain('Body number 3');
    expect(result.page.version).toMatchObject({ number: first.number, authorId: fx.ownerId });

    const missing = await read(page.id, '?version=99');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ result: { outcome: 'version_not_found', version: 99 } });
  });

  it('an unknown id, another project’s page and another workspace’s page answer the SAME bytes', async () => {
    const sibling = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const siblingPage = await seed('Sibling secret', 'zephyr', sibling.id);
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const rivalPage = await seed('Rival secret', 'zephyr', rival.projectId, rival.ctx);

    const bodies = await Promise.all(
      ['cmunknownpageid0000000000', siblingPage.id, rivalPage.id].map(async (id) => {
        const res = await read(id);
        expect(res.status).toBe(200);
        return res.text();
      }),
    );
    expect(bodies[0]).toBe(JSON.stringify({ result: { outcome: 'not_found' } }));
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
  });

  it('a token whose user cannot read pages gets not_found, never a body', async () => {
    const page = await seed('Spec', 'zephyr body');
    const browse = await browseOnlyMember();
    const res = await read(page.id, '', { token: tokenFor(browse, fx.projectId) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ result: { outcome: 'not_found' } }));
  });

  it('is read-only: the page’s revision and version history are unchanged after reads and a search', async () => {
    const { page } = await threeVersionPage();
    const before = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    const versionsBefore = await adminDb.pageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { number: 'asc' },
    });
    await read(page.id);
    await read(page.id, `?version=${versionsBefore[0]!.number}`);
    await search('?q=Body');
    const after = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    const versionsAfter = await adminDb.pageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { number: 'asc' },
    });
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(versionsAfter).toEqual(versionsBefore);
  });
});

describe('the internal page routes — an unexpected failure', () => {
  it('is rethrown, never dressed as an outcome', async () => {
    vi.spyOn(pagesService, 'searchPages').mockRejectedValueOnce(new Error('db down'));
    await expect(search('?q=zephyr')).rejects.toThrow('db down');
    vi.spyOn(pagesService, 'getPageMarkdown').mockRejectedValueOnce(new Error('db down'));
    await expect(read('pg_x')).rejects.toThrow('db down');
  });
});
