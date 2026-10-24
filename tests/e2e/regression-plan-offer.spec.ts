// Acceptance E2E — Motir AI offers to plan what the conversation describes, and starts
// on Confirm or a typed yes (Story MOTIR-9219 · MOTIR-9297; `conversation-turn-intent.md`
// AMENDMENT 5 · MOTIR-9215). The receipt a person watches to accept the story, walking
// its Verification recipe in order:
//
//   THE RECORDED WALK (recipe steps 1–7, one chapter each). A question is answered with
//   no offer; "plan a fix for that" is answered with ONE offer carrying Confirm and
//   Decline; Decline plans nothing and the conversation carries on; the offer again,
//   and a typed "yes, plan it" starts the plan in the same conversation; on an item
//   page "plan this" starts planning at once with no offer drawn; mid-planning, "plan
//   the import screen instead" is the same offer, never "Start something new?", and
//   its Confirm restarts the way Plan something new does; an offer survives closing
//   and reopening the overlay, and its Confirm still starts.
//
//   THE REST (unrecorded). The exactly-once collisions — Confirm pressed twice, and
//   Confirm followed by a typed yes — and recipe step 9, the offer in Chinese. Step 8
//   (no `work_item:edit`) is the core story integration gate's (MOTIR-9295,
//   `planOfferRefusals.test.ts`), as is every other refusal arm.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'), where motir-ai
// is mocked UNDER the routes by `lib/test-ai-jobs-mock.ts`. The fixture writes what
// each answer DECIDED — its `offer`, and a typed reply's `offerReply` — so no assertion
// here tests motir-ai's judgement (the motir-ai story gate, MOTIR-9296, owns that). The
// real ask door, settle, offer doors, plan submit, restart and Postgres all run, and
// nothing is stubbed with `page.route`. The org is given a paid AI plan through the
// lane's billing fixture, so the shipped entitlement path runs.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal: a response armed before the action that
// causes it (the ask door, the settle, the confirm and decline doors), a Postgres row
// read back, or the fixture journal. Every "nothing was planned" is a COUNT of `plan`
// journal entries and `Plan` rows read at the moment it matters — never an absence on
// the screen alone, and never a missing session row, since an ask runs on one.
// `beat()` and the chapter hold are pacing, taken after the assertion that proved it.
import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
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
import { withPlanningOverlay } from '@/lib/planning/launcher';
import type { AskJobOutcome } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 300_000 });

const copy = en.planningWorkspace.planOffer;
const zcopy = zh.planningWorkspace.planOffer;
const restart = en.planningWorkspace.restart;

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
const answer = (page: Page, text: string) =>
  byId(page, 'plan-change-report').filter({ hasText: text });
const offers = (page: Page) => byId(page, 'plan-offer');
const latestOffer = (page: Page) => offers(page).last();
const confirmButton = (page: Page) => byId(page, 'plan-offer-confirm');
const declineButton = (page: Page) => byId(page, 'plan-offer-decline');
const restartControl = (page: Page) => byId(page, 'planning-restart-control');
const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── Authoritative signals ───────────────────────────────────────────────────

const ASK = '/api/ai/ask';
const SETTLE = '/api/ai/ask/settle';
const CONFIRM = '/api/ai/plan-change/session/offer/confirm';
const DECLINE = '/api/ai/plan-change/session/offer/decline';
const pathOf = (r: Response) => new URL(r.url()).pathname;
const posted = (page: Page, pathname: string) =>
  page.waitForResponse((r) => pathOf(r) === pathname && r.request().method() === 'POST');

/** The `plan` jobs the server submitted — the planner's boundary, counted. */
const planEntries = () => submitsOf('plan');

// ── Persisted state (through the owner's client, so RLS cannot zero them) ───

const plansOf = (sessionId: string) => adminDb.plan.count({ where: { sessionId } });
const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const turnsOf = (sessionId: string) =>
  adminDb.planChangeTurn.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });

/** The latest answer turn on the conversation and its stored offer. */
async function latestAnswerRow(sessionId: string) {
  const turn = await adminDb.planChangeTurn.findFirstOrThrow({
    where: { sessionId, role: 'assistant' },
    orderBy: { seq: 'desc' },
  });
  return { ...turn, stored: turn.answerOffer as { requestMd?: string } | null };
}

/** The open project conversation the overlay resumes — the latest one this person started. */
async function openConversation(userId: string) {
  return adminDb.planChangeSession.findFirstOrThrow({
    where: { createdById: userId, endedAt: null, origin: 'conversation' },
    orderBy: { createdAt: 'desc' },
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

/** Press Confirm on the live offer; the door's body. */
async function pressConfirm(page: Page): Promise<{ sessionId: string; planId: string }> {
  const door = posted(page, CONFIRM);
  await confirmButton(page).click();
  const res = await door;
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { sessionId: string; planId: string };
}

const plainAnswer = (text: string): AskJobOutcome => ({ intent: 'ask', answer: text });
const offering = (text: string, requestText: string): AskJobOutcome => ({
  intent: 'ask',
  answer: text,
  offer: { kind: 'plan', requestText, immediate: false },
});

let seed: AiAugmentReplanSeed;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  declareSeam({ ask: [], plan: [{}] });
  seed = await seedAiAugmentReplan(`plan-offer-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const workspaceRow = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.ctx.workspaceId },
  });
  // Confirm SPENDS credits: on this cloud-on lane an org the billing fixture does not
  // name reads as free and out of credits.
  if (workspaceRow.organizationId) grantPaidAiPlanIfBilled(workspaceRow.organizationId);
  await signIn(page, seed.email, seed.password);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('the plan offer — a question, the offer, Decline, a typed yes, plan this, mid-planning, reopen', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9219');
  const userId = seed.ctx.userId;
  const QUESTION = `what is ${seed.loginKey} about?`;
  const QUESTION_ANSWER = `${seed.loginKey} is the sign-in screen, and nothing blocks it.`;
  const WANT = 'actually I want to plan a fix for that';
  const FIX = `Plan a fix for ${seed.loginKey}: the sign-in screen drops the remember-me choice.`;
  const OFFER_ANSWER = 'I can plan that fix: keep the remember-me choice across sign-ins.';
  const OTHER_QUESTION = 'what else is open on the board?';
  const OTHER_ANSWER = 'Two cards are open: the digest and the billing page.';
  const AGAIN = "let's plan it after all";
  const YES = 'yes, plan it';
  const YES_ANSWER = 'Starting the plan for the sign-in fix.';
  const IMPORT = "let's plan the import screen instead";
  const IMPORT_REQUEST = 'Plan the CSV import screen.';
  const IMPORT_ANSWER = 'I can plan the import screen instead.';
  const LATER = 'and the import error states?';
  const LATER_REQUEST = 'Plan the import screen’s error states.';
  const LATER_ANSWER = 'I can plan the error states too.';
  let conversationId = '';

  // ── 1 · A QUESTION OFFERS NOTHING ─────────────────────────────────────────
  await chapter('A question is answered, with no offer', async () => {
    queueAsk(plainAnswer(QUESTION_ANSWER));
    await page.goto('/dashboard');
    await openProjectThread(page);
    const settled = await ask(page, QUESTION);
    expect(settled.outcome).toBe('answered');
    await expect(answer(page, QUESTION_ANSWER)).toHaveCount(1);
    await expect(offers(page)).toHaveCount(0);
    await expect(confirmButton(page)).toHaveCount(0);
    conversationId = (await openConversation(userId)).id;
    expect(planEntries()).toHaveLength(0);
    expect(await plansOf(conversationId)).toBe(0);
    await beat();
  });

  // ── 2 · THE OFFER ─────────────────────────────────────────────────────────
  await chapter('"Plan a fix for that" is answered with one offer', async () => {
    queueAsk(offering(OFFER_ANSWER, FIX));
    await ask(page, WANT);
    await expect(answer(page, OFFER_ANSWER)).toHaveCount(1);
    await expect(offers(page)).toHaveCount(1);
    const offer = latestOffer(page);
    await expect(offer).toHaveAttribute('data-offer-state', 'undecided');
    await expect(offer.getByTestId('plan-offer-request')).toContainText(FIX);
    await expect(offer).toContainText(copy.label);
    await expect(confirmButton(page)).toHaveText(copy.confirm);
    await expect(declineButton(page)).toHaveText(copy.decline);
    expect((await latestAnswerRow(conversationId)).stored?.requestMd).toBe(FIX);
    expect(planEntries()).toHaveLength(0);
    expect(await plansOf(conversationId)).toBe(0);
    await beat();
  });

  // ── 3 · DECLINE ───────────────────────────────────────────────────────────
  await chapter('Decline plans nothing, and the conversation carries on', async () => {
    const declined = posted(page, DECLINE);
    await declineButton(page).click();
    expect((await declined).status()).toBe(200);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'declined');
    await expect(latestOffer(page).getByTestId('plan-offer-declined')).toContainText(copy.declined);
    await expect(confirmButton(page)).toHaveCount(0);
    expect(planEntries()).toHaveLength(0);
    expect(await plansOf(conversationId)).toBe(0);

    queueAsk(plainAnswer(OTHER_ANSWER));
    expect((await ask(page, OTHER_QUESTION)).outcome).toBe('answered');
    await expect(answer(page, OTHER_ANSWER)).toHaveCount(1);
    // The new answer declared no offer, and the declined one stays a record.
    await expect(offers(page)).toHaveCount(1);
    await expect(confirmButton(page)).toHaveCount(0);
    expect(planEntries()).toHaveLength(0);
    expect(await plansOf(conversationId)).toBe(0);
    await beat();
  });

  // ── 4 · A TYPED YES ───────────────────────────────────────────────────────
  await chapter('The offer again, and a typed yes starts the plan here', async () => {
    queueAsk(offering(OFFER_ANSWER, FIX));
    await ask(page, AGAIN);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'undecided');
    const offerTurn = await latestAnswerRow(conversationId);

    queueAsk({
      intent: 'ask',
      answer: YES_ANSWER,
      offerReply: { seq: offerTurn.seq, kind: 'plan', decision: 'agree' },
    });
    expect((await ask(page, YES)).outcome).toBe('redirected');
    await expect.poll(() => planEntries().length).toBe(1);
    expect(await plansOf(conversationId)).toBe(1);
    // The person retyped nothing: the request the start appended is the stored offer's.
    const appended = (await turnsOf(conversationId)).filter(
      (t) => t.role === 'user' && t.seq > offerTurn.seq && t.body !== YES,
    );
    expect(appended.map((t) => t.body)).toEqual([offerTurn.stored!.requestMd]);
    await beat();

    // Reloaded, the offer reads confirmed, and the Plans list names the conversation.
    await page.goto(
      withPlanningOverlay('/dashboard', { kind: 'project', sessionId: conversationId }),
    );
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    // Exactly one offer reads confirmed, and it is the latest. (A `filter({ has })`
    // locator is resolved INSIDE each offer, so a rail-rooted one there matched
    // nothing — MOTIR-9344.)
    await expect(
      rail(page).locator('[data-testid="plan-offer"][data-offer-state="confirmed"]'),
    ).toHaveCount(1);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'confirmed');
    await expect(latestOffer(page).getByTestId('plan-offer-confirmed')).toBeVisible();
    await expect(confirmButton(page)).toHaveCount(0);
    await page.goto('/plans');
    await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.locator(`[data-session-row="${conversationId}"]`)).toHaveCount(1);
    await beat();
  });

  // ── 5 · PLAN THIS ─────────────────────────────────────────────────────────
  await chapter('On an item page, "plan this" starts planning at once', async () => {
    const before = planEntries().length;
    await page.goto(`/items/${seed.notifKey}`);
    await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await entrance(page).click();
    await page.waitForURL(overlayOpen);
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(offers(page)).toHaveCount(0);
    const started = page.waitForResponse(
      (r) =>
        /\/api\/work-items\/[^/]+\/ai\/plan$/.test(pathOf(r)) && r.request().method() === 'POST',
    );
    await composer(page).fill('plan this');
    await sendButton(page).click();
    expect((await started).status()).toBe(200);
    await expect(offers(page)).toHaveCount(0);
    await expect.poll(() => planEntries().length).toBe(before + 1);
    const session = await adminDb.planChangeSession.findFirstOrThrow({
      where: { createdById: userId, targetKeys: { has: seed.notifKey } },
    });
    expect((await turnsOf(session.id)).find((t) => t.role === 'user')?.body).toBe('plan this');
    expect(await plansOf(session.id)).toBe(1);
    await expect
      .poll(
        async () =>
          (await adminDb.workItem.findFirstOrThrow({ where: { identifier: seed.notifKey } }))
            .status,
      )
      .toBe('planning');
    await expect(offers(page)).toHaveCount(0);
    await beat();
    await closeOverlay(page);
  });

  // ── 6 · MID-PLANNING ──────────────────────────────────────────────────────
  let successorId = '';
  await chapter('Mid-planning, "plan something else" is the same offer', async () => {
    await page.goto(
      withPlanningOverlay('/dashboard', { kind: 'project', sessionId: conversationId }),
    );
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    queueAsk(offering(IMPORT_ANSWER, IMPORT_REQUEST));
    await ask(page, IMPORT);
    await expect(answer(page, IMPORT_ANSWER)).toHaveCount(1);
    const offer = latestOffer(page);
    await expect(offer).toHaveAttribute('data-offer-state', 'undecided');
    await expect(offer).toContainText(copy.labelMidPlanning);
    await expect(byId(page, 'plan-offer-mid-planning')).toContainText(copy.midPlanning);
    await expect(rail(page).getByText(restart.confirm.body)).toHaveCount(0);
    await expect(byId(page, 'planning-restart-confirm-turn')).toHaveCount(0);
    await beat();

    const before = planEntries().length;
    const started = await pressConfirm(page);
    successorId = started.sessionId;
    expect(successorId).not.toBe(conversationId);
    await expect.poll(() => planEntries().length).toBe(before + 1);
    // A fresh plan, not a revision of the one this conversation held.
    expect(planEntries().at(-1)!.planId).toBeUndefined();
    const original = await sessionRow(conversationId);
    expect(original.endedAt).not.toBeNull();
    expect(original.endReason).toBe('restarted');
    expect(await plansOf(conversationId)).toBe(1);
    expect(await plansOf(successorId)).toBe(1);
    expect(
      (await turnsOf(successorId)).filter((t) => t.role === 'user').map((t) => t.body),
    ).toEqual([IMPORT_REQUEST]);
    await beat();

    await page.goto('/plans');
    await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.locator(`[data-session-row="${successorId}"]`)).toHaveCount(1);
    await beat();
  });

  // ── 7 · THE OFFER SURVIVES A REOPEN ───────────────────────────────────────
  await chapter('An offer is still there after the overlay is reopened', async () => {
    await page.goto(withPlanningOverlay('/dashboard', { kind: 'project', sessionId: successorId }));
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    queueAsk(offering(LATER_ANSWER, LATER_REQUEST));
    await ask(page, LATER);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'undecided');
    const offerTurn = await latestAnswerRow(successorId);
    await closeOverlay(page);

    await openProjectThread(page);
    await expect(latestOffer(page)).toHaveAttribute('data-offer-state', 'undecided', {
      timeout: FIRST_PAINT_MS,
    });
    await expect(latestOffer(page).getByTestId('plan-offer-request')).toContainText(LATER_REQUEST);
    await expect(confirmButton(page)).toBeVisible();
    // The same stored offer row, and no answer was written by reopening.
    const after = await latestAnswerRow(successorId);
    expect(after.id).toBe(offerTurn.id);
    expect(after.stored).toEqual(offerTurn.stored);
    await beat();

    const before = planEntries().length;
    await pressConfirm(page);
    await expect.poll(() => planEntries().length).toBe(before + 1);
    expect(planEntries()).toHaveLength(before + 1);
    await beat();
  });
});

// ═══ Exactly once (unrecorded) ═══════════════════════════════════════════════

test('Confirm pressed twice, and Confirm then a typed yes, each start one plan', async ({
  page,
}) => {
  const userId = seed.ctx.userId;
  const REQUEST = 'Plan the notifications digest.';

  // Confirm, then the same press again (a second tab, a double click): one start.
  queueAsk(offering('I can plan the digest.', REQUEST));
  await page.goto('/dashboard');
  await openProjectThread(page);
  await ask(page, 'can we plan the digest?');
  const first = (await openConversation(userId)).id;
  const offerTurn = await latestAnswerRow(first);
  const started = await pressConfirm(page);
  const again = await page.request.post(CONFIRM, {
    data: { sessionId: first, offerTurnId: offerTurn.id },
  });
  expect(again.status(), await again.text()).toBe(200);
  expect(((await again.json()) as { planId: string }).planId).toBe(started.planId);
  await expect.poll(() => planEntries().length).toBe(1);
  expect(planEntries()).toHaveLength(1);
  expect(await plansOf(first)).toBe(1);

  // A second conversation: Confirm, then a typed yes to the same offer — still one.
  await expect(restartControl(page)).toBeEnabled({ timeout: 60_000 });
  const raised = posted(page, '/api/ai/plan-change/session/restart/confirm');
  await restartControl(page).click();
  expect((await raised).status()).toBe(200);
  const restarted = posted(page, '/api/ai/plan-change/session/restart');
  await byId(page, 'planning-restart-confirm').click();
  const swapped = (await (await restarted).json()) as { session: { id: string } };
  const second = swapped.session.id;

  queueAsk(offering('I can plan the billing page.', 'Plan the billing page.'));
  await ask(page, 'and the billing page?');
  const secondOffer = await latestAnswerRow(second);
  await pressConfirm(page);
  await expect.poll(() => planEntries().length).toBe(2);
  queueAsk({
    intent: 'ask',
    answer: 'It is already being planned.',
    offerReply: { seq: secondOffer.seq, kind: 'plan', decision: 'agree' },
  });
  expect((await ask(page, 'yes, plan it')).outcome).toBe('answered');
  expect(planEntries()).toHaveLength(2);
  expect(await plansOf(second)).toBe(1);
});

// ═══ In Chinese (unrecorded) ═════════════════════════════════════════════════

test('in Chinese, the offer and its confirmed state render from the zh catalogue', async ({
  page,
}) => {
  const userId = seed.ctx.userId;
  const REQUEST = '为登录界面规划一个修复。';
  queueAsk({
    intent: 'ask',
    answer: '我可以规划这个修复。',
    offer: { kind: 'plan', requestText: REQUEST, immediate: false },
  });
  await setReaderLanguage(page, seed.email, 'zh');
  await page.goto('/dashboard');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh', { timeout: FIRST_PAINT_MS });
  await openProjectThread(page, new RegExp(zh.shell.aiCallout.actions.ask.title));
  await ask(page, '其实我想为它规划一个修复', zh.planningWorkspace.conversation.send);

  const offer = latestOffer(page);
  await expect(offer).toHaveAttribute('data-offer-state', 'undecided');
  await expect(offer).toContainText(zcopy.label);
  await expect(confirmButton(page)).toHaveText(zcopy.confirm);
  await expect(declineButton(page)).toHaveText(zcopy.decline);
  for (const english of [copy.label, copy.confirm, copy.decline, copy.declineHelp]) {
    await expect(offer).not.toContainText(english);
  }

  await pressConfirm(page);
  await expect(offer.getByTestId('plan-offer-confirmed')).toContainText(zcopy.started);
  await expect(offer).not.toContainText(copy.started);
  const conversation = (await openConversation(userId)).id;
  expect(planEntries()).toHaveLength(1);
  expect(await plansOf(conversation)).toBe(1);
});
