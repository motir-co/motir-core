import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import {
  InvalidPlanStepError,
  PlanNotFoundError,
  PlanNotGeneratingError,
} from '@/lib/plans/errors';
import { PLAN_LESSON_CALL_BATCH_MAX } from '@/lib/plans/planLessonCall';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { RLS_DENIAL, isRlsDenial } from '../../helpers/sqlstate';

// MOTIR-10191 — a plan KEEPS every lesson call its planner sessions made
// (`plan_lesson_call`), and which sessions were recorded at all
// (`plan_lesson_session`): the searches with the ids they returned in rank order,
// the reinforcements and additions, the ids injected in code — never a lesson's
// text. Every case drives `plansService` against real Postgres and reads the
// stored rows back through `adminDb`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const LESSON_A = 'cstr77ecwfcozfr3frq8l7pxl';
const LESSON_B = 'clx9shared0lesson00000001';

async function generatingPlan(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The search story', kind: 'story' } }],
    fx.ctx,
  );
  return plan.id;
}

const callsOf = (planId: string) =>
  adminDb.planLessonCall.findMany({ where: { planId }, orderBy: { seq: 'asc' } });
const sessionsOf = (planId: string) =>
  adminDb.planLessonSession.findMany({ where: { planId }, orderBy: { firstReportAt: 'asc' } });

const search = {
  kind: 'search',
  query: 'wiring a dependency edge across two repositories the wrong way',
  filters: { kinds: ['story'], phases: ['lay'], subject: 'mcp', limit: 8 },
  lessonIds: [LESSON_B, LESSON_A],
  outcome: 'matched',
};

describe('recordPlanLessonCalls — appends the session’s calls, in call order', () => {
  it('stores each kind with a plan-wide seq that continues across calls and sessions', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);

    const first = await plansService.recordPlanLessonCalls(
      planId,
      {
        sessionKey: 'lay-1',
        lessonCalls: [
          search,
          {
            kind: 'reinforce',
            lessonId: LESSON_A,
            occurrenceRef: 'plan:p1#lay-1',
            outcome: 'counted',
            counted: true,
          },
        ],
      },
      fx.ctx,
    );
    expect(first.map((r) => [r.seq, r.kind])).toEqual([
      [1, 'search'],
      [2, 'reinforce'],
    ]);
    // Rank order is kept exactly as sent.
    expect(first[0]!.lessonIds).toEqual([LESSON_B, LESSON_A]);

    const second = await plansService.recordPlanLessonCalls(
      planId,
      {
        sessionKey: 'ai:job:2',
        lessonCalls: [
          { kind: 'injected', lessonIds: [LESSON_A], outcome: 'injected' },
          {
            kind: 'add',
            lessonId: LESSON_B,
            occurrenceRef: 'MOTIR-1',
            outcome: 'added',
            counted: true,
          },
        ],
      },
      fx.ctx,
    );
    expect(second.map((r) => [r.seq, r.kind, r.sessionKey])).toEqual([
      [3, 'injected', 'ai:job:2'],
      [4, 'add', 'ai:job:2'],
    ]);

    const rows = await callsOf(planId);
    expect(rows.map((r) => [r.sessionKey, r.seq, r.kind, r.lessonId, r.counted])).toEqual([
      ['lay-1', 1, 'search', null, null],
      ['lay-1', 2, 'reinforce', LESSON_A, true],
      ['ai:job:2', 3, 'injected', null, null],
      ['ai:job:2', 4, 'add', LESSON_B, true],
    ]);
    expect(rows[0]!.filters).toEqual({
      kinds: ['story'],
      phases: ['lay'],
      subject: 'mcp',
      limit: 8,
    });
    expect(rows[0]!.query).toBe(search.query);
    expect(rows[1]!.filters).toEqual({});
    expect(rows[1]!.lessonIds).toEqual([]);
    expect(rows[1]!.occurrenceRef).toBe('plan:p1#lay-1');
    expect((await sessionsOf(planId)).map((s) => s.sessionKey)).toEqual(['lay-1', 'ai:job:2']);
  });

  it('an EMPTY report marks the session recorded and writes no call', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const rows = await plansService.recordPlanLessonCalls(
      planId,
      { sessionKey: 'author-3', lessonCalls: [] },
      fx.ctx,
    );
    expect(rows).toEqual([]);
    expect(await callsOf(planId)).toEqual([]);
    const [marker] = await sessionsOf(planId);
    expect(marker).toMatchObject({ sessionKey: 'author-3' });

    // A second report touches the marker, never duplicates it.
    await plansService.recordPlanLessonCalls(
      planId,
      { sessionKey: 'author-3', lessonCalls: [search] },
      fx.ctx,
    );
    const markers = await sessionsOf(planId);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.lastReportAt.getTime()).toBeGreaterThanOrEqual(
      markers[0]!.firstReportAt.getTime(),
    );
  });

  it('records a refused search and a not-counted reinforce as they came back', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanLessonCalls(
      planId,
      {
        sessionKey: 's1',
        lessonCalls: [
          { kind: 'search', query: 'q', lessonIds: [], outcome: 'unavailable', detail: 'down' },
          {
            kind: 'reinforce',
            lessonId: LESSON_A,
            occurrenceRef: 'r',
            outcome: 'already_counted',
            counted: false,
          },
        ],
      },
      fx.ctx,
    );
    const rows = await callsOf(planId);
    expect(rows.map((r) => [r.outcome, r.detail, r.counted, r.lessonIds])).toEqual([
      ['unavailable', 'down', null, []],
      ['already_counted', null, false, []],
    ]);
  });

  it.each([
    ['a batch over the cap', Array.from({ length: PLAN_LESSON_CALL_BATCH_MAX + 1 }, () => search)],
    ['not an array', 'search'],
    ['an unknown kind', [{ ...search, kind: 'browse' }]],
    ['a call with no outcome', [{ ...search, outcome: undefined }]],
    ['a call carrying a lesson’s text', [{ ...search, howToApply: 'Audit each edge.' }]],
    ['a malformed lesson id', [{ ...search, lessonIds: ['not an id!'] }]],
    ['a search naming one lessonId', [{ ...search, lessonId: LESSON_A }]],
    [
      'a reinforce naming lessonIds',
      [{ kind: 'reinforce', lessonIds: [LESSON_A], outcome: 'counted' }],
    ],
    [
      'a reinforce with a query',
      [{ kind: 'reinforce', lessonId: LESSON_A, query: 'q', outcome: 'counted' }],
    ],
  ])('refuses %s, writing nothing — not even the marker', async (_label, lessonCalls) => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await expect(
      plansService.recordPlanLessonCalls(
        planId,
        { sessionKey: 's1', lessonCalls: lessonCalls as unknown },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await callsOf(planId)).toEqual([]);
    expect(await sessionsOf(planId)).toEqual([]);
  });

  it('caps a long field', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const [row] = await plansService.recordPlanLessonCalls(
      planId,
      { sessionKey: 's1', lessonCalls: [{ ...search, query: 'q'.repeat(5000) }] },
      fx.ctx,
    );
    expect(Array.from(row!.query!)).toHaveLength(1000);
    expect(row!.query!.endsWith('…')).toBe(true);
  });

  it('is refused once the plan is no longer generating', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await expect(
      plansService.recordPlanLessonCalls(planId, { sessionKey: 's1', lessonCalls: [] }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotGeneratingError);
    expect(await sessionsOf(planId)).toEqual([]);
  });

  it('is the sixth exclusive form of reportPlanStep, and names no target', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    const result = await plansService.reportPlanStep(
      planId,
      { sessionKey: 's1', targetRef: null, lessonCalls: [search] },
      fx.ctx,
    );
    expect(result.kind).toBe('lessonCalls');
    await expect(
      plansService.reportPlanStep(
        planId,
        { sessionKey: 's1', targetRef: 'planItem:x', lessonCalls: [search] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    await expect(
      plansService.reportPlanStep(
        planId,
        { sessionKey: 's1', targetRef: null, step: 'settle', lessonCalls: [search] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidPlanStepError);
    expect(await callsOf(planId)).toHaveLength(1);
  });
});

describe('listPlanLessonLog — reads back by plan and session, recorded or not', () => {
  it('pages calls in seq order and lists every recorded session, an empty one included', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'lay', kind: 'lay', targetRef: null },
      fx.ctx,
    );
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'author-unrecorded', kind: 'author', targetRef: null },
      fx.ctx,
    );
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'author-silent', kind: 'author', targetRef: null },
      fx.ctx,
    );
    await plansService.recordPlanLessonCalls(
      planId,
      { sessionKey: 'lay', lessonCalls: [search, { ...search, query: 'second' }] },
      fx.ctx,
    );
    await plansService.recordPlanLessonCalls(
      planId,
      { sessionKey: 'author-silent', lessonCalls: [] },
      fx.ctx,
    );
    await plansService.recordPlanLessonCalls(
      planId,
      { sessionKey: 'conversation', lessonCalls: [{ ...search, query: 'third' }] },
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    // Readable after the plan is decided-ready — it is evidence, not a live signal.
    const first = await plansService.listPlanLessonLog(planId, { limit: 2 }, fx.ctx);
    expect(first.calls.map((c) => [c.seq, c.query])).toEqual([
      [1, search.query],
      [2, 'second'],
    ]);
    expect(first.nextAfterSeq).toBe(2);
    expect(first.sessions.map((s) => [s.sessionKey, s.calls, s.step?.stepKind ?? null])).toEqual([
      ['lay', 2, 'lay'],
      ['author-silent', 0, 'author'],
      ['conversation', 1, null],
    ]);
    // A session that reported a step but no lesson log is NOT read as "never searched".
    expect(first.unrecordedSessions.map((s) => s.sessionKey)).toEqual(['author-unrecorded']);

    const rest = await plansService.listPlanLessonLog(planId, { afterSeq: 2 }, fx.ctx);
    expect(rest.calls.map((c) => c.query)).toEqual(['third']);
    expect(rest.sessions).toHaveLength(3);
    expect(rest.nextAfterSeq).toBeNull();

    const one = await plansService.listPlanLessonLog(
      planId,
      { sessionKey: 'author-silent' },
      fx.ctx,
    );
    expect(one.calls).toEqual([]);
    expect(one.sessions.map((s) => [s.sessionKey, s.calls])).toEqual([['author-silent', 0]]);
    expect(one.unrecordedSessions).toEqual([]);

    const unrecorded = await plansService.listPlanLessonLog(
      planId,
      { sessionKey: 'author-unrecorded' },
      fx.ctx,
    );
    expect(unrecorded.sessions).toEqual([]);
    expect(unrecorded.unrecordedSessions.map((s) => s.sessionKey)).toEqual(['author-unrecorded']);
  });

  it('answers another workspace’s plan as not found', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await expect(plansService.listPlanLessonLog(planB, {}, a.ctx)).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
  });

  it('cascades away with the plan', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await generatingPlan(fx);
    await plansService.recordPlanLessonCalls(
      planId,
      { sessionKey: 's', lessonCalls: [search] },
      fx.ctx,
    );
    await adminDb.plan.delete({ where: { id: planId } });
    expect(await callsOf(planId)).toEqual([]);
    expect(await sessionsOf(planId)).toEqual([]);
  });
});

describe('plan_lesson_call / plan_lesson_session RLS — the gate is the parent plan', () => {
  async function asAppRole<T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx);
    });
  }

  it('another workspace’s log is neither readable nor writable', async () => {
    const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const planB = await generatingPlan(b);
    await plansService.recordPlanLessonCalls(
      planB,
      { sessionKey: 'b', lessonCalls: [search] },
      b.ctx,
    );

    expect(await asAppRole(a.workspaceId, (tx) => tx.planLessonCall.findMany())).toEqual([]);
    expect(await asAppRole(a.workspaceId, (tx) => tx.planLessonSession.findMany())).toEqual([]);
    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.planLessonCall.create({
          data: {
            planId: planB,
            sessionKey: 'x',
            seq: 99,
            kind: 'search',
            filters: {},
            lessonIds: [],
            outcome: 'matched',
          },
        }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    await expect(
      asAppRole(a.workspaceId, (tx) =>
        tx.planLessonSession.create({ data: { planId: planB, sessionKey: 'x' } }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    expect(await asAppRole(b.workspaceId, (tx) => tx.planLessonCall.findMany())).toHaveLength(1);
    expect(await asAppRole(b.workspaceId, (tx) => tx.planLessonSession.findMany())).toHaveLength(1);
  });
});
