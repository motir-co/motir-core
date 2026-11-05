import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { PlanSessionNotFoundError } from '@/lib/planChange/errors';
import { plansService } from '@/lib/services/plansService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { workItemsService } from '@/lib/services/workItemsService';
import { runCreatePlan } from '@/lib/mcp/tools/authorPlan';
import { createTestProject } from '../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6022 — EVERY PLAN BELONGS TO A SESSION (story MOTIR-6011;
// `agent-authored-plans.md` AMENDMENT 17 §4–§5). One case per author path
// asserting the session's origin, the revision keeping its session, the
// card-anchored read going through the column, and — the regression this card
// could introduce — an MCP plan still parking its own targets now that it HAS a
// session. Only the motir-ai boundary is mocked.

let jobSeq = 0;
const submitJobMock = vi.fn(async () => ({ jobId: `job-link-${++jobSeq}` }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionEndService } = await import('@/lib/services/planSessionEndService');
const { planChangeMailboxService } = await import('@/lib/services/planChangeMailboxService');

let fx: WorkItemFixture;

function pctx(): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

async function sessionOf(planId: string) {
  const plan = await adminDb.plan.findUniqueOrThrow({
    where: { id: planId },
    select: { sessionId: true, session: true },
  });
  expect(plan.sessionId).not.toBeNull();
  return plan.session!;
}

async function makeStory(title = 'A story') {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title, parentId: null },
    fx.ctx,
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('each author path attaches a session of the right origin', () => {
  it('a CONVERSATION submit puts its plan on that conversation', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      PROJECT_SCOPE,
      'add auth',
    );
    const { planId, session } = await planChangeSessionsService.submit(pctx(), {
      sessionId: convo.id,
    });

    const s = await sessionOf(planId!);
    expect(s.id).toBe(convo.id);
    expect(s.origin).toBe('conversation');
    expect(session.id).toBe(convo.id);
  });

  it('MCP `create_plan` opens a session of origin `mcp`, owned by the token user', async () => {
    const result = await runCreatePlan(
      { projectKey: fx.project.identifier, title: 'agent plan' },
      fx.ctx,
    );
    const plan = await adminDb.plan.findFirstOrThrow({ where: { projectId: fx.projectId } });

    expect(result.isError).not.toBe(true);
    const s = await sessionOf(plan.id);
    expect(s.origin).toBe('mcp');
    expect(s.createdById).toBe(fx.ownerId);
    expect(s.turnCount).toBe(0);
  });

  it('a GENERATION opens a session of origin `generation`', async () => {
    const { planId } = await aiGenerationService.startGeneration(pctx(), { title: 'gen' });
    expect((await sessionOf(planId)).origin).toBe('generation');
  });

  it('an EXPAND opens a session of origin `expand`, anchored at its root item', async () => {
    const story = await makeStory();
    const { planId } = await aiPlanEditsService.submitExpand(story.identifier, pctx());

    const s = await sessionOf(planId);
    expect(s.origin).toBe('expand');
    expect(s.targetKeys).toEqual([story.identifier]);
    expect(s.scopeKey).toBe(buildScope([story.identifier]).scopeKey);
  });

  it('a CADENCE plan opens a session of origin `cadence`, with nobody as its starter', async () => {
    const story = await makeStory();
    const { planId } = await aiPlanEditsService.submitExpand(story.identifier, pctx(), {
      origin: 'cadence',
    });

    const s = await sessionOf(planId);
    expect(s.origin).toBe('cadence');
    expect(s.createdById).toBeNull();
  });

  it('a one-shot AUGMENT with no conversation opens a `generation` session', async () => {
    const { planId } = await aiPlanEditsService.submitAugment('add audit logging', pctx());
    expect((await sessionOf(planId)).origin).toBe('generation');
  });

  it('refuses a session id from another project, creating no plan', async () => {
    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSW',
    });
    const theirs = await planChangeSessionsService.startWithFirstTurn(
      { ...pctx(), projectId: elsewhere.id, project: elsewhere },
      PROJECT_SCOPE,
      'x',
    );

    await expect(
      plansService.createPlan(fx.projectId, { session: { sessionId: theirs.id } }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
    expect(await adminDb.plan.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});

// BUG MOTIR-10431 — a plan Motir writes for the auto-plan cadence, an expand or a
// generation had no Stop. Its session was opened with no `lastJobId`, while the stop
// door and the run's own boundary read resolve the thread BY `last_job_id`, so a stop
// on that job was refused and could never reach the walk. The session opened for a
// hosted job now owns it, as a conversation's submit does; an MCP plan has no job.
describe('a session Motir opens for its own job owns that job (MOTIR-10431)', () => {
  const hosted: Array<[string, () => Promise<{ planId: string }>]> = [
    [
      'an auto-plan CADENCE plan',
      async () => {
        const story = await makeStory();
        return aiPlanEditsService.submitExpand(story.identifier, pctx(), { origin: 'cadence' });
      },
    ],
    [
      'an EXPAND',
      async () => {
        const story = await makeStory();
        return aiPlanEditsService.submitExpand(story.identifier, pctx());
      },
    ],
    ['a GENERATION', () => aiGenerationService.startGeneration(pctx(), { title: 'gen' })],
    ['a one-shot AUGMENT', () => aiPlanEditsService.submitAugment('add audit logging', pctx())],
  ];

  it.each(hosted)('%s records its job on its session', async (_label, open) => {
    const { planId } = await open();
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    const s = await sessionOf(planId);

    expect(plan.sourceJobId).toMatch(/^job-link-/);
    expect(s.lastJobId).toBe(plan.sourceJobId);
    expect(s.lastSubmittedAt).not.toBeNull();
  });

  it.each(hosted)('%s can be STOPPED: the stop reaches its walk', async (_label, open) => {
    const { planId } = await open();
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    const s = await sessionOf(planId);
    const mctx = { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId };

    // The overlay addresses the session it opened on and the job it names.
    const raised = await planChangeMailboxService.raiseStop(
      plan.sourceJobId!,
      `stop:${plan.sourceJobId}`,
      mctx,
      s.id,
    );
    expect(raised.stopped).toBe(true);
    // …and the run's next phase boundary reads it.
    const boundary = await planChangeMailboxService.readForBoundary(plan.sourceJobId!, mctx);
    expect(boundary.stopped).toBe(true);
  });

  it('an MCP `create_plan` binds no job — nothing Motir runs writes it', async () => {
    await runCreatePlan({ projectKey: fx.project.identifier, title: 'agent plan' }, fx.ctx);
    const plan = await adminDb.plan.findFirstOrThrow({ where: { projectId: fx.projectId } });
    const s = await sessionOf(plan.id);

    expect(s.lastJobId).toBeNull();
    expect(s.lastSubmittedAt).toBeNull();
  });

  it('a conversation submit still binds the job on the conversation it names', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'x');
    const { planId } = await planChangeSessionsService.submit(pctx(), { sessionId: convo.id });
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId! } });

    expect((await sessionOf(planId!)).lastJobId).toBe(plan.sourceJobId);
    expect(await adminDb.planChangeSession.count({ where: { projectId: fx.projectId } })).toBe(1);
  });
});

describe('a REVISION keeps its session', () => {
  it('re-points sourceJobId and leaves sessionId where it was', async () => {
    const { planId } = await aiPlanEditsService.submitAugment('first', pctx());
    // An empty close would DECLINE it; the state under test is a planned plan.
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });
    const before = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });

    await plansService.acquireRevisionLease(
      planId,
      fx.ctx,
      { source: 'native', harness: 'Motir', model: null },
      { jobId: 'job-revision-1' },
    );

    const after = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(after.sourceJobId).toBe('job-revision-1');
    expect(after.sourceJobId).not.toBe(before.sourceJobId);
    expect(after.sessionId).toBe(before.sessionId);
  });
});

describe('the card-anchored read goes through the column', () => {
  it('resolves to the NEWER session’s planned plan when an older session of the scope holds an approved one', async () => {
    const story = await makeStory();
    const scope = buildScope([story.identifier]);

    const older = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'first go');
    const { planId: approvedId } = await planChangeSessionsService.submit(pctx(), {
      sessionId: older.id,
    });
    await adminDb.plan.update({ where: { id: approvedId! }, data: { status: 'approved' } });
    // The older conversation ENDS; the next first turn starts a new session of
    // the same scope (AMENDMENT 23 §3 — an open one would be resumed at any age).
    await planSessionEndService.endSession(older.id, 'idle', { workspaceId: fx.workspaceId });
    const newer = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'second go');
    expect(newer.id).not.toBe(older.id);
    const { planId: plannedId } = await planChangeSessionsService.submit(pctx(), {
      sessionId: newer.id,
    });
    await adminDb.plan.update({ where: { id: plannedId! }, data: { status: 'planned' } });

    expect(
      await plansService.resolvePlanIdForWorkItem(fx.projectId, story.identifier, fx.ctx),
    ).toBe(plannedId);
  });
});

describe('parking — a session is a HOLDER only when it is a conversation', () => {
  it('an MCP plan still PARKS its target, though it now has a session', async () => {
    const story = await makeStory('parked by an agent');
    const plan = await plansService.createPlan(
      fx.projectId,
      { session: { origin: 'mcp' }, authorSource: 'mcp' },
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: story.id, patch: { title: 'renamed' } }],
      fx.ctx,
    );

    const lock = await adminDb.planTargetLock.findFirst({ where: { workItemId: story.id } });
    expect(lock?.planId).toBe(plan.id);
    const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(item.status).toBe('planning');
  });

  it('a CONVERSATION plan parks nothing of its own — the session already holds the anchor', async () => {
    const story = await makeStory('held by a conversation');
    const convo = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      buildScope([story.identifier]),
      'reshape it',
    );
    const { planId } = await planChangeSessionsService.submit(pctx(), { sessionId: convo.id });
    await plansService.addProposals(
      planId!,
      [{ op: 'modify', workItemId: story.id, patch: { title: 'reshaped' } }],
      fx.ctx,
    );

    const lock = await adminDb.planTargetLock.findFirstOrThrow({ where: { workItemId: story.id } });
    expect(lock.sessionId).toBe(convo.id);
    expect(lock.planId).toBeNull();
  });
});

describe('the session release follows the conversation’s LATEST plan', () => {
  it('declining an EARLIER plan keeps the conversation’s hold; deciding the latest releases it', async () => {
    const story = await makeStory('refined twice');
    const convo = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      buildScope([story.identifier]),
      'first cut',
    );
    const { planId: earlier } = await planChangeSessionsService.submit(pctx(), {
      sessionId: convo.id,
    });
    await planChangeSessionsService.appendTurn('smaller please', pctx(), { sessionId: convo.id });
    const { planId: latest } = await planChangeSessionsService.submit(pctx(), {
      sessionId: convo.id,
    });
    await adminDb.plan.updateMany({
      where: { id: { in: [earlier!, latest!] } },
      data: { status: 'planned' },
    });

    await plansService.declinePlan(earlier!, fx.ctx);
    expect(
      (await adminDb.planTargetLock.findFirst({ where: { workItemId: story.id } }))?.sessionId,
    ).toBe(convo.id);

    await plansService.declinePlan(latest!, fx.ctx);
    expect(await adminDb.planTargetLock.findFirst({ where: { workItemId: story.id } })).toBeNull();
  });
});
