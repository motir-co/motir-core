import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import type { ProposalInput } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';

// ═══════════════════════════════════════════════════════════════════════════
// RELEASING A PLAN'S HOLD ASKS THE QUESTION AGAIN (bug MOTIR-12163). Real
// Postgres, through the real plan doors.
// ═══════════════════════════════════════════════════════════════════════════
//
// A plan that targets an asked choice parks it (`in_review → planning`), and the
// park is a pull-back: it supersedes the card's `decision_choice` gate
// (`pulled_back`). Declining the plan restored the status and nothing else, so the
// card sat In Review with no question and nothing in Waiting on you. The first case
// below is that exact reproduction. After the fix every release of a plan's hold —
// a decline, a withdraw that empties the plan, the lease sweep — reconciles a
// choice's or a `human` decision's question under the rule an edit follows
// (`choiceGateService.reconcile` / `decisionConfirmationGateService.reconcile`).

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const CHOICE = [
  '## Question',
  'Where do exported reports live?',
  '## Why this is a choice',
  '**Situation:** better than your decision',
  '**You said:** "Keep them in Postgres."',
  'Research found a cheaper store.',
  '## Options',
  '### Managed object storage',
  '**Best if you want:** less to operate',
  'The provider runs it.',
  '### Our own Postgres',
  '**Best if you want:** more cost-effective',
  'No new vendor.',
  '## What this choice gates',
  'The export story.',
].join('\n');

const DECISION = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** workflow · less requirement',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'MOTIR-6 and MOTIR-7',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

type QuestionKind = 'decision_choice' | 'decision_confirmation';

let seq = 0;

async function createCard(
  fields: { type: 'choice' | 'decision' | 'code'; descriptionMd: string },
  blockedBy?: string,
) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Card ${seq}`,
      type: fields.type,
      executor: fields.type === 'code' ? 'coding_agent' : 'human',
      descriptionMd: fields.descriptionMd,
      ...(blockedBy ? { links: [{ relationship: 'blocked_by', targetId: blockedBy }] } : {}),
    },
    fx.ctx,
  );
}

const createChoice = (blockedBy?: string) =>
  createCard({ type: 'choice', descriptionMd: CHOICE }, blockedBy);

async function gatesOf(workItemId: string, kind: QuestionKind = 'decision_choice') {
  return adminDb.approvalGate.findMany({
    where: { workItemId, kind },
    orderBy: { createdAt: 'asc' },
  });
}

async function awaitingOf(workItemId: string, kind: QuestionKind = 'decision_choice') {
  return (await gatesOf(workItemId, kind)).filter((gate) => gate.state === 'awaiting');
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function lockFor(workItemId: string) {
  return adminDb.planTargetLock.findUnique({ where: { workItemId } });
}

const touch = (workItemId: string): ProposalInput => ({
  op: 'modify',
  workItemId,
  patch: { priority: 'high' },
});

/** An MCP plan (no session): the plan itself parks its targets. Still `generating`. */
async function generatingPlan(proposals: ProposalInput[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  return plan.id;
}

async function plannedPlan(proposals: ProposalInput[]): Promise<string> {
  const planId = await generatingPlan(proposals);
  await plansService.markPlanned(planId, fx.ctx);
  return planId;
}

/** Every status hop `act` wrote on the card, each announced exactly once (MOTIR-12164). */
async function hopsDuring(workItemId: string, act: () => Promise<unknown>) {
  const { hops } = await expectEachHopAnnounced(
    workItemId,
    { workspaceId: fx.workspaceId, actorId: fx.ownerId },
    act,
  );
  return hops;
}

describe('DECLINE re-asks a parked question', () => {
  it(
    'THE REPORTED CASE: a declined plan leaves the choice In Review AND asked, at the same stamp',
    async () => {
      const card = await createChoice();
      expect(card.status).toBe('in_review');
      const [before] = await awaitingOf(card.id);
      expect(before).toBeDefined();

      const planId = await plannedPlan([touch(card.id)]);
      // The park withdrew the question while the card is being re-planned.
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
      expect(await awaitingOf(card.id)).toHaveLength(0);
      expect((await gatesOf(card.id))[0]).toMatchObject({
        state: 'superseded',
        supersededCause: 'pulled_back',
      });

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('in_review');
      const awaiting = await awaitingOf(card.id);
      expect(awaiting).toHaveLength(1);
      expect(awaiting[0]!.id).not.toBe(before!.id);
      expect(awaiting[0]!.subjectVersion).toBe(before!.subjectVersion);
      expect(awaiting[0]!.routedToId).toBe(fx.ownerId);
      expect(await lockFor(card.id)).toBeNull();
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    "a `human` decision's confirm question is asked again too",
    async () => {
      const card = await createCard({ type: 'decision', descriptionMd: DECISION });
      const [before] = await awaitingOf(card.id, 'decision_confirmation');
      expect(before).toBeDefined();
      expect(card.status).toBe('in_review');

      const planId = await plannedPlan([touch(card.id)]);
      expect(await awaitingOf(card.id, 'decision_confirmation')).toHaveLength(0);

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('in_review');
      const awaiting = await awaitingOf(card.id, 'decision_confirmation');
      expect(awaiting).toHaveLength(1);
      expect(awaiting[0]!.subjectVersion).toBe(before!.subjectVersion);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a choice whose blocker is still open is given back unasked, exactly as it was',
    async () => {
      const blocker = await createCard({ type: 'code', descriptionMd: 'The blocker.' });
      const card = await createChoice(blocker.id);
      expect(card.status).toBe('todo');
      expect(await gatesOf(card.id)).toHaveLength(0);

      const planId = await plannedPlan([touch(card.id)]);
      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('todo');
      expect(await gatesOf(card.id)).toHaveLength(0);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a card that asks no question is restored and nothing else',
    async () => {
      const card = await createCard({ type: 'code', descriptionMd: 'Build it.' });
      await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

      const planId = await plannedPlan([touch(card.id)]);
      const hops = await hopsDuring(card.id, () => plansService.declinePlan(planId, fx.ctx));

      expect(hops).toEqual([{ fromStatusKey: PLANNING_STATUS_KEY, toStatusKey: 'in_progress' }]);
      expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a hand-parked choice the plan adopted rests at To Do, is asked, and walks to review by declared edges',
    async () => {
      const card = await createChoice();
      // Parked by hand before any plan named it: the pull-back withdrew its question.
      await workItemsService.updateStatus(card.id, PLANNING_STATUS_KEY, fx.ctx);
      expect(await awaitingOf(card.id)).toHaveLength(0);
      const planId = await plannedPlan([touch(card.id)]);
      expect(await lockFor(card.id)).toMatchObject({
        planId,
        priorStatus: PLANNING_STATUS_KEY,
        statusHeld: false,
      });

      const hops = await hopsDuring(card.id, () => plansService.declinePlan(planId, fx.ctx));

      expect(await awaitingOf(card.id)).toHaveLength(1);
      expect(await statusOf(card.id)).toBe('in_review');
      expect(hops).toEqual(
        expect.arrayContaining([
          { fromStatusKey: PLANNING_STATUS_KEY, toStatusKey: 'todo' },
          // `todo → in_review` is a declared default edge since MOTIR-12202, so the
          // walk takes it directly rather than passing through In Progress.
          { fromStatusKey: 'todo', toStatusKey: 'in_review' },
        ]),
      );
      expect(hops).toHaveLength(2);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('every other release of the hold re-asks it too', () => {
  it(
    'a withdraw that empties the plan',
    async () => {
      const card = await createChoice();
      const planId = await generatingPlan([touch(card.id)]);
      expect(await awaitingOf(card.id)).toHaveLength(0);

      await plansService.withdrawProposal(
        planId,
        (await adminDb.planItem.findFirstOrThrow({ where: { planId } })).id,
        fx.ctx,
      );
      await plansService.markPlanned(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('in_review');
      expect(await awaitingOf(card.id)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'the sweep of an abandoned generating plan',
    async () => {
      const card = await createChoice();
      await generatingPlan([touch(card.id)]);
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toEqual([{ workItemId: card.id, outcome: 'restored' }]);
      expect(await statusOf(card.id)).toBe('in_review');
      expect(await awaitingOf(card.id)).toHaveLength(1);
    },
    DB_TEST_TIMEOUT_MS,
  );
});
