import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkItemPagesDto } from '@/lib/dto/pageLinks';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// A PAGE EMBEDS A WORK ITEM AS A CARD — THE ACCEPTANCE RECEIPT
// (Story MOTIR-7566 · Subtask MOTIR-9184). The story's verification recipe, in a
// real browser against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One recorded journey, as a project Member with `page:edit`: from the toolbar's
// "Embed a work item as a card" the picker opens in card placement; picking an
// item drops a block card carrying its five facts — type, key, title, status and
// assignee. A reload keeps the card, and its Open control opens the item's
// quick-view peek. The work item's Pages section, opened fresh, lists the page
// once as Embedded. A chip for the same item on the same page makes the section
// show ONE row carrying both labels. The item is reassigned and the page
// reloaded with no edit in between: the card shows the new assignee, because the
// summary is read live. Finally the card is shown as an inline mention: the
// section keeps one row, now labelled Mentioned only.
//
// The tests after the recorded one run at machine speed with no chapters: a card
// deleted from the body leaves the Pages section, and a card for an item the
// reader cannot see renders as the unavailable card with neither key nor title.
//
// ── THE WAITS (CLAUDE.md § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// Every body save is waited on by its own `POST /api/pages/<id>/updates`
// response, ARMED BEFORE the input that produces it, then the toolbar's save
// indicator reading Saved — the `pages-write.spec.ts` signal. The picker's search
// by its `GET /api/work-items/mention-search` for the exact query. The Pages
// section is a client island that reads ONCE on mount (nothing another mutation
// on the page refreshes it), so every section assertion follows a FRESH
// navigation to the item page, waits on that `GET /api/work-items/<id>/pages`,
// and checks the `sources` of the row the section's own read returned as well as
// the labels it drew. Nothing waits on a timeout: every `beat()` is pacing for
// the viewer, taken after the state it shows is already proven.

const PASSWORD = 'acceptance-page-embed-e2e-pass-123';
const OWNER_EMAIL = 'acceptance-embed-owner@example.com';
const MEMBER_EMAIL = 'acceptance-embed-member@example.com';

const TYPING = { delay: 45 };
const JOURNEY_BUDGET_MS = 60_000;

const PAGE_TITLE = 'Checkout launch plan';
const INTRO = 'The payments team owns this launch.';
const LEAD_IN = 'Blocked on ';
const QUERY = 'Checkout';
const ITEM_TITLE = 'Checkout retry backoff';
const SECRET_TITLE = 'Treasury key rotation plan';
const OWNER_NAME = 'Olga Owner';
const MEMBER_NAME = 'Mia Member';

// The names the editor card and the shipped Pages section settled — bound HERE,
// once, by role and accessible name, so a wording change costs one line.
const NAMES = {
  toolbarEmbed: 'Embed a work item as a card',
  picker: 'Mention a work item',
  placementCard: 'Card',
  placementMention: 'Inline mention',
  cardOptions: 'Card options',
  openCard: 'Open work item',
  toMention: 'Show as inline mention',
  removeCard: 'Remove card',
  typeCode: 'Type: Code',
  statusTodo: 'To Do',
  unavailable: 'Work item unavailable',
  sourceEmbed: 'Embedded',
  sourceMention: 'Mentioned',
  noPages: 'No page links to this work item yet.',
} as const;

interface Seed {
  owner: ServiceContext;
  member: ServiceContext;
  projectId: string;
  pageId: string;
  item: { id: string; key: string };
  secret: { id: string; key: string };
}

async function seed(): Promise<Seed> {
  const owner = await usersService.createUser({
    email: OWNER_EMAIL,
    password: PASSWORD,
    name: OWNER_NAME,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Embed Workspace',
    ownerUserId: owner.id,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  const shop = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Storefront',
    identifier: 'SHOP',
  });
  // The second project is Members-only and the reader is not added to it.
  const vault = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Vault',
    identifier: 'VLT',
  });
  await projectMembersService.setAccessMode({
    key: vault.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    mode: 'members',
  });

  const member = await usersService.createUser({
    email: MEMBER_EMAIL,
    password: PASSWORD,
    name: MEMBER_NAME,
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  await addToProjectAs({
    key: shop.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    targetUserId: member.id,
    role: 'member',
  });
  const memberCtx = { userId: member.id, workspaceId: workspace.id };
  await projectsService.setActiveProject({ ...ownerCtx, projectId: shop.id });
  await projectsService.setActiveProject({ ...memberCtx, projectId: shop.id });

  const created = await workItemsService.createWorkItem(
    { projectId: shop.id, kind: 'task', title: ITEM_TITLE, type: 'code', assigneeId: owner.id },
    ownerCtx,
  );
  const hidden = await workItemsService.createWorkItem(
    { projectId: vault.id, kind: 'task', title: SECRET_TITLE },
    ownerCtx,
  );
  const page = await pagesService.createPage(ownerCtx, { projectId: shop.id, title: PAGE_TITLE });
  const seeded: Seed = {
    owner: ownerCtx,
    member: memberCtx,
    projectId: shop.id,
    pageId: page.id,
    item: { id: created.id, key: created.identifier },
    secret: { id: hidden.id, key: hidden.identifier },
  };
  await writeMarkdown(seeded, INTRO);
  return seeded;
}

/** Replace the page's body through the shipped markdown write, as the owner. */
async function writeMarkdown(s: Seed, markdown: string): Promise<void> {
  const { revision } = await adminDb.page.findUniqueOrThrow({ where: { id: s.pageId } });
  await pagesService.savePageMarkdown(s.owner, {
    projectId: s.projectId,
    pageId: s.pageId,
    markdown,
    expectedRevision: revision,
  });
}

// ── Locators and waits ──────────────────────────────────────────────────────

const bodyOf = (page: Page) =>
  page.getByRole('textbox', { name: 'Page body', exact: true }).first();
const toolbarOf = (page: Page) => page.getByRole('toolbar', { name: 'Formatting', exact: true });
const indicatorOf = (page: Page) => toolbarOf(page).getByRole('status');
const pickerOf = (page: Page) => page.getByRole('listbox', { name: NAMES.picker, exact: true });
/** The embedded card's host-drawn body: five facts, each below by its own locator. */
const cardOf = (page: Page) => bodyOf(page).getByTestId('work-item-embed-card');
const cardFrameOf = (page: Page, key: string) =>
  bodyOf(page).getByRole('group', { name: `Work item ${key}`, exact: true });
const chipOf = (page: Page, key: string) =>
  bodyOf(page).getByRole('link', { name: new RegExp(`\\b${key}\\b`) });
const pagesSectionOf = (page: Page) => page.locator('#pages');
const pageRowOf = (page: Page, key: string) =>
  pagesSectionOf(page)
    .getByRole('list', { name: `Pages that link to ${key}`, exact: true })
    .getByRole('link')
    .filter({ hasText: PAGE_TITLE });

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

async function openPage(page: Page, pageId: string): Promise<void> {
  expect((await page.goto(`/pages/${pageId}`))?.status()).toBe(200);
  await expect(bodyOf(page)).toHaveAttribute('contenteditable', 'true');
  await expect(indicatorOf(page)).toHaveText('Saved');
}

/**
 * Open the work item FRESH and wait on the Pages section's own read; returns the
 * section and the row the read returned for the page (`undefined` when none).
 */
async function openItem(
  page: Page,
  item: { id: string; key: string },
): Promise<{ section: Locator; sources: string[] | null; rows: number }> {
  const read = pagesReadOf(page, item.id);
  expect((await page.goto(`/items/${item.key}`))?.status()).toBe(200);
  const response = await read;
  expect(response.status()).toBe(200);
  const dto = (await response.json()) as WorkItemPagesDto;
  const section = pagesSectionOf(page);
  await expect(section.getByRole('heading', { name: 'Pages', level: 2 })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  const row = dto.rows.find((r) => r.title === PAGE_TITLE);
  return { section, sources: row ? [...row.sources].sort() : null, rows: dto.rows.length };
}

/** At the end of the body: a new line, the lead-in, then the toolbar's embed door. */
async function openPickerFromToolbar(page: Page): Promise<Locator> {
  await bodyOf(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(LEAD_IN, TYPING);
  await toolbarOf(page).getByRole('button', { name: NAMES.toolbarEmbed, exact: true }).click();
  const picker = pickerOf(page);
  await expect(picker).toBeVisible();
  return picker;
}

/** Type the query into the open picker and wait on its search. */
async function searchFor(page: Page, picker: Locator): Promise<void> {
  const searched = searchOf(page, QUERY);
  await page.keyboard.type(QUERY, TYPING);
  expect((await searched).status()).toBe(200);
  await expect(picker.getByRole('option')).toHaveCount(1);
}

/** The card's five facts, each by its own locator. */
async function expectFiveFacts(
  page: Page,
  item: { key: string },
  facts: { assignee: string },
): Promise<void> {
  const card = cardOf(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('img', { name: NAMES.typeCode, exact: true })).toBeVisible();
  await expect(card.getByText(item.key, { exact: true })).toBeVisible();
  await expect(card.getByText(ITEM_TITLE, { exact: true })).toBeVisible();
  await expect(card.getByText(NAMES.statusTodo, { exact: true })).toBeVisible();
  await expect(card.getByText(facts.assignee, { exact: true })).toBeVisible();
}

/** The card's controls appear on hover; open the ⋯ menu. */
async function openCardMenu(page: Page, key: string): Promise<void> {
  await cardFrameOf(page, key).hover();
  await bodyOf(page).getByRole('button', { name: NAMES.cardOptions, exact: true }).click();
}

// ── The recorded journey ────────────────────────────────────────────────────

test('a member embeds a work item as a card; it shows five live facts, lists the page as Embedded, and converts back to a chip', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-7566');
  test.setTimeout(240_000);

  await resetDatabase();
  const s = await seed();
  const { pageId, item } = s;
  await signIn(page, MEMBER_EMAIL, PASSWORD);
  await openPage(page, pageId);
  const startedAt = Date.now();

  await chapter(
    'Embed as a card — the toolbar opens the picker in card placement; picking drops a card with five facts',
    async () => {
      const picker = await openPickerFromToolbar(page);
      await expect(
        page.getByRole('radio', { name: NAMES.placementCard, exact: true }),
      ).toHaveAttribute('aria-checked', 'true');
      await searchFor(page, picker);
      await savedAfter(page, pageId, async () => {
        await picker.getByRole('option', { name: new RegExp(`\\b${item.key}\\b`) }).click();
        await expect(picker).toBeHidden();
      });
      await expectFiveFacts(page, item, { assignee: OWNER_NAME });
      await beat();
    },
  );

  await chapter('Reloaded — it is still a card, and Open shows the item in the peek', async () => {
    await openPage(page, pageId);
    await expectFiveFacts(page, item, { assignee: OWNER_NAME });
    await cardFrameOf(page, item.key).hover();
    await bodyOf(page).getByRole('button', { name: NAMES.openCard, exact: true }).click();
    await page.waitForURL((u) => u.searchParams.get('peek') === item.key);
  });

  await chapter('The work item lists the page once — Embedded, not Mentioned', async () => {
    const opened = await openItem(page, item);
    await expect(pageRowOf(page, item.key)).toHaveCount(1);
    await expect(pageRowOf(page, item.key)).toContainText(NAMES.sourceEmbed);
    await expect(pageRowOf(page, item.key)).not.toContainText(NAMES.sourceMention);
    expect(opened.sources).toEqual(['embed']);
    await beat();
  });

  await chapter('A chip for the same item — one row, both labels', async () => {
    await openPage(page, pageId);
    await bodyOf(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(`${LEAD_IN}@`, TYPING);
    const picker = pickerOf(page);
    await expect(picker).toBeVisible();
    await expect(
      page.getByRole('radio', { name: NAMES.placementMention, exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
    await searchFor(page, picker);
    await savedAfter(page, pageId, async () => {
      await picker.getByRole('option', { name: new RegExp(`\\b${item.key}\\b`) }).click();
      await expect(picker).toBeHidden();
    });
    await expect(chipOf(page, item.key)).toBeVisible();

    const opened = await openItem(page, item);
    await expect(pageRowOf(page, item.key)).toHaveCount(1);
    await expect(pageRowOf(page, item.key)).toContainText(NAMES.sourceEmbed);
    await expect(pageRowOf(page, item.key)).toContainText(NAMES.sourceMention);
    expect(opened.sources).toEqual(['embed', 'mention']);
  });

  await chapter('Reassigned elsewhere — the page, reloaded, shows the new assignee', async () => {
    // Off camera, through the shipped write: the claim is that the card reads live.
    await workItemsService.assignWorkItem(item.id, s.member.userId, s.owner);
    await openPage(page, pageId);
    await expectFiveFacts(page, item, { assignee: MEMBER_NAME });
    await beat();
  });

  await chapter(
    'Shown as an inline mention — the work item keeps one row, Mentioned only',
    async () => {
      await savedAfter(page, pageId, async () => {
        await openCardMenu(page, item.key);
        await page.getByRole('menuitem', { name: NAMES.toMention, exact: true }).click();
        await expect(cardOf(page)).toHaveCount(0);
      });
      const opened = await openItem(page, item);
      await expect(pageRowOf(page, item.key)).toHaveCount(1);
      await expect(pageRowOf(page, item.key)).toContainText(NAMES.sourceMention);
      await expect(pageRowOf(page, item.key)).not.toContainText(NAMES.sourceEmbed);
      expect(opened.sources).toEqual(['mention']);
      expect(opened.rows).toBe(1);
    },
  );

  // The receipt's budget: the clip must stay inside the lane's ~60 s.
  expect(Date.now() - startedAt).toBeLessThan(JOURNEY_BUDGET_MS);
});

// ── Unrecorded ──────────────────────────────────────────────────────────────

test('deleting the card from the body takes the page out of the work item’s Pages section', async ({
  page,
}) => {
  await resetDatabase();
  const s = await seed();
  await writeMarkdown(s, `${INTRO}\n\n![${s.item.key}](motir:${s.item.id})`);
  await signIn(page, MEMBER_EMAIL, PASSWORD);

  const before = await openItem(page, s.item);
  await expect(pageRowOf(page, s.item.key)).toHaveCount(1);
  expect(before.sources).toEqual(['embed']);

  await openPage(page, s.pageId);
  await expectFiveFacts(page, s.item, { assignee: OWNER_NAME });
  await savedAfter(page, s.pageId, async () => {
    await openCardMenu(page, s.item.key);
    await page.getByRole('menuitem', { name: NAMES.removeCard, exact: true }).click();
    await expect(cardOf(page)).toHaveCount(0);
  });

  const after = await openItem(page, s.item);
  await expect(after.section).toContainText(NAMES.noPages);
  await expect(pageRowOf(page, s.item.key)).toHaveCount(0);
  expect(after.sources).toBeNull();
});

test('a card for an item the reader cannot see is the unavailable card, with no key or title', async ({
  page,
}) => {
  await resetDatabase();
  const s = await seed();
  // Written through the shipped markdown write — the picker cannot offer it.
  await writeMarkdown(s, `${INTRO}\n\n![${s.secret.key}](motir:${s.secret.id})`);
  await signIn(page, MEMBER_EMAIL, PASSWORD);
  await openPage(page, s.pageId);

  const body = bodyOf(page);
  await expect(body.getByText(NAMES.unavailable, { exact: true })).toBeVisible();
  await expect(cardOf(page)).toHaveCount(0);
  await expect(body).not.toContainText(s.secret.key);
  await expect(body).not.toContainText(SECRET_TITLE);
});
