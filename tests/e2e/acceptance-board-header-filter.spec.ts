// Acceptance E2E — the board's header filter IS the board's filter (MOTIR-11566,
// the behaviour MOTIR-11564 (the read) and MOTIR-11565 (the UI) built). Walked
// end to end in a real browser against the SERVED app, as a person would use it,
// and recorded as the acceptance video:
//
//   1. Ada (board admin) opens the kanban board "Bugs", stored filter Kind is
//      Bug, with no URL params: the header shows the Board filter chip with
//      Kind is Bug, and only bugs show;
//   2. she adds Priority is High in the header: Edited shows, only high-priority
//      bugs show; Save to board filter, confirmed, toasts, and the URL drops its
//      filter params;
//   3. a reload opens the board on Kind is Bug AND Priority is High;
//   4. she picks the saved filter "mobile" from Saved: it REPLACES the board
//      filter — every mobile card shows, tasks included, under the saved
//      filter's name chip; Reset to board filter returns to the high-priority
//      bugs and the Edited mark is gone;
//   5. she picks "mobile" again and chooses Set as board filter: after a reload
//      the board's filter is Label is mobile;
//   6. she removes every condition: every card on the board shows; Reset returns
//      to Label is mobile;
//   7. Tess, a project member without board:configure, opens "Bugs": the board
//      filter shows; her edit and a saved filter she applies both show Edited /
//      Reset, never Save to board filter or Set as board filter;
//   8. the project's default board, which has no stored filter, starts with an
//      empty header filter that behaves as it always did.
//
// The replace behaviour is the point of steps 4 and 6: before MOTIR-11564 a
// header filter could only NARROW within the stored one, so a saved filter for
// mobile work on a Kind is Bug board showed mobile BUGS only. Here it shows the
// mobile tasks too, and clearing the header shows the whole board.
//
// ── THE ACTORS ──────────────────────────────────────────────────────────────
// Ada (workspace owner, board admin) and Tess (a workspace member added to the
// project as `member`, who holds no `board:configure`). Seeded through the real
// services; both sign in on the ONE recorded page, because the lane publishes
// one video per test.
//
// ── WHAT IS SEEDED AND WHAT IS DRIVEN ───────────────────────────────────────
// Seeded: the actors, the project, its cards and label, the two project-visible
// saved filters, and the board "Bugs" with its stored filter (the card allows
// "create (or seed)"; creating a board with a filter from the New board dialog
// is MOTIR-10560's receipt, `acceptance-board-stored-filter.spec.ts`). Driven in
// the browser: every control this card's behaviour lives in — the header row,
// the Advanced builder, the Saved picker, the save confirms and their toasts.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every write arms `waitForResponse` before the click that sends it, and its
// status and body are read before anything else happens; every read of the
// board arms the `GET /api/board` it causes. The visible UI (chips, card titles,
// column counts, toasts) is then asserted against what that projection proved.
// There is no sleep; the only holds are the recording's `chapter()` and `beat()`
// pacing, always taken after the state is proven.
//
// ── THE STRINGS ─────────────────────────────────────────────────────────────
// Every label and sentence matched is read from `messages/en.json`, never
// retyped.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made. The lane records at its one fixed viewport (MOTIR-11471), so
// this spec never resizes the page.

import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { createTestPerson } from './_helpers/testPerson';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { labelsService } from '@/lib/services/labelsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { boardsService } from '@/lib/services/boardsService';
import { encodeFilterEnvelope, encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { BoardDto, BoardProjectionDto } from '@/lib/dto/boards';
import type { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 600_000 });

const PASSWORD = 'board-header-filter-e2e-pass-3';
const ADA = { email: 'bhf-ada@example.com', name: 'Ada Admin' };
const TESS = { email: 'bhf-tess@example.com', name: 'Tess Teammate' };
type Actor = typeof ADA;

const PROJECT = { name: 'Field App', key: 'BHF' };
const BUGS_BOARD = 'Bugs';
const MOBILE = 'mobile';
/** The saved filter the card names: Label is mobile, visible to the project. */
const MOBILE_FILTER = 'mobile';
/** A second project-visible saved filter Tess applies in step 7. */
const HIGH_FILTER = 'High priority';

const TB = en.boards;
const THF = TB.headerFilter;
const TIV = en.issueViews;
const TSF = en.savedFilters;
const APPLIED_BAR = `[aria-label="${TSF.applied.barAria}"]`;
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));
/** A condition as its chip on the header filter row reads it (MOTIR-11565): the
 * bold field, then the operator and values — no space between the two
 * elements' text. */
const sentence = (field: string, values: string) => `${field}${TIV.advancedOpIsAnyOf} ${values}`;
const BUG = en.labels.issueType.bug;
const HIGH = en.labels.priority.high;
const KIND_BUG_TEXT = sentence(TIV.filterKind, BUG);
const HIGH_TEXT = sentence(TIV.advancedFieldPriority, HIGH);
const LABEL_TEXT = sentence(TIV.advancedFieldLabel, MOBILE);

// ── The cards ───────────────────────────────────────────────────────────────
// Every step's change must be visible in the data: high and non-high bugs
// (Priority narrows the board filter), mobile bugs AND mobile non-bugs (a saved
// filter REPLACES the board filter rather than narrowing within it), a high
// non-bug (Priority alone is not Kind is Bug), and cards that are neither (the
// whole board shows when every condition is removed). Spread over the three
// columns so the column counts move with each step.

interface CardSeed {
  title: string;
  kind: WorkItemKind;
  status: 'todo' | 'in_progress' | 'done';
  priority: WorkItemPriority;
  mobile?: boolean;
}

const CARDS: CardSeed[] = [
  { title: 'Login fails on Safari', kind: 'bug', status: 'todo', priority: 'high', mobile: true },
  { title: 'Upload times out over 2 GB', kind: 'bug', status: 'in_progress', priority: 'high' },
  {
    title: 'Export crashes on an empty sheet',
    kind: 'bug',
    status: 'todo',
    priority: 'medium',
    mobile: true,
  },
  { title: 'Typo in the footer', kind: 'bug', status: 'done', priority: 'low' },
  {
    title: 'Mobile navigation drawer',
    kind: 'task',
    status: 'in_progress',
    priority: 'medium',
    mobile: true,
  },
  { title: 'Mobile push settings', kind: 'task', status: 'todo', priority: 'high', mobile: true },
  { title: 'Write the release notes', kind: 'task', status: 'todo', priority: 'medium' },
  { title: 'Onboarding checklist', kind: 'story', status: 'done', priority: 'medium' },
];

const titles = (pick: (c: CardSeed) => boolean) =>
  CARDS.filter(pick)
    .map((c) => c.title)
    .sort();
const ALL = titles(() => true);
const BUGS = titles((c) => c.kind === 'bug');
const HIGH_BUGS = titles((c) => c.kind === 'bug' && c.priority === 'high');
const MOBILE_CARDS = titles((c) => !!c.mobile);
const MOBILE_HIGH = titles((c) => !!c.mobile && c.priority === 'high');
const ALL_HIGH = titles((c) => c.priority === 'high');

const KIND_BUG: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
};
const KIND_BUG_AND_HIGH: FilterAst = {
  combinator: 'and',
  conditions: [
    { field: 'kind', operator: 'is_any_of', value: ['bug'] },
    { field: 'priority', operator: 'is_any_of', value: ['high'] },
  ],
};
const PRIORITY_HIGH: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
};
const labelIs = (labelId: string): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'lbl', operator: 'is_any_of', value: [labelId] }],
});

// ── Seed ────────────────────────────────────────────────────────────────────

interface Seed {
  defaultBoardId: string;
  bugsBoardId: string;
  labelId: string;
}

async function seed(): Promise<Seed> {
  const ada = await createTestPerson({ ...ADA, password: PASSWORD });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Field Studio',
    ownerUserId: ada.id,
  });
  const ctx = { userId: ada.id, workspaceId: workspace.id };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: ada.id,
    name: PROJECT.name,
    identifier: PROJECT.key,
  });
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });

  // Tess: a member of the workspace and the project — no `board:configure`.
  const tess = await createTestPerson({ ...TESS, password: PASSWORD });
  await workspacesService.addMember({ userId: tess.id, workspaceId: workspace.id });
  await addToProjectAs({
    key: project.identifier,
    actorUserId: ada.id,
    ctx,
    targetUserId: tess.id,
    role: 'member',
  });
  await projectsService.setActiveProject({
    userId: tess.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });

  let labelId = '';
  for (const card of CARDS) {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: card.kind, title: card.title, priority: card.priority },
      ctx,
    );
    // The columns group by status, whose write path is another story's (the
    // board-filter.spec shortcut).
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: card.status } });
    if (card.mobile) {
      const labels = await labelsService.addLabel(item.id, MOBILE, ctx);
      labelId = labels.find((l) => l.name === MOBILE)!.id;
    }
  }

  await savedFiltersService.create(
    project.identifier,
    {
      name: MOBILE_FILTER,
      visibility: 'project',
      filterParam: encodeFilterParam(labelIs(labelId)),
    },
    ctx,
  );
  await savedFiltersService.create(
    project.identifier,
    { name: HIGH_FILTER, visibility: 'project', filterParam: encodeFilterParam(PRIORITY_HIGH) },
    ctx,
  );

  const bugs = await boardsService.createBoard(
    project.id,
    { name: BUGS_BOARD, type: 'kanban', filter: encodeFilterEnvelope(KIND_BUG) },
    ctx,
  );
  const boards = await boardsService.listBoards(project.id, ctx);
  const defaultBoard = boards.find((b) => b.isDefault);
  if (!defaultBoard) throw new Error('a project should have a default board');

  return { defaultBoardId: defaultBoard.id, bugsBoardId: bugs.id, labelId };
}

// ── Waits ───────────────────────────────────────────────────────────────────

/** The board projection the page fetches for `boardId`; `filtered` splits on
 *  whether a header `filter` param rides it. */
function frameOf(page: Page, boardId: string, filtered?: boolean): Promise<Response> {
  return page.waitForResponse((r) => {
    if (r.request().method() !== 'GET') return false;
    const u = new URL(r.url());
    if (u.pathname !== '/api/board' || u.searchParams.get('boardId') !== boardId) return false;
    return filtered === undefined || u.searchParams.has('filter') === filtered;
  });
}

function respondsTo(page: Page, path: string, method: string): Promise<Response> {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === method,
  );
}

async function answered<T>(pending: Promise<Response>, status: number): Promise<T> {
  const res = await pending;
  expect(res.status(), `${res.request().method()} ${new URL(res.url()).pathname}`).toBe(status);
  return (await res.json()) as T;
}

/** A frame response's body, after its status is proven. */
async function frame(pending: Promise<Response>): Promise<BoardProjectionDto> {
  return answered<BoardProjectionDto>(pending, 200);
}

const titlesOf = (board: BoardProjectionDto) =>
  board.columns.flatMap((c) => c.cards.map((card) => card.title)).sort();

// ── Locators ────────────────────────────────────────────────────────────────
// Scoped to the live subtree (the page's `main`, or the open dialog): a
// page-rooted test id can also match a streamed or outgoing copy.
const main = (page: Page) => page.getByRole('main');

/** The header filter row on a board with a stored filter (MOTIR-11565). */
const headerRow = (page: Page) => main(page).getByTestId('board-header-filter');
/** Whichever applied row is showing: the board's own, or the saved-filter bar. */
const appliedRow = (page: Page) => main(page).locator(APPLIED_BAR);
const actionsOf = (page: Page) => main(page).getByTestId('board-filter-actions');
const boardRegion = (page: Page) => main(page).getByTestId('board');
const advancedDialog = (page: Page) => page.getByRole('dialog', { name: TIV.advancedDialogLabel });
const savedPicker = (page: Page) => page.locator(`[aria-label="${TSF.dropdown.label}"]`);
/** A toast, inside the toast region (app chrome named "Notifications (F8)"), so
 *  neither a streamed copy of the page nor the screen-reader announcement can
 *  match (the `regression-page-archive.spec.ts` helper). */
const toastOf = (page: Page, text: string) =>
  page
    .getByRole('region', { name: /Notifications/ })
    .getByRole('listitem')
    .filter({ hasText: text });
const editedMark = (page: Page) => appliedRow(page).getByText(TSF.applied.edited, { exact: true });

// ── Actions ─────────────────────────────────────────────────────────────────

async function as(page: Page, actor: Actor): Promise<void> {
  await signIn(page, actor.email, PASSWORD);
}

/** Open `/boards` on `boardId` with no filter params; return its projection. */
async function openBoard(page: Page, boardId: string): Promise<BoardProjectionDto> {
  const read = frameOf(page, boardId);
  await page.goto(`/boards?board=${boardId}`);
  const board = await frame(read);
  await expect(boardRegion(page)).toBeVisible();
  return board;
}

/** Reload the board page and return the projection the reload read. */
async function reloadBoard(page: Page, boardId: string): Promise<BoardProjectionDto> {
  const read = frameOf(page, boardId);
  await page.reload();
  const board = await frame(read);
  await expect(boardRegion(page)).toBeVisible();
  return board;
}

/** Pick one value of a builder row's multi-select, then close its list with a
 *  click on the row's own padding (Escape would close the dialog with it). */
async function pickValue(page: Page, scope: Locator, field: string, value: string) {
  const trigger = scope.getByRole('combobox', { name: `${field} values` });
  await trigger.click();
  const option = page.getByRole('option', { name: value, exact: true });
  await option.click();
  if (await option.isVisible()) await scope.click({ position: { x: 4, y: 4 } });
  await expect(option).toBeHidden();
}

/** Point a builder row at a field. */
async function setField(page: Page, row: Locator, field: string) {
  await row.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: field, exact: true }).click();
}

/** In the Advanced builder, add a Priority is High row after `existing` rows,
 *  and return the projection the change read. */
async function addPriorityHigh(
  page: Page,
  boardId: string,
  existing: number,
): Promise<BoardProjectionDto> {
  await page.getByRole('button', { name: /^Advanced/ }).click();
  const dialog = advancedDialog(page);
  await expect(dialog).toBeVisible();
  // The header starts as the board filter: its conditions are already rows.
  if (existing > 0) {
    await expect(dialog.getByRole('group', { name: `Condition ${existing}` })).toBeVisible();
  }
  await dialog.getByRole('button', { name: TIV.advancedAddCondition }).click();
  const row = dialog.getByRole('group', { name: `Condition ${existing + 1}` });
  await setField(page, row, TIV.advancedFieldPriority);
  const read = frameOf(page, boardId, true);
  await pickValue(page, row, TIV.advancedFieldPriority, HIGH);
  const board = await frame(read);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return board;
}

/** Apply a saved filter from the Saved picker; return the projection it read. */
async function applySaved(page: Page, boardId: string, name: string): Promise<BoardProjectionDto> {
  await page.getByRole('button', { name: /^Saved filters/ }).click();
  const picker = savedPicker(page);
  await expect(picker).toBeVisible();
  const read = frameOf(page, boardId, true);
  await picker
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .first()
    .click();
  const board = await frame(read);
  await expect(picker).toBeHidden();
  return board;
}

/** Reset to board filter from the row's actions; return the projection it read. */
async function resetToBoardFilter(page: Page, boardId: string): Promise<BoardProjectionDto> {
  const read = frameOf(page, boardId, false);
  await actionsOf(page).getByRole('button', { name: THF.reset }).click();
  return frame(read);
}

/** Confirm a Save to / Set as board filter, and return the PATCH's answer. The
 *  board's next projection (no filter params) is read too. */
async function confirmBoardWrite(
  page: Page,
  boardId: string,
  title: string,
  action: string,
): Promise<{ saved: BoardDto; board: BoardProjectionDto }> {
  const confirm = page.getByRole('dialog', { name: title });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByTestId('board-filter-save-confirm')).toBeVisible();
  const write = respondsTo(page, `/api/boards/${boardId}`, 'PATCH');
  const read = frameOf(page, boardId, false);
  await confirm.getByRole('button', { name: action, exact: true }).click();
  const saved = await answered<BoardDto>(write, 200);
  const board = await frame(read);
  await expect(confirm).toBeHidden();
  return { saved, board };
}

/** The URL carries no header filter at all — the board filter itself. */
function expectCleanUrl(page: Page): void {
  const params = new URL(page.url()).searchParams;
  for (const key of ['filter', 'boardFilter', 'kind', 'priority', 'lbl', 'type']) {
    expect(params.has(key), `?${key} in ${page.url()}`).toBe(false);
  }
}

/** The board shows exactly `expected` — proven by the projection, then on the
 *  page: each column's count badge, each expected card's title, and no other
 *  card's title. */
async function expectBoardShows(
  page: Page,
  board: BoardProjectionDto,
  expected: string[],
): Promise<void> {
  expect(titlesOf(board)).toEqual(expected);
  for (const column of board.columns) {
    const inColumn = CARDS.filter(
      (c) => expected.includes(c.title) && column.statusKeys.includes(c.status),
    );
    expect(column.totalCount, `${column.name} count`).toBe(inColumn.length);
    await expect(main(page).getByTestId(`board-count-${column.id}`)).toHaveText(
      String(inColumn.length),
    );
  }
  for (const card of CARDS) {
    const title = boardRegion(page).getByText(card.title, { exact: true });
    if (expected.includes(card.title)) await expect(title).toBeVisible();
    else await expect(title).toHaveCount(0);
  }
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('The board header filter opens as the board filter, saves to it, takes a saved filter in its place, and resets to it: steps 1 to 8', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11566');
  const s = await seed();
  const bugsId = s.bugsBoardId;

  await chapter(
    'Step 1 · Ada opens “Bugs” with no filter in the URL: the header shows its board filter Kind is Bug, and only bugs show',
    async () => {
      await as(page, ADA);
      const board = await openBoard(page, bugsId);
      expect(board.storedFilter?.envelope).toEqual(encodeFilterEnvelope(KIND_BUG));
      expectCleanUrl(page);
      await expectBoardShows(page, board, BUGS);

      await expect(headerRow(page)).toBeVisible();
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'board');
      await expect(headerRow(page).getByRole('button', { name: THF.chipAria })).toContainText(
        THF.chip,
      );
      await expect(headerRow(page)).toContainText(KIND_BUG_TEXT);
      await expect(editedMark(page)).toHaveCount(0);
      await expect(actionsOf(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 2 · She adds Priority is High: Edited shows, only high-priority bugs show, and Save to board filter stores it',
    async () => {
      const board = await addPriorityHigh(page, bugsId, 1);
      await expectBoardShows(page, board, HIGH_BUGS);
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'edited');
      await expect(editedMark(page)).toBeVisible();
      await expect(headerRow(page)).toContainText(KIND_BUG_TEXT);
      await expect(headerRow(page)).toContainText(HIGH_TEXT);
      await expect(actionsOf(page).getByRole('button', { name: THF.reset })).toBeVisible();
      await beat();

      await actionsOf(page).getByRole('button', { name: THF.saveToBoard }).click();
      const { saved, board: after } = await confirmBoardWrite(
        page,
        bugsId,
        THF.confirmSaveTitle,
        THF.saveToBoard,
      );
      expect(saved.filter).toEqual(encodeFilterEnvelope(KIND_BUG_AND_HIGH));
      await expect(toastOf(page, THF.savedToast)).toContainText(THF.savedToastBody);
      await page.waitForURL((u) => !u.searchParams.has('filter'));
      expectCleanUrl(page);
      await expectBoardShows(page, after, HIGH_BUGS);
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'board');
      await expect(editedMark(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 3 · A reload opens “Bugs” on its saved board filter: Kind is Bug and Priority is High',
    async () => {
      const board = await reloadBoard(page, bugsId);
      expect(board.storedFilter?.envelope).toEqual(encodeFilterEnvelope(KIND_BUG_AND_HIGH));
      expectCleanUrl(page);
      await expectBoardShows(page, board, HIGH_BUGS);
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'board');
      await expect(headerRow(page)).toContainText(THF.chip);
      await expect(headerRow(page)).toContainText(KIND_BUG_TEXT);
      await expect(headerRow(page)).toContainText(HIGH_TEXT);
      await expect(editedMark(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 4 · The saved filter “mobile” replaces the board filter — every mobile card shows, tasks included — and Reset to board filter returns',
    async () => {
      const board = await applySaved(page, bugsId, MOBILE_FILTER);
      // Replace, not narrow: the mobile TASKS show, which Kind is Bug would hide.
      await expectBoardShows(page, board, MOBILE_CARDS);
      await expect(headerRow(page)).toHaveCount(0);
      await expect(appliedRow(page)).toContainText(MOBILE_FILTER);
      await expect(appliedRow(page)).toContainText(LABEL_TEXT);
      await expect(appliedRow(page)).not.toContainText(KIND_BUG_TEXT);
      await expect(actionsOf(page).getByRole('button', { name: THF.setAsBoard })).toBeVisible();
      await expect(actionsOf(page).getByRole('button', { name: THF.reset })).toBeVisible();
      await beat();

      const back = await resetToBoardFilter(page, bugsId);
      await page.waitForURL((u) => !u.searchParams.has('filter'));
      expectCleanUrl(page);
      await expectBoardShows(page, back, HIGH_BUGS);
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'board');
      await expect(headerRow(page)).toContainText(KIND_BUG_TEXT);
      await expect(headerRow(page)).toContainText(HIGH_TEXT);
      await expect(editedMark(page)).toHaveCount(0);
      await expect(actionsOf(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 5 · Ada picks “mobile” again and sets it as the board filter: after a reload the board’s filter is Label is mobile',
    async () => {
      await applySaved(page, bugsId, MOBILE_FILTER);
      await actionsOf(page).getByRole('button', { name: THF.setAsBoard }).click();
      const { saved } = await confirmBoardWrite(
        page,
        bugsId,
        fill(THF.confirmSetTitle, { name: MOBILE_FILTER }),
        THF.setAsBoard,
      );
      expect(saved.filter).toEqual(encodeFilterEnvelope(labelIs(s.labelId)));
      await expect(toastOf(page, fill(THF.setToast, { name: MOBILE_FILTER }))).toBeVisible();
      await page.waitForURL((u) => !u.searchParams.has('filter'));
      expectCleanUrl(page);
      await beat();

      const board = await reloadBoard(page, bugsId);
      expect(board.storedFilter?.envelope).toEqual(encodeFilterEnvelope(labelIs(s.labelId)));
      await expectBoardShows(page, board, MOBILE_CARDS);
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'board');
      await expect(headerRow(page)).toContainText(THF.chip);
      await expect(headerRow(page)).toContainText(LABEL_TEXT);
      await expect(headerRow(page)).not.toContainText(KIND_BUG_TEXT);
      await expect(editedMark(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 6 · Removing every condition shows every card on the board, and Reset returns to Label is mobile',
    async () => {
      await page.getByRole('button', { name: /^Advanced/ }).click();
      const dialog = advancedDialog(page);
      await expect(dialog.getByRole('group', { name: 'Condition 1' })).toBeVisible();
      const read = frameOf(page, bugsId, false);
      await dialog.getByRole('button', { name: TIV.advancedClearAll }).click();
      const board = await frame(read);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      // The Cleared state survives a reload because the URL says so.
      expect(new URL(page.url()).searchParams.get('boardFilter')).toBe('off');
      await expectBoardShows(page, board, ALL);
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'cleared');
      await expect(headerRow(page)).toContainText(THF.clearedNote);
      await expect(editedMark(page)).toBeVisible();
      await expect(actionsOf(page).getByRole('button', { name: THF.reset })).toBeVisible();
      await beat();

      const back = await resetToBoardFilter(page, bugsId);
      await page.waitForURL((u) => !u.searchParams.has('boardFilter'));
      expectCleanUrl(page);
      await expectBoardShows(page, back, MOBILE_CARDS);
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'board');
      await expect(headerRow(page)).toContainText(LABEL_TEXT);
      await expect(editedMark(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 7 · Tess, without board:configure, sees the board filter; her edits offer Reset but never Save to board filter or Set as board filter',
    async () => {
      await as(page, TESS);
      const board = await openBoard(page, bugsId);
      await expectBoardShows(page, board, MOBILE_CARDS);
      await expect(headerRow(page)).toHaveAttribute('data-mode', 'board');
      await expect(headerRow(page)).toContainText(THF.chip);
      await expect(headerRow(page)).toContainText(LABEL_TEXT);
      await expect(actionsOf(page)).toHaveCount(0);
      await beat();

      // An edit in the header: Edited and Reset, Save as for her own copy, and
      // no Save to board filter.
      const edited = await addPriorityHigh(page, bugsId, 1);
      await expectBoardShows(page, edited, MOBILE_HIGH);
      await expect(editedMark(page)).toBeVisible();
      await expect(actionsOf(page).getByRole('button', { name: THF.reset })).toBeVisible();
      await expect(
        actionsOf(page).getByRole('button', { name: TSF.applied.saveAs, exact: true }),
      ).toBeVisible();
      await expect(main(page).getByRole('button', { name: THF.saveToBoard })).toHaveCount(0);
      await expect(main(page).getByRole('button', { name: THF.setAsBoard })).toHaveCount(0);
      await beat();

      // A saved filter in its place: Reset, and no Set as board filter.
      const high = await applySaved(page, bugsId, HIGH_FILTER);
      await expectBoardShows(page, high, ALL_HIGH);
      await expect(appliedRow(page)).toContainText(HIGH_FILTER);
      await expect(appliedRow(page)).toContainText(HIGH_TEXT);
      await expect(actionsOf(page).getByRole('button', { name: THF.reset })).toBeVisible();
      await expect(main(page).getByRole('button', { name: THF.setAsBoard })).toHaveCount(0);
      await expect(main(page).getByRole('button', { name: THF.saveToBoard })).toHaveCount(0);
      await beat();

      const back = await resetToBoardFilter(page, bugsId);
      await expectBoardShows(page, back, MOBILE_CARDS);
      await expect(headerRow(page)).toContainText(LABEL_TEXT);
      await expect(actionsOf(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 8 · The default board has no board filter: the header filter starts empty and behaves as before',
    async () => {
      const board = await openBoard(page, s.defaultBoardId);
      expect(board.storedFilter).toBeNull();
      await expectBoardShows(page, board, ALL);
      await expect(headerRow(page)).toHaveCount(0);
      await expect(main(page).getByText(THF.chip, { exact: true })).toHaveCount(0);
      await expect(appliedRow(page)).toHaveCount(0);
      await beat();

      const narrowed = await addPriorityHigh(page, s.defaultBoardId, 0);
      await expectBoardShows(page, narrowed, ALL_HIGH);
      await expect(appliedRow(page)).toContainText(HIGH_TEXT);
      await expect(main(page).getByText(THF.chip, { exact: true })).toHaveCount(0);
      await expect(actionsOf(page)).toHaveCount(0);
      await expect(main(page).getByRole('button', { name: THF.reset })).toHaveCount(0);
      await beat();

      // Clear all is the whole board again, with no `boardFilter=off`: there is
      // no board filter to switch off.
      await page.getByRole('button', { name: /^Advanced/ }).click();
      const dialog = advancedDialog(page);
      const read = frameOf(page, s.defaultBoardId, false);
      await dialog.getByRole('button', { name: TIV.advancedClearAll }).click();
      const cleared = await frame(read);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expectCleanUrl(page);
      await expectBoardShows(page, cleared, ALL);
      await expect(appliedRow(page)).toHaveCount(0);
      await beat();
    },
  );
});
