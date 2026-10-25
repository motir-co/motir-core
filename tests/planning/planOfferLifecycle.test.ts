import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { GuideReplanOfferState } from '@/lib/planning/guideReplanOffer';
import {
  cannotStartOf,
  pendingPlanOfferOf,
  planOfferStateOf,
  recordedRefusalOf,
  PLAN_OFFER_CANNOT_START_ORDER,
  type PlanOfferCannotStart,
  type PlanOfferRecord,
  type PlanOfferState,
  type PlanOfferTurn,
} from '@/lib/planChange/planOffer';
import { readAskOutcome, type AskPlanOffer } from '@/lib/planning/askResult';
import { createTestProject } from '../fixtures/projectFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// THE PLAN OFFER'S LIFECYCLE (Story MOTIR-9219 · MOTIR-9290). The pure rule as unit
// tests; the landing, the decline door and the recorded refusal through the shipped
// ask settle on REAL Postgres. Mocked: only the motir-ai boundary (`submitJob` /
// `getJob`), whose envelope is the input under test.

// ── the pure half ────────────────────────────────────────────────────────────────

const OPEN: PlanOfferRecord = {
  kind: 'plan',
  requestMd: 'Plan the export.',
  targetKey: null,
  declinedAt: null,
  confirmedAt: null,
  confirmedSessionId: null,
};

function user(seq: number): PlanOfferTurn {
  return { id: `u${seq}`, seq, role: 'user', offer: null };
}
function answer(seq: number, offer: Partial<PlanOfferRecord> | null = null): PlanOfferTurn {
  return { id: `a${seq}`, seq, role: 'assistant', offer: offer ? { ...OPEN, ...offer } : null };
}

describe('planOfferStateOf', () => {
  it('reads each of the four states, and null for a turn with no offer', () => {
    const turns = [user(0), answer(1, {}), user(2), answer(3, {})];
    expect(planOfferStateOf(turns, 'a1')).toBe('superseded');
    expect(planOfferStateOf(turns, 'a3')).toBe('undecided');
    expect(planOfferStateOf(turns, 'u0')).toBeNull();
    expect(planOfferStateOf(turns, 'missing')).toBeNull();
    expect(planOfferStateOf([answer(0, { declinedAt: 'x' })], 'a0')).toBe('declined');
    expect(planOfferStateOf([answer(0, { confirmedSessionId: 's' })], 'a0')).toBe('confirmed');
    expect(planOfferStateOf([answer(0, { confirmedAt: 't' })], 'a0')).toBe('confirmed');
  });

  it('supersedes on ANY later answer, even one that carries no offer', () => {
    const turns = [answer(0, {}), user(1), answer(2)];
    expect(planOfferStateOf(turns, 'a0')).toBe('superseded');
    // A later USER turn alone supersedes nothing.
    expect(planOfferStateOf([answer(0, {}), user(1)], 'a0')).toBe('undecided');
  });

  it('keeps a stored disposition over a later answer: confirmed > declined > superseded', () => {
    const later = [user(1), answer(2, {})];
    expect(
      planOfferStateOf([answer(0, { confirmedSessionId: 's', declinedAt: 'x' }), ...later], 'a0'),
    ).toBe('confirmed');
    expect(planOfferStateOf([answer(0, { declinedAt: 'x' }), ...later], 'a0')).toBe('declined');
  });

  it('a user turn never holds an offer, whatever it carries', () => {
    const odd: PlanOfferTurn = { id: 'u0', seq: 0, role: 'user', offer: OPEN };
    expect(planOfferStateOf([odd], 'u0')).toBeNull();
    expect(pendingPlanOfferOf([odd])).toBeNull();
  });
});

describe('pendingPlanOfferOf', () => {
  it('is the latest answer’s offer exactly when it is undecided, agreeing with the state', () => {
    const turns = [answer(0, {}), user(1), answer(2, { requestMd: 'Latest.' }), user(3)];
    expect(pendingPlanOfferOf(turns)).toEqual({
      turnId: 'a2',
      seq: 2,
      offer: { ...OPEN, requestMd: 'Latest.' },
    });
    expect(planOfferStateOf(turns, 'a2')).toBe('undecided');
  });

  it('is null after a later answer with no offer, and on a decided latest offer', () => {
    expect(pendingPlanOfferOf([answer(0, {}), user(1), answer(2)])).toBeNull();
    expect(pendingPlanOfferOf([answer(0, { declinedAt: 'x' })])).toBeNull();
    expect(pendingPlanOfferOf([answer(0, { confirmedSessionId: 's' })])).toBeNull();
    expect(pendingPlanOfferOf([user(0)])).toBeNull();
    expect(pendingPlanOfferOf([])).toBeNull();
  });
});

describe('cannotStartOf', () => {
  const none = {
    planningAvailable: true,
    targetClosed: false,
    targetHeld: false,
    outOfCredits: false,
  };

  it('is null when nothing holds, and names each reason alone', () => {
    expect(cannotStartOf(none)).toBeNull();
    expect(cannotStartOf({ ...none, planningAvailable: false })).toBe('planning_unavailable');
    expect(cannotStartOf({ ...none, targetClosed: true })).toBe('target_closed');
    expect(cannotStartOf({ ...none, targetHeld: true })).toBe('target_held');
    expect(cannotStartOf({ ...none, outOfCredits: true })).toBe('out_of_credits');
  });

  it('serves the first reason in the fixed order when several hold', () => {
    expect(PLAN_OFFER_CANNOT_START_ORDER).toEqual([
      'planning_unavailable',
      'target_closed',
      'target_held',
      'out_of_credits',
    ]);
    expect(cannotStartOf({ ...none, targetClosed: true, targetHeld: true })).toBe('target_closed');
    const all = {
      planningAvailable: false,
      targetClosed: true,
      targetHeld: true,
      outOfCredits: true,
    };
    expect(cannotStartOf(all)).toBe('planning_unavailable');
    expect(cannotStartOf({ ...all, planningAvailable: true })).toBe('target_closed');
    expect(cannotStartOf({ ...none, targetHeld: true, outOfCredits: true })).toBe('target_held');
  });
});

describe('the two offer lifecycles share one vocabulary', () => {
  it('PlanOfferState and GuideReplanOfferState admit the same four members', () => {
    const plan: Record<PlanOfferState, true> = {
      undecided: true,
      superseded: true,
      declined: true,
      confirmed: true,
    };
    // Typed as the GUIDE's record: a member either union lacks fails to compile.
    const guide: Record<GuideReplanOfferState, true> = plan;
    const back: Record<PlanOfferState, true> = guide;
    expect(Object.keys(back).sort()).toEqual(['confirmed', 'declined', 'superseded', 'undecided']);
    const reasons: Record<PlanOfferCannotStart, true> = {
      planning_unavailable: true,
      target_closed: true,
      target_held: true,
      out_of_credits: true,
    };
    expect(Object.keys(reasons).sort()).toEqual([...PLAN_OFFER_CANNOT_START_ORDER].sort());
  });
});

describe('recordedRefusalOf', () => {
  it('reads only an out_of_credits record with a time', () => {
    expect(recordedRefusalOf(null)).toBeNull();
    expect(recordedRefusalOf([])).toBeNull();
    expect(recordedRefusalOf({})).toBeNull();
    expect(recordedRefusalOf({ startRefusal: 'x' })).toBeNull();
    expect(recordedRefusalOf({ startRefusal: { reason: 'other', at: 't' } })).toBeNull();
    expect(recordedRefusalOf({ startRefusal: { reason: 'out_of_credits' } })).toBeNull();
    expect(
      recordedRefusalOf({ startRefusal: { reason: 'out_of_credits', at: 't', detail: 7 } }),
    ).toEqual({ reason: 'out_of_credits', detail: null, at: 't' });
  });
});

describe('readAskOutcome reads the envelope offer', () => {
  const ask = (offer: unknown) => readAskOutcome({ ask: { intent: 'ask', answer: 'A.', offer } });

  it('maps requestText onto requestMd and defaults immediate to false', () => {
    expect(ask({ kind: 'plan', requestText: ' Plan it. ', targetKey: 'PROD-1' })?.offer).toEqual({
      kind: 'plan',
      requestMd: 'Plan it.',
      targetKey: 'PROD-1',
      immediate: false,
    });
    expect(
      (ask({ kind: 'plan', requestText: 'x', immediate: 'yes' })?.offer as AskPlanOffer | undefined)
        ?.immediate,
    ).toBe(false);
    expect(
      (ask({ kind: 'plan', requestText: 'x', immediate: true })?.offer as AskPlanOffer | undefined)
        ?.immediate,
    ).toBe(true);
    expect(
      (
        ask({ kind: 'plan', requestText: 'x', targetKey: 'not a key' })?.offer as
          | AskPlanOffer
          | undefined
      )?.targetKey,
    ).toBe(null);
  });

  it('reads an unknown kind, a blank request and no offer as ABSENCE', () => {
    for (const offer of [
      { kind: 'log_bug', requestText: 'File it.' },
      { kind: 'PLAN', requestText: 'x' },
      { kind: 'plan', requestText: '   ' },
      'plan',
      undefined,
    ]) {
      const out = ask(offer);
      expect(out?.answer).toBe('A.');
      expect(out && 'offer' in out).toBe(false);
    }
  });
});

// ── the database half ──────────────────────────────────────────────────────────

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planOfferService } = await import('@/lib/services/planOfferService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { PlanOfferNotFoundError, PlanOfferNotOpenError, PlanChangeSessionNotFoundError } =
  await import('@/lib/planChange/errors');

const T = { timeout: 120_000 };

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

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function ctxOf(userId: string): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}
const owner = () => ctxOf(fx.ownerId);

async function task(title = 'CSV export') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** A workspace member in the fixture's project; `permissions` gives them a custom role. */
async function member(label: string, permissions?: string[]): Promise<ProjectContext> {
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
  if (permissions) await restrict(u.id, permissions);
  return ctxOf(u.id);
}

async function restrict(userId: string, permissions: string[]) {
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: `Role ${userId}`,
    permissions,
  });
  await setProjectRoleAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: userId,
    role: role.id,
  });
}

/** Type `body`, settle its job with `ask`, and return the thread after the settle. */
async function turn(
  pctx: ProjectContext,
  body: string,
  ask: Record<string, unknown>,
  sessionId?: string,
) {
  const submitted = await aiAskService.submitTurn(body, pctx, sessionId ? { sessionId } : {});
  if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
  const jobId = submitted.jobId;
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
  const settled = await aiAskService.settle(jobId, pctx, { sessionId: submitted.session.id });
  return { jobId, sessionId: submitted.session.id, session: settled.session };
}

const answerWith = (offer?: Record<string, unknown>) => ({
  intent: 'ask',
  answer: 'Here is how the export works.',
  citations: [],
  ...(offer ? { offer } : {}),
});
const planOffer = (targetKey?: string, extra: Record<string, unknown> = {}) => ({
  kind: 'plan',
  requestText: 'Plan custom fields in the CSV export.',
  ...(targetKey ? { targetKey } : {}),
  immediate: false,
  ...extra,
});

function lastAnswer(turns: readonly PlanChangeTurnDto[]): PlanChangeTurnDto {
  return turns.filter((t) => t.role === 'assistant').at(-1)!;
}

async function threadOf(pctx: ProjectContext, sessionId: string) {
  return (await planChangeSessionsService.getById(pctx, sessionId)).turns;
}

/** The context the LAST submit sent to motir-ai. */
function lastContext(): Record<string, unknown> {
  return submitJobMock.mock.calls.at(-1)![2] as Record<string, unknown>;
}

describe('land — the offer rides the answer’s own append', () => {
  it(
    'stores a non-immediate plan offer on the answer turn, undecided and startable',
    T,
    async () => {
      const target = await task();
      const { session } = await turn(
        owner(),
        'Can we export custom fields?',
        answerWith(planOffer(target.identifier)),
      );
      const a = lastAnswer(session.turns);
      expect(a.body).toBe('Here is how the export works.');
      expect(a.offer).toMatchObject({
        kind: 'plan',
        requestMd: 'Plan custom fields in the CSV export.',
        targetKey: target.identifier,
        declinedAt: null,
        confirmedSessionId: null,
        state: 'undecided',
        cannotStart: null,
      });
    },
  );

  it(
    'keeps the composed requirement on a no-target offer and drops it on a targeted one',
    T,
    async () => {
      const requirement = {
        outcome: 'Plan from the pane.',
        behaviour: 'Show it before Confirm.',
        scopeEdge: '',
        constraints: '',
        acceptance: 'Six headings.',
        assumptions: [{ id: 'r1', text: 'One pane.' }],
      };
      const noTarget = await turn(
        owner(),
        'Plan something new',
        answerWith(planOffer(undefined, { requirement })),
      );
      expect(lastAnswer(noTarget.session.turns).offer).toMatchObject({
        targetKey: null,
        requirement,
      });

      const target = await task();
      const targeted = await turn(
        owner(),
        'Plan the export',
        answerWith(planOffer(target.identifier, { requirement })),
      );
      const offer = lastAnswer(targeted.session.turns).offer!;
      expect(offer.targetKey).toBe(target.identifier);
      expect('requirement' in offer).toBe(false);

      // A target that does not resolve for the caller lands with no target, and still
      // stores no requirement: it was composed for a targeted offer.
      const unresolved = await turn(
        owner(),
        'Plan the other one',
        answerWith(planOffer('NOPE-9', { requirement })),
      );
      const lost = lastAnswer(unresolved.session.turns).offer!;
      expect(lost.targetKey).toBeNull();
      expect('requirement' in lost).toBe(false);
    },
  );

  it('stores NO offer for an immediate offer, an unknown kind, or no offer at all', T, async () => {
    const target = await task();
    for (const ask of [
      answerWith(planOffer(target.identifier, { immediate: true })),
      answerWith({ kind: 'log_bug', requestText: 'File the bug.' }),
      answerWith(),
    ]) {
      // An immediate offer starts at once (MOTIR-9291) and its settle answers the
      // session it landed on, so the answer is read off the conversation itself.
      const { sessionId } = await turn(owner(), `Turn ${jobSeq}`, ask);
      const a = lastAnswer(await threadOf(owner(), sessionId));
      expect(a.body).toBe('Here is how the export works.');
      expect(a.offer).toBeNull();
      const row = await adminDb.planChangeTurn.findFirstOrThrow({ where: { id: a.id } });
      expect(row.answerOffer).toBeNull();
    }
  });

  it(
    'appends the answer without the offer when the caller lacks work_item:edit, or AI is unconfigured',
    T,
    async () => {
      const target = await task();
      const asker = await member('ask-only', ['project:browse', 'ai:plan']);
      const noEdit = await turn(
        asker,
        'Plan custom fields?',
        answerWith(planOffer(target.identifier)),
      );
      expect(lastAnswer(noEdit.session.turns).body).toBe('Here is how the export works.');
      expect(lastAnswer(noEdit.session.turns).offer).toBeNull();

      // The same turn by a member holding both writes the offer.
      const both = await member('both');
      const ok = await turn(both, 'Plan custom fields?', answerWith(planOffer(target.identifier)));
      expect(lastAnswer(ok.session.turns).offer?.targetKey).toBe(target.identifier);

      const submitted = await aiAskService.submitTurn('Plan it?', owner());
      if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
      jobs.set(submitted.jobId, {
        jobId: submitted.jobId,
        status: 'succeeded',
        result: { ask: answerWith(planOffer(target.identifier)) },
        error: null,
      });
      vi.stubEnv('MOTIR_AI_URL', '');
      const settled = await aiAskService.settle(submitted.jobId, owner(), {
        sessionId: submitted.session.id,
      });
      expect(lastAnswer(settled.session.turns).body).toBe('Here is how the export works.');
      expect(lastAnswer(settled.session.turns).offer).toBeNull();
    },
  );

  it('lands a target in another project, or an unknown key, as NO target', T, async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTHR',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'task', title: 'Foreign' },
      fx.ctx,
    );
    expect(foreign.identifier).toBe('OTHR-1');
    // A member of THIS project only: the scoped read and an unscoped one differ.
    const m = await member('scoped');
    const a = await turn(m, 'Plan that?', answerWith(planOffer(foreign.identifier)));
    expect(lastAnswer(a.session.turns).offer).toMatchObject({
      targetKey: null,
      state: 'undecided',
    });
    const b = await turn(m, 'And this?', answerWith(planOffer('PROD-999')), a.sessionId);
    expect(lastAnswer(b.session.turns).offer?.targetKey).toBeNull();
  });

  it('lands NO offer for a target that is already done or cancelled', T, async () => {
    const done = await task('Shipped export');
    await adminDb.workItem.update({ where: { id: done.id }, data: { status: 'cancelled' } });
    const { session } = await turn(
      owner(),
      'Plan it again?',
      answerWith(planOffer(done.identifier)),
    );
    expect(lastAnswer(session.turns).body).toBe('Here is how the export works.');
    expect(lastAnswer(session.turns).offer).toBeNull();
  });

  it(
    'a replayed settle appends one answer and one offer, and keeps a decline standing',
    T,
    async () => {
      const target = await task();
      const { jobId, sessionId } = await turn(
        owner(),
        'Plan it?',
        answerWith(planOffer(target.identifier)),
      );
      const a = lastAnswer(await threadOf(owner(), sessionId));
      await planOfferService.declinePlanOffer(a.id, owner(), { sessionId });
      const replay = await aiAskService.settle(jobId, owner(), { sessionId });
      const answers = replay.session.turns.filter((t) => t.role === 'assistant');
      expect(answers).toHaveLength(1);
      expect(answers[0]!.offer?.state).toBe('declined');
      expect(submitJobMock).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'the answer arm plans nothing: no submit beyond the ask, no plan_change intent',
    T,
    async () => {
      const target = await task();
      const { session } = await turn(owner(), 'Plan it?', answerWith(planOffer(target.identifier)));
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      expect(submitJobMock.mock.calls[0]![0]).toBe('ask_project');
      const intents = session.turns.filter((t) => t.role === 'user').map((t) => t.intent);
      expect(intents).toEqual(['ask']);
      expect(await adminDb.plan.count()).toBe(0);
    },
  );
});

describe('pendingPlanOffer on the ask context', () => {
  it('states the live offer read before the append, and is ABSENT when none is', T, async () => {
    const target = await task();
    const first = await turn(owner(), 'Plan it?', answerWith(planOffer(target.identifier)));
    expect('pendingPlanOffer' in lastContext()).toBe(false);
    const offered = lastAnswer(first.session.turns);

    const second = await turn(owner(), 'Yes, go on.', answerWith(), first.sessionId);
    expect(lastContext()['pendingPlanOffer']).toEqual({
      kind: 'plan',
      requestText: 'Plan custom fields in the CSV export.',
      targetKey: target.identifier,
      seq: offered.seq,
    });
    // That answer carried no offer, so the first is superseded and nothing is pending.
    expect(second.session.turns.find((t) => t.id === offered.id)!.offer?.state).toBe('superseded');
    await turn(owner(), 'Anything else?', answerWith(), first.sessionId);
    expect('pendingPlanOffer' in lastContext()).toBe(false);
  });

  it('is not sent with a run: the snapshot states its own offer', T, async () => {
    const target = await task();
    const first = await turn(owner(), 'Plan it?', answerWith(planOffer(target.identifier)));
    await adminDb.planChangeSession.update({
      where: { id: first.sessionId },
      data: { lastJobId: 'job-run', lastSubmittedAt: new Date() },
    });
    await aiAskService.submitMidRunTurn('Mid-run question', owner(), {
      sessionId: first.sessionId,
      runJobId: 'job-run',
      planId: 'plan-missing',
    });
    const context = lastContext();
    expect(context['run']).toBeDefined();
    expect('pendingPlanOffer' in context).toBe(false);
  });
});

describe('declinePlanOffer', () => {
  it('declines an undecided offer once, idempotently, appending nothing', T, async () => {
    const target = await task();
    const { sessionId, session } = await turn(
      owner(),
      'Plan it?',
      answerWith(planOffer(target.identifier)),
    );
    const a = lastAnswer(session.turns);
    const before = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });

    const declined = await planOfferService.declinePlanOffer(a.id, owner(), { sessionId });
    const offer = declined.turns.find((t) => t.id === a.id)!.offer!;
    expect(offer.state).toBe('declined');
    expect(offer.declinedById).toBe(fx.ownerId);
    expect(offer.declinedAt).not.toBeNull();

    const again = await planOfferService.declinePlanOffer(a.id, owner(), { sessionId });
    expect(again.turns).toEqual(declined.turns);

    const after = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(after.turnCount).toBe(before.turnCount);
    expect(after.lastActivityAt).toEqual(before.lastActivityAt);
    expect(submitJobMock).toHaveBeenCalledTimes(1);
  });

  it(
    'refuses a superseded or confirmed offer, a turn with no offer, and another member',
    T,
    async () => {
      const target = await task();
      const first = await turn(owner(), 'Plan it?', answerWith(planOffer(target.identifier)));
      const older = lastAnswer(first.session.turns);
      const second = await turn(owner(), 'Or this?', answerWith(planOffer()), first.sessionId);
      const newer = lastAnswer(second.session.turns);
      const sessionId = first.sessionId;

      await expect(
        planOfferService.declinePlanOffer(older.id, owner(), { sessionId }),
      ).rejects.toBeInstanceOf(PlanOfferNotOpenError);
      const userTurn = second.session.turns.find((t) => t.role === 'user')!;
      await expect(
        planOfferService.declinePlanOffer(userTurn.id, owner(), { sessionId }),
      ).rejects.toBeInstanceOf(PlanOfferNotFoundError);
      const other = await member('other');
      await expect(
        planOfferService.declinePlanOffer(newer.id, other, { sessionId }),
      ).rejects.toBeInstanceOf(PlanChangeSessionNotFoundError);

      // A stored confirmation (One start per offer's write) reads confirmed, and stays
      // so after a later answer.
      const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: newer.id } });
      await adminDb.planChangeTurn.update({
        where: { id: newer.id },
        data: {
          answerOffer: {
            ...(row.answerOffer as Record<string, unknown>),
            confirmedAt: new Date().toISOString(),
            confirmedById: fx.ownerId,
            confirmedSessionId: sessionId,
          },
        },
      });
      await turn(owner(), 'Thanks.', answerWith(), sessionId);
      const turns = await threadOf(owner(), sessionId);
      expect(turns.find((t) => t.id === newer.id)!.offer?.state).toBe('confirmed');
      await expect(
        planOfferService.declinePlanOffer(newer.id, owner(), { sessionId }),
      ).rejects.toBeInstanceOf(PlanOfferNotOpenError);
      const stored = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: newer.id } });
      expect((stored.answerOffer as Record<string, unknown>)['declinedAt']).toBeNull();
    },
  );
});

describe('cannotStart — resolved live on every read', () => {
  async function offered() {
    const target = await task();
    const { sessionId, session } = await turn(
      owner(),
      'Plan it?',
      answerWith(planOffer(target.identifier)),
    );
    const turnId = lastAnswer(session.turns).id;
    const read = async (pctx = owner()) =>
      (await threadOf(pctx, sessionId)).find((t) => t.id === turnId)!.offer!.cannotStart;
    return { target, sessionId, turnId, read };
  }

  async function lockBy(
    workItemId: string,
    holder: { sessionId?: string; planId?: string },
    expiresAt: Date,
  ) {
    await adminDb.planTargetLock.deleteMany({ where: { workItemId } });
    await adminDb.planTargetLock.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId,
        sessionId: holder.sessionId ?? null,
        planId: holder.planId ?? null,
        heldById: fx.ownerId,
        priorStatus: 'todo',
        expiresAt,
      },
    });
  }

  it('target_closed once the stored target closes', T, async () => {
    const o = await offered();
    expect(await o.read()).toBeNull();
    await adminDb.workItem.update({ where: { id: o.target.id }, data: { status: 'done' } });
    expect(await o.read()).toBe('target_closed');
  });

  it(
    'target_held for another session’s live lease; none for an expired one or its own',
    T,
    async () => {
      const o = await offered();
      const elsewhere = await adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          createdById: fx.ownerId,
          scopeKey: 'other-scope',
          targetKeys: [o.target.identifier],
        },
      });
      const soon = new Date(Date.now() + 60_000);
      await lockBy(o.target.id, { sessionId: elsewhere.id }, soon);
      expect(await o.read()).toBe('target_held');
      await lockBy(o.target.id, { sessionId: elsewhere.id }, new Date(Date.now() - 1_000));
      expect(await o.read()).toBeNull();
      await lockBy(o.target.id, { sessionId: o.sessionId }, soon);
      expect(await o.read()).toBeNull();

      // Closed AND held: the first reason in the fixed order, on every read.
      await lockBy(o.target.id, { sessionId: elsewhere.id }, soon);
      await adminDb.workItem.update({ where: { id: o.target.id }, data: { status: 'cancelled' } });
      expect(await o.read()).toBe('target_closed');
      expect(await o.read()).toBe('target_closed');
    },
  );

  it(
    'planning_unavailable when the caller loses work_item:edit, or AI is unconfigured',
    T,
    async () => {
      const o = await offered();
      vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
      expect(await o.read()).toBe('planning_unavailable');
      vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
      expect(await o.read()).toBeNull();

      // A member's own offer, read after their role loses work_item:edit.
      const m = await member('loses-edit');
      const mine = await turn(m, 'Plan it?', answerWith(planOffer(o.target.identifier)));
      const mineId = lastAnswer(mine.session.turns).id;
      await restrict(m.userId, ['project:browse', 'ai:plan']);
      const turns = await threadOf(m, mine.sessionId);
      expect(turns.find((t) => t.id === mineId)!.offer?.cannotStart).toBe('planning_unavailable');
    },
  );

  it('out_of_credits once recorded, idempotently, and only on an offer', T, async () => {
    const o = await offered();
    const first = await planOfferService.recordCannotStart(
      o.turnId,
      'out_of_credits',
      'no credits',
      owner(),
      {
        sessionId: o.sessionId,
      },
    );
    expect(first.turns.find((t) => t.id === o.turnId)!.offer?.cannotStart).toBe('out_of_credits');
    const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: o.turnId } });
    const at = recordedRefusalOf(row.answerOffer)!.at;
    await planOfferService.recordCannotStart(o.turnId, 'out_of_credits', 'again', owner(), {
      sessionId: o.sessionId,
    });
    const again = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: o.turnId } });
    expect(recordedRefusalOf(again.answerOffer)).toEqual({
      reason: 'out_of_credits',
      detail: 'no credits',
      at,
    });
    const userTurn = (await threadOf(owner(), o.sessionId)).find((t) => t.role === 'user')!;
    await expect(
      planOfferService.recordCannotStart(userTurn.id, 'out_of_credits', null, owner(), {
        sessionId: o.sessionId,
      }),
    ).rejects.toBeInstanceOf(PlanOfferNotFoundError);
  });
});
