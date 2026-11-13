import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { homeService } from '@/lib/services/homeService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures';
import { setProjectAccess } from '@/tests/helpers/projectAccess';
import { homePageItems } from '../helpers/homePage';

// The Workbench's TO FIX read (Story MOTIR-6588 · MOTIR-6604), over real Postgres.
//
// To fix is In progress's category with `fixReason` set, and In progress is that
// category with it unset — one read, two slices. What is under test is the promise
// that makes that worth doing: every in-progress card the reader owns is on exactly
// one of the two tabs, each count equals its list, and the tab reads only what the
// reader may browse, in their own workspace.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = (fx: WorkItemFixture, projectId: string = fx.projectId) => ({
  ...fx.ctx,
  projectId,
});

const DETAIL = {
  repair: 'fix',
  check: 'Vitest',
  queueReason: null,
  base: null,
  reviewerName: null,
  notePreview: null,
  gate: null,
  affected: 1,
  total: 1,
};

/** A card of the reader's at `status`, with `fixReason` stored as given. */
async function card(
  fx: WorkItemFixture,
  title: string,
  status: string,
  fixReason:
    | 'run_died'
    | 'queue_failed'
    | 'conflicted'
    | 'ci_failed'
    | 'changes_requested'
    | null = null,
) {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status,
      assigneeId: fx.ownerId,
      fixReason,
      ...(fixReason ? { fixDetail: DETAIL } : {}),
    },
  });
  return item;
}

const ids = (page: Parameters<typeof homePageItems>[0]) =>
  homePageItems(page)
    .map((r) => r.id)
    .sort();

describe('To fix and In progress PARTITION the in-progress set', () => {
  it('every in-progress card is on exactly one of the two, over a mixed set', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FIX' });
    const stuck = [
      await card(fx, 'queue', 'implemented', 'queue_failed'),
      await card(fx, 'conflict', 'implemented', 'conflicted'),
      await card(fx, 'red', 'implemented', 'ci_failed'),
      await card(fx, 'sent back', 'in_review', 'changes_requested'),
    ];
    const moving = [
      await card(fx, 'building', 'in_progress'),
      await card(fx, 'green', 'implemented'),
      await card(fx, 'reviewing', 'in_review'),
    ];
    const toDo = await card(fx, 'not started', 'todo');

    const [toFix, inProgress, todo] = await Promise.all([
      homeService.listToFix(hctx(fx)),
      homeService.listInProgress(hctx(fx)),
      homeService.listToDo(hctx(fx)),
    ]);

    expect(ids(toFix)).toEqual(stuck.map((c) => c.id).sort());
    expect(ids(inProgress)).toEqual(moving.map((c) => c.id).sort());
    expect(ids(toFix).filter((id) => ids(inProgress).includes(id))).toEqual([]);
    expect(ids(todo)).toEqual([toDo.id]);
    // The rows carry the stored answer the UI draws.
    expect(toFix.items.find((r) => r.id === stuck[2]!.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: DETAIL,
    });
    expect(
      homePageItems(inProgress).every((r) => r.fixReason === null && r.fixDetail === null),
    ).toBe(true);
  });

  it('the counts equal the lists, and My work still counts everything unfinished', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'CNT' });
    await card(fx, 'a', 'implemented', 'ci_failed');
    await card(fx, 'b', 'in_review', 'changes_requested');
    await card(fx, 'c', 'in_progress');
    await card(fx, 'd', 'todo');

    const [counts, toFix, inProgress, myWork] = await Promise.all([
      homeService.tabCounts(hctx(fx)),
      homeService.listToFix(hctx(fx)),
      homeService.listInProgress(hctx(fx)),
      homeService.listMyWork(hctx(fx)),
    ]);

    expect(counts.toFix).toBe(toFix.total);
    expect(counts.toFix).toBe(2);
    expect(counts.inProgress).toBe(inProgress.total);
    expect(counts.inProgress).toBe(1);
    expect(counts.myWork).toBe(myWork.total);
    expect(counts.myWork).toBe(4);
  });

  it('a stored reason on a card OUTSIDE the in-progress category lists nowhere as To fix', async () => {
    // The recompute never writes one there; the slice does not trust that alone.
    const fx = await makeWorkItemFixture({ identifier: 'OUT' });
    await card(fx, 'done but stale', 'done', 'ci_failed');
    await card(fx, 'todo but stale', 'todo', 'ci_failed');

    expect((await homeService.listToFix(hctx(fx))).total).toBe(0);
    expect((await homeService.tabCounts(hctx(fx))).toFix).toBe(0);
  });

  it('lists by REASON PRIORITY first — run died, queue, conflict, red, sent back (design § 30, Order; § 31)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ORD' });
    // Created in the REVERSE of the priority, so neither id nor kind order can pass it.
    const sentBack = await card(fx, 'sent back', 'in_review', 'changes_requested');
    const red = await card(fx, 'red', 'implemented', 'ci_failed');
    const conflict = await card(fx, 'conflict', 'implemented', 'conflicted');
    const queue = await card(fx, 'queue', 'implemented', 'queue_failed');
    // The enum value was added with `BEFORE 'queue_failed'` (MOTIR-6880): a generated
    // `ADD VALUE` would have sorted it LAST, and this is the read that would show it.
    const died = await card(fx, 'died', 'in_progress', 'run_died');

    const page = await homeService.listToFix(hctx(fx));

    expect(page.items.map((r) => r.id)).toEqual([
      died.id,
      queue.id,
      conflict.id,
      red.id,
      sentBack.id,
    ]);
  });

  it('pages like the other tabs, with the shipped total and clamp', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PGE' });
    for (let i = 0; i < 3; i++) await card(fx, `stuck ${i}`, 'implemented', 'ci_failed');

    const first = await homeService.listToFix(hctx(fx), { limit: 2 });
    const past = await homeService.listToFix(hctx(fx), { limit: 2, page: 9 });

    expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(first.items).toHaveLength(2);
    expect(past).toMatchObject({ total: 3, page: 2 });
    expect(past.items).toHaveLength(1);
  });
});

describe('To fix reads only what the reader may browse', () => {
  it('another workspace’s stuck card is neither listed nor counted', async () => {
    const mine = await makeWorkItemFixture({ identifier: 'MIN' });
    const theirs = await makeWorkItemFixture({ identifier: 'THR' });
    await card(theirs, 'theirs', 'implemented', 'ci_failed');

    // Point the reader at the OTHER workspace's project: the project axis alone must
    // not be what excludes the row.
    const foreign = { ...mine.ctx, projectId: theirs.projectId };
    expect((await homeService.listToFix(foreign)).total).toBe(0);
    expect((await homeService.tabCounts(foreign)).toFix).toBe(0);
  });

  it('a card in a private project the reader is not a member of is neither listed nor counted', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PRV' });
    const outsider = await createTestUser({
      email: `outsider-${Date.now()}@example.com`,
      name: 'Outsider',
    });
    await workspacesService.addMember({
      userId: outsider.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });
    const item = await card(fx, 'private', 'implemented', 'ci_failed');
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: outsider.id } });
    const ctx = { userId: outsider.id, workspaceId: fx.workspaceId, projectId: fx.projectId };
    // Positive control: while the project is open, the outsider sees their card.
    expect((await homeService.listToFix(ctx)).total).toBe(1);

    await setProjectAccess(adminDb, fx.projectId, 'members');

    expect((await homeService.listToFix(ctx)).total).toBe(0);
    expect((await homeService.tabCounts(ctx)).toFix).toBe(0);
  });
});

describe('To fix offers Continue hosted where the reader may edit (§ 31, MOTIR-6882)', () => {
  const DIED = { ...DETAIL, repair: 'continue', check: null, continueKey: null };

  async function dead(
    fx: WorkItemFixture,
    title: string,
    repair: 'continue' | 'none',
    assigneeId?: string,
  ) {
    const item = await card(fx, title, 'in_progress', 'run_died');
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { fixDetail: { ...DIED, repair }, ...(assigneeId ? { assigneeId } : {}) },
    });
    return item;
  }

  it('an editor gets it on a dead run with a branch, and on nothing else', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'CHE' });
    const pushed = await dead(fx, 'pushed', 'continue');
    const nothing = await dead(fx, 'nothing pushed', 'none');
    const red = await card(fx, 'red', 'implemented', 'ci_failed');

    const page = await homeService.listToFix(hctx(fx));
    const flag = (id: string) => page.items.find((r) => r.id === id)?.canContinueHosted;

    expect(flag(pushed.id)).toBe(true);
    expect(flag(nothing.id)).toBe(false);
    expect(flag(red.id)).toBe(false);
  });

  it('a reader who may only browse gets it nowhere — the claim would refuse them', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'CHV' });
    const viewer = await createTestUser({
      email: `viewer-${Date.now()}@example.com`,
      name: 'Viewer',
    });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'viewer',
    });
    await dead(fx, 'theirs to watch', 'continue', viewer.id);
    const ctx = { userId: viewer.id, workspaceId: fx.workspaceId, projectId: fx.projectId };

    const page = await homeService.listToFix(ctx);

    expect(page.total).toBe(1);
    expect(page.items[0]!.canContinueHosted).toBe(false);
  });

  it('other tabs never carry it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'CHO' });
    await card(fx, 'building', 'in_progress');
    const page = await homeService.listInProgress(hctx(fx));
    expect(page.items.every((r) => r.canContinueHosted === false)).toBe(true);
  });
});

describe('To fix offers Fix in Motir agent on a row a REVIEW sent back (§ 32, MOTIR-6930)', () => {
  async function sentBackBy(
    fx: WorkItemFixture,
    title: string,
    gate: 'agent_review' | 'pull_request_approval' | 'acceptance_result',
    assigneeId?: string,
  ) {
    const item = await card(fx, title, 'in_review', 'changes_requested');
    await adminDb.workItem.update({
      where: { id: item.id },
      data: {
        fixDetail: { ...DETAIL, check: null, gate, reviewerName: 'Mei Lin' },
        ...(assigneeId ? { assigneeId } : {}),
      },
    });
    return item;
  }

  it('an editor gets it on the agent’s and a person’s refusal — never on red CI or an acceptance Re-run', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FHE' });
    const agent = await sentBackBy(fx, 'agent', 'agent_review');
    const person = await sentBackBy(fx, 'person', 'pull_request_approval');
    const rerun = await sentBackBy(fx, 'rerun', 'acceptance_result');
    const red = await card(fx, 'red', 'implemented', 'ci_failed');

    const page = await homeService.listToFix(hctx(fx));
    const row = (id: string) => page.items.find((r) => r.id === id)!;

    expect(row(agent.id)).toMatchObject({ canFixHosted: true, repairRun: null });
    expect(row(person.id)).toMatchObject({ canFixHosted: true, repairRun: null });
    expect(row(rerun.id).canFixHosted).toBe(false);
    expect(row(red.id).canFixHosted).toBe(false);
    expect(page.items.every((r) => r.canContinueHosted === false)).toBe(true);
  });

  it('the open repair rides the row — hosted named as hosted — read once for the page', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FHR' });
    const held = await sentBackBy(fx, 'held', 'agent_review');
    const free = await sentBackBy(fx, 'free', 'agent_review');
    const identifier = (
      await adminDb.workItem.findUniqueOrThrow({ where: { id: held.id }, select: { key: true } })
    ).key;
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'fix',
        reportedBy: 'cli',
        cards: [{ key: `${fx.projectIdentifier}-${identifier}`, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await adminDb.dispatchRun.update({ where: { id: run.id }, data: { origin: 'hosted' } });
    // Opening a run is not what this read is about: the card stays the sent-back row.
    await adminDb.workItem.update({
      where: { id: held.id },
      data: {
        status: 'in_review',
        assigneeId: fx.ownerId,
        fixReason: 'changes_requested',
        fixDetail: { ...DETAIL, check: null, gate: 'agent_review', reviewerName: 'Mei Lin' },
      },
    });

    const page = await homeService.listToFix(hctx(fx));
    const row = (id: string) => page.items.find((r) => r.id === id)!;

    expect(row(held.id).repairRun).toMatchObject({
      id: run.id,
      hosted: true,
      byViewer: true,
      holder: { id: fx.ctx.userId },
    });
    expect(row(held.id).repairRun!.label).toMatch(/^motir fix · .+ UTC$/);
    expect(row(free.id).repairRun).toBeNull();
  });

  it('a reader who may only browse gets no door', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FHV' });
    const viewer = await createTestUser({
      email: `fh-viewer-${Date.now()}@example.com`,
      name: 'Viewer',
    });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'viewer',
    });
    await sentBackBy(fx, 'theirs', 'agent_review', viewer.id);
    const page = await homeService.listToFix({
      userId: viewer.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(page.total).toBe(1);
    expect(page.items[0]!.canFixHosted).toBe(false);
  });
});
