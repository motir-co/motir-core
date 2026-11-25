import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// HELD OUT OF PLANNING on every surface that draws the status slot (MOTIR-11546) —
// against REAL Postgres, through the shipped reads.
//
// A childless story blocked by an unfinished STORY that has no subtasks yet can't
// be planned: the planner holds it (motir-ai `src/llm/blockerHold.ts`, rule 1) and
// the Plan button's check refuses it (`lib/planning/plannability.ts`, MOTIR-10544).
// So the roadmap level read reports it `planHeld`, and `isToPlanItem` — the shared
// rule the canvas, the board card, the quick view and the item page all draw from
// — no longer calls it To plan. What it pins:
//   · the level read's `planHeld` for each case of the card's criteria — held, and
//     released by a first subtask, a done-category status or an archive; never held
//     by a story with subtasks, a task or a bug; never with no blocker; never an epic;
//   · the board card and the quick view carry the same answer for the same story;
//   · `plannabilityService.heldStoryIds` is one batched answer, and the click-time
//     check agrees with it card for card.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { plannabilityService } from '@/lib/services/plannabilityService';
import { workItemsService } from '@/lib/services/workItemsService';
import { isToPlanItem } from '@/lib/workItems/statusSlot';
import type { RoadmapNodeDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Kind = 'epic' | 'story' | 'task' | 'bug' | 'subtask';

async function item(kind: Kind, title: string, parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

async function blockedBy(card: { id: string }, blocker: { id: string }) {
  await workItemsService.linkWorkItems(
    { fromId: card.id, toId: blocker.id, kind: 'is_blocked_by' },
    fx.ctx,
  );
}

async function setStatus(target: { id: string }, status: string) {
  await adminDb.workItem.update({ where: { id: target.id }, data: { status } });
}

/** The root level's node for `card`, read fresh — "the next level read". */
async function rootNode(card: { id: string }): Promise<RoadmapNodeDto> {
  const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
  const node = nodes.find((n) => n.id === card.id);
  if (!node) throw new Error(`no root node for ${card.id}`);
  return node;
}

/** The level read's verdict, and the To plan state the shared rule draws from it. */
async function stateOf(card: { id: string }) {
  const node = await rootNode(card);
  return { planHeld: node.planHeld, toPlan: isToPlanItem(node) };
}

const HELD = { planHeld: true, toPlan: false };
const TO_PLAN = { planHeld: false, toPlan: true };

describe('the roadmap level read reports each story held out of planning', () => {
  it(
    'a childless todo story blocked by an open childless story is held, so not To plan',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await item('story', 'Export a sprint report');
      const blocker = await item('story', 'Store each sprint report as a snapshot');
      await blockedBy(card, blocker);

      expect(await stateOf(card)).toEqual(HELD);
      // The blocker itself is blocked by nothing: it is To plan, and it is the one
      // that needs planning first.
      expect(await stateOf(blocker)).toEqual(TO_PLAN);
      // The canvas and the Plan button's check read one rule.
      expect(
        (await plannabilityService.checkPlannable(fx.projectId, card.identifier, fx.ctx)).plannable,
      ).toBe(false);
    },
  );

  it(
    'a Blocked-status story is held the same way — the category, not the key',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await item('story', 'Export a sprint report');
      const blocker = await item('story', 'Not planned yet');
      await setStatus(card, 'blocked');
      await blockedBy(card, blocker);

      expect(await stateOf(card)).toEqual(HELD);
    },
  );

  it(
    'the blocker’s first subtask releases it: To plan again on the next read',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await item('story', 'Export a sprint report');
      const blocker = await item('story', 'Store each sprint report as a snapshot');
      await blockedBy(card, blocker);
      expect(await stateOf(card)).toEqual(HELD);

      await item('subtask', 'Its first subtask', blocker.id);
      expect(await stateOf(card)).toEqual(TO_PLAN);
    },
  );

  it(
    'a finished blocker releases it — done and cancelled alike (the done CATEGORY)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const doneCard = await item('story', 'Waits on a finished story');
      const done = await item('story', 'Finished');
      await blockedBy(doneCard, done);
      const cancelledCard = await item('story', 'Waits on a dropped story');
      const cancelled = await item('story', 'Dropped');
      await blockedBy(cancelledCard, cancelled);
      expect(await stateOf(doneCard)).toEqual(HELD);
      expect(await stateOf(cancelledCard)).toEqual(HELD);

      await setStatus(done, 'done');
      await setStatus(cancelled, 'cancelled');
      expect(await stateOf(doneCard)).toEqual(TO_PLAN);
      expect(await stateOf(cancelledCard)).toEqual(TO_PLAN);
    },
  );

  it('an archived blocker releases it', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await item('story', 'Export a sprint report');
    const blocker = await item('story', 'Set aside');
    await blockedBy(card, blocker);
    expect(await stateOf(card)).toEqual(HELD);

    await workItemsService.archiveWorkItem(blocker.id, fx.ctx);
    expect(await stateOf(card)).toEqual(TO_PLAN);
  });

  it(
    'a story blocked only by a story WITH subtasks, a task or a bug is not held — still To plan',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const planned = await item('story', 'Already broken down');
      await item('subtask', 'Its subtask', planned.id);
      const byStory = await item('story', 'Waits on a planned story');
      await blockedBy(byStory, planned);
      const byTask = await item('story', 'Waits on a task');
      await blockedBy(byTask, await item('task', 'A childless task'));
      const byBug = await item('story', 'Waits on a bug');
      await blockedBy(byBug, await item('bug', 'A childless bug'));

      expect(await stateOf(byStory)).toEqual(TO_PLAN);
      expect(await stateOf(byTask)).toEqual(TO_PLAN);
      expect(await stateOf(byBug)).toEqual(TO_PLAN);
    },
  );

  it(
    'a story with no open blockers is not held, and an epic is never held',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const free = await item('story', 'Nothing in its way');
      const epic = await item('epic', 'A childless epic');
      await blockedBy(epic, await item('story', 'An unplanned story'));

      expect(await stateOf(free)).toEqual(TO_PLAN);
      // The rule holds STORIES only, so the epic keeps its To plan.
      expect(await stateOf(epic)).toEqual(TO_PLAN);
    },
  );

  it(
    'a drilled level carries it too, and a non-story node is never held',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const epic = await item('epic', 'Reporting');
      const card = await item('story', 'Export a sprint report', epic.id);
      const blocker = await item('story', 'Store each sprint report as a snapshot', epic.id);
      const task = await item('task', 'A task under the epic', epic.id);
      await blockedBy(card, blocker);
      await blockedBy(task, blocker);

      const { nodes } = await workItemsService.getProjectRoadmap(fx.projectId, epic.id, fx.ctx);
      const held = new Map(nodes.map((n) => [n.id, n.planHeld]));
      expect(held.get(card.id)).toBe(true);
      expect(held.get(blocker.id)).toBe(false);
      expect(held.get(task.id)).toBe(false);
    },
  );
});

describe('the board card and the quick view carry the same answer', () => {
  it(
    'a held story’s board card and peek are held; a free story’s are not',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await item('story', 'Export a sprint report');
      const blocker = await item('story', 'Store each sprint report as a snapshot');
      await blockedBy(card, blocker);

      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      const cards = new Map(board.columns.flatMap((c) => c.cards).map((c) => [c.id, c]));
      expect(cards.get(card.id)?.planHeld).toBe(true);
      expect(cards.get(blocker.id)?.planHeld).toBe(false);
      expect(isToPlanItem({ ...cards.get(card.id)!, statusCategory: 'todo' })).toBe(false);

      const peek = (identifier: string) =>
        workItemsService.getQuickView(
          fx.projectId,
          identifier,
          fx.project.accessMode,
          fx.ctx,
          'en',
        );
      expect((await peek(card.identifier)).planHeld).toBe(true);
      expect((await peek(blocker.identifier)).planHeld).toBe(false);
    },
  );
});

describe('plannabilityService.heldStoryIds', () => {
  it(
    'answers a whole set in one call, agreeing with the click-time check card for card',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const unplanned = await item('story', 'Unplanned');
      const planned = await item('story', 'Planned');
      await item('subtask', 'Its subtask', planned.id);
      const held = await item('story', 'Held');
      await blockedBy(held, unplanned);
      await blockedBy(held, planned);
      const free = await item('story', 'Free');
      await blockedBy(free, planned);
      const task = await item('task', 'A task');
      await blockedBy(task, unplanned);

      const all = [unplanned, planned, held, free, task];
      const ids = await plannabilityService.heldStoryIds(all, fx.workspaceId);
      expect([...ids]).toEqual([held.id]);
      for (const card of all) {
        const check = await plannabilityService.checkPlannable(
          fx.projectId,
          card.identifier,
          fx.ctx,
        );
        expect(ids.has(card.id)).toBe(!check.plannable);
      }
      expect(await plannabilityService.isHeld(held, fx.workspaceId)).toBe(true);
      expect(await plannabilityService.isHeld(free, fx.workspaceId)).toBe(false);
    },
  );

  it(
    'leaves out the blockers the reader may not see, and reads nothing for no story',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await item('story', 'Export a sprint report');
      const blocker = await item('story', 'Withheld from this reader');
      await blockedBy(card, blocker);

      expect(
        (
          await plannabilityService.heldStoryIds([card], fx.workspaceId, {
            excludeBlockerIds: [blocker.id],
          })
        ).size,
      ).toBe(0);
      expect((await plannabilityService.heldStoryIds([], fx.workspaceId)).size).toBe(0);
      const task = await item('task', 'Not a story');
      expect((await plannabilityService.heldStoryIds([task], fx.workspaceId)).size).toBe(0);
    },
  );
});

// THE TO PLAN STATUS (MOTIR-12234): a card a corrected decision moved into
// `to_plan` (in the `in_progress` category) may already have children. The level
// read computes `planHeld` for it by the same rule, so the canvas's Plan button,
// its blocked tag and the Plan click's check agree about it.
describe('a story in the To plan status', () => {
  it(
    'with children, is held by an open childless story and released by its first subtask — the check agrees',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await item('story', 'Export a sprint report');
      await item('subtask', 'Render the PDF', card.id);
      await setStatus(card, 'to_plan');
      const blocker = await item('story', 'Store each sprint report as a snapshot');
      await blockedBy(card, blocker);

      const held = await rootNode(card);
      expect(held.status).toBe('to_plan');
      expect(held.statusCategory).toBe('in_progress');
      expect(held.hasChildren).toBe(true);
      expect(held.planHeld).toBe(true);
      expect(
        (await plannabilityService.checkPlannable(fx.projectId, card.identifier, fx.ctx)).plannable,
      ).toBe(false);

      await item('subtask', 'Write the snapshot table', blocker.id);
      expect((await rootNode(card)).planHeld).toBe(false);
      // The check does not refuse a card for being in the To plan status.
      expect(
        (await plannabilityService.checkPlannable(fx.projectId, card.identifier, fx.ctx)).plannable,
      ).toBe(true);
    },
  );
});
