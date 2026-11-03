import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// The three dispatch-run repositories, against a real Postgres (Story
// MOTIR-1789 · MOTIR-1791). Every method, plus the two arms that only exist
// because of a decision: the SET-shaped write, and a leg whose card is GONE.
//
// Fixtures are seeded through `adminDb` (the owner) and every subject call runs
// inside a `db.$transaction` — the repositories take `tx` on reads as well as
// writes, because the tables are RLS-gated on `app.workspace_id` and a read
// outside a bound transaction returns an empty list rather than an error. The
// tenancy PROOF is `tests/dispatch-run-rls.test.ts`; this file is about the
// operations.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  userId: string;
  workspaceId: string;
  projectId: string;
  storyId: string;
  childAId: string;
  childBId: string;
}

let seq = 0;
function nextPosition(): string {
  seq += 1;
  return `a${seq.toString(36)}`;
}

async function seedFixture(): Promise<Fixture> {
  const tag = `${seq++}`;
  const user = await adminDb.user.create({
    data: { name: 'Yue', email: `yue-${tag}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `moooon ${tag}`, slug: `moooon-${tag}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: org.id, userId: user.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `moooon ${tag}`, slug: `ws-${tag}`, organizationId: org.id },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: user.id, workspaceRole: 'manager' },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Motir ${tag}`,
      slug: `motir-${tag}`,
      identifier: `P${tag}`,
      workspaceId: workspace.id,
    },
  });

  const makeItem = async (kind: 'story' | 'subtask', key: number, parentId?: string) =>
    adminDb.workItem.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        reporterId: user.id,
        kind,
        key,
        identifier: `${project.identifier}-${key}`,
        title: `${kind} ${key}`,
        position: nextPosition(),
        ...(parentId ? { parentId } : {}),
      },
    });

  const story = await makeItem('story', 1);
  const childA = await makeItem('subtask', 2, story.id);
  const childB = await makeItem('subtask', 3, story.id);

  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    storyId: story.id,
    childAId: childA.id,
    childBId: childB.id,
  };
}

/** Run `fn` inside a transaction with the workspace GUC bound, as the app path does. */
async function bound<T>(
  workspaceId: string,
  fn: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

describe('dispatchRunRepository', () => {
  it('opens a run and reads it back with its legs in the run’s own order', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    const runId = await bound(f.workspaceId, async (tx) => {
      const run = await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'run_scope',
          scope: { connect: { id: f.storyId } },
          scopeLabel: 'P1-1',
          agent: 'claude',
          model: 'claude-opus-5',
        },
        tx,
      );
      // The legs are written B-then-A by POSITION on purpose: the read must
      // return the run's OWN order, not insertion order and not key order.
      await dispatchRunCardRepository.createMany(
        [
          {
            workspaceId: f.workspaceId,
            dispatchRunId: run.id,
            workItemId: f.childBId,
            workItemKey: 'P1-3',
            position: 0,
          },
          {
            workspaceId: f.workspaceId,
            dispatchRunId: run.id,
            workItemId: f.childAId,
            workItemKey: 'P1-2',
            position: 1,
          },
        ],
        tx,
      );
      return run.id;
    });

    const read = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.findByIdWithCards(runId, tx),
    );

    expect(read?.command).toBe('run_scope');
    expect(read?.origin).toBe('local');
    expect(read?.status).toBe('running');
    expect(read?.stopReason).toBeNull();
    expect(read?.scopeLabel).toBe('P1-1');
    expect(read?.cards.map((c) => c.workItemKey)).toEqual(['P1-3', 'P1-2']);
  });

  it('names each run’s target by key AND title — the scope, else the first leg (MOTIR-7028)', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    const ids = await bound(f.workspaceId, async (tx) => {
      const open = (data: Record<string, unknown> = {}) =>
        dispatchRunRepository.create(
          {
            workspace: { connect: { id: f.workspaceId } },
            project: { connect: { id: f.projectId } },
            command: 'run',
            ...data,
          },
          tx,
        );
      const scoped = await open({ scope: { connect: { id: f.storyId } }, scopeLabel: 'P-1' });
      const leg = await open();
      const gone = await open();
      const bare = await open();
      await dispatchRunCardRepository.createMany(
        [
          {
            workspaceId: f.workspaceId,
            dispatchRunId: leg.id,
            workItemId: f.childAId,
            workItemKey: 'P-2',
            position: 0,
          },
          // A leg whose card was deleted keeps its key and has no title.
          {
            workspaceId: f.workspaceId,
            dispatchRunId: gone.id,
            workItemId: null,
            workItemKey: 'P-9',
            position: 0,
          },
        ],
        tx,
      );
      return { scoped: scoped.id, leg: leg.id, gone: gone.id, bare: bare.id };
    });

    const targets = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.findTargets(Object.values(ids), tx),
    );
    const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: f.storyId } });
    const childA = await adminDb.workItem.findUniqueOrThrow({ where: { id: f.childAId } });
    expect(targets.get(ids.scoped)).toEqual({ key: story.identifier, title: story.title });
    expect(targets.get(ids.leg)).toEqual({ key: 'P-2', title: childA.title });
    expect(targets.get(ids.gone)).toEqual({ key: 'P-9', title: null });
    expect(targets.has(ids.bare)).toBe(false);
    // No runs, no query.
    expect(await bound(f.workspaceId, (tx) => dispatchRunRepository.findTargets([], tx))).toEqual(
      new Map(),
    );
  });

  it('is idempotent on the open: the same key finds the run rather than making a second', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');

    const first = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'auto',
          idempotencyKey: 'run-abc',
        },
        tx,
      ),
    );

    const found = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.findByIdempotencyKey(f.workspaceId, 'run-abc', tx),
    );
    expect(found?.id).toBe(first.id);

    // And the index REFUSES the second row, which is what makes the read above
    // a guard rather than a hope.
    await expect(
      bound(f.workspaceId, (tx) =>
        dispatchRunRepository.create(
          {
            workspace: { connect: { id: f.workspaceId } },
            project: { connect: { id: f.projectId } },
            command: 'auto',
            idempotencyKey: 'run-abc',
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
  });

  it('lists a card’s run history and a scope’s run history — different questions', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    await bound(f.workspaceId, async (tx) => {
      const run = await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'run_scope',
          scope: { connect: { id: f.storyId } },
        },
        tx,
      );
      await dispatchRunCardRepository.createMany(
        [
          {
            workspaceId: f.workspaceId,
            dispatchRunId: run.id,
            workItemId: f.childAId,
            position: 0,
          },
        ],
        tx,
      );
    });

    const byScope = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByScope(f.storyId, { take: 10 }, tx),
    );
    const scopeAsCard = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByWorkItem(f.storyId, { take: 10 }, tx),
    );
    const childAsCard = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByWorkItem(f.childAId, { take: 10 }, tx),
    );

    expect(byScope).toHaveLength(1);
    // The CONTAINER has no leg of its own, so it does not appear in its own
    // card history — which is exactly why the two reads are not one read.
    expect(scopeAsCard).toHaveLength(0);
    expect(childAsCard).toHaveLength(1);
  });

  it('paginates a card’s run history by cursor, newest first', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    for (let i = 0; i < 3; i += 1) {
      await bound(f.workspaceId, async (tx) => {
        const run = await dispatchRunRepository.create(
          {
            workspace: { connect: { id: f.workspaceId } },
            project: { connect: { id: f.projectId } },
            command: 'run',
            startedAt: new Date(Date.UTC(2026, 7, 20 + i)),
          },
          tx,
        );
        await dispatchRunCardRepository.createMany(
          [
            {
              workspaceId: f.workspaceId,
              dispatchRunId: run.id,
              workItemId: f.childAId,
              position: 0,
            },
          ],
          tx,
        );
      });
    }

    const page1 = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByWorkItem(f.childAId, { take: 2 }, tx),
    );
    expect(page1).toHaveLength(2);
    expect(page1[0]!.startedAt.getTime()).toBeGreaterThan(page1[1]!.startedAt.getTime());

    const page2 = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByWorkItem(f.childAId, { take: 2, cursor: page1[1]!.id }, tx),
    );
    expect(page2).toHaveLength(1);
    expect(page2[0]!.id).not.toBe(page1[0]!.id);
    expect(page2[0]!.id).not.toBe(page1[1]!.id);
  });

  it('narrows a card’s run history by status in the query, not the page (MOTIR-10286)', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    // Oldest first: the only failed run is the OLDEST, behind two newer ones.
    const ids: string[] = [];
    for (const [i, status] of (['failed', 'succeeded', 'running'] as const).entries()) {
      await bound(f.workspaceId, async (tx) => {
        const run = await dispatchRunRepository.create(
          {
            workspace: { connect: { id: f.workspaceId } },
            project: { connect: { id: f.projectId } },
            command: 'run',
            status,
            startedAt: new Date(Date.UTC(2026, 7, 20 + i)),
          },
          tx,
        );
        ids.push(run.id);
        await dispatchRunCardRepository.createMany(
          [
            {
              workspaceId: f.workspaceId,
              dispatchRunId: run.id,
              workItemId: f.childAId,
              position: 0,
            },
          ],
          tx,
        );
      });
    }
    const [failed, succeeded, running] = ids;

    const onlyFailed = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByWorkItem(f.childAId, { take: 1, statuses: ['failed'] }, tx),
    );
    expect(onlyFailed.map((r) => r.id)).toEqual([failed]);

    const two = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByWorkItem(
        f.childAId,
        { take: 10, statuses: ['running', 'failed'] },
        tx,
      ),
    );
    expect(two.map((r) => r.id)).toEqual([running, failed]);

    // An empty list narrows nothing — the same as leaving it out.
    const everything = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByWorkItem(f.childAId, { take: 10, statuses: [] }, tx),
    );
    expect(everything.map((r) => r.id)).toEqual([running, succeeded, failed]);
  });

  it('locks the terminal state FOR UPDATE, and the close is read-derived from it', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');

    const run = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'next',
        },
        tx,
      ),
    );

    const first = await bound(f.workspaceId, async (tx) => {
      const locked = await dispatchRunRepository.findTerminalStateForUpdate(run.id, tx);
      expect(locked?.status).toBe('running');
      expect(locked?.stopReason).toBeNull();
      return dispatchRunRepository.update(
        run.id,
        { status: 'succeeded', stopReason: 'completed', endedAt: new Date() },
        tx,
      );
    });
    expect(first.status).toBe('succeeded');

    // The SECOND closer — the abandoned-run reap — reads a row that is already
    // terminal and returns WITHOUT writing. This is the whole point of the lock:
    // without the guard a clean run ends up recorded as `timed_out`, the one
    // outcome a reader would take as evidence something went wrong.
    const second = await bound(f.workspaceId, async (tx) => {
      const locked = await dispatchRunRepository.findTerminalStateForUpdate(run.id, tx);
      if (locked && locked.status !== 'running') return null;
      return dispatchRunRepository.update(run.id, { status: 'timed_out' }, tx);
    });
    expect(second).toBeNull();

    const after = await bound(f.workspaceId, (tx) => dispatchRunRepository.findById(run.id, tx));
    expect(after?.status).toBe('succeeded');
    expect(after?.stopReason).toBe('completed');
  });

  it('finds the stale running runs the reap sweeps, oldest first', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');

    await bound(f.workspaceId, async (tx) => {
      await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'auto',
          startedAt: new Date(Date.UTC(2026, 0, 1)),
        },
        tx,
      );
      await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'auto',
          startedAt: new Date(Date.UTC(2026, 0, 2)),
        },
        tx,
      );
      // Already closed — the reap must not see it.
      await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'auto',
          status: 'succeeded',
          stopReason: 'drained',
          startedAt: new Date(Date.UTC(2026, 0, 1)),
        },
        tx,
      );
    });

    const stale = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listStaleRunning(new Date(Date.UTC(2026, 0, 3)), 10, tx),
    );
    expect(stale).toHaveLength(2);
    expect(stale[0]!.startedAt.getTime()).toBeLessThan(stale[1]!.startedAt.getTime());
    expect(stale.every((r) => r.status === 'running')).toBe(true);
  });
});

describe('dispatchRunCardRepository', () => {
  it('appends one leg after the fact — the `motir auto` shape — and updates it', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    const leg = await bound(f.workspaceId, async (tx) => {
      const run = await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'auto',
        },
        tx,
      );
      return dispatchRunCardRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          dispatchRun: { connect: { id: run.id } },
          workItem: { connect: { id: f.childAId } },
          workItemKey: 'P1-2',
          position: 0,
        },
        tx,
      );
    });

    expect(leg.disposition).toBe('queued');

    const settled = await bound(f.workspaceId, (tx) =>
      dispatchRunCardRepository.update(
        leg.id,
        { disposition: 'implemented', exitCode: 0, sessionBranch: 'motir/auto-abc' },
        tx,
      ),
    );
    expect(settled.disposition).toBe('implemented');
    expect(settled.sessionBranch).toBe('motir/auto-abc');

    const byPair = await bound(f.workspaceId, (tx) =>
      dispatchRunCardRepository.findByRunAndWorkItem(leg.dispatchRunId, f.childAId, tx),
    );
    expect(byPair?.id).toBe(leg.id);
  });

  it('refuses a skipped leg with no reason, and a reason on a leg that was not skipped', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    const runId = await bound(f.workspaceId, async (tx) => {
      const run = await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'batch',
        },
        tx,
      );
      return run.id;
    });

    // The CHECK constraint, in both directions. A skip with no reason is the one
    // row on a run page that says nothing; a reason on a leg that was not
    // skipped reads as a skip to anyone scanning the column.
    await expect(
      bound(f.workspaceId, (tx) =>
        dispatchRunCardRepository.createMany(
          [
            {
              workspaceId: f.workspaceId,
              dispatchRunId: runId,
              workItemId: f.childAId,
              position: 0,
              disposition: 'skipped',
            },
          ],
          tx,
        ),
      ),
    ).rejects.toThrow();

    await expect(
      bound(f.workspaceId, (tx) =>
        dispatchRunCardRepository.createMany(
          [
            {
              workspaceId: f.workspaceId,
              dispatchRunId: runId,
              workItemId: f.childBId,
              position: 1,
              disposition: 'queued',
              skipReason: 'needs_human',
            },
          ],
          tx,
        ),
      ),
    ).rejects.toThrow();

    const ok = await bound(f.workspaceId, (tx) =>
      dispatchRunCardRepository.createMany(
        [
          {
            workspaceId: f.workspaceId,
            dispatchRunId: runId,
            workItemId: f.childAId,
            position: 0,
            disposition: 'skipped',
            skipReason: 'needs_human',
          },
        ],
        tx,
      ),
    );
    expect(ok).toBe(1);
  });

  it('reads a leg back after its CARD is deleted — every method, no throw', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    const { runId, legId } = await bound(f.workspaceId, async (tx) => {
      const run = await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'run_scope',
          scope: { connect: { id: f.storyId } },
          scopeLabel: 'P1-1',
        },
        tx,
      );
      const leg = await dispatchRunCardRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          dispatchRun: { connect: { id: run.id } },
          workItem: { connect: { id: f.childAId } },
          workItemKey: 'P1-2',
          position: 0,
          disposition: 'implemented',
        },
        tx,
      );
      return { runId: run.id, legId: leg.id };
    });

    // Delete BOTH the leg's card and the run's scope — the two `SET NULL` FKs.
    // `work_item.parentId` RESTRICTS, so the second child goes first; this test
    // is about what the RUN record does when its subjects vanish, not about the
    // tree's own delete rules.
    await adminDb.workItem.delete({ where: { id: f.childAId } });
    await adminDb.workItem.delete({ where: { id: f.childBId } });
    await adminDb.workItem.delete({ where: { id: f.storyId } });

    const run = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.findByIdWithCards(runId, tx),
    );
    expect(run).not.toBeNull();
    expect(run!.scopeWorkItemId).toBeNull();
    // The LABEL survives, which is the whole reason it is stored: the page can
    // still say which story this run was pointed at.
    expect(run!.scopeLabel).toBe('P1-1');
    expect(run!.cards).toHaveLength(1);
    expect(run!.cards[0]!.workItemId).toBeNull();
    expect(run!.cards[0]!.workItemKey).toBe('P1-2');
    expect(run!.cards[0]!.disposition).toBe('implemented');

    // …and the leg is still addressable by its OWN id, which is the address that
    // keeps working after the card is gone.
    const byId = await bound(f.workspaceId, (tx) => dispatchRunCardRepository.findById(legId, tx));
    expect(byId?.workItemId).toBeNull();

    const listed = await bound(f.workspaceId, (tx) =>
      dispatchRunCardRepository.listByRun(runId, tx),
    );
    expect(listed).toHaveLength(1);

    // The run is still reachable from the LIST reads too — an orphaned leg must
    // not make a whole page unreadable.
    const byProject = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByProject(f.projectId, { take: 10 }, tx),
    );
    expect(byProject).toHaveLength(1);
  });

  it('lets two orphaned legs of ONE run coexist — NULLs are distinct in the unique index', async () => {
    const f = await seedFixture();
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');

    const runId = await bound(f.workspaceId, async (tx) => {
      const run = await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'run_scope',
        },
        tx,
      );
      await dispatchRunCardRepository.createMany(
        [
          {
            workspaceId: f.workspaceId,
            dispatchRunId: run.id,
            workItemId: f.childAId,
            position: 0,
          },
          {
            workspaceId: f.workspaceId,
            dispatchRunId: run.id,
            workItemId: f.childBId,
            position: 1,
          },
        ],
        tx,
      );
      return run.id;
    });

    // If the unique index treated NULLs as equal, the SECOND cascade would
    // violate it and the delete would fail — taking a card's deletion hostage to
    // a run that happened months ago.
    await adminDb.workItem.delete({ where: { id: f.childAId } });
    await adminDb.workItem.delete({ where: { id: f.childBId } });

    const legs = await bound(f.workspaceId, (tx) => dispatchRunCardRepository.listByRun(runId, tx));
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.workItemId === null)).toBe(true);
  });
});

describe('dispatchRunEventRepository', () => {
  async function seedRun(f: Fixture): Promise<{ runId: string; legId: string }> {
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');
    return bound(f.workspaceId, async (tx) => {
      const run = await dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'run_scope',
        },
        tx,
      );
      const leg = await dispatchRunCardRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          dispatchRun: { connect: { id: run.id } },
          workItem: { connect: { id: f.childAId } },
          position: 0,
        },
        tx,
      );
      return { runId: run.id, legId: leg.id };
    });
  }

  it('appends a batch, reads it back in `seq` order, and resumes from a cursor', async () => {
    const f = await seedFixture();
    const { runId, legId } = await seedRun(f);
    const { dispatchRunEventRepository } =
      await import('@/lib/repositories/dispatchRunEventRepository');

    const written = await bound(f.workspaceId, (tx) =>
      dispatchRunEventRepository.createMany(
        [
          // Deliberately out of `seq` order on the wire: the read's order is the
          // index's, never the insert's.
          {
            workspaceId: f.workspaceId,
            dispatchRunId: runId,
            seq: 3,
            kind: 'agent_started',
            dispatchRunCardId: legId,
          },
          { workspaceId: f.workspaceId, dispatchRunId: runId, seq: 1, kind: 'run_opened' },
          {
            workspaceId: f.workspaceId,
            dispatchRunId: runId,
            seq: 2,
            kind: 'card_claimed',
            dispatchRunCardId: legId,
          },
        ],
        tx,
      ),
    );
    expect(written).toBe(3);

    const all = await bound(f.workspaceId, (tx) =>
      dispatchRunEventRepository.listSince(runId, 0, 100, tx),
    );
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all.map((e) => e.kind)).toEqual(['run_opened', 'card_claimed', 'agent_started']);

    // `sinceSeq` is EXCLUSIVE — a client that has seen event 1 asks for 1.
    const resumed = await bound(f.workspaceId, (tx) =>
      dispatchRunEventRepository.listSince(runId, 1, 100, tx),
    );
    expect(resumed.map((e) => e.seq)).toEqual([2, 3]);

    const forCard = await bound(f.workspaceId, (tx) =>
      dispatchRunEventRepository.listByCardSince(legId, 0, 100, tx),
    );
    expect(forCard.map((e) => e.seq)).toEqual([2, 3]);

    expect(await bound(f.workspaceId, (tx) => dispatchRunEventRepository.maxSeq(runId, tx))).toBe(
      3,
    );
    expect(
      await bound(f.workspaceId, (tx) => dispatchRunEventRepository.countByRun(runId, tx)),
    ).toBe(3);
  });

  it('converges on a REDELIVERED batch instead of duplicating a stream a client is tailing', async () => {
    const f = await seedFixture();
    const { runId } = await seedRun(f);
    const { dispatchRunEventRepository } =
      await import('@/lib/repositories/dispatchRunEventRepository');

    const batch = [
      { workspaceId: f.workspaceId, dispatchRunId: runId, seq: 1, kind: 'run_opened' as const },
      { workspaceId: f.workspaceId, dispatchRunId: runId, seq: 2, kind: 'run_closed' as const },
    ];

    expect(
      await bound(f.workspaceId, (tx) => dispatchRunEventRepository.createMany(batch, tx)),
    ).toBe(2);
    // The retry writes NOTHING and does not throw — a reporter that timed out
    // has no way to know whether its first attempt landed.
    expect(
      await bound(f.workspaceId, (tx) => dispatchRunEventRepository.createMany(batch, tx)),
    ).toBe(0);
    expect(
      await bound(f.workspaceId, (tx) => dispatchRunEventRepository.countByRun(runId, tx)),
    ).toBe(2);
  });

  it('answers a null `maxSeq` for a run with no events', async () => {
    const f = await seedFixture();
    const { runId } = await seedRun(f);
    const { dispatchRunEventRepository } =
      await import('@/lib/repositories/dispatchRunEventRepository');
    expect(
      await bound(f.workspaceId, (tx) => dispatchRunEventRepository.maxSeq(runId, tx)),
    ).toBeNull();
  });

  it('the retention sweep NULLS bodies and keeps the events', async () => {
    const f = await seedFixture();
    const { runId } = await seedRun(f);
    const { dispatchRunEventRepository } =
      await import('@/lib/repositories/dispatchRunEventRepository');

    await bound(f.workspaceId, (tx) =>
      dispatchRunEventRepository.createMany(
        [
          {
            workspaceId: f.workspaceId,
            dispatchRunId: runId,
            seq: 1,
            kind: 'log',
            body: 'old private output',
            createdAt: new Date(Date.UTC(2026, 0, 1)),
          },
          {
            workspaceId: f.workspaceId,
            dispatchRunId: runId,
            seq: 2,
            kind: 'log',
            body: 'recent private output',
            createdAt: new Date(Date.UTC(2026, 7, 28)),
          },
          {
            workspaceId: f.workspaceId,
            dispatchRunId: runId,
            seq: 3,
            kind: 'run_closed',
            createdAt: new Date(Date.UTC(2026, 0, 1)),
          },
        ],
        tx,
      ),
    );

    const cleared = await bound(f.workspaceId, (tx) =>
      dispatchRunEventRepository.clearBodiesOlderThan(new Date(Date.UTC(2026, 6, 1)), tx),
    );
    // ONE: the old body. The old event with no body is not counted (nothing to
    // clear), and the recent body is inside the window.
    expect(cleared).toBe(1);

    const after = await bound(f.workspaceId, (tx) =>
      dispatchRunEventRepository.listSince(runId, 0, 100, tx),
    );
    // ⚠️ THE ROWS SURVIVE. A sweep that DELETED them would put holes in a stream
    // whose readers resume by cursor, and a reader handed 500 after asking for
    // everything past 400 cannot tell a deleted event from one that has not
    // happened yet.
    expect(after.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(after[0]!.body).toBeNull();
    expect(after[1]!.body).toBe('recent private output');
  });
});

// ── THE CURSOR ARMS (Story MOTIR-1789 · MOTIR-1798) ─────────────────────────
// The story gate measured these three reads at 0% and 83% BRANCH coverage: every
// one is `...(cursor ? { cursor, skip: 1 } : {})`, and only the no-cursor arm had
// ever run. A paging bug lives exactly there — `skip: 1` is what stops a cursor
// page from repeating the row it was anchored on — so the arm that was never
// taken is the one worth taking.

describe('the cursor arms — the half of each paged read that had never run', () => {
  it('a work item’s legs page by cursor, and the anchor row is not repeated', async () => {
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');
    const f = await seedFixture();
    const runIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await bound(f.workspaceId, (tx) =>
        dispatchRunRepository.create(
          {
            workspace: { connect: { id: f.workspaceId } },
            project: { connect: { id: f.projectId } },
            command: 'run',
          },
          tx,
        ),
      );
      runIds.push(run.id);
      await bound(f.workspaceId, (tx) =>
        dispatchRunCardRepository.create(
          {
            workspace: { connect: { id: f.workspaceId } },
            dispatchRun: { connect: { id: run.id } },
            workItem: { connect: { id: f.childAId } },
            workItemKey: 'PROD-2',
            position: 0,
          },
          tx,
        ),
      );
    }

    const first = await bound(f.workspaceId, (tx) =>
      dispatchRunCardRepository.listByWorkItem(f.childAId, { take: 2 }, tx),
    );
    expect(first).toHaveLength(2);

    const next = await bound(f.workspaceId, (tx) =>
      dispatchRunCardRepository.listByWorkItem(f.childAId, { take: 2, cursor: first[1]!.id }, tx),
    );
    // ⚠️ `skip: 1` is the whole point of the arm: the anchor row must NOT come
    // back, or a reader paging a history sees one leg twice.
    expect(next.map((c) => c.id)).not.toContain(first[1]!.id);
    expect(first.concat(next)).toHaveLength(3);
  });

  it('a project’s runs page by cursor, and the status narrowing applies to both arms', async () => {
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const f = await seedFixture();
    for (let i = 0; i < 3; i += 1) {
      await bound(f.workspaceId, (tx) =>
        dispatchRunRepository.create(
          {
            workspace: { connect: { id: f.workspaceId } },
            project: { connect: { id: f.projectId } },
            command: 'batch',
          },
          tx,
        ),
      );
    }

    const page1 = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByProject(f.projectId, { take: 2 }, tx),
    );
    expect(page1).toHaveLength(2);

    const page2 = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByProject(
        f.projectId,
        { take: 2, cursor: page1[1]!.id, statuses: ['running'] },
        tx,
      ),
    );
    // The cursor arm AND the status arm together — the combination a live-filter
    // page actually makes, and the one neither arm's own test reaches.
    expect(page2.map((r) => r.id)).not.toContain(page1[1]!.id);
    expect(page2.every((r) => r.status === 'running')).toBe(true);
  });

  it('a scope’s runs page by cursor too', async () => {
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const f = await seedFixture();
    for (let i = 0; i < 3; i += 1) {
      await bound(f.workspaceId, (tx) =>
        dispatchRunRepository.create(
          {
            workspace: { connect: { id: f.workspaceId } },
            project: { connect: { id: f.projectId } },
            command: 'run_scope',
            scope: { connect: { id: f.storyId } },
          },
          tx,
        ),
      );
    }

    const first = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByScope(f.storyId, { take: 2 }, tx),
    );
    const next = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.listByScope(
        f.storyId,
        { take: 2, cursor: first[1]!.id, statuses: ['running'] },
        tx,
      ),
    );
    expect(next.map((r) => r.id)).not.toContain(first[1]!.id);
  });

  it('`findById` reads one leg back by its own id', async () => {
    const { dispatchRunRepository } = await import('@/lib/repositories/dispatchRunRepository');
    const { dispatchRunCardRepository } =
      await import('@/lib/repositories/dispatchRunCardRepository');
    const f = await seedFixture();
    const run = await bound(f.workspaceId, (tx) =>
      dispatchRunRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          project: { connect: { id: f.projectId } },
          command: 'run',
        },
        tx,
      ),
    );
    const leg = await bound(f.workspaceId, (tx) =>
      dispatchRunCardRepository.create(
        {
          workspace: { connect: { id: f.workspaceId } },
          dispatchRun: { connect: { id: run.id } },
          workItem: { connect: { id: f.childBId } },
          workItemKey: 'PROD-3',
          position: 0,
        },
        tx,
      ),
    );

    const found = await bound(f.workspaceId, (tx) =>
      dispatchRunCardRepository.findById(leg.id, tx),
    );
    expect(found?.id).toBe(leg.id);
    expect(
      await bound(f.workspaceId, (tx) => dispatchRunCardRepository.findById('nope', tx)),
    ).toBeNull();
  });
});
