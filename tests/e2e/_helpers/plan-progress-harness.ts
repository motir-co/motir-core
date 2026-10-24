import { writeFileSync } from 'node:fs';
import type { Browser, Locator, Page, Route } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, FIRST_PAINT_MS } from './acceptance-video';
import { adminDb } from './db-reset';
import { signIn } from './shell-session';
import { latestPlanningSession } from './planChangeConversation';
import { PLAN_PROGRESS_PASSWORD, type PlanProgressSeed } from './plan-progress-seed';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { workbenchTabHref } from '@/lib/workbench/tab';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { WorkbenchPlanningPageDto } from '@/lib/dto/home';
import type { PlanStepKindDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';

// The plan-progress HARNESS (MOTIR-8419) — the door-driving, poll-waiting,
// geometry and motion-recorder plumbing two acceptance specs share:
// `regression-plan-progress.spec.ts` (MOTIR-7820's receipt, where every helper
// here was written) and `regression-plan-at-work.spec.ts` (MOTIR-8413's). It was
// EXTRACTED, not rewritten: each helper is the receipt's own, moved here so the
// door-driving and poll-waiting logic keeps one implementation. What each one
// does, and why the hosted step is a service call rather than an HTTP call, is
// written in the receipt's header, which stays the reference.
//
// ONE MEASUREMENT CHANGED, and why. `boxes()` used to read each card's
// transformed rectangle. Since MOTIR-8416 a card Motir is writing GROWS about its
// centre (CSS `scale`, 1 → 1.04; design `design/ai-chat/design-notes.md`
// § _Motir at work_), so its rectangle breathes while its place on the canvas
// does not move — the design's own promise is that the growth "leaves `left`/`top`
// and the edges where they are". So a box is now its rectangle's CENTRE (which a
// growth about the centre leaves fixed, and a pan, a re-fit or a re-layout moves)
// and its LAYOUT size (`offsetWidth` / `offsetHeight`, which no transform
// changes). "Nothing moved" means exactly what it meant before; it just no longer
// mistakes a breath for a move.

export const planReview = en.planReview;
export const progress = en.planReview.progress;
export const workbench = en.workbench;
export const planning = en.workbench.planning;
export const arrival = en.planningWorkspace.arrival;
export const planRowCopy = en.approvalGate.planApproval.row;

// ── Copy helpers — the catalogue's own templates, filled ─────────────────────

/** Fill a `{name}` template from the catalogue. */
export const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
/** A rich message's text: its `<tag>…</tag>` markup removed, the chunks kept.
 *  Stripped to a fixed point, so no tag can be re-formed by the removal of
 *  another (the input is our own catalogue, but the loop costs nothing). */
export const textOf = (template: string): string => {
  let text = template;
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<\/?\w+>/g, '');
  }
  return text;
};
/** A template as a pattern — each `{placeholder}` matches any value. */
export const patternOf = (template: string, placeholder = '.+?'): string =>
  escapeRegExp(template).replace(/\\\{\w+\\\}/g, placeholder);
export const anyOf = (...templates: string[]): RegExp =>
  new RegExp(templates.map((t) => patternOf(t, '\\d+')).join('|'));

export const authoring = (title: string) => fill(progress.authoring, { title });
export const authored = (n: number, m: number) =>
  fill(progress.authored, { authored: n, proposed: m });
/** The design's elapsed formats (§26.4): `<1 min` · `{m} min` · `{h} h {m} min`. */
export const ELAPSED = anyOf(
  progress.elapsedUnderMinute,
  progress.elapsedMinutes,
  progress.elapsedHours,
);
/** The design's last-activity formats (§26.4). */
export const LAST_ACTIVITY = new RegExp(
  [progress.lastActivityJustNow, progress.lastActivitySeconds, progress.lastActivityAgo]
    .map((t) => patternOf(t))
    .join('|'),
);
export const STALLED_FOR = new RegExp(patternOf(progress.stalledFor));
/** The tab's text: its label, then its count chip (absent while every count is 0). */
export const tabText = (count: number, chipMayBeAbsent = false): RegExp =>
  new RegExp(
    `^${escapeRegExp(workbench.tabs.planning)}\\s*${chipMayBeAbsent ? `(?:${count})?` : count}$`,
  );

// ── Locators — every one scoped to a role-resolved subtree ───────────────────

export const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
export const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
export const composer = (page: Page) => rail(page).getByRole('textbox');
export const entrance = (page: Page) =>
  page.getByRole('main').getByTestId('work-item-plan-entrance');
export const views = (page: Page) => workspace(page).getByTestId('plan-proposal-views');
export const liveState = (page: Page) => workspace(page).getByTestId('plan-live-state');
export const paneProgress = (page: Page) => workspace(page).getByTestId('plan-progress');
export const paneSteps = (page: Page) => paneProgress(page).getByTestId('plan-progress-steps');
export const viewButton = (page: Page, name: string) =>
  workspace(page)
    .getByRole('group', { name: planReview.viewSwitchAria })
    .getByRole('button', { name, exact: true });
export const nodeLayer = (page: Page) => workspace(page).getByTestId('canvas-world');
export const node = (page: Page, title: string) =>
  nodeLayer(page).locator('[data-node-id]').filter({ hasText: title });
export const cuedNodes = (page: Page) => nodeLayer(page).locator('[data-node-id][data-cue]');
export const arrivals = (page: Page) => workspace(page).getByTestId('canvas-arrivals-offer');
export const canvasBack = (page: Page) =>
  workspace(page).getByRole('button', { name: en.roadmap.canvas.back, exact: true });
export const closeWorkspace = (page: Page) =>
  workspace(page).getByRole('button', { name: en.planningWorkspace.close });

export const tabStrip = (page: Page) =>
  page.getByRole('navigation', { name: workbench.tabs.label });
export const planningTab = (page: Page) => tabStrip(page).getByTestId('workbench-tab-planning');
export const planningTable = (page: Page) =>
  page.getByRole('table', { name: workbench.tabs.planning });
export const planRow = (page: Page, text: string) =>
  planningTable(page).getByRole('row').filter({ hasText: text });
/** The row's door — named by `workbench.planning.rowAria`, whose sentence varies. */
export const rowDoor = (row: Locator) =>
  row.getByRole('link', { name: planning.rowAria.split('{sentence}')[0]! });
export const compact = (row: Locator) => row.getByTestId('plan-progress-compact');
export const compactSteps = (row: Locator) => compact(row).getByTestId('plan-progress-steps');
export const emptyState = (page: Page) => page.getByRole('main').getByTestId('planning-empty');

/** The Planning tab's address, and the query key every tab is spelled with —
 *  both read from `lib/workbench/tab.ts`, the one home of that spelling. */
export const PLANNING_HREF = workbenchTabHref('planning');
export const TAB_PARAM = [
  ...new URL(PLANNING_HREF, 'http://workbench.local').searchParams.keys(),
][0]!;
export const tabOf = (url: string | URL) => new URL(url).searchParams.get(TAB_PARAM);

export const overlayOpen = (url: URL) =>
  url.searchParams.has('planSession') || url.searchParams.has('plan');

// ── The motion record (the live-drawing spec's recorder) ─────────────────────

export interface MotionEvent {
  layer: 'node' | 'edge';
  motion: string;
  text: string;
}

/**
 * Record every `data-motion` mark the canvas puts on a node or an arrow — at
 * insertion and on attribute change, because a mark lives for one play and is
 * RECORDED rather than polled for.
 */
export const MOTION_RECORDER = () => {
  const w = window as unknown as { __motion: MotionEvent[] };
  w.__motion = [];
  const note = (el: Element) => {
    const motion = el.getAttribute('data-motion');
    if (!motion) return;
    const layer = el.hasAttribute('data-node-id') ? 'node' : el.tagName === 'path' ? 'edge' : null;
    if (!layer) return;
    w.__motion.push({ layer, motion, text: (el.textContent ?? '').slice(0, 200) });
  };
  const scan = (root: Node) => {
    if (!(root instanceof Element)) return;
    note(root);
    root.querySelectorAll('[data-motion]').forEach(note);
  };
  const start = () =>
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') note(r.target as Element);
        else r.addedNodes.forEach(scan);
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-motion'],
    });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
};

export const motionLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motion?: MotionEvent[] }).__motion ?? []);

export const marked = async (page: Page, motion: string | null, text: string) =>
  (await motionLog(page)).filter(
    (e) => e.layer === 'node' && (motion === null || e.motion === motion) && e.text.includes(text),
  ).length;

// ── The authoritative signals ────────────────────────────────────────────────

export type Steps = NonNullable<PlanReviewDto['inFlightSteps']>;
export const ref = (planItemId: string) => `planItem:${planItemId}`;
export const hasStep = (steps: Steps | undefined, sessionKey: string, targetRef: string | null) =>
  (steps ?? []).some((s) => s.sessionKey === sessionKey && s.targetRef === targetRef);

/**
 * The NEXT `GET /api/plans/[id]` response whose body satisfies `until` — the
 * live pane's own poll, never intercepted. Arm it BEFORE the door call.
 */
export function planPolled(
  page: Page,
  planId: string,
  until: (body: PlanReviewDto) => boolean,
): Promise<unknown> {
  return page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'GET' || !r.ok()) return false;
      if (new URL(r.url()).pathname !== `/api/plans/${planId}`) return false;
      try {
        return until((await r.json()) as PlanReviewDto);
      } catch {
        return false;
      }
    },
    { timeout: 8 * POLL_MS },
  );
}

/** The Planning tab's poll cadence is `PLANNING_POLL_MS` (10 s, in a client
 *  component the runner does not load, so this is a copy that can drift). Six of
 *  them is the budget for the next read: on a loaded CI shard one slow
 *  `/api/workbench/window` read, or a tick that lands before the write the
 *  predicate waits for, costs a poll or two, and three left no room for that
 *  (MOTIR-8898). The spec's own timeout is 420 s, so the budget is cheap. */
const WORKBENCH_POLL_MS = 10_000;
export const WORKBENCH_READ_BUDGET_MS = 6 * WORKBENCH_POLL_MS;

/**
 * The NEXT Planning read whose page satisfies `until`. The tab's poll asks the
 * Workbench's one read, `GET /api/workbench/window?tab=planning`, whose window
 * carries the page (Story MOTIR-8539 · MOTIR-8581).
 */
export function workbenchPolled(
  page: Page,
  until: (body: WorkbenchPlanningPageDto) => boolean,
): Promise<unknown> {
  return page.waitForResponse(
    async (r) => {
      if (r.request().method() !== 'GET' || !r.ok()) return false;
      const url = new URL(r.url());
      if (url.pathname !== '/api/workbench/window') return false;
      if (url.searchParams.get('tab') !== 'planning') return false;
      try {
        const body = (await r.json()) as {
          window: { kind: string; page?: WorkbenchPlanningPageDto };
        };
        if (body.window.kind !== 'planning' || !body.window.page) return false;
        return until(body.window.page);
      } catch {
        return false;
      }
    },
    { timeout: WORKBENCH_READ_BUDGET_MS },
  );
}

export const rowOf = (body: WorkbenchPlanningPageDto, planId: string) =>
  body.items.find((r) => r.planId === planId);

// ── The hosted planner — the internal route's own service method ─────────────

export interface HostedRun {
  planId: string;
  jobId: string;
  /** What `authenticateJobRequest` resolves a hosted job's token to. */
  auth: { ctx: ServiceContext; projectId: string };
}

export async function hostedRunOf(planId: string, asker: ServiceContext): Promise<HostedRun> {
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  expect(plan.sourceJobId, 'the hosted plan carries its job').not.toBeNull();
  return {
    planId,
    jobId: plan.sourceJobId!,
    auth: {
      ctx: { userId: asker.userId, workspaceId: plan.workspaceId },
      projectId: plan.projectId,
    },
  };
}

/** One step through `POST /api/internal/ai/plan-step`'s service method. */
export async function hostedStep(
  run: HostedRun,
  sessionKey: string,
  step: PlanStepKindDto | 'end',
  targetRef: string | null = null,
): Promise<void> {
  await aiGenerationService.recordPlanStepForJob(
    { jobId: run.jobId, planId: run.planId, sessionKey, step, targetRef },
    run.auth,
  );
}

export const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

export function resetJobsFixture(): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], submitted: [] }, null, 2));
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
 * Hold the hosted run's job stream OPEN until `release()` — the run is writing.
 * Exactly the live-drawing spec's seam: the anchored door runs for real, but in
 * this lane its job settles at once, and a settled run stops watching its plan.
 */
export async function holdRunStream(page: Page): Promise<{ release: () => void }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/work-items/*/ai/plan/*/stream', async (route: Route) => {
    await released;
    await route
      .fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: done\ndata: {}\n\n',
      })
      .catch(() => {
        /* the page moved on — nothing is waiting for this stream any more */
      });
  });
  return { release };
}

export async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL((url) => url.searchParams.has('plan'));
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Ask from the CARD; the door's 200 is "the session holds this turn and its
 *  plan is open". Returns that `generating` plan's id. */
export async function askFromCard(page: Page, email: string, text: string): Promise<string> {
  const answered = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await composer(page).press('Enter');
  expect((await answered).status()).toBe(200);
  const session = await latestPlanningSession(email);
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
  });
  expect(plan.status).toBe('generating');
  return plan.id;
}

/** The pane is drawn on the CANVAS. The canvas itself, not its node layer:
 *  `canvas-world` is a 0×0 transformed origin that never reads as visible. */
export async function showCanvas(page: Page): Promise<void> {
  await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await viewButton(page, planReview.viewCanvas).click();
  await expect(workspace(page).getByTestId('planning-canvas')).toBeVisible();
}

// ── The MCP planner — the real SDK over the lane's `/api/mcp` ────────────────

export async function tool<T>(
  agent: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const r = (await agent.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name} refused: ${JSON.stringify(r.content)}`);
  return r.structuredContent as unknown as T;
}

export async function mcpCreatePlan(
  agent: Client,
  seed: PlanProgressSeed,
  title: string,
  author: { harness?: string; model?: string } = {},
): Promise<string> {
  const created = await tool<{ id: string }>(agent, CREATE_PLAN_TOOL_NAME, {
    projectKey: seed.projectKey,
    title,
    summary: title,
    ...(author.harness ? { plannedWithHarness: author.harness } : {}),
    ...(author.model ? { plannedWithModel: author.model } : {}),
  });
  return created.id;
}

export async function mcpAdd(
  agent: Client,
  planId: string,
  titles: readonly string[],
  parentRef: string,
): Promise<string[]> {
  const r = await tool<{ planItemIds: string[] }>(agent, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: titles.map((title) => ({
      op: 'add',
      proposedFields: { title, kind: 'subtask' },
      parentRef,
    })),
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

/** A LEAF's authored fields — description, explanation and the five sizing
 *  fields, so it passes the progress derivation's authored test. */
export const AUTHORED_LEAF = {
  descriptionMd: 'What to build, and the boundary it stops at.',
  explanationMd: 'Why it matters to the person following the plan.',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 3,
  estimateMinutes: 30,
  difficulty: 'medium',
} as const;

// ── Workbench › Planning ─────────────────────────────────────────────────────

/** Land on the tab — its server render IS the Workbench read for a navigation. */
export async function openPlanningTab(page: Page): Promise<void> {
  await page.goto(PLANNING_HREF);
  await expect(planningTab(page)).toHaveAttribute('aria-current', 'page', {
    timeout: FIRST_PAINT_MS,
  });
}

/** Press the row's door; the plan opens over the tab, where it is being written. */
export async function openRow(page: Page, row: Locator): Promise<void> {
  await rowDoor(row).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

// ── Geometry — the "nothing moved" measure ───────────────────────────────────

/** Each card's place: its rectangle's centre and its layout size (see the header). */
export async function boxes(
  page: Page,
  titles: readonly string[],
): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  for (const title of titles) {
    const b = await node(page, title).boundingBox();
    expect(b, `${title} has a box`).not.toBeNull();
    const [w, h] = await node(page, title).evaluate((el) => [
      (el as HTMLElement).offsetWidth,
      (el as HTMLElement).offsetHeight,
    ]);
    out[title] = [b!.x + b!.width / 2, b!.y + b!.height / 2, w!, h!];
  }
  return out;
}

export function expectSameBoxes(before: Record<string, number[]>, after: Record<string, number[]>) {
  for (const [title, box] of Object.entries(before)) {
    const now = after[title]!;
    box.forEach((v, i) => {
      expect(Math.abs(now[i]! - v), `${title} box[${i}] moved`).toBeLessThanOrEqual(1);
    });
  }
}

/** Sign a SECOND person in, in a context of their own (no recording). */
export async function asSecondPerson(browser: Browser, baseURL: string, email: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, email, PLAN_PROGRESS_PASSWORD);
  return { page, close: () => context.close() };
}
