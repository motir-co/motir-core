import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { HostedRunNoCapacityError } from '@/lib/hostedRuns/errors';
import { agentRunCapacityService } from '@/lib/services/agentRunCapacityService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// A LAUNCH REFUSED FOR NO AGENT-RUN CAPACITY (Story MOTIR-9541 · MOTIR-9628) — the
// typed error and `POST /api/work-items/[id]/hosted-runs`' answer to it. The four
// start paths' own proofs that nothing was created live beside each path's suite
// (`hostedRunStart.test.ts` for Run and Continue, `hostedRunStartFix.test.ts` for Fix,
// `agentReview/agentReviewStart.test.ts` for the review), on their fixtures.
//
// Pinned: a 409 whose body is exactly `code`, `error`, `model` and `reason` on every
// mode, `private, no-store`, and a message that names the model and carries no digit
// of its own.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { POST } = await import('@/app/api/work-items/[id]/hosted-runs/route');

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';

let fx: WorkItemFixture;
let aiCalls: string[] = [];

function stubModels(): void {
  aiCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      aiCalls.push(url);
      if (url === `${AI}/v1/agent-models`) {
        return new Response(
          JSON.stringify({ models: [{ id: MODEL, provider: 'anthropic' }], default: MODEL }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

function post(key: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`https://app.test/api/work-items/${key}/hosted-runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: key }) },
  );
}

async function expectNoCapacity(res: Response, reason: string): Promise<void> {
  expect(res.status).toBe(409);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['code', 'error', 'model', 'reason']);
  expect(body).toMatchObject({ code: 'hosted_run_no_capacity', model: MODEL, reason });
}

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  fakeOrchestrator.reset();
  fx = await makeWorkItemFixture();
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  stubModels();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('HostedRunNoCapacityError', () => {
  it('carries the code, the bare model and the reason, and a message with no digit of its own', () => {
    const err = new HostedRunNoCapacityError('glm-model', 'agent_share_exhausted');
    expect(err).toMatchObject({
      code: 'hosted_run_no_capacity',
      model: 'glm-model',
      reason: 'agent_share_exhausted',
      name: 'HostedRunNoCapacityError',
    });
    expect(err.message).toBe('The model glm-model has no agent-run capacity right now.');
    expect(err.message).not.toMatch(/\d/);
  });
});

describe('POST /api/work-items/[id]/hosted-runs — no agent-run capacity', () => {
  it('mode run, through the real pre-flight: 409 before the credit check, nothing opened', async () => {
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a card' },
      fx.ctx,
    );
    vi.spyOn(agentRunCapacityService, 'verdictFor').mockResolvedValue({
      verdict: 'no_capacity',
      reason: 'agent_share_exhausted',
    });

    await expectNoCapacity(
      await post(card.identifier, { model: MODEL, idempotencyKey: 'k' }),
      'agent_share_exhausted',
    );
    expect(aiCalls.filter((u) => u.endsWith('/v1/credits/agent-run-check'))).toEqual([]);
    expect(await adminDb.dispatchRun.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);
    expect(fakeOrchestrator.provisioned).toEqual([]);
  });

  it.each(['continue', 'fix'] as const)('mode %s: the same 409 body', async (mode) => {
    vi.spyOn(hostedRunService, 'start').mockRejectedValueOnce(
      new HostedRunNoCapacityError(MODEL, 'provider_rate_limited'),
    );
    await expectNoCapacity(
      await post('PROD-1', { model: MODEL, mode, idempotencyKey: 'k' }),
      'provider_rate_limited',
    );
  });
});
