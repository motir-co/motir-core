import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { DebugLandingDto } from '@/lib/dto/planChange';
import { MotirAiConfigError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { aiAskService, type AskSubmitResult } from '@/lib/services/aiAskService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { seedLegacyRestartConfirm } from '../helpers/legacyRestartConfirm';
import { PlanChangeFlipNotOfferedError } from '@/lib/planChange/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { openTestSession } from '../helpers/planSession';

// THE STORY GATE for MOTIR-9216 on the motir-core side (MOTIR-9233). Every
// conversation turn is one grounded read that answers (ADR conversation-turn-intent
// AMENDMENT 5). The per-card suites prove one seam each; this file drives the
// assembled `aiAskService` — `submitTurn`, `settle`, `resubmit` and the flip —
// against a REAL Postgres, with only the motir-ai transport (the HTTP boundary)
// stubbed, the same harness `askEveryTurnReads.test.ts` uses.

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-ask-1' }));
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
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

const QUESTION = 'Why is the export card blocked?';
const DEFECT = 'saving a comment drops the mention';
const ELSEWHERE = "let's plan something else";

const UNREADABLE = {
  halt: 'code_unreadable',
  repoRef: 'o/r',
  repoRefs: ['o/r'],
  reason: 'hydrate_failed',
};

const answered = (answer: string, citations: string[], extra: object = {}) => ({
  status: 'succeeded',
  result: { ask: { intent: 'ask', answer, citations }, ...extra },
});
const stale = (intent: 'debug' | 'new_session') => ({
  status: 'succeeded',
  result: { ask: { intent, answer: null, citations: [] } },
});

/** Submit a turn and narrow it to an ask submit — none of these prompts is a guide. */
async function submitAsk(
  prompt: string,
  address?: { sessionId: string },
): Promise<AskSubmitResult> {
  const submitted = await aiAskService.submitTurn(prompt, ctx, address);
  if (!('outcome' in submitted) && 'turnId' in submitted) return submitted;
  throw new Error('expected an ask submit');
}

const submittedKinds = () => submitJobMock.mock.calls.map((c) => c[0]);

let fx: WorkItemFixture;
let ctx: ProjectContext;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  let n = 0;
  submitJobMock.mockImplementation(async (...args: unknown[]) => ({
    jobId: `job-${String(args[0])}-${++n}`,
  }));
  getJobMock.mockReset();
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
  fx = await makeWorkItemFixture();
  ctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const items = () => adminDb.workItem.count({ where: { projectId: fx.projectId } });
const plans = () => adminDb.plan.count({ where: { projectId: fx.projectId } });

describe('no run: every non-guide turn is read and answered', () => {
  it.each([
    ['a question', QUESTION, false],
    ['a defect report', DEFECT, true],
    ['a request to plan something else', ELSEWHERE, false],
  ])(
    '%s is written ask, submitted as ask_project and settles into a cited answer',
    async (_label, prompt, unreadable) => {
      const card = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
      const submitted = await submitAsk(prompt);

      getJobMock.mockResolvedValue(
        answered(
          `See ${card.identifier}.`,
          [card.identifier],
          unreadable ? { codeUnreadable: UNREADABLE } : {},
        ),
      );
      const before = { items: await items(), plans: await plans() };
      const settled = await aiAskService.settle(submitted.jobId, ctx, {
        sessionId: submitted.session.id,
      });

      expect(settled.outcome).toBe('answered');
      expect(submittedKinds()).toEqual(['ask_project']);
      const thread = await openTestSession(ctx);
      const user = thread.turns.find((t) => t.id === submitted.turnId)!;
      expect(user.intent).toBe('ask');
      const reply = thread.turns.find((t) => t.role === 'assistant')!;
      expect(reply.body).toBe(`See ${card.identifier}.`);
      expect(reply.citations).toEqual([card.identifier]);
      expect(reply.codeUnreadable ?? null).toBe(unreadable ? 'answered' : null);
      // No plan-edit job, no debug job, no new-session confirm, no card.
      expect(thread.turns.some((t) => t.confirm === 'new_session')).toBe(false);
      expect(await plans()).toBe(before.plans);
      expect(await items()).toBe(before.items);
    },
  );

  it.each(['debug', 'new_session'] as const)(
    'a stale `%s` outcome with no answer settles silent and writes nothing',
    async (intent) => {
      const submitted = await submitAsk(DEFECT);
      getJobMock.mockResolvedValue(stale(intent));
      const before = { items: await items(), plans: await plans() };

      const settled = await aiAskService.settle(submitted.jobId, ctx, {
        sessionId: submitted.session.id,
      });

      expect(settled.outcome).toBe('silent');
      expect(submittedKinds()).toEqual(['ask_project']);
      const thread = await openTestSession(ctx);
      expect(thread.turns.filter((t) => t.role !== 'user')).toHaveLength(0);
      expect(await items()).toBe(before.items);
      expect(await plans()).toBe(before.plans);
    },
  );
});

describe('the retry of a stored turn', () => {
  async function storedAs(intent: 'debug' | 'new_session' | 'plan_change') {
    const submitted = await submitAsk(DEFECT);
    await planChangeSessionsService.recordTurnIntent(
      submitted.turnId,
      intent,
      ctx,
      { jobId: `job-stored-${intent}` },
      { sessionId: submitted.session.id },
    );
    return submitted;
  }

  it.each(['debug', 'new_session'] as const)(
    'a stored `%s` turn re-runs as ask_project, records ask, and adds no user turn',
    async (intent) => {
      const { turnId, session } = await storedAs(intent);
      submitJobMock.mockResolvedValueOnce({ jobId: 'job-retry' });

      const result = await aiAskService.resubmit(turnId, ctx, { sessionId: session.id });

      expect(result).toMatchObject({ jobId: 'job-retry', turnId });
      expect(submittedKinds()).toEqual(['ask_project', 'ask_project']);
      const thread = await openTestSession(ctx);
      const users = thread.turns.filter((t) => t.role === 'user');
      expect(users).toHaveLength(1);
      expect(users[0]!.intent).toBe('ask');
      expect(users[0]!.jobId).toBe('job-retry');
    },
  );

  it('an ask turn still cannot flip', async () => {
    const submitted = await submitAsk(QUESTION);
    await expect(
      aiAskService.resubmit(submitted.turnId, ctx, { flip: true, sessionId: submitted.session.id }),
    ).rejects.toBeInstanceOf(PlanChangeFlipNotOfferedError);
    expect(submittedKinds()).toEqual(['ask_project']);
  });

  it('a stored plan_change turn still retries through planChangeSessionsService.submit', async () => {
    const { turnId, session } = await storedAs('plan_change');
    const spy = vi
      .spyOn(planChangeSessionsService, 'submit')
      .mockResolvedValueOnce({ jobId: 'job-plan', planId: 'plan-1', session: {} } as never);
    try {
      const result = await aiAskService.resubmit(turnId, ctx, { sessionId: session.id });
      expect(result).toMatchObject({ outcome: 'redirected', jobId: 'job-plan' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(submittedKinds()).toEqual(['ask_project']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('turns stored under the retired intents reload unchanged', () => {
  it('a debug turn with its landing and a new_session turn with its confirm', async () => {
    const first = await submitAsk('Saving drops the mention');
    const address = { sessionId: first.session.id };
    await planChangeSessionsService.recordTurnIntent(
      first.turnId,
      'debug',
      ctx,
      { jobId: 'job-old-debug' },
      address,
    );
    const landing: DebugLandingDto = {
      outcome: 'diagnose',
      workItemKey: 'PROD-412',
      title: 'Board drag drops the card one column short',
      createdInTriage: false,
    };
    await planChangeSessionsService.appendAnswerTurn(
      {
        jobId: 'job-old-debug',
        body: 'Likely cause: the clamp.',
        citations: [],
        debugLanding: landing,
      },
      ctx,
      address,
    );
    const second = await submitAsk('Plan the mobile app instead', address);
    await planChangeSessionsService.recordTurnIntent(
      second.turnId,
      'new_session',
      ctx,
      {},
      address,
    );
    // A legacy confirm turn — nothing writes one since MOTIR-11261.
    await seedLegacyRestartConfirm(ctx, address.sessionId);

    const loaded = await planChangeSessionsService.getById(ctx, first.session.id);
    const byId = (id: string) => loaded!.turns.find((t) => t.id === id)!;
    expect(byId(first.turnId).intent).toBe('debug');
    expect(byId(second.turnId).intent).toBe('new_session');
    const reply = loaded!.turns.find((t) => t.jobId === 'job-old-debug' && t.role === 'assistant')!;
    expect(reply.debugLanding).toEqual(landing);
    expect(reply.body).toBe('Likely cause: the clamp.');
    const confirms = loaded!.turns.filter((t) => t.confirm === 'new_session');
    expect(confirms).toHaveLength(1);
    expect(await planChangeSessionsService.getById(ctx, first.session.id)).toEqual(loaded);
  });
});

describe('a turn that cannot be paid for or served writes nothing', () => {
  it.each([
    ['out of credits', () => new MotirAiOutOfCreditsError('balance 0')],
    ['Motir AI not configured', () => new MotirAiConfigError('MOTIR_AI_URL is not set')],
  ])('%s: the submit refuses with its error, no answer, card or job', async (_label, error) => {
    const thrown = error();
    submitJobMock.mockRejectedValueOnce(thrown);
    const before = { items: await items(), plans: await plans() };

    await expect(aiAskService.submitTurn(DEFECT, ctx)).rejects.toBe(thrown);

    expect(submittedKinds()).toEqual(['ask_project']);
    expect(getJobMock).not.toHaveBeenCalled();
    const thread = await openTestSession(ctx);
    expect(thread.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
    expect(await items()).toBe(before.items);
    expect(await plans()).toBe(before.plans);
  });
});
