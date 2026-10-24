import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { actionWrite } from './_helpers/authoritative-signal';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import { foldersService } from '@/lib/services/foldersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// PAGES IN THE PROJECT TREE — THE ACCEPTANCE RECEIPT (Story MOTIR-5753 ·
// Subtask MOTIR-7378). The story's verification recipe, in a real browser
// against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One project's pages, arranged by hand: a folder with a page in it and a
// sub-page under that; the sub-page dragged out to the root between two pages
// and nudged with Move up / Move down, surviving a reload; the nested page
// opened, its sidebar tree selecting it inside its open folder and its
// breadcrumb reading Runbooks › Release process; a move into its own sub-page
// that the picker will not offer; the page moved to the root with its sub-page
// following; the folder deleted, its remaining page coming up to the root; and
// a Viewer who sees the same tree with nothing to change it with.
//
// The two tests after the recorded one are the story's whole-tree STATES —
// the empty project and an expand whose read fails — at machine speed, with no
// chapters (case 8).
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Every write is waited on by its own response, ARMED BEFORE the input that
// triggers it, and its status asserted before the next step:
//   · a page create — `POST /api/pages` (201), then the title's `PATCH`;
//   · a page move (Move to…, Move up / Move down, drag) — its
//     `PATCH /api/pages/<id>/placement`, whose BODY says where it landed;
//   · a folder create / delete — the Server Action POST to `/pages`, told apart
//     by the folder's name or id in its body (`actionWrite`).
// The tree is a client island that RE-READS the levels a move touched, so a
// row's new place arrives on a separate `GET /api/pages/tree?parent=…`; that
// read is armed with the write and awaited before the rows are asserted. A
// drag is judged by the committed placement and an authoritative read of the
// level, and the gesture is simply made again when it resolved to the wrong
// place (a drop that writes nothing changes nothing).

const PASSWORD = 'acceptance-pages-tree-e2e-pass-123';
const MEMBER_EMAIL = 'acceptance-pages-tree-member@example.com';
const VIEWER_EMAIL = 'acceptance-pages-tree-viewer@example.com';

/** Visible typing — slow enough to watch. */
const TYPING = { delay: 45 };

const FOLDER = 'Runbooks';
const PARENT = 'Release process';
const SUB = 'Rollback steps';
const SIBLING = 'On-call rota';

interface Seed {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
}

async function seedProject(): Promise<Seed> {
  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: PASSWORD,
    name: 'Mia Member',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Pages Tree Workspace',
    ownerUserId: member.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: member.id,
    name: 'Release train',
    identifier: 'RLT',
  });
  // Pinned active through the product's own write, so `/pages` resolves it.
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return {
    ctx: { userId: member.id, workspaceId: workspace.id },
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
  };
}

/** A Viewer of the seeded project, granted through the product's own member write. */
async function seedViewer(seed: Seed): Promise<void> {
  const viewer = await usersService.createUser({
    email: VIEWER_EMAIL,
    password: PASSWORD,
    name: 'Vic Viewer',
  });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: seed.workspaceId });
  await addToProjectAs({
    key: seed.projectIdentifier,
    actorUserId: seed.ctx.userId,
    ctx: seed.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await projectsService.setActiveProject({
    userId: viewer.id,
    workspaceId: seed.workspaceId,
    projectId: seed.projectId,
  });
}

type TreeRow = { kind: 'folder' | 'page'; id: string; name?: string; title?: string };

/** The AUTHORITATIVE read of one level, as the signed-in reader. */
async function readLevel(page: Page, parent: string): Promise<TreeRow[]> {
  const r = await page.request.get(`/api/pages/tree?parent=${encodeURIComponent(parent)}`);
  expect(r.status(), await r.text()).toBe(200);
  return ((await r.json()) as { rows: TreeRow[] }).rows;
}

const pageTitles = (rows: TreeRow[]) => rows.filter((r) => r.kind === 'page').map((r) => r.title);

/** The tree's read of one level — armed before the action that causes it. */
function levelRead(page: Page, parent: string, timeout?: number): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      new URL(r.url()).pathname === '/api/pages/tree' &&
      new URL(r.url()).searchParams.get('parent') === parent,
    timeout === undefined ? undefined : { timeout },
  );
}

/** One page's placement write — armed before the action that causes it. */
function placement(page: Page, pageId: string, timeout?: number): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      new URL(r.url()).pathname === `/api/pages/${pageId}/placement`,
    timeout === undefined ? undefined : { timeout },
  );
}

/**
 * A real pointer drag from `from` to a point `frac` of the way down `to`, past
 * dnd-kit's 8px activation, settling on the target before the release (the
 * caller releases, after arming its waits).
 */
async function dragTo(page: Page, from: Locator, to: Locator, frac: number) {
  const f = (await from.boundingBox())!;
  const t = (await to.boundingBox())!;
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height * frac;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx + 14, fy + 8, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 18 });
  await page.mouse.move(tx, ty, { steps: 4 });
}

test('a member arranges pages in the project tree; a viewer reads the same tree', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5753');
  test.setTimeout(240_000);

  await resetDatabase();
  const seed = await seedProject();
  await seedViewer(seed);
  // Two pages already at the root, so the sub-page has somewhere BETWEEN to go.
  await pagesService.createPage(seed.ctx, { projectId: seed.projectId, title: 'Alpha' });
  await pagesService.createPage(seed.ctx, { projectId: seed.projectId, title: 'Bravo' });

  await signIn(page, MEMBER_EMAIL, PASSWORD);

  const tree = page.getByRole('tree', { name: 'Folders and pages in this project', exact: true });
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });
  /** The root's PAGE rows, in the order they are drawn. */
  const rootPages = tree.locator('[data-testid="page-tree-page"][aria-level="1"]');
  const crumbs = page.getByRole('navigation', { name: 'Where this page is', exact: true });
  const sidebar = page.getByRole('tree', { name: 'Page tree', exact: true });
  const titleField = page.getByRole('textbox', { name: 'Page title', exact: true });

  /** Open a row's menu and choose one of its entries. */
  async function rowMenu(label: string, entry: string) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('menuitem', { name: entry, exact: true }).click();
  }

  /** Run `action` (a New), wait on the create, land on the page, and title it. */
  async function createAndTitle(action: () => Promise<void>, title: string): Promise<string> {
    const created = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/pages' && r.request().method() === 'POST',
    );
    await action();
    const res = await created;
    expect(res.status()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    await page.waitForURL(`**/pages/${id}`);
    await expect(titleField).toBeFocused();
    const renamed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/pages/${id}` && r.request().method() === 'PATCH',
    );
    await titleField.pressSequentially(title, TYPING);
    await titleField.press('Enter');
    expect((await renamed).status()).toBe(200);
    return id;
  }

  /** The breadcrumb's folder segment → `/pages?folder=<id>`, the tree open to it. */
  async function backToFolder(folderId: string) {
    await crumbs.getByRole('link', { name: new RegExp(FOLDER) }).click();
    await page.waitForURL(
      (u) => u.pathname === '/pages' && u.searchParams.get('folder') === folderId,
    );
    await expect(row(FOLDER)).toHaveAttribute('aria-expanded', 'true');
  }

  /** Open a page row's Move to… picker. */
  async function openMoveTo(title: string): Promise<Locator> {
    const rootRead = levelRead(page, 'root');
    await rowMenu(`Page actions for ${title}`, 'Move to…');
    expect((await rootRead).status()).toBe(200);
    const picker = page.getByRole('listbox', { name: 'Folders and pages', exact: true });
    await expect(picker.getByRole('option', { name: 'Project root' })).toBeVisible();
    return picker;
  }

  /** Expand the folder inside the picker; its level is a read of its own. */
  async function expandInPicker(picker: Locator, folderId: string) {
    const read = levelRead(page, `folder:${folderId}`);
    await picker.getByRole('button', { name: `Expand ${FOLDER}`, exact: true }).click();
    expect((await read).status()).toBe(200);
  }

  let folderId = '';
  let parentId = '';
  let subId = '';

  await chapter('Build the tree — a folder, a page in it, and a sub-page under that', async () => {
    // From the project sidebar's Pages entry.
    await page.getByRole('link', { name: 'Pages', exact: true }).click();
    await page.waitForURL('**/pages');
    await expect(row('Alpha')).toBeVisible();
    await expect(row('Bravo')).toBeVisible();

    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const nameField = page.getByRole('textbox', { name: 'Folder name', exact: true });
    await nameField.pressSequentially(FOLDER, TYPING);
    const createFolder = actionWrite(page, '/pages', FOLDER);
    await nameField.press('Enter');
    expect((await createFolder).status()).toBe(200);
    await expect(row(FOLDER)).toHaveAttribute('aria-level', '1');
    folderId = (await readLevel(page, 'root')).find(
      (r) => r.kind === 'folder' && r.name === FOLDER,
    )!.id;

    // New page here → the page itself, title first; then back through its breadcrumb.
    parentId = await createAndTitle(
      () => rowMenu(`Folder actions for ${FOLDER}`, 'New page here'),
      PARENT,
    );
    await backToFolder(folderId);

    subId = await createAndTitle(() => rowMenu(`Page actions for ${PARENT}`, 'New sub-page'), SUB);
    await backToFolder(folderId);

    await createAndTitle(() => rowMenu(`Folder actions for ${FOLDER}`, 'New page here'), SIBLING);
    await backToFolder(folderId);

    // The three are nested: folder › page › sub-page.
    const subLevel = levelRead(page, `page:${parentId}`);
    await row(PARENT)
      .getByRole('button', { name: `Expand ${PARENT}`, exact: true })
      .click();
    expect((await subLevel).status()).toBe(200);
    await expect(row(PARENT)).toHaveAttribute('aria-level', '2');
    await expect(row(SIBLING)).toHaveAttribute('aria-level', '2');
    await expect(row(SUB)).toHaveAttribute('aria-level', '3');
    await beat();
  });

  await chapter(
    'Reorder — drag the sub-page between Alpha and Bravo, then Move up and Move down',
    async () => {
      // A drop on Bravo's top quarter means BEFORE Bravo. Judged by what COMMITTED:
      // the placement's body, then the root as the server now holds it.
      const wanted = ['Alpha', SUB, 'Bravo'];
      let committed = false;
      for (let attempt = 0; attempt < 4 && !committed; attempt++) {
        await dragTo(page, row(SUB), row('Bravo'), 0.12);
        const answer = placement(page, subId, 5_000).catch(() => null);
        const reread = levelRead(page, 'root', 10_000).catch(() => null);
        await page.mouse.up();
        const res = await answer;
        if (!res || res.status() !== 200) continue; // nothing (or a refusal) was written
        const body = (await res.json()) as { parent: { kind: string } };
        if (body.parent.kind !== 'root') continue; // it landed elsewhere — drag it again
        expect((await reread)?.status()).toBe(200);
        committed =
          JSON.stringify(pageTitles(await readLevel(page, 'root'))) === JSON.stringify(wanted);
      }
      expect(committed, 'the drag committed the sub-page between Alpha and Bravo').toBe(true);
      await expect(rootPages).toHaveText(wanted);
      await beat();

      // Move up, then Move down — each one write, and the root re-read after it.
      for (const [entry, order] of [
        ['Move up', [SUB, 'Alpha', 'Bravo']],
        ['Move down', ['Alpha', SUB, 'Bravo']],
      ] as const) {
        const moved = placement(page, subId);
        const reread = levelRead(page, 'root');
        await rowMenu(`Page actions for ${SUB}`, entry);
        expect((await moved).status()).toBe(200);
        expect((await reread).status()).toBe(200);
        await expect(rootPages).toHaveText([...order]);
      }

      // The order is the server's, not the screen's.
      await page.reload();
      await expect(rootPages).toHaveText(wanted);
    },
  );

  await chapter(
    'Open the nested page — the sidebar selects it in its folder; the breadcrumb reads Runbooks › Release process',
    async () => {
      await row(PARENT).getByRole('link').click();
      await page.waitForURL(`**/pages/${parentId}`);

      const selected = sidebar.getByRole('treeitem', { name: PARENT, exact: true });
      await expect(selected).toHaveAttribute('aria-selected', 'true');
      await expect(selected).toHaveAttribute('aria-level', '2');
      await expect(sidebar.getByRole('treeitem', { name: FOLDER, exact: true })).toHaveAttribute(
        'aria-expanded',
        'true',
      );

      const links = crumbs.getByRole('link');
      await expect(links).toHaveCount(2);
      await expect(links.first()).toHaveText('Pages');
      await expect(links.nth(1)).toContainText(FOLDER);
      await expect(crumbs.locator('[aria-current="page"]')).toHaveText(PARENT);
    },
  );

  await chapter('A refused move — Release process cannot go into its own sub-page', async () => {
    await backToFolder(folderId);

    // First give it its sub-page back: Move to… a PAGE.
    let picker = await openMoveTo(SUB);
    await expandInPicker(picker, folderId);
    const renested = placement(page, subId);
    const subLevel = levelRead(page, `page:${parentId}`);
    await picker.getByRole('option', { name: PARENT, exact: true }).click();
    const renestedRes = await renested;
    expect(renestedRes.status()).toBe(200);
    expect(((await renestedRes.json()) as { parent: { id?: string } }).parent.id).toBe(parentId);
    expect((await subLevel).status()).toBe(200);
    await expect(row(SUB)).toHaveAttribute('aria-level', '3');

    // Now Move to… the parent: it is offered as itself, disabled with the
    // design's reason, and nothing beneath it — its sub-page — is offered at all.
    const writes: string[] = [];
    const onRequest = (r: { method(): string; url(): string }) => {
      if (r.method() === 'PATCH' && r.url().includes('/placement')) writes.push(r.url());
    };
    page.on('request', onRequest);
    picker = await openMoveTo(PARENT);
    await expandInPicker(picker, folderId);
    const self = picker.getByRole('option').filter({ hasText: PARENT });
    await expect(self).toHaveAttribute('aria-disabled', 'true');
    await expect(self).toContainText(
      'It’s this page — a page can’t move into itself or its sub-pages.',
    );
    await expect(picker.getByRole('button', { name: `Expand ${PARENT}` })).toHaveCount(0);
    await expect(picker.getByRole('option', { name: SUB })).toHaveCount(0);
    await beat();
    // Choosing it anyway does nothing: `force`, because a disabled option is
    // exactly what Playwright's actionability check would refuse to click.
    await self.click({ force: true });
    await expect(picker).toBeVisible();
    await picker.press('Escape');
    await expect(picker).toBeHidden();
    page.off('request', onRequest);

    // Nothing was asked of the server, and nothing moved.
    expect(writes).toEqual([]);
    expect(pageTitles(await readLevel(page, `page:${parentId}`))).toEqual([SUB]);
    expect(pageTitles(await readLevel(page, `folder:${folderId}`))).toEqual([PARENT, SIBLING]);
  });

  await chapter(
    'Move to… the root — the sub-page follows, and the breadcrumb updates',
    async () => {
      const picker = await openMoveTo(PARENT);
      const moved = placement(page, parentId);
      const reread = levelRead(page, 'root');
      const rereadFrom = levelRead(page, `folder:${folderId}`);
      await picker.getByRole('option', { name: 'Project root', exact: true }).click();
      const movedRes = await moved;
      expect(movedRes.status()).toBe(200);
      expect(((await movedRes.json()) as { parent: { kind: string } }).parent.kind).toBe('root');
      expect((await reread).status()).toBe(200);
      expect((await rereadFrom).status()).toBe(200);

      await expect(row(PARENT)).toHaveAttribute('aria-level', '1');
      await expect(row(SUB)).toHaveAttribute('aria-level', '2');
      expect(pageTitles(await readLevel(page, `page:${parentId}`))).toEqual([SUB]);

      await row(PARENT).getByRole('link').click();
      await page.waitForURL(`**/pages/${parentId}`);
      await expect(crumbs.getByRole('link')).toHaveCount(1);
      await expect(crumbs.getByRole('link')).toHaveText('Pages');
      await expect(crumbs.locator('[aria-current="page"]')).toHaveText(PARENT);
      await expect(sidebar.getByRole('treeitem', { name: PARENT, exact: true })).toHaveAttribute(
        'aria-level',
        '1',
      );
    },
  );

  await chapter('Delete the folder — what it still held comes up to the root', async () => {
    await crumbs.getByRole('link', { name: 'Pages', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/pages');
    await expect(row(FOLDER)).toBeVisible();

    await rowMenu(`Folder actions for ${FOLDER}`, 'Delete…');
    const confirm = page.getByRole('alertdialog', { name: `Delete folder “${FOLDER}”?` });
    await expect(confirm).toContainText('1 page will move to');
    await expect(confirm).toContainText('No work items or pages are deleted.');
    await beat();

    // The count has answered (it carries the same id), so this wait is the delete's.
    const remove = actionWrite(page, '/pages', folderId);
    const reread = levelRead(page, 'root');
    await confirm.getByRole('button', { name: 'Delete folder', exact: true }).click();
    expect((await remove).status()).toBe(200);
    expect((await reread).status()).toBe(200);
    await expect(confirm).toBeHidden();

    await expect(row(FOLDER)).toHaveCount(0);
    await expect(row(SIBLING)).toHaveAttribute('aria-level', '1');
    const root = await readLevel(page, 'root');
    expect(root.some((r) => r.kind === 'folder' && r.name === FOLDER)).toBe(false);
    expect(pageTitles(root)).toContain(SIBLING);
  });

  await chapter('A Viewer — the same tree and sidebar, with no New, Move or drag', async () => {
    await signIn(page, VIEWER_EMAIL, PASSWORD);
    await page.getByRole('link', { name: 'Pages', exact: true }).click();
    await page.waitForURL('**/pages');
    await expect(row(PARENT)).toBeVisible();
    await expect(row(SIBLING)).toBeVisible();

    await expect(page.getByRole('button', { name: 'New page', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0);
    await expect(tree.getByRole('button', { name: /^(Page|Folder) actions for / })).toHaveCount(0);
    await expect(tree.getByTestId('page-tree-drag-handle')).toHaveCount(0);

    await row(PARENT).getByRole('link').click();
    await page.waitForURL(`**/pages/${parentId}`);
    await expect(sidebar.getByRole('treeitem', { name: PARENT, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(sidebar.getByRole('button', { name: /actions for/ })).toHaveCount(0);
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText(PARENT);
    await expect(titleField).toHaveCount(0);
  });
});

test('an empty project shows the empty state, with New page and New folder', async ({ page }) => {
  await resetDatabase();
  const seed = await seedProject();
  // Every project is born with its Bugs folder; take it away so nothing is filed.
  const root = await pagesService.listTreeLevel(seed.ctx, {
    projectId: seed.projectId,
    parent: { kind: 'root' },
  });
  for (const r of root.rows) {
    if (r.kind === 'folder') {
      await foldersService.deleteFolder({ projectId: seed.projectId, folderId: r.id }, seed.ctx);
    }
  }

  await signIn(page, MEMBER_EMAIL, PASSWORD);
  const res = await page.goto('/pages');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'No pages yet', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New page', exact: true })).not.toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New folder', exact: true })).not.toHaveCount(0);
  await expect(
    page.getByRole('tree', { name: 'Folders and pages in this project', exact: true }),
  ).toHaveCount(0);
});

test('an expand whose read fails says so, and Try again reads it', async ({ page }) => {
  await resetDatabase();
  await seedProject();
  await signIn(page, MEMBER_EMAIL, PASSWORD);
  await page.goto('/pages');

  const tree = page.getByRole('tree', { name: 'Folders and pages in this project', exact: true });
  const bugs = tree.getByRole('treeitem', { name: 'Bugs', exact: true });
  await expect(bugs).toBeVisible();
  const bugsId = (await readLevel(page, 'root')).find(
    (r) => r.kind === 'folder' && r.name === 'Bugs',
  )!.id;

  // Only the RESPONSE of that one level is stubbed: the request is the tree's own.
  const isBugsLevel = (url: URL) =>
    url.pathname === '/api/pages/tree' && url.searchParams.get('parent') === `folder:${bugsId}`;
  await page.route(isBugsLevel, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
  );
  const failed = levelRead(page, `folder:${bugsId}`);
  await bugs.click();
  expect((await failed).status()).toBe(500);
  await expect(tree.getByRole('alert')).toHaveText('Couldn’t load what’s inside.');

  await page.unroute(isBugsLevel);
  const reread = levelRead(page, `folder:${bugsId}`);
  await tree.getByRole('button', { name: 'Try again', exact: true }).click();
  expect((await reread).status()).toBe(200);
  await expect(tree.getByRole('alert')).toHaveCount(0);
  await expect(tree.getByText('No pages here', { exact: true })).toBeVisible();
  await expect(bugs).toHaveAttribute('aria-expanded', 'true');
});
