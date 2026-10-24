// Acceptance E2E — a person SEES and SETS the obsolescence mark, and a MARKED card
// STAYS FINISHED (Story MOTIR-6575 · Subtask MOTIR-6680). The story's acceptance
// RECEIPT, and its Verification recipe automated.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A finished story is overtaken by another. Its owner marks it Outdated from its
// own page, says why in a note, and links the story that replaced it. From then on
// the mark is everywhere the team looks — the page header, the replacing story's
// relationships, the `/items` row, a filter, the board card — and the card cannot
// be quietly reopened: the status control holds every unfinished status and says
// how to get out, and a drag on the board springs back with the same reason. The
// quick view changes the mark to Deprecated. Clearing the mark lets the card
// reopen, and on the reopened card the two marks are locked with the reason.
//
// The unrecorded tests cover the rest of the card: a viewer reads the mark and
// cannot edit it; the `/items` row's inline status edit is refused in place; and a
// move WITHIN the done category (Done → Cancelled) still goes through.
//
// ── THE SEAMS ───────────────────────────────────────────────────────────────
//
// The project, the three stories and the viewer are seeded through the SHIPPED
// services (`agent-authored-plan-seed.ts`'s sanctioned cross-layer reach). A
// story's `done` status and its recency are set behind the service's back, as the
// board specs do: the board's terminal columns hold only cards touched within the
// Done-age window (`boardsService` `doneAgeCutoff`), so every finished story here
// is touched NOW. The project's workflow draws `done → todo` and `done → cancelled`
// (the default draws neither) so the recipe's own moves are legal edges and only
// the MARK can refuse them. Every mark and link in the recorded walk is set through
// the UI under test.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a Server Action's
// response, the board move's response (status AND body), a list or board read, a
// page reload, or a committed read of the database. `beat()` and the chapter hold
// are PACING only, each taken after the assertion that proved the state.
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { actionWrite, pageRefresh } from './_helpers/authoritative-signal';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { boardViewportWidth, columnByStatus, getBoard, pointerDragForMove } from './_helpers/board';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

const PASSWORD = 'obsolescence-e2e-pass-4';
const ob = en.workItems.obsolescence;

const WIZARD = 'Onboarding wizard';
const CANVAS = 'Onboarding canvas';
const EXPORT = 'CSV export';
const NOTE = 'the wizard was replaced by the canvas — see the roadmap story';

/** `Status can’t be reopened while this item is marked {mark}.` */
const heldText = (mark: string) => ob.held.text.replace('{mark}', mark);
/** The in-place line, as its text reads (the `<strong>` tags drop). */
const heldLine = (mark: string) =>
  ob.heldLine.replace('{mark}', mark).replace('<strong>', '').replace('</strong>', '');

// ── Seed ─────────────────────────────────────────────────────────────────────

interface Seed {
  email: string;
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

interface Story {
  id: string;
  key: string;
  title: string;
}

async function seedProject(email: string, identifier: string): Promise<Seed> {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Ines Ortega' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Obsolescence E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Onboarding',
    identifier,
  });
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  // The recipe's moves are legal edges, so only the MARK can refuse them.
  const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: project.id } });
  const id = (key: string) => statuses.find((s) => s.key === key)!.id;
  for (const to of ['todo', 'cancelled']) {
    await adminDb.workflowTransition.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        fromStatusId: id('done'),
        toStatusId: id(to),
      },
    });
  }
  return {
    email,
    ctx: { userId: owner.id, workspaceId: workspace.id },
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
  };
}

/** A FINISHED story, touched now so the board's Done column holds it. */
async function seedDoneStory(
  seed: Seed,
  title: string,
  mark: WorkItemObsolescenceDto | null = null,
  note: string | null = null,
): Promise<Story> {
  const item = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title },
    seed.ctx,
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status: 'done',
      updatedAt: new Date(),
      ...(mark ? { obsolescence: mark, obsolescenceNoteMd: note } : {}),
    },
  });
  return { id: item.id, key: item.identifier, title };
}

async function seedViewer(seed: Seed, email: string): Promise<void> {
  const viewer = await usersService.createUser({ email, password: PASSWORD, name: 'Vic Viewer' });
  await workspacesService.addMember({ userId: viewer.id, workspaceId: seed.workspaceId });
  await addToProjectAs({
    key: seed.projectKey,
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

const rowOf = async (id: string) =>
  adminDb.workItem.findUniqueOrThrow({
    where: { id },
    select: { status: true, obsolescence: true, obsolescenceNoteMd: true },
  });

// ── Locators ─────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
/** The item page's Obsolescence card — its anchor wraps it. */
const obsolescenceCard = (page: Page) => main(page).locator('#obsolescence-field');
const markGroup = (scope: Locator) => scope.getByRole('group', { name: ob.label });
const headerBadge = (page: Page, word: string) =>
  main(page).getByRole('button', { name: `${word} — ${ob.badge.jump}` });
const relationshipGroup = (page: Page, kind: 'supersedes' | 'superseded_by') =>
  main(page).locator(`[data-relationship-group="${kind}"]`);
/** The item page's held box under the status value. */
const statusNotice = (page: Page) =>
  main(page)
    .getByRole('status')
    .filter({ hasText: /reopen this item/ });
const listRow = (page: Page, key: string) => main(page).getByTestId(`issue-row-${key}`);
const columns = (page: Page) => page.getByRole('group', { name: en.boards.boardLabel });
const boardCard = (page: Page, key: string) => columns(page).getByTestId(`board-card-${key}`);
const cardShell = (page: Page, key: string) => boardCard(page, key).locator('xpath=..');

/** The Server Action carrying an obsolescence write on `pathname`. */
const markWrite = (page: Page, pathname: string) => actionWrite(page, pathname, 'obsolescence');

const boardGet = (filtered: boolean) => (r: Response) => {
  if (r.request().method() !== 'GET') return false;
  const u = new URL(r.url());
  return u.pathname === '/api/board' && u.searchParams.has('filter') === filtered;
};

// ── Steps ────────────────────────────────────────────────────────────────────

async function openItem(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(obsolescenceCard(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

async function openBoard(page: Page): Promise<void> {
  await page.goto('/boards');
  await expect(columns(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** Drag a card to a status's column; returns the committed move response. */
async function dragTo(page: Page, key: string, statusKey: string) {
  const board = await getBoard(page.request);
  return pointerDragForMove(
    page,
    boardCard(page, key),
    columns(page).getByTestId(`board-column-${columnByStatus(board, statusKey).id}`),
  );
}

async function inColumn(page: Page, key: string, statusKey: string): Promise<void> {
  const board = await getBoard(page.request);
  await expect(
    columns(page)
      .getByTestId(`board-column-${columnByStatus(board, statusKey).id}`)
      .getByTestId(`board-card-${key}`),
  ).toBeVisible();
}

/** Open the item page's status picker. */
async function openStatusPicker(page: Page): Promise<void> {
  await main(page)
    .getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true })
    .click();
  await main(page).getByRole('combobox', { name: en.ui.statusPicker.label }).click();
}

/** Add ONE advanced-filter condition — Obsolescence is any of `value`. */
async function filterByObsolescence(page: Page, value: string, read: Promise<Response>) {
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced filter' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add condition' }).click();
  const row = dialog.getByRole('group', { name: 'Condition 1' });
  await row.getByRole('combobox', { name: 'Field' }).click();
  await page
    .getByRole('option', { name: en.issueViews.advancedFieldObsolescence, exact: true })
    .click();
  await row.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: 'is any of', exact: true }).click();
  await row
    .getByRole('combobox', { name: `${en.issueViews.advancedFieldObsolescence} values` })
    .click();
  await expect(page.getByRole('option').filter({ hasText: /^(Outdated|Deprecated)$/ })).toHaveCount(
    2,
  );
  await page.getByRole('option', { name: value, exact: true }).click();
  expect((await read).status(), 'the filtered read').toBe(200);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
}

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a finished story is marked Outdated, wears it everywhere, cannot be reopened until the mark is cleared', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6575');
  await resetDatabase();
  const seed = await seedProject(`obsolescence-${Date.now()}@example.com`, 'MARK');
  const wizard = await seedDoneStory(seed, WIZARD);
  const canvas = await seedDoneStory(seed, CANVAS);
  const exporter = await seedDoneStory(seed, EXPORT);
  const wizardPath = `/items/${wizard.key}`;

  await page.setViewportSize(boardViewportWidth());
  await signIn(page, seed.email, PASSWORD);

  await chapter('Mark the finished wizard story Outdated, and say why', async () => {
    await openItem(page, wizard.key);
    await expect(obsolescenceCard(page)).toContainText(ob.value.current);
    await expect(headerBadge(page, ob.value.outdated)).toHaveCount(0);

    await obsolescenceCard(page)
      .getByRole('button', { name: `Edit ${ob.label}` })
      .click();
    const marked = markWrite(page, wizardPath);
    await markGroup(obsolescenceCard(page))
      .getByRole('button', { name: ob.value.outdated })
      .click();
    expect((await marked).status()).toBe(200);
    await expect(headerBadge(page, ob.value.outdated)).toBeVisible();

    await obsolescenceCard(page).getByLabel(ob.note.label).fill(NOTE);
    const noted = actionWrite(page, wizardPath, 'the wizard was replaced');
    await obsolescenceCard(page).getByRole('button', { name: ob.editor.save }).click();
    expect((await noted).status()).toBe(200);
    await expect(obsolescenceCard(page)).toContainText(NOTE);
    expect(await rowOf(wizard.id)).toMatchObject({
      obsolescence: 'outdated',
      obsolescenceNoteMd: NOTE,
    });
    await beat();
  });

  await chapter('Link the story that replaced it — Superseded by the canvas', async () => {
    await main(page)
      .getByRole('button', { name: /Link work item/ })
      .click();
    await page.getByRole('combobox', { name: en.ui.linkAddForm.relationship }).click();
    await page.getByRole('option', { name: en.labels.relationship.superseded_by }).click();
    await page.getByRole('combobox', { name: en.ui.linkAddForm.issueToLink }).click();
    await page.getByRole('combobox', { name: /Search by identifier or title/ }).fill(CANVAS);
    await page.getByRole('option', { name: new RegExp(CANVAS) }).click();
    const linked = actionWrite(page, wizardPath, 'superseded_by');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    expect((await linked).status()).toBe(200);
    await expect(relationshipGroup(page, 'superseded_by')).toContainText(canvas.key);

    // The feed's History tab, from a fresh server read (the tab is a URL the server
    // answers): the mark is recorded here. The link is stored as `canvas supersedes
    // wizard`, so its entry lands on the canvas story (next chapter).
    await page.goto(`${wizardPath}?activity=history`);
    await expect(obsolescenceCard(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(
      main(page)
        .locator('p')
        .filter({ hasText: /changed the Obsolescence/ })
        .first(),
    ).toBeVisible();
    await beat();
  });

  await chapter('The canvas story lists what it supersedes', async () => {
    await page.goto(`/items/${canvas.key}?activity=history`);
    await expect(obsolescenceCard(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(relationshipGroup(page, 'supersedes')).toContainText(wizard.key);
    // Its History records the link it now holds.
    await expect(
      main(page)
        .getByRole('list', { name: 'History' })
        .locator('p')
        .filter({ hasText: /linked/ }),
    ).toContainText(wizard.key);
    await expect(headerBadge(page, ob.value.outdated)).toHaveCount(0);
    await beat();
  });

  await chapter('On /items the row wears the mark, and a filter finds exactly it', async () => {
    await page.goto('/items?view=list');
    await expect(listRow(page, wizard.key)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(listRow(page, wizard.key).locator('[data-obsolescence="outdated"]')).toBeVisible();
    await expect(listRow(page, exporter.key).locator('[data-obsolescence]')).toHaveCount(0);

    await filterByObsolescence(page, ob.value.outdated, pageRefresh(page, '/items'));
    await expect(page.locator('[aria-label="Applied filter"]')).toContainText(
      en.issueViews.advancedFieldObsolescence,
    );
    await expect(listRow(page, wizard.key)).toBeVisible();
    await expect(listRow(page, canvas.key)).toHaveCount(0);
    await expect(listRow(page, exporter.key)).toHaveCount(0);
    await beat();
  });

  await chapter('The board’s Done column: the card wears the same badge', async () => {
    const read = page.waitForResponse(boardGet(false));
    await openBoard(page);
    expect((await read).status()).toBe(200);
    await inColumn(page, wizard.key, 'done');
    await expect(
      boardCard(page, wizard.key).locator('[data-obsolescence="outdated"]'),
    ).toBeVisible();
    await expect(boardCard(page, exporter.key).locator('[data-obsolescence]')).toHaveCount(0);
    await beat();
  });

  await chapter('Dragging it back to To Do springs it back — the card says why', async () => {
    const move = await dragTo(page, wizard.key, 'todo');
    expect(move.status()).toBe(409);
    expect(((await move.json()) as { code: string }).code).toBe('MARKED_CARD_CANNOT_REOPEN');
    await inColumn(page, wizard.key, 'done');
    const refusal = cardShell(page, wizard.key).getByRole('status');
    await expect(refusal).toContainText(heldLine(ob.value.outdated));
    await expect(refusal.getByRole('link', { name: ob.openItem })).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: en.boards.moveRejectedTitle }),
    ).toHaveCount(0);
    expect((await rowOf(wizard.id)).status).toBe('done');
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('Its status control holds To Do, and says how to reopen it', async () => {
    await openItem(page, wizard.key);
    await expect(statusNotice(page)).toContainText(heldText(ob.value.outdated));
    await expect(statusNotice(page).getByRole('link', { name: ob.held.door })).toBeVisible();
    await openStatusPicker(page);
    const todo = page.getByRole('option', { name: /^To Do/ });
    await expect(todo).toHaveAttribute('aria-disabled', 'true');
    await expect(todo).toContainText(ob.held.option);
    await expect(page.getByRole('option', { name: /^Cancelled/ })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await beat();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  await chapter('In the quick view, change the mark to Deprecated — the hold stays', async () => {
    await page.goto('/items?view=list');
    const row = listRow(page, wizard.key);
    await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
    const peekRead = page.waitForResponse(
      (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
    );
    await row
      .getByRole('link', { name: new RegExp(WIZARD) })
      .first()
      .click();
    expect((await peekRead).status()).toBe(200);
    const peek = page.getByRole('dialog');
    const markRow = peek.locator('dt', { hasText: new RegExp(`^${ob.label}$`) }).locator('..');
    await markRow.getByRole('button', { name: `Edit ${ob.label}` }).click();
    const changed = markWrite(page, '/items');
    await markGroup(peek).getByRole('button', { name: ob.value.deprecated }).click();
    expect((await changed).status()).toBe(200);
    await expect(markRow.locator('[data-obsolescence="deprecated"]')).toBeVisible();
    await expect(peek.getByRole('status').filter({ hasText: /reopen this item/ })).toContainText(
      heldText(ob.value.deprecated),
    );
    expect((await rowOf(wizard.id)).obsolescence).toBe('deprecated');
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter(
    'Clear the mark — the card reopens to To Do, and cannot be marked there',
    async () => {
      await openItem(page, wizard.key);
      await obsolescenceCard(page)
        .getByRole('button', { name: `Edit ${ob.label}` })
        .click();
      const cleared = markWrite(page, wizardPath);
      await markGroup(obsolescenceCard(page))
        .getByRole('button', { name: ob.value.current })
        .click();
      expect((await cleared).status()).toBe(200);
      await expect(statusNotice(page)).toHaveCount(0);
      await expect(headerBadge(page, ob.value.deprecated)).toHaveCount(0);
      await obsolescenceCard(page).getByRole('button', { name: ob.editor.cancel }).click();

      await openStatusPicker(page);
      const moved = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          Boolean(r.request().headers()['next-action']) &&
          new URL(r.url()).pathname === wizardPath &&
          (r.request().postData() ?? '').includes('todo'),
      );
      await page.getByRole('option', { name: /^To Do/ }).click();
      expect((await moved).status()).toBe(200);
      await expect.poll(async () => (await rowOf(wizard.id)).status).toBe('todo');

      await obsolescenceCard(page)
        .getByRole('button', { name: `Edit ${ob.label}` })
        .click();
      const group = markGroup(obsolescenceCard(page));
      for (const name of [ob.value.outdated, ob.value.deprecated]) {
        await expect(group.getByRole('button', { name })).toBeDisabled();
      }
      await expect(obsolescenceCard(page)).toContainText(ob.lockedHint);
      await beat();
    },
  );
});

test('a viewer reads the mark, the note and the badge — and edits none of them', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject(`obsolescence-owner-${Date.now()}@example.com`, 'MARKV');
  const wizard = await seedDoneStory(seed, WIZARD, 'outdated', NOTE);
  const viewerEmail = `obsolescence-viewer-${Date.now()}@example.com`;
  await seedViewer(seed, viewerEmail);

  await signIn(page, viewerEmail, PASSWORD);
  await openItem(page, wizard.key);
  await expect(headerBadge(page, ob.value.outdated)).toBeVisible();
  await expect(obsolescenceCard(page)).toContainText(NOTE);
  const chevron = obsolescenceCard(page).getByRole('button', {
    name: new RegExp(`^${ob.label} —`),
  });
  await expect(chevron).toHaveAttribute('aria-disabled', 'true');
  // A disabled control is not actionable to Playwright; force the press to prove
  // it opens nothing.
  await chevron.click({ force: true });
  await expect(markGroup(obsolescenceCard(page))).toHaveCount(0);
});

test('the /items row’s inline status edit of a marked card is refused in place', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject(`obsolescence-list-${Date.now()}@example.com`, 'MARKL');
  const wizard = await seedDoneStory(seed, WIZARD, 'deprecated');

  await signIn(page, seed.email, PASSWORD);
  await page.goto('/items?view=list');
  const row = listRow(page, wizard.key);
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await row.getByRole('button', { name: `Edit ${en.issueViews.status}` }).click();
  const moved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
  );
  await page.getByRole('listbox').getByRole('option', { name: 'To Do' }).click();
  expect((await moved).status()).toBe(200);
  const line = row.getByRole('status');
  await expect(line).toContainText(heldLine(ob.value.deprecated));
  await expect(line.getByRole('link', { name: ob.openItem })).toHaveAttribute(
    'href',
    `/items/${wizard.key}#obsolescence-field`,
  );
  expect((await rowOf(wizard.id)).status).toBe('done');
});

test('a move WITHIN the done category is not a reopen — Done → Cancelled goes through', async ({
  page,
}) => {
  await resetDatabase();
  const seed = await seedProject(`obsolescence-terminal-${Date.now()}@example.com`, 'MARKT');
  const wizard = await seedDoneStory(seed, WIZARD, 'outdated');

  await page.setViewportSize(boardViewportWidth());
  await signIn(page, seed.email, PASSWORD);
  await openBoard(page);
  await inColumn(page, wizard.key, 'done');
  const move = await dragTo(page, wizard.key, 'cancelled');
  expect(move.status()).toBe(200);
  await expect.poll(async () => (await rowOf(wizard.id)).status).toBe('cancelled');
  expect((await rowOf(wizard.id)).obsolescence).toBe('outdated');
});
