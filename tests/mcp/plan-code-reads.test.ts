import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import {
  GET_PLAN_CODE_READS_TOOL_NAME,
  summarizePlanCodeReads,
} from '@/lib/mcp/tools/getPlanCodeReads';
import type { PlanCodeReadPageDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A planning session's CODE READS over MCP (MOTIR-10122): `report_plan_step`'s
// `codeReads` arm writes them, `get_plan_code_reads` reads them back. The store's
// own rules (order, caps, refusals, RLS) are proven in
// `tests/integration/plans/planCodeRead.test.ts`; asserted HERE is what only the
// transport answers — the schema lets the arm through, the result text and
// payload, the read-back's grouping by session with its step words, paging, and
// that every commit is printed in full.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b';
const LOCAL = '2c26b46b68ffc68ff99b453c1d30413413422d70';

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-code-reads', version: '0.0.0' });
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
    proposals: [{ op: 'add', proposedFields: { title: 'The picker', kind: 'story' } }],
  });
  return planId;
}

const fileRead = {
  tool: 'read_file',
  repo: 'acme/core',
  path: 'lib/x.ts',
  startLine: 10,
  endLine: 40,
  askedRef: 'main',
  commits: [{ sha: SHA }],
  outcome: 'found',
  lines: 31,
};
const localGrep = {
  tool: 'Grep',
  repo: 'motir-core',
  path: 'lib/',
  query: 'chooseInTx',
  commits: [{ repo: 'motir-core', sha: LOCAL, dirty: true }],
  outcome: 'ok',
  hits: 3,
};
const refused = {
  tool: 'read_file',
  repo: 'acme/core',
  path: 'nope.ts',
  askedRef: 'gone',
  outcome: 'ref_not_found',
  detail: 'no commit named gone',
};

describe('the tools are registered and permissioned', () => {
  it('get_plan_code_reads is registered, read-gated and free', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_PLAN_CODE_READS_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_PLAN_CODE_READS_TOOL_NAME]).toBe('project:browse');
    expect(isBillableTool(GET_PLAN_CODE_READS_TOOL_NAME)).toBe(false);
  });

  it('`tools/list` publishes the codeReads arm and the read-back tool', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const report = tools.find((t) => t.name === REPORT_PLAN_STEP_TOOL_NAME)!;
    expect(Object.keys(report.inputSchema.properties ?? {})).toContain('codeReads');
    const read = tools.find((t) => t.name === GET_PLAN_CODE_READS_TOOL_NAME)!;
    expect(Object.keys(read.inputSchema.properties ?? {}).sort()).toEqual([
      'afterSeq',
      'limit',
      'planId',
      'sessionKey',
    ]);
    expect(read.annotations?.readOnlyHint).toBe(true);
  });
});

describe('report_plan_step codeReads → get_plan_code_reads', () => {
  it('records each session’s reads in call order and reads them back grouped by session', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    // The authoring session holds a step, so its reads come back with its words;
    // the conversation session holds none, and its reads are recorded anyway.
    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-1',
      step: 'author',
    });

    const first = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'plan.py:run:0',
      codeReads: [fileRead, localGrep],
    });
    expect(first.isError, textOf(first)).toBeFalsy();
    expect(first.structuredContent).toEqual({
      planId,
      sessionKey: 'plan.py:run:0',
      codeReads: [
        { seq: 1, tool: 'read_file' },
        { seq: 2, tool: 'Grep' },
      ],
    });
    expect(textOf(first)).toBe(
      `Recorded 2 code reads for session \`plan.py:run:0\` on plan ${planId}.`,
    );
    const one = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-1',
      codeReads: [refused],
    });
    expect(textOf(one)).toBe(`Recorded 1 code read for session \`author-1\` on plan ${planId}.`);

    const back = await call(client, GET_PLAN_CODE_READS_TOOL_NAME, { planId });
    expect(back.isError, textOf(back)).toBeFalsy();
    const page = back.structuredContent as unknown as PlanCodeReadPageDto;
    expect(page.reads.map((r) => [r.seq, r.sessionKey, r.tool, r.outcome])).toEqual([
      [1, 'plan.py:run:0', 'read_file', 'found'],
      [2, 'plan.py:run:0', 'Grep', 'ok'],
      [3, 'author-1', 'read_file', 'ref_not_found'],
    ]);
    expect(page.reads[2]!.commits).toEqual([]);
    expect(page.sessions.map((s) => s.sessionKey)).toEqual(['author-1']);
    expect(page.nextAfterSeq).toBeNull();
    // No field of the read-back can hold a file's text.
    expect(JSON.stringify(page)).not.toMatch(/"(text|content)"/);

    const text = textOf(back);
    expect(text).toContain(`Plan ${planId}: 3 code read(s), in call order.`);
    expect(text).toContain('Session plan.py:run:0:');
    expect(text).toContain(
      `  #1 read_file acme/core lib/x.ts:10-40 · at ${SHA} · found (31 lines)`,
    );
    expect(text).toContain(
      `  #2 Grep motir-core lib/ "chooseInTx" · at motir-core@${LOCAL} (dirty) · ok (3 hits)`,
    );
    expect(text).toContain('Session author-1 — author:');
    expect(text).toContain(
      '  #3 read_file acme/core nope.ts · at no commit resolved · ref_not_found — no commit named gone',
    );
  });

  it('narrows to one session and pages with afterSeq until nextAfterSeq is null', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    for (const sessionKey of ['a', 'b', 'a']) {
      await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
        planId,
        sessionKey,
        codeReads: [fileRead],
      });
    }

    const onlyA = await call(client, GET_PLAN_CODE_READS_TOOL_NAME, { planId, sessionKey: 'a' });
    expect(
      (onlyA.structuredContent as unknown as PlanCodeReadPageDto).reads.map((r) => r.seq),
    ).toEqual([1, 3]);

    const p1 = await call(client, GET_PLAN_CODE_READS_TOOL_NAME, { planId, limit: 2 });
    const page1 = p1.structuredContent as unknown as PlanCodeReadPageDto;
    expect(page1.reads.map((r) => r.seq)).toEqual([1, 2]);
    expect(page1.nextAfterSeq).toBe(2);
    expect(textOf(p1)).toContain('call again with `afterSeq: 2`');
    const p2 = await call(client, GET_PLAN_CODE_READS_TOOL_NAME, {
      planId,
      limit: 2,
      afterSeq: 2,
    });
    const page2 = p2.structuredContent as unknown as PlanCodeReadPageDto;
    expect(page2.reads.map((r) => r.seq)).toEqual([3]);
    expect(page2.nextAfterSeq).toBeNull();
  });

  it('a refused batch is a typed PLAN_STEP_INVALID and records nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    for (const extra of [
      { codeReads: [{ ...fileRead, commits: [{ sha: 'main' }] }] },
      { codeReads: [fileRead], step: 'settle' },
      { codeReads: [fileRead], target: 'planItem:x' },
    ]) {
      const res = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
        planId,
        sessionKey: 's',
        ...extra,
      });
      expect(res.isError, JSON.stringify(extra)).toBe(true);
      expect(textOf(res)).toContain('PLAN_STEP_INVALID');
    }
    expect(await adminDb.planCodeRead.count({ where: { planId } })).toBe(0);
  });

  it('an empty plan says so; a plan in another workspace is not found', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    const empty = await call(client, GET_PLAN_CODE_READS_TOOL_NAME, { planId });
    expect(textOf(empty)).toBe(`Plan ${planId}: no code reads recorded.`);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreign = await call(await connectClient(other.ctx), GET_PLAN_CODE_READS_TOOL_NAME, {
      planId,
    });
    expect(foreign.isError).toBe(true);
  });
});

describe('summarizePlanCodeReads', () => {
  it('an empty middle page says "on this page"', () => {
    expect(summarizePlanCodeReads({ planId: 'p', reads: [], sessions: [], nextAfterSeq: 5 })).toBe(
      'Plan p: no code reads recorded on this page.',
    );
  });
});
