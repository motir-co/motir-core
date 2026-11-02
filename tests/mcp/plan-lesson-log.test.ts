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
  GET_PLAN_LESSON_LOG_TOOL_NAME,
  lessonCallLine,
  summarizePlanLessonLog,
} from '@/lib/mcp/tools/getPlanLessonLog';
import type { PlanLessonCallDto, PlanLessonLogPageDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A planning session's LESSON CALLS over MCP (MOTIR-10191): `report_plan_step`'s
// `lessonCalls` arm writes them, `get_plan_lesson_log` reads them back. The
// store's own rules (order, caps, refusals, RLS) are proven in
// `tests/integration/plans/planLessonCall.test.ts`; asserted HERE is what only
// the transport answers — the schema lets the arm through, an empty report is
// accepted, the read-back groups by session, and "made no lesson call" reads
// differently from "not recorded".

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const LESSON = 'cstr77ecwfcozfr3frq8l7pxl';
const OTHER = 'clx9shared0lesson00000001';

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-lesson-log', version: '0.0.0' });
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

const search = {
  kind: 'search',
  query: 'wiring a cross-repository edge the wrong way',
  filters: { kinds: ['story'], phases: ['lay'] },
  lessonIds: [OTHER, LESSON],
  outcome: 'matched',
};

describe('the tool is registered and permissioned', () => {
  it('get_plan_lesson_log is registered, read-gated and free', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_PLAN_LESSON_LOG_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_PLAN_LESSON_LOG_TOOL_NAME]).toBe('project:browse');
    expect(isBillableTool(GET_PLAN_LESSON_LOG_TOOL_NAME)).toBe(false);
  });

  it('`tools/list` publishes the lessonCalls arm and the read-back tool', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const report = tools.find((t) => t.name === REPORT_PLAN_STEP_TOOL_NAME)!;
    expect(Object.keys(report.inputSchema.properties ?? {})).toContain('lessonCalls');
    const read = tools.find((t) => t.name === GET_PLAN_LESSON_LOG_TOOL_NAME)!;
    expect(Object.keys(read.inputSchema.properties ?? {}).sort()).toEqual([
      'afterSeq',
      'limit',
      'planId',
      'sessionKey',
    ]);
    expect(read.annotations?.readOnlyHint).toBe(true);
  });
});

describe('report_plan_step lessonCalls → get_plan_lesson_log', () => {
  it('records each session’s calls and reads them back grouped, an empty session explicit', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    await call(client, REPORT_PLAN_STEP_TOOL_NAME, { planId, sessionKey: 'lay-1', step: 'lay' });
    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-2',
      step: 'author',
    });
    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-3',
      step: 'author',
    });

    const recorded = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'lay-1',
      lessonCalls: [
        search,
        {
          kind: 'reinforce',
          lessonId: LESSON,
          occurrenceRef: `plan:${planId}#lay-1`,
          outcome: 'counted',
          counted: true,
        },
      ],
    });
    expect(recorded.isError).toBeFalsy();
    expect(textOf(recorded)).toBe(
      `Recorded 2 lesson calls for session \`lay-1\` on plan ${planId}.`,
    );
    expect(recorded.structuredContent).toEqual({
      planId,
      sessionKey: 'lay-1',
      lessonCalls: [
        { seq: 1, kind: 'search' },
        { seq: 2, kind: 'reinforce' },
      ],
    });

    const empty = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-2',
      lessonCalls: [],
    });
    expect(empty.isError).toBeFalsy();
    expect(textOf(empty)).toBe(
      `Recorded session \`author-2\` on plan ${planId} as making no lesson call.`,
    );

    const read = await call(client, GET_PLAN_LESSON_LOG_TOOL_NAME, { planId });
    expect(read.isError).toBeFalsy();
    const page = read.structuredContent as unknown as PlanLessonLogPageDto;
    expect(page.calls.map((c) => [c.seq, c.sessionKey, c.kind, c.lessonIds, c.lessonId])).toEqual([
      [1, 'lay-1', 'search', [OTHER, LESSON], null],
      [2, 'lay-1', 'reinforce', [], LESSON],
    ]);
    expect(page.sessions.map((s) => [s.sessionKey, s.calls, s.step?.stepKind])).toEqual([
      ['lay-1', 2, 'lay'],
      ['author-2', 0, 'author'],
    ]);
    expect(page.unrecordedSessions.map((s) => s.sessionKey)).toEqual(['author-3']);
    expect(page.nextAfterSeq).toBeNull();

    const text = textOf(read);
    expect(text).toContain(`Plan ${planId}: 2 lesson call(s) on this page, 2 session(s) recorded.`);
    expect(text).toContain('Session lay-1 — lay: 2 call(s).');
    expect(text).toContain(
      `  #1 search "wiring a cross-repository edge the wrong way" [kinds story · phases lay] → matched: ${OTHER}, ${LESSON}`,
    );
    expect(text).toContain(`  #2 reinforce ${LESSON} for plan:${planId}#lay-1 → counted (counted)`);
    expect(text).toContain('Session author-2 — author: no lesson call (recorded).');
    expect(text).toContain('Not recorded (no lesson log): author-3 — author.');
  });

  it('refuses a call carrying a lesson’s text, and a lessonCalls sent with a step', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    const withText = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 's',
      lessonCalls: [{ ...search, title: 'Audit which way each dependency edge points' }],
    });
    // The published schema has no field a lesson's text could ride in: the
    // transport refuses it before the store's own refusal is reached.
    expect(withText.isError).toBe(true);
    expect(textOf(withText)).toMatch(/title/);
    const twoArms = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 's',
      step: 'lay',
      lessonCalls: [],
    });
    expect(twoArms.isError).toBe(true);
    expect(await adminDb.planLessonSession.count({ where: { planId } })).toBe(0);
  });

  it('pages with afterSeq and narrows to one session', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await generatingPlan(client, fx);
    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'a',
      lessonCalls: [search, { ...search, query: 'two' }],
    });
    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'b',
      lessonCalls: [{ kind: 'injected', lessonIds: [LESSON], outcome: 'injected' }],
    });
    const first = await call(client, GET_PLAN_LESSON_LOG_TOOL_NAME, { planId, limit: 2 });
    const p1 = first.structuredContent as unknown as PlanLessonLogPageDto;
    expect(p1.nextAfterSeq).toBe(2);
    expect(textOf(first)).toContain('More calls follow: call again with `afterSeq: 2`.');
    const second = await call(client, GET_PLAN_LESSON_LOG_TOOL_NAME, { planId, afterSeq: 2 });
    const p2 = second.structuredContent as unknown as PlanLessonLogPageDto;
    expect(p2.calls.map((c) => c.kind)).toEqual(['injected']);
    expect(textOf(second)).toContain(`  #3 injected in code → ${LESSON}`);
    const one = await call(client, GET_PLAN_LESSON_LOG_TOOL_NAME, { planId, sessionKey: 'b' });
    const p3 = one.structuredContent as unknown as PlanLessonLogPageDto;
    expect(p3.sessions.map((s) => s.sessionKey)).toEqual(['b']);
  });

  it('answers an unknown plan as not found', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const read = await call(client, GET_PLAN_LESSON_LOG_TOOL_NAME, { planId: 'nope' });
    expect(read.isError).toBe(true);
    expect(textOf(read)).toMatch(/PLAN_NOT_FOUND|not found/i);
  });
});

describe('summarizePlanLessonLog / lessonCallLine — the text a check quotes', () => {
  const base: PlanLessonCallDto = {
    seq: 1,
    sessionKey: 's',
    kind: 'search',
    query: null,
    filters: {},
    lessonIds: [],
    lessonId: null,
    occurrenceRef: null,
    outcome: 'nothing-matched',
    counted: null,
    detail: null,
    createdAt: '2026-11-01T00:00:00.000Z',
  };

  it('prints each kind, an empty search and every filter axis', () => {
    expect(lessonCallLine(base)).toBe('#1 search [no filters] → nothing-matched: none');
    expect(
      lessonCallLine({
        ...base,
        query: 'q',
        filters: { kinds: ['task'], types: ['code'], phases: ['author'], subject: 'mcp', limit: 4 },
        outcome: 'unavailable',
        detail: 'store down',
      }),
    ).toBe(
      '#1 search "q" [kinds task · types code · phases author · subject mcp · limit 4] → unavailable: none — store down',
    );
    expect(lessonCallLine({ ...base, kind: 'injected', outcome: 'injected' })).toBe(
      '#1 injected in code → none',
    );
    expect(
      lessonCallLine({
        ...base,
        kind: 'add',
        outcome: 'error',
        counted: false,
        detail: 'duplicate',
      }),
    ).toBe('#1 add (no lesson) → error (not counted) — duplicate');
    expect(lessonCallLine({ ...base, kind: 'reinforce', lessonId: LESSON, outcome: 'error' })).toBe(
      `#1 reinforce ${LESSON} → error`,
    );
  });

  it('names a session whose calls are on another page only by its count line', () => {
    const page: PlanLessonLogPageDto = {
      planId: 'P',
      calls: [],
      sessions: [
        {
          sessionKey: 'later',
          calls: 3,
          firstReportAt: base.createdAt,
          lastReportAt: base.createdAt,
          step: {
            sessionKey: 'later',
            stepKind: 'author',
            targetRef: 'planItem:x',
            targetTitle: 'The picker',
            firstReportedAt: base.createdAt,
            updatedAt: base.createdAt,
          },
        },
      ],
      unrecordedSessions: [],
      nextAfterSeq: null,
    };
    expect(summarizePlanLessonLog(page)).toBe(
      'Plan P: 0 lesson call(s) on this page, 1 session(s) recorded.',
    );
  });
});
