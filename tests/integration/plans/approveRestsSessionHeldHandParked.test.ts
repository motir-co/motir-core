import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { buildScope } from '@/lib/planChange/scope';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { openTestSession } from '../../helpers/planSession';

// ═══════════════════════════════════════════════════════════════════════════
// APPROVE RESTS A HAND-PARKED TARGET THAT A CONVERSATION SESSION HOLDS (bug
// MOTIR-8356; `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D6/D8).
// ═══════════════════════════════════════════════════════════════════════════
//
// A plan produced by a CONVERSATION session parks nothing itself — the session
// already holds its anchors (`plansService.addProposals`, `sessionHoldingThisPlan`).
// When the anchor was ALREADY at `planning` — a person or a run parked it by hand
// with `transition_status` before opening the session, which the runbook's *Park
// the target* step does — the session's lock records `priorStatus: 'planning'`,
// `statusHeld: false`, `planId: null`.
//
// `restPlanTargets` reads only the PLAN's locks, and the session release that
// follows an approve answered `left_as_is` for that lock, because the
// hand-park adoption test wanted a plan holder. So the approve changed the card
// and left it at Planning, with the lock row deleted and nothing to move it again.
//
// The control case — a card the SESSION itself parks, so the lock holds a status
// to restore — has always worked and is pinned here so the fix cannot trade one
// for the other.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(
  fx: WorkItemFixture,
  title = 'The card',
): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The old body.' },
    fx.ctx,
  );
  return { id: dto.id, key: dto.identifier };
}

function pctxOf(fx: WorkItemFixture) {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** Open a conversation session anchored on the card, author a `modify` under it
 *  and approve — the shape an `open_plan_session` + `create_plan` walk produces. */
async function approveThroughSession(
  fx: WorkItemFixture,
  card: { id: string; key: string },
): Promise<{ planId: string; sessionId: string }> {
  const session = await openTestSession(pctxOf(fx), buildScope([card.key]));
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Re-plan', session: { sessionId: session.id } },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: card.id, patch: { descriptionMd: 'A different body.' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  return { planId: plan.id, sessionId: session.id };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function lockRows(workItemId: string) {
  return adminDb.planTargetLock.findMany({ where: { workItemId } });
}

describe('approve — a conversation session holding a hand-parked target', () => {
  it('rests the card at To Do and leaves no lock behind', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    // The hand park the runbook performs before it opens the session.
    await workItemsService.updateStatus(card.id, 'planning', fx.ctx);

    const { sessionId } = await approveThroughSession(fx, card);

    // The premise: the session, not the plan, held it, and it moved no status.
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).descriptionMd,
    ).toBe('A different body.');
    expect(await statusOf(card.id)).toBe('todo');
    expect(await lockRows(card.id)).toEqual([]);
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })).endedAt,
    ).not.toBeNull();
  });

  it('rests the card at Blocked while a blocker of it is still open', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx, 'The card');
    const blocker = await seedCard(fx, 'Its blocker');
    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.updateStatus(card.id, 'planning', fx.ctx);

    await approveThroughSession(fx, card);

    expect(await statusOf(card.id)).toBe('blocked');
    expect(await lockRows(card.id)).toEqual([]);
  });

  it('CONTROL: a card the session itself parks still comes back at the status it held', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    await approveThroughSession(fx, card);

    // The session HELD a status (`in_progress`), so the release restores it —
    // the long-standing contract, and not the resting status.
    expect(await statusOf(card.id)).toBe('in_progress');
    expect(await lockRows(card.id)).toEqual([]);
  });

  it('a DECLINE still leaves the hand-parked card where the person put it — only an approve is a decision about it', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await workItemsService.updateStatus(card.id, 'planning', fx.ctx);
    const session = await openTestSession(pctxOf(fx), buildScope([card.key]));
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Re-plan', session: { sessionId: session.id } },
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: card.id, patch: { descriptionMd: 'A different body.' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    await plansService.declinePlan(plan.id, fx.ctx);

    expect(await statusOf(card.id)).toBe('planning');
    expect(await lockRows(card.id)).toEqual([]);
  });

  // MOTIR-9527 / MOTIR-9531 (2026-10-30): the approve committed, its post-commit
  // session release never gave the cards back, and the lock sweep later released
  // the expired lease WITHOUT knowing the plan was approved — `left_as_is`, lock
  // row deleted, both cards at Planning for good. The resting status is an answer
  // only the approve knows, so it has to be written inside the approve's
  // transaction, as `restPlanTargets` writes a plan-held target's.
  it('rests the card inside the approve, so a failed post-commit release cannot strand it', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await workItemsService.updateStatus(card.id, 'planning', fx.ctx);
    vi.spyOn(planTargetLockService, 'releaseForSession').mockRejectedValue(
      new Error('post-commit release lost'),
    );

    await approveThroughSession(fx, card);
    // The sweep reaching the lease after it expired is what stranded the cards.
    await planTargetLockService.releaseExpired(new Date(Date.now() + 2 * 60 * 60 * 1000));

    expect(await statusOf(card.id)).toBe('todo');
    expect(await lockRows(card.id)).toEqual([]);
  });

  it('rests a hand-parked target blocked by another hand-parked target of the same session at Blocked', async () => {
    const fx = await makeWorkItemFixture();
    const first = await seedCard(fx, 'The first card');
    const second = await seedCard(fx, 'The second card');
    await workItemsService.linkWorkItems(
      { fromId: second.id, toId: first.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.updateStatus(first.id, 'planning', fx.ctx);
    await workItemsService.updateStatus(second.id, 'planning', fx.ctx);
    vi.spyOn(planTargetLockService, 'releaseForSession').mockRejectedValue(
      new Error('post-commit release lost'),
    );

    const session = await openTestSession(pctxOf(fx), buildScope([first.key, second.key]));
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Re-plan', session: { sessionId: session.id } },
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: first.id, patch: { descriptionMd: 'A different body.' } },
        { op: 'modify', workItemId: second.id, patch: { descriptionMd: 'Another body.' } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    expect(await statusOf(first.id)).toBe('todo');
    expect(await statusOf(second.id)).toBe('blocked');
    expect(await lockRows(first.id)).toEqual([]);
    expect(await lockRows(second.id)).toEqual([]);
  });
});
