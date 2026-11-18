import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeScope } from '@/lib/planChange/scope';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { addressOf, openTestSession } from '../helpers/planSession';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { PlanChangeAnswerOptionUnknownError } from '@/lib/planChange/errors';

// The PLANNER'S TURN in the plan-change thread (MOTIR-2226) — the consuming half
// of MOTIR-2222's boundary contract, against a REAL Postgres (the motir-core
// convention). Only the motir-ai boundary client is mocked, which is the same
// exception every AI service test takes; the enum, the row lock, the
// `(session_id, seq)` unique, the workspace scoping and the access gate all run
// for real.
//
// What these prove, criterion by criterion:
//   * the new `assistant` role persists, carrying its producing `jobId` and a
//     NULL `authorId`, and leaves existing `user` / `system` turns untouched;
//   * it rides the SAME row-locked, read-derived `seq` allocation — including
//     under genuine concurrency, so no second allocation route was introduced;
//   * exactly ONE assistant turn per job, however many times the recording is
//     replayed (a reload, a second tab, a re-read);
//   * a job that carries no utterance is NOT an error — the run still happened;
//   * the report's bare work-item keys are rewritten to the canonical chip token
//     and resolved into the session DTO's `workItemRefs`.

const getJobMock = vi.fn();
const submitJobMock = vi.fn(async () => ({ jobId: 'job-augment-1' }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
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

// The session each case works on (MOTIR-6028). Every write names its session by
// id now that the scope-keyed wrappers are gone; `openCurrent` opens (or resumes)
// it the way the public `open` doors do and remembers its address.
let current: { sessionId: string } = { sessionId: '' };
async function openCurrent(pctx: ProjectContext, scope?: PlanChangeScope) {
  const session = await openTestSession(pctx, scope);
  current = addressOf(session);
  return session;
}

function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** A settled job whose result carries the planner's utterance. */
function jobWithTurn(turn: unknown) {
  return { jobId: 'job-augment-1', status: 'succeeded', result: { turn }, error: null };
}

/** Open a thread, put a user turn on it, and SUBMIT — the state a real planner
 *  turn always arrives into (the recording is gated on the thread's own job). */
async function submittedThread(ctx: ProjectContext) {
  await openCurrent(ctx);
  await planChangeSessionsService.appendTurn('add payments', ctx, current);
  return planChangeSessionsService.submit(ctx, current);
}

async function threadRows(fx: WorkItemFixture) {
  const session = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planChangeSessionRepository.findByIdInProject(
      current.sessionId,
      fx.projectId,
      fx.workspaceId,
      tx,
    ),
  );
  return withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planChangeTurnRepository.listBySessionId(session!.id, fx.workspaceId, tx),
  );
}

let fx: WorkItemFixture;

beforeEach(async () => {
  current = { sessionId: '' };
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
  getJobMock.mockReset();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('recordPlannerTurn — the assistant turn persists', () => {
  it('files the planner’s report as an `assistant` turn with its jobId and a NULL authorId', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'I searched the plan.', question: null }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    const assistant = dto.turns.filter((t) => t.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.body).toBe('I searched the plan.');
    // The producing job rides on the turn — it is provenance AND the idempotency
    // key the replay guard below depends on.
    expect(assistant[0]!.jobId).toBe('job-augment-1');
    // No human wrote it, exactly as for a `system` marker.
    expect(assistant[0]!.authorId).toBeNull();
    expect(assistant[0]!.question).toBeNull();
    expect(assistant[0]!.isAnswer).toBe(false);
  });

  it('carries the ONE Gate-2 question when the turn asked', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({
        action: 'ask',
        message: 'When you say “add payments” — which direction?',
        question: 'Taking money in, or paying suppliers out?',
      }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);
    const asked = dto.turns.find((t) => t.role === 'assistant');
    // Persisted, not held on the client — this is the whole reason the pending
    // question survives a reload and can still be answered tomorrow.
    expect(asked!.question).toBe('Taking money in, or paying suppliers out?');
  });

  it('leaves the EXISTING `user` and `system` turns untouched', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    const before = await threadRows(fx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    const after = await threadRows(fx);
    // Byte-for-byte identical rows, in the same positions: adding an enum member
    // and two defaulted columns changes nothing that already existed.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(before.map((r) => r.role)).toEqual(['user', 'system']);
    expect(before.every((r) => r.isAnswer === false && r.question === null)).toBe(true);
  });
});

describe('recordPlannerTurn — an unreadable code graph (MOTIR-8141)', () => {
  const halted = {
    jobId: 'job-augment-1',
    status: 'succeeded',
    result: { codeUnreadable: { halt: 'code_unreadable', repoRef: 'acme/web', reason: 'down' } },
    error: null,
  };

  it('files ONE declined assistant turn that remembers the outage, and writes no plan', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(halted);

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    const assistant = dto.turns.filter((t) => t.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.codeUnreadable).toBe('declined');
    expect(assistant[0]!.jobId).toBe('job-augment-1');
    expect(assistant[0]!.question).toBeNull();
    expect(assistant[0]!.body.length).toBeGreaterThan(0);
  });

  it('is idempotent: a replayed settle writes no second turn', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(halted);

    await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);
    const again = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    expect(again.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
  });

  it('leaves an ordinary turn with no outage mark', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    expect(dto.turns.find((t) => t.role === 'assistant')!.codeUnreadable).toBeNull();
  });
});

describe('recordPlannerTurn — the SAME locked seq allocation', () => {
  it('appends on the shared row-locked path: gapless seq, bumped turnCount', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.role)).toEqual(['user', 'system', 'assistant']);
    const session = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeSessionRepository.findByIdInProject(
        current.sessionId,
        fx.projectId,
        fx.workspaceId,
        tx,
      ),
    );
    expect(session!.turnCount).toBe(3);
  });

  it('SERIALIZES an assistant turn racing a user turn — no `(sessionId, seq)` collision', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    // The regression this guards: an assistant turn allocated OUTSIDE the lock
    // would read the same `turnCount` as the concurrent user append, and one of
    // the two would be lost to the unique. Both must land, in some order.
    await Promise.all([
      planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current),
      planChangeSessionsService.appendTurn('and make them smaller', ctx, current),
    ]);

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1);
    expect(rows.filter((r) => r.role === 'user').map((r) => r.body)).toEqual([
      'add payments',
      'and make them smaller',
    ]);
  });
});

describe('recordPlannerTurn — exactly ONE turn per job', () => {
  it('a REPLAYED recording of the same job adds nothing', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);
    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    // A reload, a second tab and a retried settle all replay this call — each is
    // a no-op that returns the thread as it stands, never a duplicate bubble.
    expect(dto.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
    expect(dto.turnCount).toBe(3);
  });

  it('holds under CONCURRENT replays — the guard is inside the lock', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    // Two tabs settling at once. Checked outside the lock, both would see "not
    // there yet" and both would insert.
    await Promise.all([
      planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current),
      planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current),
    ]);

    const rows = await threadRows(fx);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});

describe('recordPlannerTurn — a silent job is not a failure', () => {
  it.each([
    ['no result at all', null],
    ['a result with no turn', {}],
    ['a turn with no message', { turn: { action: 'draft', question: null } }],
    ['a turn whose message is blank', { turn: { action: 'draft', message: '   ' } }],
    ['a malformed turn', { turn: 'nonsense' }],
  ])('tolerates %s — the thread is returned unchanged', async (_label, result) => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue({
      jobId: 'job-augment-1',
      status: 'succeeded',
      result,
      error: null,
    });

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    // The plan-edit run itself succeeded and its proposals are on the canvas.
    // The worst outcome of an unreadable utterance is a thread with no narration.
    expect(dto.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
    expect(dto.turnCount).toBe(2);
  });

  it('refuses a job the thread did not submit, without touching motir-ai', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);

    const dto = await planChangeSessionsService.recordPlannerTurn(
      'someone-elses-job',
      ctx,
      current,
    );

    expect(dto.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
    // Gated BEFORE the read: a job this conversation never ran has no business
    // narrating into it, and is not worth a round-trip to discover.
    expect(getJobMock).not.toHaveBeenCalled();
  });
});

describe('recordPlannerTurn — work-item references', () => {
  it('rewrites a bare key to the chip token and resolves it into `workItemRefs`', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Billing' },
      fx.ctx,
    );
    getJobMock.mockResolvedValue(
      jobWithTurn({
        action: 'draft',
        message: `I searched the plan. ${target.identifier} already covers it.`,
        question: null,
      }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    const report = dto.turns.find((t) => t.role === 'assistant')!;
    // The SHIPPED write-side normalization (MOTIR-1440), reused: a bare key both
    // relates and CHIPS, rather than staying plain text.
    expect(report.body).toContain(`[${target.identifier}](motir:${target.id})`);
    // …and the summary the chip renders from rides on the session, exactly as it
    // does for a description or a comment.
    const ref = dto.workItemRefs[target.id];
    expect(ref?.accessible).toBe(true);
    expect(ref && ref.accessible ? ref.identifier : null).toBe(target.identifier);
  });

  it('leaves a key that resolves to nothing as plain text', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({
        action: 'draft',
        message: `Nothing matched ${fx.projectIdentifier}-999999.`,
        question: null,
      }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);

    const report = dto.turns.find((t) => t.role === 'assistant')!;
    expect(report.body).toContain(`${fx.projectIdentifier}-999999`);
    expect(report.body).not.toContain('motir:');
    expect(dto.workItemRefs).toEqual({});
  });
});

describe('appendTurn — the answer flag', () => {
  it('records a reply sent from the answer bar as an ANSWER', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);

    await planChangeSessionsService.appendTurn('taking money from customers', ctx, current, {
      isAnswer: true,
    });

    const rows = await threadRows(fx);
    expect(rows[0]!.isAnswer).toBe(true);
  });

  it('defaults to NOT an answer — a turn that changed the subject supersedes', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);

    await planChangeSessionsService.appendTurn('actually, re-sequence Billing first', ctx, current);

    const rows = await threadRows(fx);
    expect(rows[0]!.isAnswer).toBe(false);
  });
});

// A QUESTION'S OPTIONS (MOTIR-11700): the planner's question carries 2 to 4 options as
// data; an answer that CLICKED one is resolved, under the session lock, against the
// question it answers, and is read back to the planner as that option.
describe('a question with options, and the answer that picks one', () => {
  const OPTIONS = [
    { id: 'o1', label: 'Taking money in', means: 'Customers pay us.' },
    { id: 'o2', label: 'Paying suppliers', means: 'We pay suppliers out.' },
  ];

  async function askedThread(ctx: ProjectContext) {
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({
        action: 'ask',
        message: 'Which direction?',
        question: 'Taking money in, or paying suppliers out?',
        options: OPTIONS,
      }),
    );
    return planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx, current);
  }

  it('stores the question’s options on the planner turn', async () => {
    const ctx = projectCtx(fx);
    const dto = await askedThread(ctx);
    const asked = dto.turns.find((t) => t.role === 'assistant');
    expect(asked!.questionOptions).toEqual(OPTIONS);
  });

  it('a pick is stored as the option it names, with its meaning', async () => {
    const ctx = projectCtx(fx);
    await askedThread(ctx);
    const dto = await planChangeSessionsService.appendTurn('Paying suppliers', ctx, current, {
      isAnswer: true,
      answerOptionId: 'o2',
    });
    const answer = dto.turns.at(-1)!;
    expect(answer.answerOption).toEqual(OPTIONS[1]);
    const rows = await threadRows(fx);
    expect(rows.at(-1)!.answerOption).toEqual(OPTIONS[1]);
  });

  it('refuses an id the waiting question did not offer, and writes nothing', async () => {
    const ctx = projectCtx(fx);
    await askedThread(ctx);
    const before = (await threadRows(fx)).length;
    await expect(
      planChangeSessionsService.appendTurn('Something', ctx, current, {
        isAnswer: true,
        answerOptionId: 'o9',
      }),
    ).rejects.toBeInstanceOf(PlanChangeAnswerOptionUnknownError);
    expect(await threadRows(fx)).toHaveLength(before);
  });

  it('an option id on a turn that is not an answer is ignored', async () => {
    const ctx = projectCtx(fx);
    await askedThread(ctx);
    const dto = await planChangeSessionsService.appendTurn('change of subject', ctx, current, {
      answerOptionId: 'o9',
    });
    expect(dto.turns.at(-1)!.answerOption ?? null).toBeNull();
  });

  it('the accumulated intent reads a pick as the option, and typed words as own words', async () => {
    const { buildAccumulatedIntent } = await import('@/lib/services/planChangeSessionsService');
    const ctx = projectCtx(fx);
    await askedThread(ctx);
    await planChangeSessionsService.appendTurn('only card payments', ctx, current, {
      isAnswer: true,
    });
    const intent = buildAccumulatedIntent(await threadRows(fx));
    expect(intent).toContain('In my own words, none of your options: only card payments');
  });
});
