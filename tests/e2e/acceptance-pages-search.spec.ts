// Acceptance E2E — a member searches pages from the Pages tree (Story MOTIR-9491
// · MOTIR-9640). The story's verification recipe, steps 1 to 6, in a real
// browser against the SERVED app: the Search box above the tree, a body-word
// hit that opens, a meaning-only hit, a page matching both ways listed once,
// Clear bringing the tree back with no request, and a query that matches
// nothing. One test, one chapter per recipe step, named `Step 1` to `Step 6`.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts, the lane whose server and job
// worker reach motir-ai at all. The ONE thing replaced is motir-ai's
// `POST /v1/embeddings`, by `lib/test-embeddings-mock.ts` in BOTH processes:
// the worker embeds a page after its save, the server embeds the typed query.
// Its vectors are a topic function of the text, so "engineers take turns
// answering overnight incidents" and "who gets woken up when production breaks"
// share a topic axis and no word, `rota` sits on that axis too, and `zephyr`
// has an axis of its own. Everything else is real: the session, the box's
// debounced hook, `GET /api/pages/search`, the fused query and the page route.
//
// Step 6 switches the seam to 503 through its control file: with meaning search
// running there is no query that matches nothing (it has no cut-off, MOTIR-9572),
// so the No-results state is reached through word search alone.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// A page's vector lags its save in the worker, so the seeded pages' rows are
// polled before the first chapter. The box sends one request once typing
// settles, so every query arms `waitForResponse` for that exact `q` before it
// types, and every assertion about hits follows that 200. There is no sleep.
//
// ── THE STRINGS ─────────────────────────────────────────────────────────────
// The tree stays mounted under `hidden` while results show, so every locator is
// by role (the accessibility tree skips hidden nodes), and every label matched
// is read from `messages/en.json`, never retyped.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made. CI is this spec's first run: the lane's `next build` cannot
// run in the cloud thread that wrote it.

import { writeFileSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { readFixtureFileSync } from '@/lib/test-fixture-file';
import type { EmbeddingsControl, EmbeddingsJournalLine } from '@/lib/test-embeddings-mock';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 300_000 });

const PASSWORD = 'pages-search-e2e-pass-123';
const EMAIL = 'pages-search-member@example.com';

// The recipe's own text.
const ROTA_TITLE = 'On-call rota';
const ROTA_BODY = 'engineers take turns answering overnight incidents';
const ROADMAP_TITLE = 'Quarterly roadmap';
const ROADMAP_BODY = 'The zephyr launch moves to the second quarter.';
const FOLDER = 'Planning';
const WORD = 'zephyr';
const MEANING = 'who gets woken up when production breaks';
const BOTH = 'rota';
const NOTHING = 'qxjvbnmw';

const S = en.pages.search;
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');

const CONTROL_PATH = process.env['MOTIR_AI_EMBEDDINGS_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_AI_EMBEDDINGS_JOURNAL_PATH']!;
const POLL = { timeout: 60_000 } as const;

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
  rotaId: string;
  roadmapId: string;
  folderId: string;
}

async function seed(): Promise<Seed> {
  const member = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Mia Member',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Search Workspace',
    ownerUserId: member.id,
  });
  const ctx = { userId: member.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: member.id,
    name: 'Platform',
    identifier: 'PSE',
  });
  await markProjectOnboarded(project.id);
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const folder = await foldersService.createFolder(
    { projectId: project.id, parentFolderId: null, name: FOLDER },
    ctx,
  );
  const rota = await pagesService.createPageFromMarkdown(ctx, {
    projectId: project.id,
    title: ROTA_TITLE,
    markdown: ROTA_BODY,
  });
  const roadmap = await pagesService.createPageFromMarkdown(ctx, {
    projectId: project.id,
    title: ROADMAP_TITLE,
    markdown: ROADMAP_BODY,
    parent: { kind: 'folder', id: folder.id },
  });
  return { rotaId: rota.id, roadmapId: roadmap.id, folderId: folder.id };
}

// ── The box ─────────────────────────────────────────────────────────────────

const isSearch = (url: string) => new URL(url).pathname === '/api/pages/search';

/** Type `q` into the box and return the 200 its settled request answered. */
async function searchFor(page: Page, q: string) {
  const answered = page.waitForResponse(
    (r) => isSearch(r.url()) && new URL(r.url()).searchParams.get('q') === q,
  );
  await box(page).fill(q);
  const res = await answered;
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    items: { id: string; title: string }[];
    mode: string;
    nextCursor: string | null;
  };
}

const box = (page: Page) => page.getByRole('searchbox', { name: S.label });
// A hit is a link inside the result list: the tree's own page rows carry links
// with the same names, so an unscoped link locator would find a tree row.
const results = (page: Page) => page.getByRole('list', { name: S.results });
const hit = (page: Page, title: string) =>
  results(page).getByRole('link', { name: title, exact: true });
const treeRow = (page: Page, title: string) => page.getByRole('treeitem', { name: title });

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

test('A member searches pages from the Pages tree: the recipe, steps 1 to 6', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9491');
  const s = await seed();
  // The worker embeds both pages after their save; wait for both rows.
  await expect
    .poll(
      () => adminDb.pageEmbedding.count({ where: { pageId: { in: [s.rotaId, s.roadmapId] } } }),
      POLL,
    )
    .toBe(2);
  await signIn(page, EMAIL, PASSWORD);

  await chapter('Step 1 · a Search box sits above the tree', async () => {
    // `?folder=` opens the tree to the Planning folder, so both pages are rows.
    await page.goto(`/pages?folder=${s.folderId}`);
    const region = page.getByRole('search', { name: S.label });
    await expect(region).toBeVisible();
    await expect(box(page)).toBeVisible();
    await expect(treeRow(page, ROTA_TITLE)).toBeVisible();
    await expect(treeRow(page, ROADMAP_TITLE)).toBeVisible();
    const boxTop = (await region.boundingBox())!.y;
    const treeTop = (await page.getByRole('tree').boundingBox())!.y;
    expect(boxTop).toBeLessThan(treeTop);
  });
  await beat();

  await chapter('Step 2 · a body word finds "Quarterly roadmap", which opens', async () => {
    const body = await searchFor(page, WORD);
    expect(body.items.map((h) => h.title)).toContain(ROADMAP_TITLE);
    const link = hit(page, ROADMAP_TITLE);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/pages/${s.roadmapId}`);
    await expect(link.getByRole('list', { name: en.pages.tree.breadcrumb.label })).toContainText(
      FOLDER,
    );
    await expect(link.locator('mark', { hasText: new RegExp(`^${WORD}$`, 'i') })).toHaveCount(1);
    await expect(treeRow(page, ROTA_TITLE)).toBeHidden();
    await beat();

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/pages/${s.roadmapId}$`));
    await expect(page.getByRole('textbox', { name: en.pages.page.titleLabel })).toHaveValue(
      ROADMAP_TITLE,
    );
  });
  await beat();

  await chapter('Step 3 · a question sharing no word finds "On-call rota" by meaning', async () => {
    await page.goto('/pages');
    await expect(box(page)).toBeVisible();
    const body = await searchFor(page, MEANING);
    expect(body.mode).toBe('merged');
    expect(body.items.map((h) => h.id)).toContain(s.rotaId);
    await expect(hit(page, ROTA_TITLE)).toBeVisible();
    await expect(page.getByRole('note')).toHaveCount(0);
    expect(journal().some((l) => l.status === 200 && l.input.includes(MEANING))).toBe(true);
  });
  await beat();

  await chapter('Step 4 · "rota" matches both ways and is listed once', async () => {
    const body = await searchFor(page, BOTH);
    expect(body.items.filter((h) => h.id === s.rotaId)).toHaveLength(1);
    await expect(hit(page, ROTA_TITLE)).toHaveCount(1);
  });
  await beat();

  await chapter('Step 5 · Clear brings the tree back, and a blank box sends nothing', async () => {
    const sent: Request[] = [];
    const count = (r: Request) => {
      if (isSearch(r.url())) sent.push(r);
    };
    page.on('request', count);
    await page.getByRole('button', { name: S.clear }).click();
    await expect(box(page)).toHaveValue('');
    await expect(treeRow(page, ROTA_TITLE)).toBeVisible();
    await box(page).fill('   ');
    await expect(treeRow(page, ROTA_TITLE)).toBeVisible();
    await expect(results(page)).toHaveCount(0);
    await expect(hit(page, ROTA_TITLE)).toHaveCount(0);
    // The empty hint describes the focused blank box: the box has settled.
    await expect(box(page)).toHaveAccessibleDescription(S.emptyHint);
    page.off('request', count);
    expect(sent).toHaveLength(0);
  });
  await beat();

  await chapter(
    'Step 6 · a query matching nothing says so, and Clear restores the tree',
    async () => {
      // Meaning search has no similarity cut-off (MOTIR-9572): while it runs,
      // every embedded page is a candidate, so no query can match nothing. A
      // query matches nothing only by words, so the meaning half is switched
      // off first, which the box draws as its word-matches-only note.
      setBackend('unavailable');
      const body = await searchFor(page, NOTHING);
      expect(body.mode).toBe('full-text-only');
      expect(body.items).toEqual([]);
      await expect(page.getByRole('note')).toHaveText(S.mode.fullText);
      const message = fill(S.noResults, { query: NOTHING });
      await expect(page.getByRole('paragraph').filter({ hasText: message })).toBeVisible();
      // Two Clear controls now: the box's own, then the No-results message's.
      const clears = page.getByRole('button', { name: S.clear });
      await expect(clears).toHaveCount(2);
      await clears.last().click();
      await expect(box(page)).toHaveValue('');
      await expect(treeRow(page, ROTA_TITLE)).toBeVisible();
    },
  );
  await beat();
});
