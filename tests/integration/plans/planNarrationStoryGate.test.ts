import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { contextFromExtra, grantFromExtra } from '@/lib/mcp/context';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { mintJobToken } from '@/lib/ai/jobToken';
import { REPORT_PLAN_STEP_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { fetchPlanNarrationPage, PlanRequestError } from '@/lib/planning/planReviewClient';
import { plansService } from '@/lib/services/plansService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workspacesService } from '@/lib/services/workspacesService';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { VISITOR_ADDRESS_HEADER } from '@/lib/visitor/address';
import {
  PLAN_NARRATION_BATCH_MAX,
  PLAN_NARRATION_READ_WINDOW,
  PLAN_NARRATION_SENTENCE_MAX,
} from '@/lib/plans/planNarration';
import {
  PLAN_STALLED_AFTER_MS,
  readPlanProgress,
  type PlanProgressSnapshot,
} from '@/lib/plans/planProgress';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanNarrationPageDto } from '@/lib/dto/plans';
import type { WorkbenchPlanningPageDto } from '@/lib/dto/home';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateRateLimitCounters } from '../../helpers/db';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { projectAccessData, setProjectAccess } from '@/tests/helpers/projectAccess';
import { consentedVisitor } from '../../visitor/_consentedVisitor';

// THE NARRATION STORY GATE, motir-core's half (Story MOTIR-8060 · Subtask
// MOTIR-8066).
//
// The store (MOTIR-8062), the chat-panel read (MOTIR-8063) and the panel
// (MOTIR-8064) each prove their own layer. What none of them can see is the
// ASSEMBLED path: a sentence going in through a real door, cleaned and appended
// without moving the step or the session's step words; both coming back out on
// the review read every chat surface polls (and the sentences on the paged read);
// both outliving the step's `end` and the plan's decision; a refusal leaving no
// trace; and a Visitor seeing them exactly where they may see the plan.
//
// ── THE PLANNERS ARE PLAYED, NOT RUN ─────────────────────────────────────────
// Each planner reaches core through one door, both run IN THIS PROCESS, exactly
// as `planProgressStoryGate.test.ts` drives them:
//   · plan.py → `report_plan_step` through an in-memory MCP client over
//     `buildMcpServer` (`{ planId, sessionKey, step | narration }`);
//   · the hosted planner → the internal route's `POST` with the service bearer
//     and a minted job token (`{ jobId, sessionKey, step | narration }`).
//
// ── NOTHING CHANGED IS PROVEN FROM THE ROWS ──────────────────────────────────
// Every "unchanged" below is a before/after read of the stored rows through the
// admin client, never only the response: a refusal that answered the right code
// and wrote anyway would pass a response-only assertion.
//
// ── TIME IS NEVER FAKED ──────────────────────────────────────────────────────
// Stalled is reached by BACKDATING `plan.last_activity_at` and
// `plan_step.started_at`, then reading each answer at its own `observedAt`.
//
// ── WHAT IS MOCKED ───────────────────────────────────────────────────────────
// The request boundary only: the session, the cookie-reading workspace resolver,
// and `next/headers` (a test has no request scope). Every service, repository
// and row is the real one.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const wsCtx = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => wsCtx.current,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
const { GET: planRoute } = await import('@/app/api/plans/[id]/route');
const { GET: narrationRoute } = await import('@/app/api/plans/[id]/narration/route');
const { GET: planningRoute } = await import('@/app/api/workbench/planning/route');
const { POST: stepPOST } = await import('@/app/api/internal/ai/plan-step/route');

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_narration", "plan_narration_session", "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  session.current = null;
  wsCtx.current = null;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The two planners' doors ──────────────────────────────────────────────────

async function connectClient(
  ctx: ServiceContext,
  grant?: () => ReturnType<typeof grantFromExtra>,
): Promise<Client> {
  const server = buildMcpServer(() => ctx, grant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'plan-narration-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** plan.py's call — a step report or a narration batch, whichever `args` carries. */
const mcpReport = (client: Client, args: Record<string, unknown>) =>
  client.callTool({
    name: REPORT_PLAN_STEP_TOOL_NAME,
    arguments: args,
  }) as Promise<CallToolResult>;

/** A plan.py call that must succeed — its error text is the failure message. */
async function mcpOk(client: Client, args: Record<string, unknown>): Promise<void> {
  const res = await mcpReport(client, args);
  expect(res.isError, textOf(res)).toBeFalsy();
}

/** A plan.py call that must be refused with `code`. */
async function mcpRefused(client: Client, args: Record<string, unknown>, code: string) {
  const res = await mcpReport(client, args);
  expect(res.isError, `expected ${code}, got success`).toBe(true);
  expect(textOf(res)).toContain(code);
}

/** The hosted planner's call — the internal route with its two credentials. */
function hosted(fx: WorkItemFixture, body: Record<string, unknown>): Promise<Response> {
  const token = mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
  return stepPOST(
    new Request('http://core/api/internal/ai/plan-step', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SERVICE_SECRET}`,
        'x-motir-job-token': token,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function hostedOk(fx: WorkItemFixture, body: Record<string, unknown>): Promise<void> {
  const res = await hosted(fx, body);
  expect(res.status, await res.clone().text()).toBe(200);
}

async function hostedRefused(
  fx: WorkItemFixture,
  body: Record<string, unknown>,
  status: number,
  code: string,
) {
  const res = await hosted(fx, body);
  expect(res.status).toBe(status);
  expect(((await res.json()) as { code: string }).code).toBe(code);
}

/**
 * A NATIVE plan bound to a generation job, with `titles` proposed as adds — one
 * plan BOTH doors reach: the MCP door addresses it by id, the route by its job.
 */
async function sharedPlan(
  fx: WorkItemFixture,
  jobId: string,
  titles: string[],
): Promise<{ planId: string; addIds: string[] }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { sourceJobId: jobId, title: `Narrated ${jobId}`, createdById: fx.ownerId },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    titles.map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'task' as const },
    })),
    fx.ctx,
  );
  return { planId: plan.id, addIds: appended.appendedItemIds };
}

// ── The reads ────────────────────────────────────────────────────────────────

function signIn(user: { id: string }, workspaceId: string | null): void {
  session.current = { user: { id: user.id, email: `${user.id}@example.com`, name: 'Reader' } };
  wsCtx.current = workspaceId ? { userId: user.id, workspaceId } : null;
}

/** `GET /api/plans/[id]` as the plan's owner. */
async function reviewRead(fx: WorkItemFixture, planId: string): Promise<PlanReviewDto> {
  signIn({ id: fx.ownerId }, fx.workspaceId);
  const res = await planRoute(new Request(`http://localhost/api/plans/${planId}`), {
    params: Promise.resolve({ id: planId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PlanReviewDto;
}

/** `GET /api/plans/[id]/narration?beforeSeq=<n>` as the plan's owner. */
async function pageRead(
  fx: WorkItemFixture,
  planId: string,
  beforeSeq: number,
): Promise<PlanNarrationPageDto> {
  signIn({ id: fx.ownerId }, fx.workspaceId);
  const res = await narrationRoute(
    new Request(`http://localhost/api/plans/${planId}/narration?beforeSeq=${beforeSeq}`),
    { params: Promise.resolve({ id: planId }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PlanNarrationPageDto;
}

/** `GET /api/workbench/planning` as the plan's owner — the raw text and the page. */
async function tabRead(
  fx: WorkItemFixture,
): Promise<{ raw: string; page: WorkbenchPlanningPageDto }> {
  signIn({ id: fx.ownerId }, fx.workspaceId);
  const res = await planningRoute(new Request('http://localhost/api/workbench/planning'));
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { raw, page: JSON.parse(raw) as WorkbenchPlanningPageDto };
}

async function tabProgress(fx: WorkItemFixture, planId: string): Promise<PlanProgressSnapshot> {
  const { page } = await tabRead(fx);
  const row = page.items.find((r) => r.planId === planId);
  expect(row, `plan ${planId} is not on the reader's Planning tab`).toBeDefined();
  return row!.progress;
}

const entriesOf = (review: PlanReviewDto) =>
  review.narration!.entries.map((e) => [e.seq, e.sessionKey, e.body] as const);

const wordsOf = (review: PlanReviewDto) =>
  review.narration!.sessions.map((s) => [s.sessionKey, s.stepKind, s.targetRef, s.targetTitle]);

// ── The stored rows, for every "nothing changed" ─────────────────────────────

const narrationRows = (planId: string) =>
  adminDb.planNarration.findMany({ where: { planId }, orderBy: { seq: 'asc' } });

const sessionRows = (planId: string) =>
  adminDb.planNarrationSession.findMany({
    where: { planId },
    orderBy: [{ firstReportedAt: 'asc' }, { id: 'asc' }],
  });

const stepRow = (planId: string, sessionKey: string) =>
  adminDb.planStep.findUnique({ where: { planId_sessionKey: { planId, sessionKey } } });

/** Everything a narration refusal must leave exactly as it was. */
async function stored(planId: string, sessionKey: string) {
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  return {
    narration: await narrationRows(planId),
    sessions: await sessionRows(planId),
    step: await stepRow(planId, sessionKey),
    lastActivityAt: plan.lastActivityAt.toISOString(),
  };
}

const PAST_STALL = PLAN_STALLED_AFTER_MS + 60_000;

// ─────────────────────────────────────────────────────────────────────────────
describe('A. both doors append, in order, and the step does not move', () => {
  async function threeSessions() {
    const fx = await makeWorkItemFixture({ identifier: 'PNA' });
    const client = await connectClient(fx.ctx);
    const committed = await createTestWorkItem(fx, { title: 'The billing story', kind: 'story' });
    const jobId = 'job_narration_a';
    const { planId, addIds } = await sharedPlan(fx, jobId, ['The mailbox picker']);
    const x = `planItem:${addIds[0]}`;

    await mcpOk(client, { planId, sessionKey: 'p1', step: 'author', target: x });
    await hostedOk(fx, { jobId, sessionKey: 'h1', step: 'lay', target: committed.id });
    await mcpOk(client, { planId, sessionKey: 's1', step: 'settle' });
    return { fx, client, committed, jobId, planId, x };
  }

  it('A1 — sentences from both doors come back in seq order, beside every session’s step words', async () => {
    const t = await threeSessions();
    await mcpOk(t.client, {
      planId: t.planId,
      sessionKey: 'p1',
      narration: ['Reading the mailbox service', 'Checking where a turn is stored'],
    });
    await hostedOk(t.fx, {
      jobId: t.jobId,
      sessionKey: 'h1',
      narration: ['Laying the story’s children'],
    });

    const review = await reviewRead(t.fx, t.planId);
    expect(entriesOf(review)).toEqual([
      [1, 'p1', 'Reading the mailbox service'],
      [2, 'p1', 'Checking where a turn is stored'],
      [3, 'h1', 'Laying the story’s children'],
    ]);
    expect(review.narration!.earlierCount).toBe(0);
    // `firstReportedAt` order; the hosted door wrote step words too, and the
    // wordless `settle` session is listed, not dropped.
    expect(wordsOf(review)).toEqual([
      ['p1', 'author', t.x, 'The mailbox picker'],
      ['h1', 'lay', t.committed.id, 'The billing story'],
      ['s1', 'settle', null, null],
    ]);
    expect(review.narration!.entries.some((e) => e.sessionKey === 's1')).toBe(false);
  });

  it('A2 — a narration call leaves the step and the step words byte-identical, and stamps the activity', async () => {
    const t = await threeSessions();
    const before = {
      p1: await stepRow(t.planId, 'p1'),
      h1: await stepRow(t.planId, 'h1'),
      words: await sessionRows(t.planId),
    };

    await mcpOk(t.client, { planId: t.planId, sessionKey: 'p1', narration: ['One', 'Two'] });
    await hostedOk(t.fx, { jobId: t.jobId, sessionKey: 'h1', narration: ['Three'] });

    expect(await stepRow(t.planId, 'p1')).toEqual(before.p1);
    expect(await stepRow(t.planId, 'h1')).toEqual(before.h1);
    expect(await sessionRows(t.planId)).toEqual(before.words);

    // Every row of the LAST call shares one server instant, and it is the stamp.
    const rows = await narrationRows(t.planId);
    const last = rows.filter((r) => r.sessionKey === 'h1');
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: t.planId } });
    expect(last.map((r) => r.createdAt.toISOString())).toEqual([plan.lastActivityAt.toISOString()]);
    const first = rows.filter((r) => r.sessionKey === 'p1').map((r) => r.createdAt.getTime());
    expect(new Set(first).size).toBe(1);

    const review = await reviewRead(t.fx, t.planId);
    expect(review.lastActivityAt).toBe(plan.lastActivityAt.toISOString());
    expect(review.narration!.entries.at(-1)!.createdAt).toBe(plan.lastActivityAt.toISOString());
  });

  it('A3 — a second call under one session appends after the first and replaces nothing', async () => {
    const t = await threeSessions();
    await mcpOk(t.client, { planId: t.planId, sessionKey: 'p1', narration: ['a', 'b'] });
    await hostedOk(t.fx, { jobId: t.jobId, sessionKey: 'h1', narration: ['c'] });
    const before = await narrationRows(t.planId);

    await mcpOk(t.client, { planId: t.planId, sessionKey: 'p1', narration: ['d', 'e'] });

    const after = await narrationRows(t.planId);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(entriesOf(await reviewRead(t.fx, t.planId))).toEqual([
      [1, 'p1', 'a'],
      [2, 'p1', 'b'],
      [3, 'h1', 'c'],
      [4, 'p1', 'd'],
      [5, 'p1', 'e'],
    ]);
  });

  it('A′3a — a re-report replaces the words in ONE row, keeps `firstReportedAt` and moves `updatedAt`', async () => {
    const t = await threeSessions();
    await mcpOk(t.client, { planId: t.planId, sessionKey: 'p1', narration: ['Before'] });
    await hostedOk(t.fx, { jobId: t.jobId, sessionKey: 'h1', narration: ['Before too'] });
    const before = await sessionRows(t.planId);
    const sentences = await narrationRows(t.planId);

    // A target change on one door, a kind change on the other.
    await mcpOk(t.client, {
      planId: t.planId,
      sessionKey: 'p1',
      step: 'author',
      target: t.committed.id,
    });
    await hostedOk(t.fx, { jobId: t.jobId, sessionKey: 'h1', step: 'author', target: t.x });

    const after = await sessionRows(t.planId);
    expect(after).toHaveLength(3);
    expect(
      await adminDb.planNarrationSession.count({ where: { planId: t.planId, sessionKey: 'p1' } }),
    ).toBe(1);
    expect(
      await adminDb.planNarrationSession.count({ where: { planId: t.planId, sessionKey: 'h1' } }),
    ).toBe(1);
    for (const key of ['p1', 'h1']) {
      const was = before.find((r) => r.sessionKey === key)!;
      const is = after.find((r) => r.sessionKey === key)!;
      expect(is.id).toBe(was.id);
      expect(is.firstReportedAt).toEqual(was.firstReportedAt);
      expect(is.updatedAt.getTime()).toBeGreaterThan(was.updatedAt.getTime());
    }

    const review = await reviewRead(t.fx, t.planId);
    expect(wordsOf(review)).toEqual([
      ['p1', 'author', t.committed.id, 'The billing story'],
      ['h1', 'author', t.x, 'The mailbox picker'],
      ['s1', 'settle', null, null],
    ]);
    expect(await narrationRows(t.planId)).toEqual(sentences);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. parallel sessions stay ordered and attributed', () => {
  it('B4 — three sessions over both doors in ONE Promise.all', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PNB' });
    const client = await connectClient(fx.ctx);
    const jobId = 'job_narration_b';
    const { planId, addIds } = await sharedPlan(fx, jobId, ['One', 'Two', 'Three']);

    const viaMcp = async (sessionKey: string, target: string) => {
      await mcpOk(client, { planId, sessionKey, step: 'author', target });
      await mcpOk(client, {
        planId,
        sessionKey,
        narration: [`${sessionKey}-1`, `${sessionKey}-2`],
      });
      await mcpOk(client, {
        planId,
        sessionKey,
        narration: [`${sessionKey}-3`, `${sessionKey}-4`],
      });
    };
    const viaRoute = async (sessionKey: string, target: string) => {
      await hostedOk(fx, { jobId, sessionKey, step: 'author', target });
      await hostedOk(fx, { jobId, sessionKey, narration: [`${sessionKey}-1`, `${sessionKey}-2`] });
      await hostedOk(fx, { jobId, sessionKey, narration: [`${sessionKey}-3`, `${sessionKey}-4`] });
    };
    // ⚠️ NO AWAIT BETWEEN THEM — the shape parallel authoring produces.
    await Promise.all([
      viaMcp('m-a', `planItem:${addIds[0]}`),
      viaMcp('m-b', `planItem:${addIds[1]}`),
      viaRoute('h-c', `planItem:${addIds[2]}`),
    ]);

    const review = await reviewRead(fx, planId);
    const entries = review.narration!.entries;
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    for (const key of ['m-a', 'm-b', 'h-c']) {
      const mine = entries.filter((e) => e.sessionKey === key).map((e) => e.body);
      // Its own order, and nothing of anyone else's.
      expect(mine).toEqual([1, 2, 3, 4].map((n) => `${key}-${n}`));
    }
    const titles = new Map(
      review.narration!.sessions.map((s) => [s.sessionKey, s.targetTitle] as const),
    );
    expect(titles).toEqual(
      new Map([
        ['m-a', 'One'],
        ['m-b', 'Two'],
        ['h-c', 'Three'],
      ]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C. the window and the paged read, assembled', () => {
  it('C5 — the review read carries the newest window, sessions unwindowed; the paged route reaches back', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PNC' });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await sharedPlan(fx, 'job_narration_c', ['Late target']);
    const EARLY = PLAN_NARRATION_BATCH_MAX;
    const LATE = PLAN_NARRATION_READ_WINDOW;

    await mcpOk(client, { planId, sessionKey: 'early', step: 'settle' });
    await mcpOk(client, {
      planId,
      sessionKey: 'early',
      narration: Array.from({ length: EARLY }, (_, i) => `Early ${i + 1}`),
    });
    await mcpOk(client, { planId, sessionKey: 'early', step: 'end' });

    await mcpOk(client, {
      planId,
      sessionKey: 'late',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    for (let from = 0; from < LATE; from += PLAN_NARRATION_BATCH_MAX) {
      const size = Math.min(PLAN_NARRATION_BATCH_MAX, LATE - from);
      await mcpOk(client, {
        planId,
        sessionKey: 'late',
        narration: Array.from({ length: size }, (_, i) => `Late ${from + i + 1}`),
      });
    }

    const total = EARLY + LATE;
    const review = await reviewRead(fx, planId);
    const n = review.narration!;
    expect(n.entries.map((e) => e.seq)).toEqual(
      Array.from(
        { length: PLAN_NARRATION_READ_WINDOW },
        (_, i) => total - PLAN_NARRATION_READ_WINDOW + i + 1,
      ),
    );
    expect(n.earlierCount).toBe(total - PLAN_NARRATION_READ_WINDOW);
    // None of `early`'s sentences is in the window, and it is still listed.
    expect(n.entries.some((e) => e.sessionKey === 'early')).toBe(false);
    expect(wordsOf(review)).toEqual([
      ['early', 'settle', null, null],
      ['late', 'author', `planItem:${addIds[0]}`, 'Late target'],
    ]);

    const page = await pageRead(fx, planId, n.entries[0]!.seq);
    expect(page.entries.map((e) => e.seq)).toEqual(Array.from({ length: EARLY }, (_, i) => i + 1));
    expect(page.entries.map((e) => e.body)).toEqual(
      Array.from({ length: EARLY }, (_, i) => `Early ${i + 1}`),
    );
    expect(page.earlierCount).toBe(0);
  });

  it('C5b — the panel’s client reaches the same page through the real route', async () => {
    // `fetchPlanNarrationPage` is what the chat panel calls; its `fetch` is wired
    // straight to the route handler, so the client, the route and the service are
    // all real and only the network is skipped.
    const fx = await makeWorkItemFixture({ identifier: 'PNQ' });
    const client = await connectClient(fx.ctx);
    const { planId } = await sharedPlan(fx, 'job_narration_c5b', ['Paged']);
    await mcpOk(client, { planId, sessionKey: 'p1', step: 'settle' });
    await mcpOk(client, { planId, sessionKey: 'p1', narration: ['One', 'Two', 'Three'] });

    signIn({ id: fx.ownerId }, fx.workspaceId);
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      seen.push(`${url.pathname}${url.search}`);
      const id = decodeURIComponent(url.pathname.split('/')[3]!);
      return narrationRoute(new Request(url, init), { params: Promise.resolve({ id }) });
    });
    try {
      const page = await fetchPlanNarrationPage(planId, 4, undefined, 2);
      expect(page.entries.map((e) => e.body)).toEqual(['Two', 'Three']);
      expect(page.earlierCount).toBe(1);
      expect(seen).toEqual([`/api/plans/${planId}/narration?beforeSeq=4&limit=2`]);
      expect((await fetchPlanNarrationPage(planId, 2)).entries.map((e) => e.body)).toEqual(['One']);
      // A refused page is the client's typed error, carrying the route's status.
      const refused = await fetchPlanNarrationPage('cm-not-a-plan', 2).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(PlanRequestError);
      expect((refused as PlanRequestError).status).toBe(404);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D. cleaning, through both doors', () => {
  const LONG = 'a'.repeat(PLAN_NARRATION_SENTENCE_MAX + 50);
  const CJK = '漢'.repeat(PLAN_NARRATION_SENTENCE_MAX + 10);
  const EMOJI = '😀'.repeat(PLAN_NARRATION_SENTENCE_MAX + 5);
  const EXACT = 'b'.repeat(PLAN_NARRATION_SENTENCE_MAX);
  const MESSY = 'Line one\nline\ttwo\r\n   three\u0007 end';

  async function bothDoors(sentences: string[]) {
    const fx = await makeWorkItemFixture({ identifier: 'PND' });
    const client = await connectClient(fx.ctx);
    const jobId = 'job_narration_d';
    const { planId } = await sharedPlan(fx, jobId, ['Target']);
    await mcpOk(client, { planId, sessionKey: 'm', step: 'settle' });
    await hostedOk(fx, { jobId, sessionKey: 'h', step: 'settle' });
    await mcpOk(client, { planId, sessionKey: 'm', narration: sentences });
    await hostedOk(fx, { jobId, sessionKey: 'h', narration: sentences });
    const entries = (await reviewRead(fx, planId)).narration!.entries;
    return (key: string) => entries.filter((e) => e.sessionKey === key).map((e) => e.body);
  }

  it('D6 — newlines, tabs, returns and control characters come back as one single-spaced line', async () => {
    const bodiesOf = await bothDoors([MESSY]);
    for (const key of ['m', 'h']) {
      expect(bodiesOf(key)).toEqual(['Line one line two three end']);
      expect(bodiesOf(key)[0]).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });

  it('D7 — the cap, against the imported constant: cut with `…`, never mid code point; exact kept whole', async () => {
    const bodiesOf = await bothDoors([LONG, CJK, EMOJI, EXACT]);
    for (const key of ['m', 'h']) {
      const [long, cjk, emoji, exact] = bodiesOf(key).map((b) => Array.from(b));
      for (const cut of [long!, cjk!, emoji!]) {
        expect(cut).toHaveLength(PLAN_NARRATION_SENTENCE_MAX);
        expect(cut.at(-1)).toBe('…');
      }
      expect(new Set(cjk!.slice(0, -1))).toEqual(new Set(['漢']));
      // A broken surrogate pair would read as a lone half, never as the emoji.
      expect(new Set(emoji!.slice(0, -1))).toEqual(new Set(['😀']));
      expect(exact!.join('')).toBe(EXACT);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E. refusals write nothing', () => {
  // The hosted route's own status split: a malformed BODY (both arms, neither, a
  // narration with a target) is 400; a well-formed call the service refuses on
  // its content (a blank sentence, the batch bounds, a session with no step) is
  // 422. Both carry `PLAN_STEP_INVALID`.
  async function narratedPlan(identifier: string) {
    const fx = await makeWorkItemFixture({ identifier });
    const client = await connectClient(fx.ctx);
    const jobId = `job_narration_${identifier.toLowerCase()}`;
    const { planId, addIds } = await sharedPlan(fx, jobId, ['Guarded']);
    await mcpOk(client, {
      planId,
      sessionKey: 'p1',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await mcpOk(client, { planId, sessionKey: 'p1', narration: ['Already said.'] });
    return { fx, client, jobId, planId, addIds };
  }

  /** Run `refuse`, then prove the four stored facts did not move. */
  async function nothingMoves(planId: string, refuse: () => Promise<void>) {
    const before = await stored(planId, 'p1');
    await refuse();
    expect(await stored(planId, 'p1')).toEqual(before);
  }

  it('E8 — a batch with one blank sentence is refused whole: none of its valid ones is written', async () => {
    const t = await narratedPlan('PNE');
    const batch = ['Valid.', '   \n\t ', 'Also valid.'];
    await nothingMoves(t.planId, async () => {
      await mcpRefused(
        t.client,
        { planId: t.planId, sessionKey: 'p1', narration: batch },
        'PLAN_STEP_INVALID',
      );
      await hostedRefused(
        t.fx,
        { jobId: t.jobId, sessionKey: 'p1', narration: batch },
        422,
        'PLAN_STEP_INVALID',
      );
    });
  });

  it('E9 — an empty batch, and one over the cap', async () => {
    const t = await narratedPlan('PNF');
    const over = Array.from({ length: PLAN_NARRATION_BATCH_MAX + 1 }, (_, i) => `S${i}`);
    await nothingMoves(t.planId, async () => {
      for (const narration of [[], over]) {
        await mcpRefused(
          t.client,
          { planId: t.planId, sessionKey: 'p1', narration },
          'PLAN_STEP_INVALID',
        );
        await hostedRefused(
          t.fx,
          { jobId: t.jobId, sessionKey: 'p1', narration },
          422,
          'PLAN_STEP_INVALID',
        );
      }
    });
  });

  it('E10 — a session that holds no step, named in the refusal', async () => {
    const t = await narratedPlan('PNG');
    await nothingMoves(t.planId, async () => {
      const res = await mcpReport(t.client, {
        planId: t.planId,
        sessionKey: 'ghost',
        narration: ['Hi.'],
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('PLAN_STEP_INVALID');
      expect(textOf(res)).toContain('ghost');
      const routed = await hosted(t.fx, {
        jobId: t.jobId,
        sessionKey: 'ghost',
        narration: ['Hi.'],
      });
      expect(routed.status).toBe(422);
      const body = (await routed.json()) as { code: string; error: string };
      expect(body.code).toBe('PLAN_STEP_INVALID');
      expect(body.error).toContain('ghost');
    });
  });

  it('E11 — narration with a step, narration with a target, and neither', async () => {
    const t = await narratedPlan('PNH');
    const target = `planItem:${t.addIds[0]}`;
    await nothingMoves(t.planId, async () => {
      for (const shape of [
        { step: 'author', target, narration: ['Both.'] },
        { target, narration: ['Aimed.'] },
        {},
      ]) {
        await mcpRefused(
          t.client,
          { planId: t.planId, sessionKey: 'p1', ...shape },
          'PLAN_STEP_INVALID',
        );
        await hostedRefused(
          t.fx,
          { jobId: t.jobId, sessionKey: 'p1', ...shape },
          400,
          'PLAN_STEP_INVALID',
        );
      }
    });
  });

  it('E12 — off `generating`: narration and a NEW session’s step are refused, and no session row appears', async () => {
    const t = await narratedPlan('PNI');
    await plansService.markPlanned(t.planId, t.fx.ctx);
    await nothingMoves(t.planId, async () => {
      await mcpRefused(
        t.client,
        { planId: t.planId, sessionKey: 'p1', narration: ['Late.'] },
        'PLAN_NOT_GENERATING',
      );
      await mcpRefused(
        t.client,
        { planId: t.planId, sessionKey: 'new', step: 'settle' },
        'PLAN_NOT_GENERATING',
      );
      await hostedRefused(
        t.fx,
        { jobId: t.jobId, sessionKey: 'p1', narration: ['Late.'] },
        409,
        'PLAN_NOT_GENERATING',
      );
      await hostedRefused(
        t.fx,
        { jobId: t.jobId, sessionKey: 'new', step: 'settle' },
        409,
        'PLAN_NOT_GENERATING',
      );
    });
    expect(
      await adminDb.planNarrationSession.count({ where: { planId: t.planId, sessionKey: 'new' } }),
    ).toBe(0);
  });

  it('E13 — a PAT carrying only CLI_TOKEN_GRANT is refused before any write', async () => {
    const t = await narratedPlan('PNJ');
    const { token } = await apiTokensService.create(t.fx.ownerId, t.fx.workspaceId, {
      label: 'motir run (narration gate)',
      fixedGrant: [...CLI_TOKEN_GRANT],
    });
    const info = await verifyMcpToken(new Request('http://localhost/api/mcp'), token);
    const extra = { authInfo: info } as Parameters<typeof contextFromExtra>[0];
    const run = await connectClient(contextFromExtra(extra), () => grantFromExtra(extra));

    await nothingMoves(t.planId, async () => {
      await mcpRefused(
        run,
        { planId: t.planId, sessionKey: 'p1', narration: ['No.'] },
        PERMISSION_NOT_GRANTED_CODE,
      );
      await mcpRefused(
        run,
        { planId: t.planId, sessionKey: 'run', step: 'settle' },
        PERMISSION_NOT_GRANTED_CODE,
      );
    });
    expect(
      await adminDb.planNarrationSession.count({ where: { planId: t.planId, sessionKey: 'run' } }),
    ).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F. sentences and step words outlive the step and the decision', () => {
  async function ended(identifier: string) {
    const fx = await makeWorkItemFixture({ identifier });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await sharedPlan(fx, `job_${identifier.toLowerCase()}`, ['Kept']);
    await mcpOk(client, {
      planId,
      sessionKey: 'p1',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await mcpOk(client, {
      planId,
      sessionKey: 'p1',
      narration: ['First thought.', 'Second thought.'],
    });
    const before = await reviewRead(fx, planId);
    await mcpOk(client, { planId, sessionKey: 'p1', step: 'end' });
    return { fx, planId, before };
  }

  async function bothReadsKeep(fx: WorkItemFixture, planId: string, before: PlanReviewDto) {
    const review = await reviewRead(fx, planId);
    expect(review.narration!.entries).toEqual(before.narration!.entries);
    expect(review.narration!.sessions).toEqual(before.narration!.sessions);
    const page = await pageRead(fx, planId, before.narration!.entries.length + 1);
    expect(page.entries).toEqual(before.narration!.entries);
    return review;
  }

  it('F14 — after `end` the step is gone and every sentence and the step words remain', async () => {
    const t = await ended('PNK');
    const review = await bothReadsKeep(t.fx, t.planId, t.before);
    expect(review.inFlightSteps!.map((s) => s.sessionKey)).not.toContain('p1');
    expect((review.progress?.steps ?? []).map((s) => s.sessionKey)).not.toContain('p1');
  });

  it('F15 — after planned and approved, and on a declined plan, both reads keep them unchanged', async () => {
    const t = await ended('PNL');
    await plansService.markPlanned(t.planId, t.fx.ctx);
    await bothReadsKeep(t.fx, t.planId, t.before);
    await plansService.approvePlan(t.planId, t.fx.ctx);
    expect((await bothReadsKeep(t.fx, t.planId, t.before)).status).toBe('approved');

    const d = await ended('PNM');
    await plansService.markPlanned(d.planId, d.fx.ctx);
    await plansService.declinePlan(d.planId, d.fx.ctx);
    expect((await bothReadsKeep(d.fx, d.planId, d.before)).status).toBe('declined');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('G. stalled held off by sentences, and the progress line unchanged', () => {
  it('G16 — a backdated plan reads stalled, and one narration batch lifts it on both reads', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PNN' });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await sharedPlan(fx, 'job_narration_g16', ['Slow']);
    await mcpOk(client, {
      planId,
      sessionKey: 'p1',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });

    const at = new Date(Date.now() - PAST_STALL);
    await adminDb.plan.update({ where: { id: planId }, data: { lastActivityAt: at } });
    await adminDb.planStep.updateMany({ where: { planId }, data: { startedAt: at } });
    const stale = (await reviewRead(fx, planId)).progress!;
    expect(readPlanProgress(stale, Date.parse(stale.observedAt)).state).toBe('stalled');

    await mcpOk(client, { planId, sessionKey: 'p1', narration: ['Still here.'] });

    const onReview = (await reviewRead(fx, planId)).progress!;
    const onTab = await tabProgress(fx, planId);
    const now = Math.max(Date.parse(onReview.observedAt), Date.parse(onTab.observedAt));
    expect(readPlanProgress(onReview, now).state).not.toBe('stalled');
    expect(readPlanProgress(onTab, now).state).not.toBe('stalled');
  });

  it('G17 — narration moves only a step’s last sign of life on the progress surfaces, and no sentence is on the Workbench read', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PNO' });
    const client = await connectClient(fx.ctx);
    const jobId = 'job_narration_g17';
    const { planId, addIds } = await sharedPlan(fx, jobId, ['Quiet']);
    await mcpOk(client, {
      planId,
      sessionKey: 'p1',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await hostedOk(fx, { jobId, sessionKey: 'h1', step: 'settle' });

    const beforeReview = await reviewRead(fx, planId);
    const beforeTab = await tabProgress(fx, planId);

    const SENTENCE = 'Weighing the unmistakable-narration-marker approach';
    await mcpOk(client, { planId, sessionKey: 'p1', narration: [SENTENCE] });
    await hostedOk(fx, { jobId, sessionKey: 'h1', narration: [`${SENTENCE} again`] });

    const afterReview = await reviewRead(fx, planId);
    const { raw, page } = await tabRead(fx);
    const afterTab = page.items.find((r) => r.planId === planId)!.progress;
    // A sentence is the session's latest sign of life, so it may move a step's
    // `lastActivityAt` (MOTIR-11184) — and nothing else: no phrase, target or
    // order changes, and no sentence text reaches either read.
    const withoutActivity = (steps: readonly { lastActivityAt: string }[]) =>
      steps.map(({ lastActivityAt: _a, ...rest }) => rest);
    expect(withoutActivity(afterReview.progress!.steps)).toEqual(
      withoutActivity(beforeReview.progress!.steps),
    );
    expect(afterReview.inFlightSteps).toEqual(beforeReview.inFlightSteps);
    expect(withoutActivity(afterTab.steps)).toEqual(withoutActivity(beforeTab.steps));
    const p1 = afterReview.progress!.steps.find((x) => x.sessionKey === 'p1')!;
    const p1Before = beforeReview.progress!.steps.find((x) => x.sessionKey === 'p1')!;
    expect(Date.parse(p1.lastActivityAt)).toBeGreaterThanOrEqual(
      Date.parse(p1Before.lastActivityAt),
    );
    expect(raw).not.toContain('unmistakable-narration-marker');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('H. the Visitor read', () => {
  let previousCloud: string | undefined;
  beforeEach(async () => {
    await truncateRateLimitCounters();
    __resetSharedRateLimitStoreForTest();
    pinSharedRateLimitStoreDeadline();
    previousCloud = process.env['MOTIR_CLOUD'];
    process.env['MOTIR_CLOUD'] = 'true';
  });
  afterEach(() => {
    if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
    else process.env['MOTIR_CLOUD'] = previousCloud;
  });

  /** A route call as a reader addressing the public project by its header. */
  async function asAddressed(
    route: typeof planRoute,
    url: string,
    planId: string,
    address: string,
  ): Promise<Response> {
    return route(new Request(url, { headers: { [VISITOR_ADDRESS_HEADER]: address } }), {
      params: Promise.resolve({ id: planId }),
    });
  }

  async function visitorReads(fx: WorkItemFixture, planId: string, beforeSeq: number) {
    const visitor = await consentedVisitor(fx.projectIdentifier);
    // Signed in, with no workspace of the project's: the member read answers
    // 401, and the address resolves them as this project's Visitor.
    signIn({ id: visitor.actorUserId }, null);
    const review = await asAddressed(
      planRoute,
      `http://localhost/api/plans/${planId}`,
      planId,
      fx.projectIdentifier,
    );
    signIn({ id: visitor.actorUserId }, null);
    const page = await asAddressed(
      narrationRoute,
      `http://localhost/api/plans/${planId}/narration?beforeSeq=${beforeSeq}`,
      planId,
      fx.projectIdentifier,
    );
    return { review, page };
  }

  async function publicProject() {
    const fx = await makeWorkItemFixture({ identifier: 'PNV' });
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('public'),
    });
    return { fx, client: await connectClient(fx.ctx) };
  }

  it('H18 — a Visitor’s review read and paged read equal a member’s, after an `end` and after approve', async () => {
    const { fx, client } = await publicProject();
    const committed = await createTestWorkItem(fx, { title: 'Public story', kind: 'story' });
    const jobId = 'job_narration_h18';
    const { planId, addIds } = await sharedPlan(fx, jobId, ['Public add']);
    await mcpOk(client, {
      planId,
      sessionKey: 'p1',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await hostedOk(fx, { jobId, sessionKey: 'h1', step: 'lay', target: committed.id });
    await mcpOk(client, { planId, sessionKey: 'p1', narration: ['Public one.', 'Public two.'] });
    await hostedOk(fx, { jobId, sessionKey: 'h1', narration: ['Public three.'] });

    const same = async () => {
      const member = await reviewRead(fx, planId);
      const memberPage = await pageRead(fx, planId, 4);
      const { review, page } = await visitorReads(fx, planId, 4);
      expect(review.status).toBe(200);
      expect(page.status).toBe(200);
      const seen = (await review.json()) as PlanReviewDto;
      expect(seen.narration!.entries).toEqual(member.narration!.entries);
      expect(seen.narration!.sessions).toEqual(member.narration!.sessions);
      expect(await page.json()).toEqual(memberPage);
      expect(member.narration!.entries).toHaveLength(3);
      expect(member.narration!.sessions).toHaveLength(2);
    };

    await same();
    await mcpOk(client, { planId, sessionKey: 'p1', step: 'end' });
    await same();
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);
    await same();

    // Signed OUT, the address alone is not a reader: the member's 401 stands.
    session.current = null;
    wsCtx.current = null;
    const anonymous = await asAddressed(
      planRoute,
      `http://localhost/api/plans/${planId}`,
      planId,
      fx.projectIdentifier,
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain('Public one.');
  });

  it('H19 — a plan touching a private epic: both Visitor reads 404, leaking no sentence and no title', async () => {
    const { fx, client } = await publicProject();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic' });
    const hidden = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Confidential pricing story',
      parentId: epic.id,
    });
    await adminDb.workItem.update({ where: { id: epic.id }, data: { publicChildrenHidden: true } });
    const jobId = 'job_narration_h19';
    const { planId } = await sharedPlan(fx, jobId, ['Visible add']);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: hidden.id, patch: { title: 'Renamed' } }],
      fx.ctx,
    );
    await mcpOk(client, { planId, sessionKey: 'p1', step: 'lay', target: hidden.id });
    await hostedOk(fx, { jobId, sessionKey: 'h1', step: 'settle' });
    await mcpOk(client, { planId, sessionKey: 'p1', narration: ['Secret pricing sentence.'] });
    await hostedOk(fx, { jobId, sessionKey: 'h1', narration: ['Another secret sentence.'] });
    // The words are stored — so their absence below is the gate, not a gap.
    expect((await sessionRows(planId))[0]!.targetTitle).toBe('Confidential pricing story');

    const { review, page } = await visitorReads(fx, planId, 10);
    expect(review.status).toBe(404);
    expect(page.status).toBe(404);
    for (const text of [await review.text(), await page.text()]) {
      for (const secret of ['Secret pricing', 'Another secret', 'Confidential pricing']) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ARM THE CASES ABOVE DO NOT REACH, on a file this lane GATES.
describe('I. the paged route’s remaining arm', () => {
  it('a workspace member who may not browse the project gets the no-existence-leak 404', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PNP' });
    const client = await connectClient(fx.ctx);
    const { planId } = await sharedPlan(fx, 'job_narration_i', ['Members only']);
    await mcpOk(client, { planId, sessionKey: 'p1', step: 'settle' });
    await mcpOk(client, { planId, sessionKey: 'p1', narration: ['Members-only sentence.'] });
    await setProjectAccess(adminDb, fx.projectId, 'members');
    const outsider = await createTestUser({
      email: `outsider-${Date.now()}@example.com`,
      name: 'outsider',
    });
    await workspacesService.addMember({
      userId: outsider.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });

    signIn(outsider, fx.workspaceId);
    const res = await narrationRoute(
      new Request(`http://localhost/api/plans/${planId}/narration?beforeSeq=5`),
      { params: Promise.resolve({ id: planId }) },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Members-only sentence.');
  });
});
