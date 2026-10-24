// Acceptance E2E — a question-only conversation ends 30 minutes after its last turn, is never
// raised in Waiting on you, is resumed inside the window, and is not listed on the Plans page,
// which shows only sessions that reached planning (Story MOTIR-9217 · Subtask MOTIR-9303).
//
// THE RECORDED WALK. A question is asked and answered; the reply pass raises nothing on it
// although every input the old predicate needed is present; Plans reads empty; the person comes
// back inside the window and the same conversation takes the follow-up; 29 minutes leaves it
// open and 31 ends it `idle`, and a second pass changes nothing; a fresh start offers no
// earlier-conversation pointer. Then a conversation that DID reach planning is listed under its
// own state on an eight-segment strip whose All adds up, survives `?planState=none` and the
// lease while its plan is undecided, and — once ended — is the conversation the fresh start's
// pointer names, landing on the very row the room lists.
//
// ⚠️ ONE ROUTE CHANGE FROM THE CARD, read from the shipped client. The card produces the
// plan-less conversation from a CARD. But an anchored turn is a planning submit
// (`usePlanChangeConversation`: the anchored branch always calls `submitContextualPlan`), and a
// planning submit opens a plan — so a card's first turn has REACHED planning by definition and
// cannot be plan-less. The one door that answers a question without planning is the project
// thread's `POST /api/ai/ask`, so the question-only half runs there (project scope), and the
// planned half runs from the card (that card's scope). The pointer is asserted per scope, which
// is what the read keys it by.
//
// THE CLOCK. Both windows are crossed by moving `lastActivityAt` back through `adminDb` and then
// calling the sweep's two shipped entry points in the job's own order with an explicit `now`.
// Nothing asserted is stubbed: the marker, the end and the row state are read from Postgres.
//
// DETERMINISM (the coding convention § E2E): every wait is a response, a landmark, or a Postgres
// read-back. `beat()` / `chapter()` are PACING only, after the assertion that proved the state.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { finishSessionPlan } from './_helpers/planChangeConversation';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { PLAN_TARGET_LOCK_LEASE_MS } from '@/lib/planChange/targetLock';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import {
  AWAITING_REPLY_AFTER_MS,
  planningSessionGateService,
} from '@/lib/services/planningSessionGateService';
import type { AiJobsFixture, AskJobOutcome, PlanJobOutcome } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 300_000 });

const sessions = en.aiPlanning.sessions;
const MIN = 60 * 1000;

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

function patchFixture(patch: (f: AiJobsFixture) => void): void {
  const f = readJobsFixture();
  patch(f);
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

const queueAsk = (outcome: AskJobOutcome) =>
  patchFixture((f) => {
    f.ask = [...(f.ask ?? []), outcome];
  });
const queuePlan = (outcome: PlanJobOutcome) =>
  patchFixture((f) => {
    f.plan = [...(f.plan ?? []), outcome];
  });

async function stubAiAccess(page: Page): Promise<void> {
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

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const earlierLine = (page: Page) => rail(page).getByTestId('planning-earlier-session');
const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });
const tabStrip = (page: Page) =>
  page.getByRole('group', { name: 'Filter conversations by plan state' });
const sessionRow = (page: Page, id: string) => page.locator(`[data-session-row="${id}"]`);
// Scoped to `main` (MOTIR-8210): the streamed Waiting-on-you list has a hidden SSR copy.
const waitingRow = (page: Page, id: string) =>
  page.getByRole('main').locator(`[data-planning-session="${id}"]`);

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── Persisted state ──────────────────────────────────────────────────────────

const row = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const plansOf = (sessionId: string) => adminDb.plan.findMany({ where: { sessionId } });
const backdate = (id: string, ms: number) =>
  adminDb.planChangeSession.update({
    where: { id },
    data: { lastActivityAt: new Date(Date.now() - ms) },
  });
/** The sweep's two steps this story changes, in the job's own order, at an explicit `now`. */
async function sweepPass() {
  const now = new Date();
  const replies = await planningSessionGateService.raiseAwaitingReplies(now);
  const idle = await planSessionEndService.closeIdleSessions(now);
  return { replies, idle };
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function openProjectThread(page: Page): Promise<{ sessionId: string | null }> {
  const resumed = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session' && r.request().method() === 'GET',
  );
  await page.goto(withPlanningOverlay('/roadmap', { kind: 'project' }));
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
  const body = (await (await resumed).json()) as { session?: { id: string } | null };
  return { sessionId: body.session?.id ?? null };
}

async function openFromCard(page: Page, key: string): Promise<{ sessionId: string | null }> {
  const resumed = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'GET',
  );
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
  const body = (await (await resumed).json()) as { session?: { id: string } | null };
  return { sessionId: body.session?.id ?? null };
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

/** Ask on the project thread: the ask door's 200, then its settle's 200 — the answer is written. */
async function askAndSettle(page: Page, text: string): Promise<string> {
  const asked = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
  );
  const settled = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask/settle' && r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: en.planningWorkspace.conversation.send }).click();
  const askRes = await asked;
  expect(askRes.status(), await askRes.text()).toBe(200);
  expect((await settled).status()).toBe(200);
  const { sessionId } = JSON.parse(askRes.request().postData() ?? '{}') as { sessionId?: string };
  return sessionId ?? (await latestOwnSession()).id;
}

let ownerId = '';
const latestOwnSession = () =>
  adminDb.planChangeSession.findFirstOrThrow({
    where: { createdById: ownerId },
    orderBy: { createdAt: 'desc' },
  });

/** The number a strip segment carries, read off its own text. */
async function segmentCounts(page: Page): Promise<{ label: string; n: number }[]> {
  const texts = await tabStrip(page).getByRole('button').allTextContents();
  return texts.map((t) => {
    const m = /^(.*?)(\d+)$/.exec(t.trim());
    return { label: (m?.[1] ?? t).trim(), n: Number(m?.[2] ?? NaN) };
  });
}

test.beforeEach(async () => {
  await resetDatabase();
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], plan: [], submitted: [] }, null, 2));
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a question-only conversation is never waiting on you, ends on the lease, and is not listed; a planned one is', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9217');

  const email = `question-only-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  ownerId = (await adminDb.user.findUniqueOrThrow({ where: { email } })).id;
  const project = await adminDb.project.findFirstOrThrow({
    where: { identifier: seed.projectKey },
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const QUESTION = 'What is still open on the canvas story?';
  const ANSWER = 'Nothing is blocked; the canvas seam is the last open piece.';
  const FOLLOW_UP = 'And who owns the canvas seam?';
  const FOLLOW_ANSWER = 'The owner of this project does.';
  let questionId = '';

  await chapter('A question is asked and answered — no plan is written', async () => {
    queueAsk({ intent: 'ask', answer: ANSWER, citations: [] });
    await openProjectThread(page);
    questionId = await askAndSettle(page, QUESTION);
    await expect(rail(page).getByText(ANSWER).first()).toBeVisible();

    const s = await row(questionId);
    expect(s.awaitingPersonSince).toBeNull();
    expect(s.endedAt).toBeNull();
    expect(await plansOf(questionId)).toHaveLength(0);
    await beat();
    await closeOverlay(page);
  });

  await chapter('Left past the reply threshold, it is not waiting on you', async () => {
    await backdate(questionId, AWAITING_REPLY_AFTER_MS + 5 * MIN);
    const out = await planningSessionGateService.raiseAwaitingReplies(new Date());
    expect(out.sessionIds).not.toContain(questionId);

    // Every input the OLD reply predicate needed is present — so raising nothing is the rule.
    const s = await row(questionId);
    expect(s.awaitingPersonSince).toBeNull();
    expect({
      open: s.endedAt === null,
      unfailed: s.failedAt === null,
      owned: s.createdById === ownerId,
      origin: s.origin,
      quiet: s.lastActivityAt.getTime() < Date.now() - AWAITING_REPLY_AFTER_MS,
    }).toEqual({ open: true, unfailed: true, owned: true, origin: 'conversation', quiet: true });
    const last = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { sessionId: questionId },
      orderBy: { seq: 'desc' },
    });
    expect({ role: last.role, question: last.question }).toEqual({
      role: 'assistant',
      question: null,
    });

    await page.goto('/workbench?tab=approvals');
    await expect(page.getByRole('main')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(waitingRow(page, questionId)).toHaveCount(0);
    await beat();
  });

  await chapter('Plans: nothing has reached planning yet', async () => {
    await page.goto('/plans');
    await expect(page.getByRole('main').getByText(sessions.emptyTitle)).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByRole('main').getByText(sessions.emptyDescription)).toBeVisible();
    await expect(tabStrip(page)).toHaveCount(0);
    await expect(sessionRow(page, questionId)).toHaveCount(0);
    await beat();
  });

  await chapter('Back inside the window — the same conversation takes the follow-up', async () => {
    const backdatedTo = (await row(questionId)).lastActivityAt;
    const { sessionId } = await openProjectThread(page);
    expect(sessionId).toBe(questionId);
    await expect(rail(page).getByText(QUESTION).first()).toBeVisible();
    await expect(rail(page).getByText(ANSWER).first()).toBeVisible();

    queueAsk({ intent: 'ask', answer: FOLLOW_ANSWER, citations: [] });
    expect(await askAndSettle(page, FOLLOW_UP)).toBe(questionId);
    await expect(rail(page).getByText(FOLLOW_ANSWER).first()).toBeVisible();
    await expect
      .poll(async () => (await row(questionId)).lastActivityAt.getTime())
      .toBeGreaterThan(backdatedTo.getTime());
    await beat();
    await closeOverlay(page);
  });

  await chapter('29 minutes: still open', async () => {
    await backdate(questionId, PLAN_TARGET_LOCK_LEASE_MS - 1 * MIN);
    const { replies, idle } = await sweepPass();
    expect(replies.sessionIds).not.toContain(questionId);
    expect(idle.sessionIds).not.toContain(questionId);
    expect((await row(questionId)).endedAt).toBeNull();
    await beat();
  });

  let afterFirst: Awaited<ReturnType<typeof row>>;

  await chapter('31 minutes: ended idle, and never in Waiting on you', async () => {
    await page.goto('/workbench?tab=approvals');
    await expect(page.getByRole('main')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(waitingRow(page, questionId)).toHaveCount(0);

    await backdate(questionId, PLAN_TARGET_LOCK_LEASE_MS + 1 * MIN);
    const { replies, idle } = await sweepPass();
    expect(replies.sessionIds).not.toContain(questionId);
    expect(idle.sessionIds).toContain(questionId);
    afterFirst = await row(questionId);
    expect(afterFirst.endedAt).not.toBeNull();
    expect(afterFirst.endReason).toBe('idle');
    expect(afterFirst.failedAt).toBeNull();
    expect(afterFirst.awaitingPersonSince).toBeNull();

    await page.reload();
    await expect(page.getByRole('main')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(waitingRow(page, questionId)).toHaveCount(0);
    await beat();
  });

  await chapter('A second pass changes nothing', async () => {
    const { replies, idle } = await sweepPass();
    expect(replies).toEqual({ raised: 0, sessionIds: [] });
    expect(idle).toEqual({ closed: 0, sessionIds: [] });
    expect(await row(questionId)).toEqual(afterFirst);
    await beat();
  });

  await chapter('A fresh start — and no pointer, since nothing reached planning', async () => {
    const planRows = await adminDb.plan.count({ where: { projectId: project.id } });
    expect(planRows).toBe(0);
    const { sessionId } = await openProjectThread(page);
    expect(sessionId).not.toBe(questionId);
    expect(sessionId).toBeNull();
    await expect(rail(page).getByText(FOLLOW_ANSWER)).toHaveCount(0);
    await expect(earlierLine(page)).toHaveCount(0);
    await expect(
      rail(page).locator(`a[href*="/plans?session=${encodeURIComponent(questionId)}"]`),
    ).toHaveCount(0);
    await beat();
    await closeOverlay(page);
  });

  let plannedId = '';
  let planId = '';

  await chapter('Planning from the card — the conversation reaches planning', async () => {
    queuePlan({ status: 'succeeded', turn: { message: 'Here is a plan for the canvas seam.' } });
    await openFromCard(page, seed.storyKey);
    const sent = page.waitForResponse(
      (r) =>
        /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'POST',
    );
    const recorded = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/ai/plan-change/session/planner-turn' &&
        r.request().method() === 'POST',
    );
    await composer(page).fill('Split this story so the canvas can ship alone.');
    await rail(page).getByRole('button', { name: en.planningWorkspace.conversation.send }).click();
    expect((await sent).status()).toBe(200);
    expect((await recorded).status()).toBe(200);
    plannedId = (await latestOwnSession()).id;
    expect(plannedId).not.toBe(questionId);
    planId = await finishSessionPlan(plannedId, 'Ship the canvas seam');
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    await closeOverlay(page);

    await page.goto('/plans');
    await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(sessionRow(page, plannedId)).toContainText(sessions.planState.planned);
    await expect(sessionRow(page, questionId)).toHaveCount(0);
    await expect(page.getByText(sessions.emptyTitle)).toHaveCount(0);
    await beat();
  });

  await chapter('Eight segments, no "No plan yet", and All adds up', async () => {
    await expect(tabStrip(page).getByRole('button')).toHaveCount(8);
    await expect(tabStrip(page).getByRole('button', { name: sessions.planState.none })).toHaveCount(
      0,
    );
    const segments = await segmentCounts(page);
    expect(segments[0]!.label).toBe(sessions.filter.all);
    const drawn = segments.slice(1).reduce((a, s) => a + s.n, 0);
    expect(segments[0]!.n).toBe(drawn);
    expect(segments[0]!.n).toBe(1);
    await beat();
  });

  await chapter('An old ?planState=none link opens on All', async () => {
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.goto('/plans?planState=none');
    await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    expect(new URL(page.url()).pathname).toBe('/plans');
    await expect(sessionRow(page, plannedId)).toBeVisible();
    await expect(
      tabStrip(page).getByRole('button', { name: new RegExp(`^${sessions.filter.all}`) }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
    await beat();
  });

  await chapter('Past the lease with its plan undecided, the planned one stays open', async () => {
    await backdate(plannedId, PLAN_TARGET_LOCK_LEASE_MS + 5 * MIN);
    const { replies, idle } = await sweepPass();
    expect(replies.sessionIds).not.toContain(plannedId);
    expect(idle.sessionIds).not.toContain(plannedId);
    expect((await row(plannedId)).endedAt).toBeNull();
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    await beat();
  });

  await chapter(
    'Ended, it is what a fresh start points to — and the row the room lists',
    async () => {
      const before = await row(plannedId);
      await planSessionEndService.endSession(plannedId, 'restarted', {
        workspaceId: before.workspaceId,
        endedById: ownerId,
      });
      const ended = await row(plannedId);
      expect(ended.endedAt).not.toBeNull();
      expect(ended.endReason).toBe('restarted');
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
        'planned',
      );

      const { sessionId } = await openFromCard(page, seed.storyKey);
      expect(sessionId).not.toBe(plannedId);
      await expect(earlierLine(page)).toBeVisible();
      const link = earlierLine(page).getByRole('link');
      const href = await link.getAttribute('href');
      const target = new URL(href!, page.url());
      expect(target.searchParams.get('session')).toBe(plannedId);
      expect(target.searchParams.get('session')).not.toBe(questionId);
      await beat();

      const errors: Error[] = [];
      page.on('pageerror', (e) => errors.push(e));
      await link.click();
      await page.waitForURL((url) => url.pathname.endsWith('/plans'));
      await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(sessionRow(page, plannedId)).toBeVisible();
      await expect(
        tabStrip(page).getByRole('button', { name: new RegExp(`^${sessions.filter.all}`) }),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(new URL(page.url()).searchParams.get('session')).toBe(plannedId);
      expect(errors).toEqual([]);
      await beat();
    },
  );
});
