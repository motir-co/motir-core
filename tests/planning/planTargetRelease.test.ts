import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { RESTING_BLOCKED_KEY, RESTING_TODO_KEY, restingStatusFor } from '@/lib/plans/restingStatus';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// RELEASE BY PLAN, AND THE RESTING STATUS (MOTIR-5646), bug MOTIR-5640 — against
// a REAL Postgres, through `plansService.approvePlan` / `declinePlan`.
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D6–D8. This is the half
// the product owner asked for:
//
//   "when the plan is accepted, the status is changed back to To Do or Blocked."
//
// ⚠️ THE ONE LINE THIS FILE EXISTS FOR. `releasePlanTargetLocks` used to open
// with `if (!plan.sourceJobId) return;`, and `sourceJobId` is null for EVERY
// MCP-authored plan — which is every runbook planning pass. So a card parked by
// `motir plan` was released by nothing, for ever, and no sweep reached it either
// because a hand-parked card had no lock row to expire. The first case below is
// that exact reproduction.

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

async function seedCard(title = 'The card'): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The old body.' },
    fx.ctx,
  );
  return dto.id;
}

/** Put a card at `status` directly — the statuses past `implemented` are written
 *  by CI and by gates, not by a person's move. */
async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function lockCount(workItemId: string): Promise<number> {
  return adminDb.planTargetLock.count({ where: { workItemId } });
}

/** An MCP-authored plan (`sourceJobId` null) with one `modify`, closed and ready
 *  to decide. */
async function plannedModify(
  workItemId: string,
  patch: Record<string, unknown> = { descriptionMd: 'Re-scoped.' },
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

describe('restingStatusFor — the pure decision (D6–D8)', () => {
  it('rests a parked target at Blocked when a blocker is open, else at To Do', () => {
    expect(
      restingStatusFor({ archived: false, currentStatus: 'planning', hasOpenBlocker: true }),
    ).toEqual({ write: true, toKey: RESTING_BLOCKED_KEY });
    expect(
      restingStatusFor({ archived: false, currentStatus: 'planning', hasOpenBlocker: false }),
    ).toEqual({ write: true, toKey: RESTING_TODO_KEY });
  });

  it('writes NOTHING for an archived target — a `remove`d card is claimed by nothing', () => {
    expect(
      restingStatusFor({ archived: true, currentStatus: 'planning', hasOpenBlocker: false }),
    ).toEqual({ write: false, reason: 'archived' });
  });

  it('writes NOTHING when a person moved it out of `planning` — that is a MANUAL release', () => {
    expect(
      restingStatusFor({ archived: false, currentStatus: 'in_progress', hasOpenBlocker: false }),
    ).toEqual({ write: false, reason: 'moved_by_hand' });
  });
});

describe('approve — an MCP plan with NO source job releases its own targets', () => {
  it(
    'a card parked from `in_progress` with an OPEN blocker rests at Blocked, and the lock is gone',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const blocker = await seedCard('An open blocker');
      await workItemsService.linkWorkItems(
        { fromId: card, toId: blocker, kind: 'is_blocked_by' },
        fx.ctx,
      );
      await setStatus(card, 'in_progress');

      const planId = await plannedModify(card);
      // The reproduction: this plan has no source job at all.
      expect(
        (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sourceJobId,
      ).toBeNull();
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe(RESTING_BLOCKED_KEY);
      expect(await lockCount(card)).toBe(0);
    },
  );

  it(
    'the same card with every blocker DONE rests at To Do — not back at `in_progress`',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const blocker = await seedCard('A finished blocker');
      await workItemsService.linkWorkItems(
        { fromId: card, toId: blocker, kind: 'is_blocked_by' },
        fx.ctx,
      );
      await setStatus(blocker, 'done');
      await setStatus(card, 'in_progress');

      await plansService.approvePlan(await plannedModify(card), fx.ctx);

      // ⚠️ NOT `in_progress`. Restoring the PRIOR status is what the release used
      // to do, and it is wrong here: the body just changed, so a card claiming
      // work is under way on it would be claiming the old body's work.
      expect(await statusOf(card)).toBe(RESTING_TODO_KEY);
      expect(await lockCount(card)).toBe(0);
    },
  );

  it(
    'a target the plan REMOVES is archived and takes no status write (D7 row 1)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'in_progress');

      const plan = await plansService.createPlan(fx.projectId, { title: 'Supersede' }, fx.ctx);
      await plansService.addProposals(plan.id, [{ op: 'remove', workItemId: card }], fx.ctx);
      await plansService.markPlanned(plan.id, fx.ctx);
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);

      await plansService.approvePlan(plan.id, fx.ctx);

      const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card } });
      expect(after.archivedAt).not.toBeNull();
      // Left at `planning`, deliberately: an archived row is claimed by nothing,
      // and writing a status onto it would be a claim about work that is gone.
      expect(after.status).toBe(PLANNING_STATUS_KEY);
      expect(await lockCount(card)).toBe(0);
    },
  );

  it(
    'a CONTAINER that gained child `add`s rests at To Do (D7 row 3)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const parent = (
        await workItemsService.createWorkItem(
          { projectId: fx.projectId, kind: 'story', title: 'The container' },
          fx.ctx,
        )
      ).id;
      const plan = await plansService.createPlan(fx.projectId, { title: 'Lay' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [
          {
            op: 'add',
            parentRef: parent,
            proposedFields: { title: 'A new child', kind: 'task' },
          },
        ],
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      expect(await statusOf(parent)).toBe(PLANNING_STATUS_KEY);

      await plansService.approvePlan(plan.id, fx.ctx);

      expect(await statusOf(parent)).toBe(RESTING_TODO_KEY);
      expect(await lockCount(parent)).toBe(0);
    },
  );

  it(
    'a target moved out of `planning` BY HAND is not moved by approve (D8)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'in_progress');
      const planId = await plannedModify(card);
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);

      // A person pulled it out while the plan sat in review. That is a MANUAL
      // release, and writing our answer over it would undo a human decision.
      await setStatus(card, 'in_progress');

      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe('in_progress');
      expect(await lockCount(card)).toBe(0);
    },
  );

  it(
    'a plan produced by a CONVERSATION parks nothing — the session is its holder',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      // ⚠️ THIS CASE WAS REWRITTEN BY MOTIR-5648's E2E evidence. It used to
      // assert that a session's EARLIER plan still released its own targets,
      // because the release used to resolve a session by `lastJobId` and miss for
      // any plan but the latest.
      //
      // That scenario can no longer arise: a plan that resolves to a session
      // parks NOTHING, so it has no targets of its own to release (AMENDMENT 16
      // D5). One conversation produces successive plans over the same cards —
      // that is what refining is — and making each plan its own holder made a
      // conversation collide with itself in the browser.
      //
      // The release's robustness is unchanged and still covered: it resolves a
      // PLAN's locks by `plan_id`, which is what the MCP cases above exercise.
      const card = await seedCard();
      await setStatus(card, 'implemented');

      const session = await adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          scopeKey: 'scope-a',
          lastJobId: 'job-1',
        },
      });
      const plan = await plansService.createPlan(
        fx.projectId,
        // The plan names its session (AMENDMENT 17 §5, MOTIR-6022) — the column
        // replaced the `sourceJobId == lastJobId` link this case used to seed.
        {
          title: 'The conversation\u2019s plan',
          sourceJobId: 'job-1',
          session: { sessionId: session.id },
        },
        fx.ctx,
      );
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
        fx.ctx,
      );

      // No park, no lock: the session holds what it opened with, and this plan
      // adds nothing of its own.
      expect(await statusOf(card)).toBe('implemented');
      expect(await lockCount(card)).toBe(0);
      expect(
        await planChangeSessionRepository.findByProjectAndLastJobId(
          fx.projectId,
          'job-1',
          fx.workspaceId,
          adminDb,
        ),
      ).toMatchObject({ id: session.id });

      // ⚠️ INVERTED BY MOTIR-10102. This line used to pin that approving it moves
      // no status, because nothing was parked — which was the bug: the plan
      // rewrote the body of a card that claimed its old body was built, and the
      // card went on claiming it. Nothing is parked still; the re-scope move
      // (`lib/plans/rescopeStatus.ts`) takes it to `todo` anyway.
      await plansService.markPlanned(plan.id, fx.ctx);
      await plansService.approvePlan(plan.id, fx.ctx);
      expect(await statusOf(card)).toBe('todo');
    },
  );
});

describe('decline, and the other endings — the PRIOR status comes back (D8)', () => {
  it.each([['approved'], ['blocked'], ['implemented'], ['in_review'], ['in_progress']])(
    'declining a plan returns a card parked from `%s` to `%s`',
    async (status) => {
      const card = await seedCard();
      await setStatus(card, status);
      const planId = await plannedModify(card);
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);

      await plansService.declinePlan(planId, fx.ctx);

      // NOTHING about the card changed, so it goes back exactly where it was —
      // which is the asymmetry with approve, and the whole of D6 vs D8.
      expect(await statusOf(card)).toBe(status);
      expect(await lockCount(card)).toBe(0);
    },
  );

  it(
    'a close that materializes NOTHING restores the prior status',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'implemented');

      const plan = await plansService.createPlan(fx.projectId, { title: 'Abandoned' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
        fx.ctx,
      );
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);

      await plansService.withdrawProposal(
        plan.id,
        (await adminDb.planItem.findFirstOrThrow({ where: { planId: plan.id } })).id,
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);

      expect(await statusOf(card)).toBe('implemented');
      expect(await lockCount(card)).toBe(0);
    },
  );

  it(
    'a declined plan does NOT move a card a person had already pulled out',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'implemented');
      const planId = await plannedModify(card);
      await setStatus(card, 'in_progress');

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe('in_progress');
      expect(await lockCount(card)).toBe(0);
    },
  );
});

describe('idempotency', () => {
  it('a replayed approve changes nothing', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    await setStatus(card, 'in_progress');
    const planId = await plannedModify(card);

    await plansService.approvePlan(planId, fx.ctx);
    const first = await statusOf(card);

    // A second approve is refused (the plan is decided), and refused WITHOUT
    // touching the card — there is no lock left to act on either way.
    await plansService.approvePlan(planId, fx.ctx).catch(() => undefined);

    expect(await statusOf(card)).toBe(first);
    expect(await lockCount(card)).toBe(0);
  });

  it('a replayed decline changes nothing', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    await setStatus(card, 'approved');
    const planId = await plannedModify(card);

    await plansService.declinePlan(planId, fx.ctx);
    await plansService.declinePlan(planId, fx.ctx).catch(() => undefined);

    expect(await statusOf(card)).toBe('approved');
    expect(await lockCount(card)).toBe(0);
  });
});
