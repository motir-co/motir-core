import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanProgress, PLAN_PROGRESS_PASSWORD } from './_helpers/plan-progress-seed';
import { startSseFrameServer, type SseFrameServer } from './_helpers/sse-frame-server';
import { declareJobs, routeJobStream, stubAiAccess } from './_helpers/plan-narration-doors';
import {
  ASK,
  COPY,
  PLANNER_QUESTION,
  PLANNER_REPLY,
  Q1,
  Q2,
  Q3,
  SCRIPT,
  act,
  answerLine,
  ask,
  assumptionLine,
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
  planRequirement,
  question,
  rail,
  readingButton,
  recommended,
  recordSharpenPosts,
  settleTarget,
  sharpenTurnSettled,
  summary,
  thread,
} from './_helpers/grill-me-journey';

// MOTIR-8179 — the ACCEPTANCE VIDEO for Story MOTIR-1101 ("Grill me").
//
// One watchable journey: a person opens the planning overlay from a card, turns
// Grill me on, sends their request, answers the planner's questions one at a
// time — picks a reading, skips one, stops — sees what they settled, watches the
// control step aside when planning starts, and finds the answers on the card
// after a reload. The regression cases (off by default, nothing to ask, the
// error, re-entry, a new session) are `cloud-grill-me.spec.ts`'s; this spec is
// the receipt, and the lane publishes it from a green PR run.
//
// What is real and what is SCRIPTED is `_helpers/grill-me-journey.ts`'s header:
// a real anchored plan run held in its conversation phase by the SSE frame
// server, the real Sharpen door and write-back, and motir-ai's `sharpen_turn`
// played from a script — so nothing asserts which question motir-ai would
// choose. Every act waits on the settle that stored its turn before the next
// assertion; `chapter()` / `beat()` holds are pacing for a viewer only.

test.describe.configure({ timeout: 240_000 });

let sse: SseFrameServer;

test.beforeEach(async () => {
  await resetDatabase();
  sse = await startSseFrameServer();
});

test.afterEach(async () => {
  await sse.close();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

test('Grill me: the planner asks before it plans — pick, skip, stop, and the answers land on the plan and the card', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1101');
  declareJobs(PLANNER_REPLY, PLANNER_QUESTION);
  declareSharpen(SCRIPT);
  const seed = await seedPlanProgress(`grill-receipt-${Date.now()}`);
  await stubAiAccess(page);
  await routeJobStream(page, sse);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
  const posts = recordSharpenPosts(page);
  let planId = '';
  const picked = Q1.readings[1]!;

  await chapter('Plan from a card — Grill me is there, and off', async () => {
    await openPlanningFromCard(page, seed.storyKey, FIRST_PAINT_MS);
    await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await grillHelp(page).click();
    await expect(grillExplanation(page)).toContainText(COPY.control.popover.body1);
    await beat();
    await page.keyboard.press('Escape');
    await expect(grillExplanation(page)).toHaveCount(0);
  });

  await chapter('Turn it on — nothing starts until the next message', async () => {
    await grillSwitch(page).click();
    await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(rail(page).getByTestId('grill-me-hint')).toHaveText(COPY.control.hint);
    expect(posts).toHaveLength(0);
  });

  await chapter('Send the request — one question at a time, with answers to pick', async () => {
    const firstTurn = sharpenTurnSettled(page);
    ({ planId } = await ask(page, sse, seed.reader.email, ASK));
    expect((await firstTurn).outcome).toBe('settled');
    await expect(conversationPhase(page)).toBeVisible();
    await expect(question(page)).toHaveCount(1);
    await expect(question(page)).toContainText(Q1.text);
    for (const r of Q1.readings) await expect(readingButton(page, r.id)).toBeVisible();
    await beat();
  });

  await chapter('Pick an answer — the next question follows from it', async () => {
    await act(page, readingButton(page, picked.id));
    await expect(question(page)).toContainText(Q2.text);
    await expect(thread(page)).toContainText(picked.label);
  });

  await chapter('Skip one — the planner will assume its recommendation', async () => {
    await act(page, question(page).getByTestId('sharpen-skip'));
    await expect(thread(page)).toContainText(COPY.sharpen.markers.skipped);
    await expect(question(page)).toContainText(Q3.text);
  });

  await chapter('Stop grilling — what was settled is kept', async () => {
    await act(page, question(page).getByTestId('sharpen-stop'));
    await expect(thread(page).getByTestId('sharpen-stopped')).toHaveText(
      COPY.sharpen.markers.stopped,
    );
    await expect(summary(page)).toContainText(picked.label);
    const assumptions = summary(page).getByTestId('sharpen-summary-assumptions');
    await expect(assumptions).toContainText(Q2.text);
    await expect(assumptions).toContainText(recommended(Q2).label);
    await expect(summary(page)).not.toContainText(Q3.text);
    await expect(rail(page).getByTestId('sharpen-written')).toBeVisible();
    await beat();
  });

  await chapter('Planning starts — Grill me steps aside', async () => {
    await settleTarget(page, sse);
    await expect(handoff(page)).toBeVisible();
    await expect(grillToggle(page)).toHaveCount(0);
    await expect(composer(page)).toBeEnabled();
    // The requirement has no rendered surface; the plan row is its authority.
    const requirement = await planRequirement(planId);
    expect(requirement?.behaviour).toBe(`- ${answerLine(Q1, picked.label)}`);
    expect(requirement?.plannerAssumptions).toEqual([
      { question: Q2.text, recommendation: recommended(Q2).label },
    ]);
  });

  await chapter('Reload the card — the answers are on it', async () => {
    await expectCardCarries(
      page,
      seed.storyKey,
      [answerLine(Q1, picked.label)],
      [assumptionLine(Q2)],
      FIRST_PAINT_MS,
    );
    await beat();
  });
});
