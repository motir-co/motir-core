import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  addPlanProgressStory,
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
  type PlanProgressSeed,
} from './_helpers/plan-progress-seed';
import { startSseFrameServer, type SseFrameServer } from './_helpers/sse-frame-server';
import {
  askFromCard,
  declareJobs,
  routeJobStream,
  stubAiAccess,
} from './_helpers/plan-narration-doors';
import {
  ASK,
  COPY,
  PLANNER_ANSWER,
  PLANNER_QUESTION,
  PLANNER_REPLY,
  Q1,
  Q2,
  Q3,
  Q4,
  SCRIPT,
  act,
  answerLine,
  ask,
  assumptionLine,
  cardBody,
  composer,
  conversationPhase,
  declareSharpen,
  expectCardCarries,
  grillExplanation,
  grillHelp,
  grillSwitch,
  grillToggle,
  handoff,
  openPlanningFromCard,
  planPolled,
  planRequirement,
  question,
  rail,
  readSharpen,
  readingButton,
  recommended,
  recordSharpenPosts,
  settleTarget,
  sharpenDoorAnswered,
  sharpenTurnSettled,
  summary,
  thread,
} from './_helpers/grill-me-journey';

// MOTIR-8179 — the "Grill me" E2E for Story MOTIR-1101.
//
// Every case drives the PLANNING OVERLAY opened from a work item, so the run is
// anchored on that card, and asserts what a person sees there — and, after a
// reload, what landed on the plan and on the card. No case opens a Sharpen entry
// on a plan review page or a work item page: Grill me is a MODE of the planning
// conversation, and that is the only door it has.
//
// What is real and what is scripted is `_helpers/grill-me-journey.ts`'s header:
// a real anchored plan run held in its conversation phase by the SSE frame
// server, the real Sharpen door and write-back, and motir-ai's `sharpen_turn`
// played from a SCRIPT — so nothing here asserts which question motir-ai would
// choose. `regression-grill-me.spec.ts` is the same journey recorded as the
// story's receipt.
//
// ── Determinism ─────────────────────────────────────────────────────────────
// Every grilling act arms a wait for the settle that STORED its turn
// (`outcome !== 'pending'`) before the click, and asserts after it. An ABSENCE
// (no request, no question) is asserted only after a LATER authoritative signal
// than the render that would have caused it — the run's own plan poll. The
// conversation phase's end is a frame the spec writes, and its visible effect
// (the hand-off bubble) is what the next step waits on. Nothing sleeps.

test.describe.configure({ timeout: 180_000 });

let sse: SseFrameServer;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  sse = await startSseFrameServer();
  declareJobs(PLANNER_REPLY, PLANNER_QUESTION);
  await stubAiAccess(page);
  await routeJobStream(page, sse);
});

test.afterEach(async () => {
  await sse.close();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedAndSignIn(page: Parameters<typeof signIn>[0]): Promise<PlanProgressSeed> {
  const seed = await seedPlanProgress(`grill-${Date.now()}`);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
  return seed;
}

test('off by default, the "?" explains it, and a request with it off asks nothing', async ({
  page,
}) => {
  declareSharpen(SCRIPT);
  const seed = await seedAndSignIn(page);
  const posts = recordSharpenPosts(page);
  await openPlanningFromCard(page, seed.storyKey, FIRST_PAINT_MS);

  // Opt-in, off by default.
  await expect(grillToggle(page)).toBeVisible();
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');

  // The "?" opens the explanation, and it closes again.
  await expect(grillHelp(page)).toHaveAttribute('aria-expanded', 'false');
  await grillHelp(page).click();
  await expect(grillExplanation(page)).toBeVisible();
  await expect(grillExplanation(page)).toHaveAttribute('data-testid', 'grill-me-explanation');
  await expect(grillExplanation(page)).toContainText(COPY.control.popover.body1);
  await expect(grillHelp(page)).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(grillExplanation(page)).toHaveCount(0);
  await expect(grillHelp(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');

  // A request with it off runs as today: the conversation phase, no question.
  const { planId } = await ask(page, sse, seed.reader.email, ASK);
  await expect(conversationPhase(page)).toBeVisible();
  await planPolled(page, planId);
  await expect(question(page)).toHaveCount(0);
  await expect(thread(page)).toHaveCount(0);
  expect(posts, 'no Sharpen session was opened').toHaveLength(0);
  expect(readSharpen().submitted ?? []).toHaveLength(0);

  // Mid-planning is unchanged: the composer stays live while the run plans.
  await settleTarget(page, sse);
  await expect(composer(page)).toBeEnabled();
  await expect(planRequirement(planId)).resolves.toBeNull();
});

test('grilled before planning: one question at a time, pick, skip, you decide, stop — kept, handed off, written to the plan and the card', async ({
  page,
}) => {
  declareSharpen(SCRIPT);
  const seed = await seedAndSignIn(page);
  const posts = recordSharpenPosts(page);
  await openPlanningFromCard(page, seed.storyKey, FIRST_PAINT_MS);
  const before = await cardBody(seed.storyKey);

  // ── Turning it on starts nothing by itself ──
  await grillSwitch(page).click();
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(rail(page).getByTestId('grill-me-hint')).toHaveText(COPY.control.hint);
  await expect(question(page)).toHaveCount(0);
  expect(posts, 'turning it on sends nothing').toHaveLength(0);
  expect(readSharpen().submitted ?? []).toHaveLength(0);

  // ── The next message starts it: one question, with readings ──
  const opened = sharpenDoorAnswered(page);
  const firstTurn = sharpenTurnSettled(page);
  const { planId } = await ask(page, sse, seed.reader.email, ASK);
  const openRes = await opened;
  expect(openRes.status()).toBe(200);
  expect(openRes.request().postDataJSON(), 'the session is over the run’s own plan').toEqual({
    planId,
  });
  expect((await firstTurn).outcome).toBe('settled');
  await expect(conversationPhase(page)).toBeVisible();
  await expect(question(page)).toHaveCount(1);
  await expect(question(page)).toContainText(Q1.text);
  for (const r of Q1.readings) await expect(readingButton(page, r.id)).toBeVisible();
  expect(Q1.readings.length).toBeGreaterThanOrEqual(2);

  // ── Pick narrows to the next question ──
  const picked = Q1.readings[1]!;
  const afterPick = await act(page, readingButton(page, picked.id));
  expect(afterPick.session.settled.map((s) => s.questionId)).toEqual([Q1.id]);
  await expect(question(page)).toHaveCount(1);
  await expect(question(page)).toContainText(Q2.text);
  await expect(question(page)).not.toContainText(Q1.text);
  await expect(thread(page)).toContainText(picked.label);

  // ── Skip is recorded as the planner's assumption ──
  const afterSkip = await act(page, question(page).getByTestId('sharpen-skip'));
  expect(afterSkip.session.assumptions.map((a) => a.questionId)).toEqual([Q2.id]);
  await expect(thread(page)).toContainText(COPY.sharpen.markers.skipped);
  await expect(question(page)).toContainText(Q3.text);

  // ── "You decide" likewise ──
  const afterDecide = await act(page, question(page).getByTestId('sharpen-you-decide'));
  expect(afterDecide.session.assumptions.map((a) => a.questionId)).toEqual([Q2.id, Q3.id]);
  const assumed = thread(page).getByTestId('sharpen-assumption');
  await expect(assumed).toHaveCount(1);
  await expect(assumed).toContainText(COPY.sharpen.summary.plannersAssumption);
  await expect(assumed).toContainText(recommended(Q3).label);
  await expect(question(page)).toContainText(Q4.text);

  // ── Stop midway keeps what was settled ──
  const stopped = await act(page, question(page).getByTestId('sharpen-stop'));
  expect(stopped.session.endReason).toBe('stopped');
  await expect(question(page)).toHaveCount(0);
  await expect(thread(page).getByTestId('sharpen-stopped')).toHaveText(
    COPY.sharpen.markers.stopped,
  );
  await expect(summary(page)).toContainText(Q1.text);
  await expect(summary(page)).toContainText(picked.label);
  const assumptions = summary(page).getByTestId('sharpen-summary-assumptions');
  await expect(assumptions).toContainText(Q2.text);
  await expect(assumptions).toContainText(recommended(Q2).label);
  await expect(assumptions).toContainText(Q3.text);
  // Nothing for the question nobody answered.
  await expect(summary(page)).not.toContainText(Q4.text);
  await expect(rail(page).getByTestId('sharpen-written')).toBeVisible();
  const writeBacks = readSharpen().writeBacks ?? [];
  expect(writeBacks.map((w) => w.status)).toEqual([200]);

  // ── The control hides at the hand-off; the composer stays live ──
  await settleTarget(page, sse);
  await expect(conversationPhase(page)).toHaveCount(0);
  await expect(grillToggle(page)).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
  // The ended session's summary stays above the hand-off.
  await expect(summary(page)).toBeVisible();
  await expect(handoff(page)).toBeVisible();

  // ── Written back to the plan … ──
  const requirement = await planRequirement(planId);
  expect(requirement?.behaviour).toBe(`- ${answerLine(Q1, picked.label)}`);
  expect(requirement?.plannerAssumptions).toEqual([
    { question: Q2.text, recommendation: recommended(Q2).label },
    { question: Q3.text, recommendation: recommended(Q3).label },
  ]);

  // ── … and to the card the run is anchored on, after a reload ──
  expect(before ?? '').not.toContain('Acceptance criteria');
  await expectCardCarries(
    page,
    seed.storyKey,
    [answerLine(Q1, picked.label)],
    [assumptionLine(Q2), assumptionLine(Q3)],
    FIRST_PAINT_MS,
  );
  await expect(page.getByRole('main').getByLabel('Work item description')).not.toContainText(
    Q4.text,
  );
});

test('nothing to ask: the session says so, asks no question, and the card is unchanged', async ({
  page,
}) => {
  declareSharpen({ mode: 'determinate' });
  const seed = await seedAndSignIn(page);
  await openPlanningFromCard(page, seed.storyKey, FIRST_PAINT_MS);
  const before = await cardBody(seed.storyKey);

  await grillSwitch(page).click();
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
  const turn = sharpenTurnSettled(page);
  const { planId } = await ask(page, sse, seed.reader.email, ASK);
  const settled = await turn;
  expect(settled.session.endReason).toBe('nothing_to_ask');

  await expect(rail(page).getByTestId('sharpen-nothing-to-ask')).toHaveText(
    COPY.sharpen.markers.nothingToAsk,
  );
  await expect(question(page)).toHaveCount(0);
  await expect(summary(page)).toHaveCount(0);
  expect(readSharpen().writeBacks ?? []).toHaveLength(0);

  await page.reload();
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  expect(await cardBody(seed.storyKey)).toBe(before);
  await expect(planRequirement(planId)).resolves.toBeNull();
});

test('a failed turn shows the error, and the card is unchanged', async ({ page }) => {
  declareSharpen({ mode: 'error', detail: 'The fixture failed this sharpen turn.' });
  const seed = await seedAndSignIn(page);
  await openPlanningFromCard(page, seed.storyKey, FIRST_PAINT_MS);
  const before = await cardBody(seed.storyKey);

  await grillSwitch(page).click();
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
  const turn = sharpenTurnSettled(page);
  const { planId } = await ask(page, sse, seed.reader.email, ASK);
  expect((await turn).outcome).toBe('failed');

  const error = rail(page).getByTestId('sharpen-error');
  await expect(error.getByRole('alert')).toHaveText(COPY.sharpen.error);
  await expect(question(page)).toHaveCount(0);
  expect(readSharpen().writeBacks ?? []).toHaveLength(0);

  await page.reload();
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  expect(await cardBody(seed.storyKey)).toBe(before);
  await expect(planRequirement(planId)).resolves.toBeNull();
});

test('re-entry restores the choice: a new run back in its conversation phase shows the control, still on', async ({
  page,
}) => {
  declareSharpen(SCRIPT);
  const seed = await seedAndSignIn(page);
  await openPlanningFromCard(page, seed.storyKey, FIRST_PAINT_MS);

  await grillSwitch(page).click();
  const firstTurn = sharpenTurnSettled(page);
  const { sessionId } = await ask(page, sse, seed.reader.email, ASK);
  await firstTurn;
  await expect(question(page)).toContainText(Q1.text);
  await act(page, question(page).getByTestId('sharpen-stop'));
  await expect(thread(page).getByTestId('sharpen-stopped')).toBeVisible();

  // The run settles its target → planning; the control is not rendered.
  await settleTarget(page, sse);
  await expect(grillToggle(page)).toHaveCount(0);

  // The run ends asking the person a question (the jobs fixture's reply), and the
  // person's answer starts a NEW plan job — a new run, back in its conversation
  // phase until that job's own `target_settled` arrives.
  sse.done();
  await expect(handoff(page)).toHaveCount(0);
  await expect(rail(page).getByText(PLANNER_QUESTION).first()).toBeVisible();
  await askFromCard(page, sse, composer(page), PLANNER_ANSWER);

  await expect(conversationPhase(page)).toBeVisible();
  await expect(grillToggle(page)).toBeVisible();
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
  expect(
    await page.evaluate((id) => window.sessionStorage.getItem(`motir.grillMe.${id}`), sessionId),
  ).toBe('on');
});

test('a new planning session starts with Grill me off', async ({ page }) => {
  declareSharpen(SCRIPT);
  const seed = await seedAndSignIn(page);
  const other = await addPlanProgressStory(seed, 'Import a board from CSV');
  await openPlanningFromCard(page, seed.storyKey, FIRST_PAINT_MS);

  await grillSwitch(page).click();
  const firstTurn = sharpenTurnSettled(page);
  const { sessionId } = await ask(page, sse, seed.reader.email, ASK);
  await firstTurn;
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
  // The choice is held against THAT session.
  expect(
    await page.evaluate((id) => window.sessionStorage.getItem(`motir.grillMe.${id}`), sessionId),
  ).toBe('on');

  // A fresh planning session — another card's overlay, in the same tab.
  await openPlanningFromCard(page, other.key, FIRST_PAINT_MS);
  await expect(grillToggle(page)).toBeVisible();
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
});
