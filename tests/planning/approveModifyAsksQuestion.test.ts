import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { buildScope } from '@/lib/planChange/scope';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemPatch, ProposalInput } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { openTestSession } from '../helpers/planSession';
import { expectEachHopAnnounced } from '../helpers/transitionedEvents';

// ═══════════════════════════════════════════════════════════════════════════
// AN APPROVED `modify` PUTS BACK THE QUESTION ITS CHOICE OR DECISION ASKS (bug
// MOTIR-12159). Real Postgres, through the real plan doors.
// ═══════════════════════════════════════════════════════════════════════════
//
// The reported case is the first one: a plan targeting an asked choice parks it
// (`in_review → planning`, a pull-back that withdraws its `decision_choice` gate),
// the approve rests it at `todo` because its body changed, and nothing asked the
// question again. After the fix the approve reconciles every `modify` target under
// the rule an edit follows: re-asked at the body's current stamp when it parses and
// nothing open blocks it, withdrawn when it stopped being a choice.

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

/** The same choice with its second option renamed — a new stamp. */
const RENAMED = CHOICE.replace('### Our own Postgres', '### Our own database');

/** The same choice with an option that no longer says who it is best for. */
const DEFECTIVE = CHOICE.replace('**Best if you want:** more cost-effective\n', '');

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

let seq = 0;

async function createCard(
  fields: {
    type: 'choice' | 'decision' | 'code';
    executor?: 'human' | 'coding_agent';
    descriptionMd: string;
  },
  blockedBy?: string,
) {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Card ${seq}`,
      type: fields.type,
      executor: fields.executor ?? (fields.type === 'code' ? 'coding_agent' : 'human'),
      descriptionMd: fields.descriptionMd,
      ...(blockedBy ? { links: [{ relationship: 'blocked_by', targetId: blockedBy }] } : {}),
    },
    fx.ctx,
  );
}

const createChoice = (descriptionMd = CHOICE, blockedBy?: string) =>
  createCard({ type: 'choice', descriptionMd }, blockedBy);

type QuestionKind = 'decision_choice' | 'decision_confirmation';

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

const modify = (workItemId: string, patch: PlanItemPatch): ProposalInput => ({
  op: 'modify',
  workItemId,
  patch,
});

/** A plan with no conversation — the MCP / `plan.py` door — planned, not approved. */
async function mcpPlan(proposals: ProposalInput[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** A plan a planning CONVERSATION anchored at `anchorKey` produced — it parks nothing. */
async function conversationPlan(anchorKey: string, proposals: ProposalInput[]): Promise<string> {
  const session = await openTestSession(
    {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    },
    buildScope([anchorKey]),
  );
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Re-plan', session: { sessionId: session.id } },
    fx.ctx,
  );
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

const actor = () => ({ workspaceId: fx.workspaceId, actorId: fx.ownerId });

describe('a choice the plan PARKED (an MCP plan)', () => {
  it(
    'THE REPORTED CASE: renamed options are asked at the new stamp, and the card is back in review',
    async () => {
      const card = await createChoice();
      const [before] = await awaitingOf(card.id);
      expect(card.status).toBe('in_review');

      const planId = await mcpPlan([modify(card.id, { descriptionMd: RENAMED })]);
      // The park withdrew the question — the person must not pick while it is replanned.
      expect(await awaitingOf(card.id)).toHaveLength(0);

      const { hops } = await expectEachHopAnnounced(card.id, actor(), () =>
        plansService.approvePlan(planId, fx.ctx),
      );

      const awaiting = await awaitingOf(card.id);
      expect(awaiting).toHaveLength(1);
      expect(awaiting[0]!.subjectVersion).not.toBe(before!.subjectVersion);
      expect(awaiting[0]!.routedToId).toBe(fx.ownerId);
      expect(await statusOf(card.id)).toBe('in_review');
      // Rested at To Do by the re-scope, then walked to review by declared edges.
      expect(hops).toEqual(
        expect.arrayContaining([
          { fromStatusKey: 'planning', toStatusKey: 'todo' },
          // `todo → in_review` is a declared default edge since MOTIR-12202, so the
          // walk takes it directly rather than passing through In Progress.
          { fromStatusKey: 'todo', toStatusKey: 'in_review' },
        ]),
      );
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a patch that leaves the body alone asks the SAME options again',
    async () => {
      const card = await createChoice();
      const [before] = await awaitingOf(card.id);
      const planId = await mcpPlan([modify(card.id, { priority: 'high' })]);
      await plansService.approvePlan(planId, fx.ctx);

      const awaiting = await awaitingOf(card.id);
      expect(awaiting).toHaveLength(1);
      expect(awaiting[0]!.id).not.toBe(before!.id);
      expect(awaiting[0]!.subjectVersion).toBe(before!.subjectVersion);
      expect(await statusOf(card.id)).toBe('in_review');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a body that stopped parsing asks nothing, and the card rests at To Do',
    async () => {
      const card = await createChoice();
      const planId = await mcpPlan([modify(card.id, { descriptionMd: DEFECTIVE })]);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await awaitingOf(card.id)).toHaveLength(0);
      expect(await statusOf(card.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a choice re-typed to `code` asks nothing any more',
    async () => {
      const card = await createChoice();
      const planId = await mcpPlan([modify(card.id, { type: 'code' })]);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await awaitingOf(card.id)).toHaveLength(0);
      // The status is the re-scope rule's (MOTIR-10102): a re-type is not a
      // re-scope, so the card gets back the status it was parked from.
      expect(await statusOf(card.id)).toBe('in_review');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a choice with an open blocker is not asked, and rests Blocked',
    async () => {
      const blocker = await createCard({ type: 'code', descriptionMd: 'Build the thing.' });
      const card = await createChoice(CHOICE, blocker.id);
      expect(await awaitingOf(card.id)).toHaveLength(0);
      const planId = await mcpPlan([modify(card.id, { descriptionMd: RENAMED })]);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await awaitingOf(card.id)).toHaveLength(0);
      expect(await statusOf(card.id)).toBe('blocked');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a card the plan re-types INTO a complete choice is asked and walked to review',
    async () => {
      const card = await createCard({ type: 'code', descriptionMd: CHOICE });
      const planId = await mcpPlan([modify(card.id, { type: 'choice' })]);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await awaitingOf(card.id)).toHaveLength(1);
      expect(await statusOf(card.id)).toBe('in_review');
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('a `human` decision', () => {
  it(
    'a rewritten record is confirmed again at the new stamp, and the card is back in review',
    async () => {
      const card = await createCard({ type: 'decision', descriptionMd: DECISION });
      const [before] = await awaitingOf(card.id, 'decision_confirmation');
      expect(before).toBeDefined();
      const planId = await mcpPlan([
        modify(card.id, {
          descriptionMd: DECISION.replace('to the bucket', 'to the managed bucket'),
        }),
      ]);
      await plansService.approvePlan(planId, fx.ctx);

      const awaiting = await awaitingOf(card.id, 'decision_confirmation');
      expect(awaiting).toHaveLength(1);
      expect(awaiting[0]!.subjectVersion).not.toBe(before!.subjectVersion);
      expect(await statusOf(card.id)).toBe('in_review');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a decision re-typed to a choice withdraws the confirm question and asks the choice',
    async () => {
      // Re-typed AND given a choice's body, by a plan that does not park it, so
      // the confirm question is still out until the approve withdraws it.
      const card = await createCard({ type: 'decision', descriptionMd: DECISION });
      const planId = await conversationPlan(
        (await createCard({ type: 'code', descriptionMd: 'Anchor.' })).identifier,
        [modify(card.id, { type: 'choice', descriptionMd: CHOICE })],
      );
      await plansService.approvePlan(planId, fx.ctx);

      expect(await awaitingOf(card.id, 'decision_confirmation')).toHaveLength(0);
      expect(await awaitingOf(card.id)).toHaveLength(1);
      expect(await statusOf(card.id)).toBe('in_review');
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('a choice the plan did NOT park (a conversation plan’s non-anchor)', () => {
  it(
    'its OLD question is withdrawn and the new options are asked',
    async () => {
      const anchor = await createCard({ type: 'code', descriptionMd: 'Anchor.' });
      const card = await createChoice();
      const [before] = await awaitingOf(card.id);
      const planId = await conversationPlan(anchor.identifier, [
        modify(card.id, { descriptionMd: RENAMED }),
      ]);
      // Never parked: the old question is still out while the plan is open.
      expect(await awaitingOf(card.id)).toHaveLength(1);
      await plansService.approvePlan(planId, fx.ctx);

      const gates = await gatesOf(card.id);
      expect(gates.find((gate) => gate.id === before!.id)?.state).toBe('superseded');
      const awaiting = gates.filter((gate) => gate.state === 'awaiting');
      expect(awaiting).toHaveLength(1);
      expect(awaiting[0]!.subjectVersion).not.toBe(before!.subjectVersion);
      expect(await statusOf(card.id)).toBe('in_review');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a choice re-typed off `choice` has its old question withdrawn',
    async () => {
      const anchor = await createCard({ type: 'code', descriptionMd: 'Anchor.' });
      const card = await createChoice();
      const planId = await conversationPlan(anchor.identifier, [modify(card.id, { type: 'code' })]);
      expect(await awaitingOf(card.id)).toHaveLength(1);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await awaitingOf(card.id)).toHaveLength(0);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'a choice ANOTHER plan still holds at Planning is left to that hold, and asks nothing yet',
    async () => {
      const anchor = await createCard({ type: 'code', descriptionMd: 'Anchor.' });
      const card = await createChoice();
      await mcpPlan([modify(card.id, { priority: 'high' })]);
      expect(await statusOf(card.id)).toBe('planning');
      const planId = await conversationPlan(anchor.identifier, [
        modify(card.id, { descriptionMd: RENAMED }),
      ]);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('planning');
      expect(await awaitingOf(card.id)).toHaveLength(0);
    },
    DB_TEST_TIMEOUT_MS,
  );
  it(
    'a choice a person moved to Planning by hand, held by nothing, is asked as an edit would ask it',
    async () => {
      const anchor = await createCard({ type: 'code', descriptionMd: 'Anchor.' });
      const card = await createChoice();
      await workItemsService.updateStatus(card.id, 'planning', fx.ctx);
      expect(await awaitingOf(card.id)).toHaveLength(0);
      expect(await adminDb.planTargetLock.count({ where: { workItemId: card.id } })).toBe(0);
      const planId = await conversationPlan(anchor.identifier, [
        modify(card.id, { descriptionMd: RENAMED }),
      ]);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await awaitingOf(card.id)).toHaveLength(1);
      expect(await statusOf(card.id)).toBe('in_review');
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('a card that asks no question', () => {
  it(
    'a `code` card the plan modifies is untouched by the pass',
    async () => {
      const card = await createCard({ type: 'code', descriptionMd: 'Build it.' });
      const planId = await mcpPlan([modify(card.id, { priority: 'high' })]);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);
      expect(await statusOf(card.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );
});
