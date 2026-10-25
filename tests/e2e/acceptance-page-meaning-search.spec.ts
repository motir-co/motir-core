// Acceptance E2E — Pages are found by meaning (Story MOTIR-9490 · MOTIR-9577).
// The story's ten-step verification recipe, in order, against the SERVED app:
// REST with a real API token, the app's own archive and restore, an MCP client
// over `/api/mcp`, and the OpenAPI document the server publishes. One test, one
// chapter per recipe step, named `Step 1` to `Step 10`.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts, the lane whose server and job
// worker reach motir-ai at all. The ONE thing replaced is motir-ai's
// `POST /v1/embeddings`, by `lib/test-embeddings-mock.ts` in BOTH processes: the
// worker embeds a page after each save, the server embeds the query. Its vectors
// are a topic function of the text, so the recipe's page ("engineers take turns
// answering overnight incidents") and query ("who gets woken up when production
// breaks") share an axis and no word. Step 7 flips the same seam to 503 through
// its control file, which is the degraded arm `embedQuery` really takes; its
// journal is what step 8 reads to prove a refusal reached no seam. Everything
// else is real: the token, the routes, the `page/embedding.requested` job, the
// fused query, the MCP transport and the OpenAPI route.
//
// ── NO THRESHOLD ────────────────────────────────────────────────────────────
// Search by meaning has no similarity cut-off (MOTIR-9572): every embedded live
// page of the project is a candidate, ranked. So "the old meaning no longer
// returns the page" is asserted as the ranking says it: a second on-call page,
// seeded beside the recipe's, ranks ABOVE the edited page for the old meaning,
// and the new meaning ranks the edited page first.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// The embedding job runs in the lane's worker, so a page's vector can lag its
// 201. Every wait is an `expect.poll` of the search outcome the step asserts
// (or of the `page_embedding` row, for a page the caller must NOT see, so its
// absence cannot pass before it exists), and the archive is armed on its own
// response before the menu click. There is no fixed sleep.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made. CI is this spec's first run: the lane's `next build` cannot
// run in the cloud thread that wrote it.

import { writeFileSync } from 'node:fs';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { readFixtureFileSync } from '@/lib/test-fixture-file';
import type { EmbeddingsControl, EmbeddingsJournalLine } from '@/lib/test-embeddings-mock';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

test.describe.configure({ timeout: 300_000 });

const PASSWORD = 'page-meaning-e2e-pass-123';
const OWNER_EMAIL = 'page-meaning-owner@example.com';
const MEMBER_EMAIL = 'page-meaning-member@example.com';
const READER_EMAIL = 'page-meaning-reader@example.com';
const PAGE_GRANT = ['project:browse', 'page:view', 'page:edit'];

// The recipe's own text.
const TITLE = 'On-call rota';
const BODY = 'engineers take turns answering overnight incidents';
const MEANING = 'who gets woken up when production breaks';
const WORD = 'rota';
const PLANTS_BODY = 'office plants: the ficus and the ferns need water on fridays';
const PLANTS_QUERY = 'houseplants watering';
// The second on-call page the ranking is compared against (see NO THRESHOLD).
const CONTROL_TITLE = 'Escalation';
const CONTROL_BODY = 'escalation path for outages';
const HIDDEN_TITLE = 'Acquisition plan confidential';
const HIDDEN_BODY = 'engineers take turns answering overnight incidents and outages';
const REFUSED_QUERY = 'refused probe overnight incidents';

const CONTROL_PATH = process.env['MOTIR_AI_EMBEDDINGS_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_AI_EMBEDDINGS_JOURNAL_PATH']!;

const POLL = { timeout: 60_000 } as const;

// ── The seam's two files ────────────────────────────────────────────────────

function setBackend(mode: EmbeddingsControl['mode']): void {
  writeFileSync(CONTROL_PATH, JSON.stringify({ mode } satisfies EmbeddingsControl));
}

function journal(): EmbeddingsJournalLine[] {
  try {
    return readFixtureFileSync(JOURNAL_PATH)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EmbeddingsJournalLine);
  } catch {
    return [];
  }
}

// ── Seed ────────────────────────────────────────────────────────────────────

interface Seed {
  projectKey: string;
  ownerCtx: { userId: string; workspaceId: string };
  hiddenProjectId: string;
  /** The recipe's API token: a member's, bound to the project. */
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
    name: 'Meaning Workspace',
    ownerUserId: owner.id,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Platform',
    identifier: 'PLT',
  });
  await markProjectOnboarded(project.id);
  // The project the member cannot view pages of: members-only, and never joined.
  const hidden = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Deals',
    identifier: 'DLS',
  });
  await adminDb.project.update({ where: { id: hidden.id }, data: { accessMode: 'members' } });

  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: PASSWORD,
    name: 'Mia Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const token = await apiTokensService.create(member.id, workspace.id, {
    label: 'meaning search',
    permissions: PAGE_GRANT,
    projectId: project.id,
  });

  const reader = await usersService.createUser({
    email: READER_EMAIL,
    password: PASSWORD,
    name: 'Rhea Reader',
  });
  await workspacesService.addMember({ userId: reader.id, workspaceId: workspace.id });
  const noView = await apiTokensService.create(reader.id, workspace.id, {
    label: 'reader',
    permissions: ['project:browse', 'page:view'],
    projectId: project.id,
  });
  const role = await createCustomRoleAs({
    ctx: ownerCtx,
    name: 'Browse only',
    permissions: ['project:browse', 'work_item:view'],
  });
  await setProjectRoleDefinitionFor(reader.id, project.id, {
    roleDefinitionId: role.id,
    role: 'member',
  });

  return {
    projectKey: project.identifier,
    ownerCtx,
    hiddenProjectId: hidden.id,
    token: token.token,
    noViewToken: noView.token,
  };
}

// ── The doors ───────────────────────────────────────────────────────────────

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface Hit {
  id: string;
  title: string;
  snippet: string;
  rank: number;
}

interface SearchBody {
  items: Hit[];
  nextCursor: string | null;
  mode: 'merged' | 'full-text-only' | 'not-indexed';
  message: string | null;
}

function searchRaw(
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

/** A search that must answer 200, with the response text kept for leak checks. */
async function search(request: APIRequestContext, token: string, projectKey: string, q: string) {
  const res = await searchRaw(request, token, projectKey, q);
  const text = await res.text();
  expect(res.status(), text.slice(0, 400)).toBe(200);
  const body = JSON.parse(text) as SearchBody;
  expect(Object.keys(body).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
  return { body, text, ids: body.items.map((h) => h.id) };
}

async function agent(token: string, baseURL: string | undefined): Promise<Client> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  const client = new Client({ name: 'page-meaning', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
      requestInit: { headers: bearer(token) },
    }),
  );
  return client;
}

const archiveOf = (page: Page, id: string) =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/pages/${id}/archive` && r.request().method() === 'POST',
  );

test.beforeEach(async () => {
  await resetDatabase();
  setBackend('healthy');
  writeFileSync(JOURNAL_PATH, '');
});

test.afterEach(() => {
  setBackend('healthy');
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('Pages are found by meaning: the ten-step recipe over REST, the app, MCP and OpenAPI', async ({
  page,
  request,
  baseURL,
  chapter,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9490');
  const s = await seed();
  const find = (q: string, token = s.token) => search(request, token, s.projectKey, q);
  let pageId = '';
  let controlId = '';
  let revision = 0;

  await chapter(
    'Step 1 · create "On-call rota" over REST, and wait for its embedding',
    async () => {
      const res = await request.post(`/api/v1/projects/${s.projectKey}/pages`, {
        headers: bearer(s.token),
        data: { title: TITLE, markdown: BODY },
      });
      expect(res.status(), (await res.text()).slice(0, 400)).toBe(201);
      const created = (await res.json()) as { id: string; revision: number };
      pageId = created.id;
      revision = created.revision;

      const control = await request.post(`/api/v1/projects/${s.projectKey}/pages`, {
        headers: bearer(s.token),
        data: { title: CONTROL_TITLE, markdown: CONTROL_BODY },
      });
      expect(control.status()).toBe(201);
      controlId = ((await control.json()) as { id: string }).id;

      // The job ran for both once the meaning search ranks both, in merged mode.
      await expect
        .poll(async () => {
          const { body, ids } = await find(MEANING);
          return body.mode === 'merged' && ids.includes(pageId) && ids.includes(controlId);
        }, POLL)
        .toBe(true);
    },
  );

  await chapter(
    'Step 2 · a query sharing no word with the page finds it, in merged mode',
    async () => {
      for (const word of MEANING.split(' ')) {
        expect(`${TITLE} ${BODY}`.toLowerCase().split(/[^a-z]+/)).not.toContain(word);
      }
      const { body, ids } = await find(MEANING);
      expect(body.mode).toBe('merged');
      expect(body.message).toBeNull();
      expect(ids).toContain(pageId);
    },
  );

  await chapter('Step 3 · the single word "rota" returns the page exactly once', async () => {
    const { body, ids } = await find(WORD);
    expect(body.mode).toBe('merged');
    expect(ids.filter((id) => id === pageId)).toHaveLength(1);
    expect(ids[0]).toBe(pageId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  await chapter(
    'Step 4 · rewrite it about office plants at its revision; the meaning moves',
    async () => {
      const res = await request.patch(`/api/v1/pages/${pageId}`, {
        headers: bearer(s.token),
        data: { markdown: PLANTS_BODY, revision },
      });
      expect(res.status(), (await res.text()).slice(0, 400)).toBe(200);
      const stale = await request.patch(`/api/v1/pages/${pageId}`, {
        headers: bearer(s.token),
        data: { markdown: BODY, revision },
      });
      expect(stale.status()).toBe(409);
      expect(((await stale.json()) as { code: string }).code).toBe('PAGE_REVISION_CONFLICT');

      // Re-embedded: the worker sent the new body across the boundary. The plants
      // query alone cannot prove it — full-text matches "water" the moment the
      // save lands, 30 s before the debounced job runs.
      await expect
        .poll(
          () =>
            journal().some(
              (l) => l.status === 200 && l.input.some((text) => text.includes('ficus')),
            ),
          POLL,
        )
        .toBe(true);
      const plants = await find(PLANTS_QUERY);
      expect(plants.body.mode).toBe('merged');
      expect(plants.ids[0]).toBe(pageId);

      // The old meaning: the on-call page that is still about it ranks above
      // (polled, because the vector is written just after the call returns).
      await expect.poll(async () => (await find(MEANING)).ids[0], POLL).toBe(controlId);
      const old = await find(MEANING);
      expect(old.ids.indexOf(pageId)).toBeGreaterThan(0);
    },
  );

  await chapter('Step 5 · archive it in the app: gone; restore it: back', async () => {
    await signIn(page, MEMBER_EMAIL, PASSWORD);
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

    expect((await find(PLANTS_QUERY)).ids).not.toContain(pageId);
    expect((await find(WORD)).ids).not.toContain(pageId);

    // Restore through the app's own door, as the signed-in member.
    const restored = await page.request.delete(`/api/pages/${pageId}/archive`);
    expect(restored.status(), (await restored.text()).slice(0, 400)).toBe(200);
    await expect.poll(async () => (await find(PLANTS_QUERY)).ids[0], POLL).toBe(pageId);
  });

  await chapter('Step 6 · a page in a project the member cannot view never appears', async () => {
    const before = await find(MEANING);
    const hidden = await pagesService.createPageFromMarkdown(s.ownerCtx, {
      projectId: s.hiddenProjectId,
      title: HIDDEN_TITLE,
      markdown: HIDDEN_BODY,
    });
    // Its row exists first, so its absence below cannot pass before the job ran.
    await expect
      .poll(() => adminDb.pageEmbedding.count({ where: { pageId: hidden.id } }), POLL)
      .toBe(1);

    const after = await find(MEANING);
    expect(after.ids).toEqual(before.ids);
    expect(after.ids).not.toContain(hidden.id);
    expect(after.text).not.toContain(HIDDEN_TITLE);
    expect(after.text).not.toContain('Acquisition');
    expect(after.body.items).toHaveLength(before.body.items.length);
  });

  await chapter(
    'Step 7 · the embedding backend is down: 200, full-text-only, never a 500',
    async () => {
      setBackend('unavailable');

      const word = await find(WORD);
      expect(word.body.mode).toBe('full-text-only');
      expect(word.body.message).toMatch(/Semantic search did not run/);
      expect(word.ids).toEqual([pageId]);

      const meaning = await find(MEANING);
      expect(meaning.body.mode).toBe('full-text-only');
      expect(meaning.body.message).toMatch(/Semantic search did not run/);
      expect(meaning.ids).toEqual([]);
      expect(journal().some((l) => l.status === 503)).toBe(true);

      setBackend('healthy');
    },
  );

  await chapter(
    'Step 8 · a token without page:view is refused by name, and no seam is called',
    async () => {
      const res = await searchRaw(request, s.noViewToken, s.projectKey, REFUSED_QUERY);
      const text = await res.text();
      expect(res.status(), text.slice(0, 400)).toBe(403);
      expect((JSON.parse(text) as { code: string }).code).toBe('PROJECT_ACCESS_DENIED');
      expect(text).not.toContain(TITLE);
      // A query embedded under the refusal would be in the journal by now: the
      // response is only written after the service returned or threw.
      expect(journal().filter((l) => l.input.includes(REFUSED_QUERY))).toEqual([]);
      // …and the same query from a caller who may search IS journalled, so the
      // absence above is not a journal that records nothing.
      await find(REFUSED_QUERY);
      expect(journal().filter((l) => l.input.includes(REFUSED_QUERY))).toHaveLength(1);
    },
  );

  await chapter('Step 9 · the MCP search_pages tool answers what REST answers', async () => {
    const rest = await find(MEANING);
    expect(rest.body.mode).toBe('merged');
    const client = await agent(s.token, baseURL);
    const result = (await client.callTool({
      name: 'search_pages',
      arguments: { projectKey: s.projectKey, q: MEANING },
    })) as CallToolResult;
    await client.close();
    expect(result.isError ?? false).toBe(false);
    const tool = result.structuredContent as unknown as SearchBody;
    expect(tool.items.map((h) => h.id)).toEqual(rest.ids);
    expect(tool.mode).toBe(rest.body.mode);
    expect(tool.message).toBe(rest.body.message);
  });

  await chapter('Step 10 · the published OpenAPI document describes the fused search', async () => {
    const res = await request.get('/api/openapi/v1.json');
    expect(res.status()).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const resolve = (schema: Record<string, unknown>): Record<string, unknown> =>
      typeof schema['$ref'] === 'string'
        ? doc.components.schemas[String(schema['$ref']).split('/').pop()!]!
        : schema;
    const ok = doc.paths['/api/v1/projects/{projectKey}/pages/search']!['get']!.responses[
      '200'
    ] as { content: Record<string, { schema: Record<string, unknown> }> };
    const result = resolve(ok.content['application/json']!.schema);
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(['items', 'message', 'mode', 'nextCursor']);
    expect(props['mode']!['enum']).toEqual(['merged', 'full-text-only', 'not-indexed']);
    expect(JSON.stringify(props['message'])).toContain('null');
    const hit = resolve(props['items']!['items'] as Record<string, unknown>);
    const rank = (hit['properties'] as Record<string, Record<string, unknown>>)['rank']!;
    expect(String(rank['description'])).toMatch(/Fused score/);
  });
});
