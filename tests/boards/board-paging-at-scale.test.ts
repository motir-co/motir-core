import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { boardsService, BOARD_PAGE_SIZE } from '@/lib/services/boardsService';
import { keyForAppend } from '@/lib/workItems/positioning';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { connectRepairRepo } from '../helpers/repairFixtures';

// MOTIR-10535 — the board at the size that broke it. A 2,830-card project made
// `GET /api/board` answer 500 (P2028): the review-state read ran over EVERY
// card in one interactive transaction and overran Prisma's 5 s budget. Paging
// per lane bounds every per-card batch by lanes × BOARD_PAGE_SIZE, so:
//
//   1. a 3,000-card board whose every card carries a pull request and an
//      awaiting agent-review gate (the review-state read's heaviest shape)
//      answers, with at most BOARD_PAGE_SIZE cards per lane and the FULL count;
//   2. the number of statements the board read (and a lane's next page) sends
//      does not grow with the board — the same on 60 cards as on 3,000.
//
// Real Postgres, rows written in bulk through `adminDb` (the fixture is not the
// behaviour under test).

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const LANES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const;

/** `perLane` cards in each of {@link LANES}, every one delivered by an open pull
 * request and holding an awaiting agent-review gate. */
async function seedBoard(fx: WorkItemFixture, perLane: number): Promise<void> {
  const repo = await connectRepairRepo(fx, `repo-${fx.projectIdentifier.toLowerCase()}`);
  let position: string | null = null;
  const rows = LANES.flatMap((status, lane) =>
    Array.from({ length: perLane }, (_, i) => {
      const key = 1000 + lane * perLane + i;
      return {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task' as const,
        key,
        identifier: `${fx.projectIdentifier}-${key}`,
        title: `Card ${key}`,
        status,
        reporterId: fx.ownerId,
        position: (position = keyForAppend(position)),
      };
    }),
  );
  const items = await adminDb.workItem.createManyAndReturn({
    data: rows,
    select: { id: true, key: true },
  });
  const prs = await adminDb.githubPullRequest.createManyAndReturn({
    data: items.map((w) => ({
      repoId: repo.id,
      number: w.key,
      state: 'open',
      headRef: `card-${w.key}`,
      baseRef: 'main',
      title: `Deliver ${w.key}`,
    })),
    select: { id: true, number: true },
  });
  const prByNumber = new Map(prs.map((p) => [p.number, p.id]));
  await adminDb.workItemDelivery.createMany({
    data: items.map((w) => ({
      workspaceId: fx.workspaceId,
      workItemId: w.id,
      githubPullRequestId: prByNumber.get(w.key)!,
      repoId: repo.id,
    })),
  });
  await adminDb.approvalGate.createMany({
    data: items.map((w) => ({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: w.id,
      kind: 'agent_review' as const,
      subjectId: w.id,
      state: 'awaiting' as const,
    })),
  });
}

/** Every statement the pg driver sends, minus the transaction's own frames. */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(pg.Client.prototype, 'query');
  try {
    await fn();
    return spy.mock.calls.filter(([q]) => {
      const text = typeof q === 'string' ? q : ((q as { text?: string })?.text ?? '');
      return !/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(text);
    }).length;
  } finally {
    spy.mockRestore();
  }
}

describe('the board read at scale (MOTIR-10535)', () => {
  it('a 3,000-card board with a delivery and a gate on every card answers one page per lane', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BIG' });
    await seedBoard(fx, 600);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    for (const status of LANES) {
      const lane = board.columns.find((c) => c.statusKeys[0] === status)!;
      expect(lane.totalCount, `${status} full count`).toBe(600);
      expect(lane.cards, `${status} first page`).toHaveLength(BOARD_PAGE_SIZE);
      expect(lane.cursor, `${status} has more`).not.toBeNull();
    }
    const loaded = board.columns.reduce((n, c) => n + c.cards.length, 0);
    expect(loaded).toBeLessThanOrEqual(board.columns.length * BOARD_PAGE_SIZE);

    // ...and a deep page answers too.
    const done = board.columns.find((c) => c.statusKeys[0] === 'done')!;
    const page = await boardsService.getColumnPage(
      fx.projectId,
      fx.ctx,
      board.boardId,
      done.id,
      done.cursor!,
    );
    expect(page.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(page.totalCount).toBe(600);
  });

  it('sends the same number of statements for 60 cards as for 3,000 — board read and next page', async () => {
    const small = await makeWorkItemFixture({ identifier: 'SML', name: 'Small' });
    await seedBoard(small, 12);
    const big = await makeWorkItemFixture({ identifier: 'LRG', name: 'Large' });
    await seedBoard(big, 600);

    // Warm both once so a one-time lookup (a cached catalog, a first-use
    // statement) is not counted against either side.
    const smallBoard = await boardsService.getBoard(small.projectId, small.ctx);
    const bigBoard = await boardsService.getBoard(big.projectId, big.ctx);

    const smallRead = await countQueries(() => boardsService.getBoard(small.projectId, small.ctx));
    const bigRead = await countQueries(() => boardsService.getBoard(big.projectId, big.ctx));
    expect(smallRead).toBeGreaterThan(0);
    expect(bigRead).toBe(smallRead);

    const laneOf = (b: typeof smallBoard) => b.columns.find((c) => c.statusKeys[0] === 'todo')!;
    const smallPage = await countQueries(() =>
      boardsService.getColumnPage(
        small.projectId,
        small.ctx,
        smallBoard.boardId,
        laneOf(smallBoard).id,
        laneOf(smallBoard).cursor!,
      ),
    );
    const bigPage = await countQueries(() =>
      boardsService.getColumnPage(
        big.projectId,
        big.ctx,
        bigBoard.boardId,
        laneOf(bigBoard).id,
        laneOf(bigBoard).cursor!,
      ),
    );
    expect(smallPage).toBeGreaterThan(0);
    expect(bigPage).toBe(smallPage);
  });
});
