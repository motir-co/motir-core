import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// The Board / Backlog FOLDER filter's integration gate (Story MOTIR-11666 ·
// MOTIR-11670) on a REAL Postgres. The story's page subtasks hand the
// project's folders to every builder on the Board, the Backlog and
// Settings › Board, so a person can now build a `folder` condition there; this
// file drives the AST those hosts emit through the shipped reads it reaches:
//
//   board, inline header filter         boardsService.getBoard(…, { ast })
//   board, its STORED filter            boardsService.setBoardFilter → getBoard(no filter)
//   backlog section                     backlogService.getBacklog({ filterAst })
//   a sprint's section                  backlogService.getSprintIssues({ filterAst })
//
// Every expectation is the UNFILTERED read narrowed by the fixture's own
// membership — never a hand-typed id list, and never the read under test — so
// a read that ignored the condition fails, and every filtered set is asserted
// non-empty and strictly smaller than the read it narrows.
//
// Already pinned, cited rather than repeated:
//   Folder is none of a parent folder through getBoard and getBacklog (one
//     operator, the list read's set as the oracle):
//     tests/integration/folders/placementStoryGate.test.ts › 'seam · one set'
//   all four operators, sub-folders, a filed epic's descendants and stale ids
//     on the /items list read and the automation condition:
//     tests/integration/work-items/folder-filter-predicate.test.ts
// Both run unchanged. How a header filter combines with a board's stored
// filter is MOTIR-11564's; the stored-filter cases here read with NO header
// filter.

import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { encodeFilterEnvelope, type FilterAst, type FilterOperatorId } from '@/lib/filters/ast';
import type { BoardProjectionDto } from '@/lib/dto/boards';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function make(
  fx: WorkItemFixture,
  kind: WorkItemKindDto,
  title: string,
  parentId: string | null = null,
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, parentId },
    fx.ctx,
  );
}

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

async function file(fx: WorkItemFixture, workItemId: string, folderId: string) {
  await foldersService.fileWorkItem(workItemId, { folderId }, fx.ctx);
}

const folderAst = (operator: FilterOperatorId, value: string[] | null): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'folder', operator, value }],
});

const sorted = (ids: Iterable<string>) => [...ids].sort();

/**
 * The story's fixture: "Done" ▸ "Oct 2026" and "To do" ▸ "Oct 2026", a task
 * filed in each of the four; an epic filed in "To do" with a story and a
 * subtask under it (filed only through the epic); two unfiled tasks; and a
 * sprint holding the Done ▸ Oct task, the To do ▸ Oct task and one unfiled
 * task. Nine items in all, so the board's one To Do column stays inside its
 * first page (BOARD_PAGE_SIZE, 10) and the unfiltered board IS every item —
 * `boardIds` asserts that whenever it reads unfiltered. Also a
 * folder of ANOTHER project in the same workspace and a folder created then
 * deleted — the two stale ids.
 */
async function seed() {
  const fx = await makeWorkItemFixture();
  const done = await folder(fx, 'Done');
  const doneOct = await folder(fx, 'Oct 2026', done.id);
  const todo = await folder(fx, 'To do');
  const todoOct = await folder(fx, 'Oct 2026', todo.id);

  const doneTask = await make(fx, 'task', 'Shipped export');
  const doneOctTask = await make(fx, 'task', 'Shipped in October');
  const todoTask = await make(fx, 'task', 'Next up');
  const todoOctTask = await make(fx, 'task', 'Next up in October');
  const epic = await make(fx, 'epic', 'Pricing');
  const story = await make(fx, 'story', 'Pricing page', epic.id);
  const subtask = await make(fx, 'subtask', 'Plan table', story.id);
  const loose1 = await make(fx, 'task', 'Unfiled one');
  const loose2 = await make(fx, 'task', 'Unfiled two');
  await file(fx, doneTask.id, done.id);
  await file(fx, doneOctTask.id, doneOct.id);
  await file(fx, todoTask.id, todo.id);
  await file(fx, todoOctTask.id, todoOct.id);
  await file(fx, epic.id, todo.id);

  // The sprint holds one item from a Done folder, one from a To do folder and
  // one unfiled item; the rest stay in the backlog section.
  const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Gate' }, fx.ctx);
  await backlogService.bulkAssignToSprint(
    [doneOctTask.id, todoOctTask.id, loose1.id],
    sprint.id,
    fx.ctx,
  );

  // The two stale ids: another project's folder in the same workspace, and a
  // folder of this project deleted after its id was captured.
  const other = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Other',
    identifier: 'OTHR',
  });
  const foreign = await foldersService.createFolder(
    { projectId: other.id, parentFolderId: null, name: 'Done' },
    fx.ctx,
  );
  const gone = await folder(fx, 'Gone');
  await foldersService.deleteFolder({ projectId: fx.projectId, folderId: gone.id }, fx.ctx);

  // Membership by EFFECTIVE folder — the oracle every expectation narrows by.
  const inDone = new Set([doneTask.id, doneOctTask.id]);
  const inTodo = new Set([todoTask.id, todoOctTask.id, epic.id, story.id, subtask.id]);
  const unfiled = new Set([loose1.id, loose2.id]);

  return {
    fx,
    folders: { done, doneOct, todo, todoOct },
    items: { todoOctTask, story, subtask },
    sprint,
    inDone,
    inTodo,
    unfiled,
    seeded: inDone.size + inTodo.size + unfiled.size,
    staleIds: { foreign: foreign.id, deleted: gone.id },
  };
}

type Seed = Awaited<ReturnType<typeof seed>>;

const cards = (board: BoardProjectionDto) =>
  sorted(board.columns.flatMap((column) => column.cards.map((card) => card.id)));

async function boardIds(s: Seed, ast?: FilterAst, boardId?: string) {
  return cards(
    await boardsService.getBoard(s.fx.projectId, s.fx.ctx, boardId, ast ? { ast } : undefined),
  );
}

/** The unfiltered board — asserted to hold every seeded item, so no column's
 * page cap can hide a card from the oracle. */
async function wholeBoard(s: Seed) {
  const all = await boardIds(s);
  expect(all).toHaveLength(s.seeded);
  return all;
}

async function backlogIds(s: Seed, filterAst?: FilterAst) {
  const page = await backlogService.getBacklog(s.fx.projectId, { limit: 100, filterAst }, s.fx.ctx);
  return sorted(page.items.map((item) => item.id));
}

async function sprintIds(s: Seed, filterAst?: FilterAst) {
  const page = await backlogService.getSprintIssues(
    s.sprint.id,
    { limit: 100, filterAst },
    s.fx.ctx,
  );
  return sorted(page.items.map((item) => item.id));
}

/** `all` narrowed to the ids `keep` accepts — asserted non-vacuous. */
function narrowed(all: string[], keep: (id: string) => boolean): string[] {
  const out = all.filter(keep);
  expect(out.length).toBeGreaterThan(0);
  expect(out.length).toBeLessThan(all.length);
  return out;
}

/** What each operator keeps, by the fixture's membership. */
function keeps(s: Seed) {
  return {
    anyOfTodo: (id: string) => s.inTodo.has(id),
    noneOfDone: (id: string) => !s.inDone.has(id),
    isEmpty: (id: string) => s.unfiled.has(id),
    isNotEmpty: (id: string) => !s.unfiled.has(id),
  };
}

describe('the board read — an inline Folder filter', () => {
  it('is any of “To do” keeps To do, To do › Oct 2026 and the filed epic’s story and subtask', async () => {
    const s = await seed();
    const all = await wholeBoard(s);
    const got = await boardIds(s, folderAst('is_any_of', [s.folders.todo.id]));
    expect(got).toEqual(narrowed(all, keeps(s).anyOfTodo));
    // The sub-folder's task and the epic's descendants are on the board and kept.
    for (const id of [s.items.todoOctTask.id, s.items.story.id, s.items.subtask.id]) {
      expect(all).toContain(id);
      expect(got).toContain(id);
    }
  });

  it('is none of “Done” removes Done and Done › Oct 2026, and keeps unfiled work', async () => {
    const s = await seed();
    const all = await wholeBoard(s);
    const got = await boardIds(s, folderAst('is_none_of', [s.folders.done.id]));
    expect(got).toEqual(narrowed(all, keeps(s).noneOfDone));
    expect(got.some((id) => s.unfiled.has(id))).toBe(true);
  });

  it('is empty and is not empty split the board into unfiled and filed work', async () => {
    const s = await seed();
    const all = await wholeBoard(s);
    const empty = await boardIds(s, folderAst('is_empty', null));
    const notEmpty = await boardIds(s, folderAst('is_not_empty', null));
    expect(empty).toEqual(narrowed(all, keeps(s).isEmpty));
    expect(notEmpty).toEqual(narrowed(all, keeps(s).isNotEmpty));
    expect(empty.filter((id) => notEmpty.includes(id))).toEqual([]);
    expect(sorted([...empty, ...notEmpty])).toEqual(all);
  });
});

describe('the backlog reads — the backlog section and a sprint’s section', () => {
  it('each of the four operators narrows the backlog section by the fixture’s membership', async () => {
    const s = await seed();
    const all = await backlogIds(s);
    const k = keeps(s);
    expect(await backlogIds(s, folderAst('is_any_of', [s.folders.todo.id]))).toEqual(
      narrowed(all, k.anyOfTodo),
    );
    expect(await backlogIds(s, folderAst('is_none_of', [s.folders.done.id]))).toEqual(
      narrowed(all, k.noneOfDone),
    );
    const empty = await backlogIds(s, folderAst('is_empty', null));
    const notEmpty = await backlogIds(s, folderAst('is_not_empty', null));
    expect(empty).toEqual(narrowed(all, k.isEmpty));
    expect(notEmpty).toEqual(narrowed(all, k.isNotEmpty));
    expect(empty.filter((id) => notEmpty.includes(id))).toEqual([]);
    expect(sorted([...empty, ...notEmpty])).toEqual(all);
  });

  it('a sprint’s items narrow the same way: is none of “Done”, is any of “To do”', async () => {
    const s = await seed();
    const all = await sprintIds(s);
    expect(all).toHaveLength(3);
    const k = keeps(s);
    expect(await sprintIds(s, folderAst('is_none_of', [s.folders.done.id]))).toEqual(
      narrowed(all, k.noneOfDone),
    );
    expect(await sprintIds(s, folderAst('is_any_of', [s.folders.todo.id]))).toEqual(
      narrowed(all, k.anyOfTodo),
    );
  });
});

describe('the board’s STORED filter', () => {
  it('a stored Folder is none of “Done” narrows the board read with no header filter, and clearing it restores the board', async () => {
    const s = await seed();
    const all = await wholeBoard(s);
    const { boardId } = await boardsService.getBoard(s.fx.projectId, s.fx.ctx);

    const saved = await boardsService.setBoardFilter(
      boardId,
      encodeFilterEnvelope(folderAst('is_none_of', [s.folders.done.id])),
      s.fx.ctx,
    );
    expect(saved.filter).not.toBeNull();
    const got = await boardIds(s, undefined, boardId);
    expect(got).toEqual(narrowed(all, keeps(s).noneOfDone));
    expect(got.some((id) => s.unfiled.has(id))).toBe(true);

    await boardsService.setBoardFilter(boardId, null, s.fx.ctx);
    expect(await boardIds(s, undefined, boardId)).toEqual(all);
  });
});

describe('stale folder ids — deleted, or another project’s', () => {
  it.each(['deleted', 'foreign'] as const)(
    'a %s folder id in is any of matches nothing on the board, the backlog and a stored filter, and raises no error',
    async (which) => {
      const s = await seed();
      const id = s.staleIds[which];
      const ast = folderAst('is_any_of', [id]);
      await wholeBoard(s);
      expect(await boardIds(s, ast)).toEqual([]);
      expect((await backlogIds(s)).length).toBeGreaterThan(0);
      expect(await backlogIds(s, ast)).toEqual([]);

      const { boardId } = await boardsService.getBoard(s.fx.projectId, s.fx.ctx);
      // The write accepts the stale id rather than refusing it …
      const saved = await boardsService.setBoardFilter(
        boardId,
        encodeFilterEnvelope(ast),
        s.fx.ctx,
      );
      expect(saved.filter).not.toBeNull();
      // … and the board then reads empty, flagging the condition stale.
      const board = await boardsService.getBoard(s.fx.projectId, s.fx.ctx, boardId);
      expect(cards(board)).toEqual([]);
      expect(board.storedFilter?.staleConditions).toEqual([
        expect.objectContaining({ index: 0, field: 'folder' }),
      ]);
    },
  );
});
