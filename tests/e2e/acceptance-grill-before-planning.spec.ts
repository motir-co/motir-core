// Acceptance E2E — Grill me works in this conversation: with it on, a vague request
// gets a sharpening question before any plan offer is made (Story MOTIR-9221 ·
// MOTIR-9319; design `design/ai-chat/grill-before-planning.mock.html`). The receipt a
// person watches to accept the story, walking its Verification recipe:
//
//   THE RECORDED WALK (recipe steps 1–3). Grill me on, a vague request is answered
//   with a plan offer, and the offer is HELD while the grilling asks — no Confirm, no
//   Decline; two answers and Stop show the offer listing what they settled, and the
//   Plans page still lists nothing; a typed yes starts planning in the same
//   conversation, carrying the answers, and the run asks none of them again.
//
//   THE REST (unrecorded). A clear request gets the offer at once; Grill me off and a
//   defect report open no grilling; "plan this" on a card starts at once; a reopen
//   within the lease shows the grilling where it was left; Grill me switched off
//   mid-grilling shows the offer; and step 1 in Chinese.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'). motir-ai is
// mocked UNDER the routes: the grounded read and the planning run by
// `lib/test-ai-jobs-mock.ts` (the fixture writes each answer's `offer` and a typed
// reply's `offerReply`), and the grilling turns by `lib/test-sharpen-mock.ts` from a
// SCRIPT (`_helpers/grill-me-journey.ts`). So no assertion tests which question
// motir-ai would ask — the motir-ai story gate owns that. The real ask door, Sharpen
// door and settle, offer doors, plan submit and Postgres all run; nothing is stubbed
// with `page.route`.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal: a response armed before the action
// that causes it (the ask door and its settle, the settle that stored a grilling
// turn, the plan start), a Postgres row, or a seam journal. An absence — no Confirm
// while the grilling is open — is asserted only AFTER the question is visible, so it
// cannot pass vacuously. `beat()` and the chapter hold are pacing, taken after the
// assertion that proved the step.
import type { Page, Request, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import { declareSeam, queueAsk, submitsOf } from './_helpers/mid-run-seam';
import { grantPaidAiPlanIfBilled } from './_helpers/billing';
import { setReaderLanguage } from './_helpers/reader-language';
import {
  Q1,
  Q2,
  Q3,
  declareSharpen,
  grillHelp,
  grillSwitch,
  question,
  readSharpen,
  readingButton,
  sharpenTurnSettled,
  thread,
} from './_helpers/grill-me-journey';
import type { AskJobOutcome } from '@/lib/test-ai-jobs-mock';
import type { SharpenTargetFixture } from '@/lib/test-sharpen-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 300_000 });

const offerCopy = en.planningWorkspace.planOffer;
const controlCopy = en.planningWorkspace.grill.control;
const sharpenCopy = en.sharpen;

// ── Locators ────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan|规划/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const sendButton = (page: Page, name = en.planningWorkspace.conversation.send) =>
  rail(page).getByRole('button', { name, exact: true });
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI', exact: true });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const byId = (page: Page, id: string) => rail(page).getByTestId(id);
const offers = (page: Page) => byId(page, 'plan-offer');
const confirmButton = (page: Page) => byId(page, 'plan-offer-confirm');
const declineButton = (page: Page) => byId(page, 'plan-offer-decline');
const heldNotice = (page: Page) => byId(page, 'plan-offer-held');
const settledList = (page: Page) => byId(page, 'plan-offer-settled');
const clearLine = (page: Page) => byId(page, 'plan-offer-clear');
const conversationGrill = (page: Page) => byId(page, 'conversation-grill');
/** The popover is portalled out of the rail, so it is found by its role and name. */
const explanation = (page: Page, title = controlCopy.popover.title) =>
  page.getByRole('dialog', { name: title });

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── Authoritative signals ───────────────────────────────────────────────────

const ASK = '/api/ai/ask';
const SETTLE = '/api/ai/ask/settle';
const pathOf = (r: Response) => new URL(r.url()).pathname;
const posted = (page: Page, pathname: string) =>
  page.waitForResponse((r) => pathOf(r) === pathname && r.request().method() === 'POST');

/** Every Sharpen-door POST that names a CONVERSATION — the before-planning grilling. */
function recordConversationGrills(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || new URL(r.url()).pathname !== '/api/ai/sharpen') return;
    const body = r.postDataJSON() as { conversationId?: unknown } | null;
    if (typeof body?.conversationId === 'string') seen.push(r);
  });
  return seen;
}

/** The grilling turns the Sharpen seam played, by the scope core sent. */
const sharpenSubmits = (kind: 'conversation' | 'plan') =>
  (readSharpen().submitted ?? []).filter((s) => s.context?.scope.kind === kind);

/** The `plan` jobs the server submitted — the planner's boundary, counted. */
const planEntries = () => submitsOf('plan');

// ── Persisted state (through the owner's client, so RLS cannot zero them) ───

const plansOf = (sessionId: string) => adminDb.plan.count({ where: { sessionId } });

/** The open project conversation the overlay resumes — the latest this person started. */
async function openConversation(userId: string) {
  return adminDb.planChangeSession.findFirstOrThrow({
    where: { createdById: userId, endedAt: null, origin: 'conversation' },
    orderBy: { createdAt: 'desc' },
  });
}

/** The latest answer turn on the conversation — the one carrying the offer. */
async function latestAnswerRow(sessionId: string) {
  return adminDb.planChangeTurn.findFirstOrThrow({
    where: { sessionId, role: 'assistant' },
    orderBy: { seq: 'desc' },
  });
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function openProjectThread(page: Page, askLink: RegExp = /Ask about this project/) {
  await expect(orb(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await orb(page).click();
  await calloutPanel(page).getByRole('link', { name: askLink }).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

async function closeOverlay(page: Page) {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

async function turnGrillOn(page: Page) {
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await grillSwitch(page).click();
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
}

/** Send a turn on the project thread: the ask door's 200, then the settle's body. */
async function ask(
  page: Page,
  text: string,
  send = en.planningWorkspace.conversation.send,
): Promise<{ outcome?: string }> {
  const asked = posted(page, ASK);
  const settled = posted(page, SETTLE);
  await composer(page).fill(text);
  await sendButton(page, send).click();
  const askRes = await asked;
  expect(askRes.status(), await askRes.text()).toBe(200);
  const res = await settled;
  expect(res.status(), await res.text()).toBe(200);
  await expect(rail(page).getByText(text).first()).toBeVisible();
  return (await res.json()) as { outcome?: string };
}

/** Ask, and wait for the grilling the offering answer opened to store its first turn. */
async function askAndGrill(page: Page, text: string, send?: string) {
  const firstTurn = sharpenTurnSettled(page);
  await ask(page, text, send);
  expect((await firstTurn).outcome).toBe('settled');
}

/** One grilling act — a click — and the stored turn it produced. */
async function act(page: Page, press: ReturnType<Page['getByTestId']>) {
  const settled = sharpenTurnSettled(page);
  await press.click();
  return settled;
}

/** The offer's Confirm and Decline are not in the DOM — asserted once the question shows. */
async function expectHeld(page: Page) {
  await expect(question(page)).toBeVisible();
  await expect(heldNotice(page)).toHaveText(offerCopy.held);
  await expect(conversationGrill(page)).toHaveAttribute('data-hold', 'held');
  await expect(confirmButton(page)).toHaveCount(0);
  await expect(declineButton(page)).toHaveCount(0);
  await expect(offers(page)).toHaveCount(0);
}

const VAGUE = 'plan something for exports';
const VAGUE_ANSWER = 'Exports today are a nightly CSV of the reports page.';
const VAGUE_REQUEST = 'Plan an export feature for the project.';
const CLEAR = "plan a CSV export of the board's visible columns, for project admins, nothing else";
const CLEAR_REQUEST = 'Plan a CSV export of the board’s visible columns for project admins.';

const offering = (answer: string, requestText: string): AskJobOutcome => ({
  intent: 'ask',
  answer,
  offer: { kind: 'plan', requestText, immediate: false },
});

const SCRIPT: SharpenTargetFixture = { mode: 'scripted', questions: [Q1, Q2, Q3] };

let seed: AiAugmentReplanSeed;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  // The planning run is HELD in its conversation phase, so the run's own grilling
  // is reachable once a start lands; the plans after it settle at once.
  declareSeam({ ask: [], plan: [{ status: 'running' }, {}] });
  declareSharpen(SCRIPT);
  seed = await seedAiAugmentReplan(`grill-before-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const workspaceRow = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.ctx.workspaceId },
  });
  // Grilling and the start SPEND credits: on this cloud-on lane an org the billing
  // fixture does not name reads as free and out of credits.
  if (workspaceRow.organizationId) grantPaidAiPlanIfBilled(workspaceRow.organizationId);
  await signIn(page, seed.email, seed.password);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('Grill me before planning — a vague request is grilled, Stop shows the offer with what was settled, and a typed yes plans it without asking again', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9221');
  const userId = seed.ctx.userId;
  const picked1 = Q1.readings[0]!;
  const picked2 = Q2.readings[1]!;
  let conversationId = '';

  // ── 1 · GRILLED BEFORE ANY OFFER ──────────────────────────────────────────
  await chapter('Grill me on — a vague request is questioned before any offer', async () => {
    await page.goto('/dashboard');
    await openProjectThread(page);
    await turnGrillOn(page);
    await expect(rail(page).getByTestId('grill-me-hint')).toHaveText(
      controlCopy.hintBeforePlanning,
    );
    await grillHelp(page).click();
    await expect(explanation(page)).toContainText(controlCopy.popover.beforePlanning);
    await page.keyboard.press('Escape');
    await expect(explanation(page)).toHaveCount(0);
    await beat();

    queueAsk(offering(VAGUE_ANSWER, VAGUE_REQUEST));
    await askAndGrill(page, VAGUE);
    await expect(question(page)).toContainText(Q1.text);
    for (const r of Q1.readings) await expect(readingButton(page, r.id)).toBeVisible();
    for (const id of ['sharpen-skip', 'sharpen-you-decide', 'sharpen-stop']) {
      await expect(question(page).getByTestId(id)).toBeVisible();
    }
    await expect(composer(page)).toHaveAttribute(
      'placeholder',
      sharpenCopy.question.composerPlaceholder,
    );
    await expectHeld(page);
    conversationId = (await openConversation(userId)).id;
    expect(sharpenSubmits('conversation').map((s) => s.context.scope.ref)).toEqual([
      conversationId,
    ]);
    expect(planEntries()).toHaveLength(0);
    await beat();
  });

  // ── 2 · STOP SHOWS THE OFFER ──────────────────────────────────────────────
  await chapter('Two answers, then Stop — the offer lists what was settled', async () => {
    await act(page, readingButton(page, picked1.id));
    await expect(question(page)).toContainText(Q2.text);
    await expectHeld(page);
    await act(page, readingButton(page, picked2.id));
    await expect(question(page)).toContainText(Q3.text);
    await expectHeld(page);
    await beat();

    await act(page, question(page).getByTestId('sharpen-stop'));
    await expect(thread(page).getByTestId('sharpen-stopped')).toHaveText(
      sharpenCopy.markers.stopped,
    );
    await expect(heldNotice(page)).toHaveCount(0);
    await expect(conversationGrill(page)).toHaveAttribute('data-hold', 'shown');
    await expect(offers(page)).toHaveCount(1);
    await expect(settledList(page)).toContainText(offerCopy.settledHeading);
    const answers = settledList(page).getByTestId('plan-offer-settled-answer');
    await expect(answers).toHaveCount(2);
    await expect(answers.nth(0)).toContainText(picked1.label);
    await expect(answers.nth(1)).toContainText(picked2.label);
    await expect(confirmButton(page)).toBeVisible();
    await expect(declineButton(page)).toBeVisible();
    expect(planEntries()).toHaveLength(0);
    expect(await plansOf(conversationId)).toBe(0);

    // A second tab: the Plans page does not list a conversation nobody confirmed.
    const plans = await page.context().newPage();
    await plans.goto('/plans');
    await expect(plans.getByRole('main')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(plans.locator(`[data-session-row="${conversationId}"]`)).toHaveCount(0);
    await plans.close();
    await beat();
  });

  // ── 3 · A TYPED YES PLANS IT, WITHOUT ASKING AGAIN ────────────────────────
  await chapter('A typed yes plans it here, and the run asks none of it again', async () => {
    const offerTurn = await latestAnswerRow(conversationId);
    queueAsk({
      intent: 'ask',
      answer: 'Starting the plan for exports.',
      offerReply: { seq: offerTurn.seq, kind: 'plan', decision: 'agree' },
    });
    // The next grilling turn stored after the yes is the RUN's own (the conversation's
    // grilling has ended), so it is armed before the yes is sent.
    const inRunTurn = sharpenTurnSettled(page);
    expect((await ask(page, 'yes, plan it')).outcome).toBe('redirected');
    await expect.poll(() => planEntries().length).toBe(1);
    expect(await plansOf(conversationId)).toBe(1);
    // What motir-core sent the planner: the conversation's settled answers.
    const carried = planEntries()[0]!.carriedAnswers;
    expect(carried?.settled.map((s) => [s.questionId, s.answer])).toEqual([
      [Q1.id, picked1.label],
      [Q2.id, picked2.label],
    ]);

    // The run's own grilling opens over its plan, carrying the same set — so it
    // ends with nothing to ask, and no question is drawn.
    const stored = await inRunTurn;
    expect(stored.outcome).toBe('settled');
    expect(stored.session.scope.kind).toBe('plan');
    expect(stored.session.endReason).toBe('nothing_to_ask');
    const inRun = sharpenSubmits('plan')[0]!.context;
    expect(inRun.run?.carried?.settled.map((s) => s.questionId)).toEqual([Q1.id, Q2.id]);
    await expect(rail(page).getByText(sharpenCopy.markers.nothingToAsk)).toBeVisible();
    await expect(question(page)).toHaveCount(0);
    // start, two answers and Stop: the conversation was grilled once, never again.
    expect(sharpenSubmits('conversation')).toHaveLength(4);
    expect(sharpenSubmits('plan')).toHaveLength(1);
    await beat();

    await page.goto('/plans');
    await expect(page.locator(`[data-session-row="${conversationId}"]`)).toHaveCount(1, {
      timeout: FIRST_PAINT_MS,
    });
    await beat();
  });
});

// ═══ The rest (unrecorded) ═══════════════════════════════════════════════════

test('a request clear enough to plan gets the offer at once, with the clear-enough line', async ({
  page,
}) => {
  declareSharpen({ mode: 'determinate' });
  await page.goto('/dashboard');
  await openProjectThread(page);
  await turnGrillOn(page);
  queueAsk(offering('Board exports are not built yet.', CLEAR_REQUEST));
  await askAndGrill(page, CLEAR);
  await expect(clearLine(page)).toContainText(offerCopy.clearEnough);
  await expect(thread(page)).toContainText(sharpenCopy.conversation.nothingToAsk);
  await expect(question(page)).toHaveCount(0);
  await expect(settledList(page)).toHaveCount(0);
  await expect(confirmButton(page)).toBeVisible();
});

test('with Grill me off the offer is shown straight away, and no grilling is sent', async ({
  page,
}) => {
  const grills = recordConversationGrills(page);
  await page.goto('/dashboard');
  await openProjectThread(page);
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
  queueAsk(offering(VAGUE_ANSWER, VAGUE_REQUEST));
  await ask(page, VAGUE);
  await expect(confirmButton(page)).toBeVisible();
  await expect(heldNotice(page)).toHaveCount(0);
  expect(grills).toHaveLength(0);
  expect(sharpenSubmits('conversation')).toHaveLength(0);
});

test('a defect report is answered with no grilling', async ({ page }) => {
  const grills = recordConversationGrills(page);
  await page.goto('/dashboard');
  await openProjectThread(page);
  await turnGrillOn(page);
  const ANSWER = 'Mentions are parsed on save, and an edit re-parses them.';
  queueAsk({ intent: 'ask', answer: ANSWER });
  await ask(page, 'saving a comment drops the @mention');
  await expect(byId(page, 'plan-change-report').filter({ hasText: ANSWER })).toHaveCount(1);
  await expect(question(page)).toHaveCount(0);
  await expect(offers(page)).toHaveCount(0);
  expect(grills).toHaveLength(0);
  expect(sharpenSubmits('conversation')).toHaveLength(0);
});

test('"plan this" on a card starts planning at once, never holding an offer', async ({ page }) => {
  const grills = recordConversationGrills(page);
  await page.goto(`/items/${seed.notifKey}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await turnGrillOn(page);
  const started = page.waitForResponse(
    (r) => /\/api\/work-items\/[^/]+\/ai\/plan$/.test(pathOf(r)) && r.request().method() === 'POST',
  );
  await composer(page).fill('plan this');
  await sendButton(page).click();
  expect((await started).status()).toBe(200);
  await expect.poll(() => planEntries().length).toBe(1);
  // The run's OWN grilling is let through: a Sharpen session over its plan.
  await expect.poll(() => sharpenSubmits('plan').length).toBeGreaterThan(0);
  await expect(offers(page)).toHaveCount(0);
  await expect(heldNotice(page)).toHaveCount(0);
  expect(grills).toHaveLength(0);
  expect(sharpenSubmits('conversation')).toHaveLength(0);
});

test('reopened within the lease, the grilling is where it was left, and still held', async ({
  page,
}) => {
  const userId = seed.ctx.userId;
  await page.goto('/dashboard');
  await openProjectThread(page);
  await turnGrillOn(page);
  queueAsk(offering(VAGUE_ANSWER, VAGUE_REQUEST));
  await askAndGrill(page, VAGUE);
  await act(page, readingButton(page, Q1.readings[0]!.id));
  await expect(question(page)).toContainText(Q2.text);
  const conversationId = (await openConversation(userId)).id;
  await closeOverlay(page);

  await openProjectThread(page);
  expect((await openConversation(userId)).id).toBe(conversationId);
  await expect(question(page)).toContainText(Q2.text, { timeout: FIRST_PAINT_MS });
  await expect(thread(page)).toContainText(Q1.readings[0]!.label);
  await expectHeld(page);
  // Reopening sent nothing: the grilling's turns are the ones it had.
  expect(sharpenSubmits('conversation')).toHaveLength(2);
});

test('switching Grill me off mid-grilling shows the offer with what was settled so far', async ({
  page,
}) => {
  await page.goto('/dashboard');
  await openProjectThread(page);
  await turnGrillOn(page);
  queueAsk(offering(VAGUE_ANSWER, VAGUE_REQUEST));
  await askAndGrill(page, VAGUE);
  await act(page, readingButton(page, Q1.readings[0]!.id));
  await expectHeld(page);

  const stopped = sharpenTurnSettled(page);
  await grillSwitch(page).click();
  expect((await stopped).outcome).toBe('settled');
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(thread(page)).toContainText(sharpenCopy.conversation.switchedOff);
  await expect(heldNotice(page)).toHaveCount(0);
  await expect(settledList(page).getByTestId('plan-offer-settled-answer')).toContainText(
    Q1.readings[0]!.label,
  );
  await expect(confirmButton(page)).toBeVisible();
});

test('in Chinese, the grilling, the Held notice and the settled list render from the zh catalogue', async ({
  page,
}) => {
  const zOffer = zh.planningWorkspace.planOffer;
  const zControl = zh.planningWorkspace.grill.control;
  await setReaderLanguage(page, seed.email, 'zh');
  await page.goto('/dashboard');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh', { timeout: FIRST_PAINT_MS });
  await openProjectThread(page, new RegExp(zh.shell.aiCallout.actions.ask.title));
  await turnGrillOn(page);
  await expect(rail(page).getByTestId('grill-me-hint')).toHaveText(zControl.hintBeforePlanning);
  await grillHelp(page).click();
  await expect(explanation(page, zControl.popover.title)).toContainText(
    zControl.popover.beforePlanning,
  );
  await page.keyboard.press('Escape');

  queueAsk(offering('导出目前是报表页的每晚 CSV。', '为项目规划一个导出功能。'));
  await askAndGrill(page, '为导出规划点什么', zh.planningWorkspace.conversation.send);
  await expect(question(page)).toBeVisible();
  await expect(heldNotice(page)).toHaveText(zOffer.held);
  await expect(confirmButton(page)).toHaveCount(0);

  await act(page, readingButton(page, Q1.readings[0]!.id));
  await act(page, question(page).getByTestId('sharpen-stop'));
  await expect(settledList(page)).toContainText(zOffer.settledHeading);
  await expect(settledList(page)).not.toContainText(offerCopy.settledHeading);
  await expect(confirmButton(page)).toHaveText(zOffer.confirm);
});
