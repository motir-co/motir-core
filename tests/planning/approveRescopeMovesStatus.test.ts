import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { buildScope } from '@/lib/planChange/scope';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemPatch, ProposalInput } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { openTestSession } from '../helpers/planSession';

// ═══════════════════════════════════════════════════════════════════════════
// THE RE-SCOPE MOVE (bug MOTIR-10102) — approving a plan that rewrites a card's
// title, description or repository takes that card out of `implemented` /
// `in_review` / `approved`: to `blocked` with an open blocker after materialize,
// else `in_progress` while a run is working it, else `todo`. For EVERY card the
// plan modifies — a conversation plan's non-anchor, a session-parked anchor and an
// MCP plan's parked target alike — and a patch that changes anything else gives
// the card back the status it held.
// ═══════════════════════════════════════════════════════════════════════════
//
// The reported case is the first one below: a CONVERSATION plan parks nothing,
// its session holds only its anchors, so a `modify` of any other card was never
// parked, never rested and never moved — MOTIR-5780 stayed `implemented` with a
// new body and three open blockers.

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(title: string): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The old body.' },
    fx.ctx,
  );
  return { id: dto.id, key: dto.identifier };
}

/** A card at `status`, walked there through the legal edges. */
async function cardAt(status: string, title = `card at ${status}`) {
  const card = await seedCard(title);
  const walk: Record<string, string[]> = {
    todo: [],
    in_progress: ['in_progress'],
    implemented: ['in_progress', 'implemented'],
    in_review: ['in_progress', 'in_review'],
    approved: ['in_progress', 'in_review', 'approved'],
    done: ['in_progress', 'done'],
  };
  for (const hop of walk[status]!) await workItemsService.updateStatus(card.id, hop, fx.ctx);
  return card;
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/** Every status move on a card after `since`, oldest first. */
async function statusTrailSince(id: string, since: Date) {
  const revisions = await adminDb.workItemRevision.findMany({
    where: { workItemId: id, changeKind: 'updated', changedAt: { gte: since } },
    orderBy: { changedAt: 'asc' },
  });
  return revisions
    .map((r) => (r.diff as Record<string, unknown>).status)
    .filter((cell): cell is { from: string; to: string } => Boolean(cell));
}

/** Open a run that is WORKING `workItemId` — an open leg on a running run. */
async function liveRunOn(workItemId: string, command: 'run' | 'fix' | 'review' = 'run') {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command,
      createdById: fx.ownerId,
    },
  });
  await adminDb.dispatchRunCard.create({
    data: {
      workspaceId: fx.workspaceId,
      dispatchRunId: run.id,
      workItemId,
      position: 0,
      disposition: 'running',
      startedAt: new Date(),
    },
  });
}

function pctx() {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** A plan a planning CONVERSATION anchored at `anchor` produced, carrying
 *  `proposals` — planned, not yet approved. */
async function conversationPlan(
  anchor: { key: string },
  proposals: ProposalInput[],
): Promise<string> {
  const session = await openTestSession(pctx(), buildScope([anchor.key]));
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Re-plan', session: { sessionId: session.id } },
    fx.ctx,
  );
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** A plan with no conversation — the MCP / `plan.py` door — planned, not approved. */
async function mcpPlan(proposals: ProposalInput[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

const modify = (workItemId: string, patch: PlanItemPatch): ProposalInput => ({
  op: 'modify',
  workItemId,
  patch,
});

/** The status row the review shows for `workItemId`'s `modify`, if any. */
async function reviewStatusRow(planId: string, workItemId: string) {
  const review = await planReviewService.getPlanReview(planId, fx.ctx);
  const item = review.items.find((i) => i.op === 'modify' && i.nodeId === workItemId)!;
  return item.changes.find((c) => c.field === 'status');
}

const RESCOPED_WHILE = (label: string) =>
  `To Do, Blocked, or In Progress (re-scoped while ${label}; decided when this plan is approved)`;

describe('a conversation plan — the modified card is NOT one of its anchors', () => {
  it(
    'THE REPORTED CASE: an `implemented` card re-scoped with new open blockers lands at Blocked',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const anchor = await cardAt('todo', 'The anchor');
      const card = await cardAt('implemented', 'The re-scoped card');
      const blockerA = await cardAt('todo', 'New prerequisite A');
      const blockerB = await cardAt('todo', 'New prerequisite B');
      const planId = await conversationPlan(anchor, [
        modify(card.id, {
          title: 'The re-scoped card, rewritten',
          descriptionMd: 'Work that is not built yet.',
          blockedByAdd: [blockerA.id, blockerB.id],
        }),
      ]);
      // The premise: the conversation's plan parked nothing, so the card still
      // reads `implemented` and no lock names it.
      expect(await statusOf(card.id)).toBe('implemented');
      expect(await adminDb.planTargetLock.count({ where: { workItemId: card.id } })).toBe(0);
      expect(await reviewStatusRow(planId, card.id)).toEqual({
        field: 'status',
        from: 'Implemented',
        to: RESCOPED_WHILE('Implemented'),
      });

      const before = new Date();
      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('blocked');
      expect(await statusTrailSince(card.id, before)).toEqual([
        { from: 'implemented', to: 'blocked' },
      ]);
    },
  );

  it.each([['implemented'], ['in_review'], ['approved']])(
    'a `%s` card whose description changed lands at To Do',
    async (status) => {
      const anchor = await cardAt('todo', 'The anchor');
      const card = await cardAt(status);
      const planId = await conversationPlan(anchor, [
        modify(card.id, { descriptionMd: 'A different body.' }),
      ]);

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a re-scoped card a run is working lands at In Progress — and a REVIEW run is not one',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const anchor = await cardAt('todo', 'The anchor');
      const worked = await cardAt('implemented', 'Being repaired');
      const reviewed = await cardAt('in_review', 'Being reviewed');
      await liveRunOn(worked.id, 'fix');
      await liveRunOn(reviewed.id, 'review');
      const planId = await conversationPlan(anchor, [
        modify(worked.id, { title: 'Re-scoped while a fix runs' }),
        modify(reviewed.id, { title: 'Re-scoped while a review reads it' }),
      ]);

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(worked.id)).toBe('in_progress');
      expect(await statusOf(reviewed.id)).toBe('todo');
    },
  );

  it(
    'a re-scope with a live run AND an open blocker lands at Blocked — the blocker wins',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const anchor = await cardAt('todo', 'The anchor');
      const card = await cardAt('implemented');
      const blocker = await cardAt('todo', 'Its new prerequisite');
      await liveRunOn(card.id);
      const planId = await conversationPlan(anchor, [
        modify(card.id, { descriptionMd: 'New.', blockedByAdd: [blocker.id] }),
      ]);

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('blocked');
    },
  );

  it.each<[string, PlanItemPatch]>([
    ['type', { type: 'design' }],
    ['estimateMinutes', { estimateMinutes: 90 }],
    ['storyPoints', { storyPoints: 5 }],
    ['priority', { priority: 'high' }],
    ['explanationMd', { explanationMd: 'A new why.' }],
    ['edges', { blockedByAdd: [] }],
  ])(
    'a %s-only patch leaves an `implemented` card where it is, and the review shows no move',
    async (label, patch) => {
      const anchor = await cardAt('todo', 'The anchor');
      const card = await cardAt('implemented');
      let effective = patch;
      if (label === 'edges') {
        const blocker = await cardAt('todo', 'A new prerequisite');
        effective = { blockedByAdd: [blocker.id] };
      }
      const planId = await conversationPlan(anchor, [modify(card.id, effective)]);
      expect(await reviewStatusRow(planId, card.id)).toBeUndefined();

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('implemented');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a card that does not claim built work keeps its status, re-scoped or not',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const anchor = await cardAt('todo', 'The anchor');
      const started = await cardAt('in_progress', 'Started');
      const fresh = await cardAt('todo', 'Not started');
      const planId = await conversationPlan(anchor, [
        modify(started.id, { descriptionMd: 'New.' }),
        modify(fresh.id, { descriptionMd: 'New.' }),
      ]);
      expect(await reviewStatusRow(planId, started.id)).toBeUndefined();

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(started.id)).toBe('in_progress');
      expect(await statusOf(fresh.id)).toBe('todo');
    },
  );

  it('a MARK-ONLY modify leaves a `done` card done', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const anchor = await cardAt('todo', 'The anchor');
    const done = await cardAt('done', 'Shipped');
    const planId = await conversationPlan(anchor, [
      modify(done.id, { obsolescence: 'outdated', obsolescenceNoteMd: 'Superseded.' }),
    ]);
    expect(await reviewStatusRow(planId, done.id)).toBeUndefined();

    await plansService.approvePlan(planId, fx.ctx);

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: done.id } });
    expect(row.status).toBe('done');
    expect(row.obsolescence).toBe('outdated');
  });

  it(
    'a card ANOTHER plan holds at Planning is given its new status on that hold, not on the card',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const anchor = await cardAt('todo', 'The anchor');
      const card = await cardAt('implemented');
      // An undecided MCP plan parks it first.
      await mcpPlan([modify(card.id, { priority: 'high' })]);
      expect(await statusOf(card.id)).toBe('planning');
      const planId = await conversationPlan(anchor, [
        modify(card.id, { descriptionMd: 'A different body.' }),
      ]);
      expect(await reviewStatusRow(planId, card.id)).toEqual({
        field: 'status',
        from: 'Planning',
        to: RESCOPED_WHILE('Implemented'),
      });

      await plansService.approvePlan(planId, fx.ctx);

      // Still held — the other plan is undecided — and the hold now gives back
      // `todo`, never the `implemented` the new body made false.
      expect(await statusOf(card.id)).toBe('planning');
      const lock = await adminDb.planTargetLock.findUniqueOrThrow({
        where: { workItemId: card.id },
      });
      expect(lock.priorStatus).toBe('todo');
    },
  );
});

describe('a conversation plan — the modified card IS its anchor, parked by the session', () => {
  it(
    'an `implemented` anchor whose body changed is given back at To Do, not Implemented',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const anchor = await cardAt('implemented', 'The anchor');
      const planId = await conversationPlan(anchor, [
        modify(anchor.id, { descriptionMd: 'A different body.' }),
      ]);
      // The session parked it, from `implemented`.
      expect(await statusOf(anchor.id)).toBe('planning');
      expect(await reviewStatusRow(planId, anchor.id)).toEqual({
        field: 'status',
        from: 'Planning',
        to: RESCOPED_WHILE('Implemented'),
      });

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(anchor.id)).toBe('todo');
      expect(await adminDb.planTargetLock.count({ where: { workItemId: anchor.id } })).toBe(0);
    },
  );

  it(
    'CONTROL: a priority-only change gives the anchor back at Implemented, as the review says',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const anchor = await cardAt('implemented', 'The anchor');
      const planId = await conversationPlan(anchor, [modify(anchor.id, { priority: 'high' })]);
      expect(await reviewStatusRow(planId, anchor.id)).toEqual({
        field: 'status',
        from: 'Planning',
        to: 'Implemented (returned when this plan is approved)',
      });

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(anchor.id)).toBe('implemented');
    },
  );
});

describe('an MCP plan — every target parked by its own append', () => {
  it(
    'a re-scoped `implemented` target a run is working lands at In Progress',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await cardAt('implemented');
      await liveRunOn(card.id);
      const planId = await mcpPlan([modify(card.id, { title: 'Re-scoped' })]);
      expect(await reviewStatusRow(planId, card.id)).toEqual({
        field: 'status',
        from: 'Planning',
        to: RESCOPED_WHILE('Implemented'),
      });

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('in_progress');
      expect(await adminDb.planTargetLock.count({ where: { workItemId: card.id } })).toBe(0);
    },
  );

  it(
    'a container the plan lays NEW children under still rests at To Do, whatever its own patch',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const container = await cardAt('implemented', 'A built container');
      const planId = await mcpPlan([
        modify(container.id, { priority: 'high' }),
        {
          op: 'add',
          parentRef: container.id,
          proposedFields: { kind: 'subtask', title: 'Unbuilt child', type: 'code' },
        },
      ]);
      expect(await reviewStatusRow(planId, container.id)).toMatchObject({
        to: 'To Do or Blocked (returned when this plan is approved)',
      });

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(container.id)).toBe('todo');
    },
  );
});
