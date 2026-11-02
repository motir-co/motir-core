import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { SEARCH_PAST_PLANS_TOOL_NAME, renderPastPlans } from '@/lib/mcp/tools/searchPastPlans';
import { PAST_PLAN_SUMMARY_EXCERPT_MAX } from '@/lib/plans/pastPlans';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { GET as SEARCH_ROUTE } from '@/app/api/internal/ai/past-plans/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `search_past_plans` (MOTIR-10241) over real Postgres, driven through
// `buildMcpServer` + an in-memory client: registered and declared, the same rows
// as the internal route for the same project, paging by `nextCursor`, an empty
// result the named `nothing-matched` state, and no plan of another project or
// workspace ever returned.

const SERVICE_SECRET = 'core-callback-secret-test';
let fx: WorkItemFixture;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function call(ctx: ServiceContext, args: Record<string, unknown>): Promise<CallToolResult> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'past-plans-test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return (await client.callTool({
      name: SEARCH_PAST_PLANS_TOOL_NAME,
      arguments: args,
    })) as CallToolResult;
  } finally {
    await client.close();
  }
}

const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const structured = (r: CallToolResult) => {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as Record<string, unknown>;
};

async function plannedPlan(f: WorkItemFixture, title: string): Promise<string> {
  const plan = await plansService.createPlan(f.projectId, { title }, f.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: `${title} — a proposal`, kind: 'task' } }],
    f.ctx,
  );
  await plansService.markPlanned(plan.id, f.ctx);
  return plan.id;
}

describe('search_past_plans — registered and declared', () => {
  it('tools/list names it, titled and read-only; every declaration home carries it', async () => {
    const server = buildMcpServer(() => fx.ctx);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(c);
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === SEARCH_PAST_PLANS_TOOL_NAME);
    expect(tool).toBeTruthy();
    expect(tool!.title).toBe('Search past plans');
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(MCP_TOOL_NAMES).toContain(SEARCH_PAST_PLANS_TOOL_NAME);
    expect(TOOL_PERMISSIONS[SEARCH_PAST_PLANS_TOOL_NAME]).toBe('project:browse');
    expect(TOOL_SCOPES[SEARCH_PAST_PLANS_TOOL_NAME]).toBe('read');
    expect(TOOL_ANNOTATIONS[SEARCH_PAST_PLANS_TOOL_NAME]).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(EXEMPT_TOOLS).toHaveProperty(SEARCH_PAST_PLANS_TOOL_NAME);
  });
});

describe('search_past_plans', () => {
  it('an empty project is the non-error nothing-matched state', async () => {
    const res = await call(fx.ctx, { projectKey: 'prod' });
    expect(structured(res)).toEqual({ outcome: 'nothing-matched', plans: [], nextCursor: null });
    expect(textOf(res)).toBe(`No plan of ${fx.projectIdentifier} matched.`);
  });

  it('returns the same rows as the internal route, declined ones with their reason', async () => {
    const planned = await plannedPlan(fx, 'Export rework');
    const declined = await plannedPlan(fx, 'Export retry');
    await plansService.declinePlan(declined, fx.ctx);
    await adminDb.plan.update({
      where: { id: planned },
      data: { summary: 's'.repeat(PAST_PLAN_SUMMARY_EXCERPT_MAX + 1) },
    });

    const res = await call(fx.ctx, { projectKey: fx.projectIdentifier, q: 'EXPORT' });
    const out = structured(res);
    const route = await SEARCH_ROUTE(
      new Request('http://core/api/internal/ai/past-plans?q=EXPORT', {
        headers: {
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': mintJobToken({
            userId: fx.ctx.userId,
            workspaceId: fx.ctx.workspaceId,
            projectId: fx.projectId,
          }),
        },
      }),
    );
    expect(out).toEqual(await route.json());
    expect((out['plans'] as { id: string }[]).map((p) => p.id)).toEqual([declined, planned]);
    const text = textOf(res);
    expect(text).toContain(`2 plans of ${fx.projectIdentifier}, newest first`);
    expect(text).toContain('declined (reviewed)');
    expect(text).toContain('summary (agent-written), truncated: ');
    expect(text).toContain('1 proposal ');
    expect(text).toContain('No more plans.');

    const onlyPlanned = await call(fx.ctx, {
      projectKey: fx.projectIdentifier,
      status: ['planned'],
    });
    expect((structured(onlyPlanned)['plans'] as { id: string }[]).map((p) => p.id)).toEqual([
      planned,
    ]);
  });

  it('pages with nextCursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      ids.push((await plansService.createPlan(fx.projectId, { title: `P${i}` }, fx.ctx)).id);
    }
    const first = await call(fx.ctx, { projectKey: fx.projectIdentifier });
    const page = structured(first);
    expect(page['plans']).toHaveLength(20);
    expect(page['nextCursor']).toBe(ids[1]);
    expect(textOf(first)).toContain(`cursor "${ids[1]}"`);
    const second = await call(fx.ctx, {
      projectKey: fx.projectIdentifier,
      cursor: page['nextCursor'],
    });
    expect((structured(second)['plans'] as { id: string }[]).map((p) => p.id)).toEqual([ids[0]]);
  });

  it('never returns a plan of a sibling project or another workspace', async () => {
    const mine = await plannedPlan(fx, 'Mine');
    const sibling = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    await plannedPlan({ ...fx, projectId: sibling.id }, 'Sibling');
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    await plannedPlan(rival, 'Rival');

    const res = await call(fx.ctx, { projectKey: fx.projectIdentifier });
    expect((structured(res)['plans'] as { id: string }[]).map((p) => p.id)).toEqual([mine]);

    const foreign = await call(fx.ctx, { projectKey: rival.projectIdentifier });
    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toContain('PROJECT_NOT_FOUND');
  });

  it('refuses an over-long query PAST_PLANS_QUERY_INVALID', async () => {
    const res = await call(fx.ctx, { projectKey: fx.projectIdentifier, q: 'x'.repeat(201) });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PAST_PLANS_QUERY_INVALID');
  });

  it('renders an undecided plan without a decision and a declined one with no recorded reason', () => {
    const text = renderPastPlans('PROD', {
      outcome: 'ok',
      nextCursor: null,
      plans: [
        {
          id: 'a',
          title: null,
          status: 'declined',
          decisionReason: null,
          summaryExcerpt: null,
          summaryTruncated: false,
          itemCount: 2,
          createdAt: 't0',
          plannedAt: null,
          decidedAt: null,
        },
        {
          id: 'b',
          title: 'Approved',
          status: 'approved',
          decisionReason: null,
          summaryExcerpt: 'short',
          summaryTruncated: false,
          itemCount: 1,
          createdAt: 't1',
          plannedAt: 't1',
          decidedAt: 't2',
        },
      ],
    });
    expect(text).toContain('2 plans of PROD');
    expect(text).toContain('Untitled plan (a) · declined (reason not recorded) · 2 proposals');
    expect(text).toContain('Approved (b) · approved · decided t2');
    expect(text).toContain('summary (agent-written): short');
  });
});
