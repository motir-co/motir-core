import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { pageRefresh } from './_helpers/authoritative-signal';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// A LEAF CARRIES A DIFFICULTY A PERSON SETS — THE ACCEPTANCE RECEIPT (Story
// MOTIR-6016 · Subtask MOTIR-6103). The story's verification recipe, in a real
// browser against a production build and a real database.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person sets how hard a subtask is to reason about in the quick view, changes
// it on the card's page and sees the change land in the activity feed without a
// reload, finds the card by filtering the list and the board on it, clears it,
// and finds no such field at all on the story above it.
//
// ── THE WAITS (the coding convention § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// A difficulty write is a Server Action POST to the CURRENT page, told apart by
// its body (it names the item's id and the `difficulty` key). Every write is
// armed BEFORE the press, its status asserted, and then settled on the
// COMMITTED row (`expect.poll` over the database) before the walk moves on. The
// feed's own re-read is its GET `/api/work-items/<id>/activity/history`, armed
// before the press that bumps it. A list read is the RSC GET the builder's
// `router.push` makes; a board read is its `GET /api/board?filter=`.

const PASSWORD = 'acceptance-difficulty-e2e-pass-123';
const OWNER_EMAIL = 'acceptance-difficulty@example.com';
const VIEWER_EMAIL = 'acceptance-difficulty-viewer@example.com';

const STORY = 'Checkout rework';
const SUBJECT = 'Reorder the lock acquisition';
const SIBLING_MEDIUM = 'Split the payment adapter';
const SIBLING_LOW = 'Rename the retry flag';

interface Seed {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
}

interface Item {
  id: string;
  identifier: string;
  title: string;
}

async function seedProject(email: string, identifier: string): Promise<Seed> {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Mo Rivera' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Difficulty Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Payments',
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

/** One story holding the subtask under test (no difficulty) and two siblings
 * that carry one, so a filter has something to leave out. */
async function seedStory(seed: Seed) {
  const story = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: STORY },
    seed.ctx,
  );
  const leaf = async (title: string, difficulty: WorkItemDifficultyDto | null): Promise<Item> => {
    const dto = await workItemsService.createWorkItem(
      { projectId: seed.projectId, kind: 'subtask', title, parentId: story.id, difficulty },
      seed.ctx,
    );
    return { id: dto.id, identifier: dto.identifier, title: dto.title };
  };
  return {
    story: { id: story.id, identifier: story.identifier, title: story.title } as Item,
    subject: await leaf(SUBJECT, null),
    medium: await leaf(SIBLING_MEDIUM, 'medium'),
    low: await leaf(SIBLING_LOW, 'low'),
  };
}

/** THE committed-state read: the row itself, polled until it holds `expected`. */
async function expectCommitted(id: string, expected: WorkItemDifficultyDto | null): Promise<void> {
  await expect
    .poll(
      async () =>
        (await adminDb.workItem.findUnique({ where: { id }, select: { difficulty: true } }))
          ?.difficulty ?? null,
      { message: `the row committed difficulty = ${String(expected)}`, timeout: 20_000 },
    )
    .toBe(expected);
}

/** The Server Action carrying a difficulty write for `itemId`, on `pathname`. */
function difficultyWrite(page: Page, pathname: string, itemId: string): Promise<Response> {
  return page.waitForResponse((res) => {
    const req = res.request();
    const body = req.postData() ?? '';
    return (
      req.method() === 'POST' &&
      req.headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === pathname &&
      body.includes(itemId) &&
      body.includes('difficulty')
    );
  });
}

/** The History feed's own re-read of its first page. */
function historyReread(page: Page, itemId: string): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/work-items/${itemId}/activity/history`,
  );
}

/** Open the quick view over /items by activating the row; wait for its real read. */
async function openPeek(page: Page, identifier: string) {
  const row = page.getByRole('main').getByTestId(`issue-row-${identifier}`);
  await expect(row).toBeVisible();
  const read = page.waitForResponse(
    (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
  );
  // A plain click on the row's stretched link opens the peek (MOTIR-1306). The
  // link covers the whole row, but its centre sits under a cell's content, so
  // the press lands in the row's left padding, where only the link is.
  await row
    .getByRole('link')
    .first()
    .click({ position: { x: 6, y: 22 } });
  expect((await read).status(), 'the quick view read').toBe(200);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The quick view's rail row whose caption is `label`. */
const railRow = (page: Page, label: string) =>
  page
    .getByRole('dialog')
    .locator('dt', { hasText: new RegExp(`^${label}$`) })
    .locator('..');

/** The item page's Difficulty card, found by its own chevron — named `Edit
 * Difficulty` at rest and `Close Difficulty` while its editor is open. */
const difficultyCard = (page: Page) =>
  page
    .getByRole('main')
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: /^(Edit|Close) Difficulty$/ }) });

const listRow = (page: Page, title: string) =>
  page.getByRole('main').getByRole('row').filter({ hasText: title });

/** Add ONE advanced-filter condition on Difficulty and apply it. */
async function filterByDifficulty(
  page: Page,
  operator: 'is any of' | 'is empty',
  value: 'High' | null,
  read: Promise<Response>,
): Promise<void> {
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row = dialog.getByRole('group', { name: 'Condition 1' });
  await row.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Difficulty', exact: true }).click();
  await row.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: operator, exact: true }).click();
  if (value !== null) {
    await row.getByRole('combobox', { name: 'Difficulty values' }).click();
    const options = page.getByRole('option');
    // The three values the design draws, easiest first.
    await expect(options.filter({ hasText: /^(Low|Medium|High)$/ })).toHaveCount(3);
    await page.getByRole('option', { name: value, exact: true }).click();
  }
  expect((await read).status(), 'the filtered read').toBe(200);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
}

async function boardTitles(res: Response): Promise<string[]> {
  const board = (await res.json()) as { columns: Array<{ cards: Array<{ title: string }> }> };
  return board.columns.flatMap((c) => c.cards.map((card) => card.title)).sort();
}

const boardGet = (filtered: boolean) => (r: Response) => {
  if (r.request().method() !== 'GET') return false;
  const u = new URL(r.url());
  return u.pathname === '/api/board' && u.searchParams.has('filter') === filtered;
};

test('a person sets a leaf’s difficulty, changes it, finds it on the list and the board, clears it — and a story has none', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  test.setTimeout(240_000);
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-6016');

  await resetDatabase();
  const seed = await seedProject(OWNER_EMAIL, 'DIFF');
  const { story, subject, medium, low } = await seedStory(seed);

  await signIn(page, OWNER_EMAIL, PASSWORD);

  await chapter('Open a subtask from the list — its difficulty is not set', async () => {
    await page.goto('/items?view=list');
    const dialog = await openPeek(page, subject.identifier);
    await expect(dialog.getByRole('heading', { name: SUBJECT })).toBeVisible();
    await expect(railRow(page, 'Difficulty')).toContainText('None');
  });

  await chapter('Set it to Medium in the quick view', async () => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Edit Difficulty', exact: true }).click();
    const picker = dialog.getByRole('group', { name: 'Difficulty' });
    await expect(picker).toBeVisible();
    // Unset presses nothing.
    await expect(picker.getByRole('button', { pressed: true })).toHaveCount(0);

    const write = difficultyWrite(page, '/items', subject.id);
    await picker.getByRole('button', { name: 'Medium', exact: true }).click();
    expect((await write).status(), 'the quick-view write').toBe(200);
    await expectCommitted(subject.id, 'medium');
    await expect(railRow(page, 'Difficulty')).toContainText('Medium');
    await beat();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  const subjectPath = `/items/${subject.identifier}`;

  await chapter('On its page it reads Medium — change it to High', async () => {
    await page.goto(`${subjectPath}?activity=history`);
    await expect(page.getByRole('heading', { name: SUBJECT })).toBeVisible();
    await expect(difficultyCard(page)).toContainText('Medium');
    await beat();

    await page.getByRole('button', { name: 'Edit Difficulty', exact: true }).click();
    const picker = difficultyCard(page).getByRole('group', { name: 'Difficulty' });
    await expect(picker.getByRole('button', { name: 'Medium', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const write = difficultyWrite(page, subjectPath, subject.id);
    const feed = historyReread(page, subject.id);
    await picker.getByRole('button', { name: 'High', exact: true }).click();
    expect((await write).status(), 'the page write').toBe(200);
    await expectCommitted(subject.id, 'high');
    expect((await feed).status(), 'the feed re-read its first page').toBe(200);
  });

  await chapter('The activity feed records Medium → High, with no reload', async () => {
    // A pick closes the editor; the card reads the committed value.
    await expect(difficultyCard(page)).toContainText('High');
    // The entry the feed re-read: the field name, then the struck old value and
    // the new one (the stored keys, as Executor's are). One entry's sentence
    // paragraph is the unit, so nothing wider can satisfy it.
    const entries = page
      .getByRole('main')
      .locator('p')
      .filter({ hasText: /changed the Difficulty/ })
      .locator('..');
    // Two changes, two entries: None → medium from the quick view, and this one.
    await expect(entries).toHaveCount(2);
    const entry = entries.filter({ hasText: /high/ });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('medium');
    await expect(entry).toContainText('high');
    await expect(entry).toBeVisible();
    await entry.scrollIntoViewIfNeeded();
    expect(new URL(page.url()).pathname, 'the page was never reloaded').toBe(subjectPath);
    await beat();
  });

  await chapter('Filter the list: Difficulty is any of High', async () => {
    await page.goto('/items?view=list');
    for (const item of [subject, medium, low]) {
      await expect(listRow(page, item.title)).toBeVisible();
    }
    await filterByDifficulty(page, 'is any of', 'High', pageRefresh(page, '/items'));

    const applied = page.locator('[aria-label="Applied filter"]');
    await expect(applied).toContainText('Difficulty');
    await expect(applied).toContainText('High');
    await expect(listRow(page, SUBJECT)).toBeVisible();
    await expect(listRow(page, SIBLING_MEDIUM)).toHaveCount(0);
    await expect(listRow(page, SIBLING_LOW)).toHaveCount(0);
    await beat();

    // Remove the condition — the chip bar lets go of it and the list is whole.
    await page.getByRole('button', { name: /^Advanced filter/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
    const cleared = pageRefresh(page, '/items');
    await dialog.getByRole('button', { name: 'Remove condition 1', exact: true }).click();
    expect((await cleared).status(), 'the unfiltered read').toBe(200);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('[aria-label="Applied filter"]')).toHaveCount(0);
    await expect(listRow(page, SIBLING_MEDIUM)).toBeVisible();
  });

  await chapter('The board narrows to it on the same condition', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const whole = page.waitForResponse(boardGet(false));
    await page.goto('/boards');
    expect(await boardTitles(await whole)).toEqual(
      expect.arrayContaining([SUBJECT, SIBLING_MEDIUM, SIBLING_LOW]),
    );
    const board = page.getByRole('main').getByTestId('board');
    await expect(board.getByText(SIBLING_MEDIUM)).toBeVisible();

    const filtered = page.waitForResponse(boardGet(true));
    await filterByDifficulty(page, 'is any of', 'High', filtered);
    const titles = await boardTitles(await filtered);
    expect(titles, 'the board matched only the High subtask').toEqual([SUBJECT]);
    await expect(board.getByText(SUBJECT)).toBeVisible();
    await expect(board.getByText(SIBLING_MEDIUM)).toHaveCount(0);
    await expect(board.getByText(SIBLING_LOW)).toHaveCount(0);
    await beat();
  });

  await chapter('Clear it — Difficulty is empty now finds it', async () => {
    await page.goto(subjectPath);
    await expect(difficultyCard(page)).toContainText('High');
    await page.getByRole('button', { name: 'Edit Difficulty', exact: true }).click();
    const write = difficultyWrite(page, subjectPath, subject.id);
    await difficultyCard(page).getByRole('button', { name: 'Clear', exact: true }).click();
    expect((await write).status(), 'the clear').toBe(200);
    await expectCommitted(subject.id, null);
    await expect(difficultyCard(page)).toContainText('Set difficulty');
    await beat();

    await page.goto('/items?view=list');
    await expect(listRow(page, SIBLING_MEDIUM)).toBeVisible();
    await filterByDifficulty(page, 'is empty', null, pageRefresh(page, '/items'));
    await expect(listRow(page, SUBJECT)).toBeVisible();
    await expect(listRow(page, SIBLING_MEDIUM)).toHaveCount(0);
    await expect(listRow(page, SIBLING_LOW)).toHaveCount(0);
    await beat();
  });

  await chapter('The story above it has no Difficulty field at all', async () => {
    await page.goto(`/items/${story.identifier}`);
    await expect(page.getByRole('heading', { name: STORY })).toBeVisible();
    // Absent from the DOM — not a hidden or disabled control.
    await expect(page.getByRole('button', { name: 'Edit Difficulty', exact: true })).toHaveCount(0);
    await expect(
      page
        .getByRole('main')
        .locator('[data-surface="card"]')
        .filter({ hasText: /^Difficulty/ }),
    ).toHaveCount(0);
    // The page's other leaf fields' neighbour — Priority — is there, so the
    // absence is not an unrendered panel.
    await expect(page.getByRole('button', { name: 'Edit Priority', exact: true })).toBeVisible();

    await page.goto('/items?view=list');
    const dialog = await openPeek(page, story.identifier);
    await expect(dialog.getByRole('heading', { name: STORY })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Edit Priority', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Edit Difficulty', exact: true })).toHaveCount(
      0,
    );
    await expect(dialog.locator('dt', { hasText: /^Difficulty$/ })).toHaveCount(0);
    await beat();
  });
});

test('a viewer without edit rights sees a leaf’s difficulty and no picker', async ({ page }) => {
  await resetDatabase();
  const seed = await seedProject('acceptance-difficulty-owner@example.com', 'DVIEW');
  const { subject } = await seedStory(seed);
  await workItemsService.updateWorkItem(subject.id, { difficulty: 'high' }, seed.ctx);

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

  await signIn(page, VIEWER_EMAIL, PASSWORD);
  await page.goto(`/items/${subject.identifier}`);
  await expect(page.getByRole('heading', { name: SUBJECT })).toBeVisible();

  const main = page.getByRole('main');
  const card = main.locator('[data-surface="card"]').filter({ hasText: /^Difficulty\s*High/ });
  await expect(card).toBeVisible();
  await expect(main.getByRole('button', { name: 'Edit Difficulty', exact: true })).toHaveCount(0);
  await expect(main.getByRole('group', { name: 'Difficulty' })).toHaveCount(0);
});
