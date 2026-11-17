// Acceptance E2E — boards keep their own stored filter (Story MOTIR-10560 ·
// MOTIR-11337). The story's verification recipe, walked end to end in a real
// browser against the SERVED app, and recorded as the story's acceptance video:
//
//   1. an admin creates the kanban board "Bugs" from the board switcher's New
//      board dialog, building Kind is Bug in the dialog's Board filter section;
//   2. the project's default board still shows every card;
//   3. a teammate who did not create "Bugs" sees the same bugs, with the board
//      filter as the header filter (MOTIR-11565 retired the indicator);
//   4. the teammate adds Assignee is the teammate to it in Advanced;
//   5. Clear all shows the whole board, and Reset to board filter returns to
//      every bug;
//   6. a scrum board "Mobile sprint" started from a saved filter (Label is
//      mobile) shows only the mobile cards of the active sprint;
//   7. that saved filter is edited, then deleted, and the board keeps its copy;
//   8. board settings change "Bugs" to Kind is Bug AND Priority is High;
//   9. a condition the builder would never send is refused with a 422;
//  10. the label "mobile" leaves its last card and is deleted: "Mobile sprint"
//      still loads, matches nothing (the filtered-empty state), and its
//      settings name the stale condition;
//  11. an outsider reads the public project as a Visitor and sees "Bugs"
//      through its stored filter;
//  12. clearing the filter in settings shows every card again.
//
// One test, one chapter per step. The database-level seams (the AND
// composition with `or` on either side, the admin gate, tenant scope) are the
// integration gate's (`tests/boards/stored-filter-*.test.ts`); this walk does
// not re-assert them.
//
// ── THE ACTORS ──────────────────────────────────────────────────────────────
// Ada (workspace owner, board admin), Tess (a workspace member added to the
// project, who creates nothing) and Olive (an outsider with her own workspace,
// who reads the public project as a Visitor). Seeded through the real services.
// Every actor signs in on the ONE recorded page, as
// `acceptance-pages-comment-notifications.spec.ts` does: the lane publishes one
// video per test, so a second browser context would be missing from the receipt.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every write arms `waitForResponse` before the click that sends it, and its
// status AND body are read before anything else happens. Every content
// assertion reads the board projection the page fetches (`GET /api/board`,
// the `titlesOf` pattern of `board-filter.spec.ts`), never the optimistic DOM.
// There is no sleep; the only holds are the recording's `chapter()` and
// `beat()` pacing, always taken after the state is proven.
//
// ── WHAT IS SEEDED AND WHAT IS DRIVEN ───────────────────────────────────────
// Seeded: the actors, the project, its cards, labels, sprint and the saved
// filter. Driven in the browser: every surface this story ships (the dialog's
// section, the board and its indicator, the toolbar filter on top, the settings
// editor). Two side effects belong to OTHER features and have no surface of
// this story's: editing and deleting the saved filter, and removing the label
// from its cards. Those go through their shipped HTTP routes from the signed-in
// page (`page.request`, the actor's own session), not through a service call,
// so each one is the same request the product's own controls send.
//
// ── THE INVALID CONDITION ───────────────────────────────────────────────────
// The shared builder never sends a condition it can tell is invalid: a row whose
// value fails validation stays pending (its "Not applied yet" note) and is left
// out of the write. So step 9 shows that note first, then makes the same
// condition reach the server the only way it can, as a client the builder does
// not guard would send it: the editor saves a valid day count and the request
// is rewritten on the wire (`page.route`) to carry the invalid one. The 422 is
// the server's real answer, and the refusal the editor renders is its real
// rendering of it.
//
// ── THE STRINGS ─────────────────────────────────────────────────────────────
// Every label and sentence matched is read from `messages/en.json`, never
// retyped.
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
import { labelsService } from '@/lib/services/labelsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { boardsService } from '@/lib/services/boardsService';
import {
  encodeFilterEnvelope,
  encodeFilterParam,
  type FilterAst,
  type FilterEnvelope,
} from '@/lib/filters/ast';
import type { BoardDto, BoardProjectionDto, BoardSummaryDto } from '@/lib/dto/boards';
import type { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import { projectAccessData } from '../helpers/projectAccess';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 600_000 });

const PASSWORD = 'board-stored-filter-e2e-pass-7';
const ADA = { email: 'bsf-ada@example.com', name: 'Ada Admin' };
const TESS = { email: 'bsf-tess@example.com', name: 'Tess Teammate' };
const OLIVE = { email: 'bsf-olive@example.com', name: 'Olive Outsider' };
type Actor = typeof ADA;

const PROJECT = { name: 'Field App', key: 'BSF' };
const BUGS_BOARD = 'Bugs';
const MOBILE_BOARD = 'Mobile sprint';
const SAVED_FILTER = 'Mobile work';
const MOBILE = 'mobile';

const TB = en.boards;
const TS = en.settings.board.storedFilter;
const TIV = en.issueViews;
const APPLIED_BAR = `[aria-label="${en.savedFilters.applied.barAria}"]`;
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));
/** A `{count, plural, one {…} other {…}}` message at a count of one, in English. */
const one = (template: string) =>
  template.replace(/\{count, plural, one \{([^}]*)\} other \{[^}]*\}\}/, (_, branch: string) =>
    branch.replace('#', '1'),
  );
/** A condition as its chip on the board's header filter row reads it
 * (MOTIR-11565): the bold field, then the operator and values — no space
 * between the two elements' text. */
const sentence = (field: string, values: string) => `${field}${TIV.advancedOpIsAnyOf} ${values}`;
const BUG = en.labels.issueType.bug;
const HIGH = en.labels.priority.high;
const KIND_BUG_TEXT = sentence(TIV.filterKind, BUG);
const HIGH_TEXT = sentence(TIV.advancedFieldPriority, HIGH);
const LABEL_TEXT = sentence(TIV.advancedFieldLabel, 'mobile');

// ── The cards ───────────────────────────────────────────────────────────────
// Each step's narrowing must be visible in the data: bugs assigned to Tess AND
// to Ada (Assignee narrows), high and non-high bugs (Priority narrows), non-bugs
// in the same columns as the bugs (a widened read would show), and mobile cards
// both inside and outside the active sprint (the sprint scope narrows).

interface CardSeed {
  title: string;
  kind: WorkItemKind;
  status: 'todo' | 'in_progress' | 'done';
  priority: WorkItemPriority;
  assignee?: 'ada' | 'tess';
  points?: number;
  inSprint?: boolean;
  mobile?: boolean;
}

const CARDS: CardSeed[] = [
  {
    title: 'Login fails on Safari',
    kind: 'bug',
    status: 'todo',
    priority: 'high',
    assignee: 'tess',
  },
  {
    title: 'Export crashes on an empty sheet',
    kind: 'bug',
    status: 'in_progress',
    priority: 'medium',
    assignee: 'ada',
  },
  { title: 'Typo in the footer', kind: 'bug', status: 'done', priority: 'low', assignee: 'tess' },
  {
    title: 'Upload times out over 2 GB',
    kind: 'bug',
    status: 'todo',
    priority: 'high',
    assignee: 'ada',
  },
  { title: 'Write the release notes', kind: 'task', status: 'todo', priority: 'medium' },
  { title: 'Onboarding checklist', kind: 'story', status: 'in_progress', priority: 'medium' },
  { title: 'Tidy the stylesheet', kind: 'task', status: 'done', priority: 'low' },
  {
    title: 'Mobile navigation drawer',
    kind: 'story',
    status: 'todo',
    priority: 'medium',
    points: 3,
    inSprint: true,
    mobile: true,
  },
  {
    title: 'Mobile push settings',
    kind: 'task',
    status: 'in_progress',
    priority: 'medium',
    points: 5,
    inSprint: true,
    mobile: true,
  },
  {
    title: 'Mobile offline mode',
    kind: 'story',
    status: 'todo',
    priority: 'medium',
    points: 8,
    mobile: true,
  },
  {
    title: 'Desktop keyboard shortcuts',
    kind: 'story',
    status: 'todo',
    priority: 'medium',
    points: 2,
    inSprint: true,
  },
];

const titles = (pick: (c: CardSeed) => boolean) =>
  CARDS.filter(pick)
    .map((c) => c.title)
    .sort();
const ALL = titles(() => true);
const BUGS = titles((c) => c.kind === 'bug');
const TESS_BUGS = titles((c) => c.kind === 'bug' && c.assignee === 'tess');
const HIGH_BUGS = titles((c) => c.kind === 'bug' && c.priority === 'high');
const MOBILE_IN_SPRINT = titles((c) => !!c.mobile && !!c.inSprint);
const MOBILE_SPRINT_POINTS = CARDS.filter((c) => c.mobile && c.inSprint).reduce(
  (sum, c) => sum + (c.points ?? 0),
  0,
);

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
const labelIs = (labelId: string): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'lbl', operator: 'is_any_of', value: [labelId] }],
});

// ── Seed ────────────────────────────────────────────────────────────────────

interface Seed {
  ids: Record<string, string>;
  projectId: string;
  defaultBoardId: string;
  labelId: string;
  savedFilterId: string;
  /** Card id by title. */
  cards: Record<string, string>;
  mobileCardIds: string[];
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

  // Tess: a member of the workspace and the project, who creates nothing.
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

  // The project is public, so an outsider can read it as a Visitor. Olive has
  // her own workspace and project, so signing in lands her on her own Workbench.
  await adminDb.project.update({ where: { id: project.id }, data: projectAccessData('public') });
  const olive = await createTestPerson({ ...OLIVE, password: PASSWORD });
  const own = await workspacesService.createWorkspace({
    name: 'Olive Studio',
    ownerUserId: olive.id,
  });
  const ownProject = await projectsService.createProject({
    workspaceId: own.workspace.id,
    actorUserId: olive.id,
    name: 'Sketches',
    identifier: 'SKT',
  });
  await projectsService.setActiveProject({
    userId: olive.id,
    workspaceId: own.workspace.id,
    projectId: ownProject.id,
  });

  const sprint = await sprintsService.createSprint(
    project.id,
    { name: 'Sprint 12', goal: 'Mobile beta' },
    ctx,
  );
  const assignees = { ada: ada.id, tess: tess.id };
  const cards: Record<string, string> = {};
  const mobileCardIds: string[] = [];
  let labelId = '';
  for (const card of CARDS) {
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: card.kind,
        title: card.title,
        priority: card.priority,
        ...(card.assignee ? { assigneeId: assignees[card.assignee] } : {}),
        ...(card.points !== undefined ? { storyPoints: card.points } : {}),
      },
      ctx,
    );
    // The columns group by status and the sprint scope reads `sprintId`; the
    // write paths for both are other stories' (the board-filter.spec shortcut).
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { status: card.status, ...(card.inSprint ? { sprintId: sprint.id } : {}) },
    });
    if (card.mobile) {
      const labels = await labelsService.addLabel(item.id, MOBILE, ctx);
      labelId = labels.find((l) => l.name === MOBILE)!.id;
      mobileCardIds.push(item.id);
    }
    cards[card.title] = item.id;
  }
  // Started through the shipped lifecycle, so the sprint is ACTIVE and its
  // committed baseline is stamped.
  await sprintsService.startSprint(
    sprint.id,
    { endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
    ctx,
  );

  const saved = await savedFiltersService.create(
    project.identifier,
    { name: SAVED_FILTER, visibility: 'project', filterParam: encodeFilterParam(labelIs(labelId)) },
    ctx,
  );

  const boards = await boardsService.listBoards(project.id, ctx);
  const defaultBoard = boards.find((b) => b.isDefault);
  if (!defaultBoard) throw new Error('a project should have a default board');

  return {
    ids: { [ADA.email]: ada.id, [TESS.email]: tess.id, [OLIVE.email]: olive.id },
    projectId: project.id,
    defaultBoardId: defaultBoard.id,
    labelId,
    savedFilterId: saved.id,
    cards,
    mobileCardIds,
  };
}

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

/** Any board projection that names a board — armed before a create, when the
 *  new board's id is not known yet (the only such read after it is the new one). */
function selectedFrame(page: Page, except: string[]): Promise<Response> {
  return page.waitForResponse((r) => {
    if (r.request().method() !== 'GET') return false;
    const u = new URL(r.url());
    const id = u.searchParams.get('boardId');
    return u.pathname === '/api/board' && id !== null && !except.includes(id);
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

/** The board's header filter row (MOTIR-11565), which replaced the stored-filter
 * indicator: the Board filter chip and the board's own conditions. */
const indicator = (page: Page) => main(page).getByTestId('board-header-filter');
const boardRegion = (page: Page) => main(page).getByTestId('board');
const dialogOf = (page: Page) => page.getByRole('dialog', { name: TB.newBoardTitle });
const editorOf = (page: Page) => main(page).getByTestId('board-stored-filter-editor');
const advancedDialog = (page: Page) => page.getByRole('dialog', { name: TIV.advancedDialogLabel });

// ── Actions ─────────────────────────────────────────────────────────────────

/** Sign `actor` in on the recorded page. */
async function as(page: Page, actor: Actor): Promise<void> {
  await signIn(page, actor.email, PASSWORD);
}

/** Open `/boards` on `boardId` and return its first projection. */
async function openBoard(page: Page, boardId: string): Promise<BoardProjectionDto> {
  const read = frameOf(page, boardId);
  await page.goto(`/boards?board=${boardId}`);
  const board = await frame(read);
  await expect(
    boardRegion(page).or(main(page).getByTestId('board-filtered-empty')).first(),
  ).toBeVisible();
  return board;
}

/** Open the board switcher's New board dialog and name the board. */
async function startNewBoard(page: Page, name: string): Promise<void> {
  await main(page).getByTestId('board-switcher-trigger').click();
  await page.getByRole('menuitem', { name: TB.newBoard }).click();
  await expect(dialogOf(page)).toBeVisible();
  await dialogOf(page).getByTestId('board-new-name').fill(name);
}

/** Create the board in the open dialog, and return the write's request body,
 *  its answer, and the new board's first projection. */
async function createBoard(
  page: Page,
  except: string[],
): Promise<{ sent: Record<string, unknown>; created: BoardSummaryDto; board: BoardProjectionDto }> {
  const write = respondsTo(page, '/api/boards', 'POST');
  const read = selectedFrame(page, except);
  await dialogOf(page).getByRole('button', { name: TB.createBoard, exact: true }).click();
  const res = await write;
  const sent = res.request().postDataJSON() as Record<string, unknown>;
  const created = await answered<BoardSummaryDto>(Promise.resolve(res), 201);
  await expect(dialogOf(page)).toBeHidden();
  const board = await frame(read);
  expect(board.boardId).toBe(created.id);
  return { sent, created, board };
}

/** Pick one value of a builder row's multi-select, then close its list with a
 *  click on the row's own padding. Not Escape: inside the New board dialog the
 *  key reaches the dialog and closes it with the list. */
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

/** Every column holds only bugs, and each column's count is its cards. */
function expectOnlyBugsByColumn(board: BoardProjectionDto, expected: string[]): void {
  const want = new Map(CARDS.filter((c) => expected.includes(c.title)).map((c) => [c.title, c]));
  for (const column of board.columns) {
    for (const card of column.cards) {
      expect(card.kind, `${card.title} in ${column.name}`).toBe('bug');
    }
    const inColumn = [...want.values()].filter((c) => column.statusKeys.includes(c.status));
    expect(column.totalCount, `${column.name} count`).toBe(inColumn.length);
    expect(column.cards.map((c) => c.title).sort(), column.name).toEqual(
      inColumn.map((c) => c.title).sort(),
    );
  }
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('A board keeps its own stored filter, set when it is created and edited in board settings, for every reader: the recipe, steps 1 to 12', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-10560');
  const s = await seed();
  let bugsId = '';
  let mobileId = '';

  await chapter(
    'Step 1 · Ada creates the kanban board “Bugs” with the board filter Kind is Bug, and it shows only bugs',
    async () => {
      await as(page, ADA);
      await openBoard(page, s.defaultBoardId);
      await startNewBoard(page, BUGS_BOARD);
      const section = dialogOf(page).getByTestId('board-filter-section');
      await expect(section).toContainText(TB.filterSectionEmptyHint);
      await section.getByTestId('board-filter-add').click();
      await expect(section).toContainText(TB.filterSectionIntro);
      await section.getByRole('button', { name: TIV.advancedAddCondition }).click();
      await pickValue(page, section, TIV.filterKind, BUG);
      await expect(dialogOf(page)).toBeVisible();
      await beat();

      const { sent, board } = await createBoard(page, [s.defaultBoardId]);
      bugsId = board.boardId;
      expect(sent).toMatchObject({ name: BUGS_BOARD, type: 'kanban' });
      expect(sent.filter).toEqual(encodeFilterEnvelope(KIND_BUG));
      expect(board.storedFilter?.envelope).toEqual(encodeFilterEnvelope(KIND_BUG));
      expect(titlesOf(board)).toEqual(BUGS);
      expectOnlyBugsByColumn(board, BUGS);

      await expect(indicator(page)).toBeVisible();
      await expect(indicator(page)).toContainText(TB.headerFilter.chip);
      await expect(indicator(page)).toContainText(KIND_BUG_TEXT);
      for (const title of BUGS) await expect(boardRegion(page).getByText(title)).toBeVisible();
      await expect(boardRegion(page).getByText('Write the release notes')).toHaveCount(0);
      await beat();
    },
  );

  await chapter('Step 2 · The project’s default board still shows every card', async () => {
    const board = await openBoard(page, s.defaultBoardId);
    expect(board.storedFilter).toBeNull();
    expect(titlesOf(board)).toEqual(ALL);
    await expect(indicator(page)).toHaveCount(0);
    await expect(boardRegion(page).getByText('Write the release notes')).toBeVisible();
    await beat();
  });

  await chapter(
    'Step 3 · Tess, who did not create “Bugs”, opens it and sees the same bugs and the board filter',
    async () => {
      await as(page, TESS);
      const board = await openBoard(page, bugsId);
      expect(titlesOf(board)).toEqual(BUGS);
      expectOnlyBugsByColumn(board, BUGS);
      await expect(indicator(page)).toBeVisible();
      await expect(indicator(page)).toContainText(KIND_BUG_TEXT);
      // Unedited, the row offers no action, and a reader who cannot configure
      // the board never sees Save to board filter.
      await expect(main(page).getByTestId('board-filter-actions')).toHaveCount(0);
      await expect(
        main(page).getByRole('button', { name: TB.headerFilter.saveToBoard }),
      ).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 4 · Tess adds Assignee is Tess to the board filter in the header, which narrows “Bugs”',
    async () => {
      await page.getByRole('button', { name: /^Advanced/ }).click();
      const dialog = advancedDialog(page);
      await expect(dialog).toBeVisible();
      // The header starts as the board filter (MOTIR-11565): Kind is Bug is
      // already the builder's first row, so Tess's condition is the second.
      await expect(dialog.getByRole('group', { name: 'Condition 1' })).toBeVisible();
      await dialog.getByRole('button', { name: TIV.advancedAddCondition }).click();
      const row = dialog.getByRole('group', { name: 'Condition 2' });
      await setField(page, row, TIV.assignee);
      const read = frameOf(page, bugsId, true);
      await pickValue(page, row, TIV.assignee, TESS.name);
      const board = await frame(read);
      expect(titlesOf(board)).toEqual(TESS_BUGS);
      expect(board.storedFilter?.envelope).toEqual(encodeFilterEnvelope(KIND_BUG));
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      // One row: the Board filter chip, Edited, both conditions, and — for a
      // member — Save as and Reset to board filter, never Save to board filter.
      const chips = page.locator(APPLIED_BAR);
      await expect(chips).toBeVisible();
      await expect(chips).toContainText(TESS.name);
      await expect(chips).toContainText(KIND_BUG_TEXT);
      await expect(chips).toContainText(en.savedFilters.applied.edited);
      const actions = main(page).getByTestId('board-filter-actions');
      await expect(actions.getByRole('button', { name: TB.headerFilter.reset })).toBeVisible();
      await expect(actions.getByRole('button', { name: TB.headerFilter.saveToBoard })).toHaveCount(
        0,
      );
      await beat();
    },
  );

  await chapter(
    'Step 5 · Clear all shows the whole board, and Reset to board filter returns to every bug',
    async () => {
      await page.getByRole('button', { name: /^Advanced/ }).click();
      const dialog = advancedDialog(page);
      let read = frameOf(page, bugsId, false);
      await dialog.getByRole('button', { name: TIV.advancedClearAll }).click();
      let board = await frame(read);
      // Clear keeps its meaning (MOTIR-11565): every condition removed is the
      // board's whole scope, and the URL says so (`boardFilter=off`).
      expect(new URL(page.url()).searchParams.get('boardFilter')).toBe('off');
      expect(titlesOf(board)).toEqual(ALL);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(indicator(page)).toContainText(TB.headerFilter.clearedNote);

      read = frameOf(page, bugsId, false);
      await main(page)
        .getByTestId('board-filter-actions')
        .getByRole('button', { name: TB.headerFilter.reset })
        .click();
      board = await frame(read);
      expect(titlesOf(board)).toEqual(BUGS);
      expectOnlyBugsByColumn(board, BUGS);
      await expect(indicator(page)).toContainText(KIND_BUG_TEXT);
      await expect(main(page).getByTestId('board-filter-actions')).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 6 · Ada creates the scrum board “Mobile sprint” from the saved filter Label is mobile: only the sprint’s mobile cards',
    async () => {
      await as(page, ADA);
      await openBoard(page, bugsId);
      await startNewBoard(page, MOBILE_BOARD);
      await dialogOf(page).getByTestId('board-type-scrum').click();
      const section = dialogOf(page).getByTestId('board-filter-section');
      await section.getByTestId('board-filter-add').click();
      await section.getByRole('combobox', { name: TB.filterStartFromSaved }).click();
      await page.getByRole('option', { name: new RegExp(SAVED_FILTER) }).click();
      await expect(section.getByTestId('board-filter-copied')).toHaveText(
        fill(TB.filterCopiedNote, { name: SAVED_FILTER }),
      );
      await expect(section.getByRole('group', { name: 'Condition 1' })).toContainText(MOBILE);
      await beat();

      const { sent, board } = await createBoard(page, [s.defaultBoardId, bugsId]);
      mobileId = board.boardId;
      // The conditions are copied in; no saved-filter reference reaches the write.
      expect(sent).toMatchObject({ name: MOBILE_BOARD, type: 'scrum' });
      expect(sent.filter).toEqual(encodeFilterEnvelope(labelIs(s.labelId)));
      expect(JSON.stringify(sent)).not.toContain(s.savedFilterId);
      expect(board.type).toBe('scrum');
      expect(board.storedFilter?.envelope).toEqual(encodeFilterEnvelope(labelIs(s.labelId)));
      expect(titlesOf(board)).toEqual(MOBILE_IN_SPRINT);
      // The sprint's points cover only the cards the filter keeps.
      expect(board.sprint?.points.committed).toBe(MOBILE_SPRINT_POINTS);
      await expect(indicator(page)).toContainText(LABEL_TEXT);
      await beat();
    },
  );

  await chapter(
    'Step 7 · The saved filter is edited, then deleted, and “Mobile sprint” keeps its own copy',
    async () => {
      const path = `/api/projects/${PROJECT.key}/saved-filters/${s.savedFilterId}`;
      const edited = await page.request.patch(path, {
        data: { filter: encodeFilterParam(KIND_BUG) },
      });
      expect(edited.status(), 'edit the saved filter').toBe(200);
      let board = await openBoard(page, mobileId);
      expect(titlesOf(board)).toEqual(MOBILE_IN_SPRINT);

      const deleted = await page.request.delete(path);
      expect(deleted.ok(), 'delete the saved filter').toBe(true);
      expect(await adminDb.savedFilter.count({ where: { id: s.savedFilterId } })).toBe(0);
      board = await openBoard(page, mobileId);
      expect(titlesOf(board)).toEqual(MOBILE_IN_SPRINT);
      expect(board.storedFilter?.envelope).toEqual(encodeFilterEnvelope(labelIs(s.labelId)));
      await expect(indicator(page)).toContainText(LABEL_TEXT);
      await beat();
    },
  );

  await chapter(
    'Step 8 · In board settings Ada changes “Bugs” to Kind is Bug AND Priority is High, and Tess’s board follows on reload',
    async () => {
      await page.goto(`/settings/project/board?board=${bugsId}`);
      const editor = editorOf(page);
      await expect(editor).toBeVisible();
      await expect(editor.getByRole('group', { name: 'Condition 1' })).toBeVisible();
      await editor.getByRole('button', { name: TIV.advancedAddCondition }).click();
      const row = editor.getByRole('group', { name: 'Condition 2' });
      await setField(page, row, TIV.advancedFieldPriority);
      await pickValue(page, row, TIV.advancedFieldPriority, HIGH);
      await expect(editor.getByTestId('board-stored-filter-unsaved')).toBeVisible();
      await beat();

      const write = respondsTo(page, `/api/boards/${bugsId}`, 'PATCH');
      await editor.getByTestId('board-stored-filter-save').click();
      const saved = await answered<BoardDto>(write, 200);
      expect(saved.filter).toEqual(encodeFilterEnvelope(KIND_BUG_AND_HIGH));
      await expect(editor.getByTestId('board-stored-filter-announce')).toHaveText(TS.savedAnnounce);
      await expect(editor.getByTestId('board-stored-filter-unsaved')).toHaveCount(0);

      await as(page, TESS);
      const board = await openBoard(page, bugsId);
      expect(titlesOf(board)).toEqual(HIGH_BUGS);
      expectOnlyBugsByColumn(board, HIGH_BUGS);
      await expect(indicator(page)).toContainText(HIGH_TEXT);
      await beat();
    },
  );

  await chapter(
    'Step 9 · A condition with an invalid value is refused with a 422, and the stored filter is unchanged',
    async () => {
      await as(page, ADA);
      await page.goto(`/settings/project/board?board=${bugsId}`);
      const editor = editorOf(page);
      await expect(editor.getByRole('group', { name: 'Condition 2' })).toBeVisible();
      await editor.getByRole('button', { name: TIV.advancedAddCondition }).click();
      const row = editor.getByRole('group', { name: 'Condition 3' });
      await setField(page, row, TIV.advancedFieldUpdated);
      await row.getByRole('combobox', { name: 'Operator' }).click();
      await page.getByRole('option', { name: TIV.advancedOpInLastDays, exact: true }).click();
      // The builder's own guard: a zero-day window stays pending and unsent.
      await row.getByRole('textbox', { name: TIV.advancedDayCountAria }).fill('0');
      await expect(row).toContainText(TIV.advancedPendingNote);
      await beat();

      // A valid window is typed, and the request is rewritten on the wire to the
      // invalid one, as a client the builder does not guard would send it.
      await row.getByRole('textbox', { name: TIV.advancedDayCountAria }).fill('7');
      await expect(row).not.toContainText(TIV.advancedPendingNote);
      await page.route(`**/api/boards/${bugsId}`, async (route) => {
        const body = route.request().postDataJSON() as { filter: FilterEnvelope };
        body.filter.f = body.filter.f.map(([field, operator, value]) =>
          field === 'updated' ? [field, operator, 0] : [field, operator, value],
        );
        await route.continue({ postData: JSON.stringify(body) });
      });
      const write = respondsTo(page, `/api/boards/${bugsId}`, 'PATCH');
      await editor.getByTestId('board-stored-filter-save').click();
      const refused = await answered<{ code: string; error: string; conditionIndex?: number }>(
        write,
        422,
      );
      await page.unroute(`**/api/boards/${bugsId}`);
      expect(refused.code).toBe('INVALID_FILTER_VALUE');
      expect(refused.conditionIndex).toBe(2);
      const refusal = editor.getByTestId('board-filter-refusal');
      await expect(refusal).toContainText(TS.refusedTitle);
      await expect(refusal).toContainText(fill(TS.refusedInvalid, { n: 3, reason: refused.error }));
      await beat();

      // A re-read: the stored filter is the one step 8 saved.
      const reread = await page.request.get(`/api/board?boardId=${bugsId}`);
      expect(reread.status()).toBe(200);
      const stored = ((await reread.json()) as BoardProjectionDto).storedFilter;
      expect(stored?.envelope).toEqual(encodeFilterEnvelope(KIND_BUG_AND_HIGH));
    },
  );

  await chapter(
    'Step 10 · The label “mobile” leaves its last card and is deleted: “Mobile sprint” still loads, matches nothing, and settings name the stale condition',
    async () => {
      for (const cardId of s.mobileCardIds) {
        const res = await page.request.delete(`/api/work-items/${cardId}/labels/${s.labelId}`);
        expect(res.status(), `remove ${MOBILE} from ${cardId}`).toBe(200);
      }
      // Labels are deleted on last use.
      expect(await adminDb.label.count({ where: { id: s.labelId } })).toBe(0);

      const board = await openBoard(page, mobileId);
      expect(titlesOf(board)).toEqual([]);
      expect(board.storedFilter?.staleConditions).toEqual([
        { index: 0, field: 'lbl', reason: 'unknown-value' },
      ]);
      // The board renders (no error page): the filtered-empty state, with the
      // board filter still saying what it applies.
      await expect(main(page).getByTestId('board-filtered-empty')).toBeVisible();
      await expect(main(page).getByTestId('board-filtered-empty')).toContainText(
        TB.boardFilterEmptyTitle,
      );
      await expect(indicator(page)).toBeVisible();
      await expect(main(page).getByTestId('board-filter-chip-stale')).toBeVisible();
      await beat();

      await page.goto(`/settings/project/board?board=${mobileId}`);
      const stale = editorOf(page).getByTestId('board-stored-filter-stale');
      await expect(stale).toContainText(one(TS.staleTitle));
      await expect(stale).toContainText(
        fill(TS.staleRowLabel, { n: 1, field: TIV.advancedFieldLabel }),
      );
      await beat();
    },
  );

  await chapter(
    'Step 11 · Olive, outside the organisation, reads the public project as a Visitor and sees “Bugs” through its filter',
    async () => {
      await as(page, OLIVE);
      await page.goto(`/p/${PROJECT.key}/board`);
      await page.waitForURL((u) => u.pathname === `/p/${PROJECT.key}/consent`);
      const consent = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes(`/p/${PROJECT.key}/consent`),
      );
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      expect((await consent).status()).toBe(200);
      await page.waitForURL((u) => u.pathname === `/p/${PROJECT.key}/board`);

      const read = frameOf(page, bugsId);
      await page.goto(`/p/${PROJECT.key}/board?board=${bugsId}`);
      const board = await frame(read);
      expect(titlesOf(board)).toEqual(HIGH_BUGS);
      for (const column of board.columns) {
        for (const card of column.cards) expect(card.kind).toBe('bug');
      }
      await expect(indicator(page)).toBeVisible();
      await expect(indicator(page)).toContainText(KIND_BUG_TEXT);
      await expect(
        main(page).getByRole('button', { name: TB.headerFilter.saveToBoard }),
      ).toHaveCount(0);
      await expect(indicator(page).getByRole('link')).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'Step 12 · Ada clears the board filter of “Bugs” in settings, and the board shows every card again',
    async () => {
      await as(page, ADA);
      await page.goto(`/settings/project/board?board=${bugsId}`);
      const editor = editorOf(page);
      await expect(editor.getByRole('group', { name: 'Condition 1' })).toBeVisible();
      await editor.getByTestId('board-stored-filter-clear').click();
      await expect(editor.getByTestId('board-stored-filter-cleared')).toHaveText(TS.clearedNote);
      const write = respondsTo(page, `/api/boards/${bugsId}`, 'PATCH');
      await editor.getByTestId('board-stored-filter-save').click();
      const res = await write;
      expect(res.request().postDataJSON()).toEqual({ filter: null });
      const saved = await answered<BoardDto>(Promise.resolve(res), 200);
      expect(saved.filter).toBeNull();
      await beat();

      const board = await openBoard(page, bugsId);
      expect(board.storedFilter).toBeNull();
      expect(titlesOf(board)).toEqual(ALL);
      await expect(indicator(page)).toHaveCount(0);
      await expect(boardRegion(page).getByText('Write the release notes')).toBeVisible();
      await beat();
    },
  );
});
