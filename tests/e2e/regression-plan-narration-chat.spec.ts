import type { Locator, Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createTranslator } from 'next-intl';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { latestPlanningSession } from './_helpers/planChangeConversation';
import { agentSession } from './_helpers/agent-authored-plan-seed';
import {
  addPlanProgressStory,
  makePlanProgressPublic,
  nudgePlan,
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
  type PlanProgressSeed,
} from './_helpers/plan-progress-seed';
import { startSseFrameServer, type SseFrameServer } from './_helpers/sse-frame-server';
import {
  askFromCard,
  declareJobs,
  hostedClose,
  hostedPlanStep,
  hostedStep,
  latestPlanJob,
  mcpAdd,
  mcpCreatePlan,
  mcpNarrate,
  mcpSay,
  mcpStep,
  proposalRef,
  routeJobStream,
  stubAiAccess,
  type HostedJob,
} from './_helpers/plan-narration-doors';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { PLAN_NARRATION_BATCH_MAX, PLAN_NARRATION_READ_WINDOW } from '@/lib/plans/planNarration';
import { WORKBENCH_PATH, workbenchTabHref } from '@/lib/workbench/tab';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanNarrationPageDto, PlanStepKindDto } from '@/lib/dto/plans';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// MOTIR-8068 — the narration E2E + ACCEPTANCE VIDEO for Story MOTIR-8060.
//
// The story's claim, in a real browser: while a plan is written, the chat panel
// shows what the planner says it is doing — in the planner's OWN sentences, one
// group per planner session, each headed by that session's real step (its kind
// and the card it works on) — and NOT the per-tool-call lines MOTIR-7974 drew.
// The sentences are kept: a reader who leaves and comes back, opens the plan
// after it ends, reads it in 中文 or visits a public project as a signed-in
// outsider finds every one, under the same heads. One control folds them all.
//
// ── What is real, and what is PLAYED ────────────────────────────────────────
// This lane runs no model: its motir-ai is the jobs mock
// (`lib/test-ai-jobs-mock.ts`), and `prompts/plan.py` is not in this repository.
// So BOTH planners are played, each at the boundary it crosses into motir-core,
// and every Motir door they cross is the real one
// (`_helpers/plan-narration-doors.ts`):
//   · THE HOSTED PLANNER — the person asks from the card's composer, so the real
//     anchored door `POST /api/work-items/{key}/ai/plan` opens a real `plan` job,
//     session and plan row. The spec then does what motir-ai does: it POSTs to the
//     real `POST /api/internal/ai/plan-step` with the §4a service bearer
//     (`CORE_CALLBACK_SECRET`, which this lane's webServer carries) and that
//     job's §4b job token (the `readBackToken` the jobs mock recorded), checked
//     by the route's own `authenticateAndLimitJobRequest` — an `author` step on
//     the seeded task, then `narration` batches, then `end`.
//   · PLAN.PY — the real MCP SDK against this lane's `/api/mcp`, with a minted
//     token carrying `ai:view_plan` (`agentSession`): `create_plan`,
//     `add_plan_items`, `report_plan_step` (steps AND `narration` batches) and
//     `add_plan_items { final: true }`.
// That the REAL hosted planner sends its model's sentences is MOTIR-8070's gate
// (motir-ai) and the live verification's (MOTIR-8069); that the real plan.py
// forwards only the model's own lines, batched, and nothing under
// `--no-narrate`, is MOTIR-8065 / MOTIR-8067's (motir-meta). This lane claims
// none of it. Door semantics at row level are MOTIR-8066's integration gate.
//
// THE ONE SEAM is MOTIR-7982's: the browser's job-stream request is re-targeted
// with `route.continue({ url })` at a runner-local SSE server
// (`_helpers/sse-frame-server.ts`) that holds the run open — a settled run stops
// watching its plan — and writes `tool_call` frames, the frames motir-ai still
// emits, so the ABSENCE of call lines is asserted while those frames arrive. The
// `/api/ai/access` stub is MOTIR-7982's too. NO READ IS INTERCEPTED: nothing
// routes `/api/plans`, `/api/workbench` or `/api/mcp`, and no door is stubbed.
//
// ⚠️ THE VISITOR IS SIGNED IN. The card says "a signed-out Visitor"; a signed-out
// request for a plan answers 401 (`memberThenVisitor`), and the shipped Visitor
// specs read as a signed-in OUTSIDER through the consent screen. Case 7 does the
// same.
//
// ── How a group head is asserted ────────────────────────────────────────────
// Through ONE helper, `groupOf(scope, head)`, which finds a group by its head's
// step-kind span (`data-kind`) and its stored target title — never by a
// page-wide text search — and `expectHead`, which compares:
//   · the kind word, formatted from `planningWorkspace.conversation.act.*` /
//     `narration.kindSettle` in the reader's locale with next-intl's own
//     `createTranslator`;
//   · the head line — the step words (`act.authoringLine` filled with the title
//     AS STORED, or `narration.settleLine` alone) and, when finished, the
//     design's finished mark (`narration.done`) — EXACTLY. An exact comparison is
//     the negative too: a head reading a generic finished label in place of its
//     step words cannot equal it;
//   · live vs finished: `data-session`, and the finished mark's presence.
// Before a head is asserted, the spec waits on a poll body whose
// `narration.sessions` carries that session with those step words.
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// Before each door call the spec arms a wait for the next `GET /api/plans/[id]`
// (or narration-page) response whose BODY carries the expected sentence on the
// expected session, the session's step words, the step's end, or the status —
// and only then asserts the DOM. Frame-server writes follow the previous
// assertion. Nothing sleeps as a signal; `beat()` and `chapter()`'s holds are
// pacing for a viewer only (`acceptance-video.ts` § Pacing). Every asserted
// label is formatted from `messages/en.json` / `messages/zh.json`; the sentences
// and titles are this spec's own constants and seed values.

const NS = 'planningWorkspace.conversation';
type Tr = (key: string, values?: Record<string, string | number>) => string;
const TR: Record<'en' | 'zh', Tr> = {
  en: createTranslator({ locale: 'en', messages: en, namespace: NS }) as unknown as Tr,
  zh: createTranslator({ locale: 'zh', messages: zh, namespace: NS }) as unknown as Tr,
};
const CLOSE = { en: en.planningWorkspace.close, zh: zh.planningWorkspace.close };

const KIND_KEY: Record<PlanStepKindDto, string> = {
  settle: 'narration.kindSettle',
  lay: 'act.laying',
  author: 'act.authoring',
};

// ── Locators — every one scoped to a role-resolved subtree ───────────────────

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const workspace = (page: Page) => page.getByRole('dialog').filter({ has: rail(page) });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const reviewRail = (page: Page) =>
  page.getByRole('complementary', { name: en.planReview.reviewRailAria });
const narration = (scope: Locator) => scope.getByTestId('plan-narration');
const toggleAll = (scope: Locator) => scope.getByTestId('plan-narration-toggle-all');
const groups = (scope: Locator) => scope.getByTestId('plan-narration-group');
const messages = (group: Locator) => group.getByTestId('plan-narration-message');

interface Head {
  kind: PlanStepKindDto;
  /** The target's title AS STORED; null for a `settle` session. */
  title: string | null;
}

/** THE ONE LOCATOR every attribution and head assertion goes through: the group
 *  whose head names `head`'s step kind and stored title. */
function groupOf(scope: Locator, head: Head): Locator {
  const page = scope.page();
  let group = groups(scope).filter({ has: page.locator(`[data-kind="${head.kind}"]`) });
  if (head.title !== null) {
    group = group.filter({
      has: page
        .getByTestId('plan-narration-head-title')
        .filter({ hasText: new RegExp(`^${escapeRegExp(head.title)}$`) }),
    });
  }
  return group;
}

/** The head's step words in `tr`'s locale, finished mark included when not live. */
function headLine(tr: Tr, head: Head, live: boolean): string {
  const words =
    head.kind === 'settle'
      ? tr('narration.settleLine')
      : head.kind === 'lay'
        ? tr('act.layingLine', { target: head.title! })
        : tr('act.authoringLine', { title: head.title! });
  return live ? words : `${words} ${tr('narration.done')}`;
}

async function expectHead(scope: Locator, tr: Tr, head: Head, live: boolean): Promise<Locator> {
  const group = groupOf(scope, head);
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('data-session', live ? 'live' : 'finished');
  await expect(group.locator('[data-kind]')).toHaveText(tr(KIND_KEY[head.kind]));
  // EXACT — so a generic finished label in place of the step words cannot pass.
  await expect(group.getByTestId('plan-narration-head-line')).toHaveText(headLine(tr, head, live));
  await expect(group.getByTestId('plan-narration-done')).toHaveCount(live ? 0 : 1);
  if (head.title !== null) {
    await expect(group.getByTestId('plan-narration-head-title')).toHaveText(head.title);
  }
  return group;
}

/** The group's sentences, in order, and none of `absent` among them. */
async function expectSaid(
  scope: Locator,
  head: Head,
  said: readonly string[],
  absent: readonly string[] = [],
): Promise<void> {
  const list = messages(groupOf(scope, head));
  await expect(list).toHaveText([...said]);
  for (const text of absent) await expect(list.filter({ hasText: text })).toHaveCount(0);
}

/** No MOTIR-7974 call line, call-count disclosure or earlier-calls row. */
async function expectNoCallLines(scope: Locator): Promise<void> {
  await expect(scope.getByTestId('plan-change-call')).toHaveCount(0);
  await expect(scope.getByTestId('plan-change-calls-toggle')).toHaveCount(0);
  await expect(scope.getByTestId('plan-change-calls-earlier')).toHaveCount(0);
}

// ── The authoritative signals ────────────────────────────────────────────────

type Pred = (body: PlanReviewDto) => boolean;

/** The NEXT `GET /api/plans/[id]` response whose body satisfies `until` — the
 *  surface's own poll, never intercepted. Arm it BEFORE the door call. */
function planPolled(page: Page, planId: string, until: Pred): Promise<unknown> {
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

const said =
  (key: string, ...texts: string[]): Pred =>
  (b) =>
    texts.every((text) =>
      (b.narration?.entries ?? []).some((e) => e.sessionKey === key && e.body === text),
    );
const headed =
  (key: string, head: Head): Pred =>
  (b) =>
    (b.narration?.sessions ?? []).some(
      (s) => s.sessionKey === key && s.stepKind === head.kind && s.targetTitle === head.title,
    );
const stepOpen =
  (key: string): Pred =>
  (b) =>
    (b.inFlightSteps ?? []).some((s) => s.sessionKey === key);
const ended =
  (key: string): Pred =>
  (b) =>
    !stepOpen(key)(b);
const both =
  (...preds: Pred[]): Pred =>
  (b) =>
    preds.every((p) => p(b));
const status =
  (s: PlanReviewDto['status']): Pred =>
  (b) =>
    b.status === s;

// ── Surfaces ─────────────────────────────────────────────────────────────────

/** Open a plan where a member reads it: `/plans/[id]` sends an undecided plan to
 *  the planning overlay (and renders a decided one on the page). */
async function openPlan(page: Page, planId: string, until: Pred | null = null): Promise<void> {
  const first = until ? planPolled(page, planId, until) : null;
  await page.goto(`/plans/${planId}`);
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  if (first) await first;
}

async function closeOverlay(page: Page, locale: 'en' | 'zh' = 'en'): Promise<void> {
  // The button's name carries its `Esc` hint too ("Close Esc").
  await workspace(page)
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(CLOSE[locale])}`) })
    .first()
    .click();
  await expect(workspace(page)).toHaveCount(0);
}

async function setLocale(page: Page, locale: 'en' | 'zh'): Promise<void> {
  await page
    .context()
    .addCookies([{ name: 'NEXT_LOCALE', value: locale, url: new URL('/', page.url()).href }]);
}

/** Workbench › Planning, and the row of the plan titled `title`. */
const PLANNING_HREF = workbenchTabHref('planning');
const planningTable = (page: Page) => page.getByRole('table', { name: en.workbench.tabs.planning });
async function openFromWorkbench(page: Page, planTitle: string): Promise<void> {
  await page.goto(PLANNING_HREF);
  const row = planningTable(page).getByRole('row').filter({ hasText: planTitle });
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await row
    .getByRole('link', { name: en.workbench.planning.rowAria.split('{sentence}')[0]! })
    .click();
  await page.waitForURL((url) => url.pathname !== WORKBENCH_PATH || url.search.includes('plan'));
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

// ── Seeding the two planners ─────────────────────────────────────────────────

interface Hosted {
  planId: string;
  job: HostedJob;
}

/** Ask for a plan from the story's composer; the plan the door opened, and the
 *  job motir-ai would hold for it. Waits for a poll body reading `generating`
 *  — the precondition every hosted sentence rests on. */
async function askHosted(page: Page, sse: SseFrameServer, seed: PlanProgressSeed): Promise<Hosted> {
  await page.goto(`/items/${seed.storyKey}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL((url) => url.searchParams.has('plan'));
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await askFromCard(page, sse, composer(page), ASK);
  const session = await latestPlanningSession(seed.reader.email);
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
  });
  const job = latestPlanJob();
  expect(plan.sourceJobId, 'the hosted plan carries the job the mock answered').toBe(job.jobId);
  await planPolled(page, plan.id, status('generating'));
  return { planId: plan.id, job };
}

let callSeq = 0;
function toolCall(tool: string, family: string, verb: string, value: string) {
  callSeq += 1;
  return {
    callId: `c${callSeq}`,
    tool,
    family,
    verb,
    object: { kind: 'path', value },
    itemRef: null,
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

const ASK = 'Split the session work into cards.';
const REPLY = 'Here is what I looked at.';
const QUESTION = 'Should the session store keep its current cookie name?';
const MCP_PLAN = 'Harden the session lifecycle';
const A = 'Rotate the session cookie on sign-in';
const B = 'Expire idle sessions on the server';
const H1 = 'I am reading how the session store refreshes tokens.';
const H2 = 'The refresh path writes the cookie twice; I will fold that into one card.';
const H3 = 'I have what I need for this card.';
const A1 = 'Looking at where the cookie is issued.';
const B1 = 'Checking how long an idle session lives today.';
const A2 = 'The cookie is set in two places; one card covers both.';
const B2 = 'Idle sessions do not expire on the server today.';
const A3 = 'Writing the acceptance criteria for the rotation.';
const A4 = 'Done with the rotation card.';
const B3 = 'Adding the server-side expiry as its own card.';
const B4 = 'One more check on the timeout default.';

test.describe.configure({ timeout: 600_000 });

let sse: SseFrameServer;
let agent: Client | null = null;

test.beforeEach(async () => {
  await resetDatabase();
  sse = await startSseFrameServer();
  callSeq = 0;
});

test.afterEach(async () => {
  await agent?.close();
  agent = null;
  await sse.close();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT — cases 1–6
// ─────────────────────────────────────────────────────────────────────────────

test('the planner says what it is doing in its own words — per session under its real step, kept after leaving and after the plan ends, folded all at once, in 中文', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8060');
  const t = TR.en;
  declareJobs(REPLY, QUESTION);
  const seed = await seedPlanProgress(`narration-${Date.now()}`);
  // The hosted plan leases the seed's story for its session; plan.py's plan
  // runs beside it and proposes under a story nobody holds.
  const side = await addPlanProgressStory(seed, 'Harden the session store');
  await stubAiAccess(page);
  await routeJobStream(page, sse);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
  agent = await agentSession(seed.token, baseURL!);

  const HOSTED: Head = { kind: 'author', title: seed.taskTitle };
  const HEAD_A: Head = { kind: 'author', title: A };
  const HEAD_B: Head = { kind: 'author', title: B };
  const SETTLE: Head = { kind: 'settle', title: null };
  let hosted!: Hosted;
  let mcpPlanId = '';

  // ── CASE 1 ──────────────────────────────────────────────────────────────
  await chapter(
    'Ask Motir AI for a plan — it says what it is doing, in its own words',
    async () => {
      hosted = await askHosted(page, sse, seed);
      const r = rail(page);

      const stepped = planPolled(page, hosted.planId, both(headed('h1', HOSTED), stepOpen('h1')));
      await hostedStep(page, hosted.job, 'h1', { step: 'author', target: seed.taskId });
      await stepped;
      await expectHead(r, t, HOSTED, true);

      const first = planPolled(page, hosted.planId, said('h1', H1));
      await hostedStep(page, hosted.job, 'h1', { narration: [H1] });
      await first;
      await expectSaid(r, HOSTED, [H1]);
      await beat();

      // motir-ai still emits `tool_call` frames; the rail draws none of them.
      sse.write('tool_call', toolCall('read_file', 'code_read', 'read', 'lib/auth/session.ts'));
      sse.write('tool_call', toolCall('code_search', 'code_graph', 'search', 'refresh token'));
      const second = planPolled(page, hosted.planId, said('h1', H2));
      await hostedStep(page, hosted.job, 'h1', { narration: [H2] });
      await second;
      await expectSaid(r, HOSTED, [H1, H2]);
      await expectHead(r, t, HOSTED, true);
      await expectNoCallLines(r);
      await beat();
    },
  );

  // ── CASE 2 ──────────────────────────────────────────────────────────────
  await chapter('Two plan.py sessions at once — each sentence under its own card', async () => {
    mcpPlanId = await mcpCreatePlan(agent!, seed.projectKey, MCP_PLAN);
    await mcpStep(agent!, mcpPlanId, 'p-settle', 'settle');
    await mcpStep(agent!, mcpPlanId, 'p-settle', 'end');
    const [a, b] = await mcpAdd(agent!, mcpPlanId, [A, B], side.key);
    await mcpStep(agent!, mcpPlanId, 'pA', 'author', proposalRef(a!));
    await mcpStep(agent!, mcpPlanId, 'pB', 'author', proposalRef(b!));

    await closeOverlay(page);
    await openPlan(
      page,
      mcpPlanId,
      both(headed('pA', HEAD_A), headed('pB', HEAD_B), stepOpen('pA'), stepOpen('pB')),
    );
    const r = rail(page);
    await expectHead(r, t, HEAD_A, true);
    await expectHead(r, t, HEAD_B, true);

    const order: [string, Head, string][] = [
      ['pA', HEAD_A, A1],
      ['pB', HEAD_B, B1],
      ['pA', HEAD_A, A2],
      ['pB', HEAD_B, B2],
      ['pA', HEAD_A, A3],
    ];
    for (const [key, , text] of order) {
      const seen = planPolled(page, mcpPlanId, said(key, text));
      await mcpSay(agent!, mcpPlanId, key, [text]);
      await seen;
      await expect(messages(groups(r)).filter({ hasText: text })).toHaveCount(1);
      await beat();
    }
    await expectSaid(r, HEAD_A, [A1, A2, A3], [B1, B2]);
    await expectSaid(r, HEAD_B, [B1, B2], [A1, A2, A3]);
    // The progress line carries no sentence (the story leaves it unchanged).
    const progressLine = workspace(page).getByTestId('plan-progress');
    for (const text of [A1, A2, A3, B1, B2]) await expect(progressLine).not.toContainText(text);
    await expectNoCallLines(r);
  });

  // ── CASE 3 ──────────────────────────────────────────────────────────────
  await chapter(
    'Leave and come back — every sentence is still there, under its real step',
    async () => {
      await closeOverlay(page);
      // While nobody is watching: one more sentence each, the hosted session ends,
      // and plan.py's session A ends.
      await hostedStep(page, hosted.job, 'h1', { narration: [H3] });
      await hostedStep(page, hosted.job, 'h1', { step: 'end' });
      await mcpSay(agent!, mcpPlanId, 'pA', [A4]);
      await mcpSay(agent!, mcpPlanId, 'pB', [B3]);
      await mcpStep(agent!, mcpPlanId, 'pA', 'end');

      // Back from Workbench › Planning, where the plan is still being written.
      const back = planPolled(page, mcpPlanId, both(said('pA', A4), said('pB', B3), ended('pA')));
      await openFromWorkbench(page, MCP_PLAN);
      await back;
      const r = rail(page);
      await expectHead(r, t, HEAD_A, false);
      await expectHead(r, t, HEAD_B, true);
      await expectSaid(r, HEAD_A, [A1, A2, A3, A4]);
      await expectSaid(r, HEAD_B, [B1, B2, B3]);
      await beat();

      const next = planPolled(page, mcpPlanId, said('pB', B4));
      await mcpSay(agent!, mcpPlanId, 'pB', [B4]);
      await next;
      await expectSaid(r, HEAD_B, [B1, B2, B3, B4]);
      await beat();

      // The hosted plan, from its plan page opened fresh: its ended session keeps
      // its real step words, finished.
      await closeOverlay(page);
      await openPlan(page, hosted.planId, both(said('h1', H3), ended('h1')));
      await expectHead(rail(page), t, HOSTED, false);
      await expectSaid(rail(page), HOSTED, [H1, H2, H3]);
      await expectNoCallLines(rail(page));
      await beat();
    },
  );

  // ── CASE 6 ──────────────────────────────────────────────────────────────
  await chapter(
    'The same notes in 中文 — the words translate, the sentences and titles do not',
    async () => {
      const z = TR.zh;
      await closeOverlay(page);
      await setLocale(page, 'zh');
      await openPlan(page, mcpPlanId, said('pB', B4));
      const r = rail(page);
      await expectHead(r, z, HEAD_A, false);
      await expectHead(r, z, HEAD_B, true);
      await expectSaid(r, HEAD_A, [A1, A2, A3, A4]);
      // The planner's English sentences stay as written under the 中文 labels.
      await expectSaid(r, HEAD_B, [B1, B2, B3, B4]);
      for (const m of await messages(groups(r)).all()) {
        await expect(m).toHaveAttribute('dir', 'auto');
        expect(await m.getAttribute('lang')).toBeNull();
      }
      const total = 8;
      await expect(toggleAll(r)).toHaveText(z('narration.hideAll', { count: total }));
      await expect(groupOf(r, HEAD_B).getByTestId('plan-narration-group-toggle')).toHaveText(
        z('narration.groupCount', { count: 4 }),
      );
      await beat();
      await toggleAll(r).click();
      await expect(toggleAll(r)).toHaveText(z('narration.showAll', { count: total }));
      await beat();
      await toggleAll(r).click();
      await expect(toggleAll(r)).toHaveText(z('narration.hideAll', { count: total }));
      await closeOverlay(page, 'zh');
      await setLocale(page, 'en');
    },
  );

  // ── CASE 4 ──────────────────────────────────────────────────────────────
  await chapter(
    'After the plan ends — nothing is live, and every head keeps its step',
    async () => {
      await mcpStep(agent!, mcpPlanId, 'pB', 'end');
      await mcpAdd(agent!, mcpPlanId, ['Document the session lifetime'], side.key, true);
      const planned = await adminDb.plan.findUniqueOrThrow({ where: { id: mcpPlanId } });
      expect(planned.status).toBe('planned');

      await openPlan(page, mcpPlanId, status('planned'));
      const r = rail(page);
      await expectHead(r, t, SETTLE, false);
      await expectHead(r, t, HEAD_A, false);
      await expectHead(r, t, HEAD_B, false);
      await expectSaid(r, HEAD_A, [A1, A2, A3, A4]);
      await expectSaid(r, HEAD_B, [B1, B2, B3, B4]);
      // A wordless settle session is its head alone.
      await expect(messages(groupOf(r, SETTLE))).toHaveCount(0);
      await expect(
        r.locator('[data-testid="plan-narration-group"][data-session="live"]'),
      ).toHaveCount(0);
      await beat();
    },
  );

  // ── CASE 5 ──────────────────────────────────────────────────────────────
  await chapter('One control folds every note — and the conversation stays', async () => {
    // The hosted run ends through its real door (a final proposal), and the
    // person's own turn stands on the rail beside the notes.
    await closeOverlay(page);
    await hostedClose(page, hosted.job, 'Document the session lifetime');
    await openPlan(page, hosted.planId, both(said('h1', H3), status('planned')));
    const r = rail(page);
    await expect(r.getByText(ASK).last()).toBeVisible();

    const group = groupOf(r, HOSTED);
    const list = group.getByTestId('plan-narration-messages');
    await expect(toggleAll(r)).toHaveAttribute('aria-expanded', 'true');
    await expect(toggleAll(r)).toHaveText(t('narration.hideAll', { count: 3 }));
    await toggleAll(r).click();
    await expect(toggleAll(r)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggleAll(r)).toHaveText(t('narration.showAll', { count: 3 }));
    await expect(list).toBeHidden();
    // What collapse-all never hides.
    await expect(r.getByText(ASK).last()).toBeVisible();
    await expect(group.getByTestId('plan-narration-head')).toBeVisible();
    await expectHead(r, t, HOSTED, false);
    await beat();

    // One group opened alone, through its own disclosure…
    const disclosure = group.getByTestId('plan-narration-group-toggle');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(list).toBeVisible();
    // …which opens every group there is, so the all-control reads expanded —
    // and one press on it folds the group again.
    await expect(toggleAll(r)).toHaveAttribute('aria-expanded', 'true');
    await toggleAll(r).click();
    await expect(toggleAll(r)).toHaveAttribute('aria-expanded', 'false');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
    await beat();

    // Remembered across a reload.
    await page.reload();
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(toggleAll(rail(page))).toHaveAttribute('aria-expanded', 'false');
    await expect(groupOf(rail(page), HOSTED).getByTestId('plan-narration-messages')).toBeHidden();
    await toggleAll(rail(page)).click();
    await expect(toggleAll(rail(page))).toHaveAttribute('aria-expanded', 'true');
    for (const l of await rail(page).getByTestId('plan-narration-messages').all()) {
      await expect(l).toBeVisible();
    }
    await beat();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FURTHER TESTS — cases 7–11, unpaced
// ─────────────────────────────────────────────────────────────────────────────

/** A plan.py plan with two authored sessions, `pA` holding two sentences. */
async function mcpPlanWithNotes(
  seed: PlanProgressSeed,
  client: Client,
  notes = true,
  parentKey: string = seed.storyKey,
): Promise<{ planId: string; a: string; b: string }> {
  const planId = await mcpCreatePlan(client, seed.projectKey, MCP_PLAN);
  const [a, b] = await mcpAdd(client, planId, [A, B], parentKey);
  await mcpStep(client, planId, 'pA', 'author', proposalRef(a!));
  await mcpStep(client, planId, 'pB', 'author', proposalRef(b!));
  if (notes) await mcpSay(client, planId, 'pA', [A1, A2]);
  return { planId, a: a!, b: b! };
}

test('case 7 — a Visitor reads the same notes under the same heads, read-only, and can fold them', async ({
  page,
  baseURL,
}) => {
  const t = TR.en;
  const slug = `narration-visitor-${Date.now()}`;
  const seed = await seedPlanProgress(slug);
  const visitor = await makePlanProgressPublic(seed, slug);
  agent = await agentSession(seed.token, baseURL!);
  const { planId } = await mcpPlanWithNotes(seed, agent);
  const HEAD_A: Head = { kind: 'author', title: A };
  const HEAD_B: Head = { kind: 'author', title: B };
  const planPath = `/p/${seed.projectKey}/plans/${planId}`;

  await signIn(page, visitor.email, PLAN_PROGRESS_PASSWORD);
  await page.goto(planPath);
  await page.waitForURL((url) => url.pathname === `/p/${seed.projectKey}/consent`);
  const consent = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes(`/p/${seed.projectKey}/consent`),
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await consent).status()).toBe(200);
  await page.waitForURL((url) => !url.pathname.endsWith('/consent'));

  // While generating — the server render is the read.
  await page.goto(planPath);
  const r = reviewRail(page);
  await expect(r).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expectHead(r, t, HEAD_A, true);
  await expectHead(r, t, HEAD_B, true);
  await expectSaid(r, HEAD_A, [A1, A2]);
  await expect(messages(groupOf(r, HEAD_B))).toHaveCount(0);
  // Read-only: no composer, and the collapse-all is the one control on the notes.
  await expect(r.getByRole('textbox')).toHaveCount(0);
  await expect(narration(r).getByRole('button')).toHaveCount(2);
  await toggleAll(r).click();
  await expect(toggleAll(r)).toHaveAttribute('aria-expanded', 'false');
  await expect(groupOf(r, HEAD_A).getByTestId('plan-narration-messages')).toBeHidden();
  await toggleAll(r).click();
  await expect(groupOf(r, HEAD_A).getByTestId('plan-narration-messages')).toBeVisible();

  // Ended: both sessions end; a fresh read shows the same heads, finished.
  await mcpStep(agent, planId, 'pA', 'end');
  await mcpStep(agent, planId, 'pB', 'end');
  await page.goto(planPath);
  await expect(reviewRail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expectHead(reviewRail(page), t, HEAD_A, false);
  await expectHead(reviewRail(page), t, HEAD_B, false);
  await expectSaid(reviewRail(page), HEAD_A, [A1, A2]);
});

test('case 4b — a declined plan keeps every sentence under its real step heads', async ({
  page,
  baseURL,
}) => {
  const t = TR.en;
  const seed = await seedPlanProgress(`narration-declined-${Date.now()}`);
  agent = await agentSession(seed.token, baseURL!);
  const { planId } = await mcpPlanWithNotes(seed, agent);
  await mcpSay(agent, planId, 'pB', [B1]);
  await mcpStep(agent, planId, 'pA', 'end');
  await mcpStep(agent, planId, 'pB', 'end');
  await mcpAdd(agent, planId, ['Document the session lifetime'], seed.storyKey, true);
  await stubAiAccess(page);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

  await openPlan(page, planId, status('planned'));
  // Decline it where it is decided — the overlay's own confirm band.
  const overlay = workspace(page);
  await overlay
    .getByTestId('plan-change-confirm-bar')
    .getByRole('button', { name: en.approvalGate.planApproval.surface.decline, exact: true })
    .click();
  const band = overlay.getByTestId('plan-decline-confirm').first();
  const declined = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/plans/${planId}/decline` &&
      r.request().method() === 'POST',
  );
  await band
    .getByRole('button', { name: en.approvalGate.planApproval.declineConfirm.proceed, exact: true })
    .click();
  expect((await declined).status()).toBe(200);

  // A decided plan is a record: `/plans/[id]` renders it on the page.
  await page.goto(`/plans/${planId}`);
  const r = reviewRail(page);
  await expect(r).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expectHead(r, t, { kind: 'author', title: A }, false);
  await expectHead(r, t, { kind: 'author', title: B }, false);
  await expectSaid(r, { kind: 'author', title: A }, [A1, A2]);
  await expectSaid(r, { kind: 'author', title: B }, [B1]);
});

test('case 8 — sessions that said nothing show their step heads only, and no collapse-all', async ({
  page,
  baseURL,
}) => {
  const t = TR.en;
  const seed = await seedPlanProgress(`narration-none-${Date.now()}`);
  agent = await agentSession(seed.token, baseURL!);
  const { planId } = await mcpPlanWithNotes(seed, agent, false);
  await stubAiAccess(page);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

  await openPlan(page, planId, both(stepOpen('pA'), stepOpen('pB')));
  const r = rail(page);
  await expectHead(r, t, { kind: 'author', title: A }, true);
  await expectHead(r, t, { kind: 'author', title: B }, true);
  await expect(r.getByTestId('plan-narration-message')).toHaveCount(0);
  await expect(r.getByTestId('plan-narration-messages')).toHaveCount(0);
  await expect(toggleAll(r)).toHaveCount(0);
  await expect(r.getByTestId('plan-narration-group-toggle')).toHaveCount(0);
});

test('case 9 — a refused sentence, through either door, changes nothing on screen', async ({
  page,
  baseURL,
}) => {
  const t = TR.en;
  declareJobs(REPLY, QUESTION);
  const seed = await seedPlanProgress(`narration-refused-${Date.now()}`);
  agent = await agentSession(seed.token, baseURL!);
  // plan.py's plan holds the story it proposes under; the hosted ask below
  // plans the seed's own story, so plan.py proposes under another.
  const side = await addPlanProgressStory(seed, 'Harden the session store');
  const { planId } = await mcpPlanWithNotes(seed, agent, true, side.key);
  await stubAiAccess(page);
  await routeJobStream(page, sse);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

  // plan.py: a session with no step, and an empty sentence.
  const noStep = await mcpNarrate(agent, planId, 'p-unknown', ['Nobody holds this session.']);
  expect(noStep.ok).toBe(false);
  expect(noStep.ok ? '' : noStep.text).toContain('PLAN_STEP_INVALID');
  const empty = await mcpNarrate(agent, planId, 'pA', ['   ']);
  expect(empty.ok).toBe(false);
  expect(empty.ok ? '' : empty.text).toContain('PLAN_STEP_INVALID');
  await openPlan(
    page,
    planId,
    both(said('pA', A1, A2), (b) => b.narration?.entries.length === 2),
  );
  const r = rail(page);
  await planPolled(page, planId, (b) => b.narration?.entries.length === 2);
  await expect(groups(r)).toHaveCount(2);
  await expectSaid(r, { kind: 'author', title: A }, [A1, A2]);
  await expect(messages(groupOf(r, { kind: 'author', title: B }))).toHaveCount(0);
  await closeOverlay(page);

  // The hosted door: a plan that is no longer generating answers 409.
  const hosted = await askHosted(page, sse, seed);
  const HOSTED: Head = { kind: 'author', title: seed.taskTitle };
  const stepped = planPolled(page, hosted.planId, said('h1', H1));
  await hostedStep(page, hosted.job, 'h1', { step: 'author', target: seed.taskId });
  await hostedStep(page, hosted.job, 'h1', { narration: [H1] });
  await stepped;
  await hostedClose(page, hosted.job, 'Document the session lifetime');
  const late = await hostedPlanStep(page, hosted.job, 'h1', { narration: [H2] });
  expect(late.status()).toBe(409);
  expect(((await late.json()) as { code: string }).code).toBe('PLAN_NOT_GENERATING');
  await closeOverlay(page).catch(() => undefined);
  await openPlan(page, hosted.planId, (b) => b.status === 'planned');
  await expectHead(rail(page), t, HOSTED, false);
  await expectSaid(rail(page), HOSTED, [H1]);
});

test('case 10 — earlier notes load above the window through the paged read, and stay', async ({
  page,
  baseURL,
}) => {
  const t = TR.en;
  const seed = await seedPlanProgress(`narration-earlier-${Date.now()}`);
  agent = await agentSession(seed.token, baseURL!);
  const { planId } = await mcpPlanWithNotes(seed, agent, false);
  const total = PLAN_NARRATION_READ_WINDOW + PLAN_NARRATION_BATCH_MAX;
  const sentence = (n: number) => `Note ${String(n).padStart(3, '0')} on the rotation card.`;
  for (let start = 1; start <= total; start += PLAN_NARRATION_BATCH_MAX) {
    const batch = Array.from({ length: PLAN_NARRATION_BATCH_MAX }, (_, i) => sentence(start + i));
    await mcpSay(agent, planId, 'pA', batch);
  }
  await stubAiAccess(page);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

  const HEAD_A: Head = { kind: 'author', title: A };
  await openPlan(page, planId, said('pA', sentence(total)));
  const r = rail(page);
  await expectHead(r, t, HEAD_A, true);
  await expect(messages(groupOf(r, HEAD_A))).toHaveCount(PLAN_NARRATION_READ_WINDOW);
  await expect(messages(groupOf(r, HEAD_A)).first()).toHaveText(
    sentence(PLAN_NARRATION_BATCH_MAX + 1),
  );
  const earlier = r.getByTestId('plan-narration-earlier');
  await expect(earlier).toHaveText(t('narration.earlier', { count: PLAN_NARRATION_BATCH_MAX }));

  const paged = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === `/api/plans/${planId}/narration` &&
      res.request().method() === 'GET',
  );
  await earlier.click();
  const page1 = (await (await paged).json()) as PlanNarrationPageDto;
  expect(page1.entries).toHaveLength(PLAN_NARRATION_BATCH_MAX);
  const all = Array.from({ length: total }, (_, i) => sentence(i + 1));
  await expect(messages(groupOf(r, HEAD_A))).toHaveText(all);
  await expect(earlier).toHaveCount(0);

  // The next read does not remove them. The pane reads on a push (MOTIR-8542),
  // so a quiet touch of the plan causes that read.
  const next = planPolled(page, planId, said('pA', sentence(total)));
  await nudgePlan(planId);
  await next;
  await expect(messages(groupOf(r, HEAD_A))).toHaveText(all);
  await expectHead(r, t, HEAD_A, true);
});

test('case 11 — the announcer is the rail’s only polite live region', async ({ page, baseURL }) => {
  const seed = await seedPlanProgress(`narration-live-${Date.now()}`);
  agent = await agentSession(seed.token, baseURL!);
  const { planId } = await mcpPlanWithNotes(seed, agent);
  await stubAiAccess(page);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);

  await openPlan(page, planId, said('pA', A1, A2));
  const r = rail(page);
  const next = planPolled(page, planId, said('pB', B1));
  await mcpSay(agent, planId, 'pB', [B1]);
  await next;
  await expect(messages(groups(r))).toHaveCount(3);

  const polite = r.locator('[aria-live="polite"]');
  await expect(polite).toHaveCount(1);
  await expect(polite).toHaveAttribute('data-testid', 'plan-change-progress');
  await expect(narration(r)).toHaveAttribute('aria-live', 'off');
  // No narration message sits inside a polite region.
  await expect(
    r.locator('[aria-live="polite"] [data-testid="plan-narration-message"]'),
  ).toHaveCount(0);
});
