import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { RESTING_TODO_KEY } from '@/lib/plans/restingStatus';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { expectEachHopAnnounced, transitionedEventsFor } from '../helpers/transitionedEvents';

// A PLAN'S PARK AND ITS RELEASE ANNOUNCE EVERY STATUS THEY WRITE (bug MOTIR-12164) —
// against a REAL Postgres, through the shipped doors, with the real `sendEvent` writing
// `job_event`.
//
// The park (`acquireOne`), the restore (`releaseOne`) and the rest of an adopted card
// (`restAdoptedTarget`) all wrote a status revision through `applyStatusTransition`
// inside another service's transaction, and nothing emitted `work-item/transitioned`
// after the commit. So watchers, automation rules and the parent rollup never saw a card
// enter or leave Planning. Every case below is a door that writes one of those hops, and
// `expectEachHopAnnounced` holds the revisions it wrote against the events it recorded,
// in both directions — an extra event is as wrong as a missing one.

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const who = () => ({ workspaceId: fx.workspaceId, actorId: fx.ownerId });

const pctx = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId });

async function seedCard(title = 'The card'): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The body.' },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/** An MCP-authored plan (no session, no source job) with one `modify`, still
 *  `generating` — the plan itself holds its target. */
async function generatingModify(workItemId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId, patch: { priority: 'high' } }],
    fx.ctx,
  );
  return plan.id;
}

async function makeSession(targetKeys: string[]) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    planChangeSessionRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        scopeKey: targetKeys.join(','),
        targetKeys,
      },
      tx,
    ),
  );
}

describe("a plan's park", () => {
  it(
    'announces the move into Planning once the append commits',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

      const { hops } = await expectEachHopAnnounced(card.id, who(), () =>
        generatingModify(card.id),
      );

      // The card's reproduction: `PARK events before=1 after=1` before the fix.
      expect(hops).toEqual([{ fromStatusKey: 'in_progress', toStatusKey: PLANNING_STATUS_KEY }]);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );

  it(
    'announces nothing when the transaction that parked rolls back',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
      const before = await transitionedEventsFor(card.id);

      await expect(
        withWorkspaceContext(fx.ctx, async (tx) => {
          await planTargetLockService.acquireForPlanWithin(
            plan.id,
            [card.id],
            new Set(['done', 'cancelled']),
            pctx(),
            new Date(),
            tx,
          );
          throw new Error('the append failed after the park');
        }),
      ).rejects.toThrow('the append failed after the park');

      expect(await statusOf(card.id)).toBe('todo');
      expect(await transitionedEventsFor(card.id)).toHaveLength(before.length);
    },
  );

  it(
    'says so and sends nothing early when it runs outside a transaction helper',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
      const before = await transitionedEventsFor(card.id);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // A bare transaction opens no after-commit scope, so the hop cannot be deferred.
      await adminDb.$transaction((tx) =>
        planTargetLockService.acquireForPlanWithin(
          plan.id,
          [card.id],
          new Set(['done', 'cancelled']),
          pctx(),
          new Date(),
          tx,
        ),
      );

      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
      expect(await transitionedEventsFor(card.id)).toHaveLength(before.length);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('written outside a transaction scope'),
        expect.objectContaining({
          workItemId: card.id,
          fromStatusKey: 'todo',
          toStatusKey: PLANNING_STATUS_KEY,
        }),
      );
    },
  );
});

describe("a plan's release", () => {
  it(
    'a decline announces the restore to the status the card was parked from',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
      const planId = await generatingModify(card.id);
      await plansService.markPlanned(planId, fx.ctx);

      const { hops } = await expectEachHopAnnounced(card.id, who(), () =>
        plansService.declinePlan(planId, fx.ctx),
      );

      expect(hops).toEqual([{ fromStatusKey: PLANNING_STATUS_KEY, toStatusKey: 'in_progress' }]);
    },
  );

  it(
    'a decline announces the rest of an ADOPTED hand-parked card',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await workItemsService.updateStatus(card.id, PLANNING_STATUS_KEY, fx.ctx);
      const planId = await generatingModify(card.id);
      await plansService.markPlanned(planId, fx.ctx);

      const { hops } = await expectEachHopAnnounced(card.id, who(), () =>
        plansService.declinePlan(planId, fx.ctx),
      );

      expect(hops).toEqual([{ fromStatusKey: PLANNING_STATUS_KEY, toStatusKey: RESTING_TODO_KEY }]);
    },
  );

  it(
    'the expiry sweep announces its restore, signed by the lease holder',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
      // A `generating` plan whose author went silent: the dead-author case D9 expires.
      await generatingModify(card.id);
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const { result, hops } = await expectEachHopAnnounced(card.id, who(), () =>
        planTargetLockService.releaseExpired(),
      );

      expect(result.entries).toEqual([{ workItemId: card.id, outcome: 'restored' }]);
      expect(hops).toEqual([{ fromStatusKey: PLANNING_STATUS_KEY, toStatusKey: 'in_progress' }]);
    },
  );
});

describe("a session's hold", () => {
  it(
    'announces the park on open and the restore on release',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
      const session = await makeSession([card.identifier]);

      const parked = await expectEachHopAnnounced(card.id, who(), () =>
        planTargetLockService.acquireForScope(session.id, [card.identifier], pctx()),
      );
      expect(parked.hops).toEqual([
        { fromStatusKey: 'in_progress', toStatusKey: PLANNING_STATUS_KEY },
      ]);

      const released = await expectEachHopAnnounced(card.id, who(), () =>
        planTargetLockService.releaseForSession(session.id, pctx()),
      );
      expect(released.hops).toEqual([
        { fromStatusKey: PLANNING_STATUS_KEY, toStatusKey: 'in_progress' },
      ]);
    },
  );

  it(
    'a hand-off announces the release upward and the park downward',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const up = await seedCard('The epic-level card');
      const down = await seedCard('The story-level card');
      const session = await makeSession([up.identifier]);
      await planTargetLockService.acquireForScope(session.id, [up.identifier], pctx());

      const handOff = () =>
        planTargetLockService.handOff(
          session.id,
          { release: [up.identifier], acquire: [down.identifier] },
          pctx(),
        );
      const upHops = await expectEachHopAnnounced(up.id, who(), () =>
        expectEachHopAnnounced(down.id, who(), handOff),
      );

      expect(upHops.hops).toEqual([{ fromStatusKey: PLANNING_STATUS_KEY, toStatusKey: 'todo' }]);
      expect(upHops.result.hops).toEqual([
        { fromStatusKey: 'todo', toStatusKey: PLANNING_STATUS_KEY },
      ]);
    },
  );
});
