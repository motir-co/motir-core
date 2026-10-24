import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { actionWrite } from './_helpers/authoritative-signal';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleDefinitionFor,
} from '../helpers/workspaceRoleFixtures';

// TAG A PAGE IN A WORK ITEM'S DESCRIPTION AND EXPLANATION — THE ACCEPTANCE
// RECEIPT (Story MOTIR-7694 · Subtask MOTIR-7700). The story's verification
// recipe, in a real browser against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One recorded journey, as a project Member: on a work item's edit form, `@` and
// part of a page title open the picker, whose Pages section lists the page;
// choosing it drops a page chip into the Description, and Save writes it. The
// item's read view shows the chip by the page's title, linking to the page. The
// same is done with a second page in the Explanation. The item's Pages section
// lists both pages — "Tagged in description" and "Tagged in explanation". The
// first page is renamed on its own page and the item's chip follows; the second
// is archived and its chip reads "Page unavailable", with its title nowhere on
// the item and its Pages row gone.
//
// The test after the recorded one runs at machine speed, with no chapters: a
// member whose role lacks `page:view` sees both chips unavailable, no page title
// anywhere on the item, and an `@` picker with no Pages section that never
// searches pages.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// The picker's page search is waited on by its `GET /api/pages/mention-search`
// for the exact query, armed before the keystroke that completes it. Save is a
// Server Action, so it is matched by its body (`actionWrite`, marker
// `motir-page:` — only the write carries a page token) and its 200 asserted
// before the read view is opened. The read view is waited on by the Pages
// section's own `GET /api/work-items/<id>/pages` (a client island that reads on
// mount, after the server-rendered chips). The rename by its `PATCH
// /api/pages/<id>`, the archive by its `POST /api/pages/<id>/archive`. Nothing
// waits on a timeout: every `beat()` is pacing for the viewer, taken after the
// state it shows is already proven.

const PASSWORD = 'acceptance-page-tag-e2e-pass-123';
const OWNER_EMAIL = 'acceptance-tag-owner@example.com';
const MEMBER_EMAIL = 'acceptance-tag-member@example.com';
const NO_PAGES_EMAIL = 'acceptance-tag-no-pages@example.com';

const TYPING = { delay: 45 };

const ITEM_TITLE = 'Card payments rollout';
const PAGE_A = 'Checkout launch plan';
const PAGE_A_RENAMED = 'Checkout launch runbook';
const PAGE_B = 'Pricing research';
const QUERY_A = 'Checkout';
const QUERY_B = 'Pricing';
const LEAD_A = 'Follows ';
const LEAD_B = 'Because of ';

interface Seed {
  projectId: string;
  item: { id: string; key: string };
  pageA: string;
  pageB: string;
}

/** `tagged` creates the item with both pages already tagged, as the recorded journey leaves it. */
async function seedProject(opts: { tagged?: boolean } = {}): Promise<Seed> {
  const owner = await usersService.createUser({
    email: OWNER_EMAIL,
    password: PASSWORD,
    name: 'Olga Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Tag Workspace',
    ownerUserId: owner.id,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  const shop = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Storefront',
    identifier: 'SHOP',
  });
  await projectsService.setActiveProject({ ...ownerCtx, projectId: shop.id });

  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: PASSWORD,
    name: 'Mia Member',
  });
  // A member of the project who cannot see its pages: browses, reads and edits
  // work items, and holds no `page:view`.
  const noPages = await usersService.createUser({
    email: NO_PAGES_EMAIL,
    password: PASSWORD,
    name: 'Nora Nopages',
  });
  for (const user of [member, noPages]) {
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: shop.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: user.id,
      role: 'member',
    });
    await projectsService.setActiveProject({
      userId: user.id,
      workspaceId: workspace.id,
      projectId: shop.id,
    });
  }
  const role = await createCustomRoleAs({
    ctx: ownerCtx,
    name: 'Items only',
    permissions: ['project:browse', 'work_item:view', 'work_item:edit'],
  });
  await setProjectRoleDefinitionFor(noPages.id, shop.id, {
    roleDefinitionId: role.id,
    role: 'member',
  });

  const a = await pagesService.createPage(ownerCtx, { projectId: shop.id, title: PAGE_A });
  const b = await pagesService.createPage(ownerCtx, { projectId: shop.id, title: PAGE_B });
  const created = await workItemsService.createWorkItem(
    {
      projectId: shop.id,
      kind: 'task',
      title: ITEM_TITLE,
      ...(opts.tagged
        ? {
            descriptionMd: `${LEAD_A}[${PAGE_A}](motir-page:${a.id}).`,
            explanationMd: `${LEAD_B}[${PAGE_B}](motir-page:${b.id}).`,
          }
        : {}),
    },
    ownerCtx,
  );
  return {
    projectId: shop.id,
    item: { id: created.id, key: created.identifier },
    pageA: a.id,
    pageB: b.id,
  };
}

// ── Locators and waits ──────────────────────────────────────────────────────

const editorOf = (page: Page, name: 'Description' | 'Explanation') =>
  page.getByRole('textbox', { name, exact: true });
const pickerOf = (page: Page) =>
  page.getByRole('listbox', { name: 'Mention a person, work item or page', exact: true });
/** A live chip on the read view — a link named by the page's CURRENT title alone. */
const chipOf = (page: Page, title: string) => page.getByRole('link', { name: title, exact: true });
const UNAVAILABLE = 'Page unavailable';
/** `ContentSectionCard` is not a landmark, so the section is its fragment id; inside it, roles. */
const pagesSectionOf = (page: Page) => page.locator('#pages');
const pageRowOf = (page: Page, key: string, title: string) =>
  pagesSectionOf(page)
    .getByRole('list', { name: `Pages that link to ${key}`, exact: true })
    .getByRole('link')
    .filter({ hasText: title });

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

const pageSearchOf = (page: Page, q: string) =>
  respondsTo(page, '/api/pages/mention-search', 'GET', (p) => p.get('q') === q);

/** Open the work item's read view and wait on the Pages section's own read. */
async function openItem(page: Page, item: Seed['item']): Promise<Locator> {
  const read = respondsTo(page, `/api/work-items/${item.id}/pages`, 'GET');
  expect((await page.goto(`/items/${item.key}`))?.status()).toBe(200);
  expect((await read).status()).toBe(200);
  await expect(page.getByRole('heading', { name: ITEM_TITLE, level: 1 })).toBeVisible();
  return pagesSectionOf(page);
}

async function openEdit(page: Page, item: Seed['item']): Promise<void> {
  expect((await page.goto(`/items/${item.key}/edit`))?.status()).toBe(200);
  await expect(editorOf(page, 'Description')).toHaveAttribute('contenteditable', 'true');
}

/**
 * At the end of `field`, type the lead-in and `@` + `query`, wait on the page
 * search for the whole query, choose `title` from the Pages section, and return
 * once the chip is in the editor.
 */
async function tagIn(
  page: Page,
  field: 'Description' | 'Explanation',
  lead: string,
  query: string,
  title: string,
): Promise<void> {
  const editor = editorOf(page, field);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(lead, TYPING);
  await page.keyboard.type(`@${query.slice(0, 1)}`, TYPING);
  const picker = pickerOf(page);
  await expect(picker).toBeVisible();
  // One character is under the search minimum: the Pages section asks for more.
  await expect(picker).toContainText('Keep typing to search pages…');
  const searched = pageSearchOf(page, query);
  await page.keyboard.type(query.slice(1), TYPING);
  expect((await searched).status()).toBe(200);
  await expect(picker).toContainText('Pages');
  const option = picker.getByRole('option', { name: new RegExp(title) });
  await expect(option).toHaveCount(1);
  await beatIfRecording();
  await option.click();
  await expect(picker).toBeHidden();
  await expect(editor.locator('.page-chip')).toContainText([title]);
}

/** Save the edit form and wait on its Server Action — the write carrying a page token. */
async function save(page: Page, item: Seed['item']): Promise<void> {
  const written = actionWrite(page, `/items/${item.key}/edit`, 'motir-page:');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await written).status()).toBe(200);
}

// The picker's list is the longest thing to read; the recorded test sets this to
// its `beat`, the unrecorded one leaves it a no-op.
let beatIfRecording: () => Promise<void> = async () => {};

// ── The recorded journey ────────────────────────────────────────────────────

test('a member tags a page in a Description and another in an Explanation; the chips follow a rename and go unavailable on archive', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-7694');
  test.setTimeout(240_000);
  beatIfRecording = () => beat();

  await resetDatabase();
  const seed = await seedProject();
  const { item } = seed;
  await signIn(page, MEMBER_EMAIL, PASSWORD);

  try {
    await chapter('In the Description, @ and part of a title — the picker has Pages', async () => {
      await openEdit(page, item);
      await tagIn(page, 'Description', LEAD_A, QUERY_A, PAGE_A);
      await save(page, item);
    });

    await chapter('The read view shows the page chip, linking to the page', async () => {
      await openItem(page, item);
      const chip = chipOf(page, PAGE_A);
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('href', `/pages/${seed.pageA}`);
      await chip.scrollIntoViewIfNeeded();
      await beat();
    });

    await chapter('A second page, tagged in the Explanation', async () => {
      await openEdit(page, item);
      await tagIn(page, 'Explanation', LEAD_B, QUERY_B, PAGE_B);
      await save(page, item);
      await openItem(page, item);
      await expect(chipOf(page, PAGE_A)).toBeVisible();
      const chip = chipOf(page, PAGE_B);
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('href', `/pages/${seed.pageB}`);
    });

    await chapter(
      'The Pages section — "Tagged in description" and "Tagged in explanation"',
      async () => {
        const section = pagesSectionOf(page);
        await section.scrollIntoViewIfNeeded();
        const a = pageRowOf(page, item.key, PAGE_A);
        const b = pageRowOf(page, item.key, PAGE_B);
        await expect(a).toHaveCount(1);
        await expect(a).toContainText('Tagged in description');
        await expect(b).toHaveCount(1);
        await expect(b).toContainText('Tagged in explanation');
        await beat();
      },
    );

    await chapter('The first page is renamed — the chip follows', async () => {
      expect((await page.goto(`/pages/${seed.pageA}`))?.status()).toBe(200);
      const title = page.getByRole('textbox', { name: 'Page title' });
      await expect(title).toHaveValue(PAGE_A);
      const renamed = respondsTo(page, `/api/pages/${seed.pageA}`, 'PATCH');
      await title.fill(PAGE_A_RENAMED);
      await title.press('Enter');
      await title.blur();
      expect((await renamed).status()).toBe(200);

      await openItem(page, item);
      const chip = chipOf(page, PAGE_A_RENAMED);
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('href', `/pages/${seed.pageA}`);
      await expect(chipOf(page, PAGE_A)).toHaveCount(0);
      await chip.scrollIntoViewIfNeeded();
      await beat();
    });

    await chapter('The second page is archived — its chip reads "Page unavailable"', async () => {
      expect((await page.goto(`/pages/${seed.pageB}`))?.status()).toBe(200);
      // No sub-pages, so the page's own ⋯ → Archive… archives at once.
      const archived = respondsTo(page, `/api/pages/${seed.pageB}/archive`, 'POST');
      await page.getByRole('button', { name: `Page actions for ${PAGE_B}`, exact: true }).click();
      await page.getByRole('menuitem', { name: 'Archive…', exact: true }).click();
      expect((await archived).status()).toBe(200);
      await expect(
        page.getByRole('status', { name: 'This page is archived', exact: true }),
      ).toBeVisible();

      const section = await openItem(page, item);
      await expect(page.getByText(UNAVAILABLE, { exact: true })).toHaveCount(1);
      await expect(chipOf(page, PAGE_B)).toHaveCount(0);
      // The archived page's Pages row is served as an unavailable one (MOTIR-9203):
      // it is no longer a link to follow, and it is not dropped from the section.
      await expect(pagesSectionOf(page).getByTestId('pages-row-unavailable')).toHaveCount(1);
      await expect(pageRowOf(page, item.key, PAGE_B)).toHaveCount(0);
      await expect(pageRowOf(page, item.key, PAGE_A_RENAMED)).toHaveCount(1);
      await page.getByRole('main').getByText(UNAVAILABLE, { exact: true }).scrollIntoViewIfNeeded();
      await beat();
      await section.scrollIntoViewIfNeeded();
    });
  } finally {
    beatIfRecording = async () => {};
  }
});

// ── Unrecorded ──────────────────────────────────────────────────────────────

test('a member without page:view sees every page chip unavailable and an @ picker with no Pages section', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject({ tagged: true });

  const pageSearches: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/pages/mention-search') pageSearches.push(r.url());
  });
  await signIn(page, NO_PAGES_EMAIL, PASSWORD);

  // The read view: both chips unavailable, and neither title anywhere on it.
  expect((await page.goto(`/items/${seed.item.key}`))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: ITEM_TITLE, level: 1 })).toBeVisible();
  await expect(page.getByText(UNAVAILABLE, { exact: true })).toHaveCount(2);
  await expect(page.locator('body')).not.toContainText(PAGE_A);
  await expect(page.locator('body')).not.toContainText(PAGE_B);
  await expect(page.getByRole('heading', { name: 'Pages', level: 2 })).toHaveCount(0);

  // The editor: the picker opens without a Pages section and searches no pages.
  await openEdit(page, seed.item);
  await editorOf(page, 'Description').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(` @${QUERY_A}`);
  const picker = page.getByRole('listbox', { name: 'Mention a person or work item', exact: true });
  await expect(picker).toBeVisible();
  await expect(pickerOf(page)).toHaveCount(0);
  await expect(picker).not.toContainText('Pages');
  await expect(picker).not.toContainText(PAGE_A);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  expect(pageSearches).toEqual([]);
});
