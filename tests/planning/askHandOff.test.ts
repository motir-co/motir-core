import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// ONE MESSAGE, ONE QUICK REPLY (bug MOTIR-11797), on REAL Postgres. Every message typed in
// the conversation runs as an `ask_project` turn, and its job now sends the quick reply
// (`conversation_ack`). When that turn STARTS a plan — the settle reads it as a plan change,
// an immediate "plan this", an offer's Confirm or a typed yes — the plan's job carries
// `context.askHandOff` naming the ask job, so motir-ai's PART 1 does not reply a second
// time. A plan nobody's turn started carries none. Mocked: only the motir-ai boundary
// (`submitJob` / `getJob`), so every turn and plan row is the real one.

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
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { workItemsService } = await import('@/lib/services/workItemsService');

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

const owner = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

const REQUEST = 'Plan custom fields in the CSV export.';

/** Type `body`, settle its job with `ask`, and return the ask job and the settle. */
async function turn(body: string, ask: Record<string, unknown>, sessionId?: string) {
  const submitted = await aiAskService.submitTurn(body, owner(), sessionId ? { sessionId } : {});
  if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
  const jobId = submitted.jobId;
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
  const settled = await aiAskService.settle(jobId, owner(), { sessionId: submitted.session.id });
  return { jobId, sessionId: submitted.session.id, settled };
}

const answerWith = (extra: Record<string, unknown> = {}) => ({
  intent: 'ask',
  answer: 'Here is how the export works.',
  citations: [],
  ...extra,
});
const planOffer = (targetKey?: string, extra: Record<string, unknown> = {}) => ({
  kind: 'plan',
  requestText: REQUEST,
  ...(targetKey ? { targetKey } : {}),
  immediate: false,
  ...extra,
});

const lastAnswer = (turns: readonly PlanChangeTurnDto[]) =>
  turns.filter((t) => t.role === 'assistant').at(-1)!;

/** The context of every PLAN job submitted so far, in order (an ask is not one). */
function planContexts(): Array<Record<string, unknown>> {
  return submitJobMock.mock.calls
    .filter((c) => c[0] !== 'ask_project')
    .map((c) => c[2] as Record<string, unknown>);
}

describe('a plan a conversation turn started names the ask job that replied (MOTIR-11797)', () => {
  it('Confirm on an offer: the offer turn’s ask job', T, async () => {
    const { jobId, sessionId, settled } = await turn(
      'Can we export custom fields?',
      answerWith({ offer: planOffer() }),
    );
    const offerTurnId = lastAnswer(settled.session.turns).id;
    await planOfferStartService.confirmPlanOffer(owner(), {
      conversationId: sessionId,
      offerTurnId,
    });
    const [plan] = planContexts();
    expect(plan?.askHandOff).toEqual({ askJobId: jobId });
  });

  it('Confirm on a TARGETED offer: the scoped door carries it too', T, async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'CSV export' },
      fx.ctx,
    );
    const { jobId, sessionId, settled } = await turn(
      'Can we export custom fields?',
      answerWith({ offer: planOffer(target.identifier) }),
    );
    await planOfferStartService.confirmPlanOffer(owner(), {
      conversationId: sessionId,
      offerTurnId: lastAnswer(settled.session.turns).id,
    });
    expect(planContexts()[0]?.askHandOff).toEqual({ askJobId: jobId });
  });

  it('an immediate "plan this": the ask job that read the turn', T, async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'CSV export' },
      fx.ctx,
    );
    const { jobId, settled } = await turn(
      'Plan this card.',
      answerWith({ offer: planOffer(target.identifier, { immediate: true }) }),
    );
    expect(settled.outcome).toBe('redirected');
    expect(planContexts()).toHaveLength(1);
    expect(planContexts()[0]?.askHandOff).toEqual({ askJobId: jobId });
  });

  it('a turn the settle reads as a plan change: the ask job that read it', T, async () => {
    const { jobId, settled } = await turn('Add a CSV card to the plan.', {
      intent: 'plan_change',
      answer: null,
      citations: [],
    });
    expect(settled.outcome).toBe('redirected');
    expect(planContexts()).toHaveLength(1);
    expect(planContexts()[0]?.askHandOff).toEqual({ askJobId: jobId });
  });

  it('a plan no ask turn started carries none', T, async () => {
    const { sessionId } = await turn('Can we export custom fields?', answerWith());
    await planChangeSessionsService.submit(owner(), { sessionId });
    const [plan] = planContexts();
    expect(plan).toBeDefined();
    expect(plan).not.toHaveProperty('askHandOff');
  });
});
