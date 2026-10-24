import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import { markdownToUpdate } from '@/lib/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// ARCHIVE, RESTORE AND DELETE A PAGE — THE ACCEPTANCE RECEIPT (Story MOTIR-5755 ·
// Subtask MOTIR-7426). The story's verification recipe, in a real browser
// against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One recorded journey, as a Manager: a page with a sub-page is archived from
// the `/pages` tree — the confirm names the sub-page, both rows leave; Archived
// pages lists them as ONE row with its sub-page count, where it came from and
// who archived it; Restore puts both back under the project root between the
// same two pages they sat between; and the page, archived again, is opened by
// its address, deleted from its banner through the permanent-delete confirm,
// and its address then answers not-found.
//
// The tests after the recorded one run at machine speed, with no chapters:
// Undo in the archive toast; a restore whose parent is gone or archived; an
// archived page and an archived sub-page by their address; the list's empty
// state, Load more and a refused restore; and what a Member and a Viewer see.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Every write is waited on by its own response, ARMED BEFORE the click that
// sends it, and its status asserted before the next step:
//   · archive  — `POST   /api/pages/<id>/archive` (after the set read `GET`);
//   · restore  — `DELETE /api/pages/<id>/archive`;
//   · delete   — `DELETE /api/pages/<id>`.
// The tree is a client island: an archive takes the row out in place and then
// re-reads the level, and Undo re-reads it — `GET /api/pages/tree?parent=…`,
// armed with the write and awaited before the rows are asserted. The Archived
// pages list drops a restored or deleted row in place from the write's answer;
// Load more is waited on by its `GET /api/pages/archived` with a cursor.

const PASSWORD = 'acceptance-page-archive-e2e-pass-123';
const MANAGER_EMAIL = 'acceptance-archive-manager@example.com';
const MEMBER_EMAIL = 'acceptance-archive-member@example.com';
const VIEWER_EMAIL = 'acceptance-archive-viewer@example.com';
const MANAGER_NAME = 'Mia Manager';

const PARENT = 'Release process';
const SUB = 'Rollback steps';

interface Seed {
  manager: ServiceContext;
  member: ServiceContext;
  projectId: string;
}

async function seedProject(): Promise<Seed> {
  const manager = await usersService.createUser({
    email: MANAGER_EMAIL,
    password: PASSWORD,
    name: MANAGER_NAME,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Archive Workspace',
    ownerUserId: manager.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: manager.id,
    name: 'Release train',
    identifier: 'ARC',
  });
  const managerCtx = { userId: manager.id, workspaceId: workspace.id };
  await projectsService.setActiveProject({ ...managerCtx, projectId: project.id });

  const others: Record<'member' | 'viewer', string> = { member: '', viewer: '' };
  for (const [role, email, name] of [
    ['member', MEMBER_EMAIL, 'Max Member'],
    ['viewer', VIEWER_EMAIL, 'Vic Viewer'],
  ] as const) {
    const user = await usersService.createUser({ email, password: PASSWORD, name });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: project.identifier,
      actorUserId: manager.id,
      ctx: managerCtx,
      targetUserId: user.id,
      role,
    });
    await projectsService.setActiveProject({
      userId: user.id,
      workspaceId: workspace.id,
      projectId: project.id,
    });
    others[role] = user.id;
  }

  return {
    manager: managerCtx,
    member: { userId: others.member, workspaceId: workspace.id },
    projectId: project.id,
  };
}

async function make(
  seed: Seed,
  title: string,
  parent?: { kind: 'page'; id: string },
): Promise<string> {
  return (await pagesService.createPage(seed.manager, { projectId: seed.projectId, title, parent }))
    .id;
}

const at = (seed: Seed, pageId: string) => ({ projectId: seed.projectId, pageId });

/** A body save through the service — one `page_version` per author. */
async function write(seed: Seed, ctx: ServiceContext, pageId: string, markdown: string) {
  const current = await pagesService.getPage(ctx, at(seed, pageId));
  await pagesService.savePageUpdate(ctx, {
    ...at(seed, pageId),
    update: markdownToUpdate(new Uint8Array(Buffer.from(current.bodyState, 'base64')), markdown),
  });
}

// ── Locators and waits ──────────────────────────────────────────────────────

const treeOf = (page: Page) =>
  page.getByRole('tree', { name: 'Folders and pages in this project', exact: true });
const rowOf = (page: Page, title: string) =>
  treeOf(page).getByRole('treeitem', { name: title, exact: true });
/** The root's PAGE rows, in the order they are drawn. */
const rootPagesOf = (page: Page) =>
  treeOf(page).locator('[data-testid="page-tree-page"][aria-level="1"]');
const listOf = (page: Page) => page.getByRole('table', { name: 'Archived pages', exact: true });
/** A list row, by its page link (a `hasText` filter would also match "No sub-pages"). */
const listRow = (page: Page, title: string) =>
  listOf(page)
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: title, exact: true }) });
/** The archived banner — a `status` named by its heading. */
const bannerOf = (page: Page, name = 'This page is archived') =>
  page.getByRole('status', { name, exact: true });
/**
 * A toast, inside the toast region (app chrome named "Notifications (F8)") — so
 * neither a streamed copy of the page nor the screen-reader announcement, which
 * repeats the text without the action button, can match.
 */
const toastOf = (page: Page, text: string) =>
  page
    .getByRole('region', { name: /Notifications/ })
    .getByRole('listitem')
    .filter({ hasText: text });

function respondsTo(
  page: Page,
  path: string,
  method: string,
  search?: (params: URLSearchParams) => boolean,
): Promise<Response> {
  return page.waitForResponse((r) => {
    const url = new URL(r.url());
    return (
      url.pathname === path &&
      r.request().method() === method &&
      (search === undefined || search(url.searchParams))
    );
  });
}

const archiveOf = (page: Page, id: string) => respondsTo(page, `/api/pages/${id}/archive`, 'POST');
const restoreOf = (page: Page, id: string) =>
  respondsTo(page, `/api/pages/${id}/archive`, 'DELETE');
const deleteOf = (page: Page, id: string) => respondsTo(page, `/api/pages/${id}`, 'DELETE');
const levelRead = (page: Page, parent: string) =>
  respondsTo(page, '/api/pages/tree', 'GET', (q) => q.get('parent') === parent);

/** Open a tree row's menu and choose one of its entries. */
async function rowMenu(page: Page, title: string, entry: string) {
  await page.getByRole('button', { name: `Page actions for ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: entry, exact: true }).click();
}

/** Open `/pages/archived` from the `/pages` header's link. */
async function openArchivedPages(page: Page) {
  await page.getByRole('link', { name: 'Archived pages', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/pages/archived');
  await expect(page.getByRole('heading', { name: 'Archived pages', level: 1 })).toBeVisible();
}

// ── The recorded journey ────────────────────────────────────────────────────

test('a manager archives a page with its sub-page, finds it in Archived pages, restores it, and deletes it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5755');
  test.setTimeout(240_000);

  await resetDatabase();
  const seed = await seedProject();
  // Three pages at the root, so the restored page has a place BETWEEN to return to.
  await make(seed, 'Alpha');
  const parentId = await make(seed, PARENT);
  await make(seed, SUB, { kind: 'page', id: parentId });
  await make(seed, 'Bravo');
  const wanted = ['Alpha', PARENT, 'Bravo'];

  await signIn(page, MANAGER_EMAIL, PASSWORD);

  await chapter(
    'Archive a page with its sub-page — the confirm names it, both leave the tree',
    async () => {
      await page.getByRole('link', { name: 'Pages', exact: true }).click();
      await page.waitForURL('**/pages');
      await expect(rootPagesOf(page)).toHaveText(wanted);
      const expanded = levelRead(page, `page:${parentId}`);
      await rowOf(page, PARENT)
        .getByRole('button', { name: `Expand ${PARENT}`, exact: true })
        .click();
      expect((await expanded).status()).toBe(200);
      await expect(rowOf(page, SUB)).toHaveAttribute('aria-level', '2');

      // The set is read first; a page with a sub-page confirms.
      const setRead = respondsTo(page, `/api/pages/${parentId}/archive`, 'GET');
      await rowMenu(page, PARENT, 'Archive…');
      expect((await setRead).status()).toBe(200);
      const confirm = page.getByRole('alertdialog', {
        name: `Archive “${PARENT}” and its 1 sub-page?`,
        exact: true,
      });
      await expect(confirm).toContainText('2 pages will be archived');
      await expect(confirm).toContainText(SUB);
      await expect(confirm).toContainText('Nothing is deleted.');
      await beat();

      const archived = archiveOf(page, parentId);
      const reread = levelRead(page, 'root');
      await confirm.getByRole('button', { name: 'Archive 2 pages', exact: true }).click();
      const archivedRes = await archived;
      expect(archivedRes.status()).toBe(200);
      expect(await archivedRes.json()).toMatchObject({ rootId: parentId, subPageCount: 1 });
      expect((await reread).status()).toBe(200);
      await expect(confirm).toBeHidden();

      await expect(toastOf(page, `Archived “${PARENT}” and 1 sub-page`)).toBeVisible();
      await expect(rowOf(page, PARENT)).toHaveCount(0);
      await expect(rowOf(page, SUB)).toHaveCount(0);
      await expect(rootPagesOf(page)).toHaveText(['Alpha', 'Bravo']);
      await beat();
    },
  );

  await chapter(
    'Archived pages — one row, with its sub-page, where it came from and who archived it',
    async () => {
      await openArchivedPages(page);
      const rows = listOf(page).getByRole('rowgroup').last().getByRole('row');
      await expect(rows).toHaveCount(1);
      const row = listRow(page, PARENT);
      await expect(row).toContainText('1 sub-page');
      await expect(row).toContainText('Project root');
      await expect(row).toContainText(MANAGER_NAME);
      // The sub-page left with its root: it is not a row of its own.
      await expect(listRow(page, SUB)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Restore — both come back under the project root, between Alpha and Bravo',
    async () => {
      const restored = restoreOf(page, parentId);
      await page.getByRole('button', { name: `Restore “${PARENT}”`, exact: true }).click();
      const restoredRes = await restored;
      expect(restoredRes.status()).toBe(200);
      expect(await restoredRes.json()).toMatchObject({
        restoredIds: [parentId, expect.any(String)],
        landing: { kind: 'original', parentPageId: null, folderId: null },
      });
      await expect(toastOf(page, `Restored “${PARENT}” and 1 sub-page`)).toBeVisible();
      // The row leaves the list, and the list is empty.
      await expect(page.getByRole('heading', { name: 'No archived pages' })).toBeVisible();

      // `/pages` renders the root level on the server: no tree read to wait on.
      await page.getByRole('button', { name: 'Back to Pages', exact: true }).click();
      await page.waitForURL((u) => u.pathname === '/pages');
      await expect(rootPagesOf(page)).toHaveText(wanted);
      const expanded = levelRead(page, `page:${parentId}`);
      await rowOf(page, PARENT)
        .getByRole('button', { name: `Expand ${PARENT}`, exact: true })
        .click();
      expect((await expanded).status()).toBe(200);
      await expect(rowOf(page, SUB)).toHaveAttribute('aria-level', '2');
      await beat();
    },
  );

  await chapter(
    'Archive it again and delete it from its banner — permanently, with its history',
    async () => {
      const setRead = respondsTo(page, `/api/pages/${parentId}/archive`, 'GET');
      await rowMenu(page, PARENT, 'Archive…');
      expect((await setRead).status()).toBe(200);
      const confirm = page.getByRole('alertdialog', {
        name: `Archive “${PARENT}” and its 1 sub-page?`,
        exact: true,
      });
      const archived = archiveOf(page, parentId);
      await confirm.getByRole('button', { name: 'Archive 2 pages', exact: true }).click();
      expect((await archived).status()).toBe(200);
      await expect(rowOf(page, PARENT)).toHaveCount(0);

      // The archived page, opened from its row in Archived pages.
      await openArchivedPages(page);
      await listRow(page, PARENT).getByRole('link', { name: PARENT, exact: true }).click();
      await page.waitForURL(`**/pages/${parentId}`);
      const banner = bannerOf(page);
      await expect(banner).toContainText('This page is archived');
      await expect(banner).toContainText(`Archived by ${MANAGER_NAME}`);
      await expect(banner).toContainText('Its 1 sub-page was archived with it.');

      await banner.getByRole('button', { name: 'Delete…', exact: true }).click();
      const dialog = page.getByRole('alertdialog', {
        name: `Delete “${PARENT}” permanently?`,
        exact: true,
      });
      await expect(dialog).toContainText('every saved version and image');
      await expect(dialog).toContainText('This can’t be undone.');
      await expect(dialog).toContainText('2 pages will be deleted');
      await beat();

      const deleted = deleteOf(page, parentId);
      await dialog.getByRole('button', { name: 'Delete 2 pages', exact: true }).click();
      expect((await deleted).status()).toBe(200);
      await page.waitForURL((u) => u.pathname === '/pages');
      await expect(toastOf(page, `Deleted “${PARENT}” and 1 sub-page`)).toBeVisible();
      await expect(rootPagesOf(page)).toHaveText(['Alpha', 'Bravo']);

      // Gone from the archive, and its address answers not-found.
      await openArchivedPages(page);
      await expect(page.getByRole('heading', { name: 'No archived pages' })).toBeVisible();
      const res = await page.goto(`/pages/${parentId}`);
      expect(res?.status()).toBe(404);
    },
  );
});

// ── The rest of the recipe, at machine speed ────────────────────────────────

test('Undo in the archive toast puts the page back in its row', async ({ page }) => {
  await resetDatabase();
  const seed = await seedProject();
  const alphaId = await make(seed, 'Alpha');
  await make(seed, 'Bravo');
  await make(seed, 'Charlie');
  await signIn(page, MANAGER_EMAIL, PASSWORD);
  await page.goto('/pages');
  await expect(rootPagesOf(page)).toHaveText(['Alpha', 'Bravo', 'Charlie']);

  // A page with no sub-pages archives at once — no confirm.
  const archived = archiveOf(page, alphaId);
  await rowMenu(page, 'Alpha', 'Archive…');
  expect((await archived).status()).toBe(200);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(rootPagesOf(page)).toHaveText(['Bravo', 'Charlie']);

  const toast = toastOf(page, 'Archived “Alpha”');
  const restored = restoreOf(page, alphaId);
  const reread = levelRead(page, 'root');
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await restored).status()).toBe(200);
  expect((await reread).status()).toBe(200);
  await expect(rootPagesOf(page)).toHaveText(['Alpha', 'Bravo', 'Charlie']);
  await expect(toastOf(page, 'Restored “Alpha”')).toBeVisible();
});

test('a restore whose parent is gone or archived lands under the next page up, and the toast says where', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject();
  // Grand › Parent › Sub: Sub archived alone, then Parent archived and DELETED.
  const grand = await make(seed, 'Grand');
  const parent = await make(seed, 'Parent', { kind: 'page', id: grand });
  const sub = await make(seed, 'Sub', { kind: 'page', id: parent });
  await pagesService.archivePage(seed.manager, at(seed, sub));
  await pagesService.archivePage(seed.manager, at(seed, parent));
  await pagesService.deletePage(seed.manager, at(seed, parent));
  // Elder › Middle › Child: Child archived alone, then Middle archived (kept).
  const elder = await make(seed, 'Elder');
  const middle = await make(seed, 'Middle', { kind: 'page', id: elder });
  const child = await make(seed, 'Child', { kind: 'page', id: middle });
  await pagesService.archivePage(seed.manager, at(seed, child));
  await pagesService.archivePage(seed.manager, at(seed, middle));

  await signIn(page, MANAGER_EMAIL, PASSWORD);
  await page.goto('/pages/archived');

  // The deleted parent's delete re-homed Sub to its place, under Grand
  // (ADR §7 AMENDMENT 2): it restores THERE — never silently at the root.
  await expect(listRow(page, 'Sub')).toContainText('Grand');
  const restoredSub = restoreOf(page, sub);
  await page.getByRole('button', { name: 'Restore “Sub”', exact: true }).click();
  const subRes = await restoredSub;
  expect(subRes.status()).toBe(200);
  expect(await subRes.json()).toMatchObject({
    landing: { kind: 'original', parentPageId: grand, title: 'Grand' },
  });
  await expect(toastOf(page, 'Restored “Sub”')).toBeVisible();
  await expect(listRow(page, 'Sub')).toHaveCount(0);

  // Child's parent is still archived: it lands under Elder, and the toast says why.
  await expect(listRow(page, 'Child')).toContainText('Middle');
  await expect(listRow(page, 'Child')).toContainText('(archived)');
  const restoredChild = restoreOf(page, child);
  await page.getByRole('button', { name: 'Restore “Child”', exact: true }).click();
  expect((await restoredChild).status()).toBe(200);
  await expect(
    toastOf(page, 'Restored under “Elder”, because “Middle” is archived.'),
  ).toBeVisible();

  // The tree shows each where the toast said.
  await page.goto('/pages');
  for (const [top, landed] of [
    ['Grand', 'Sub'],
    ['Elder', 'Child'],
  ] as const) {
    const topId = top === 'Grand' ? grand : elder;
    const read = levelRead(page, `page:${topId}`);
    await rowOf(page, top)
      .getByRole('button', { name: `Expand ${top}`, exact: true })
      .click();
    expect((await read).status()).toBe(200);
    await expect(rowOf(page, landed)).toHaveAttribute('aria-level', '2');
  }
  await expect(rowOf(page, 'Middle')).toHaveCount(0);
  await expect(rowOf(page, 'Parent')).toHaveCount(0);
});

test('an archived page by its address: the banner, a read-only editor, no Restore version; its sub-page links to it', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject();
  const root = await make(seed, 'Handbook');
  const sub = await make(seed, 'Onboarding', { kind: 'page', id: root });
  await write(seed, seed.manager, root, 'First draft.');
  await write(seed, seed.member, root, 'First draft.\n\nA second paragraph.');
  await pagesService.archivePage(seed.manager, at(seed, root));

  await signIn(page, MANAGER_EMAIL, PASSWORD);
  expect((await page.goto(`/pages/${root}`))?.status()).toBe(200);
  const banner = bannerOf(page);
  await expect(banner).toContainText('This page is archived');
  await expect(banner).toContainText(`Archived by ${MANAGER_NAME}`);
  await expect(banner).toContainText('Its 1 sub-page was archived with it.');
  await expect(
    banner.getByRole('button', { name: 'Restore “Handbook”', exact: true }),
  ).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Delete…', exact: true })).toBeVisible();

  // Read-only: no title field, a body that cannot be edited, no page ⋯ to archive.
  await expect(page.getByRole('textbox', { name: 'Page title', exact: true })).toHaveCount(0);
  const body = page.getByRole('textbox', { name: 'Page body', exact: true }).first();
  await expect(body).toContainText('A second paragraph.');
  await expect(body).toHaveAttribute('contenteditable', 'false');
  await expect(
    page.getByRole('button', { name: 'Page actions for Handbook', exact: true }),
  ).toHaveCount(0);

  // History reads, and offers no Restore version.
  const listed = respondsTo(page, `/api/pages/${root}/versions`, 'GET');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  expect((await listed).status()).toBe(200);
  const rows = page
    .getByRole('list', { name: 'Versions of this page', exact: true })
    .getByRole('button');
  await expect(rows).toHaveCount(2);
  const v1 = respondsTo(page, `/api/pages/${root}/versions/1`, 'GET');
  await rows.nth(1).click();
  expect((await v1).status()).toBe(200);
  await expect(page.getByRole('region', { name: 'Version 1', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Version 1', exact: true })
      .getByText('Versions of an archived page can be read, not restored. Restore the page first.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore this version', exact: true })).toHaveCount(
    0,
  );

  // The sub-page's banner names its root and links to it — its only action.
  expect((await page.goto(`/pages/${sub}`))?.status()).toBe(200);
  const subBanner = bannerOf(page, 'This page was archived with “Handbook”');
  await expect(subBanner).toBeVisible();
  await expect(subBanner.getByRole('button')).toHaveCount(0);
  await subBanner.getByRole('link', { name: 'Open “Handbook”' }).click();
  await page.waitForURL(`**/pages/${root}`);
  await expect(bannerOf(page)).toContainText('This page is archived');
});

test('Archived pages: the empty state, Load more past 50, and a refused restore', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject();
  await signIn(page, MANAGER_EMAIL, PASSWORD);

  // Nothing archived yet.
  expect((await page.goto('/pages/archived'))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'No archived pages' })).toBeVisible();
  await expect(listOf(page)).toHaveCount(0);

  // 51 archive roots: one page of 50, then Load more.
  for (let i = 0; i < 51; i++) {
    const id = await make(seed, `Old note ${String(i).padStart(2, '0')}`);
    await pagesService.archivePage(seed.manager, at(seed, id));
  }
  await page.reload();
  const rows = listOf(page).getByRole('rowgroup').last().getByRole('row');
  await expect(rows).toHaveCount(50);
  await expect(page.getByRole('main').getByText('50 shown', { exact: true })).toBeVisible();

  // Hold the next page's answer, so its loading state can be seen.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const isNext = (url: URL) =>
    url.pathname === '/api/pages/archived' && url.searchParams.has('cursor');
  await page.route(isNext, async (route) => {
    await held;
    await route.continue();
  });
  const more = respondsTo(page, '/api/pages/archived', 'GET', (q) => q.has('cursor'));
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Loading…' })).toBeVisible();
  release();
  expect((await more).status()).toBe(200);
  await page.unroute(isNext);
  await expect(rows).toHaveCount(51);
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);

  // A refused restore: a row that, behind this tab, became part of its parent's
  // archive — PAGE_ARCHIVE_ROOT_REQUIRED's message, and the stale row leaves.
  const guide = await make(seed, 'Guide');
  const chapterId = await make(seed, 'Chapter one', { kind: 'page', id: guide });
  await pagesService.archivePage(seed.manager, at(seed, chapterId));
  await page.reload();
  await expect(listRow(page, 'Chapter one')).toBeVisible();
  await pagesService.restorePage(seed.manager, at(seed, chapterId));
  await pagesService.archivePage(seed.manager, at(seed, guide));

  const refused = restoreOf(page, chapterId);
  await page.getByRole('button', { name: 'Restore “Chapter one”', exact: true }).click();
  const refusedRes = await refused;
  expect(refusedRes.status()).toBe(409);
  expect(await refusedRes.json()).toMatchObject({ code: 'PAGE_ARCHIVE_ROOT_REQUIRED' });
  const toast = toastOf(page, 'Couldn’t restore “Chapter one”');
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
  await expect(listRow(page, 'Chapter one')).toHaveCount(0);
});

test('a member archives and restores but never deletes; a viewer sees no Archive, Restore or Delete', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject();
  await make(seed, 'Live page');
  const archived = await make(seed, 'Shelved');
  await pagesService.archivePage(seed.manager, at(seed, archived));

  // A Member.
  await signIn(page, MEMBER_EMAIL, PASSWORD);
  await page.goto('/pages');
  await page.getByRole('button', { name: 'Page actions for Live page', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Archive…', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete…' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await openArchivedPages(page);
  await expect(page.getByRole('button', { name: 'Restore “Shelved”', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'More actions for “Shelved”' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Delete/ })).toHaveCount(0);

  await page.goto(`/pages/${archived}`);
  await expect(bannerOf(page).getByRole('button', { name: 'Restore “Shelved”' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Delete/ })).toHaveCount(0);

  // A Viewer.
  await signIn(page, VIEWER_EMAIL, PASSWORD);
  await page.goto('/pages');
  await expect(rowOf(page, 'Live page')).toBeVisible();
  await expect(treeOf(page).getByRole('button', { name: /actions for/ })).toHaveCount(0);

  await openArchivedPages(page);
  await expect(listRow(page, 'Shelved')).toBeVisible();
  await expect(page.getByRole('button', { name: /Restore|Delete|More actions/ })).toHaveCount(0);

  await page.goto(`/pages/${archived}`);
  await expect(bannerOf(page)).toContainText('This page is archived');
  await expect(bannerOf(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Restore|Delete|Archive/ })).toHaveCount(0);
});
