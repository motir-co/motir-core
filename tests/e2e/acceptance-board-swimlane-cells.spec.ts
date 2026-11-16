// Acceptance E2E — swimlane boards page each (lane × column) cell on its own and
// scroll each lane sideways on its own (Story MOTIR-11328 · MOTIR-11454). The
// story's verification recipe, walked end to end in a real browser against the
// SERVED app, and recorded as the story's acceptance video:
//
//   1. group by Assignee on a ~60-card project where one assignee holds 40 cards
//      in To Do: that lane's To Do cell shows 10 with "10 of 40" and Load more,
//      and the other lanes show their own To Do cards;
//   2. Load more takes that one cell to 20 of 40 and nothing else changes; on to
//      40 of 40, and the control is gone;
//   3. the pinned To Do header still reads the column total, and each lane header
//      its lane's total;
//   4. a collapsed lane, after a reload, loads nothing; expanded, its cells load;
//   5. group by Epic on a project seeded with 200 epics: the board opens without
//      asking for every lane, and a lane further down fills as it comes into view;
//   6. one lane's right arrow, then a drag on its background: only that lane moves;
//   7. a card dragged from lane A's To Do into lane B's In Progress lands, both
//      cells' counts follow, and paging lane B's In Progress lists it once;
//   8. a toolbar filter Priority is High shrinks every cell and Clear restores
//      them; a board with a stored filter never shows a card it excludes;
//   9. group by None: the flat board pages exactly as before;
//  10. the group-by control and lane headers, in each state the design draws.
//
// One recorded test, one chapter per step, then a receipt test that reads the
// run's own sidecars back.
//
// ── THE TENANT ──────────────────────────────────────────────────────────────
// One workspace owned by Ana, with two projects: "Atlas" (60 cards across Ana,
// Bo and Cal plus one unassigned card) and "Orbit" (200 epics with one story
// each, laid by the shipped `seedLargeBoard`). The active project is switched
// between chapters through the shipped `projectsService.setActiveProject`.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every page response from the two routes this story adds — the lane page
// (`GET /api/board/lanes/[laneKey]/cells`) and the cell page
// (`GET /api/board/columns/[id]/cards?lane=`) — is collected as it arrives, with
// its body. A chapter waits by polling that collection for the response it
// needs (so a response that arrived before the wait was armed is never missed),
// or by asserting on something rendered, or by polling the shipped board read.
// There is no sleep: the only holds are the recording's `chapter()` and `beat()`
// pacing, taken after the state is proven. Every collected response is checked
// for the page bound, its total, and the column's own order.
//
// ── WHAT THIS RECEIPT DOES NOT SHOW ─────────────────────────────────────────
// A failed cell page and its retry, a failed lane page, the read-only group-by
// trigger and the narrow-viewport state are not on this recording: a green run
// cannot make a page fail or change an actor's permissions on demand, and this
// lane stubs nothing. They are proven by the cell's and the group-by control's
// component suites (`tests/components/board-lane-cell*.test.tsx`,
// `tests/components/board-group-by-control.test.tsx`) and the integration gate.
// Design fidelity is the reviewer's judgement; chapter 10 puts each drawn state
// the run reaches on camera, and asserts that it is reached.
//
// ── THE STRINGS ─────────────────────────────────────────────────────────────
// Every label and sentence matched is read from `messages/en.json`.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made. CI is this spec's first run: the lane's `next build` does not
// run in the cloud thread that wrote it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { createTestPerson } from './_helpers/testPerson';
import { dragCardOntoCell, getFullBoard, scrollLaneToEnd, setGroupBy } from './_helpers/board';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService, BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import { encodeFilterEnvelope, type FilterAst } from '@/lib/filters/ast';
import {
  BOARD_SWIMLANE_NO_VALUE,
  type BoardCellPageDto,
  type BoardColumnDto,
  type BoardLanePageDto,
  type BoardProjectionDto,
} from '@/lib/dto/boards';
import type { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import { seedLargeBoard } from '../../scripts/seedLargeBoard';
import {
  MIN_MEDIAN_CHAPTER_GAP_SECONDS,
  MIN_WATCHABLE_SECONDS,
  assessWatchability,
  isOwnedRecording,
} from '../../scripts/upload-acceptance-video.mjs';
import en from '@/messages/en.json';

// The 200-epic project is ~400 cards laid one transaction at a time, and the
// walk holds every chapter for the reviewer: the at-scale spec's ceiling.
test.describe.configure({ timeout: 900_000 });

const THIS_SPEC = 'tests/e2e/acceptance-board-swimlane-cells.spec.ts';
const STORY = 'MOTIR-11328';

const CHAPTERS = [
  'Step 1 · Group by Assignee: the busy lane’s To Do cell shows 10 of 40 with Load more, and every other lane shows its own To Do cards',
  'Step 2 · Load more pages only that cell: 20 of 40, then 40 of 40 and the control is gone',
  'Step 3 · The pinned To Do header reads the column total, and each lane header its lane’s total',
  'Step 4 · A collapsed lane loads nothing after a reload; expanded, its cells load their first page',
  'Step 5 · Group by Epic on 200 epics: the board opens without asking for every lane, and a lane further down fills as it appears',
  'Step 6 · One lane’s right arrow, then a drag on its background: only that lane moves, its label stays pinned',
  'Step 7 · A card dragged from lane A’s To Do into lane B’s In Progress: both counts follow, and paging lists it once',
  'Step 8 · Toolbar filter Priority is High shrinks every cell and Clear restores them; a stored filter is never crossed',
  'Step 9 · Group by None: the flat board pages exactly as before, with no per-cell Load more',
  'Step 10 · The group-by control and lane headers in each drawn state: three dimensions, catch-all, collapsed, empty, first load',
] as const;

const PASSWORD = 'board-swimlane-cells-e2e-pass-3';
const ANA = { email: 'bsc-ana@example.com', name: 'Ana Archer' };
const BO = { email: 'bsc-bo@example.com', name: 'Bo Baker' };
const CAL = { email: 'bsc-cal@example.com', name: 'Cal Carter' };
const ATLAS = { name: 'Atlas', key: 'BSC' };
const ORBIT = { name: 'Orbit', key: 'BSO' };
const ORBIT_EPICS = 200;
const BUGS_BOARD = 'Atlas bugs';

const TB = en.boards;
const TIV = en.issueViews;
const HIGH = en.labels.priority.high;
const TERMINAL = new Set(DEFAULT_STATUSES.filter((s) => s.category === 'done').map((s) => s.key));

/** An ICU message with `{name}` / `{name, number}` arguments, filled in English. */
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)(?:, number)?\}/g, (_, k: string) => {
    const v = values[k];
    return typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '');
  });
/** A cell's (or a column header's) count as it renders: "{loaded} of {total}"
 *  while more remain, else the bare total. */
const countText = (loaded: number, total: number) =>
  loaded < total ? fill(TB.laneCountLoaded, { loaded, total }) : fill(TB.laneCount, { total });

// ── The Atlas cards ─────────────────────────────────────────────────────────
// Ana holds 40 in To Do (a third bugs, a quarter High). Bo holds an epic in
// In Progress (its status derives from its twelve In Progress children), a task
// and a High bug in To Do and two Done tasks. Cal holds two To Do tasks (one
// High) and twelve In Progress stories under Bo's epic (a quarter High). One bug
// is unassigned, so the Assignee catch-all lane has a card. 60 cards in all.

type Who = 'ana' | 'bo' | 'cal' | null;
interface CardSeed {
  title: string;
  kind: WorkItemKind;
  status: 'todo' | 'in_progress' | 'done';
  priority: WorkItemPriority;
  who: Who;
  underEpic?: boolean;
}

const EPIC_TITLE = 'Checkout revamp';
const MOVED_TITLE = 'Bo: wire the payment form';

const CARDS: CardSeed[] = [
  ...Array.from(
    { length: 40 },
    (_, i): CardSeed => ({
      title: `Ana: intake item ${i + 1}`,
      kind: i % 3 === 0 ? 'bug' : 'task',
      status: 'todo',
      priority: i % 4 === 0 ? 'high' : 'medium',
      who: 'ana',
    }),
  ),
  { title: EPIC_TITLE, kind: 'epic', status: 'in_progress', priority: 'medium', who: 'bo' },
  { title: MOVED_TITLE, kind: 'task', status: 'todo', priority: 'medium', who: 'bo' },
  { title: 'Bo: card reader times out', kind: 'bug', status: 'todo', priority: 'high', who: 'bo' },
  { title: 'Bo: archive old receipts', kind: 'task', status: 'done', priority: 'low', who: 'bo' },
  { title: 'Bo: rotate the API key', kind: 'task', status: 'done', priority: 'low', who: 'bo' },
  {
    title: 'Cal: draft the refund copy',
    kind: 'task',
    status: 'todo',
    priority: 'high',
    who: 'cal',
  },
  {
    title: 'Cal: sketch the receipt',
    kind: 'task',
    status: 'todo',
    priority: 'medium',
    who: 'cal',
  },
  ...Array.from(
    { length: 12 },
    (_, i): CardSeed => ({
      title: `Cal: checkout step ${i + 1}`,
      kind: 'story',
      status: 'in_progress',
      priority: i % 4 === 0 ? 'high' : 'medium',
      who: 'cal',
      underEpic: true,
    }),
  ),
  { title: 'Triage: crash on launch', kind: 'bug', status: 'todo', priority: 'medium', who: null },
];

/** The board as the seed (and the walk's one move) leave it: what each cell must
 *  hold. Kept in step with the drag in chapter 7. */
interface ModelCard extends CardSeed {
  id: string;
  identifier: string;
}

const KIND_BUG: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
};

// ── Seed ────────────────────────────────────────────────────────────────────

interface Seed {
  ctx: { userId: string; workspaceId: string };
  users: Record<'ana' | 'bo' | 'cal', string>;
  atlas: { projectId: string; boardId: string; bugsBoardId: string };
  orbit: { projectId: string; boardId: string };
  cards: ModelCard[];
  epicId: string;
}

async function seed(): Promise<Seed> {
  const ana = await createTestPerson({ ...ANA, password: PASSWORD });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Atlas Studio',
    ownerUserId: ana.id,
  });
  const ctx = { userId: ana.id, workspaceId: workspace.id };
  const atlas = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: ana.id,
    name: ATLAS.name,
    identifier: ATLAS.key,
  });
  const orbit = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: ana.id,
    name: ORBIT.name,
    identifier: ORBIT.key,
  });

  const users = { ana: ana.id, bo: '', cal: '' };
  for (const [who, person] of [
    ['bo', BO],
    ['cal', CAL],
  ] as const) {
    const user = await createTestPerson({ ...person, password: PASSWORD });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: atlas.identifier,
      actorUserId: ana.id,
      ctx,
      targetUserId: user.id,
      role: 'member',
    });
    users[who] = user.id;
  }

  // Atlas: created in order, so each column's rank is creation order.
  const cards: ModelCard[] = [];
  let epicId = '';
  for (const card of CARDS) {
    const item = await workItemsService.createWorkItem(
      {
        projectId: atlas.id,
        kind: card.kind,
        title: card.title,
        priority: card.priority,
        ...(card.who ? { assigneeId: users[card.who] } : {}),
        ...(card.underEpic ? { parentId: epicId } : {}),
      },
      ctx,
    );
    if (card.title === EPIC_TITLE) epicId = item.id;
    // Columns group by status; the transition path is another story's (the
    // board-filter.spec shortcut, as the stored-filter acceptance spec does).
    if (card.status !== 'todo') {
      await adminDb.workItem.update({ where: { id: item.id }, data: { status: card.status } });
    }
    cards.push({ ...card, id: item.id, identifier: item.identifier });
  }
  // The epic's status is DERIVED from its children (the parent status rollup,
  // run by the job worker on each child write). Its children were moved to In
  // Progress above, so the rollup lands it there whenever it runs; write that
  // state last, so the board is the same whether the job ran before the seed
  // finished or runs after it.
  await adminDb.workItem.update({ where: { id: epicId }, data: { status: 'in_progress' } });

  const atlasBoards = await boardsService.listBoards(atlas.id, ctx);
  const atlasDefault = atlasBoards.find((b) => b.isDefault)!;
  // A second Atlas board that keeps its own stored filter, Kind is Bug, grouped
  // by Assignee through the shipped config write.
  const bugs = await boardsService.createBoard(
    atlas.id,
    { name: BUGS_BOARD, filter: encodeFilterEnvelope(KIND_BUG) },
    ctx,
  );
  await boardsService.setSwimlaneGroupBy(bugs.id, 'assignee', ctx);

  // Orbit: 200 epics, one story under each — each epic is a lane, holding the
  // epic itself (a board card that is an epic sits in its own lane) and its story.
  await seedLargeBoard(
    {
      workspaceId: workspace.id,
      projectId: orbit.id,
      projectIdentifier: orbit.identifier,
      ownerId: ana.id,
      memberIds: [ana.id],
    },
    {
      epics: ORBIT_EPICS,
      storiesPerEpic: 1,
      rootStories: 0,
      tallColumnExtra: 0,
      unassignedEvery: 0,
      doneAgedOutEvery: 0,
    },
    adminDb,
  );
  const orbitDefault = (await boardsService.listBoards(orbit.id, ctx)).find((b) => b.isDefault)!;

  await projectsService.setActiveProject({ ...ctx, projectId: atlas.id });
  return {
    ctx,
    users,
    atlas: { projectId: atlas.id, boardId: atlasDefault.id, bugsBoardId: bugs.id },
    orbit: { projectId: orbit.id, boardId: orbitDefault.id },
    cards,
    epicId,
  };
}

// ── The page collector ──────────────────────────────────────────────────────

interface SeenPage {
  /** Order of arrival. */
  seq: number;
  route: 'lane' | 'cell';
  boardId: string;
  laneKey: string;
  /** The toolbar filter param the read carried, or null. */
  filter: string | null;
  cells: BoardCellPageDto[];
}

interface Collector {
  seen: SeenPage[];
  /** Lane-route REQUESTS as they leave the page, by board: lane keys in order. */
  laneRequests: { seq: number; boardId: string; laneKey: string }[];
  /** Column-route requests with no `lane` — the flat board's own paging. */
  flatColumnRequests: { seq: number; boardId: string }[];
  next(): number;
}

function collect(page: Page): Collector {
  let seq = 0;
  const c: Collector = {
    seen: [],
    laneRequests: [],
    flatColumnRequests: [],
    next: () => seq,
  };
  page.on('request', (req) => {
    if (req.method() !== 'GET') return;
    const u = new URL(req.url());
    const lane = u.pathname.match(/^\/api\/board\/lanes\/([^/]+)\/cells$/);
    if (lane) {
      c.laneRequests.push({
        seq: ++seq,
        boardId: u.searchParams.get('boardId') ?? '',
        laneKey: decodeURIComponent(lane[1]!),
      });
    } else if (
      /^\/api\/board\/columns\/[^/]+\/cards$/.test(u.pathname) &&
      !u.searchParams.has('lane')
    ) {
      c.flatColumnRequests.push({ seq: ++seq, boardId: u.searchParams.get('boardId') ?? '' });
    }
  });
  page.on('response', async (res: Response) => {
    if (res.request().method() !== 'GET' || res.status() !== 200) return;
    const u = new URL(res.url());
    const lane = u.pathname.match(/^\/api\/board\/lanes\/([^/]+)\/cells$/);
    const cell =
      /^\/api\/board\/columns\/[^/]+\/cards$/.test(u.pathname) && u.searchParams.get('lane');
    if (!lane && !cell) return;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return; // the page navigated away mid-body; nothing was rendered from it
    }
    const boardId = u.searchParams.get('boardId') ?? '';
    const filter = u.searchParams.get('filter');
    if (lane) {
      const dto = body as BoardLanePageDto;
      c.seen.push({
        seq: ++seq,
        route: 'lane',
        boardId,
        laneKey: dto.laneKey,
        filter,
        cells: dto.cells,
      });
    } else {
      const dto = body as BoardCellPageDto;
      c.seen.push({
        seq: ++seq,
        route: 'cell',
        boardId,
        laneKey: dto.laneKey,
        filter,
        cells: [dto],
      });
    }
  });
  return c;
}

/** Every observed cell page: at most a page of cards, a total that covers them,
 *  and — on a non-terminal column — the board rank ascending (the column's own
 *  order; a terminal column's recency order is checked against the flat read). */
function expectBoundedPages(c: Collector): void {
  expect(c.seen.length, 'the walk observed cell pages').toBeGreaterThan(0);
  for (const page of c.seen) {
    for (const cell of page.cells) {
      const where = `${page.route} page ${cell.columnId} × ${cell.laneKey}`;
      expect(cell.cards.length, `${where} is bounded`).toBeLessThanOrEqual(BOARD_PAGE_SIZE);
      expect(typeof cell.totalCount, `${where} carries its total`).toBe('number');
      expect(cell.totalCount, `${where} total covers its cards`).toBeGreaterThanOrEqual(
        cell.cards.length,
      );
      if (cell.cards.some((card) => TERMINAL.has(card.status))) continue;
      const ranks = cell.cards.map((card) => card.position);
      expect(ranks, `${where} is in the column's rank order`).toEqual(
        [...ranks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
  }
}

/** Every observed cell of `boardId` lists its cards in the same relative order
 *  as the flat board's column — the column's own order, terminal columns too. */
function expectColumnOrder(c: Collector, boardId: string, flat: BoardProjectionDto): void {
  const order = new Map(flat.columns.map((col) => [col.id, col.cards.map((card) => card.id)]));
  for (const page of c.seen.filter((p) => p.boardId === boardId)) {
    for (const cell of page.cells) {
      const column = order.get(cell.columnId) ?? [];
      const ids = cell.cards.map((card) => card.id).filter((id) => column.includes(id));
      const expected = column.filter((id) => ids.includes(id));
      expect(ids, `cell ${cell.columnId} × ${cell.laneKey} follows its column`).toEqual(expected);
    }
  }
}

// ── Locators and waits ──────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const laneOf = (page: Page, key: string) => main(page).getByTestId(`swimlane-${key}`);
const cellOf = (page: Page, col: string, lane: string) =>
  main(page).getByTestId(`lane-cell-${col}-${lane}`);
const cellCount = (page: Page, col: string, lane: string) =>
  main(page).getByTestId(`cell-count-${col}-${lane}`);
const loadMore = (page: Page, col: string, lane: string) =>
  main(page).getByTestId(`cell-load-more-${col}-${lane}`);
const cellCards = (page: Page, col: string, lane: string) =>
  cellOf(page, col, lane).locator('[data-testid^="board-card-"]');
const headerCount = (page: Page, col: string) =>
  main(page).getByTestId('swimlane-header-row').getByTestId(`board-count-${col}`);
const scrollerOf = (page: Page, key: string) => main(page).getByTestId(`swimlane-scroller-${key}`);
const advancedDialog = (page: Page) => page.getByRole('dialog', { name: TIV.advancedDialogLabel });

/** The board projection the page fetches for `boardId`. */
function frameOf(page: Page, boardId: string, filtered?: boolean): Promise<Response> {
  return page.waitForResponse((r) => {
    if (r.request().method() !== 'GET') return false;
    const u = new URL(r.url());
    if (u.pathname !== '/api/board' || u.searchParams.get('boardId') !== boardId) return false;
    return filtered === undefined || u.searchParams.has('filter') === filtered;
  });
}

async function frame(pending: Promise<Response>): Promise<BoardProjectionDto> {
  const res = await pending;
  expect(res.status(), 'GET /api/board').toBe(200);
  return (await res.json()) as BoardProjectionDto;
}

/** Open `/boards` on `boardId` and return its projection. */
async function openBoard(page: Page, boardId: string): Promise<BoardProjectionDto> {
  const read = frameOf(page, boardId);
  await page.goto(`/boards?board=${boardId}`);
  const board = await frame(read);
  await expect(
    main(page).getByTestId('board').or(main(page).getByTestId('swimlane-board')).first(),
  ).toBeVisible();
  return board;
}

/** Switch the group-by through the shipped control; return the re-laid read. */
async function groupBy(
  page: Page,
  boardId: string,
  label: 'None' | 'Assignee' | 'Epic' | 'Priority',
): Promise<BoardProjectionDto> {
  const read = frameOf(page, boardId);
  await setGroupBy(page, label);
  return frame(read);
}

/** Bring a lane into view and wait for its lane page — one that arrived at or
 *  after `since`, on `boardId`, under the toolbar filter state `filtered`. */
async function laneLoaded(
  page: Page,
  c: Collector,
  boardId: string,
  key: string,
  since: number,
  filtered = false,
): Promise<SeenPage> {
  await laneOf(page, key).scrollIntoViewIfNeeded();
  const found = () =>
    c.seen.find(
      (p) =>
        p.route === 'lane' &&
        p.seq > since &&
        p.boardId === boardId &&
        p.laneKey === key &&
        (p.filter !== null) === filtered,
    );
  await expect
    .poll(() => found() !== undefined, { message: `lane ${key} loaded its cells` })
    .toBe(true);
  const lane = found()!;
  // Rendered: every cell of the lane has left its placeholder.
  for (const cell of lane.cells) {
    await expect(cellOf(page, cell.columnId, key)).not.toHaveAttribute(
      'data-cell-phase',
      /not-loaded|first-load|placeholder/,
    );
  }
  return lane;
}

/** Press a cell's Load more and wait for that cell's page; return it. */
async function pressLoadMore(
  page: Page,
  c: Collector,
  boardId: string,
  col: string,
  lane: string,
): Promise<BoardCellPageDto> {
  const since = c.next();
  const button = loadMore(page, col, lane);
  await expect(button).toHaveText(TB.cellLoadMore);
  await button.click();
  const found = () =>
    c.seen.find(
      (p) =>
        p.route === 'cell' &&
        p.seq > since &&
        p.boardId === boardId &&
        p.laneKey === lane &&
        p.cells[0]!.columnId === col,
    );
  await expect
    .poll(() => found() !== undefined, { message: `cell ${col} × ${lane} paged` })
    .toBe(true);
  return found()!.cells[0]!;
}

/** What every mounted cell renders, by cell id — its card ids, its count text and
 *  whether it offers Load more — for a "nothing else changed" comparison. */
function cellSnapshot(page: Page, except: string): Promise<Record<string, string>> {
  return main(page).evaluate((root, skip) => {
    const out: Record<string, string> = {};
    for (const el of root.querySelectorAll<HTMLElement>('[data-testid^="lane-cell-"]')) {
      const id = el.dataset.testid!;
      if (id === skip) continue;
      const cards = [...el.querySelectorAll<HTMLElement>('[data-testid^="board-card-"]')].map(
        (n) => n.dataset.testid,
      );
      const count = el.querySelector('[data-testid^="cell-count-"]')?.textContent ?? '';
      const more = el.querySelector('[data-testid^="cell-load-more-"]') ? 'more' : '';
      out[id] = `${cards.join(',')}|${count}|${more}|${el.dataset.cellPhase ?? ''}`;
    }
    return out;
  }, except);
}

const scrollLefts = (page: Page, keys: string[]) =>
  Promise.all(keys.map((k) => scrollerOf(page, k).evaluate((el) => Math.round(el.scrollLeft))));

/** The column ids by status key, and the lane keys in order, of a projection. */
function shape(board: BoardProjectionDto) {
  const col = (status: string): BoardColumnDto => {
    const found = board.columns.find((c) => c.statusKeys.includes(status));
    if (!found) throw new Error(`no column maps ${status}`);
    return found;
  };
  return { col, lanes: board.swimlanes.map((l) => l.key) };
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The recorded test's output directory, for the receipt test after it. */
let recordingDir: string | null = null;

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('A grouped board pages each lane’s cell 10 at a time with Load more and scrolls each lane on its own: the recipe, steps 1 to 10', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}, testInfo) => {
  acceptanceStory('MOTIR-11328');
  recordingDir = testInfo.outputDir;

  const s = await seed();
  const { ana, bo, cal } = s.users;
  const UNASSIGNED = BOARD_SWIMLANE_NO_VALUE; // the catch-all lane of every dimension
  const model = s.cards;
  const count = (pick: (c: ModelCard) => boolean) => model.filter(pick).length;
  const inCell = (status: string, who: Who) => (c: ModelCard) =>
    c.status === status && c.who === who;
  const atlasId = s.atlas.boardId;

  // The cell phases the page passes through, as the DOM states them — observed,
  // never driven, so chapter 10 can show the first-load placeholder was reached.
  await page.addInitScript(() => {
    const w = window as unknown as { __cellPhases: Set<string> };
    w.__cellPhases = new Set();
    const note = (el: Element) => {
      const phase = el.getAttribute('data-cell-phase');
      if (phase) w.__cellPhases.add(phase);
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target instanceof Element) note(r.target);
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          note(n);
          n.querySelectorAll('[data-cell-phase]').forEach(note);
        }
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-cell-phase'],
    });
  });
  const phasesSeen = () =>
    page.evaluate(() => [...(window as unknown as { __cellPhases: Set<string> }).__cellPhases]);
  const c = collect(page);

  // A tall viewport, so a lane's ten-card cell and the lane beneath it fit on
  // screen together for the drag of chapter 7; wide enough to show five columns,
  // so every lane overflows sideways and draws its arrows.
  await page.setViewportSize({ width: 1600, height: 1600 });
  await signIn(page, ANA.email, PASSWORD);

  let todo = '';
  let inProgress = '';
  let done = '';
  let columnNames: string[] = [];
  let atlasReopened = 0;

  await chapter(CHAPTERS[0], async () => {
    await openBoard(page, atlasId);
    const since = c.next();
    const board = await groupBy(page, atlasId, 'Assignee');
    ({ id: todo } = shape(board).col('todo'));
    ({ id: inProgress } = shape(board).col('in_progress'));
    ({ id: done } = shape(board).col('done'));
    columnNames = board.columns.map((col) => col.name);
    // The grouped read carries the column meta only; the cards come per cell.
    for (const col of board.columns) expect(col.cards).toEqual([]);
    expect(shape(board).lanes).toEqual([ana, bo, cal, UNASSIGNED]);
    await expect(main(page).getByTestId('swimlane-board')).toBeVisible();

    const busy = await laneLoaded(page, c, atlasId, ana, since);
    const busyTodo = busy.cells.find((cell) => cell.columnId === todo)!;
    expect(busyTodo.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(busyTodo.totalCount).toBe(40);
    await laneOf(page, ana).scrollIntoViewIfNeeded();
    await expect(cellCount(page, todo, ana)).toHaveText(countText(10, 40));
    await expect(loadMore(page, todo, ana)).toBeVisible();
    await beat();

    // Every other lane shows its OWN To Do cards — none is left empty because
    // another lane filled the column's first page.
    for (const who of ['bo', 'cal', null] as const) {
      const key = who ? s.users[who] : UNASSIGNED;
      const lane = await laneLoaded(page, c, atlasId, key, since);
      const expected = model.filter(inCell('todo', who)).map((m) => m.id);
      expect(lane.cells.find((cell) => cell.columnId === todo)!.cards.map((m) => m.id)).toEqual(
        expected,
      );
      await expect(cellCards(page, todo, key)).toHaveCount(expected.length);
      await expect(cellCount(page, todo, key)).toHaveText(
        countText(expected.length, expected.length),
      );
      await expect(loadMore(page, todo, key)).toHaveCount(0);
    }
    await laneOf(page, ana).scrollIntoViewIfNeeded();
    await beat();
  });

  await chapter(CHAPTERS[1], async () => {
    const id = `lane-cell-${todo}-${ana}`;
    const before = await cellSnapshot(page, id);
    const second = await pressLoadMore(page, c, atlasId, todo, ana);
    expect(second.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(second.totalCount).toBe(40);
    await expect(cellCount(page, todo, ana)).toHaveText(countText(20, 40));
    expect(await cellSnapshot(page, id), 'no other cell changed').toEqual(before);
    await beat();

    await pressLoadMore(page, c, atlasId, todo, ana);
    await expect(cellCount(page, todo, ana)).toHaveText(countText(30, 40));
    const last = await pressLoadMore(page, c, atlasId, todo, ana);
    expect(last.cursor).toBeNull();
    await expect(cellCount(page, todo, ana)).toHaveText(countText(40, 40));
    await expect(loadMore(page, todo, ana)).toHaveCount(0);
    expect(await cellSnapshot(page, id), 'still no other cell changed').toEqual(before);
    await loadMore(page, todo, ana)
      .or(cellCount(page, todo, ana))
      .first()
      .scrollIntoViewIfNeeded();
    await beat();
  });

  await chapter(CHAPTERS[2], async () => {
    // Hold the busy cell part-loaded: a reload resets it to its first page; one
    // Load more takes it to 20 of 40.
    const since = c.next();
    await page.reload();
    await laneLoaded(page, c, atlasId, ana, since);
    await pressLoadMore(page, c, atlasId, todo, ana);
    await expect(cellCount(page, todo, ana)).toHaveText(countText(20, 40));

    // The pinned header reads the column's TOTAL across every lane (its last
    // number), whatever the cells have loaded so far.
    const columnTotal = count((m) => m.status === 'todo');
    expect(columnTotal).toBe(45);
    await main(page).getByTestId('swimlane-header-row').scrollIntoViewIfNeeded();
    await expect(headerCount(page, todo)).toContainText(columnTotal.toLocaleString('en-US'));
    const header = (await headerCount(page, todo).textContent()) ?? '';
    expect(
      Number(
        header
          .match(/[\d,]+/g)
          ?.at(-1)
          ?.replace(/,/g, ''),
      ),
    ).toBe(columnTotal);

    // Each lane header reads its own lane's aggregate.
    for (const who of ['ana', 'bo', 'cal', null] as const) {
      const key = who ? s.users[who] : UNASSIGNED;
      await expect(main(page).getByTestId(`swimlane-count-${key}`)).toHaveText(
        String(count((m) => m.who === who)),
      );
    }
    await beat();
  });

  await chapter(CHAPTERS[3], async () => {
    const head = main(page).getByTestId(`swimlane-head-${bo}`);
    await head.scrollIntoViewIfNeeded();
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(main(page).getByTestId(`swimlane-cells-${bo}`)).toHaveCount(0);
    await beat();

    const since = c.next();
    await page.reload();
    await laneLoaded(page, c, atlasId, ana, since);
    // Bring every later lane in, past the collapsed one: each answers, and the
    // collapsed lane — scrolled through on the way — asked for nothing.
    await laneOf(page, bo).scrollIntoViewIfNeeded();
    await laneLoaded(page, c, atlasId, cal, since);
    await laneLoaded(page, c, atlasId, UNASSIGNED, since);
    const reHead = main(page).getByTestId(`swimlane-head-${bo}`);
    await expect(reHead).toHaveAttribute('aria-expanded', 'false');
    await expect(main(page).getByTestId(`swimlane-cells-${bo}`)).toHaveCount(0);
    expect(
      c.laneRequests.filter((r) => r.seq > since && r.laneKey === bo),
      'a collapsed lane issues no cell-page request',
    ).toEqual([]);
    await reHead.scrollIntoViewIfNeeded();
    await beat();

    const expanding = c.next();
    await reHead.click();
    await expect(reHead).toHaveAttribute('aria-expanded', 'true');
    const lane = await laneLoaded(page, c, atlasId, bo, expanding);
    const boTodo = model.filter(inCell('todo', 'bo'));
    expect(lane.cells.find((cell) => cell.columnId === todo)!.cards.map((m) => m.id)).toEqual(
      boTodo.map((m) => m.id),
    );
    await expect(cellCards(page, todo, bo)).toHaveCount(boTodo.length);
    await expect(cellCards(page, done, bo)).toHaveCount(count(inCell('done', 'bo')));
    await beat();
  });

  await chapter(CHAPTERS[4], async () => {
    await projectsService.setActiveProject({ ...s.ctx, projectId: s.orbit.projectId });
    const orbitId = s.orbit.boardId;
    await openBoard(page, orbitId);
    const since = c.next();
    const board = await groupBy(page, orbitId, 'Epic');
    const lanes = shape(board).lanes;
    // Every epic is a lane. "No epic" is listed only when a card is outside them
    // all, and on Orbit every card is an epic or under one.
    expect(lanes.filter((key) => key !== UNASSIGNED)).toHaveLength(ORBIT_EPICS);

    // The board paints with its first lane's cells in.
    await laneLoaded(page, c, orbitId, lanes[0]!, since);
    const askedAtPaint = new Set(
      c.laneRequests.filter((r) => r.seq > since && r.boardId === orbitId).map((r) => r.laneKey),
    );
    expect(askedAtPaint.size, 'the first paint asked for some lanes, not all').toBeGreaterThan(0);
    expect(askedAtPaint.size).toBeLessThan(lanes.length);
    await beat();

    // A lane further down, not asked for yet, fills as it comes into view.
    const far = lanes[Math.floor(lanes.length / 3)]!;
    expect(askedAtPaint.has(far), `lane ${far} was not asked for at paint`).toBe(false);
    const lane = await laneLoaded(page, c, orbitId, far, since);
    const story = lane.cells.flatMap((cell) => cell.cards).filter((m) => m.kind === 'story');
    expect(story).toHaveLength(1);
    await expect(laneOf(page, far).getByTestId(`board-card-${story[0]!.identifier}`)).toBeVisible();
    const askedAfter = new Set(
      c.laneRequests.filter((r) => r.seq > since && r.boardId === orbitId).map((r) => r.laneKey),
    );
    expect(askedAfter.size, 'still not every lane').toBeLessThan(lanes.length);
    await beat();

    await projectsService.setActiveProject({ ...s.ctx, projectId: s.atlas.projectId });
  });

  await chapter(CHAPTERS[5], async () => {
    const since = c.next();
    atlasReopened = since;
    await openBoard(page, atlasId);
    await laneLoaded(page, c, atlasId, ana, since);
    await laneLoaded(page, c, atlasId, bo, since);
    await laneOf(page, ana).scrollIntoViewIfNeeded();
    const others = [bo, cal, UNASSIGNED];
    const othersBefore = await scrollLefts(page, others);
    const label = main(page).getByTestId(`swimlane-headcontent-${ana}`);
    const labelX = (await label.boundingBox())!.x;

    // The arrow: only Ana's lane moves.
    const arrow = main(page).getByTestId(`swimlane-arrow-right-${ana}`);
    await expect(arrow).toHaveAccessibleName(fill(TB.laneScrollRightAria, { lane: ANA.name }));
    await arrow.click();
    await expect
      .poll(async () => (await scrollLefts(page, [ana]))[0], {
        message: 'the arrow scrolled the lane',
      })
      .toBeGreaterThan(0);
    // Settled: the smooth scroll has stopped moving.
    let afterArrow = -1;
    await expect
      .poll(async () => {
        const now = (await scrollLefts(page, [ana]))[0]!;
        const still = now === afterArrow;
        afterArrow = now;
        return still;
      })
      .toBe(true);
    expect(await scrollLefts(page, others), 'the other lanes stayed put').toEqual(othersBefore);
    expect((await label.boundingBox())!.x, 'the lane label stays pinned').toBeCloseTo(labelX, 0);
    // The pinned header follows the lane just scrolled, so Ana's lane sits AT its
    // offset and draws no strip; a lane left behind is now OFF it, and names its
    // columns itself. Every cell of the scrolled lane still names its column.
    await expect(main(page).getByTestId(`swimlane-strip-${ana}`)).toHaveCount(0);
    const strip = main(page).getByTestId(`swimlane-strip-${bo}`);
    await expect(strip).toBeVisible();
    for (const name of columnNames) await expect(strip).toContainText(name);
    for (const name of columnNames) {
      await expect(scrollerOf(page, ana).getByRole('group', { name, exact: true })).toHaveCount(1);
    }
    await beat();

    // The background drag: a press on an empty cell in view, pulled right (back
    // toward the start the arrow left, so there is always room to pan).
    const point = await scrollerOf(page, ana).evaluate((scroller) => {
      const box = scroller.getBoundingClientRect();
      for (const el of scroller.querySelectorAll<HTMLElement>('[data-testid^="lane-cell-"]')) {
        if (el.querySelector('[data-testid^="board-card-"]')) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        if (x > box.left + 40 && x < box.right - 220) return { x, y: r.top + r.height / 2 };
      }
      return null;
    });
    expect(point, 'an empty cell of the lane is in view').not.toBeNull();
    await page.mouse.move(point!.x, point!.y);
    await page.mouse.down();
    await page.mouse.move(point!.x + 60, point!.y, { steps: 6 });
    await page.mouse.move(point!.x + 180, point!.y, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => (await scrollLefts(page, [ana]))[0], {
        message: 'the drag panned the lane',
      })
      .toBeLessThan(afterArrow);
    expect(await scrollLefts(page, others), 'the other lanes still stayed put').toEqual(
      othersBefore,
    );
    expect((await label.boundingBox())!.x, 'the lane label is still pinned').toBeCloseTo(labelX, 0);
    await expect(strip).toBeVisible();
    await beat();
  });

  await chapter(CHAPTERS[6], async () => {
    const moved = model.find((m) => m.title === MOVED_TITLE)!;
    const target = cellOf(page, inProgress, cal);
    await laneLoaded(page, c, atlasId, cal, atlasReopened);
    await expect(cellCount(page, inProgress, cal)).toHaveText(countText(10, 12));
    const boTodoCount = () => count(inCell('todo', 'bo'));
    await expect(cellCount(page, todo, bo)).toHaveText(countText(boTodoCount(), boTodoCount()));

    // A diagonal drop makes both writes — the move and the reassign — and the
    // page reads nothing back: what the cells show is their own reconciliation.
    const wrote = Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/board/move',
      ),
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' && r.request().headers()['next-action'] !== undefined,
      ),
    ]);
    // Ten loaded cards make the target taller than the screen: drop on its
    // visible middle, not its off-screen centre.
    await dragCardOntoCell(page, `board-card-${moved.identifier}`, target, {
      dropInViewportMiddle: true,
    });
    const [move, reassign] = await wrote;
    expect(move.ok(), 'POST /api/board/move').toBe(true);
    expect(reassign.ok(), 'the reassign').toBe(true);
    moved.status = 'in_progress';
    moved.who = 'cal';

    // Each cell's total follows the move (the loaded part is the cell's own).
    await expect(cellCount(page, todo, bo)).toHaveText(countText(boTodoCount(), boTodoCount()));
    await expect(cellCount(page, inProgress, cal)).toHaveText(/(^| of )13$/);
    await expect(target.getByTestId(`board-card-${moved.identifier}`)).toHaveCount(1);
    await beat();

    // Paging B's In Progress to its end lists the moved card exactly once.
    let page2: BoardCellPageDto;
    do {
      page2 = await pressLoadMore(page, c, atlasId, inProgress, cal);
    } while (page2.cursor !== null);
    await expect(cellCount(page, inProgress, cal)).toHaveText(countText(13, 13));
    await expect(loadMore(page, inProgress, cal)).toHaveCount(0);
    const mounted = await target
      .locator('[data-testid^="board-card-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(mounted.filter((t) => t === `board-card-${moved.identifier}`)).toHaveLength(1);
    expect(new Set(mounted).size, 'no card is listed twice').toBe(mounted.length);

    // The shipped read agrees: the card is In Progress, Cal's, and listed once.
    await expect
      .poll(async () => {
        const full = await getFullBoard(page.request);
        const ip = full.columns.find((col) => col.id === inProgress)!;
        const hits = ip.cards.filter((card) => card.id === moved.id);
        return hits.length === 1 && hits[0]!.assigneeId === cal;
      })
      .toBe(true);
    await beat();
  });

  await chapter(CHAPTERS[7], async () => {
    await laneOf(page, ana).scrollIntoViewIfNeeded();
    const keys = [ana, bo, cal, UNASSIGNED];
    const whoOf = (key: string): Who =>
      key === ana ? 'ana' : key === bo ? 'bo' : key === cal ? 'cal' : null;

    // Apply Priority is High through the toolbar's Advanced filter.
    let since = c.next();
    await page.getByRole('button', { name: /^Advanced/ }).click();
    const dialog = advancedDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: TIV.advancedAddCondition }).click();
    const row = dialog.getByRole('group', { name: 'Condition 1' });
    await row.getByRole('combobox', { name: 'Field' }).click();
    await page.getByRole('option', { name: TIV.advancedFieldPriority, exact: true }).click();
    const filtered = frameOf(page, atlasId, true);
    await row.getByRole('combobox', { name: `${TIV.advancedFieldPriority} values` }).click();
    await page.getByRole('option', { name: HIGH, exact: true }).click();
    const narrowed = await frame(filtered);
    await page.keyboard.press('Escape');
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    for (const key of narrowed.swimlanes.map((l) => l.key)) {
      const lane = await laneLoaded(page, c, atlasId, key, since, true);
      const who = whoOf(key);
      for (const cell of lane.cells) {
        for (const card of cell.cards) expect(card.priority, `${card.identifier}`).toBe('high');
        const status = narrowed.columns.find((col) => col.id === cell.columnId)!.statusKeys;
        expect(cell.totalCount, `High cards in ${cell.columnId} × ${key}`).toBe(
          count((m) => m.who === who && m.priority === 'high' && status.includes(m.status)),
        );
      }
    }
    await laneOf(page, ana).scrollIntoViewIfNeeded();
    const anaHigh = count((m) => m.who === 'ana' && m.priority === 'high' && m.status === 'todo');
    await expect(cellCount(page, todo, ana)).toHaveText(countText(anaHigh, anaHigh));
    await beat();

    // Clear restores every cell.
    since = c.next();
    await page.getByRole('button', { name: /^Advanced/ }).click();
    const cleared = frameOf(page, atlasId, false);
    await advancedDialog(page).getByRole('button', { name: TIV.advancedClearAll }).click();
    await frame(cleared);
    await page.keyboard.press('Escape');
    await expect(advancedDialog(page)).toBeHidden();
    for (const key of keys) {
      const lane = await laneLoaded(page, c, atlasId, key, since, false);
      const who = whoOf(key);
      for (const cell of lane.cells) {
        const status = narrowed.columns.find((col) => col.id === cell.columnId)!.statusKeys;
        expect(cell.totalCount, `every card in ${cell.columnId} × ${key}`).toBe(
          count((m) => m.who === who && status.includes(m.status)),
        );
      }
    }
    await laneOf(page, ana).scrollIntoViewIfNeeded();
    await expect(cellCount(page, todo, ana)).toHaveText(countText(10, 40));
    await beat();

    // The board that keeps its own filter, Kind is Bug: no cell ever holds a card
    // it excludes, paged or not.
    const bugsId = s.atlas.bugsBoardId;
    since = c.next();
    const bugsBoard = await openBoard(page, bugsId);
    const bugCol = shape(bugsBoard).col('todo').id;
    for (const key of bugsBoard.swimlanes.map((l) => l.key)) {
      const lane = await laneLoaded(page, c, bugsId, key, since);
      const who = whoOf(key);
      for (const cell of lane.cells) {
        for (const card of cell.cards) expect(card.kind, `${card.identifier}`).toBe('bug');
        const status = bugsBoard.columns.find((col) => col.id === cell.columnId)!.statusKeys;
        expect(cell.totalCount).toBe(
          count((m) => m.who === who && m.kind === 'bug' && status.includes(m.status)),
        );
      }
    }
    await laneOf(page, ana).scrollIntoViewIfNeeded();
    const anaBugs = count((m) => m.who === 'ana' && m.kind === 'bug' && m.status === 'todo');
    await expect(cellCount(page, bugCol, ana)).toHaveText(countText(10, anaBugs));
    const more = await pressLoadMore(page, c, bugsId, bugCol, ana);
    for (const card of more.cards) expect(card.kind, `${card.identifier}`).toBe('bug');
    await expect(cellCount(page, bugCol, ana)).toHaveText(countText(anaBugs, anaBugs));
    for (const p of c.seen.filter((x) => x.boardId === bugsId)) {
      for (const cell of p.cells) for (const card of cell.cards) expect(card.kind).toBe('bug');
    }
    await beat();
  });

  await chapter(CHAPTERS[8], async () => {
    await openBoard(page, atlasId);
    const since = c.next();
    const flat = await groupBy(page, atlasId, 'None');
    expect(flat.swimlaneGroupBy).toBe('none');
    await expect(main(page).getByTestId('board')).toBeVisible();
    await expect(main(page).getByTestId('swimlane-board')).toHaveCount(0);

    // The flat column pages through its own route, as it always has.
    const todoTotal = count((m) => m.status === 'todo');
    expect(flat.columns.find((col) => col.id === todo)!.cards).toHaveLength(BOARD_PAGE_SIZE);
    await scrollLaneToEnd(page, todo, todoTotal);
    expect(
      c.flatColumnRequests.filter((r) => r.seq > since && r.boardId === atlasId).length,
      'the flat column paged through GET /api/board/columns/[id]/cards',
    ).toBeGreaterThan(0);
    expect(
      c.laneRequests.filter((r) => r.seq > since),
      'no lane page on a flat board',
    ).toEqual([]);
    await expect(main(page).locator('[data-testid^="cell-load-more-"]')).toHaveCount(0);
    await beat();

    // Every cell page the walk saw on Atlas followed its column's own order.
    expectColumnOrder(c, atlasId, await getFullBoard(page.request));
    await beat();
  });

  await chapter(CHAPTERS[9], async () => {
    const control = page.getByRole('group', { name: TB.groupByAria });
    await expect(control).toBeVisible();
    await control.getByRole('button').click();
    for (const label of [TB.groupByNone, TB.groupByAssignee, TB.groupByEpic, TB.groupByPriority]) {
      await expect(page.getByRole('menuitemradio', { name: label, exact: true })).toBeVisible();
    }
    await expect(
      page.getByRole('menuitemradio', { name: TB.groupByNone, exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
    await beat();
    await page.keyboard.press('Escape');

    // Priority: a lane per priority the cards hold.
    await page.evaluate(() =>
      (window as unknown as { __cellPhases: Set<string> }).__cellPhases.clear(),
    );
    let since = c.next();
    const byPriority = await groupBy(page, atlasId, 'Priority');
    const priorities = [...new Set(model.map((m) => m.priority))];
    expect(byPriority.swimlanes.map((l) => l.key).sort()).toEqual([...priorities].sort());
    for (const lane of byPriority.swimlanes) {
      expect(lane.count).toBe(count((m) => m.priority === lane.key));
    }
    await laneLoaded(page, c, atlasId, byPriority.swimlanes[0]!.key, since);
    expect(await phasesSeen(), 'a cell passed through its first-load placeholder').toContain(
      'first-load',
    );
    await beat();

    // Epic: the epic's lane and the "No epic" catch-all.
    since = c.next();
    const byEpic = await groupBy(page, atlasId, 'Epic');
    expect(byEpic.swimlanes.map((l) => l.key)).toEqual([s.epicId, UNASSIGNED]);
    // An epic on the board sits in its own lane, beside the cards under it.
    const inEpicLane = (m: ModelCard) => !!m.underEpic || m.kind === 'epic';
    expect(byEpic.swimlanes[0]!.count).toBe(count(inEpicLane));
    expect(byEpic.swimlanes[1]!.count).toBe(count((m) => !inEpicLane(m)));
    await laneLoaded(page, c, atlasId, s.epicId, since);
    await expect(main(page).getByTestId(`swimlane-head-${s.epicId}`)).toContainText(EPIC_TITLE);
    await beat();

    // Assignee: the "No assignee" catch-all, a collapsed lane, an empty cell.
    since = c.next();
    await groupBy(page, atlasId, 'Assignee');
    const catchAll = await laneLoaded(page, c, atlasId, UNASSIGNED, since);
    expect(catchAll.cells.flatMap((cell) => cell.cards).map((m) => m.id)).toEqual(
      model.filter((m) => m.who === null).map((m) => m.id),
    );
    await expect(laneOf(page, UNASSIGNED)).toBeVisible();
    await beat();

    await laneLoaded(page, c, atlasId, ana, since);
    const empty = cellOf(page, inProgress, ana);
    await expect(empty).toHaveAttribute('data-cell-phase', 'empty');
    await expect(empty).toHaveText(TB.emptyColumn);
    const head = main(page).getByTestId(`swimlane-head-${cal}`);
    await head.scrollIntoViewIfNeeded();
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(head).toHaveAccessibleName(
      fill(TB.laneExpand, { label: CAL.name, count: count((m) => m.who === 'cal') }),
    );
    await expect(main(page).getByTestId(`swimlane-cells-${cal}`)).toHaveCount(0);
    await beat();
    await head.click(); // leave the board as it was found
    await expect(head).toHaveAttribute('aria-expanded', 'true');

    // Every page observed during the walk was bounded, totalled and ordered.
    expectBoundedPages(c);
  });
});

// ═══ The receipt ═════════════════════════════════════════════════════════════

test('the recording declares its story, is paced, and is owned by this spec', async () => {
  test.skip(recordingDir === null, 'the recorded test did not run in this worker');
  const dir = recordingDir!;
  const read = (name: string): unknown => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));

  const chapters = read('chapters.json') as { label: string; tSeconds: number }[];
  expect(chapters.map((ch) => ch.label)).toEqual([...CHAPTERS]);
  const offsets = chapters.map((ch) => ch.tSeconds);
  for (let i = 1; i < offsets.length; i++) {
    expect(offsets[i]!, `chapter ${i + 1} starts after chapter ${i}`).toBeGreaterThan(
      offsets[i - 1]!,
    );
  }

  expect(read('acceptance-story.json')).toEqual({ storyKey: STORY });

  const meta = read('recording-meta.json') as { totalSeconds: number; specFile: string };
  const verdict = assessWatchability({ chapters, meta });
  expect(verdict.watchable, verdict.reason ?? '').toBe(true);
  expect(meta.totalSeconds).toBeGreaterThanOrEqual(MIN_WATCHABLE_SECONDS);
  expect(verdict.medianGapSeconds ?? 0).toBeGreaterThanOrEqual(MIN_MEDIAN_CHAPTER_GAP_SECONDS);

  // Owned the way the uploader resolves it: the changed-spec set names this file.
  expect(meta.specFile).toBe(THIS_SPEC);
  expect(isOwnedRecording(meta, new Set([THIS_SPEC]))).toBe(true);

  // The file as executed: the acceptance harness's test, no module mocked, no
  // product surface stubbed.
  const source = readFileSync(path.join(__dirname, path.basename(THIS_SPEC)), 'utf8');
  expect(source).toContain("from './_helpers/acceptance-video'");
  expect(source).not.toMatch(/import \{[^}]*\b(test|expect)\b[^}]*\} from '@playwright\/test'/);
  const lines = source.split('\n').filter((l) => !l.includes('SELF-AUDIT'));
  // The audit's own list names the stubs, so its line carries the exemption marker.
  const stubs = ['vi.mock', 'page.route(', 'context.route(']; // SELF-AUDIT
  for (const stub of stubs) {
    expect(
      lines.filter((l) => l.includes(stub)),
      `no ${stub}`,
    ).toEqual([]); // SELF-AUDIT
  }
});
