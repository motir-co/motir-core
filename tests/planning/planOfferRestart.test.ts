import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { offerRestartStopKey, planOfferStartPath } from '@/lib/planChange/offerRestart';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// PLANNING SOMETHING ELSE MID-PLANNING (Story MOTIR-9219 · MOTIR-9293), on REAL
// Postgres. The restart door a confirmed offer takes on a conversation that already
// holds an undecided plan, and the confirm entry that now routes there instead of
// refusing `already_planning`. Mocked: only the motir-ai boundary.

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { buildAccumulatedIntent, planChangeSessionsService } =
  await import('@/lib/services/planChangeSessionsService');
const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { PlanSessionNotFoundError, PlanTargetLockedError } = await import('@/lib/planChange/errors');

const T = { timeout: 120_000 };
const REQUEST = 'Plan the import screen instead.';

let fx: WorkItemFixture;
let jobSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  jobs.clear();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

function ctxOf(userId: string): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}
const me = () => ctxOf(fx.ownerId);

async function card(title: string) {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'todo' } });
  return { id: dto.id, key: dto.identifier };
}

async function member(label: string): Promise<ProjectContext> {
  const u = await createTestUser({ name: `Member ${label}` });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await addToProjectAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role: 'member',
  });
  return ctxOf(u.id);
}

/** How many plan-edit jobs were submitted. */
function planSubmits(): number {
  return submitJobMock.mock.calls.filter((c) => c[0] === 'plan').length;
}

/** The caller's conversation planning card A, holding a `generating` plan. */
async function planningOn(a: { id: string }, pctx = me()) {
  const started = await contextualPlanningService.planFromWorkItem(
    { anchorId: a.id, prompt: 'Plan the export.' },
    pctx,
  );
  return { sessionId: started.sessionId, planId: started.planId, jobId: started.jobId };
}

const offerFor = (b: { key: string }, offerRef = 'offer-1') => ({
  requestMd: REQUEST,
  scope: buildScope([b.key]),
  offerRef,
});

describe('planOfferStartPath', () => {
  it.each([
    [{ endedAt: null, latestUndecidedStatus: 'generating' as const }, 'restart'],
    [{ endedAt: null, latestUndecidedStatus: 'planned' as const }, 'restart'],
    [{ endedAt: null, latestUndecidedStatus: 'stale' as const }, 'restart'],
    [{ endedAt: null, latestUndecidedStatus: null }, 'submit'],
    [{ endedAt: new Date(), latestUndecidedStatus: 'planned' as const }, 'no-start'],
  ])('%o → %s', (input, expected) => {
    expect(planOfferStartPath(input)).toBe(expected);
  });

  it('an ended session starts nothing whatever its plan', () => {
    for (const status of ['generating', 'planned', 'stale', null] as const) {
      expect(planOfferStartPath({ endedAt: '2026-10-22', latestUndecidedStatus: status })).toBe(
        'no-start',
      );
    }
  });

  it('a session a plan decision ended takes the decided route (MOTIR-11521)', () => {
    for (const endReason of ['approved', 'declined'] as const) {
      for (const status of ['generating', 'planned', 'stale', null] as const) {
        expect(
          planOfferStartPath({ endedAt: new Date(), endReason, latestUndecidedStatus: status }),
        ).toBe('decided');
      }
    }
  });

  it('every other ended session still starts nothing', () => {
    for (const endReason of ['restarted', 'idle', 'failed', null, undefined] as const) {
      expect(
        planOfferStartPath({ endedAt: new Date(), endReason, latestUndecidedStatus: null }),
      ).toBe('no-start');
    }
  });

  it('an OPEN session ignores an end reason', () => {
    expect(
      planOfferStartPath({ endedAt: null, endReason: 'approved', latestUndecidedStatus: null }),
    ).toBe('submit');
  });

  it('mints one stop key per offer', () => {
    expect(offerRestartStopKey('t1')).toBe(offerRestartStopKey('t1'));
    expect(offerRestartStopKey('t1')).not.toBe(offerRestartStopKey('t2'));
  });
});

describe('restartForPlanOffer', () => {
  it(
    'on a planned plan: ends the session restarted, leaves the plan planned, and starts the request on a successor',
    T,
    async () => {
      const a = await card('Export');
      const b = await card('Import');
      const { sessionId, planId } = await planningOn(a);
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });
      const before = planSubmits();

      const out = await planChangeSessionsService.restartForPlanOffer(
        me(),
        { sessionId },
        offerFor(b),
      );

      expect(out).toMatchObject({
        outcome: 'restarted',
        endedSessionId: sessionId,
        ownsStart: true,
      });
      expect(
        await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } }),
      ).toMatchObject({ endReason: 'restarted', endedById: fx.ownerId });
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
        'planned',
      );
      const successor = out.session!;
      expect(successor.id).not.toBe(sessionId);
      expect(successor.origin).toBe('conversation');
      expect(successor.targetKeys).toEqual([b.key]);
      expect(successor.targetKeys).not.toEqual([a.key]);
      const turns = await adminDb.planChangeTurn.findMany({
        where: { sessionId: successor.id },
        orderBy: { seq: 'asc' },
      });
      expect(turns.find((t) => t.role === 'user')?.body).toBe(REQUEST);
      expect(buildAccumulatedIntent(turns)).toBe(REQUEST);
      // The door dispatches nothing.
      expect(planSubmits()).toBe(before);
      expect(await adminDb.plan.count({ where: { sessionId: successor.id } })).toBe(0);
      expect(await adminDb.planTargetLock.count({ where: { sessionId: successor.id } })).toBe(1);

      // The successor is a valid subject for the shipped start, and a second door
      // call for the SAME addressed session changes nothing of that.
      const again = await planChangeSessionsService.restartForPlanOffer(
        me(),
        { sessionId },
        offerFor(b),
      );
      expect(again).toMatchObject({ outcome: 'already', endedSessionId: null, ownsStart: false });
      expect(again.session?.id).toBe(successor.id);
      expect(await adminDb.planChangeTurn.count({ where: { sessionId: successor.id } })).toBe(1);
      const submitted = await planChangeSessionsService.submit(me(), { sessionId: successor.id });
      expect(await adminDb.plan.count({ where: { sessionId: successor.id } })).toBe(1);
      expect(submitJobMock.mock.calls.at(-1)![2]).toMatchObject({ targetKeys: [b.key] });
      expect(submitted.session.id).toBe(successor.id);
      await planChangeSessionsService.restartForPlanOffer(me(), { sessionId }, offerFor(b));
      expect(await adminDb.plan.count({ where: { sessionId: successor.id } })).toBe(1);
    },
  );

  it(
    'on a generating plan with a live job: stops the run first, discards the plan and gives the card back',
    T,
    async () => {
      const a = await card('Export');
      const b = await card('Import');
      const { sessionId, planId, jobId } = await planningOn(a);
      expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: a.id } })).status).not.toBe(
        'todo',
      );

      await planChangeSessionsService.restartForPlanOffer(me(), { sessionId }, offerFor(b));

      const stop = await adminDb.planChangeMailboxEntry.findMany({
        where: { jobId, kind: 'stop' },
      });
      expect(stop).toHaveLength(1);
      expect(stop[0]!.idempotencyKey).toBe(offerRestartStopKey('offer-1'));
      const ended = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(stop[0]!.createdAt.getTime()).toBeLessThanOrEqual(ended.endedAt!.getTime());
      expect(await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).toMatchObject({
        status: 'declined',
        decisionReason: 'discarded',
        decidedById: fx.ownerId,
      });
      expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
        'todo',
      );
    },
  );

  it(
    'a session that never submitted raises no stop, and a finished run still restarts',
    T,
    async () => {
      const b = await card('Import');
      const fresh = await planChangeSessionsService.startWithFirstTurn(
        me(),
        buildScope([]),
        'Thinking out loud.',
      );
      const out = await planChangeSessionsService.restartForPlanOffer(
        me(),
        { sessionId: fresh.id },
        offerFor(b),
      );
      expect(out.ownsStart).toBe(true);
      expect(await adminDb.planChangeMailboxEntry.count()).toBe(0);

      const a = await card('Export');
      const { sessionId, jobId } = await planningOn(a);
      jobs.set(jobId, { jobId, status: 'succeeded', result: {}, error: null });
      const finished = await planChangeSessionsService.restartForPlanOffer(
        me(),
        { sessionId },
        offerFor(await card('Other'), 'offer-2'),
      );
      expect(finished.outcome).toBe('restarted');
    },
  );

  it(
    'an addressed session that had already ended owns no start and creates nothing',
    T,
    async () => {
      const a = await card('Export');
      const b = await card('Import');
      const { sessionId } = await planningOn(a);
      await planChangeSessionsService.endSession(sessionId, 'idle', {
        workspaceId: fx.workspaceId,
      });
      const sessionsBefore = await adminDb.planChangeSession.count();
      const none = await planChangeSessionsService.restartForPlanOffer(
        me(),
        { sessionId },
        offerFor(b),
      );
      expect(none).toEqual({
        outcome: 'already',
        endedSessionId: null,
        session: null,
        ownsStart: false,
      });
      expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore);

      const open = await planChangeSessionsService.startWithFirstTurn(
        me(),
        buildScope([b.key]),
        'Already here.',
      );
      const turnsBefore = await adminDb.planChangeTurn.count();
      const found = await planChangeSessionsService.restartForPlanOffer(
        me(),
        { sessionId },
        offerFor(b),
      );
      expect(found.ownsStart).toBe(false);
      expect(found.session?.id).toBe(open.id);
      expect(await adminDb.planChangeTurn.count()).toBe(turnsBefore);
    },
  );

  it(
    'refuses another member’s session, a guide conversation, and a caller without ai:plan',
    T,
    async () => {
      const a = await card('Export');
      const b = await card('Import');
      const { sessionId } = await planningOn(a);
      const other = await member('other');
      await expect(
        planChangeSessionsService.restartForPlanOffer(other, { sessionId }, offerFor(b)),
      ).rejects.toBeInstanceOf(PlanSessionNotFoundError);

      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: { origin: 'guide' },
      });
      await expect(
        planChangeSessionsService.restartForPlanOffer(me(), { sessionId }, offerFor(b)),
      ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: { origin: 'conversation' },
      });

      const theirs = await planningOn(await card('Theirs'), other);
      const role = await createCustomRoleAs({
        projectId: fx.projectId,
        ctx: fx.ctx,
        name: 'No planning',
        permissions: ['project:browse', 'work_item:edit'],
      });
      await setProjectRoleAs({
        key: fx.project.identifier,
        actorUserId: fx.ownerId,
        ctx: fx.ctx,
        targetUserId: other.userId,
        role: role.id,
      });
      await expect(
        planChangeSessionsService.restartForPlanOffer(
          other,
          { sessionId: theirs.sessionId },
          offerFor(b),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      for (const id of [sessionId, theirs.sessionId]) {
        expect(
          (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id } })).endedAt,
        ).toBeNull();
      }
    },
  );

  it(
    'is one transaction: a refused lease on the offered target leaves the session open and its plan unchanged',
    T,
    async () => {
      const a = await card('Export');
      const b = await card('Import');
      const other = await member('holder');
      await planningOn(b, other);
      const { sessionId, planId } = await planningOn(a);
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });

      await expect(
        planChangeSessionsService.restartForPlanOffer(me(), { sessionId }, offerFor(b)),
      ).rejects.toBeInstanceOf(PlanTargetLockedError);
      expect(
        (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })).endedAt,
      ).toBeNull();
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
        'planned',
      );
    },
  );
});

describe('confirmPlanOffer mid-planning', () => {
  it(
    'restarts the conversation and submits one plan on the successor; a second confirm submits nothing',
    T,
    async () => {
      // An ask conversation whose answer offered a plan…
      const submitted = await aiAskService.submitTurn('Can we import CSV files?', me());
      if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
      jobs.set(submitted.jobId, {
        jobId: submitted.jobId,
        status: 'succeeded',
        result: {
          ask: {
            intent: 'ask',
            answer: 'Not yet.',
            citations: [],
            offer: { kind: 'plan', requestText: REQUEST, immediate: false },
          },
        },
        error: null,
      });
      const conversationId = submitted.session.id;
      const settled = await aiAskService.settle(submitted.jobId, me(), {
        sessionId: conversationId,
      });
      const offerTurnId = settled.session.turns.filter((t) => t.role === 'assistant').at(-1)!.id;
      // …that already holds an undecided plan.
      await planChangeSessionsService.submit(me(), { sessionId: conversationId });
      const before = planSubmits();

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      expect(started.sessionId).not.toBe(conversationId);
      expect(planSubmits()).toBe(before + 1);
      expect(
        await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: conversationId } }),
      ).toMatchObject({ endReason: 'restarted', endedById: fx.ownerId });
      expect(await adminDb.plan.count({ where: { sessionId: conversationId } })).toBe(1);
      expect(await adminDb.plan.count({ where: { sessionId: started.sessionId } })).toBe(1);
      const successorTurns = await adminDb.planChangeTurn.findMany({
        where: { sessionId: started.sessionId, role: 'user' },
      });
      expect(successorTurns.map((t) => t.body)).toEqual([REQUEST]);

      const again = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });
      expect(again.sessionId).toBe(started.sessionId);
      expect(planSubmits()).toBe(before + 1);
    },
  );
});
