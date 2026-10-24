// Acceptance E2E — Plan something new from inside the overlay (Subtask MOTIR-7653,
// Story MOTIR-7631; `conversation-turn-intent.md` AMENDMENT 3).
//
// The walk: an open session on a card shows *Plan something new* in the rail
// head; pressing it asks first, and *Keep planning* changes nothing. Pressing it
// again and confirming closes the session, gives the card back, and opens a new
// empty session in place — the overlay never closes. On the project thread the
// person's WORDS are ANSWERED like any turn (AMENDMENT 5 · MOTIR-9231) and write no
// confirm; the control there raises it, and Confirm opens another new session.
// The card session reached planning — a card's first turn always opens a plan — so
// Plans lists it; the project thread only asked, so Plans does not (MOTIR-9217: a
// conversation that never proposed a plan is a question that was answered).
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'), where
// the motir-ai JOBS boundary is mocked UNDER the routes (`lib/test-ai-jobs-mock.ts`).
// The project thread's second ask job answers the words, as motir-ai now does.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a turn's
// text, a component state or the response of a request the page issued, and every
// step is checked against the database as well as the page. `beat()` / the
// chapter hold are PACING only, each after the assertion that proved the state.
import { writeFileSync } from 'node:fs';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { latestPlanningSession } from './_helpers/planChangeConversation';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

const restart = en.planningWorkspace.restart;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI', exact: true });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const control = (page: Page) => rail(page).getByTestId('planning-restart-control');
const confirmTurn = (page: Page) => rail(page).getByTestId('planning-restart-confirm-turn');
const confirmButton = (page: Page) => rail(page).getByTestId('planning-restart-confirm');
const keepButton = (page: Page) => rail(page).getByTestId('planning-restart-keep');
const kept = (page: Page) => rail(page).getByTestId('planning-restart-kept');
const earlier = (page: Page) => rail(page).getByTestId('planning-restart-earlier');

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** What the project thread answers to "plan something new". */
const WORDS_ANSWER = 'This conversation plans the export card. Plan something new starts another.';

/** The card's run closes as a plain success; the project thread's two turns — a
 *  question and "plan something new" — are both answered. */
function declareJobs(): void {
  writeFileSync(
    JOBS_FIXTURE,
    JSON.stringify(
      {
        ask: [
          { intent: 'ask', answer: 'Nothing is blocked right now.', citations: [] },
          { intent: 'ask', answer: WORDS_ANSWER, citations: [] },
        ],
        plan: [{ status: 'succeeded' }],
        submitted: [],
      },
      null,
      2,
    ),
  );
}

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

// ── Persisted state ──────────────────────────────────────────────────────────

async function cardStatus(key: string): Promise<string> {
  const card = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: key },
    select: { status: true },
  });
  return card.status;
}

async function sessionRow(id: string) {
  return adminDb.planChangeSession.findUniqueOrThrow({
    where: { id },
    select: { endedAt: true, endReason: true, copiedFromSessionId: true },
  });
}

async function turnCount(sessionId: string): Promise<number> {
  return adminDb.planChangeTurn.count({ where: { sessionId } });
}

async function planCount(sessionId: string): Promise<number> {
  return adminDb.plan.count({ where: { sessionId } });
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Send a turn from a CARD — its 200 is the authoritative "the session holds it". */
async function sendFromCard(page: Page, text: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await sent).status()).toBe(200);
  await expect(rail(page).getByText(text).first()).toBeVisible();
}

/** Send on the PROJECT thread — the ask door's 200, then the settle that files it. */
async function askOnProject(page: Page, text: string): Promise<void> {
  const asked = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
  );
  const settled = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask/settle' && r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await asked).status()).toBe(200);
  expect((await settled).status()).toBe(200);
  await expect(rail(page).getByText(text).first()).toBeVisible();
}

/** Press the control; the confirm POST's 200 is the signal the turn was written. */
async function pressControl(page: Page): Promise<void> {
  await expect(control(page)).toBeEnabled({ timeout: 60_000 });
  const raised = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session/restart/confirm' &&
      r.request().method() === 'POST',
  );
  await control(page).click();
  expect((await raised).status()).toBe(200);
}

/** Answer the confirm; returns the restart door's JSON. */
async function answer(page: Page, which: 'keep' | 'confirm'): Promise<Record<string, unknown>> {
  const answered = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session/restart' &&
      r.request().method() === 'POST',
  );
  await (which === 'keep' ? keepButton(page) : confirmButton(page)).click();
  const res = await answered;
  expect(res.status()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

test.beforeEach(async () => {
  await resetDatabase();
  declareJobs();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('Plan something new closes the session, gives the card back, and opens a new one in place', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7631');

  const email = `plan-something-new-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  const key = seed.storyKey;
  const before = await cardStatus(key);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const CARD_TURN = 'Split this story so the canvas work can ship on its own.';
  const QUESTION = 'Is anything blocked right now?';
  const WORDS = 'Forget this, I want to plan something new.';
  let cardSessionId = '';
  let projectSessionId = '';

  await chapter('An open session on the card shows Plan something new', async () => {
    await openFromCard(page, key);
    await sendFromCard(page, CARD_TURN);
    cardSessionId = (await latestPlanningSession(email)).id;
    await expect.poll(() => cardStatus(key)).toBe('planning');

    await expect(control(page)).toBeVisible();
    await expect(control(page)).toContainText(restart.control);
    await beat();
  });

  await chapter('It asks first, and Keep planning changes nothing', async () => {
    await pressControl(page);
    await expect(confirmTurn(page)).toContainText(restart.confirm.body);
    // PERSISTED: asking closed nothing.
    expect((await sessionRow(cardSessionId)).endedAt).toBeNull();
    expect(await cardStatus(key)).toBe('planning');
    await beat();

    const keptBody = await answer(page, 'keep');
    expect(keptBody['id']).toBe(cardSessionId);
    await expect(kept(page)).toContainText(restart.kept);
    await expect(confirmButton(page)).toHaveCount(0);
    await expect(control(page)).toBeVisible();

    // PERSISTED: the same session, still open, still holding the card.
    expect((await sessionRow(cardSessionId)).endedAt).toBeNull();
    expect(await cardStatus(key)).toBe('planning');
    expect((await latestPlanningSession(email)).id).toBe(cardSessionId);
    await beat();
  });

  await chapter(
    'Confirm — a new empty session opens in place, and the card is given back',
    async () => {
      await pressControl(page);
      await expect(confirmButton(page)).toBeVisible();
      const swapped = await answer(page, 'confirm');
      expect(swapped).toMatchObject({ outcome: 'restarted', endedSessionId: cardSessionId });
      const fresh = (swapped['session'] as { id: string }).id;
      expect(fresh).not.toBe(cardSessionId);

      // The overlay never closed; the rail now draws the new session.
      expect(overlayOpen(new URL(page.url()))).toBe(true);
      await expect(workspace(page)).toBeVisible();
      await expect(earlier(page)).toContainText(restart.earlier);
      await expect(rail(page).getByText(CARD_TURN)).toHaveCount(0);
      await expect(composer(page)).toBeEnabled();

      // PERSISTED: the old session ended `restarted`, the new one is empty and
      // carries nothing across, and the card is back where it was.
      expect(await sessionRow(cardSessionId)).toMatchObject({ endReason: 'restarted' });
      expect((await sessionRow(cardSessionId)).endedAt).not.toBeNull();
      expect(await sessionRow(fresh)).toMatchObject({ endedAt: null, copiedFromSessionId: null });
      expect(await turnCount(fresh)).toBe(0);
      await expect.poll(() => cardStatus(key)).toBe(before);
      await beat();

      await page.keyboard.press('Escape');
      await page.waitForURL(overlayClosed);
      await expect(workspace(page)).toHaveCount(0);
    },
  );

  await chapter(
    'On the project thread, the words are answered and the control restarts',
    async () => {
      await expect(orb(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await orb(page).click();
      await calloutPanel(page)
        .getByRole('link', { name: /Ask about this project/ })
        .click();
      await page.waitForURL(overlayOpen);
      await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(rail(page)).toBeVisible();

      await askOnProject(page, QUESTION);
      await expect(rail(page).getByText('Nothing is blocked right now.')).toBeVisible();
      projectSessionId = (await latestPlanningSession(email)).id;
      expect(projectSessionId).not.toBe(cardSessionId);
      await beat();

      // The words are READ and answered: no confirm, nothing closed.
      await askOnProject(page, WORDS);
      await expect(rail(page).getByText(WORDS_ANSWER)).toBeVisible();
      await expect(confirmTurn(page)).toHaveCount(0);
      expect((await sessionRow(projectSessionId)).endedAt).toBeNull();
      await beat();

      // The control is the door to the confirm.
      await pressControl(page);
      await expect(confirmTurn(page)).toContainText(restart.confirm.body);
      await beat();

      const swapped = await answer(page, 'confirm');
      expect(swapped).toMatchObject({ outcome: 'restarted', endedSessionId: projectSessionId });
      const fresh = (swapped['session'] as { id: string }).id;
      await expect(earlier(page)).toBeVisible();
      await expect(rail(page).getByText(QUESTION)).toHaveCount(0);
      expect(overlayOpen(new URL(page.url()))).toBe(true);

      expect(await sessionRow(projectSessionId)).toMatchObject({ endReason: 'restarted' });
      expect(await turnCount(fresh)).toBe(0);
      await beat();
    },
  );

  await chapter(
    'Plans: the card session reached planning and is listed, the project thread is not',
    async () => {
      // A card's first turn is a planning submit, so the card session holds the plan
      // it opened and ended `restarted` (MOTIR-9303's recorded deviation). The project
      // thread asked questions only and holds none. The Plans list serves only sessions
      // holding a plan (MOTIR-9217 · MOTIR-9300), so it lists the first and not the second.
      expect(await planCount(cardSessionId)).toBe(1);
      expect(await sessionRow(cardSessionId)).toMatchObject({ endReason: 'restarted' });
      expect(await planCount(projectSessionId)).toBe(0);
      await page.goto('/plans');
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.locator(`[data-session-row="${cardSessionId}"]`)).toHaveCount(1);
      await expect(page.locator(`[data-session-row="${projectSessionId}"]`)).toHaveCount(0);
      await beat();
    },
  );
});
