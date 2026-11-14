import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { homeService } from '@/lib/services/homeService';
import { boardsService } from '@/lib/services/boardsService';
import {
  fixGroupPointersFor,
  fixHeadKeysFor,
  fixTagFactsFor,
  fixTagFieldsOf,
  NO_FIX_TAG_FACTS,
} from '@/lib/services/fixGroupService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures';

// TO FIX keyed by RUN (MOTIR-7589; `design/workbench/design-notes.md` § 34, work-items
// § _ONE ENTRY PER RUN_), over real Postgres.
//
// The cards on the tab are unchanged — the slice decides them — but the tab lists, pages
// and counts ENTRIES: the cards stuck for one reason that one repair clears, under the
// card the repair runs on. The entry key is stored with the reason
// (`fixDetail.groupKey`); these tests store it directly, so what is under test is the
// READ: grouping, the head rule, members the reader does not hold, the count, the pager,
// and the pointers the tag and the banner draw from.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = (fx: WorkItemFixture) => ({ ...fx.ctx, projectId: fx.projectId });

const DETAIL = {
  repair: 'fix',
  check: 'Vitest',
  queueReason: null,
  base: null,
  reviewerName: null,
  notePreview: null,
  gate: null,
  reviewRef: null,
  lastHeardAt: null,
  ranByName: null,
  branch: null,
  branches: null,
  pushed: null,
  continueKey: null,
  diedReason: null,
  affected: 1,
  total: 1,
};

type Reason = 'run_died' | 'ci_failed' | 'changes_requested';

/** A card at `status`, stuck for `reason` in entry `groupKey` (null: a legacy row). */
async function stuck(
  fx: WorkItemFixture,
  opts: {
    title: string;
    groupKey: string | null;
    reason?: Reason;
    kind?: 'story' | 'task';
    parentId?: string;
    assigneeId?: string | null;
    reporterId?: string;
    status?: string;
  },
) {
  const item = await createTestWorkItem(fx, {
    kind: opts.kind ?? 'task',
    title: opts.title,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
  const reason = opts.reason ?? 'ci_failed';
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status: opts.status ?? 'implemented',
      assigneeId: opts.assigneeId === undefined ? fx.ownerId : opts.assigneeId,
      ...(opts.reporterId ? { reporterId: opts.reporterId } : {}),
      fixReason: reason,
      fixDetail: {
        ...DETAIL,
        ...(reason === 'run_died' ? { repair: 'continue', pushed: true } : {}),
        ...(opts.groupKey === null ? {} : { groupKey: opts.groupKey }),
      },
    },
  });
  return item;
}

/** Somebody else, holding cards the reader does not. */
async function stranger(fx: WorkItemFixture) {
  const user = await createTestUser({ email: `other-${Math.random()}@example.com`, name: 'Ada' });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: fx.workspaceId, userId: user.id, workspaceRole: 'member' },
  });
  return user;
}

/** A dead run over `legs`, pointed at `scope` (null: a single-card run). */
async function deadRun(
  fx: WorkItemFixture,
  scope: { id: string } | null,
  legs: readonly { id: string; identifier: string }[],
) {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: scope ? 'run_scope' : 'run',
      scopeWorkItemId: scope?.id ?? null,
      status: 'failed',
    },
  });
  await adminDb.dispatchRunCard.createMany({
    data: legs.map((leg, position) => ({
      workspaceId: fx.workspaceId,
      dispatchRunId: run.id,
      workItemId: leg.id,
      workItemKey: leg.identifier,
      position,
    })),
  });
  return run;
}

describe('a pull-request entry — every card one set delivers is ONE entry', () => {
  it('lists the head once with its members, counts ONE, and the head is the ancestor', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PRS' });
    const other = await stranger(fx);
    const story = await stuck(fx, { title: 'the story', kind: 'story', groupKey: 'prs:aaa' });
    const mine = await stuck(fx, { title: 'leg one', groupKey: 'prs:aaa', parentId: story.id });
    // A member the reader neither holds nor filed: still drawn under the entry.
    const theirs = await stuck(fx, {
      title: 'leg two',
      groupKey: 'prs:aaa',
      parentId: story.id,
      assigneeId: other.id,
      reporterId: other.id,
    });

    const [page, counts] = await Promise.all([
      homeService.listToFix(hctx(fx)),
      homeService.tabCounts(hctx(fx)),
    ]);

    expect(page.total).toBe(1);
    expect(counts.toFix).toBe(1);
    // My work still counts the reader's CARDS (the story and their leg), not entries.
    expect(counts.myWork).toBe(2);
    expect(page.items).toHaveLength(1);
    const [entry] = page.items;
    expect(entry).toMatchObject({ id: story.id, fixGroupKind: 'prs', fixReason: 'ci_failed' });
    // The reader's own member first, then the rest by key.
    expect(entry!.fixMembers.map((m) => m.id)).toEqual([mine.id, theirs.id]);
    expect(entry!.fixMembers[1]).toMatchObject({
      viewerIsAssignee: false,
      viewerIsReporter: false,
    });
  });

  it('with no ancestor among the members, the head is the lowest key', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'LOW' });
    const first = await stuck(fx, { title: 'one', groupKey: 'prs:bbb' });
    const second = await stuck(fx, { title: 'two', groupKey: 'prs:bbb' });

    const page = await homeService.listToFix(hctx(fx));

    expect(page.items.map((r) => r.id)).toEqual([first.id]);
    expect(page.items[0]!.fixMembers.map((m) => m.id)).toEqual([second.id]);
  });

  it('is on the reader’s tab when they hold only a member, and the head’s role reads none', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MEM' });
    const other = await stranger(fx);
    const story = await stuck(fx, {
      title: 'their story',
      kind: 'story',
      groupKey: 'prs:ccc',
      assigneeId: other.id,
      reporterId: other.id,
    });
    const mine = await stuck(fx, { title: 'my leg', groupKey: 'prs:ccc', parentId: story.id });

    const page = await homeService.listToFix(hctx(fx));

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: story.id,
      viewerIsAssignee: false,
      viewerIsReporter: false,
    });
    expect(page.items[0]!.fixMembers.map((m) => m.id)).toEqual([mine.id]);
  });
});

describe('a dead run’s entry — the run’s scope card heads it', () => {
  it('heads with the scope even when the scope itself is not stuck, borrowing the members’ reason', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'RUN' });
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    await adminDb.workItem.update({
      where: { id: story.id },
      data: { status: 'in_progress', assigneeId: fx.ownerId },
    });
    const legs = [];
    for (const title of ['b leg', 'a leg']) {
      legs.push(await createTestWorkItem(fx, { kind: 'task', title, parentId: story.id }));
    }
    // Legs in RUN order: the second card created is the run's FIRST leg.
    const run = await deadRun(fx, story, [legs[1]!, legs[0]!]);
    for (const leg of legs) {
      await adminDb.workItem.update({
        where: { id: leg.id },
        data: {
          status: 'in_progress',
          assigneeId: fx.ownerId,
          fixReason: 'run_died',
          fixDetail: {
            ...DETAIL,
            repair: 'continue',
            continueKey: story.identifier,
            groupKey: `run:${run.id}`,
          },
        },
      });
    }

    const page = await homeService.listToFix(hctx(fx));

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: story.id,
      fixGroupKind: 'run',
      fixReason: 'run_died',
      fixDetail: expect.objectContaining({ continueKey: story.identifier }),
    });
    expect(page.items[0]!.fixMembers.map((m) => m.id)).toEqual([legs[1]!.id, legs[0]!.id]);
  });

  it('a single-card run (no scope) is headed by its one leg, which stands alone', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ONE' });
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'alone' });
    const run = await deadRun(fx, null, [card]);
    await adminDb.workItem.update({
      where: { id: card.id },
      data: {
        status: 'in_progress',
        assigneeId: fx.ownerId,
        fixReason: 'run_died',
        fixDetail: { ...DETAIL, repair: 'continue', groupKey: `run:${run.id}` },
      },
    });

    const page = await homeService.listToFix(hctx(fx));

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: card.id, fixGroupKind: 'run', fixMembers: [] });
  });
});

describe('a card alone, and a row stored before the key existed', () => {
  it('a legacy row with no key is its own entry, exactly as before', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'OLD' });
    const a = await stuck(fx, { title: 'a', groupKey: null });
    const b = await stuck(fx, { title: 'b', groupKey: null });

    const page = await homeService.listToFix(hctx(fx));

    expect(page.total).toBe(2);
    expect(page.items.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(page.items.every((r) => r.fixGroupKind === 'card' && r.fixMembers.length === 0)).toBe(
      true,
    );
  });
});

describe('the pager pages ENTRIES, never splitting one', () => {
  it('the total and the windows count entries, and every member rides its head', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PAG' });
    const head = await stuck(fx, { title: 'head', groupKey: 'prs:ddd' });
    for (const t of ['m1', 'm2', 'm3']) await stuck(fx, { title: t, groupKey: 'prs:ddd' });
    await stuck(fx, { title: 'alone 1', groupKey: null });
    await stuck(fx, { title: 'alone 2', groupKey: null });

    const first = await homeService.listToFix(hctx(fx), { limit: 2 });
    const second = await homeService.listToFix(hctx(fx), { limit: 2, page: 2 });

    expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(second).toMatchObject({ total: 3, page: 2 });
    const all = [...first.items, ...second.items];
    expect(all).toHaveLength(3);
    expect(all.find((r) => r.id === head.id)?.fixMembers).toHaveLength(3);
  });
});

describe('the pointers the tag and the banner draw from', () => {
  it('name the head for a carried card, the carried cards for the head, and nothing for a card alone', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PTR' });
    const story = await stuck(fx, { title: 'story', kind: 'story', groupKey: 'prs:eee' });
    const leg = await stuck(fx, { title: 'leg', groupKey: 'prs:eee', parentId: story.id });
    const alone = await stuck(fx, { title: 'alone', groupKey: null });

    const heads = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      fixHeadKeysFor(fx.workspaceId, [story.id, leg.id, alone.id], tx),
    );
    expect([...heads]).toEqual([[leg.id, story.identifier]]);

    const pointers = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      fixGroupPointersFor(
        fx.workspaceId,
        [{ id: alone.id, projectId: fx.projectId, fixReason: null, fixDetail: null }],
        tx,
      ),
    );
    expect(pointers.get(alone.id)).toBeNull();
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        fixHeadKeysFor(fx.workspaceId, [], tx),
      ),
    ).toEqual(new Map());

    const headDetail = await workItemsService.getIssueDetail(
      fx.projectId,
      story.identifier,
      fx.ctx,
    );
    const legDetail = await workItemsService.getIssueDetail(fx.projectId, leg.identifier, fx.ctx);
    const aloneDetail = await workItemsService.getIssueDetail(
      fx.projectId,
      alone.identifier,
      fx.ctx,
    );
    expect(headDetail.fixGroup).toEqual({
      kind: 'prs',
      headKey: story.identifier,
      isHead: true,
      carriedKeys: [leg.identifier],
    });
    expect(legDetail.fixGroup).toMatchObject({ headKey: story.identifier, isHead: false });
    expect(aloneDetail.fixGroup).toBeNull();
  });

  it('the /items list and the board carry the head key on a carried card only', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'LST' });
    const story = await stuck(fx, { title: 'story', kind: 'story', groupKey: 'prs:fff' });
    const leg = await stuck(fx, { title: 'leg', groupKey: 'prs:fff', parentId: story.id });

    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: { column: 'key', direction: 'asc' } },
      fx.ctx,
    );
    expect(list.items.find((r) => r.id === leg.id)?.fixHeadKey).toBe(story.identifier);
    expect(list.items.find((r) => r.id === story.id)?.fixHeadKey).toBeUndefined();

    const tree = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);
    const storyNode = tree.find((n) => n.id === story.id);
    expect(storyNode?.fixHeadKey).toBeUndefined();
    expect(storyNode?.children.find((n) => n.id === leg.id)?.fixHeadKey).toBe(story.identifier);
  });
});

// FIXING on the tag (Story MOTIR-10305 · MOTIR-10309): the rows carry only `fixReason`, so
// the stored `fixDetail.fixing` reaches the List, the Tree, the board and the quick view
// through the same one post-read lookup the head key uses — and only as `fixing: true`.
describe('the Fixing flag the tag draws from (MOTIR-10309)', () => {
  async function fixing(fx: WorkItemFixture, title: string, groupKey: string | null = null) {
    const item = await stuck(fx, { title, groupKey });
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { fixDetail: { ...(row.fixDetail as object), fixing: true } },
    });
    return item;
  }

  it('reads Fixing from the stored detail, beside the head key, in one lookup', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FXG' });
    const story = await stuck(fx, { title: 'story', kind: 'story', groupKey: 'prs:ggg' });
    const leg = await stuck(fx, { title: 'leg', groupKey: 'prs:ggg', parentId: story.id });
    const pushed = await fixing(fx, 'pushed');
    const plain = await stuck(fx, { title: 'plain', groupKey: null });

    const facts = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      fixTagFactsFor(fx.workspaceId, [story.id, leg.id, pushed.id, plain.id], tx),
    );
    expect([...facts.headKeys]).toEqual([[leg.id, story.identifier]]);
    expect([...facts.fixingIds]).toEqual([pushed.id]);
    expect(fixTagFieldsOf(pushed.id, facts)).toEqual({ fixing: true });
    expect(fixTagFieldsOf(leg.id, facts)).toEqual({ fixHeadKey: story.identifier });
    expect(fixTagFieldsOf(plain.id, facts)).toEqual({});
    expect(fixTagFieldsOf(plain.id, NO_FIX_TAG_FACTS)).toEqual({});
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        fixTagFactsFor(fx.workspaceId, [], tx),
      ),
    ).toEqual(NO_FIX_TAG_FACTS);
  });

  it('a dead run is never Fixing, whatever its detail says', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FXD' });
    const dead = await stuck(fx, { title: 'dead', groupKey: null, reason: 'run_died' });
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: dead.id } });
    await adminDb.workItem.update({
      where: { id: dead.id },
      data: { fixDetail: { ...(row.fixDetail as object), fixing: true } },
    });
    const facts = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      fixTagFactsFor(fx.workspaceId, [dead.id], tx),
    );
    expect(facts.fixingIds.size).toBe(0);
  });

  it('the /items list, the tree, the board and the quick view carry it on the Fixing card only', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FXS' });
    const pushed = await fixing(fx, 'pushed');
    const plain = await stuck(fx, { title: 'plain', groupKey: null });

    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: { column: 'key', direction: 'asc' } },
      fx.ctx,
    );
    expect(list.items.find((r) => r.id === pushed.id)?.fixing).toBe(true);
    expect(list.items.find((r) => r.id === plain.id)).not.toHaveProperty('fixing');

    const tree = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);
    expect(tree.find((n) => n.id === pushed.id)?.fixing).toBe(true);
    expect(tree.find((n) => n.id === plain.id)).not.toHaveProperty('fixing');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const cards = board.columns.flatMap((c) => c.cards);
    expect(cards.find((c) => c.id === pushed.id)?.fixing).toBe(true);
    expect(cards.find((c) => c.id === plain.id)).not.toHaveProperty('fixing');

    const peek = await workItemsService.getQuickView(
      fx.projectId,
      pushed.identifier,
      'workspace',
      fx.ctx,
      'en',
    );
    expect(peek.fixing).toBe(true);
    const plainPeek = await workItemsService.getQuickView(
      fx.projectId,
      plain.identifier,
      'workspace',
      fx.ctx,
      'en',
    );
    expect(plainPeek).not.toHaveProperty('fixing');
  });
});
