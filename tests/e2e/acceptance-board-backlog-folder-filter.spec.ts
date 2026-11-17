// Acceptance E2E — filter the Board and the Backlog by folder (Story MOTIR-11666
// · MOTIR-11671). The story's verification recipe, walked end to end in a real
// browser against the SERVED app, and recorded as the story's acceptance video:
//
//   1. the board toolbar's Advanced filter offers Folder with its four
//      operators and a path-labelled picker; Folder is none of “Done” hides
//      Done and Done ▸ Oct 2026 and keeps unfiled work;
//   2. Folder is any of “To do” keeps To do, To do ▸ Oct 2026 and the story and
//      subtask under the epic filed in To do;
//   3. that filter survives a reload;
//   4. Folder is empty shows only unfiled work, is not empty only filed work;
//   5. a saved filter carrying Folder is any of “To do”, applied on the board,
//      narrows it and reopens Advanced with the Folder row filled;
//   6. the backlog's Advanced filter narrows the backlog list AND the active
//      sprint the same way;
//   7. on the backlog, is empty / is not empty, and a reload;
//   8. the saved filter applied on the backlog;
//   9. Settings › Board keeps Folder is none of “Done” as the board's stored
//      filter, and the board opens narrowed with the header row naming “Done”;
//  10. a board created from the board switcher with a Folder condition opens
//      already narrowed;
//  11. a folder that condition names is deleted: Settings › Board opens with no
//      error and names it “Unknown value”;
//  12. in a project with no folders, the Folder picker says so, as on /items.
//
// One test, one chapter per step. The database-level seams (every operator on
// every read, stale ids, the stored filter with no header filter) are the
// integration gate's, tests/integration/folders/boardBacklogFolderFilter.test.ts
// (MOTIR-11670); the truncated folder list is the page subtasks' component
// tests'. This walk does not re-assert them.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every write and every re-read arms `waitForResponse` before the action that
// sends it, and its status AND body are read before anything else happens. The
// board's sets are read off the projection the page fetches (`GET /api/board`,
// the `titlesOf` pattern); the backlog's off its two region reads
// (`GET /api/backlog` for the backlog list, `GET /api/sprints/:id/issues` for
// the sprint section). Each filtered expectation is the UNFILTERED read of the
// same surface narrowed by the seed's own folder membership, asserted non-empty
// and strictly smaller, so a read that ignored the condition fails. There is no
// sleep; the only holds are the recording's `chapter()` and `beat()` pacing,
// always taken after the state is proven.
//
// ── WHAT IS SEEDED AND WHAT IS DRIVEN ───────────────────────────────────────
// Seeded through the real services: the owner, the project, its folders and
// filing, the cards, the active sprint, the saved filter and a second project
// with no folders. Driven in the browser: every surface this story ships — the
// board toolbar's Advanced dialog, the backlog's Advanced dialog, the Settings ›
// Board editor and the New board dialog's Filter section. Two side effects
// belong to OTHER features and have no surface of this story's: deleting a
// folder (the folders story) and switching the active project. Both go through
// their shipped services, as the sibling acceptance spec does for its side
// effects.
//
// A toolbar filter is never combined with a board's stored filter: how the two
// compose is MOTIR-11564's, not this story's.
//
// ── THE STRINGS ─────────────────────────────────────────────────────────────
// Every label and sentence matched is read from `messages/en.json`, never
// retyped. Folder names are seed data.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made. CI is this spec's first run: the lane's `next build` does not
// run in the cloud thread that wrote it.

import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { createTestPerson } from './_helpers/testPerson';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { foldersService } from '@/lib/services/foldersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { boardsService } from '@/lib/services/boardsService';
import { encodeFilterEnvelope, encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { BoardDto, BoardProjectionDto, BoardSummaryDto } from '@/lib/dto/boards';
import type { WorkItemKind } from '@/generated/prisma/client';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 600_000 });

const PASSWORD = 'board-backlog-folder-filter-e2e-pass-4';
const ADA = { email: 'bbf-ada@example.com', name: 'Ada Admin' };

const PROJECT = { name: 'Field Notes', key: 'BBF' };
const EMPTY_PROJECT = { name: 'Blank Slate', key: 'BBE' };
const SPRINT = 'Sprint 7';
const SAVED_FILTER = 'To do work';
const NEW_BOARD = 'Up next';

const TB = en.boards;
const TS = en.settings.board.storedFilter;
const TIV = en.issueViews;
const APPLIED_BAR = `[aria-label="${en.savedFilters.applied.barAria}"]`;
const FOLDER = TIV.advancedFieldFolder;
const OPERATORS = [
  TIV.advancedOpIsAnyOf,
  TIV.advancedOpIsNoneOf,
  TIV.advancedOpIsEmpty,
  TIV.advancedOpIsNotEmpty,
];
/** A Folder condition as its chip reads it: the bold field, then the operator
 * and the folder paths — no space between the two elements' text (the sibling
 * acceptance spec's `sentence`). */
const sentence = (operator: string, values?: string) =>
  `${FOLDER}${operator}${values ? ` ${values}` : ''}`;

// ── The folders and the cards ───────────────────────────────────────────────
// Every step's narrowing must be visible in the data: a card in each of the
// four folders, an epic filed in "To do" with a story and a subtask that are
// filed only THROUGH it, unfiled cards, cards in every column, and an active
// sprint holding a Done card, two To do cards and an unfiled card while the
// rest stay in the backlog. Bugs are left out on purpose: a new bug is filed
// into the project's Bugs folder, which would blur "unfiled".

const DONE = 'Done';
const TODO = 'To do';
const OCT = 'Oct 2026';
const DONE_OCT = `${DONE} ▸ ${OCT}`;
const TODO_OCT = `${TODO} ▸ ${OCT}`;
type FolderKey = 'done' | 'doneOct' | 'todo' | 'todoOct';

interface CardSeed {
  title: string;
  kind: WorkItemKind;
  status: 'todo' | 'in_progress' | 'done';
  /** Filed directly into this folder; unset = unfiled, or filed through `parent`. */
  folder?: FolderKey;
  /** The title of the card this one sits under. */
  parent?: string;
  inSprint?: boolean;
}

const CARDS: CardSeed[] = [
  { title: 'Export to CSV', kind: 'task', status: 'done', folder: 'done', inSprint: true },
  { title: 'October release notes', kind: 'task', status: 'done', folder: 'doneOct' },
  { title: 'Pricing table', kind: 'task', status: 'todo', folder: 'todo', inSprint: true },
  {
    title: 'October onboarding email',
    kind: 'task',
    status: 'in_progress',
    folder: 'todoOct',
  },
  { title: 'Checkout', kind: 'epic', status: 'todo', folder: 'todo' },
  {
    title: 'Checkout page',
    kind: 'story',
    status: 'in_progress',
    parent: 'Checkout',
    inSprint: true,
  },
  { title: 'Card form validation', kind: 'subtask', status: 'todo', parent: 'Checkout page' },
  { title: 'Fix the footer links', kind: 'task', status: 'todo', inSprint: true },
  { title: 'Write the FAQ', kind: 'task', status: 'in_progress' },
];

/** The folder a card is EFFECTIVELY in: its own, else its nearest filed ancestor's. */
function effectiveFolder(card: CardSeed): FolderKey | null {
  if (card.folder) return card.folder;
  const parent = CARDS.find((c) => c.title === card.parent);
  return parent ? effectiveFolder(parent) : null;
}

const titles = (pick: (c: CardSeed) => boolean) =>
  CARDS.filter(pick)
    .map((c) => c.title)
    .sort();
const ALL = titles(() => true);
const IN_DONE = titles((c) => ['done', 'doneOct'].includes(effectiveFolder(c) ?? ''));
const IN_TODO = titles((c) => ['todo', 'todoOct'].includes(effectiveFolder(c) ?? ''));
const UNFILED = titles((c) => effectiveFolder(c) === null);

/** What each operator keeps, by the seed's membership. */
const KEEPS = {
  noneOfDone: (t: string) => !IN_DONE.includes(t),
  anyOfTodo: (t: string) => IN_TODO.includes(t),
  isEmpty: (t: string) => UNFILED.includes(t),
  isNotEmpty: (t: string) => !UNFILED.includes(t),
};

/** `all` narrowed by `keep` — asserted non-vacuous. */
function narrowed(all: string[], keep: (title: string) => boolean): string[] {
  const out = all.filter(keep);
  expect(out.length, 'the narrowed set is not empty').toBeGreaterThan(0);
  expect(out.length, 'the narrowed set is smaller than the whole').toBeLessThan(all.length);
  return out;
}

// ── Seed ────────────────────────────────────────────────────────────────────

interface Seed {
  projectId: string;
  emptyProjectId: string;
  workspaceId: string;
  adaId: string;
  sprintId: string;
  defaultBoardId: string;
  folders: Record<FolderKey, string>;
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

  const folder = (name: string, parentFolderId: string | null = null) =>
    foldersService.createFolder({ projectId: project.id, parentFolderId, name }, ctx);
  const done = await folder(DONE);
  const doneOct = await folder(OCT, done.id);
  const todo = await folder(TODO);
  const todoOct = await folder(OCT, todo.id);
  const folders: Record<FolderKey, string> = {
    done: done.id,
    doneOct: doneOct.id,
    todo: todo.id,
    todoOct: todoOct.id,
  };

  const sprint = await sprintsService.createSprint(project.id, { name: SPRINT }, ctx);
  const ids: Record<string, string> = {};
  for (const card of CARDS) {
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: card.kind,
        title: card.title,
        parentId: card.parent ? ids[card.parent] : null,
      },
      ctx,
    );
    ids[card.title] = item.id;
    if (card.folder)
      await foldersService.fileWorkItem(item.id, { folderId: folders[card.folder] }, ctx);
    // The columns group by status and the sprint section reads `sprintId`; the
    // write paths for both are other stories' (the board-filter.spec shortcut).
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { status: card.status, ...(card.inSprint ? { sprintId: sprint.id } : {}) },
    });
  }
  await sprintsService.startSprint(
    sprint.id,
    { endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
    ctx,
  );

  await savedFiltersService.create(
    project.identifier,
    { name: SAVED_FILTER, visibility: 'project', filterParam: encodeFilterParam(anyOf([todo.id])) },
    ctx,
  );

  // A second project with NO folders: the Bugs folder every new project is
  // given is deleted, as a person would.
  const empty = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: ada.id,
    name: EMPTY_PROJECT.name,
    identifier: EMPTY_PROJECT.key,
  });
  const emptyFolders = await foldersService.listProjectFolders({ projectId: empty.id }, ctx);
  for (const f of emptyFolders.folders) {
    if (f.parentFolderId === null) {
      await foldersService.deleteFolder({ projectId: empty.id, folderId: f.id }, ctx);
    }
  }
  expect(
    (await foldersService.listProjectFolders({ projectId: empty.id }, ctx)).folders,
  ).toHaveLength(0);

  // The walk starts in the folders project.
  await projectsService.setActiveProject({ ...ctx, projectId: project.id });

  const boards = await boardsService.listBoards(project.id, ctx);
  const defaultBoard = boards.find((b) => b.isDefault);
  if (!defaultBoard) throw new Error('a project should have a default board');

  return {
    projectId: project.id,
    emptyProjectId: empty.id,
    workspaceId: workspace.id,
    adaId: ada.id,
    sprintId: sprint.id,
    defaultBoardId: defaultBoard.id,
    folders,
  };
}

const anyOf = (ids: string[]): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'folder', operator: 'is_any_of', value: ids }],
});
const noneOf = (ids: string[]): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'folder', operator: 'is_none_of', value: ids }],
});

// ── Waits ───────────────────────────────────────────────────────────────────

/** The board projection the page fetches for `boardId`; `filtered` splits on
 *  whether the toolbar's `filter` param rides it. */
function frameOf(page: Page, boardId: string, filtered?: boolean): Promise<Response> {
  return page.waitForResponse((r) => {
    if (r.request().method() !== 'GET') return false;
    const u = new URL(r.url());
    if (u.pathname !== '/api/board' || u.searchParams.get('boardId') !== boardId) return false;
    return filtered === undefined || u.searchParams.has('filter') === filtered;
  });
}

/** Any board projection that names a board other than `except` — armed before
 *  a create, when the new board's id is not known yet. */
function selectedFrame(page: Page, except: string[]): Promise<Response> {
  return page.waitForResponse((r) => {
    if (r.request().method() !== 'GET') return false;
    const u = new URL(r.url());
    const id = u.searchParams.get('boardId');
    return u.pathname === '/api/board' && id !== null && !except.includes(id);
  });
}

/** One of the backlog page's two region reads: the backlog list
 *  (`/api/backlog`) or the active sprint's section. */
function regionRead(page: Page, path: string, filtered: boolean): Promise<Response> {
  return page.waitForResponse((r) => {
    if (r.request().method() !== 'GET') return false;
    const u = new URL(r.url());
    return (
      u.pathname === path &&
      !u.searchParams.has('cursor') &&
      u.searchParams.has('filter') === filtered
    );
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

const titlesOf = (board: BoardProjectionDto) =>
  board.columns.flatMap((c) => c.cards.map((card) => card.title)).sort();

/** A board projection's titles, after its status is proven. */
async function boardTitles(pending: Promise<Response>): Promise<string[]> {
  return titlesOf(await answered<BoardProjectionDto>(pending, 200));
}

interface RankedPage {
  items: { title: string }[];
}

/** Both backlog regions' titles, after each read's status is proven. */
async function regionTitles(
  pending: [Promise<Response>, Promise<Response>],
): Promise<{ backlog: string[]; sprint: string[] }> {
  const [b, s] = await Promise.all(pending.map((p) => answered<RankedPage>(p, 200)));
  return {
    backlog: b!.items.map((i) => i.title).sort(),
    sprint: s!.items.map((i) => i.title).sort(),
  };
}

// ── Locators ────────────────────────────────────────────────────────────────
// Scoped to the live subtree (the page's `main`, or the open dialog): a
// page-rooted test id can also match a streamed or outgoing copy.
const main = (page: Page) => page.getByRole('main');
const boardRegion = (page: Page) => main(page).getByTestId('board');
/** The board's applied-filter row: a toolbar filter's chips, or — on a board
 * with a stored filter — the header filter row (MOTIR-11565). */
const boardFilterRow = (page: Page) => main(page).getByTestId('board-filter-row');
const headerFilter = (page: Page) => main(page).getByTestId('board-header-filter');
const backlogBar = (page: Page) => main(page).locator(APPLIED_BAR);
const advancedDialog = (page: Page) => page.getByRole('dialog', { name: TIV.advancedDialogLabel });
const newBoardDialog = (page: Page) => page.getByRole('dialog', { name: TB.newBoardTitle });
const editorOf = (page: Page) => main(page).getByTestId('board-stored-filter-editor');
const backlogList = (page: Page) => main(page).getByRole('list', { name: 'Backlog work items' });
const sprintList = (page: Page) => main(page).getByRole('list', { name: `${SPRINT} work items` });

// ── Actions ─────────────────────────────────────────────────────────────────

/** Open `/boards` on `boardId` and return its first projection's titles. */
async function openBoard(page: Page, boardId: string, path = `/boards?board=${boardId}`) {
  const read = frameOf(page, boardId);
  await page.goto(path);
  const got = await boardTitles(read);
  await expect(
    boardRegion(page).or(main(page).getByTestId('board-filtered-empty')).first(),
  ).toBeVisible();
  return got;
}

/** Open `/backlog` and return both regions' first reads. */
async function openBacklog(page: Page, sprintId: string, filtered = false) {
  const reads: [Promise<Response>, Promise<Response>] = [
    regionRead(page, '/api/backlog', filtered),
    regionRead(page, `/api/sprints/${sprintId}/issues`, filtered),
  ];
  await page.goto('/backlog');
  return regionTitles(reads);
}

async function openAdvanced(page: Page): Promise<Locator> {
  await main(page)
    .getByRole('button', { name: /^Advanced/ })
    .click();
  const dialog = advancedDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeAdvanced(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(advancedDialog(page)).toBeHidden();
}

/** Add a condition to a builder and point it at Folder; returns the row. */
async function addFolderRow(page: Page, scope: Locator, n = 1): Promise<Locator> {
  await scope.getByRole('button', { name: TIV.advancedAddCondition }).click();
  const row = scope.getByRole('group', { name: `Condition ${n}` });
  await row.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: FOLDER, exact: true }).click();
  await expect(row).toContainText(TIV.advancedFolderIncludesInside);
  return row;
}

async function setOperator(page: Page, row: Locator, operator: string): Promise<void> {
  await row.getByRole('combobox', { name: 'Operator' }).click();
  await page.getByRole('option', { name: operator, exact: true }).click();
}

/** Open a Folder row's picker. */
async function openFolderValues(row: Locator): Promise<void> {
  await row.getByRole('combobox', { name: `${FOLDER} values` }).click();
}

/** Pick one folder in an open picker by its path, then close the list with a
 *  click on the row's own padding. Not Escape: inside a dialog the key reaches
 *  the dialog and closes it with the list. */
async function pickFolder(page: Page, row: Locator, path: string): Promise<void> {
  const option = page.getByRole('option', { name: path, exact: true });
  await option.click();
  if (await option.isVisible()) await row.click({ position: { x: 4, y: 4 } });
  await expect(option).toBeHidden();
}

/** The operator list offers exactly Folder's four operators. */
async function expectFolderOperators(page: Page, row: Locator): Promise<void> {
  await row.getByRole('combobox', { name: 'Operator' }).click();
  const options = page.getByRole('option');
  await expect(options).toHaveText(OPERATORS);
  await page.getByRole('option', { name: TIV.advancedOpIsAnyOf, exact: true }).click();
  await expect(options).toHaveCount(0);
}

/** Apply the seeded saved filter from the toolbar's Saved picker. */
async function applySavedFilter(page: Page): Promise<void> {
  await main(page)
    .getByRole('button', { name: /^Saved filters/ })
    .click();
  await page.getByRole('button', { name: new RegExp(`^${SAVED_FILTER}`) }).click();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('The Board, the Backlog and a board’s stored filter narrow by folder — sub-folders and a filed epic’s work included: the recipe, steps 1 to 12', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11666');
  const s = await seed();
  const boardId = s.defaultBoardId;
  let wholeBoard: string[] = [];
  let wholeBacklog = { backlog: [] as string[], sprint: [] as string[] };
  let newBoardId = '';

  await chapter(
    'Step 1 · On the board, Advanced offers Folder; Folder is none of “Done” hides Done and Done ▸ Oct 2026 and keeps unfiled work',
    async () => {
      await signIn(page, ADA.email, PASSWORD);
      wholeBoard = await openBoard(page, boardId);
      expect(wholeBoard).toEqual(ALL);

      const dialog = await openAdvanced(page);
      const row = await addFolderRow(page, dialog);
      await expectFolderOperators(page, row);
      await setOperator(page, row, TIV.advancedOpIsNoneOf);
      await openFolderValues(row);
      for (const path of [DONE, DONE_OCT, TODO, TODO_OCT]) {
        await expect(page.getByRole('option', { name: path, exact: true })).toBeVisible();
      }
      await beat();

      const read = frameOf(page, boardId, true);
      await pickFolder(page, row, DONE);
      const got = await boardTitles(read);
      expect(got).toEqual(narrowed(wholeBoard, KEEPS.noneOfDone));
      for (const title of UNFILED) expect(got).toContain(title);
      await closeAdvanced(page);

      await expect(boardFilterRow(page)).toContainText(sentence(TIV.advancedOpIsNoneOf, DONE));
      await expect(boardFilterRow(page)).not.toContainText(s.folders.done);
      for (const title of IN_DONE) await expect(boardRegion(page).getByText(title)).toHaveCount(0);
      await expect(boardRegion(page).getByText('Write the FAQ')).toBeVisible();
      await beat();
    },
  );

  await chapter(
    'Step 2 · Folder is any of “To do” keeps To do, To do ▸ Oct 2026, and the story and subtask under the epic filed in To do',
    async () => {
      const dialog = await openAdvanced(page);
      let read = frameOf(page, boardId, false);
      await dialog.getByRole('button', { name: TIV.advancedClearAll }).click();
      expect(await boardTitles(read)).toEqual(wholeBoard);

      const row = await addFolderRow(page, dialog);
      await openFolderValues(row);
      read = frameOf(page, boardId, true);
      await pickFolder(page, row, TODO);
      const got = await boardTitles(read);
      expect(got).toEqual(narrowed(wholeBoard, KEEPS.anyOfTodo));
      for (const title of ['October onboarding email', 'Checkout page', 'Card form validation']) {
        expect(got).toContain(title);
      }
      await closeAdvanced(page);

      await expect(boardFilterRow(page)).toContainText(sentence(TIV.advancedOpIsAnyOf, TODO));
      await expect(boardRegion(page).getByText('Card form validation')).toBeVisible();
      await expect(boardRegion(page).getByText('Write the FAQ')).toHaveCount(0);
      await expect(boardRegion(page).getByText('Export to CSV')).toHaveCount(0);
      await beat();
    },
  );

  await chapter('Step 3 · The To do filter survives a reload', async () => {
    const read = frameOf(page, boardId, true);
    await page.reload();
    expect(await boardTitles(read)).toEqual(narrowed(wholeBoard, KEEPS.anyOfTodo));
    await expect(boardFilterRow(page)).toContainText(sentence(TIV.advancedOpIsAnyOf, TODO));
    await expect(boardRegion(page).getByText('Checkout page')).toBeVisible();
    await beat();
  });

  await chapter(
    'Step 4 · Folder is empty shows only unfiled work; is not empty only filed work',
    async () => {
      const dialog = await openAdvanced(page);
      let read = frameOf(page, boardId, false);
      await dialog.getByRole('button', { name: TIV.advancedClearAll }).click();
      await boardTitles(read);

      const row = await addFolderRow(page, dialog);
      read = frameOf(page, boardId, true);
      await setOperator(page, row, TIV.advancedOpIsEmpty);
      const empty = await boardTitles(read);
      expect(empty).toEqual(narrowed(wholeBoard, KEEPS.isEmpty));
      await beat();

      read = frameOf(page, boardId, true);
      await setOperator(page, row, TIV.advancedOpIsNotEmpty);
      const notEmpty = await boardTitles(read);
      expect(notEmpty).toEqual(narrowed(wholeBoard, KEEPS.isNotEmpty));
      expect(empty.filter((t) => notEmpty.includes(t))).toEqual([]);
      expect([...empty, ...notEmpty].sort()).toEqual(wholeBoard);
      await closeAdvanced(page);

      await expect(boardFilterRow(page)).toContainText(sentence(TIV.advancedOpIsNotEmpty));
      await expect(boardRegion(page).getByText('Card form validation')).toBeVisible();
      await expect(boardRegion(page).getByText('Write the FAQ')).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    `Step 5 · The saved filter “${SAVED_FILTER}” (Folder is any of “To do”) narrows the board and reopens Advanced with its Folder row filled`,
    async () => {
      await openBoard(page, boardId);
      const read = frameOf(page, boardId, true);
      await applySavedFilter(page);
      expect(await boardTitles(read)).toEqual(narrowed(wholeBoard, KEEPS.anyOfTodo));
      await expect(boardFilterRow(page)).toContainText(SAVED_FILTER);
      await expect(boardFilterRow(page)).toContainText(sentence(TIV.advancedOpIsAnyOf, TODO));

      const dialog = await openAdvanced(page);
      const row = dialog.getByRole('group', { name: 'Condition 1' });
      await expect(row.getByRole('combobox', { name: 'Field' })).toContainText(FOLDER);
      await expect(row).toContainText(TODO);
      await expect(row).not.toContainText(s.folders.todo);
      await beat();
      await closeAdvanced(page);
    },
  );

  await chapter(
    'Step 6 · On the backlog, Folder is none of “Done”, then is any of “To do”, narrow the backlog list and the active sprint alike',
    async () => {
      const whole = await openBacklog(page, s.sprintId);
      wholeBacklog = whole;
      // The sprint holds a card from each group; the rest are in the backlog.
      expect(whole.sprint).toEqual(titles((c) => !!c.inSprint));
      await expect(backlogList(page).getByText('October release notes')).toBeVisible();
      await expect(sprintList(page).getByText('Export to CSV')).toBeVisible();

      const dialog = await openAdvanced(page);
      const row = await addFolderRow(page, dialog);
      await expectFolderOperators(page, row);
      await setOperator(page, row, TIV.advancedOpIsNoneOf);
      await openFolderValues(row);
      let reads: [Promise<Response>, Promise<Response>] = [
        regionRead(page, '/api/backlog', true),
        regionRead(page, `/api/sprints/${s.sprintId}/issues`, true),
      ];
      await pickFolder(page, row, DONE);
      let got = await regionTitles(reads);
      expect(got.backlog).toEqual(narrowed(whole.backlog, KEEPS.noneOfDone));
      expect(got.sprint).toEqual(narrowed(whole.sprint, KEEPS.noneOfDone));
      await closeAdvanced(page);
      await expect(backlogBar(page)).toContainText(sentence(TIV.advancedOpIsNoneOf, DONE));
      await expect(backlogList(page).getByText('October release notes')).toHaveCount(0);
      await expect(sprintList(page).getByText('Export to CSV')).toHaveCount(0);
      await expect(sprintList(page).getByText('Fix the footer links')).toBeVisible();
      await beat();

      const again = await openAdvanced(page);
      reads = [
        regionRead(page, '/api/backlog', false),
        regionRead(page, `/api/sprints/${s.sprintId}/issues`, false),
      ];
      await again.getByRole('button', { name: TIV.advancedClearAll }).click();
      await regionTitles(reads);
      const todoRow = await addFolderRow(page, again);
      await openFolderValues(todoRow);
      reads = [
        regionRead(page, '/api/backlog', true),
        regionRead(page, `/api/sprints/${s.sprintId}/issues`, true),
      ];
      await pickFolder(page, todoRow, TODO);
      got = await regionTitles(reads);
      expect(got.backlog).toEqual(narrowed(whole.backlog, KEEPS.anyOfTodo));
      expect(got.sprint).toEqual(narrowed(whole.sprint, KEEPS.anyOfTodo));
      await closeAdvanced(page);
      await expect(backlogBar(page)).toContainText(sentence(TIV.advancedOpIsAnyOf, TODO));
      await expect(sprintList(page).getByText('Checkout page')).toBeVisible();
      await expect(sprintList(page).getByText('Fix the footer links')).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 7 · On the backlog, the To do filter survives a reload; is empty shows only unfiled work, is not empty only filed work',
    async () => {
      const whole = wholeBacklog;
      let reads: [Promise<Response>, Promise<Response>] = [
        regionRead(page, '/api/backlog', true),
        regionRead(page, `/api/sprints/${s.sprintId}/issues`, true),
      ];
      await page.reload();
      let got = await regionTitles(reads);
      expect(got.backlog).toEqual(narrowed(whole.backlog, KEEPS.anyOfTodo));
      expect(got.sprint).toEqual(narrowed(whole.sprint, KEEPS.anyOfTodo));
      await expect(backlogBar(page)).toContainText(sentence(TIV.advancedOpIsAnyOf, TODO));
      await beat();

      const dialog = await openAdvanced(page);
      const row = dialog.getByRole('group', { name: 'Condition 1' });
      reads = [
        regionRead(page, '/api/backlog', true),
        regionRead(page, `/api/sprints/${s.sprintId}/issues`, true),
      ];
      await setOperator(page, row, TIV.advancedOpIsEmpty);
      const empty = await regionTitles(reads);
      expect(empty.backlog).toEqual(narrowed(whole.backlog, KEEPS.isEmpty));
      expect(empty.sprint).toEqual(narrowed(whole.sprint, KEEPS.isEmpty));
      await beat();

      reads = [
        regionRead(page, '/api/backlog', true),
        regionRead(page, `/api/sprints/${s.sprintId}/issues`, true),
      ];
      await setOperator(page, row, TIV.advancedOpIsNotEmpty);
      got = await regionTitles(reads);
      expect(got.backlog).toEqual(narrowed(whole.backlog, KEEPS.isNotEmpty));
      expect(got.sprint).toEqual(narrowed(whole.sprint, KEEPS.isNotEmpty));
      expect([...empty.backlog, ...got.backlog].sort()).toEqual(whole.backlog);
      await closeAdvanced(page);
      await expect(backlogBar(page)).toContainText(sentence(TIV.advancedOpIsNotEmpty));
      await expect(backlogList(page).getByText('Write the FAQ')).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    `Step 8 · The saved filter “${SAVED_FILTER}” narrows the backlog and reopens Advanced with its Folder row filled`,
    async () => {
      const whole = await openBacklog(page, s.sprintId);
      const reads: [Promise<Response>, Promise<Response>] = [
        regionRead(page, '/api/backlog', true),
        regionRead(page, `/api/sprints/${s.sprintId}/issues`, true),
      ];
      await applySavedFilter(page);
      const got = await regionTitles(reads);
      expect(got.backlog).toEqual(narrowed(whole.backlog, KEEPS.anyOfTodo));
      expect(got.sprint).toEqual(narrowed(whole.sprint, KEEPS.anyOfTodo));
      await expect(backlogBar(page)).toContainText(SAVED_FILTER);
      await expect(backlogBar(page)).toContainText(sentence(TIV.advancedOpIsAnyOf, TODO));

      const dialog = await openAdvanced(page);
      const row = dialog.getByRole('group', { name: 'Condition 1' });
      await expect(row.getByRole('combobox', { name: 'Field' })).toContainText(FOLDER);
      await expect(row).toContainText(TODO);
      await beat();
      await closeAdvanced(page);
    },
  );

  await chapter(
    'Step 9 · In Settings › Board, Folder is none of “Done” becomes the board’s stored filter, and the board opens without Done’s work',
    async () => {
      await page.goto(`/settings/project/board?board=${boardId}`);
      const editor = editorOf(page);
      await expect(editor).toBeVisible();
      await editor.getByTestId('board-stored-filter-add').click();
      const row = await addFolderRow(page, editor);
      await expectFolderOperators(page, row);
      await setOperator(page, row, TIV.advancedOpIsNoneOf);
      await openFolderValues(row);
      await pickFolder(page, row, DONE);
      await expect(editor.getByTestId('board-stored-filter-unsaved')).toBeVisible();
      await beat();

      const write = respondsTo(page, `/api/boards/${boardId}`, 'PATCH');
      await editor.getByTestId('board-stored-filter-save').click();
      const saved = await answered<BoardDto>(write, 200);
      expect(saved.filter).toEqual(encodeFilterEnvelope(noneOf([s.folders.done])));
      await expect(editor.getByTestId('board-stored-filter-announce')).toHaveText(TS.savedAnnounce);

      // No toolbar filter: the board's own filter is the only one applied.
      const got = await openBoard(page, boardId);
      expect(got).toEqual(narrowed(wholeBoard, KEEPS.noneOfDone));
      await expect(headerFilter(page)).toContainText(TB.headerFilter.chip);
      await expect(headerFilter(page)).toContainText(sentence(TIV.advancedOpIsNoneOf, DONE));
      await expect(boardRegion(page).getByText('Export to CSV')).toHaveCount(0);
      await expect(boardRegion(page).getByText('Write the FAQ')).toBeVisible();
      await beat();
    },
  );

  await chapter(
    `Step 10 · A board “${NEW_BOARD}” created from the board switcher with a Folder condition opens already narrowed`,
    async () => {
      await main(page).getByTestId('board-switcher-trigger').click();
      await page.getByRole('menuitem', { name: TB.newBoard }).click();
      const dialog = newBoardDialog(page);
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('board-new-name').fill(NEW_BOARD);
      const section = dialog.getByTestId('board-filter-section');
      await section.getByTestId('board-filter-add').click();
      const row = await addFolderRow(page, section);
      await openFolderValues(row);
      // Both To do and its October folder, so the board's filter names the
      // folder step 11 deletes; the cards kept are To do's either way.
      await pickFolder(page, row, TODO);
      await openFolderValues(row);
      await pickFolder(page, row, TODO_OCT);
      await expect(dialog).toBeVisible();
      await beat();

      const write = respondsTo(page, '/api/boards', 'POST');
      const read = selectedFrame(page, [boardId]);
      await dialog.getByRole('button', { name: TB.createBoard, exact: true }).click();
      const res = await write;
      const sent = res.request().postDataJSON() as Record<string, unknown>;
      const created = await answered<BoardSummaryDto>(Promise.resolve(res), 201);
      newBoardId = created.id;
      expect(sent).toMatchObject({ name: NEW_BOARD });
      expect(sent.filter).toEqual(encodeFilterEnvelope(anyOf([s.folders.todo, s.folders.todoOct])));
      await expect(dialog).toBeHidden();
      const board = await answered<BoardProjectionDto>(read, 200);
      expect(board.boardId).toBe(newBoardId);
      expect(titlesOf(board)).toEqual(narrowed(wholeBoard, KEEPS.anyOfTodo));
      await expect(headerFilter(page)).toContainText(sentence(TIV.advancedOpIsAnyOf, TODO));
      await expect(headerFilter(page)).toContainText(TODO_OCT);
      await beat();
    },
  );

  await chapter(
    `Step 11 · “${TODO_OCT}” is deleted: the board’s stored filter opens in Settings › Board with no error and names it “${TIV.advancedStaleValue}”`,
    async () => {
      // Deleting a folder is the folders story's; it moves the folder's work
      // up into "To do".
      await foldersService.deleteFolder(
        { projectId: s.projectId, folderId: s.folders.todoOct },
        { userId: s.adaId, workspaceId: s.workspaceId },
      );

      await page.goto(`/settings/project/board?board=${newBoardId}`);
      const editor = editorOf(page);
      await expect(editor).toBeVisible();
      const row = editor.getByRole('group', { name: 'Condition 1' });
      await expect(row).toContainText(TODO);
      await expect(row).toContainText(TIV.advancedStaleValue);
      await expect(row).not.toContainText(s.folders.todoOct);
      await expect(editor.getByTestId('board-filter-refusal')).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    `Step 12 · In “${EMPTY_PROJECT.name}”, a project with no folders, the Folder picker says so, as on /items`,
    async () => {
      // Switching the active project is the project switcher's; the service is
      // the same write.
      await projectsService.setActiveProject({
        userId: s.adaId,
        workspaceId: s.workspaceId,
        projectId: s.emptyProjectId,
      });
      const emptyBoards = await boardsService.listBoards(s.emptyProjectId, {
        userId: s.adaId,
        workspaceId: s.workspaceId,
      });
      const emptyBoardId = emptyBoards.find((b) => b.isDefault)!.id;
      const read = frameOf(page, emptyBoardId);
      await page.goto(`/boards?board=${emptyBoardId}`);
      expect(await boardTitles(read)).toEqual([]);

      const dialog = await openAdvanced(page);
      const row = await addFolderRow(page, dialog);
      await openFolderValues(row);
      await expect(
        page.getByRole('listbox', { name: `${FOLDER} values` }).getByText(TIV.advancedFolderNone),
      ).toBeVisible();
      await beat();
      await page.keyboard.press('Escape');
    },
  );
});
