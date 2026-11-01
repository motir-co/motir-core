import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { GET_PLAN_TOOL_NAME } from '@/lib/mcp/tools/getPlan';
import type { PlanRaisedGapDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The GAPS a planner's author sessions raised, over MCP (MOTIR-10176):
// `report_plan_step`'s `gaps` arm declares each on the plan, `get_plan` reads them
// back as `raisedGaps` — what plan.py's `--resume-plan` hands the level's amend. The
// store's own rules (order, idempotence, refusals, RLS) are proven in
// `tests/integration/plans/planRaisedGap.test.ts`; asserted HERE is what only the
// transport answers — the schema lets the arm through, the result text and
// payload, a refusal comes back as a tool error, and the read-back's shape.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-raised-gaps', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

async function generatingPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Being written',
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;
  await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The adapter', kind: 'story' } }],
  });
  return planId;
}

const raise = {
  op: 'raise',
  id: 'plan.py:20261028-093733:006:1',
  level: 'planItem:story',
  raisedBy: 'planItem:adapter',
  what: 'Nothing creates the Lambda execution role',
  decision: 'which account owns the shared role — the infra owner',
};

describe('report_plan_step gaps → get_plan raisedGaps', () => {
  it('`tools/list` publishes the gaps arm', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const report = tools.find((t) => t.name === REPORT_PLAN_STEP_TOOL_NAME)!;
    expect(Object.keys(report.inputSchema.properties ?? {})).toContain('gaps');
  });

  it('declares a raise, stamps its amend, and reads both back on get_plan', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);

    const raised = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'plan.py:20261028-093733:006',
      gaps: [raise, { op: 'raise', id: 'g-2', what: 'Nothing creates the push roles' }],
    });
    expect(raised.isError, textOf(raised)).toBeFalsy();
    expect(raised.structuredContent).toEqual({
      planId,
      sessionKey: 'plan.py:20261028-093733:006',
      gaps: { raised: [raise.id, 'g-2'], alreadyRaised: [], amended: [] },
    });
    expect(textOf(raised)).toBe(
      `On plan ${planId}: raised 2 gaps, stamped 0 as handed to the amend.`,
    );

    const before = await call(client, GET_PLAN_TOOL_NAME, { planId });
    const open = (before.structuredContent as unknown as { raisedGaps: PlanRaisedGapDto[] })
      .raisedGaps;
    expect(open.map((g) => [g.id, g.amended, g.raisedBy, g.decision])).toEqual([
      [raise.id, false, 'planItem:adapter', raise.decision],
      ['g-2', false, null, null],
    ]);

    const amended = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'plan.py:20261028-095047:003',
      gaps: [{ op: 'amend', id: raise.id, refs: ['planItem:role'] }, raise],
    });
    expect(textOf(amended)).toBe(
      `On plan ${planId}: raised 0 gaps, 1 already on the plan, stamped 1 as handed to the amend.`,
    );

    const after = await call(client, GET_PLAN_TOOL_NAME, { planId });
    const gaps = (after.structuredContent as unknown as { raisedGaps: PlanRaisedGapDto[] })
      .raisedGaps;
    expect(gaps.map((g) => [g.id, g.amended, g.answer])).toEqual([
      [raise.id, true, { refs: ['planItem:role'], open: null }],
      ['g-2', false, null],
    ]);
  });

  it('an amend of an id the plan does not hold is a tool error, and records nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    const res = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 's',
      gaps: [raise, { op: 'amend', id: 'never-raised' }],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/PLAN_STEP_INVALID|does not hold/);
    expect(await adminDb.planRaisedGap.count({ where: { planId } })).toBe(0);
  });

  it('a plan with no gaps reads back an empty list', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    const read = await call(client, GET_PLAN_TOOL_NAME, { planId });
    expect((read.structuredContent as unknown as { raisedGaps: unknown[] }).raisedGaps).toEqual([]);
  });
});
