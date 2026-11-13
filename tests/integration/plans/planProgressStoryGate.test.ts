import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { plansService } from '@/lib/services/plansService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workspacesService } from '@/lib/services/workspacesService';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import {
  PLAN_STALLED_AFTER_MS,
  readPlanProgress,
  type PlanProgressReading,
  type PlanProgressSnapshot,
} from '@/lib/plans/planProgress';
import { resolveWorkbenchLanding } from '@/lib/workbench/landing';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { HomeTabCountsDto, WorkbenchPlanningPageDto } from '@/lib/dto/home';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestProject,
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// THE PLAN-PROGRESS STORY GATE, motir-core's half (Story MOTIR-7820 · Subtask
// MOTIR-7832).
//
// Each sibling proves its own layer — the step store (MOTIR-7822), the two doors
// (MOTIR-7824), the derivation (MOTIR-7825), the reader's read (MOTIR-7828) — and
// stops there. What none of them can see is the ASSEMBLED path: a signal going in
// through a real door, stored, coming back out on the plan's one poll
// (`GET /api/plans/[id]`) AND on the Workbench tab's read
// (`GET /api/workbench/planning`), and BOTH reads deriving the SAME progress from
// two different row loads through two different entry points
// (`snapshotForReview` over the review's items, `snapshotsForPlans` over a batched
// flag read). The story's promise is that the tab row and the plan surface tell
// one truth; this file is where that promise can fail.
//
// ── THE PLANNERS ARE PLAYED, NOT RUN ─────────────────────────────────────────
// Each planner reaches core through exactly one door, and both run IN THIS
// PROCESS, as `classificationStoryGate.test.ts` drives its pair:
//   · the MCP planner (`motir plan`) → `report_plan_step` through an in-memory MCP
//     client over `buildMcpServer`;
//   · the hosted planner (motir-ai's walk) → the internal route's `POST`, called
//     with the service bearer and a minted job token.
// Whether each real planner reports at the right MOMENTS is its own emitter's
// gate; this file proves the doors and reads are right for whatever is sent.
//
// ── TIME IS NEVER FAKED ──────────────────────────────────────────────────────
// Stalled and the quiet drop are reached by BACKDATING the stored server-clock
// timestamps (`plan.last_activity_at`, `plan_step.started_at`) through the admin
// client, then reading each answer through `readPlanProgress` at that answer's
// own `observedAt` — the server instant it was built at. Nothing in
// `planProgress.ts` is mocked, and the clock is the database's and the server's.
//
// ── WHAT IS MOCKED ───────────────────────────────────────────────────────────
// The request boundary and nothing under it, exactly as the siblings' route
// tests do: the session (`getSession`, the convention's one mock) and the
// cookie-reading workspace resolver (`getWorkspaceContext` — a test has no
// cookies). Every service, repository and row is the real one.

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
const { GET: planRoute } = await import('@/app/api/plans/[id]/route');
const { GET: planningRoute } = await import('@/app/api/workbench/planning/route');
const { POST: stepPOST } = await import('@/app/api/internal/ai/plan-step/route');
const { homeService } = await import('@/lib/services/homeService');
const { workbenchPlanningService } = await import('@/lib/services/workbenchPlanningService');
const { planProgressService } = await import('@/lib/services/planProgressService');

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
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
  const client = new Client({ name: 'plan-progress-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** A tool call that must succeed — its error text is the failure message. */
async function ok(client: Client, name: string, args: Record<string, unknown>) {
  const res = await call(client, name, args);
  expect(res.isError, textOf(res)).toBeFalsy();
  return res;
}

/** The MCP planner's step report. */
const mcpStep = (
  client: Client,
  planId: string,
  sessionKey: string,
  step: 'settle' | 'lay' | 'author' | 'end',
  target?: string,
) => call(client, REPORT_PLAN_STEP_TOOL_NAME, { planId, sessionKey, step, target });

/** The hosted planner's step report — the internal route with its two credentials. */
function hostedStep(fx: WorkItemFixture, body: Record<string, unknown>): Promise<Response> {
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

// ── Plans, opened the way each planner opens one ─────────────────────────────

/** An MCP-authored plan (`create_plan`), with `adds` appended through the tool. */
async function mcpPlan(
  client: Client,
  fx: WorkItemFixture,
  adds: Record<string, unknown>[],
  title = 'Written over MCP',
): Promise<{ planId: string; addIds: string[] }> {
  const created = await ok(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title,
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;
  if (adds.length === 0) return { planId, addIds: [] };
  const addIds = await appendOverMcp(client, planId, adds);
  return { planId, addIds };
}

async function appendOverMcp(
  client: Client,
  planId: string,
  proposals: Record<string, unknown>[],
): Promise<string[]> {
  const appended = await ok(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals });
  return (appended.structuredContent as unknown as { planItemIds: string[] }).planItemIds;
}

/** A NATIVE plan bound to a generation job — what the hosted walk writes into. */
async function hostedPlan(
  fx: WorkItemFixture,
  jobId: string,
  titles: string[],
  createdById: string | null = fx.ownerId,
): Promise<{ planId: string; addIds: string[] }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { sourceJobId: jobId, title: `Hosted ${jobId}`, createdById: createdById ?? undefined },
    fx.ctx,
  );
  if (titles.length === 0) return { planId: plan.id, addIds: [] };
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

const add = (title: string, extra: Record<string, unknown> = {}) => ({
  op: 'add',
  proposedFields: { title, kind: 'task', ...extra },
});

/** Every leaf-sizing field, and both bodies an MCP plan owes. */
const SIZED = {
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 3,
  estimateMinutes: 30,
  difficulty: 'medium',
} as const;
const BODIES = { descriptionMd: 'What to do.', explanationMd: 'Why it matters.' } as const;

// ── The two reads ────────────────────────────────────────────────────────────

function signIn(user: { id: string }, workspaceId: string): void {
  session.current = { user: { id: user.id, email: `${user.id}@example.com`, name: 'Reader' } };
  wsCtx.current = { userId: user.id, workspaceId };
}

/** `GET /api/plans/[id]` — the plan surface's one poll — as `user`. */
async function reviewRead(
  fx: WorkItemFixture,
  planId: string,
  user: { id: string } = { id: fx.ownerId },
): Promise<PlanReviewDto> {
  signIn(user, fx.workspaceId);
  const res = await planRoute(new Request(`http://localhost/api/plans/${planId}`), {
    params: Promise.resolve({ id: planId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PlanReviewDto;
}

/** `GET /api/workbench/planning` — the Planning tab's read — as `user`. */
async function tabRead(
  fx: WorkItemFixture,
  user: { id: string } = { id: fx.ownerId },
): Promise<WorkbenchPlanningPageDto> {
  signIn(user, fx.workspaceId);
  const res = await planningRoute(new Request('http://localhost/api/workbench/planning'));
  expect(res.status).toBe(200);
  return (await res.json()) as WorkbenchPlanningPageDto;
}

async function tabProgress(
  fx: WorkItemFixture,
  planId: string,
  user: { id: string } = { id: fx.ownerId },
): Promise<PlanProgressSnapshot> {
  const page = await tabRead(fx, user);
  const row = page.items.find((r) => r.planId === planId);
  expect(row, `plan ${planId} is not on the reader's Planning tab`).toBeDefined();
  return row!.progress;
}

/** A snapshot read at its OWN server instant — the reading a client shows first. */
const readAtObserved = (s: PlanProgressSnapshot): PlanProgressReading =>
  readPlanProgress(s, Date.parse(s.observedAt));

/** The two reads of one plan, each read at its own observed instant. */
async function bothReadings(fx: WorkItemFixture, planId: string) {
  const review = await reviewRead(fx, planId);
  const tab = await tabProgress(fx, planId);
  expect(review.progress).toBeTruthy();
  return {
    review,
    reviewProgress: review.progress!,
    tab,
    onReview: readAtObserved(review.progress!),
    onTab: readAtObserved(tab),
  };
}

const withoutObservedAt = ({ observedAt: _o, ...rest }: PlanProgressSnapshot) => rest;
const sessionsOf = (steps: readonly { sessionKey: string }[]) =>
  steps.map((s) => s.sessionKey).sort();

/**
 * Push a plan, and every step on it, `byMs` into the past — the server clock's.
 * The plan's proposals and their edits go back with it: a step is quiet only when
 * nothing under its target was written either (MOTIR-11184), and a fixture whose
 * cards were appended a moment ago would otherwise keep a "dead" step alive.
 */
async function backdate(planId: string, byMs: number, sessionKeys?: string[]): Promise<void> {
  const at = new Date(Date.now() - byMs);
  if (!sessionKeys) {
    await adminDb.plan.update({ where: { id: planId }, data: { lastActivityAt: at } });
  }
  await adminDb.planItem.updateMany({ where: { planId }, data: { createdAt: at } });
  await adminDb.planRevision.updateMany({ where: { planId }, data: { changedAt: at } });
  await adminDb.planStep.updateMany({
    where: { planId, ...(sessionKeys ? { sessionKey: { in: sessionKeys } } : {}) },
    data: { startedAt: at },
  });
}

const PAST_STALL = PLAN_STALLED_AFTER_MS + 60_000;

// ─────────────────────────────────────────────────────────────────────────────
describe('A. both doors reach the one poll', () => {
  it('A1 — MCP door: an `author` step on an add comes back titled and placed on the review node', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPA' });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await mcpPlan(client, fx, [add('The picker'), add('The panel')]);

    const res = await mcpStep(client, planId, 'author-1', 'author', `planItem:${addIds[0]}`);
    expect(res.isError, textOf(res)).toBeFalsy();

    const review = await reviewRead(fx, planId);
    expect(review.inFlightSteps).toEqual([
      expect.objectContaining({
        sessionKey: 'author-1',
        kind: 'author',
        targetRef: `planItem:${addIds[0]}`,
      }),
    ]);
    const node = review.items.find((i) => i.planItemId === addIds[0])!;
    const step = review.progress!.steps[0]!;
    expect(step).toMatchObject({
      sessionKey: 'author-1',
      phrase: 'authoring',
      targetTitle: 'The picker',
      targetNodeId: node.nodeId,
    });
    // The stored instant is the one both halves carry.
    expect(step.startedAt).toBe(review.inFlightSteps![0]!.startedAt);
    expect(readAtObserved(review.progress!).state).toBe('working');
  });

  it('A2 — hosted door: a `lay` on a committed parent comes back titled with that work item', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPB' });
    const parent = await createTestWorkItem(fx, { title: 'Billing epic', kind: 'epic' });
    const jobId = 'job_progress_a2';
    const { planId } = await hostedPlan(fx, jobId, ['First child']);

    const res = await hostedStep(fx, {
      jobId,
      sessionKey: 'lay-1',
      step: 'lay',
      target: parent.id,
    });
    expect(res.status).toBe(200);

    const review = await reviewRead(fx, planId);
    expect(review.inFlightSteps).toEqual([
      expect.objectContaining({ sessionKey: 'lay-1', kind: 'lay', targetRef: parent.id }),
    ]);
    expect(review.progress!.steps).toEqual([
      expect.objectContaining({
        sessionKey: 'lay-1',
        phrase: 'layingChildrenOf',
        targetTitle: 'Billing epic',
        targetNodeId: parent.id,
      }),
    ]);
    expect(readAtObserved(review.progress!).state).toBe('working');
  });

  it('A3 — three sessions report in ONE Promise.all, over both doors, and all three are live', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPC' });
    const client = await connectClient(fx.ctx);
    const jobId = 'job_progress_a3';
    // One hosted plan both doors may reach: the MCP door addresses it by id, the
    // route by the job that owns it.
    const { planId, addIds } = await hostedPlan(fx, jobId, ['One', 'Two', 'Three']);

    // ⚠️ NO AWAIT BETWEEN THEM — the shape parallel authoring produces.
    const [first, second, routed] = await Promise.all([
      mcpStep(client, planId, 'author-a', 'author', `planItem:${addIds[0]}`),
      mcpStep(client, planId, 'author-b', 'author', `planItem:${addIds[1]}`),
      hostedStep(fx, {
        jobId,
        sessionKey: 'author-c',
        step: 'author',
        target: `planItem:${addIds[2]}`,
      }),
    ]);
    expect(first.isError, textOf(first)).toBeFalsy();
    expect(second.isError, textOf(second)).toBeFalsy();
    expect(routed.status).toBe(200);

    const { reviewProgress, onReview, onTab } = await bothReadings(fx, planId);
    // Three rows, one per session — whichever order the plan lock admitted them in.
    expect(sessionsOf(reviewProgress.steps)).toEqual(['author-a', 'author-b', 'author-c']);
    // Ordered by `startedAt`, ties by `sessionKey` — the order every legitimate
    // interleaving of the three writes must still produce.
    const order = [...reviewProgress.steps].sort(
      (a, b) =>
        Date.parse(a.startedAt) - Date.parse(b.startedAt) || (a.sessionKey < b.sessionKey ? -1 : 1),
    );
    expect(reviewProgress.steps).toEqual(order);
    expect(new Set(reviewProgress.steps.map((s) => s.targetTitle))).toEqual(
      new Set(['One', 'Two', 'Three']),
    );
    for (const reading of [onReview, onTab]) {
      expect(reading.state).toBe('working');
      expect(sessionsOf(reading.liveSteps)).toEqual(['author-a', 'author-b', 'author-c']);
    }
  });

  it('A4 — a second report REPLACES the session’s step; `end` clears it from both halves', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPD' });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await mcpPlan(client, fx, [add('Alpha'), add('Beta')]);

    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 's1',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 's1',
      step: 'author',
      target: `planItem:${addIds[1]}`,
    });

    let review = await reviewRead(fx, planId);
    expect(review.inFlightSteps).toHaveLength(1);
    expect(review.inFlightSteps![0]).toMatchObject({
      sessionKey: 's1',
      targetRef: `planItem:${addIds[1]}`,
    });
    expect(review.progress!.steps.map((s) => s.targetTitle)).toEqual(['Beta']);

    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, { planId, sessionKey: 's1', step: 'end' });
    review = await reviewRead(fx, planId);
    expect(review.inFlightSteps).toEqual([]);
    expect(review.progress!.steps).toEqual([]);
    expect(readAtObserved(review.progress!).state).toBe('writing');
    expect((await tabProgress(fx, planId)).steps).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. the tab row and the plan surface show the SAME progress', () => {
  /** An MCP plan with 2 of 4 adds authored and two live steps. */
  async function halfAuthored(fx: WorkItemFixture, client: Client) {
    const { planId, addIds } = await mcpPlan(client, fx, [
      add('Authored one', { ...BODIES, ...SIZED }),
      add('Authored two', { ...BODIES, ...SIZED }),
      // Missing only `difficulty`, and its author session has NOT finished it.
      add('Almost', { ...BODIES, ...SIZED, difficulty: undefined }),
      add('Bare'),
    ]);
    // Appended by hand with no session live, every card with a body was stamped
    // written (MOTIR-10490). "Almost" stands for a card whose session did not
    // finish, so its driver's word clears the stamp (MOTIR-10496).
    await ok(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: addIds[2],
      authorFinished: null,
    });
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-almost',
      step: 'author',
      target: `planItem:${addIds[2]}`,
    });
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-bare',
      step: 'author',
      target: `planItem:${addIds[3]}`,
    });
    return { planId, addIds };
  }

  it('B5 — the two derivation entry points agree, field for field, and read alike at one `now`', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPE' });
    const client = await connectClient(fx.ctx);
    const { planId } = await halfAuthored(fx, client);

    const review = await reviewRead(fx, planId);
    const tab = await tabProgress(fx, planId);

    expect(review.progress!.authored).toBe(2);
    expect(review.progress!.proposed).toBe(4);
    expect(review.progress!.steps).toHaveLength(2);
    // ⚠️ THE CRITERION: `snapshotsForPlans` (batched SQL flags) and
    // `snapshotForReview` (the review's in-memory items) — deep-equal but for the
    // instant each was built at.
    expect(withoutObservedAt(tab)).toEqual(withoutObservedAt(review.progress!));

    const now = Math.max(Date.parse(tab.observedAt), Date.parse(review.progress!.observedAt));
    const onTab = readPlanProgress(tab, now);
    const onReview = readPlanProgress(review.progress!, now);
    expect(onTab).toEqual(onReview);
    expect(onTab).toMatchObject({ state: 'working', authored: 2, proposed: 4 });
    expect(onTab.liveSteps).toHaveLength(2);
  });

  it('B6 — a sizing write moves N on neither; the driver’s `authorFinished` moves it on BOTH; a `modify` moves neither', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPF' });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await halfAuthored(fx, client);

    let { onReview, onTab } = await bothReadings(fx, planId);
    expect([onReview.authored, onTab.authored]).toEqual([2, 2]);

    // Filling the last sizing field is not the written state (MOTIR-10496).
    await ok(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: addIds[2],
      difficulty: 'medium',
    });
    ({ onReview, onTab } = await bothReadings(fx, planId));
    expect([onReview.authored, onTab.authored]).toEqual([2, 2]);

    await ok(client, UPDATE_PLAN_ITEM_TOOL_NAME, {
      planId,
      planItemId: addIds[2],
      authorFinished: true,
    });
    ({ onReview, onTab } = await bothReadings(fx, planId));
    expect([onReview.authored, onTab.authored]).toEqual([3, 3]);
    expect([onReview.proposed, onTab.proposed]).toEqual([4, 4]);

    const committed = await createTestWorkItem(fx, { title: 'Already shipped', kind: 'task' });
    await appendOverMcp(client, planId, [
      { op: 'modify', workItemId: committed.id, patch: { title: 'Renamed' } },
    ]);
    ({ onReview, onTab } = await bothReadings(fx, planId));
    expect([onReview.authored, onTab.authored]).toEqual([3, 3]);
    expect([onReview.proposed, onTab.proposed]).toEqual([4, 4]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C. stalled, and recovery', () => {
  async function stalledPlan(fx: WorkItemFixture, client: Client) {
    const { planId, addIds } = await mcpPlan(client, fx, [add('Left behind'), add('Next')]);
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'dead',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await backdate(planId, PAST_STALL);
    return { planId, addIds };
  }

  it('C7 — backdated activity and steps read `stalled`, with nothing live, on both reads', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPG' });
    const client = await connectClient(fx.ctx);
    const { planId } = await stalledPlan(fx, client);

    const { reviewProgress, onReview, onTab } = await bothReadings(fx, planId);
    // The step is still STORED and still resolves — it is the clock that drops it.
    expect(reviewProgress.steps.map((s) => s.sessionKey)).toEqual(['dead']);
    for (const reading of [onReview, onTab]) {
      expect(reading.state).toBe('stalled');
      expect(reading.liveSteps).toEqual([]);
      expect(reading.sinceActivityMs).toBeGreaterThan(PLAN_STALLED_AFTER_MS);
    }
  });

  it('C8 — a signal recovers it with ONLY the new step live; so does a content write with no signal', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPH' });
    const client = await connectClient(fx.ctx);

    // From a signal.
    const signalled = await stalledPlan(fx, client);
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId: signalled.planId,
      sessionKey: 'fresh',
      step: 'author',
      target: `planItem:${signalled.addIds[1]}`,
    });
    let readings = await bothReadings(fx, signalled.planId);
    for (const reading of [readings.onReview, readings.onTab]) {
      expect(reading.state).toBe('working');
      expect(reading.liveSteps.map((s) => s.sessionKey)).toEqual(['fresh']);
    }

    // From a WRITE alone — an append, and no `report_plan_step`.
    const written = await stalledPlan(fx, client);
    expect((await bothReadings(fx, written.planId)).onTab.state).toBe('stalled');
    await appendOverMcp(client, written.planId, [add('Appended after the stall')]);
    readings = await bothReadings(fx, written.planId);
    for (const reading of [readings.onReview, readings.onTab]) {
      expect(reading.state).toBe('writing');
      expect(reading.liveSteps).toEqual([]);
      expect(reading.proposed).toBe(3);
    }
  });

  it('C9 — the quiet drop: one session past the threshold, a sibling reporting now', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPI' });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await mcpPlan(client, fx, [add('Quiet'), add('Busy')]);
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'quiet',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await backdate(planId, PAST_STALL, ['quiet']);
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'busy',
      step: 'author',
      target: `planItem:${addIds[1]}`,
    });

    const { reviewProgress, tab, onReview, onTab } = await bothReadings(fx, planId);
    expect(sessionsOf(reviewProgress.steps)).toEqual(['busy', 'quiet']);
    expect(sessionsOf(tab.steps)).toEqual(['busy', 'quiet']);
    for (const reading of [onReview, onTab]) {
      expect(reading.state).toBe('working');
      expect(reading.liveSteps.map((s) => s.sessionKey)).toEqual(['busy']);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D. the non-happy inputs, on the assembled path', () => {
  it('D10 — a plan that never signals reads `writing`, with its counts and its last write’s time', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPJ' });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await mcpPlan(client, fx, [
      { op: 'add', proposedFields: { title: 'Story with children', kind: 'story', ...BODIES } },
      { op: 'add', proposedFields: { title: 'Story alone', kind: 'story', ...BODIES } },
    ]);
    // Deepen: two children under the first story — one authored, one bare.
    const before = Date.now();
    await appendOverMcp(client, planId, [
      {
        op: 'add',
        parentRef: `planItem:${addIds[0]}`,
        proposedFields: { title: 'Sized child', kind: 'task', ...BODIES, ...SIZED },
      },
      {
        op: 'add',
        parentRef: `planItem:${addIds[0]}`,
        proposedFields: { title: 'Bare child', kind: 'task' },
      },
    ]);
    const after = Date.now();

    const { review, reviewProgress, tab, onReview, onTab } = await bothReadings(fx, planId);
    expect(review.inFlightSteps).toEqual([]);
    expect(reviewProgress.steps).toEqual([]);
    expect(tab.steps).toEqual([]);
    const stored = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    // The LAST write's time: the deepening append's own stamp.
    expect(review.lastActivityAt).toBe(stored.lastActivityAt.toISOString());
    expect(Date.parse(review.lastActivityAt!)).toBeGreaterThanOrEqual(before - 1_000);
    expect(Date.parse(review.lastActivityAt!)).toBeLessThanOrEqual(after + 1_000);
    for (const snapshot of [reviewProgress, tab]) {
      expect(snapshot.lastActivityAt).toBe(review.lastActivityAt);
    }
    for (const reading of [onReview, onTab]) {
      // Both stories carry their bodies and are containers; one child is sized.
      expect(reading).toMatchObject({ state: 'writing', authored: 3, proposed: 4, liveSteps: [] });
    }
  });

  it('D11 — a fresh plan with nothing proposed and no signal reads `starting`', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPK' });
    const client = await connectClient(fx.ctx);
    const { planId } = await mcpPlan(client, fx, []);

    const { onReview, onTab } = await bothReadings(fx, planId);
    for (const reading of [onReview, onTab]) {
      expect(reading).toMatchObject({ state: 'starting', authored: 0, proposed: 0, liveSteps: [] });
    }
  });

  it('D12 — a step on an add that is then WITHDRAWN names nothing on either read', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPL' });
    const client = await connectClient(fx.ctx);
    const { planId, addIds } = await mcpPlan(client, fx, [add('Withdrawn'), add('Kept')]);
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'orphan',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await ok(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, { planId, planItemId: addIds[0] });

    const { review, reviewProgress, tab, onReview, onTab } = await bothReadings(fx, planId);
    // The raw row may outlive its target; the derivation is what must not name it.
    expect(review.inFlightSteps!.every((s) => s.sessionKey === 'orphan')).toBe(true);
    expect(reviewProgress.steps).toEqual([]);
    expect(tab.steps).toEqual([]);
    for (const reading of [onReview, onTab]) {
      expect(reading.liveSteps).toEqual([]);
      expect(reading.proposed).toBe(1);
    }
  });

  it('D13 — off `generating`: both doors refuse with PLAN_NOT_GENERATING, and nothing moves', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPM' });
    const client = await connectClient(fx.ctx);
    const jobId = 'job_progress_d13';
    const { planId, addIds } = await hostedPlan(fx, jobId, ['Proposed already']);
    await ok(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'last',
      step: 'author',
      target: `planItem:${addIds[0]}`,
    });
    await plansService.markPlanned(planId, fx.ctx);
    const before = (await reviewRead(fx, planId)).lastActivityAt;

    const viaTool = await mcpStep(client, planId, 'late', 'author', `planItem:${addIds[0]}`);
    expect(viaTool.isError).toBe(true);
    expect(textOf(viaTool)).toContain('PLAN_NOT_GENERATING');

    const viaRoute = await hostedStep(fx, { jobId, sessionKey: 'late', step: 'settle' });
    expect(viaRoute.status).toBe(409);
    expect(((await viaRoute.json()) as { code: string }).code).toBe('PLAN_NOT_GENERATING');

    const review = await reviewRead(fx, planId);
    expect(review.status).toBe('planned');
    expect(review.inFlightSteps).toEqual([]);
    expect(review.progress).toBeNull();
    expect(review.lastActivityAt).toBe(before);
    expect((await tabRead(fx)).items.map((r) => r.planId)).not.toContain(planId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E. the reader-only tab, and the untouched landing cascade', () => {
  async function enrol(fx: WorkItemFixture, slug: string) {
    const user = await createTestUser({ email: `${slug}-${Date.now()}@example.com`, name: slug });
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });
    return user;
  }

  /** The card's fixture: the reader's two generating plans (one native, one MCP),
   *  and one of every plan the reader's tab must NOT hold. */
  async function readerFixture(opts: { withProposed?: boolean } = {}) {
    const fx = await makeWorkItemFixture({ identifier: 'PPN' });
    const reader = await enrol(fx, 'reader');
    const teammate = await enrol(fx, 'teammate');
    const readerCtx = { userId: reader.id, workspaceId: fx.workspaceId };

    const native = await hostedPlan(fx, 'job_reader_native', ['Native add'], reader.id);
    const readerClient = await connectClient(readerCtx);
    const mcp = await mcpPlan(readerClient, fx, [add('MCP add')], 'Reader over MCP');
    // The reader's PROPOSED plan. Proposing it asks the reader to approve it, so it
    // puts a decision on To approve — which E16 must leave empty, so it opts out.
    const proposed =
      opts.withProposed === false
        ? null
        : await hostedPlan(fx, 'job_reader_planned', ['Planned add'], reader.id);
    if (proposed) await plansService.markPlanned(proposed.planId, fx.ctx);
    const teammates = await hostedPlan(fx, 'job_teammate', ['Teammate add'], teammate.id);
    const cadence = await plansService.createPlan(
      fx.projectId,
      { title: 'Cadence', origin: 'cadence' },
      fx.ctx,
    );
    const hidden = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'HID',
      name: 'Hidden',
    });
    await setProjectAccess(adminDb, hidden.id, 'members');
    const elsewhere = await plansService.createPlan(
      hidden.id,
      { title: 'Elsewhere', createdById: reader.id },
      fx.ctx,
    );
    return {
      fx,
      reader,
      teammate,
      readerCtx: { ...readerCtx, projectId: fx.projectId },
      native: native.planId,
      mcp: mcp.planId,
      proposed: proposed?.planId ?? null,
      teammates: teammates.planId,
      cadence: cadence.id,
      elsewhere: elsewhere.id,
    };
  }

  it('E14 — the tab holds exactly the reader’s two, its total is the badge, and a teammate sees theirs', async () => {
    const f = await readerFixture();
    const stored = await adminDb.plan.findMany({ select: { id: true, status: true } });
    expect(stored).toHaveLength(6); // every decoy really exists

    const page = await tabRead(f.fx, f.reader);
    expect(page.items.map((r) => r.planId).sort()).toEqual([f.native, f.mcp].sort());
    expect(page.total).toBe(2);
    expect(page.total).toBe((await homeService.tabCounts(f.readerCtx)).planning);
    for (const row of page.items) expect(row.progress.proposed).toBe(1);

    const theirs = await tabRead(f.fx, f.teammate);
    expect(theirs.items.map((r) => r.planId)).toEqual([f.teammates]);
    expect(theirs.total).toBe(
      (
        await homeService.tabCounts({
          userId: f.teammate.id,
          workspaceId: f.fx.workspaceId,
          projectId: f.fx.projectId,
        })
      ).planning,
    );
  });

  it('E15 — a plan leaves the tab and the badge together, whether proposed or discarded', async () => {
    const f = await readerFixture();
    const counted = async () => ({
      tab: (await tabRead(f.fx, f.reader)).total,
      badge: (await homeService.tabCounts(f.readerCtx)).planning,
    });
    expect(await counted()).toEqual({ tab: 2, badge: 2 });

    await plansService.markPlanned(f.native, f.fx.ctx);
    expect(await counted()).toEqual({ tab: 1, badge: 1 });
    expect((await tabRead(f.fx, f.reader)).items.map((r) => r.planId)).toEqual([f.mcp]);

    await plansService.declinePlan(f.mcp, f.fx.ctx);
    expect(await counted()).toEqual({ tab: 0, badge: 0 });
  });

  it('E16 — `planning` > 0 never moves the landing, and never lands on Planning', async () => {
    const f = await readerFixture({ withProposed: false });
    const counts = await homeService.tabCounts(f.readerCtx);
    expect(counts.planning).toBe(2);
    expect([counts.approvals, counts.toFix, counts.toResume, counts.inProgress]).toEqual([
      0, 0, 0, 0,
    ]);

    // The counts `tabCounts` produced, as the page hands them over — `planning`
    // rides along, and `LandingCounts` (a `Pick`) is what keeps it out of the rungs.
    const withPlanning: HomeTabCountsDto = counts;
    const withoutPlanning: HomeTabCountsDto = { ...counts, planning: 0 };
    const landed = resolveWorkbenchLanding(withPlanning);
    expect(landed).toBe(resolveWorkbenchLanding(withoutPlanning));
    expect(landed).not.toBe('planning');
    expect(landed).toBe('todo');
  });

  it('E17 — a PAT carrying only CLI_TOKEN_GRANT is refused by the MCP door before any write', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPO' });
    const owner = await connectClient(fx.ctx);
    const { planId, addIds } = await mcpPlan(owner, fx, [add('Guarded')]);
    const before = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });

    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'motir run (plan-progress gate)',
      fixedGrant: [...CLI_TOKEN_GRANT],
    });
    const info = await verifyMcpToken(new Request('http://localhost/api/mcp'), token);
    const extra = { authInfo: info } as Parameters<typeof contextFromExtra>[0];
    const run = await connectClient(contextFromExtra(extra), () => grantFromExtra(extra));

    const refused = await mcpStep(run, planId, 'run-session', 'author', `planItem:${addIds[0]}`);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(PERMISSION_NOT_GRANTED_CODE);

    expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
    const after = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(after.lastActivityAt.toISOString()).toBe(before.lastActivityAt.toISOString());
    expect((await reviewRead(fx, planId)).inFlightSteps).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ARMS THE CASES ABOVE DO NOT REACH, on files this lane GATES (MOTIR-7832 F).
// Each is a real input a real caller can produce; none is a mock of the path.
describe('F. the gated files’ remaining arms', () => {
  it('the tab read answers 400 for a reader with no project they may enter', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPP' });
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
    const res = await planningRoute(new Request('http://localhost/api/workbench/planning'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('NO_ACTIVE_PROJECT');
  });

  it('a LEGACY plan with no session reads on the tab with no targets', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPQ' });
    const { planId } = await hostedPlan(fx, 'job_legacy', ['Pre-session']);
    // A plan from before every plan carried a session (AMENDMENT 17) — the column
    // is still nullable, so the row is a real shape the read must survive.
    await adminDb.plan.update({ where: { id: planId }, data: { sessionId: null } });

    const page = await tabRead(fx);
    expect(page.items).toEqual([expect.objectContaining({ planId, sessionId: null, targets: [] })]);
  });

  it('a row the snapshot read builds no progress for is dropped, not half-drawn', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPR' });
    const { planId: leaving } = await hostedPlan(fx, 'job_leaving', ['Leaving']);
    const { planId: staying } = await hostedPlan(fx, 'job_staying', ['Staying']);

    // ⚠️ THE ONE COLLABORATOR SPY IN THIS FILE, and why it is needed at all.
    // `listMyPlansBeingWritten` drops a row `snapshotsForPlans` built no snapshot
    // for, and its doc comment names the case as a plan that stopped generating
    // between the two reads. But the snapshot read filters on the status the
    // WINDOW read handed it — always `generating` — so with today's code no
    // interleaving reaches that arm (MOTIR-7832 reports it). What IS a contract
    // is the drop itself: `snapshotsForPlans` builds "none for any other status",
    // and a row without progress must not be drawn. So the spy proposes `leaving`
    // after the window read and hands the REAL snapshot read the statuses as they
    // now stand; the snapshot read, the rows and the drop are all real.
    const real = planProgressService.snapshotsForPlans.bind(planProgressService);
    const spy = vi
      .spyOn(planProgressService, 'snapshotsForPlans')
      .mockImplementationOnce(async (plans, ctx) => {
        await plansService.markPlanned(leaving, fx.ctx);
        const fresh = await adminDb.plan.findMany({
          where: { id: { in: plans.map((p) => p.id) } },
          select: { id: true, status: true },
        });
        const statusOf = new Map(fresh.map((p) => [p.id, p.status]));
        return real(
          plans.map((p) => ({ ...p, status: statusOf.get(p.id) ?? p.status })),
          ctx,
        );
      });
    try {
      const page = await workbenchPlanningService.listMyPlansBeingWritten({
        ...fx.ctx,
        projectId: fx.projectId,
      });
      expect(page.items.map((r) => r.planId)).toEqual([staying]);
      // `total` is the count read WITH the window; the next poll re-reads it.
      expect(page.total).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('the batched step read answers an empty page with no query', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPS' });
    const steps = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planStepRepository.listByPlanIds([], tx),
    );
    expect(steps).toEqual([]);
  });

  it('the hosted door refuses a job credential whose user lost the project, through the AI gate', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPU' });
    const jobId = 'job_progress_lost_access';
    const { planId } = await hostedPlan(fx, jobId, ['Guarded']);
    // The job was started by somebody who can no longer see the project — a
    // workspace member, on a project that has since gone members-only.
    const leaver = await createTestUser({ email: `leaver-${Date.now()}@example.com`, name: 'x' });
    await workspacesService.addMember({
      userId: leaver.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });
    await setProjectAccess(adminDb, fx.projectId, 'members');

    const token = mintJobToken({
      userId: leaver.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const res = await stepPOST(
      new Request('http://core/api/internal/ai/plan-step', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': token,
        },
        body: JSON.stringify({ jobId, sessionKey: 's', step: 'settle' }),
      }),
    );
    // The plan gate's no-existence-leak answer, never a 500 the walk cannot match.
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PROJECT_NOT_FOUND');
    expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
  });

  it('the hosted door answers a JSON `null` body as a 400, never a 500', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PPT' });
    const token = mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    });
    const res = await stepPOST(
      new Request('http://core/api/internal/ai/plan-step', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': token,
        },
        body: 'null',
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_STEP_INVALID');
  });
});
