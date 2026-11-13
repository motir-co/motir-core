import { readFileSync, writeFileSync } from 'node:fs';
import type { APIResponse, Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { E2E_CORE_CALLBACK_SECRET } from './log-bug-as-ai';
import type { SseFrameServer } from './sse-frame-server';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import type { PlanStepKindDto } from '@/lib/dto/plans';

// THE TWO PLANNERS' DOORS, played (Story MOTIR-8060 · MOTIR-8068).
//
// The acceptance lane runs no model: its motir-ai is the jobs mock
// (`lib/test-ai-jobs-mock.ts`) and `prompts/plan.py` lives in motir-meta. A spec
// that needs a planner to SAY something plays it at the boundary that planner
// crosses into motir-core, and every Motir door it crosses is the real one:
//
//   · THE HOSTED PLANNER (motir-ai) — `POST /api/internal/ai/plan-step` with the
//     §4a service bearer (`CORE_CALLBACK_SECRET`, set on the lane's webServer
//     from `E2E_CORE_CALLBACK_SECRET`) and the §4b JOB TOKEN motir-core minted
//     into the submit's envelope, which the jobs mock records beside the job id
//     it answered with (`readBackToken`). The route's own
//     `authenticateAndLimitJobRequest` checks both.
//   · PLAN.PY — the real MCP SDK over the lane's `/api/mcp`, with a minted token
//     carrying `ai:view_plan`: `create_plan`, `add_plan_items` and
//     `report_plan_step` (steps AND narration batches).
//
// Also here, moved out of MOTIR-7982's retired `acceptance-plan-call-lines.spec.ts`
// so no spec imports another: the jobs-mock declaration, the `/api/ai/access`
// stub, and the ask from the card's composer that waits for the run's stream to
// reach the frame server.

const JOBS_FIXTURE = (): string => process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** Every plan run settles with a planner reply and QUESTION, so a run that
 *  proposes nothing ends as a conversation waiting on its answer rather than as
 *  an `EMPTY` failure. */
export function declareJobs(message: string, question: string): void {
  writeFileSync(
    JOBS_FIXTURE(),
    JSON.stringify({ ask: [], plan: [{ turn: { message, question } }], submitted: [] }, null, 2),
  );
}

interface RecordedJob {
  kind: string;
  jobId: string;
  readBackToken?: string;
}

/** The job token the mock recorded for the NEWEST plan submit — the token
 *  motir-ai would hold for that job — and its job id. */
export function latestPlanJob(): { jobId: string; token: string } {
  const fixture = JSON.parse(readFileSync(JOBS_FIXTURE(), 'utf8')) as {
    submitted?: RecordedJob[];
  };
  const job = (fixture.submitted ?? []).filter((s) => s.kind === 'plan').at(-1);
  if (!job?.readBackToken) throw new Error('the jobs mock recorded no plan submit with a token');
  return { jobId: job.jobId, token: job.readBackToken };
}

export async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applicable: false,
        organizationId: null,
        organizationName: null,
        canManageBilling: false,
        hasPaidAiPlan: false,
        balance: 0,
        tierName: null,
        tierAllotment: null,
        renewsAt: null,
      }),
    }),
  );
}

/**
 * THE INCREMENTAL-STREAM SEAM (MOTIR-7982): the page's own job-stream request is
 * re-targeted at a runner-local SSE server that holds it open and writes a frame
 * only when the spec says so. The headers are passed explicitly — re-targeting a
 * cookie-carrying request to another origin with Chromium's own header set is
 * refused as `ERR_BLOCKED_BY_CLIENT`.
 */
export async function routeJobStream(page: Page, sse: SseFrameServer): Promise<void> {
  await page.route('**/api/work-items/*/ai/plan/*/stream', (route) => {
    // The job the page subscribed to, so the server writes its frames under that
    // job's id and numbers them per job, as motir-ai does (MOTIR-10880).
    const jobId = /\/ai\/plan\/([^/]+)\/stream$/.exec(new URL(route.request().url()).pathname)?.[1];
    const url = jobId ? `${sse.url}?jobId=${jobId}` : sse.url;
    return route.continue({ url, headers: route.request().headers() });
  });
}

/** Ask from the card's composer and wait for the run's stream to reach the frame
 *  server. The door's 200 is "the session holds this turn and its job is
 *  submitted". */
export async function askFromCard(
  page: Page,
  sse: SseFrameServer,
  composer: ReturnType<Page['getByRole']>,
  text: string,
): Promise<void> {
  const answered = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  const connected = sse.nextConnection();
  await composer.fill(text);
  await composer.press('Enter');
  const res = await answered;
  if (res.status() !== 200) throw new Error(`the plan door answered ${res.status()}`);
  await connected;
}

// ── The hosted planner's door ────────────────────────────────────────────────

export interface HostedJob {
  jobId: string;
  token: string;
}

/** An in-flight card's partial fields (Story MOTIR-11190 · MOTIR-11199): the
 *  `itemDraft` body form the hosted planner streams while an author turn writes. */
export interface HostedItemDraft {
  /** The proposal being written, as `planItem:<id>`. */
  target: string;
  /** Strictly increasing per session; a stale one changes nothing. */
  seq: number;
  title?: string;
  descriptionMd?: string;
  explanationMd?: string;
}

export type HostedStepBody =
  | { step: PlanStepKindDto | 'end'; target?: string }
  | { narration: string[] }
  | { itemDraft: HostedItemDraft };

/** One call to the real `POST /api/internal/ai/plan-step`, as motir-ai makes it. */
export function hostedPlanStep(
  page: Page,
  job: HostedJob,
  sessionKey: string,
  body: HostedStepBody,
): Promise<APIResponse> {
  return page.request.post('/api/internal/ai/plan-step', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': job.token,
    },
    data: { jobId: job.jobId, sessionKey, ...body },
  });
}

/** {@link hostedPlanStep}, required to succeed. */
export async function hostedStep(
  page: Page,
  job: HostedJob,
  sessionKey: string,
  body: HostedStepBody,
): Promise<void> {
  const res = await hostedPlanStep(page, job, sessionKey, body);
  if (res.status() !== 200) {
    throw new Error(`plan-step answered ${res.status()}: ${await res.text()}`);
  }
}

/** The hosted walk's close: one `add` through the real proposals door, `final`. */
export async function hostedClose(page: Page, job: HostedJob, title: string): Promise<void> {
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': job.token,
    },
    data: {
      jobId: job.jobId,
      proposals: [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      final: true,
    },
  });
  if (res.status() !== 200) {
    throw new Error(`plan-proposals answered ${res.status()}: ${await res.text()}`);
  }
}

// ── plan.py's door — the MCP SDK ─────────────────────────────────────────────

/** A tool call's answer: its structured content, or the refusal it carried. */
export async function callTool<T>(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; value: T } | { ok: false; text: string }> {
  const r = (await agent.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) return { ok: false, text: JSON.stringify(r.content) };
  return { ok: true, value: r.structuredContent as unknown as T };
}

async function tool<T>(agent: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await callTool<T>(agent, name, args);
  if (!r.ok) throw new Error(`${name} refused: ${r.text}`);
  return r.value;
}

export async function mcpCreatePlan(
  agent: Client,
  projectKey: string,
  title: string,
): Promise<string> {
  const created = await tool<{ id: string }>(agent, CREATE_PLAN_TOOL_NAME, {
    projectKey,
    title,
    summary: title,
  });
  return created.id;
}

/** Propose leaves under `parentRef`; `final` closes the plan (it goes `planned`). */
export async function mcpAdd(
  agent: Client,
  planId: string,
  titles: readonly string[],
  parentRef: string,
  final = false,
): Promise<string[]> {
  const r = await tool<{ planItemIds: string[] }>(agent, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: titles.map((title) => ({
      op: 'add',
      proposedFields: { title, kind: 'subtask' },
      parentRef,
    })),
    ...(final ? { final: true } : {}),
  });
  return r.planItemIds;
}

export async function mcpStep(
  agent: Client,
  planId: string,
  sessionKey: string,
  step: PlanStepKindDto | 'end',
  target?: string,
): Promise<void> {
  await tool(agent, REPORT_PLAN_STEP_TOOL_NAME, {
    planId,
    sessionKey,
    step,
    ...(target ? { target } : {}),
  });
}

/** plan.py's narration batch through `report_plan_step`, as it is answered. */
export function mcpNarrate(
  agent: Client,
  planId: string,
  sessionKey: string,
  narration: readonly string[],
) {
  return callTool(agent, REPORT_PLAN_STEP_TOOL_NAME, {
    planId,
    sessionKey,
    narration: [...narration],
  });
}

/** {@link mcpNarrate}, required to succeed. */
export async function mcpSay(
  agent: Client,
  planId: string,
  sessionKey: string,
  narration: readonly string[],
): Promise<void> {
  const r = await mcpNarrate(agent, planId, sessionKey, narration);
  if (!r.ok) throw new Error(`report_plan_step narration refused: ${r.text}`);
}

/** The `planItem:<id>` ref a step names a proposal by. */
export const proposalRef = (planItemId: string): string => `planItem:${planItemId}`;
