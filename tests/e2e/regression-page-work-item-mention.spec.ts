import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { actionWrite } from './_helpers/authoritative-signal';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { markdownToUpdate } from '@/lib/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import { projectAccessData } from '../helpers/projectAccess';

// A PAGE NAMES A WORK ITEM, AND THE WORK ITEM KNOWS IT — THE ACCEPTANCE RECEIPT
// (Story MOTIR-7565 · Subtask MOTIR-7577). The story's verification recipe, in a
// real browser against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One recorded journey, as a project Member: on a page, `@` and a few letters of
// a title open the picker, which lists THIS project's matching work items and
// none from a second project whose item matches too; choosing one drops a chip
// (key, title, status) and the page saves. The work item's Pages section then
// lists the page — Mentioned, with when it was last edited — and its row leads
// back to the page. The item moves to In Progress and the page, reloaded, shows
// the chip's new status. Deleting the chip empties the section; mentioning it
// again and archiving the page (through the page's own Archive dialog) takes the
// page out of the section, and restoring it puts it back.
//
// The test after the recorded one runs at machine speed, with no chapters: a
// Visitor of the project, made public, sees no Pages section on the same item a
// member sees it on.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Every body save is waited on by its own `POST /api/pages/<id>/updates`
// response, ARMED BEFORE the input that triggers it, and then the toolbar's save
// indicator reading Saved — the `pages-write.spec.ts` signal. The picker's
// search by its `GET /api/work-items/mention-search` for the exact query; the
// Pages section by its `GET /api/work-items/<id>/pages` (a client island that
// reads on mount); the status change by its server-action response (marked by
// `toStatusKey`); the archive by its set read and `POST …/archive`, the restore
// by `DELETE …/archive`. Nothing waits on a timeout: every `beat()` is pacing
// for the viewer, taken after the state it shows is already proven. The longer
// beats sit where there is most to read (the picker's list, the Pages row, the
// chip's new status); every other phase ends on `chapter()`'s own hold.

const PASSWORD = 'acceptance-page-mention-e2e-pass-123';
const OWNER_EMAIL = 'acceptance-mention-owner@example.com';
const MEMBER_EMAIL = 'acceptance-mention-member@example.com';
const VISITOR_EMAIL = 'acceptance-mention-visitor@example.com';

const TYPING = { delay: 45 };

const PAGE_TITLE = 'Checkout launch plan';
const SUB_TITLE = 'Rollback steps';
const INTRO = 'The payments team owns this launch.';
const LEAD_IN = 'Blocked on ';
const QUERY = 'Checkout';

const ITEM_A = 'Checkout retry backoff';
const ITEM_B = 'Checkout tax rounding';
const OTHER_ITEM = 'Checkout analytics export';

interface Seed {
  owner: ServiceContext;
  member: ServiceContext;
  projectId: string;
  pageId: string;
  subPageId: string;
  itemA: { id: string; key: string };
  itemB: { id: string; key: string };
  other: { id: string; key: string };
}

async function seedProjects(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: OWNER_EMAIL,
    password: PASSWORD,
    name: 'Olga Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Mention Workspace',
    ownerUserId: owner.id,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  const shop = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Storefront',
    identifier: 'SHOP',
  });
  const ops = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Operations',
    identifier: 'OPS',
  });

  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: PASSWORD,
    name: 'Mia Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  // A member of BOTH projects: the picker leaving OPS out is the page's project
  // scope, never a permission the member lacks.
  for (const project of [shop, ops]) {
    await addToProjectAs({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: member.id,
      role: 'member',
    });
  }
  const memberCtx = { userId: member.id, workspaceId: workspace.id };
  await projectsService.setActiveProject({ ...ownerCtx, projectId: shop.id });
  await projectsService.setActiveProject({ ...memberCtx, projectId: shop.id });

  const item = async (projectId: string, title: string) => {
    const w = await workItemsService.createWorkItem({ projectId, kind: 'task', title }, ownerCtx);
    return { id: w.id, key: w.identifier };
  };
  const itemA = await item(shop.id, ITEM_A);
  const itemB = await item(shop.id, ITEM_B);
  const other = await item(ops.id, OTHER_ITEM);

  // The page, with a sub-page so archiving it goes through the confirm dialog.
  const created = await pagesService.createPage(ownerCtx, {
    projectId: shop.id,
    title: PAGE_TITLE,
  });
  const sub = await pagesService.createPage(ownerCtx, {
    projectId: shop.id,
    title: SUB_TITLE,
    parent: { kind: 'page', id: created.id },
  });
  const seed: Seed = {
    owner: ownerCtx,
    member: memberCtx,
    projectId: shop.id,
    pageId: created.id,
    subPageId: sub.id,
    itemA,
    itemB,
    other,
  };
  await writeBody(seed, INTRO);
  return seed;
}

/** Replace the page's body through the service, as the owner. */
async function writeBody(seed: Seed, markdown: string): Promise<void> {
  const at = { projectId: seed.projectId, pageId: seed.pageId };
  const current = await pagesService.getPage(seed.owner, at);
  await pagesService.savePageUpdate(seed.owner, {
    ...at,
    update: markdownToUpdate(new Uint8Array(Buffer.from(current.bodyState, 'base64')), markdown),
  });
}

// ── Locators and waits ──────────────────────────────────────────────────────

/** The live editor — the first body on the page. */
const bodyOf = (page: Page) =>
  page.getByRole('textbox', { name: 'Page body', exact: true }).first();
const toolbarOf = (page: Page) => page.getByRole('toolbar', { name: 'Formatting', exact: true });
/** Scoped to the toolbar: the indicator is its trailing end; the shell has live regions too. */
const indicatorOf = (page: Page) => toolbarOf(page).getByRole('status');
const pickerOf = (page: Page) =>
  page.getByRole('listbox', { name: 'Mention a work item', exact: true });
/** A chip in the body — the shipped `motir:` chip is a link named by key and title. */
const chipOf = (page: Page, key: string) =>
  bodyOf(page).getByRole('link', { name: new RegExp(`\\b${key}\\b`) });
/**
 * The work item's Pages section. `ContentSectionCard` is not a landmark, so it is
 * found by its fragment id (`PAGES_SECTION_ID`); everything inside is by role.
 */
const pagesSectionOf = (page: Page) => page.locator('#pages');
const pageRowOf = (page: Page, key: string) =>
  pagesSectionOf(page)
    .getByRole('list', { name: `Pages that link to ${key}`, exact: true })
    .getByRole('link')
    .filter({ hasText: PAGE_TITLE });
const EMPTY = 'No page links to this work item yet.';
const bannerOf = (page: Page) =>
  page.getByRole('status', { name: 'This page is archived', exact: true });

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

const saveOf = (page: Page, pageId: string) =>
  respondsTo(page, `/api/pages/${pageId}/updates`, 'POST');
const searchOf = (page: Page, q: string) =>
  respondsTo(page, '/api/work-items/mention-search', 'GET', (p) => p.get('q') === q);
const pagesReadOf = (page: Page, workItemId: string) =>
  respondsTo(page, `/api/work-items/${workItemId}/pages`, 'GET');

/** Run `input` and wait on the ONE save it produces, then the indicator's Saved. */
async function savedAfter(page: Page, pageId: string, input: () => Promise<void>): Promise<void> {
  const saved = saveOf(page, pageId);
  await input();
  expect((await saved).status()).toBe(200);
  await expect(indicatorOf(page)).toHaveText('Saved');
}

/** Open the page by its address and wait for its editor. */
async function openPage(page: Page, pageId: string): Promise<void> {
  expect((await page.goto(`/pages/${pageId}`))?.status()).toBe(200);
  await expect(bodyOf(page)).toHaveAttribute('contenteditable', 'true');
  await expect(indicatorOf(page)).toHaveText('Saved');
}

/** Open the work item and wait on the Pages section's own read. */
async function openItem(page: Page, item: { id: string; key: string }): Promise<Locator> {
  const read = pagesReadOf(page, item.id);
  expect((await page.goto(`/items/${item.key}`))?.status()).toBe(200);
  expect((await read).status()).toBe(200);
  const section = pagesSectionOf(page);
  await expect(section.getByRole('heading', { name: 'Pages', level: 2 })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  return section;
}

/**
 * In a new paragraph at the end of the body, type the lead-in and `@` + QUERY,
 * wait on the picker's search, and return the open picker.
 */
async function openPickerWithQuery(page: Page): Promise<Locator> {
  await bodyOf(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(LEAD_IN, TYPING);
  await page.keyboard.type(`@${QUERY.slice(0, 1)}`, TYPING);
  const picker = pickerOf(page);
  await expect(picker).toBeVisible();
  // One character is under the search minimum: the picker asks for more.
  await expect(picker).toContainText('Keep typing to search work items…');
  const searched = searchOf(page, QUERY);
  await page.keyboard.type(QUERY.slice(1), TYPING);
  expect((await searched).status()).toBe(200);
  await expect(picker.getByRole('option')).toHaveCount(2);
  return picker;
}

/** Choose `item` in the open picker and wait for the save the chip produces. */
async function pick(page: Page, pageId: string, picker: Locator, key: string): Promise<void> {
  await savedAfter(page, pageId, async () => {
    await picker.getByRole('option', { name: new RegExp(`\\b${key}\\b`) }).click();
    await expect(picker).toBeHidden();
  });
}

// ── The recorded journey ────────────────────────────────────────────────────

test('a member mentions a work item on a page; the work item lists the page, follows its status, and drops it when unlinked or archived', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-7565');
  test.setTimeout(240_000);

  await resetDatabase();
  const seed = await seedProjects();
  const { pageId, itemA, itemB, other } = seed;
  await signIn(page, MEMBER_EMAIL, PASSWORD);

  await chapter(
    'On a page, @ and part of a title — the picker lists this project only',
    async () => {
      await openPage(page, pageId);
      await expect(bodyOf(page)).toContainText(INTRO);

      const picker = await openPickerWithQuery(page);
      await expect(picker).toContainText(itemA.key);
      await expect(picker).toContainText(ITEM_A);
      await expect(picker).toContainText(itemB.key);
      await expect(picker).toContainText(ITEM_B);
      // The second project's item matches the query too, and is not offered.
      await expect(picker).not.toContainText(other.key);
      await expect(picker).not.toContainText(OTHER_ITEM);
      await beat();
    },
  );

  await chapter('Choosing it drops a chip — key, title, status — and the page saves', async () => {
    await pick(page, pageId, pickerOf(page), itemA.key);
    const chip = chipOf(page, itemA.key);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(itemA.key);
    await expect(chip).toContainText(ITEM_A);
    // The status is the chip's dot (To Do) and, by name, its hover tooltip.
    await expect(chip.locator('.wi-dot')).toHaveClass(/\bs-todo\b/);
    await chip.hover();
    await expect(page.getByRole('tooltip')).toContainText(`${ITEM_A} · To Do`);
    await expect(bodyOf(page)).toContainText(LEAD_IN.trim());
  });

  await chapter(
    'The work item’s Pages section lists the page — Mentioned, and when it was edited',
    async () => {
      const section = await openItem(page, itemA);
      const row = pageRowOf(page, itemA.key);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Mentioned');
      await expect(row.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
      await expect(row.locator('time')).not.toBeEmpty();
      await expect(section).not.toContainText(EMPTY);
      await beat();

      // The row leads back to the page, with the chip in its body.
      await row.click();
      await page.waitForURL((u) => u.pathname === `/pages/${pageId}`);
      await expect(chipOf(page, itemA.key)).toBeVisible();
    },
  );

  await chapter(
    'The item moves to In Progress — the page, reloaded, shows the new status',
    async () => {
      expect((await page.goto(`/items/${itemA.key}`))?.status()).toBe(200);
      await page.getByRole('button', { name: 'Edit Status' }).click();
      await page.getByRole('combobox', { name: 'Status' }).click();
      const statusWritten = actionWrite(page, `/items/${itemA.key}`, 'toStatusKey');
      await page.getByRole('option', { name: 'In Progress', exact: true }).click();
      expect((await statusWritten).status()).toBe(200);

      // Back to the page it was mentioned on, and a reload re-reads its chips.
      await page.goBack();
      await page.waitForURL((u) => u.pathname === `/pages/${pageId}`);
      await page.reload();
      await expect(bodyOf(page)).toHaveAttribute('contenteditable', 'true');
      await expect(indicatorOf(page)).toHaveText('Saved');
      const chip = chipOf(page, itemA.key);
      await expect(chip.locator('.wi-dot')).toHaveClass(/\bs-inprogress\b/);
      await chip.hover();
      await expect(page.getByRole('tooltip')).toContainText(`${ITEM_A} · In Progress`);
      await beat();
    },
  );

  await chapter('Deleting the chip unlinks the page — the section says so', async () => {
    await savedAfter(page, pageId, async () => {
      // A click selects the chip (it never follows its link in the editor).
      await chipOf(page, itemA.key).click();
      await page.keyboard.press('Backspace');
      await expect(chipOf(page, itemA.key)).toHaveCount(0);
    });

    const section = await openItem(page, itemA);
    await expect(section).toContainText(EMPTY);
    await expect(pageRowOf(page, itemA.key)).toHaveCount(0);
  });

  await chapter(
    'Mentioned again, then archived through its dialog — the section serves it as unavailable',
    async () => {
      await openPage(page, pageId);
      const picker = await openPickerWithQuery(page);
      await pick(page, pageId, picker, itemA.key);
      await expect(chipOf(page, itemA.key)).toBeVisible();

      // The page's own ⋯ → Archive…; its sub-page makes it confirm.
      const setRead = respondsTo(page, `/api/pages/${pageId}/archive`, 'GET');
      await page
        .getByRole('button', { name: `Page actions for ${PAGE_TITLE}`, exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Archive…', exact: true }).click();
      expect((await setRead).status()).toBe(200);
      const confirm = page.getByRole('alertdialog', {
        name: `Archive “${PAGE_TITLE}” and its 1 sub-page?`,
        exact: true,
      });
      await expect(confirm).toContainText(SUB_TITLE);
      const archived = respondsTo(page, `/api/pages/${pageId}/archive`, 'POST');
      await confirm.getByRole('button', { name: 'Archive 2 pages', exact: true }).click();
      expect((await archived).status()).toBe(200);
      await expect(bannerOf(page)).toBeVisible();

      // The archived page is no longer a link to follow: its row is served as an
      // unavailable one (MOTIR-9203), so the section is not empty — it holds the
      // unavailable row, which names no title and leads nowhere.
      const section = await openItem(page, itemA);
      await expect(section.getByTestId('pages-row-unavailable')).toHaveCount(1);
      await expect(section).not.toContainText(EMPTY);
      await expect(pageRowOf(page, itemA.key)).toHaveCount(0);
    },
  );

  await chapter('Restored from its banner — the section lists the page again', async () => {
    expect((await page.goto(`/pages/${pageId}`))?.status()).toBe(200);
    const restored = respondsTo(page, `/api/pages/${pageId}/archive`, 'DELETE');
    await bannerOf(page)
      .getByRole('button', { name: `Restore “${PAGE_TITLE}”`, exact: true })
      .click();
    expect((await restored).status()).toBe(200);
    await expect(bannerOf(page)).toHaveCount(0);

    const section = await openItem(page, itemA);
    await expect(pageRowOf(page, itemA.key)).toHaveCount(1);
    await expect(pageRowOf(page, itemA.key)).toContainText('Mentioned');
    await expect(section.getByTestId('pages-row-unavailable')).toHaveCount(0);
    await expect(section).not.toContainText(EMPTY);
  });
});

// ── Unrecorded ──────────────────────────────────────────────────────────────

test('a Visitor of the project, made public, sees no Pages section where a member sees the page', async ({
  page,
  browser,
}) => {
  await resetDatabase();
  const seed = await seedProjects();
  await writeBody(seed, `${INTRO}\n\nBlocked on [${seed.itemA.key}](motir:${seed.itemA.id}).`);
  await adminDb.project.update({
    where: { id: seed.projectId },
    data: projectAccessData('public'),
  });

  // A reader from another organisation, with a visitor record on the project.
  const visitor = await usersService.createUser({
    email: VISITOR_EMAIL,
    password: PASSWORD,
    name: 'Vera Visitor',
  });
  const own = await workspacesService.createWorkspace({
    name: 'Vera Studio',
    ownerUserId: visitor.id,
  });
  const ownProject = await projectsService.createProject({
    workspaceId: own.workspace.id,
    actorUserId: visitor.id,
    name: 'Sketches',
    identifier: 'SKT',
  });
  await projectsService.setActiveProject({
    userId: visitor.id,
    workspaceId: own.workspace.id,
    projectId: ownProject.id,
  });
  const now = new Date();
  await adminDb.projectVisitor.create({
    data: {
      projectId: seed.projectId,
      userId: visitor.id,
      consentedAt: now,
      firstVisitAt: now,
      lastVisitAt: now,
    },
  });

  // The control: a member sees the page in the item's Pages section.
  const memberContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, MEMBER_EMAIL, PASSWORD);
    await openItem(memberPage, seed.itemA);
    await expect(pageRowOf(memberPage, seed.itemA.key)).toHaveCount(1);
  } finally {
    await memberContext.close();
  }

  // The Visitor: the same item, and no section, no skeleton and no read.
  const pagesReads: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === `/api/work-items/${seed.itemA.id}/pages`) {
      pagesReads.push(r.url());
    }
  });
  await signIn(page, VISITOR_EMAIL, PASSWORD);
  const res = await page.goto(`/p/SHOP/items/${seed.itemA.key}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: ITEM_A, level: 1 })).toBeVisible();
  // The late lower stack has settled: Attachments renders in the same flush the
  // Pages section would have opened.
  await expect(page.getByRole('heading', { name: 'Attachments', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pages', level: 2 })).toHaveCount(0);
  await expect(pagesSectionOf(page)).toHaveCount(0);
  await expect(page.getByTestId('pages-section-loading')).toHaveCount(0);
  expect(pagesReads).toEqual([]);
});
