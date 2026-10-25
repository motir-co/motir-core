import { randomBytes } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// PAGES ARE FOUND BY TITLE AND BODY — Story MOTIR-9489's verification recipe
// (Subtask MOTIR-9555), steps 1 to 9 in order, against the SERVED app: REST with
// a real API token, the app's own archive action, an MCP client over
// `/api/mcp`, and the OpenAPI document the server publishes.
//
// ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
// Ranking, the cursor codec, the snippet's form, cross-door agreement over a
// corpus and the source-level access checks are proved in-process by
// `tests/services/pagesService.searchPages.test.ts` and
// `tests/pages/pageSearch.story.integration.test.ts`. This spec asserts only what
// a caller of the doors sees on the wire.
//
// ── THE MAIN LANE, NO VIDEO ─────────────────────────────────────────────────
// The story adds no surface a person watches: search is a REST operation and an
// agent tool. So it records no paced acceptance video (the non-UI exemption)
// and needs no cloud mocks, which is what the main lane is for
// (`docs/acceptance-lane-triage.md`).
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──
// Every REST step awaits its own response. The archive is the one browser
// step: its `POST /api/pages/<id>/archive` is armed BEFORE the menu click and
// its status asserted before the next search. There is no fixed sleep.
//
// A per-run random word keeps a repeated or parallel run from finding another
// run's page.

const PASSWORD = 'pages-search-e2e-pass-123';
const OWNER_EMAIL = 'pages-search-owner@example.com';
const READER_EMAIL = 'pages-search-reader@example.com';
const TITLE = 'Quarterly roadmap';
const WORD = `zephyr${randomBytes(4).toString('hex')}`;
const PAGE_GRANT = ['project:browse', 'page:view', 'page:edit'];

interface Seed {
  projectKey: string;
  token: string;
  /** A member who can browse the project; their role no longer confers `page:view`. */
  noViewToken: string;
}

async function seed(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: OWNER_EMAIL,
    password: PASSWORD,
    name: 'Olga Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Search Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Planning',
    identifier: 'PLN',
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });
  const token = await apiTokensService.create(owner.id, workspace.id, {
    label: 'search integration',
    permissions: PAGE_GRANT,
    projectId: project.id,
  });

  // The reader's token names `page:view`; their project role is then narrowed so
  // it no longer confers it — the refusal under test is the project's, not the token's.
  const reader = await usersService.createUser({
    email: READER_EMAIL,
    password: PASSWORD,
    name: 'Rhea Reader',
  });
  await workspacesService.addMember({ userId: reader.id, workspaceId: workspace.id });
  const noView = await apiTokensService.create(reader.id, workspace.id, {
    label: 'reader integration',
    permissions: ['project:browse', 'page:view'],
    projectId: project.id,
  });
  const role = await createCustomRoleAs({
    ctx,
    name: 'Browse only',
    permissions: ['project:browse', 'work_item:view'],
  });
  await setProjectRoleDefinitionFor(reader.id, project.id, {
    roleDefinitionId: role.id,
    role: 'member',
  });

  return { projectKey: project.identifier, token: token.token, noViewToken: noView.token };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface Hit {
  id: string;
  title: string;
  place: { folderPath: string[]; parentPageTitle: string | null };
  snippet: string;
  rank: number;
}

function search(
  request: APIRequestContext,
  token: string,
  projectKey: string,
  q: string,
): Promise<APIResponse> {
  return request.get(`/api/v1/projects/${projectKey}/pages/search`, {
    headers: bearer(token),
    params: { q },
  });
}

/** A search that must answer 200 — the hits, after asserting the page carries no body. */
async function hits(request: APIRequestContext, token: string, projectKey: string, q: string) {
  const res = await search(request, token, projectKey, q);
  const text = await res.text();
  expect(res.status(), text.slice(0, 400)).toBe(200);
  expect(text).not.toMatch(/"(markdown|body|bodyText|total|count)"/);
  const body = JSON.parse(text) as { items: Hit[]; nextCursor: string | null; mode: string };
  expect(Object.keys(body).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
  // This lane's server has no motir-ai, so the search says it ranked by words only
  // (MOTIR-9574); search by meaning is the acceptance lane's spec.
  expect(body.mode).toBe('full-text-only');
  return body.items;
}

async function agent(token: string, baseURL: string | undefined): Promise<Client> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  const client = new Client({ name: 'pages-search', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: bearer(token) },
    }),
  );
  return client;
}

async function searchTool(client: Client, projectKey: string, q: string) {
  const result = (await client.callTool({
    name: 'search_pages',
    arguments: { projectKey, q },
  })) as CallToolResult;
  const text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return { result, text };
}

const archiveOf = (page: Page, id: string) =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/pages/${id}/archive` && r.request().method() === 'POST',
  );

test('a page is found by a body word and a title word over REST and the MCP, and refused by name', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await resetDatabase();
  const s = await seed();
  let pageId = '';
  let revision = 0;
  let restHit: Hit | undefined;

  await test.step('1 · create a page over REST whose body, not its title, has the word', async () => {
    const res = await request.post(`/api/v1/projects/${s.projectKey}/pages`, {
      headers: bearer(s.token),
      data: { title: TITLE, markdown: `We plan the ${WORD} launch for spring.` },
    });
    expect(res.status(), (await res.text()).slice(0, 400)).toBe(201);
    const created = (await res.json()) as { id: string; revision: number };
    pageId = created.id;
    revision = created.revision;
  });

  await test.step('2 · search the body word: the page, its place and a snippet', async () => {
    const items = await hits(request, s.token, s.projectKey, WORD);
    expect(items.map((h) => h.id)).toEqual([pageId]);
    restHit = items[0];
    expect(restHit).toMatchObject({
      id: pageId,
      title: TITLE,
      place: { folderPath: [], parentPageTitle: null },
    });
    expect(restHit!.snippet).toContain(WORD);
  });

  await test.step('3 · search a word only in the title', async () => {
    expect((await hits(request, s.token, s.projectKey, 'Quarterly')).map((h) => h.id)).toEqual([
      pageId,
    ]);
  });

  await test.step('4 · an update at the revision removes the word, and it stops matching', async () => {
    const res = await request.patch(`/api/v1/pages/${pageId}`, {
      headers: bearer(s.token),
      data: { markdown: 'We plan the launch for spring.', revision },
    });
    expect(res.status(), (await res.text()).slice(0, 400)).toBe(200);
    revision = ((await res.json()) as { revision: number }).revision;
    expect(await hits(request, s.token, s.projectKey, WORD)).toEqual([]);
    expect((await hits(request, s.token, s.projectKey, 'Quarterly')).map((h) => h.id)).toEqual([
      pageId,
    ]);
  });

  await test.step('5 · put the word back, archive the page in the app, and it is gone', async () => {
    const res = await request.patch(`/api/v1/pages/${pageId}`, {
      headers: bearer(s.token),
      data: { markdown: `We plan the ${WORD} launch for spring.`, revision },
    });
    expect(res.status(), (await res.text()).slice(0, 400)).toBe(200);
    expect((await hits(request, s.token, s.projectKey, WORD)).map((h) => h.id)).toEqual([pageId]);

    await signIn(page, OWNER_EMAIL, PASSWORD);
    await page.goto('/pages');
    const row = page
      .getByRole('tree', { name: 'Folders and pages in this project', exact: true })
      .getByRole('treeitem', { name: TITLE, exact: true });
    await expect(row).toBeVisible();
    const archived = archiveOf(page, pageId);
    await page.getByRole('button', { name: `Page actions for ${TITLE}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Archive…', exact: true }).click();
    expect((await archived).status()).toBe(200);
    await expect(row).toHaveCount(0);

    expect(await hits(request, s.token, s.projectKey, WORD)).toEqual([]);
  });

  // The archived page is the recipe's subject until step 5; the remaining steps
  // need a live one, made the same way.
  await test.step('a live page again, for the refusals and the MCP', async () => {
    const res = await request.post(`/api/v1/projects/${s.projectKey}/pages`, {
      headers: bearer(s.token),
      data: { title: TITLE, markdown: `We plan the ${WORD} launch for spring.` },
    });
    expect(res.status()).toBe(201);
    pageId = ((await res.json()) as { id: string }).id;
    const items = await hits(request, s.token, s.projectKey, WORD);
    expect(items.map((h) => h.id)).toEqual([pageId]);
    restHit = items[0];
  });

  await test.step('6 · an empty or whitespace query is refused by name, with no page', async () => {
    for (const q of ['', '  ']) {
      const res = await search(request, s.token, s.projectKey, q);
      const text = await res.text();
      expect(res.status()).toBe(422);
      expect(JSON.parse(text).code).toBe('PAGE_SEARCH_QUERY_EMPTY');
      expect(text).not.toContain(TITLE);
      expect(text).not.toContain(pageId);
    }
  });

  await test.step('7 · a member whose role lacks page:view is refused, even with an empty query', async () => {
    for (const q of [WORD, '']) {
      const res = await search(request, s.noViewToken, s.projectKey, q);
      const text = await res.text();
      expect(res.status(), text.slice(0, 400)).toBe(403);
      expect(JSON.parse(text).code).toBe('PROJECT_ACCESS_DENIED');
      expect(text).not.toContain(TITLE);
      expect(text).not.toContain(WORD);
      expect(text).not.toMatch(/"(items|count|total)"/);
    }
  });

  await test.step('8 · the MCP search_pages tool: the same hit and the same refusal names', async () => {
    const client = await agent(s.token, baseURL);
    const found = await searchTool(client, s.projectKey, WORD);
    expect(found.result.isError ?? false, found.text.slice(0, 400)).toBe(false);
    const items = (found.result.structuredContent as { items: Hit[] }).items;
    expect(items).toHaveLength(1);
    const { rank: _restRank, ...restIdentity } = restHit!;
    const { rank: _mcpRank, ...mcpIdentity } = items[0]!;
    expect(mcpIdentity).toEqual(restIdentity);

    const empty = await searchTool(client, s.projectKey, '');
    expect(empty.result.isError).toBe(true);
    expect(empty.text).toMatch(/^PAGE_SEARCH_QUERY_EMPTY: /);
    await client.close();

    const reader = await agent(s.noViewToken, baseURL);
    for (const q of [WORD, '']) {
      const refused = await searchTool(reader, s.projectKey, q);
      expect(refused.result.isError).toBe(true);
      expect(refused.text).toMatch(/^PROJECT_ACCESS_DENIED: /);
      expect(refused.text).not.toContain(TITLE);
    }
    await reader.close();
  });

  await test.step('9 · the published OpenAPI document carries the operation', async () => {
    const res = await request.get('/api/openapi/v1.json');
    expect(res.status()).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        Record<string, { operationId: string; parameters: unknown[]; responses: object }>
      >;
    };
    const op = doc.paths['/api/v1/projects/{projectKey}/pages/search']?.['get'];
    expect(op?.operationId).toBe('searchPages');
    const params = (op!.parameters as Array<{ name: string; in: string }>).map(
      (p) => `${p.in}:${p.name}`,
    );
    expect(params.sort()).toEqual(['path:projectKey', 'query:cursor', 'query:q']);
    expect(Object.keys(op!.responses)).toEqual(
      expect.arrayContaining(['200', '403', '404', '422']),
    );
  });
});
