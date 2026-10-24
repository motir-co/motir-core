import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { actionWrite, pageRefresh } from './_helpers/authoritative-signal';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { foldersService } from '@/lib/services/foldersService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// A FILED WORK ITEM IS PLACED CORRECTLY EVERYWHERE ELSE — THE ACCEPTANCE RECEIPT
// (Story MOTIR-5309 · Subtask MOTIR-5380). The story's verification recipe, in a
// real browser against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The folders story let a person tidy work away; this one makes every other
// surface agree about where that work now is. The clip's two moments of doubt:
// the page of an item that was MOVED ON THE PAGE still telling the truth without
// a reload, and a saved view that leaves a folder out still leaving it out when
// it is opened again later.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
//
// A rail write is a Server Action POST to the item's own URL, told apart by its
// body (`authoritative-signal.ts`): the new parent's id for a re-parent, the
// folder's id for a filing. Each is followed by the page's placement re-read,
// whose body carries only the item's id. Both are armed BEFORE the click and
// their status asserted before anything is read off the page. A list read is the
// RSC GET the builder's `router.push` makes; the roadmap is its own API GET.
//
// Every rule behind these steps is proven below the browser, in
// tests/integration/folders/placementStoryGate.test.ts (MOTIR-5379). This spec
// proves the journey.

const PASSWORD = 'acceptance-placement-e2e-pass-123';
const FILTER_NAME = 'Not parked';

interface Seed {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
}

async function seedProject(email: string, identifier: string): Promise<Seed> {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Olivia Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Placement Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Data migration',
    identifier,
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return {
    ctx: { userId: owner.id, workspaceId: workspace.id },
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
  };
}

async function workItem(
  seed: Seed,
  kind: 'epic' | 'story' | 'task',
  title: string,
  parentId?: string,
) {
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind, title, parentId: parentId ?? null },
    seed.ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title: dto.title };
}

/** The story's seed: Parked ▸ 2025 holding Old import (with its story), and two
 * pieces of work filed nowhere. */
async function seedPlacement(seed: Seed) {
  const parked = await foldersService.createFolder(
    { projectId: seed.projectId, parentFolderId: null, name: 'Parked' },
    seed.ctx,
  );
  const y2025 = await foldersService.createFolder(
    { projectId: seed.projectId, parentFolderId: parked.id, name: '2025' },
    seed.ctx,
  );
  const oldImport = await workItem(seed, 'epic', 'Old import');
  const mapFields = await workItem(seed, 'story', 'Map legacy fields', oldImport.id);
  const q3 = await workItem(seed, 'epic', 'Q3 launch');
  const tidy = await workItem(seed, 'task', 'Tidy docs');
  await foldersService.fileWorkItem(oldImport.id, { folderId: y2025.id }, seed.ctx);
  return { parked, y2025, oldImport, mapFields, q3, tidy };
}

/** The rail card whose edit chevron is `Edit <label>` — scoped from the live main
 * landmark, so a streamed copy of the page can never match. */
const railCard = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: `Edit ${label}`, exact: true }) });

const folderCrumbs = (page: Page) =>
  page.getByRole('navigation', { name: 'Folder and parent work items', exact: true });
const parentCrumbs = (page: Page) =>
  page.getByRole('navigation', { name: 'Parent work items', exact: true });

/** The placement re-read that follows a rail write: its body names the item, and
 * never the parent or folder the write carried. */
function placementReread(page: Page, pathname: string, itemId: string, writeMarker: string) {
  return page.waitForResponse((res) => {
    const req = res.request();
    const body = req.postData() ?? '';
    return (
      req.method() === 'POST' &&
      req.headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === pathname &&
      body.includes(itemId) &&
      !body.includes(writeMarker)
    );
  });
}

const listRow = (page: Page, title: string) => page.getByRole('row').filter({ hasText: title });

test('a filed work item is placed correctly on its page, in a saved view and on the roadmap', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-5309');

  await resetDatabase();
  const seed = await seedProject('acceptance-placement@example.com', 'PLACE');
  const { parked, y2025, oldImport, mapFields, q3, tidy } = await seedPlacement(seed);

  await signIn(page, 'acceptance-placement@example.com', PASSWORD);

  await chapter('A filed item’s page says where it sits', async () => {
    await page.goto(`/items/${oldImport.identifier}`);
    await expect(folderCrumbs(page)).toContainText('Parked ▸ 2025');
    await expect(railCard(page, 'Folder')).toContainText('Parked ▸ 2025');
    await expect(railCard(page, 'Parent')).toContainText('None');
    await beat();

    await page.goto(`/items/${mapFields.identifier}`);
    const crumbs = folderCrumbs(page);
    await expect(crumbs).toContainText('Parked ▸ 2025');
    await expect(crumbs.getByRole('link', { name: /Old import/ })).toBeVisible();
    await expect(railCard(page, 'Folder')).toContainText('Parked ▸ 2025');
    await expect(railCard(page, 'Folder')).toContainText(
      `Through ${oldImport.identifier} Old import`,
    );
  });

  const storyPath = `/items/${mapFields.identifier}`;

  await chapter('Re-parent it on the page — the breadcrumb follows, no reload', async () => {
    await page.getByRole('button', { name: 'Edit Parent', exact: true }).click();
    await page.getByRole('combobox', { name: 'Parent', exact: true }).click();
    const option = page.getByRole('option', { name: /Q3 launch/ });
    await expect(option).toBeVisible();

    const write = actionWrite(page, storyPath, q3.id);
    const reread = placementReread(page, storyPath, mapFields.id, q3.id);
    await option.click();
    expect((await write).status(), 'the parent write').toBe(200);
    expect((await reread).status(), 'the placement re-read').toBe(200);

    await expect(parentCrumbs(page).getByRole('link', { name: /Q3 launch/ })).toBeVisible();
    await expect(folderCrumbs(page)).toHaveCount(0);
    await expect(railCard(page, 'Folder')).toContainText('No folder');
    expect(new URL(page.url()).pathname, 'the page was never reloaded').toBe(storyPath);
    await beat();
  });

  await chapter('File it back into Parked from the same page', async () => {
    await page.getByRole('button', { name: 'Edit Folder', exact: true }).click();
    const folders = page.getByRole('listbox', { name: 'Folders' });
    await expect(folders).toBeVisible();
    // The note sits in the Folder card, above its open picker — asserted on that card,
    // not on the whole landmark, so it cannot be satisfied by text elsewhere on the page.
    const openFolderCard = page
      .getByRole('main')
      .locator('[data-surface="card"]')
      .filter({ has: folders });
    await expect(openFolderCard).toContainText(
      `Filing it removes it from ${q3.identifier} Q3 launch.`,
    );
    await beat();

    const write = actionWrite(page, storyPath, parked.id);
    const reread = placementReread(page, storyPath, mapFields.id, parked.id);
    await folders.getByRole('option', { name: 'Parked', exact: true }).click();
    expect((await write).status(), 'the filing').toBe(200);
    expect((await reread).status(), 'the placement re-read').toBe(200);

    await expect(railCard(page, 'Folder')).toContainText('Parked');
    await expect(railCard(page, 'Parent')).toContainText('None');
    await expect(folderCrumbs(page)).toContainText('Parked');
    await expect(folderCrumbs(page).getByRole('link')).toHaveCount(0);
  });

  await chapter('Leave the Parked folder out of a saved view', async () => {
    await page.goto('/items?view=list');
    for (const item of [oldImport, mapFields, q3, tidy]) {
      await expect(listRow(page, item.title)).toBeVisible();
    }

    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Add condition' }).click();
    const row = dialog.getByRole('group', { name: 'Condition 1' });
    await row.getByRole('combobox', { name: 'Field' }).click();
    await page.getByRole('option', { name: 'Folder', exact: true }).click();
    await row.getByRole('combobox', { name: 'Operator' }).click();
    await page.getByRole('option', { name: 'is none of' }).click();
    await row.getByRole('combobox', { name: 'Folder values' }).click();

    const filtered = pageRefresh(page, '/items');
    await page.getByRole('option', { name: 'Parked', exact: true }).click();
    expect((await filtered).status(), 'the filtered list read').toBe(200);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    await expect(listRow(page, 'Q3 launch')).toBeVisible();
    await expect(listRow(page, 'Tidy docs')).toBeVisible();
    await expect(listRow(page, 'Old import')).toHaveCount(0);
    await expect(listRow(page, 'Map legacy fields')).toHaveCount(0);
    await beat();

    await page.getByRole('button', { name: 'Save as' }).click();
    const save = page.getByRole('dialog', { name: 'Save filter' });
    await expect(save).toBeVisible();
    await save.getByLabel('Name').fill(FILTER_NAME);
    const saved = page.waitForResponse(
      (res) =>
        /\/saved-filters$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
    );
    await save.getByRole('button', { name: 'Save filter' }).click();
    expect((await saved).ok(), 'the saved filter was written').toBe(true);
    await expect(save).not.toBeVisible();
  });

  await chapter('Open the saved view again — Parked is still left out', async () => {
    await page.goto('/items?view=list');
    await expect(listRow(page, 'Old import')).toBeVisible();

    await page.getByRole('button', { name: /^Saved filters/ }).click();
    const applied = pageRefresh(page, '/items');
    await page.getByRole('button', { name: new RegExp(`^${FILTER_NAME}`) }).click();
    expect((await applied).status(), 'the saved view’s list read').toBe(200);

    await expect(
      page.getByRole('button', { name: new RegExp(`Applied filter: ${FILTER_NAME}`) }),
    ).toBeVisible();
    await expect(listRow(page, 'Q3 launch')).toBeVisible();
    await expect(listRow(page, 'Tidy docs')).toBeVisible();
    await expect(listRow(page, 'Old import')).toHaveCount(0);
    await expect(listRow(page, 'Map legacy fields')).toHaveCount(0);
    await beat();
  });

  // RESTATED (Bug MOTIR-5710 · MOTIR-5741). This chapter used to assert "the
  // roadmap still shows Old import at the root" — Story MOTIR-5309's decision that
  // the roadmap is unchanged by filing. Design MOTIR-5713 retired that premise: on
  // /roadmap a filed work item leaves the root and sits inside its folder. The
  // chapter now asserts the new placement, rather than being deleted around.
  await chapter(
    'The roadmap shows Old import inside its folder, not loose at the root',
    async () => {
      const roots = page.waitForResponse(
        (res) =>
          res.url().includes('/api/projects/') &&
          res.url().includes('/roadmap') &&
          !res.url().includes('parentId') &&
          !res.url().includes('folderId') &&
          !res.url().includes('scope=sprint') &&
          res.request().method() === 'GET' &&
          res.ok(),
      );
      await page.goto('/roadmap');
      await roots;
      const canvas = page.getByRole('main').getByTestId('roadmap-canvas');
      await expect(canvas.getByText('Q3 launch', { exact: true })).toBeVisible();
      const parkedCard = canvas.locator(`[data-node-id="folder:${parked.id}"]`);
      await expect(parkedCard).toBeVisible();
      await expect(canvas.getByText('Old import', { exact: true })).toHaveCount(0);
      await beat();

      // Drill Parked. By now it holds the 2025 folder and Map legacy fields (the
      // chapters above filed that story straight into Parked); 2025 holds Old
      // import. Each hop is a real read by folder, awaited by its own response.
      const drillFolder = async (folderId: string, card: typeof parkedCard) => {
        const level = page.waitForResponse(
          (res) =>
            res.url().includes('/roadmap') &&
            res.url().includes(`folderId=${folderId}`) &&
            res.request().method() === 'GET' &&
            res.ok(),
        );
        await card.click();
        // Scoped to the LIVE canvas — never page-rooted (MOTIR-5037).
        await canvas.getByTestId('drill-button').click();
        await level;
      };
      await drillFolder(parked.id, parkedCard);
      const y2025Card = canvas.locator(`[data-node-id="folder:${y2025.id}"]`);
      await expect(y2025Card).toBeVisible();
      await expect(canvas.getByText('Map legacy fields', { exact: true })).toBeVisible();
      await expect(canvas.getByText('Old import', { exact: true })).toHaveCount(0);
      await beat();

      await drillFolder(y2025.id, y2025Card);
      await expect(canvas.getByText('Old import', { exact: true })).toBeVisible();
      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      await expect(crumbs).toContainText('Parked');
      await expect(crumbs).toContainText('2025');
      await beat();
    },
  );
});

test('a viewer without work_item:edit sees the folder on the page but cannot change it', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject('acceptance-placement-owner@example.com', 'PVIEW');
  const { oldImport } = await seedPlacement(seed);

  const viewer = await usersService.createUser({
    email: 'acceptance-placement-viewer@example.com',
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

  await signIn(page, 'acceptance-placement-viewer@example.com', PASSWORD);
  await page.goto(`/items/${oldImport.identifier}`);

  await expect(folderCrumbs(page)).toContainText('Parked ▸ 2025');
  const main = page.getByRole('main');
  await expect(
    main.locator('[data-surface="card"]').filter({ hasText: /^Folder\s*Parked ▸ 2025/ }),
  ).toBeVisible();
  await expect(main.getByRole('button', { name: 'Edit Folder', exact: true })).toHaveCount(0);
});
