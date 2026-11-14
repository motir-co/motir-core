import { beforeEach, describe, expect, it, vi } from 'vitest';

// motir-ai is the only thing stubbed, at the client boundary. Every route,
// service, Plan row and presenter below is real, against real Postgres.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
  getJob: vi.fn(),
  getJobCost: vi.fn(),
}));

import { POST as EXPAND } from '@/app/api/v1/work-items/[key]/expansions/route';
import { GET as GET_PLAN } from '@/app/api/v1/plans/[planId]/route';
import { getJobCost, submitJob, type RawJobCost } from '@/lib/ai/motirAiClient';
import {
  MotirAiConfigError,
  MotirAiJobNotFoundError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import { planSchema, type V1Plan, type V1PlanJobHandle } from '@/lib/api/v1/workLoop/schema';
import { runGetPlan } from '@/lib/mcp/tools/getPlan';
import { runAddPlanItems, runCreatePlan } from '@/lib/mcp/tools/authorPlan';
import { readPlanJobCost } from '@/lib/services/planJobCostService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// THE PLAN READ'S COST BLOCK (MOTIR-10815, task MOTIR-10789). Three properties
// carry the card:
//
//   • An unknown figure is `null` at EVERY hop — client, DTO, v1 presenter, MCP
//     payload and its text — and never `0`; a `0` arrives only as motir-ai sent it.
//   • A plan no job produced has NO `cost` key, and costs no motir-ai call.
//   • A cost read that does not answer (not found, outage, not configured) never
//     fails the plan read: the block is there, every figure `null`.

const BASE = 'http://localhost:3000/api/v1';

const KINDS = {
  conversation: 100,
  lay: 300,
  author: 300,
  entry_author: 0,
  tool: 0,
  amend: 40,
  check: 25,
  repair: 0,
};

const COMPLETE: RawJobCost = {
  jobId: 'job_cost',
  ledgerComplete: true,
  totalCostMicroUsd: 700,
  credits: 10,
  bySessionKind: KINDS,
};

const ALL_NULL = {
  ledgerComplete: null,
  totalCostMicroUsd: null,
  credits: null,
  bySessionKind: {
    conversation: null,
    lay: null,
    author: null,
    entry_author: null,
    tool: null,
    amend: null,
    check: null,
    repair: null,
  },
};

async function readPlan(caller: V1ProjectCaller, planId: string): Promise<Response> {
  return GET_PLAN(new Request(`${BASE}/plans/${planId}`, { headers: caller.headers }), {
    params: Promise.resolve({ planId }),
  });
}

/** A plan a motir-ai job produced: `sourceJobId` is set. */
async function jobPlan(caller: V1ProjectCaller): Promise<string> {
  const story = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title: 'a container' },
    caller.ctx,
  );
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_cost' } as Awaited<
    ReturnType<typeof submitJob>
  >);
  const res = await EXPAND(
    new Request(`${BASE}/work-items/${story.identifier}/expansions`, {
      method: 'POST',
      headers: caller.headers,
    }),
    { params: Promise.resolve({ key: story.identifier }) },
  );
  return ((await res.json()) as V1PlanJobHandle).planId;
}

/** A plan an agent authored over MCP: no job, `sourceJobId` null. */
async function agentPlan(caller: V1ProjectCaller): Promise<string> {
  const res = await runCreatePlan({ projectKey: caller.projectKey, title: 'by hand' }, caller.ctx);
  return (res.structuredContent as { id: string }).id;
}

async function bothSurfaces(caller: V1ProjectCaller, planId: string) {
  const res = await readPlan(caller, planId);
  expect(res.status).toBe(200);
  const v1 = (await res.json()) as V1Plan;
  expect(() => planSchema.parse(v1)).not.toThrow();
  const tool = await runGetPlan({ planId }, caller.ctx);
  expect(tool.isError).not.toBe(true);
  const mcp = tool.structuredContent as Record<string, unknown> & { cost?: V1Plan['cost'] };
  const text = (tool.content[0] as { text: string }).text;
  return { v1, mcp, text };
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
});

describe('a plan a motir-ai job produced', () => {
  it('carries motir-ai’s figures on both surfaces, a 0 only where motir-ai answered 0', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await jobPlan(caller);
    vi.mocked(getJobCost).mockResolvedValue(COMPLETE);

    const { v1, mcp, text } = await bothSurfaces(caller, planId);

    for (const cost of [v1.cost, mcp.cost]) {
      expect(cost).toEqual({
        ledgerComplete: true,
        totalCostMicroUsd: 700,
        credits: 10,
        bySessionKind: KINDS,
      });
      expect(cost?.bySessionKind.entry_author).toBe(0);
      // MOTIR-11256 — the amend, the final check and its fix are priced as their own kinds.
      expect(cost?.bySessionKind.amend).toBe(40);
      expect(cost?.bySessionKind.check).toBe(25);
      expect(cost?.bySessionKind.repair).toBe(0);
    }
    // Asked with the plan's own job and project.
    expect(vi.mocked(getJobCost)).toHaveBeenCalledWith('job_cost', caller.fixture.projectId);
    const lines = text.split('\n');
    expect(lines[2]).toBe(
      'Job cost: total 700 µUSD · 10 credits · ledger complete · conversation 100 · lay 300 · ' +
        'author 300 · entry_author 0 · tool 0 · amend 40 · check 25 · repair 0',
    );
  });

  it('keeps every unknown figure null — never 0 — on both surfaces and in the text', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await jobPlan(caller);
    vi.mocked(getJobCost).mockResolvedValue({
      jobId: 'job_cost',
      ledgerComplete: true,
      totalCostMicroUsd: null,
      credits: '7',
      // `tool` missing, `lay` null, `entry_author` not finite.
      bySessionKind: { conversation: 0, lay: null, author: 5, entry_author: Infinity },
    });

    const { v1, mcp, text } = await bothSurfaces(caller, planId);

    for (const cost of [v1.cost, mcp.cost]) {
      expect(cost?.totalCostMicroUsd).toBe(null);
      expect(cost?.credits).toBe(null);
      expect(cost?.bySessionKind.lay).toBe(null);
      expect(cost?.bySessionKind.tool).toBe(null);
      expect(cost?.bySessionKind.entry_author).toBe(null);
      expect(cost?.bySessionKind.conversation).toBe(0);
      expect(cost?.bySessionKind.author).toBe(5);
    }
    expect(text).toContain(
      'Job cost: total unknown · unknown · ledger complete · conversation 0 · lay unknown · ' +
        'author 5 · entry_author unknown · tool unknown · amend unknown · check unknown · ' +
        'repair unknown',
    );
  });

  it('an unpriced author session: author and the total null, the other sums unchanged', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await jobPlan(caller);
    vi.mocked(getJobCost).mockResolvedValue({
      ...COMPLETE,
      totalCostMicroUsd: null,
      bySessionKind: { ...KINDS, author: null },
    });

    const { v1, mcp } = await bothSurfaces(caller, planId);

    for (const cost of [v1.cost, mcp.cost]) {
      expect(cost?.bySessionKind.author).toBe(null);
      // Core never recomputes a total from the kinds.
      expect(cost?.totalCostMicroUsd).toBe(null);
      expect(cost?.bySessionKind.conversation).toBe(100);
      expect(cost?.bySessionKind.lay).toBe(300);
    }
  });

  it.each([
    ['not_found (another project’s job)', new MotirAiJobNotFoundError('job not found')],
    ['unreachable', new MotirAiUnavailableError('motir-ai did not respond')],
    ['not configured', new MotirAiConfigError('MOTIR_AI_SERVICE_TOKEN is not set')],
  ])(
    'a cost read that did not answer (%s) is the all-null block, and the plan still reads',
    async (_, err) => {
      const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
      const planId = await jobPlan(caller);
      vi.mocked(getJobCost).mockRejectedValue(err);

      const { v1, mcp, text } = await bothSurfaces(caller, planId);

      expect(v1.id).toBe(planId);
      expect(Array.isArray(v1.proposals)).toBe(true);
      expect(v1.cost).toEqual(ALL_NULL);
      expect(mcp.cost).toEqual(ALL_NULL);
      expect(v1.cost?.ledgerComplete).toBe(null);
      expect(text).toContain('Job cost: total unknown · unknown · ledger unknown');
      expect(text).not.toMatch(/Job cost:.* 0\b/);
    },
  );

  it('a body with no session kinds at all reads every kind null', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await jobPlan(caller);
    vi.mocked(getJobCost).mockResolvedValue({ ...COMPLETE, bySessionKind: 'none' });
    const { v1 } = await bothSurfaces(caller, planId);
    expect(v1.cost?.bySessionKind).toEqual(ALL_NULL.bySessionKind);
    expect(v1.cost?.ledgerComplete).toBe(true);
  });

  it('a ledgerComplete motir-ai did not send as a boolean reads null', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await jobPlan(caller);
    vi.mocked(getJobCost).mockResolvedValue({ ...COMPLETE, ledgerComplete: 'yes' });
    const { v1, text } = await bothSurfaces(caller, planId);
    expect(v1.cost?.ledgerComplete).toBe(null);
    expect(text).toContain('ledger unknown');
  });

  it('an incomplete ledger says so in the text', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await jobPlan(caller);
    vi.mocked(getJobCost).mockResolvedValue({ ...COMPLETE, ledgerComplete: false });
    const { text } = await bothSurfaces(caller, planId);
    expect(text).toContain('ledger incomplete');
  });
});

describe('a plan no job produced', () => {
  it('carries NO cost key on either surface, and asks motir-ai nothing', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const planId = await agentPlan(caller);

    const { v1, mcp, text } = await bothSurfaces(caller, planId);

    expect(v1.sourceJobId).toBe(null);
    expect(v1).not.toHaveProperty('cost');
    expect(mcp).not.toHaveProperty('cost');
    expect(text).not.toContain('Job cost');
    expect(vi.mocked(getJobCost)).toHaveBeenCalledTimes(0);
  });

  it('readPlanJobCost answers undefined without a call', async () => {
    expect(await readPlanJobCost({ sourceJobId: null, projectId: 'p' })).toBeUndefined();
    expect(vi.mocked(getJobCost)).toHaveBeenCalledTimes(0);
  });
});

describe('the write doors', () => {
  it('add_plan_items makes no cost read and answers no cost key, on a job’s plan', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    for (const planId of [await jobPlan(caller), await agentPlan(caller)]) {
      const res = await runAddPlanItems(
        {
          planId,
          proposals: [{ op: 'add', proposedFields: { title: 'a child', kind: 'subtask' } }],
        } as Parameters<typeof runAddPlanItems>[0],
        caller.ctx,
      );
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent).not.toHaveProperty('cost');
    }
    expect(vi.mocked(getJobCost)).toHaveBeenCalledTimes(0);
  });
});
