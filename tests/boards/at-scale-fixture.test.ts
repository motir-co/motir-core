import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardSwimlaneGroupBy } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { boardsService, BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seedLargeBoard } from '../../scripts/seedLargeBoard';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Subtask 3.5.1 — the at-scale board FIXTURE, unit-level against real Postgres
// (per CLAUDE.md, no mocks): the board-shaped SEED (scripts/seedLargeBoard)
// yields the documented distribution — every column populated (+ a tall one),
// many assignee/epic lanes + their catch-alls, all five priority lanes, and a
// Done-age spread.
//
// MOTIR-10535 retired the cap / Done-age test SEAM this file also pinned (the
// board pages per lane now; there is no cap to override), so the Done-age
// spread is asserted the other way round: aged-out terminal cards are no longer
// trimmed — every one of them pages in.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  identifier: string;
  memberIds: string[];
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'at-scale-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: 'At-scale WS',
    ownerUserId: owner.id,
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    identifier: 'BIG',
  });
  // Four members for the assignee lanes.
  const memberIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = await usersService.createUser({
      email: `at-scale-m${i}@example.com`,
      password: 'hunter2hunter2',
      name: `Member ${i}`,
    });
    await workspacesService.addMember({ userId: m.id, workspaceId: ws.workspace.id });
    memberIds.push(m.id);
  }
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id, identifier: 'BIG', memberIds };
}

async function setGroupBy(projectId: string, groupBy: BoardSwimlaneGroupBy): Promise<void> {
  await adminDb.board.updateMany({ where: { projectId }, data: { swimlaneGroupBy: groupBy } });
}

// Small, fast distribution — round-robins 18 spread cards over the 6 default
// statuses (3 each) + 30 extras into the tall `in_progress` column.
const SMALL_OPTS = {
  epics: 3,
  storiesPerEpic: 4,
  rootStories: 3,
  tallColumnExtra: 30,
  unassignedEvery: 4,
  doneAgedOutEvery: 2,
};

describe('board-shaped large seed distribution (3.5.1)', () => {
  it('populates every column, with one tall column far above the rest', async () => {
    const fx = await makeFixture();
    const manifest = await seedLargeBoard(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectIdentifier: fx.identifier,
        ownerId: fx.ctx.userId,
        memberIds: fx.memberIds,
      },
      SMALL_OPTS,
      adminDb,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    // Every column has cards (none empty) — the whole board is exercised.
    for (const col of board.columns) {
      expect(col.totalCount, `column ${col.name} populated`).toBeGreaterThan(0);
    }
    // The tall column dwarfs every other column (virtualization target).
    const tall = board.columns.find((c) => c.statusKeys.includes(manifest.tallStatusKey))!;
    const others = board.columns.filter((c) => c.id !== tall.id);
    for (const c of others) {
      expect(tall.totalCount, 'tall > others').toBeGreaterThan(c.totalCount);
    }
    expect(tall.totalCount).toBeGreaterThanOrEqual(SMALL_OPTS.tallColumnExtra);
  });

  it('spreads many assignee lanes + an unassigned catch-all', async () => {
    const fx = await makeFixture();
    const manifest = await seedLargeBoard(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectIdentifier: fx.identifier,
        ownerId: fx.ctx.userId,
        memberIds: fx.memberIds,
      },
      SMALL_OPTS,
      adminDb,
    );
    expect(manifest.assigneeCount).toBe(fx.memberIds.length); // every member used
    expect(manifest.unassignedCount).toBeGreaterThan(0);

    await setGroupBy(fx.projectId, BoardSwimlaneGroupBy.assignee);
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    // One lane per assignee-with-cards + the unassigned catch-all (last).
    expect(board.swimlanes.length).toBeGreaterThanOrEqual(fx.memberIds.length + 1);
    expect(board.swimlanes.some((l) => l.key === BOARD_SWIMLANE_NO_VALUE)).toBe(true);
  });

  it('spreads epic lanes + a no-epic catch-all, and all five priority lanes', async () => {
    const fx = await makeFixture();
    await seedLargeBoard(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectIdentifier: fx.identifier,
        ownerId: fx.ctx.userId,
        memberIds: fx.memberIds,
      },
      SMALL_OPTS,
      adminDb,
    );

    await setGroupBy(fx.projectId, BoardSwimlaneGroupBy.epic);
    const epicBoard = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(epicBoard.swimlanes.length).toBeGreaterThanOrEqual(SMALL_OPTS.epics + 1);
    expect(epicBoard.swimlanes.some((l) => l.key === BOARD_SWIMLANE_NO_VALUE)).toBe(true);

    await setGroupBy(fx.projectId, BoardSwimlaneGroupBy.priority);
    const prioBoard = await boardsService.getBoard(fx.projectId, fx.ctx);
    // All five priorities are seeded → five priority lanes (priority has no catch-all).
    expect(prioBoard.swimlanes.length).toBe(5);
  });

  it('seeds a Done-age spread whose aged-out cards still page in (MOTIR-10535)', async () => {
    const fx = await makeFixture();
    const manifest = await seedLargeBoard(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        projectIdentifier: fx.identifier,
        ownerId: fx.ctx.userId,
        memberIds: fx.memberIds,
      },
      SMALL_OPTS,
      adminDb,
    );
    expect(manifest.terminalAgedOut).toBeGreaterThan(0);
    expect(manifest.terminalInWindow).toBeGreaterThan(0);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    // A terminal (done/cancelled) lane pages like any other: the first page is
    // at most BOARD_PAGE_SIZE, and paging to the end reaches EVERY card,
    // aged-out ones included — no Done-age window trims the lane any more.
    const terminalCols = board.columns.filter((c) =>
      c.statusKeys.some((k) => manifest.terminalStatusKeys.includes(k)),
    );
    expect(terminalCols.length).toBeGreaterThan(0);
    let loadedTerminal = 0;
    for (const col of terminalCols) {
      expect(col.cards.length).toBeLessThanOrEqual(BOARD_PAGE_SIZE);
      const ids = new Set(col.cards.map((c) => c.id));
      let cursor = col.cursor;
      while (cursor) {
        const page = await boardsService.getColumnPage(
          fx.projectId,
          fx.ctx,
          board.boardId,
          col.id,
          cursor,
        );
        for (const c of page.cards) ids.add(c.id);
        cursor = page.cursor;
      }
      expect(ids.size, `${col.name} pages to its full count`).toBe(col.totalCount);
      loadedTerminal += ids.size;
    }
    expect(loadedTerminal).toBe(manifest.terminalAgedOut + manifest.terminalInWindow);
  });
});
