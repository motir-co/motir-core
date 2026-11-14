import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { PlanSessionNotFoundError } from '@/lib/planChange/errors';
import { KEEP_PLANNING_MARKER_BODY, NEW_SESSION_CONFIRM_BODY } from '@/lib/planChange/restart';
import { readAskOutcome } from '@/lib/planning/askResult';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { seedLegacyRestartConfirm } from '../helpers/legacyRestartConfirm';

// PLAN SOMETHING NEW (story MOTIR-7631 · MOTIR-7649) — against a REAL Postgres.
// `docs/decisions/conversation-turn-intent.md` AMENDMENT 3: Keep planning closes
// nothing, and Confirm ends the session `restarted` and returns a new, empty
// session for the same scope (A3.3/A3.4). Nothing writes the fixed confirm TURN
// any more — the words stopped in AMENDMENT 5 (MOTIR-9231), and the control asks
// in a dialog since MOTIR-11261 — so the confirm below is a LEGACY turn, seeded.
// The story's assembled gate (refusals, isolation, the ask door) is MOTIR-7652.

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

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

async function seedCard(): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'todo' } });
  return { id: dto.id, key: dto.identifier };
}

/** The owner's open conversation on `card`, holding it at Planning, with one turn. */
async function sessionOn(card: { key: string }) {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: card.key,
      targetKeys: [card.key],
      turnCount: 1,
    },
  });
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: session.id,
      seq: 0,
      role: 'user',
      body: 'Forget this, I want to plan something new',
      intent: 'ask',
      authorId: fx.ownerId,
    },
  });
  await planTargetLockService.acquireForScope(session.id, [card.key], {
    ...fx.ctx,
    projectId: fx.projectId,
  });
  return session.id;
}

describe('readAskOutcome — the new_session redirect', () => {
  it('reads it with no answer and no citations, whatever else the field carried', () => {
    expect(
      readAskOutcome({ ask: { intent: 'new_session', answer: 'Sure!', citations: ['ABC-1'] } }),
    ).toEqual({ intent: 'new_session', answer: null, citations: [] });
  });
});

describe('the confirm', () => {
  it('the service no longer writes a confirm turn (MOTIR-11261)', () => {
    expect('requestRestartConfirm' in planChangeSessionsService).toBe(false);
  });

  it(
    'a legacy confirm turn is read back as the pending confirm',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await sessionOn(await seedCard());
      await seedLegacyRestartConfirm(me(), sessionId);
      await seedLegacyRestartConfirm(me(), sessionId);

      const read = await planChangeSessionsService.getById(me(), sessionId);
      expect(read!.turns.at(-1)).toMatchObject({
        role: 'assistant',
        confirm: 'new_session',
        body: NEW_SESSION_CONFIRM_BODY,
      });
      expect(read!.turns.filter((t) => t.confirm === 'new_session')).toHaveLength(1);
    },
  );

  it(
    'Keep planning answers a pending confirm and closes nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);
      await seedLegacyRestartConfirm(me(), sessionId);

      const kept = await planChangeSessionsService.keepPlanning(me(), { sessionId });
      expect(kept.turns.at(-1)).toMatchObject({ role: 'system', body: KEEP_PLANNING_MARKER_BODY });
      // Nothing pending any more, so a second press writes nothing.
      const again = await planChangeSessionsService.keepPlanning(me(), { sessionId });
      expect(again.turns).toHaveLength(kept.turns.length);

      const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.endedAt).toBeNull();
      expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
        PLANNING_STATUS_KEY,
      );
    },
  );
  it(
    'Keep planning on a legacy confirm of an ended session writes nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await sessionOn(await seedCard());
      await seedLegacyRestartConfirm(me(), sessionId);
      await planChangeSessionsService.endSession(sessionId, 'idle', {
        workspaceId: fx.workspaceId,
      });
      const before = await adminDb.planChangeTurn.count({ where: { sessionId } });
      await planChangeSessionsService.keepPlanning(me(), { sessionId });
      expect(await adminDb.planChangeTurn.count({ where: { sessionId } })).toBe(before);
    },
  );
});

describe('restart — Confirm', () => {
  it(
    'ends the session `restarted`, gives the card back and returns a NEW empty session of the same scope',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);
      await seedLegacyRestartConfirm(me(), sessionId);

      const out = await planChangeSessionsService.restart(me(), { sessionId });

      expect(out.outcome).toBe('restarted');
      expect(out.endedSessionId).toBe(sessionId);
      const ended = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(ended).toMatchObject({ endReason: 'restarted', endedById: fx.ownerId });
      expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
        'todo',
      );

      expect(out.session.id).not.toBe(sessionId);
      expect(out.session.targetKeys).toEqual([card.key]);
      expect(out.session.turns).toEqual([]);
      expect(out.session.origin).toBe('conversation');
      const fresh = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: out.session.id },
      });
      expect(fresh).toMatchObject({ scopeKey: card.key, endedAt: null, copiedFromSessionId: null });
      // No lock until its first turn.
      expect(await adminDb.planTargetLock.count({ where: { sessionId: out.session.id } })).toBe(0);
    },
  );

  it(
    'twice: the session ends once, and the second call returns the session the first created',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await sessionOn(await seedCard());
      const first = await planChangeSessionsService.restart(me(), { sessionId });
      const endedAt = (
        await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })
      ).endedAt;

      const second = await planChangeSessionsService.restart(me(), { sessionId });

      expect(second.session.id).toBe(first.session.id);
      expect(
        (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })).endedAt,
      ).toEqual(endedAt);
      expect(await adminDb.planChangeSession.count({ where: { projectId: fx.projectId } })).toBe(2);
    },
  );

  it(
    'a guide conversation has no restart — PLAN_SESSION_NOT_FOUND',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await sessionOn(await seedCard());
      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: { origin: 'guide' },
      });
      await expect(planChangeSessionsService.restart(me(), { sessionId })).rejects.toBeInstanceOf(
        PlanSessionNotFoundError,
      );
      await expect(
        planChangeSessionsService.keepPlanning(me(), { sessionId }),
      ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
    },
  );

  it(
    'the project-wide conversation restarts into a new project-wide one',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await planChangeSessionsService.startWithFirstTurn(
        me(),
        PROJECT_SCOPE,
        'Plan the release',
      );
      const out = await planChangeSessionsService.restart(me(), { sessionId: s.id });
      expect(out.session.targetKeys).toEqual([]);
      expect(out.session.turns).toEqual([]);
      // The resume read now names the new session, never the restarted one.
      const resumed = await planChangeSessionsService.findResumableWithEarlier(me());
      expect(resumed.session?.id).toBe(out.session.id);
      expect(resumed.copyable).toBeNull();
    },
  );
});
