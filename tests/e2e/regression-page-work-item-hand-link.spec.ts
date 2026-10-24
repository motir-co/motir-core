import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { expectSettledVisible } from './_helpers/settle';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { pagesService } from '@/lib/services/pagesService';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { workItemsService } from '@/lib/services/workItemsService';
import { markdownToUpdate } from '@/lib/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import enMessages from '@/messages/en.json';

// LINK A PAGE AND A WORK ITEM BY HAND, AND UNLINK IT — THE ACCEPTANCE RECEIPT
// (Story MOTIR-7567 · Subtask MOTIR-9202). The story's verification recipe, in a
// real browser against a production build and a real database: nothing is
// stubbed, no route is intercepted and the spec writes no `manual` row itself.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One recorded journey, as a project Member. A work item's Pages section is
// empty and carries a Link page door. The picker asks for more than one
// character, then lists the one LIVE page that matches — with its place — and
// not the archived page that matches too. Picking it lands one row labelled
// Linked. On the page, the Linked work items strip shows the item as a live
// chip; Link work item adds a second, whose own Pages section now lists the
// page. Linking the first pair again is refused in words and writes nothing.
// A body edit that mentions the first item keeps the hand link: one row, both
// labels. Unlinking the second item from the page's strip removes it from both
// sides; unlinking the first from the work item removes only the hand link —
// the mention row stays and loses its Unlink — and the strip empties. History
// holds one entry per write, each naming the Page field.
//
// The test after the recorded one runs at machine speed, with no chapters: the
// same pair read by a workspace Viewer shows the row and the chip and none of
// the four controls, and a Member sees all four.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Every request is armed BEFORE the input that triggers it. After a write the
// Pages section is NOT awaited again — it mutates its rows locally on success
// — while the strip re-reads its first page after a link, so that GET is armed
// alongside the POST. Every `beat()` is pacing for the viewer, taken after the
// state it shows is already proven.

const PASSWORD = 'acceptance-hand-link-e2e-pass-123';
const OWNER_EMAIL = 'acceptance-hand-owner@example.com';
const MEMBER_EMAIL = 'acceptance-hand-member@example.com';
const VIEWER_EMAIL = 'acceptance-hand-viewer@example.com';

const TYPING = { delay: 45 };

const PARENT_TITLE = 'Payments';
const PAGE_TITLE = 'Launch runbook';
const ARCHIVED_TITLE = 'Launch runbook archive';
const PAGE_QUERY = 'Launch run';
const ITEM_A = 'Checkout retry backoff';
const ITEM_B = 'Checkout tax rounding';
const ITEM_QUERY = 'Checkout tax';

// Copy is RESOLVED from the catalogue by key, never typed: a reworded line is a
// catalogue diff, not a red spec.
const copy = enMessages as unknown as Record<string, Record<string, unknown>>;
const issueViews = copy['issueViews'] as Record<string, string>;
const links = (copy['pages'] as Record<string, Record<string, string>>)['links']!;
const fields = (copy['activity'] as Record<string, Record<string, string>>)['fields']!;
const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');

const EMPTY = issueViews['pagesEmpty']!;
const LINKED = issueViews['pagesSourceManual']!;
const MENTIONED = issueViews['pagesSourceMention']!;
const LINK_DOOR = issueViews['pagesLinkDoor']!;
const SEARCH_LABEL = issueViews['pagesLinkSearchLabel']!;
const SEARCH_HINT = issueViews['pagesLinkSearchHint']!;
const ALREADY = fill(issueViews['pagesLinkAlreadyLinked']!, { title: PAGE_TITLE });
const PAGE_FIELD = fields['pageLinks']!;

interface Seed {
  owner: ServiceContext;
  member: ServiceContext;
  projectId: string;
  pageId: string;
  archivedId: string;
  itemA: { id: string; key: string };
  itemB: { id: string; key: string };
}

async function seedProject(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: OWNER_EMAIL,
    password: PASSWORD,
    name: 'Olga Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Hand Link Workspace',
    ownerUserId: owner.id,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  const shop = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Storefront',
    identifier: 'SHOP',
  });

  const people: Array<[string, string, 'member' | 'viewer']> = [
    [MEMBER_EMAIL, 'Mia Member', 'member'],
    [VIEWER_EMAIL, 'Vic Viewer', 'viewer'],
  ];
  const ids: Record<string, string> = {};
  for (const [email, name, role] of people) {
    const user = await usersService.createUser({ email, password: PASSWORD, name });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: shop.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: user.id,
      role,
    });
    await projectsService.setActiveProject({
      userId: user.id,
      workspaceId: workspace.id,
      projectId: shop.id,
    });
    ids[role] = user.id;
  }
  await projectsService.setActiveProject({ ...ownerCtx, projectId: shop.id });

  // Items before pages, so no ordering surprise hides a write.
  const item = async (title: string) => {
    const w = await workItemsService.createWorkItem(
      { projectId: shop.id, kind: 'task', title },
      ownerCtx,
    );
    return { id: w.id, key: w.identifier };
  };
  const itemA = await item(ITEM_A);
  const itemB = await item(ITEM_B);

  const parent = await pagesService.createPage(ownerCtx, {
    projectId: shop.id,
    title: PARENT_TITLE,
  });
  const created = await pagesService.createPage(ownerCtx, {
    projectId: shop.id,
    title: PAGE_TITLE,
    parent: { kind: 'page', id: parent.id },
  });
  const archived = await pagesService.createPage(ownerCtx, {
    projectId: shop.id,
    title: ARCHIVED_TITLE,
  });
  await pagesService.archivePage(ownerCtx, { projectId: shop.id, pageId: archived.id });

  // A body to type after.
  const at = { projectId: shop.id, pageId: created.id };
  const current = await pagesService.getPage(ownerCtx, at);
  await pagesService.savePageUpdate(ownerCtx, {
    ...at,
    update: markdownToUpdate(
      new Uint8Array(Buffer.from(current.bodyState, 'base64')),
      'The payments team owns this launch.',
    ),
  });

  return {
    owner: ownerCtx,
    member: { userId: ids['member']!, workspaceId: workspace.id },
    projectId: shop.id,
    pageId: created.id,
    archivedId: archived.id,
    itemA,
    itemB,
  };
}

// ── Locators and waits ──────────────────────────────────────────────────────

const bodyOf = (page: Page) =>
  page.getByRole('textbox', { name: 'Page body', exact: true }).first();
const toolbarOf = (page: Page) => page.getByRole('toolbar', { name: 'Formatting', exact: true });
const indicatorOf = (page: Page) => toolbarOf(page).getByRole('status');
const mentionPickerOf = (page: Page) =>
  page.getByRole('listbox', { name: 'Mention a work item', exact: true });

/**
 * The work item's Pages section — found by fragment id, everything inside by role.
 *
 * ⚠️ VISIBLE copies only (MOTIR-9353). The page renders the section once
 * (`LateLowerSections`), but it streams behind the late stack's `<Suspense>`, so the
 * DOM can briefly hold a SECOND, hidden `#pages` — React's staging block or the
 * outgoing subtree (`docs/decisions/page-rooted-locator-disposition.md` § *The
 * defect*). An id locator does not filter on visibility, so a bare `#pages` resolved
 * both and died on strict mode in a Viewer run that passed on `main` the same hour.
 */
const pagesSectionOf = (page: Page) => page.locator('#pages').filter({ visible: true });
const linkDoorOf = (page: Page) =>
  pagesSectionOf(page).getByRole('button', { name: LINK_DOOR, exact: true });
const searchBoxOf = (page: Page) =>
  pagesSectionOf(page).getByRole('combobox', { name: SEARCH_LABEL, exact: true });
const candidatesOf = (page: Page) =>
  pagesSectionOf(page).getByRole('listbox', { name: issueViews['pagesLinkCandidatesAria']! });
const pageRowOf = (page: Page, key: string) =>
  pagesSectionOf(page)
    .getByRole('list', { name: fill(issueViews['pagesListAria']!, { key }), exact: true })
    .getByRole('listitem')
    .filter({ hasText: PAGE_TITLE });
const unlinkPageOf = (page: Page) =>
  pagesSectionOf(page).getByRole('button', {
    name: fill(issueViews['pagesUnlinkAria']!, { title: PAGE_TITLE }),
    exact: true,
  });

/** The page's strip — a labelled region, every control inside it by role. */
const stripOf = (page: Page) => page.getByRole('region', { name: links['title']!, exact: true });
const chipsOf = (page: Page) =>
  stripOf(page).getByRole('list', { name: links['listAria']!, exact: true });
const chipOf = (page: Page, key: string) =>
  chipsOf(page).getByRole('link', { name: new RegExp(`\\b${key}\\b`) });
const linkItemDoorOf = (page: Page) =>
  stripOf(page).getByRole('button', { name: links['link']!, exact: true });
const unlinkItemOf = (page: Page, key: string) =>
  stripOf(page).getByRole('button', { name: fill(links['unlinkAria']!, { key }), exact: true });
const itemSearchOf = (page: Page) =>
  page.getByRole('combobox', { name: links['pickerLabel']!, exact: true });
const itemOptionsOf = (page: Page) =>
  page.getByRole('listbox', { name: links['pickerLabel']!, exact: true });

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

const itemPagesRead = (page: Page, workItemId: string) =>
  respondsTo(page, `/api/work-items/${workItemId}/pages`, 'GET');
const itemPagesWrite = (page: Page, workItemId: string) =>
  respondsTo(page, `/api/work-items/${workItemId}/pages`, 'POST');
const pairDelete = (page: Page, workItemId: string, pageId: string) =>
  respondsTo(page, `/api/work-items/${workItemId}/pages/${pageId}`, 'DELETE');
const stripRead = (page: Page, pageId: string) =>
  respondsTo(page, `/api/pages/${pageId}/work-items`, 'GET');
const pageSearch = (page: Page, q: string) =>
  respondsTo(page, '/api/pages/link-search', 'GET', (p) => p.get('q') === q);
const itemSearch = (page: Page, q: string) =>
  respondsTo(page, '/api/work-items/mention-search', 'GET', (p) => p.get('q') === q);
const saveOf = (page: Page, pageId: string) =>
  respondsTo(page, `/api/pages/${pageId}/updates`, 'POST');

/** Open the work item and wait on the Pages section's own mount read. */
async function openItem(page: Page, item: { id: string; key: string }): Promise<Locator> {
  const read = itemPagesRead(page, item.id);
  expect((await page.goto(`/items/${item.key}`))?.status()).toBe(200);
  expect((await read).status()).toBe(200);
  const section = pagesSectionOf(page);
  // Settle on ONE visible section before acting on it: a transient VISIBLE double
  // (the outgoing subtree) passes the filter too, and `scrollIntoViewIfNeeded`
  // throws on it rather than retrying.
  await expectSettledVisible(section);
  await expect(section.getByRole('heading', { name: 'Pages', level: 2 })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  return section;
}

/** Open the page and wait on the strip's first read (armed before the navigation). */
async function openPage(page: Page, pageId: string): Promise<void> {
  const read = stripRead(page, pageId);
  expect((await page.goto(`/pages/${pageId}`))?.status()).toBe(200);
  expect((await read).status()).toBe(200);
  await expect(bodyOf(page)).toHaveAttribute('contenteditable', 'true');
  await expect(indicatorOf(page)).toHaveText('Saved');
}

// ── The recorded journey ────────────────────────────────────────────────────

test('a member links a page and a work item by hand from either side, sees it on both, and unlinks it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-7567');
  test.setTimeout(300_000);

  await resetDatabase();
  const seed = await seedProject();
  const { pageId, itemA, itemB } = seed;
  await signIn(page, MEMBER_EMAIL, PASSWORD);

  // Not one search may be issued for a one-character query.
  const pageSearches: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname === '/api/pages/link-search') pageSearches.push(url.searchParams.get('q')!);
  });

  await chapter(
    'A work item with no linking page — the section and its Link page door',
    async () => {
      const section = await openItem(page, itemA);
      await expect(section).toContainText(EMPTY);
      await expect(linkDoorOf(page)).toBeVisible();
      await expect(page.getByTestId('pages-section-loading')).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'The picker — a short query asks for more, then the live page with its place',
    async () => {
      await linkDoorOf(page).click();
      const box = searchBoxOf(page);
      await expect(box).toBeFocused();
      await box.pressSequentially(PAGE_QUERY.slice(0, 1), TYPING);
      await expect(pagesSectionOf(page)).toContainText(SEARCH_HINT);
      expect(pageSearches).toEqual([]);

      const searched = pageSearch(page, PAGE_QUERY);
      await box.pressSequentially(PAGE_QUERY.slice(1), TYPING);
      expect((await searched).status()).toBe(200);
      const options = candidatesOf(page).getByRole('option');
      await expect(options).toHaveCount(1);
      await expect(options.first()).toContainText(PAGE_TITLE);
      // Its place, in the vocabulary the section's rows use: the parent page.
      await expect(options.first()).toContainText(PARENT_TITLE);
      // The archived page matches the same words and is not offered.
      await expect(candidatesOf(page)).not.toContainText(ARCHIVED_TITLE);
      await beat();
    },
  );

  await chapter('Picking it — the page lands pinned as just linked, labelled Linked', async () => {
    const written = itemPagesWrite(page, itemA.id);
    await candidatesOf(page).getByRole('option').first().click();
    expect((await written).status()).toBe(200);
    // The write's own answer is the signal: the section pins the pick without a re-read.
    const pinned = pagesSectionOf(page).getByTestId('pages-pinned');
    await expect(pinned).toContainText(PAGE_TITLE);
    await expect(pinned).toContainText(issueViews['pagesJustLinked']!);
    await expect(pinned).toContainText(LINKED);
    await expect(pagesSectionOf(page)).not.toContainText(EMPTY);
    await expect(unlinkPageOf(page)).toBeVisible();
    await beat();
  });

  await chapter('On the page — the strip shows the work item as a live chip', async () => {
    await openPage(page, pageId);
    await expect(stripOf(page)).toBeVisible();
    const chip = chipOf(page, itemA.key);
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText(ITEM_A);
    await expect(chip.locator('.wi-dot')).toHaveClass(/\bs-todo\b/);
    await beat();
  });

  await chapter(
    'Link work item from the page — a second chip, and the reverse row on that item',
    async () => {
      await linkItemDoorOf(page).click();
      const box = itemSearchOf(page);
      await expect(box).toBeFocused();
      const searched = itemSearch(page, ITEM_QUERY);
      await box.pressSequentially(ITEM_QUERY, TYPING);
      expect((await searched).status()).toBe(200);
      const option = itemOptionsOf(page).getByRole('option', {
        name: new RegExp(`\\b${itemB.key}\\b`),
      });
      await expect(option).toHaveCount(1);

      const written = itemPagesWrite(page, itemB.id);
      const reread = stripRead(page, pageId);
      await option.click();
      expect((await written).status()).toBe(200);
      expect((await reread).status()).toBe(200);
      await expect(chipOf(page, itemB.key)).toHaveCount(1);
      await expect(chipOf(page, itemA.key)).toHaveCount(1);
      await beat();

      await openItem(page, itemB);
      const row = pageRowOf(page, itemB.key);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(LINKED);
    },
  );

  await chapter('Linking the same pair again — refused in words, nothing written', async () => {
    await openItem(page, itemA);
    await expect(pageRowOf(page, itemA.key)).toHaveCount(1);
    await linkDoorOf(page).click();
    const searched = pageSearch(page, PAGE_QUERY);
    await searchBoxOf(page).pressSequentially(PAGE_QUERY, TYPING);
    expect((await searched).status()).toBe(200);
    const refused = itemPagesWrite(page, itemA.id);
    await candidatesOf(page).getByRole('option').first().click();
    expect((await refused).status()).toBe(409);
    await expect(pagesSectionOf(page)).toContainText(ALREADY);
    await expect(pageRowOf(page, itemA.key)).toHaveCount(1);
    await beat();
  });

  await chapter(
    'A body edit that mentions the item — the hand link survives, one row with both labels',
    async () => {
      await openPage(page, pageId);
      await bodyOf(page).click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Blocked on @Checkout', TYPING);
      const picker = mentionPickerOf(page);
      await expect(picker).toBeVisible();
      await expect(picker.getByRole('option')).toHaveCount(2);
      const saved = saveOf(page, pageId);
      await picker.getByRole('option', { name: new RegExp(`\\b${itemA.key}\\b`) }).click();
      expect((await saved).status()).toBe(200);
      await expect(indicatorOf(page)).toHaveText('Saved');

      await openItem(page, itemA);
      const row = pageRowOf(page, itemA.key);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(MENTIONED);
      await expect(row).toContainText(LINKED);
      await beat();
    },
  );

  await chapter(
    'Unlinking from the page’s strip — the chip leaves, and the other item’s section empties',
    async () => {
      await openPage(page, pageId);
      await expect(chipOf(page, itemB.key)).toHaveCount(1);
      const removed = pairDelete(page, itemB.id, pageId);
      await unlinkItemOf(page, itemB.key).click();
      expect((await removed).status()).toBe(204);
      await expect(chipOf(page, itemB.key)).toHaveCount(0);
      await expect(chipOf(page, itemA.key)).toHaveCount(1);
      await beat();

      const section = await openItem(page, itemB);
      await expect(section).toContainText(EMPTY);
      await expect(pageRowOf(page, itemB.key)).toHaveCount(0);
    },
  );

  await chapter(
    'Unlinking from the work item — the mention stays, the hand link and its Unlink go',
    async () => {
      await openItem(page, itemA);
      const removed = pairDelete(page, itemA.id, pageId);
      await unlinkPageOf(page).click();
      expect((await removed).status()).toBe(204);
      const row = pageRowOf(page, itemA.key);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(MENTIONED);
      await expect(row).not.toContainText(LINKED);
      await expect(unlinkPageOf(page)).toHaveCount(0);
      await beat();

      await openPage(page, pageId);
      await expect(chipOf(page, itemA.key)).toHaveCount(0);
      await expect(stripOf(page)).toContainText(links['empty']!);
    },
  );

  await chapter('History — one entry per write, each naming the Page field', async () => {
    expect((await page.goto(`/items/${itemA.key}?activity=history`))?.status()).toBe(200);
    const entries = page
      .getByRole('list', { name: 'History', exact: true })
      .getByRole('listitem')
      .filter({ hasText: PAGE_FIELD })
      .filter({ hasText: PAGE_TITLE });
    // One link and one unlink on this item: exactly two entries, which is also
    // the proof that the refused second link wrote nothing.
    await expect(entries).toHaveCount(2);
    await expect(entries.filter({ hasText: /added/i })).toHaveCount(1);
    await expect(entries.filter({ hasText: /removed/i })).toHaveCount(1);
    await beat();
  });
});

// ── Unrecorded ──────────────────────────────────────────────────────────────

test('a Viewer reads the hand link on both sides with none of the four controls; a Member has them all', async ({
  page,
  browser,
}) => {
  await resetDatabase();
  const seed = await seedProject();
  await pageLinksService.linkPageForWorkItem(seed.member, {
    workItemId: seed.itemA.id,
    pageId: seed.pageId,
  });

  const memberContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, MEMBER_EMAIL, PASSWORD);
    await openItem(memberPage, seed.itemA);
    await expect(pageRowOf(memberPage, seed.itemA.key)).toHaveCount(1);
    await expect(linkDoorOf(memberPage)).toBeVisible();
    await expect(unlinkPageOf(memberPage)).toBeVisible();
    await openPage(memberPage, seed.pageId);
    await expect(chipOf(memberPage, seed.itemA.key)).toHaveCount(1);
    await expect(linkItemDoorOf(memberPage)).toBeVisible();
    await expect(unlinkItemOf(memberPage, seed.itemA.key)).toBeVisible();
  } finally {
    await memberContext.close();
  }

  await signIn(page, VIEWER_EMAIL, PASSWORD);
  await openItem(page, seed.itemA);
  await expect(pageRowOf(page, seed.itemA.key)).toHaveCount(1);
  await expect(pageRowOf(page, seed.itemA.key)).toContainText(LINKED);
  await expect(linkDoorOf(page)).toHaveCount(0);
  await expect(unlinkPageOf(page)).toHaveCount(0);

  const read = stripRead(page, seed.pageId);
  expect((await page.goto(`/pages/${seed.pageId}`))?.status()).toBe(200);
  expect((await read).status()).toBe(200);
  await expect(chipOf(page, seed.itemA.key)).toHaveCount(1);
  await expect(linkItemDoorOf(page)).toHaveCount(0);
  await expect(unlinkItemOf(page, seed.itemA.key)).toHaveCount(0);
});
