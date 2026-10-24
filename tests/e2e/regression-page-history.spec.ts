import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import { markdownToUpdate } from '@/lib/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// A PAGE'S HISTORY — THE ACCEPTANCE RECEIPT (Story MOTIR-5754 · Subtask MOTIR-7390).
// The story's verification recipe, in a real browser against a production build
// and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Three chapters: two people change one page; the first opens History, finds the
// other's change as its own version and opens the older one beside the page; and
// restores it, so the page they are looking at shows their version again with
// every earlier version still listed.
//
// The recipe's "edit twice with a pause" is TWO AUTHORS here: the coalescing
// window is ten minutes of wall clock, and a different author always starts a
// new version, so the spec needs no clock control and no test-only setting.
//
// The three tests after the recorded one — a viewer, a restore held by an
// unsaved edit, a version pruned under the panel — run at machine speed.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Every body save is waited on by its own `POST /api/pages/<id>/updates`
// response, ARMED BEFORE the typing (one burst well under the autosave's 5 s cap
// is one request); every list by its `GET …/versions`, every version by its
// `GET …/versions/<n>`, and the restore by its `POST …/versions/<n>/restore`.
// Nothing waits on a timeout or on the save indicator.

const PASSWORD = 'acceptance-history-e2e-pass-123';
const ANA_EMAIL = 'acceptance-history-ana@example.com';
const BEN_EMAIL = 'acceptance-history-ben@example.com';
const VIEWER_EMAIL = 'acceptance-history-viewer@example.com';

const TYPING = { delay: 55 };

const TITLE = 'Incident runbook';
const ANA_LINE = 'Page the on-call engineer first.';
const BEN_LINE = 'Skip the pager and post in the channel.';

interface Seed {
  ana: ServiceContext;
  ben: ServiceContext;
  workspaceId: string;
  projectId: string;
}

async function seedProject(): Promise<Seed> {
  const ana = await usersService.createUser({
    email: ANA_EMAIL,
    password: PASSWORD,
    name: 'Ana Author',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'History Workspace',
    ownerUserId: ana.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: ana.id,
    name: 'On-call',
    identifier: 'ONC',
  });
  const anaCtx = { userId: ana.id, workspaceId: workspace.id };
  await projectsService.setActiveProject({ ...anaCtx, projectId: project.id });

  const ben = await usersService.createUser({
    email: BEN_EMAIL,
    password: PASSWORD,
    name: 'Ben Builder',
  });
  await workspacesService.addMember({ userId: ben.id, workspaceId: workspace.id });
  await addToProjectAs({
    key: project.identifier,
    actorUserId: ana.id,
    ctx: anaCtx,
    targetUserId: ben.id,
    role: 'member',
  });
  await projectsService.setActiveProject({
    userId: ben.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });

  const viewer = await usersService.createUser({
    email: VIEWER_EMAIL,
    password: PASSWORD,
    name: 'Vic Viewer',
  });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: workspace.id });
  await addToProjectAs({
    key: project.identifier,
    actorUserId: ana.id,
    ctx: anaCtx,
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await projectsService.setActiveProject({
    userId: viewer.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });

  return {
    ana: anaCtx,
    ben: { userId: ben.id, workspaceId: workspace.id },
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

/** A page with v1 by Ana and v2 by Ben, written through the services. */
async function seedTwoVersions(seed: Seed): Promise<string> {
  const created = await pagesService.createPage(seed.ana, {
    projectId: seed.projectId,
    title: TITLE,
  });
  const write = async (ctx: ServiceContext, markdown: string) => {
    const page = await pagesService.getPage(ctx, {
      projectId: seed.projectId,
      pageId: created.id,
    });
    const state = new Uint8Array(Buffer.from(page.bodyState, 'base64'));
    await pagesService.savePageUpdate(ctx, {
      projectId: seed.projectId,
      pageId: created.id,
      update: markdownToUpdate(state, markdown),
    });
  };
  await write(seed.ana, ANA_LINE);
  await write(seed.ben, `${ANA_LINE}\n\n${BEN_LINE}`);
  return created.id;
}

// ── Locators and waits ──────────────────────────────────────────────────────

/** The LIVE editor — the first body on the page; a compared version is the second. */
const liveBodyOf = (page: Page) =>
  page.getByRole('textbox', { name: 'Page body', exact: true }).first();
const historyButton = (page: Page) => page.getByRole('button', { name: 'History', exact: true });
const versionsList = (page: Page) =>
  page.getByRole('list', { name: 'Versions of this page', exact: true });
const rowsOf = (page: Page) => versionsList(page).getByRole('button');
const compared = (page: Page, n: number) =>
  page.getByRole('region', { name: `Version ${n}`, exact: true });
const restoreButton = (page: Page) =>
  page.getByRole('button', { name: 'Restore this version', exact: true });

function respondsTo(page: Page, path: string, method: string): Promise<Response> {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === method,
  );
}

const savesOf = (page: Page, id: string) => respondsTo(page, `/api/pages/${id}/updates`, 'POST');
const listOf = (page: Page, id: string) => respondsTo(page, `/api/pages/${id}/versions`, 'GET');
const versionOf = (page: Page, id: string, n: number) =>
  respondsTo(page, `/api/pages/${id}/versions/${n}`, 'GET');
const restoreOf = (page: Page, id: string, n: number) =>
  respondsTo(page, `/api/pages/${id}/versions/${n}/restore`, 'POST');

/** Open History and wait on the list it reads. */
async function openHistory(page: Page, id: string): Promise<void> {
  const listed = listOf(page, id);
  await historyButton(page).click();
  expect((await listed).status()).toBe(200);
  await expect(versionsList(page)).toBeVisible();
}

/** Select row `index` (v`n`) and wait on its read; returns the version's column. */
async function openVersion(page: Page, id: string, index: number, n: number): Promise<Locator> {
  const read = versionOf(page, id, n);
  await rowsOf(page).nth(index).click();
  expect((await read).status()).toBe(200);
  const column = compared(page, n);
  await expect(column).toBeVisible();
  return column;
}

test('two members change a page; History lists both; the older version opens beside it and is restored', async ({
  page,
  browser,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5754');
  test.setTimeout(240_000);

  await resetDatabase();
  await seedProject();
  await signIn(page, ANA_EMAIL, PASSWORD);

  let pageId = '';

  // Ben, in a second browser context — off camera; the clip follows Ana.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  try {
    await signIn(pageB, BEN_EMAIL, PASSWORD);

    await chapter('Two people change a page — Ana writes it, Ben adds a line', async () => {
      await page.getByRole('link', { name: 'Pages', exact: true }).click();
      await page.waitForURL('**/pages');
      const created = respondsTo(page, '/api/pages', 'POST');
      // The empty list draws a second New page; the header's comes first.
      await page.getByRole('button', { name: 'New page', exact: true }).first().click();
      const createdResponse = await created;
      expect(createdResponse.status()).toBe(201);
      pageId = ((await createdResponse.json()) as { id: string }).id;
      await page.waitForURL(`**/pages/${pageId}`);

      const title = page.getByRole('textbox', { name: 'Page title', exact: true });
      await expect(liveBodyOf(page)).toBeVisible();
      const renamed = respondsTo(page, `/api/pages/${pageId}`, 'PATCH');
      await title.pressSequentially(TITLE, TYPING);
      await title.press('Enter');
      expect((await renamed).status()).toBe(200);

      const saved = savesOf(page, pageId);
      await page.keyboard.type(ANA_LINE, TYPING);
      expect((await saved).status()).toBe(200);
      await beat();

      // Ben opens the same page and adds his own paragraph.
      await pageB.goto(`/pages/${pageId}`);
      await expect(liveBodyOf(pageB)).toContainText(ANA_LINE);
      const savedB = savesOf(pageB, pageId);
      await liveBodyOf(pageB).click();
      await pageB.keyboard.press('ControlOrMeta+End');
      await pageB.keyboard.press('Enter');
      await pageB.keyboard.type(BEN_LINE, TYPING);
      expect((await savedB).status()).toBe(200);

      // Ana's page, reloaded, carries Ben's line.
      await page.reload();
      await expect(liveBodyOf(page)).toContainText(BEN_LINE);
      await beat();
    });
  } finally {
    await contextB.close();
  }

  await chapter(
    'History lists both versions — Ben’s on top — and v1 opens beside the page',
    async () => {
      await openHistory(page, pageId);
      const rows = rowsOf(page);
      await expect(rows).toHaveCount(2);
      // Ana's create and her first save fold into v1: same author, inside the window.
      await expect(rows.nth(0)).toContainText('v2');
      await expect(rows.nth(0)).toContainText('Ben Builder');
      await expect(rows.nth(0)).toContainText('Current');
      await expect(rows.nth(1)).toContainText('v1');
      await expect(rows.nth(1)).toContainText('You');
      await beat();

      const v1 = await openVersion(page, pageId, 1, 1);
      await expect(
        page.getByRole('region', { name: 'Comparing v1 with the current page', exact: true }),
      ).toBeVisible();
      await expect(v1.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(
        ANA_LINE,
      );
      await expect(v1.getByRole('textbox', { name: 'Page body', exact: true })).not.toContainText(
        BEN_LINE,
      );
      // The live page beside it is unchanged and still writable.
      await expect(liveBodyOf(page)).toContainText(BEN_LINE);
      await expect(liveBodyOf(page)).toHaveAttribute('contenteditable', 'true');
      await beat();
    },
  );

  await chapter(
    'Restore v1 — the page shows Ana’s version again, as v3, and nothing is lost',
    async () => {
      await restoreButton(page).click();
      const dialog = page.getByRole('alertdialog', { name: 'Restore v1?', exact: true });
      await expect(dialog).toBeVisible();
      await beat();

      const restored = restoreOf(page, pageId, 1);
      const relisted = listOf(page, pageId);
      await dialog.getByRole('button', { name: 'Restore v1', exact: true }).click();
      expect((await restored).status()).toBe(200);
      expect((await relisted).status()).toBe(200);

      // The open editor remounted on the restored content.
      await expect(liveBodyOf(page)).toContainText(ANA_LINE);
      await expect(liveBodyOf(page)).not.toContainText(BEN_LINE);
      await expect(page.getByRole('region', { name: 'Version 1', exact: true })).toHaveCount(0);

      const rows = rowsOf(page);
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText('v3');
      await expect(rows.nth(0)).toContainText('Restored from v1');
      await expect(rows.nth(0)).toContainText('Current');
      await expect(rows.nth(1)).toContainText('v2');
      await expect(rows.nth(2)).toContainText('v1');
      await expect(
        page.getByRole('status').filter({ hasText: 'Restored v1 as v3.' }),
      ).toBeVisible();
      await beat();

      // A reload shows the same content.
      await page.reload();
      await expect(liveBodyOf(page)).toContainText(ANA_LINE);
      await expect(liveBodyOf(page)).not.toContainText(BEN_LINE);
    },
  );
});

test('a viewer sees the history and a version, and no Restore anywhere', async ({ page }) => {
  await resetDatabase();
  const seed = await seedProject();
  const id = await seedTwoVersions(seed);
  await signIn(page, VIEWER_EMAIL, PASSWORD);
  const res = await page.goto(`/pages/${id}`);
  expect(res?.status()).toBe(200);

  await openHistory(page, id);
  await expect(rowsOf(page)).toHaveCount(2);
  const v1 = await openVersion(page, id, 1, 1);
  await expect(v1.getByRole('textbox', { name: 'Page body', exact: true })).toContainText(ANA_LINE);
  await expect(restoreButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Restore/ })).toHaveCount(0);
});

test('an unsaved edit holds Restore with the explanation', async ({ page }) => {
  await resetDatabase();
  const seed = await seedProject();
  const id = await seedTwoVersions(seed);
  await signIn(page, ANA_EMAIL, PASSWORD);
  expect((await page.goto(`/pages/${id}`))?.status()).toBe(200);
  await openHistory(page, id);
  await openVersion(page, id, 1, 1);
  await expect(restoreButton(page)).toBeEnabled();

  const updates = `**/api/pages/${id}/updates`;
  await page.route(updates, (route) => route.abort('internetdisconnected'));
  const failed = page.waitForEvent(
    'requestfailed',
    (r) => r.url().endsWith(`/api/pages/${id}/updates`) && r.method() === 'POST',
  );
  await liveBodyOf(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Draft.', TYPING);
  await failed;

  await expect(restoreButton(page)).toBeDisabled();
  await expect(restoreButton(page)).toHaveAccessibleDescription(
    'Restore is held until your edits are saved. It becomes available as soon as the page says Saved.',
  );

  // Unblocked, the kept edit lands and Restore returns.
  const saved = savesOf(page, id);
  await page.unroute(updates);
  expect((await saved).status()).toBe(200);
  await expect(restoreButton(page)).toBeEnabled();
});

test('restoring a version pruned under the panel says it is no longer kept and refreshes the list', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject();
  const id = await seedTwoVersions(seed);
  await signIn(page, ANA_EMAIL, PASSWORD);
  expect((await page.goto(`/pages/${id}`))?.status()).toBe(200);
  await openHistory(page, id);
  await openVersion(page, id, 1, 1);

  // The version disappears between listing and restoring.
  await adminDb.pageVersion.deleteMany({ where: { pageId: id, number: 1 } });

  await restoreButton(page).click();
  const dialog = page.getByRole('alertdialog', { name: 'Restore v1?', exact: true });
  const refused = restoreOf(page, id, 1);
  const relisted = listOf(page, id);
  await dialog.getByRole('button', { name: 'Restore v1', exact: true }).click();
  expect((await refused).status()).toBe(404);
  expect((await relisted).status()).toBe(200);

  await expect(page.getByRole('alert').filter({ hasText: 'v1 is no longer kept' })).toBeVisible();
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Version 1', exact: true })).toHaveCount(0);
  await expect(liveBodyOf(page)).toContainText(BEN_LINE);
});
