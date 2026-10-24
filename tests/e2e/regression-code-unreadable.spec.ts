// Acceptance E2E — an unreadable code graph, as a person sees it (Subtask MOTIR-8144,
// Story MOTIR-8136).
//
// Runs under `playwright.acceptance.config.ts` (MOTIR_CLOUD + `video: 'on'`) — the lane
// where the planning overlay mounts at all. `acceptanceStory()` pins the clip to the story.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Planning while Motir cannot read the project's code. A request to change the plan is
// answered with a calm "I can't read your code right now" — nothing was written, the plan
// on the canvas is exactly as it was, and Try again is on the turn. A question is still
// answered, with a notice above the answer saying nothing about the code in it is
// confirmed. Reload the page and both are still there. When the code can be read again,
// new turns are ordinary — and the two earlier turns keep their notice.
//
// ── HOW motir-ai IS STOOD IN FOR ────────────────────────────────────────────
//
// The browser run cannot stop the production graph service (MOTIR-7125's job). Motir-ai is
// replaced at the JOB boundary (`lib/test-ai-jobs-mock.ts`, MOTIR_AI_JOBS_FIXTURE_PATH),
// which settles the next plan or ask job WITH the outage signal — the same wire shape the
// integration gate records. The real routes, services and Postgres all run, which is what
// lets the reload beat prove persistence.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is the response that produced the
// turn or the rendered turn itself; `beat()` / the chapter hold are PACING only, each after
// the assertion that proved the state.
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

const outage = en.planningWorkspace.codeUnreadable;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI', exact: true });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const declinedNotice = (page: Page) => rail(page).getByTestId('plan-change-code-unreadable-notice');
const askNotice = (page: Page) => rail(page).getByTestId('plan-change-code-unreadable-ask-notice');
const retry = (page: Page) => rail(page).getByTestId('plan-change-code-unreadable-retry');
const canvasNodes = (page: Page) =>
  workspace(page).getByTestId('planning-canvas').locator('[data-node-id]');

const overlayOpen = (url: URL) => url.searchParams.has('plan');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

const SHORT_ANSWER = 'Billing runs through the invoice service.';
const LONG_ANSWER =
  `${'Billing runs through the invoice service, which reads the order, prices it and files the invoice. '.repeat(6)}`.trim();

/** Turn 1 is a change request (the classifier hands it to a plan job that HALTS on the
 *  outage, twice — the second is Try again), turns 2 and 3 are answered without the code,
 *  and after recovery everything is ordinary. */
function declareJobs(): void {
  writeFileSync(
    JOBS_FIXTURE,
    JSON.stringify(
      {
        ask: [
          { intent: 'plan_change', answer: null, citations: [] },
          { intent: 'ask', answer: SHORT_ANSWER, citations: [], codeUnreadable: true },
          { intent: 'ask', answer: LONG_ANSWER, citations: [], codeUnreadable: true },
          { intent: 'plan_change', answer: null, citations: [] },
          { intent: 'ask', answer: 'Everything reads normally now.', citations: [] },
        ],
        plan: [
          { codeUnreadable: true },
          { codeUnreadable: true },
          { turn: { message: 'Here is the plan I drafted.' } },
        ],
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

// ── Steps ────────────────────────────────────────────────────────────────────

async function openProjectThread(page: Page): Promise<void> {
  await expect(orb(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await orb(page).click();
  await calloutPanel(page)
    .getByRole('link', { name: /Ask about this project/ })
    .click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Send a turn the classifier reads as a change request; the planner-turn 200 is the
 *  authoritative "the settle filed the planner's turn". */
async function sendChange(page: Page, text: string): Promise<void> {
  const filed = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session/planner-turn' &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await filed).status()).toBe(200);
}

/** Send a question; its settle's 200 is the authoritative "the answer is filed". */
async function sendQuestion(page: Page, text: string): Promise<void> {
  const settled = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask/settle' && r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await settled).status()).toBe(200);
}

async function nodeIds(page: Page): Promise<string[]> {
  return canvasNodes(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-node-id') ?? '').sort(),
  );
}

async function storedFaces(): Promise<Array<string | null>> {
  const rows = await adminDb.planChangeTurn.findMany({
    where: { role: 'assistant' },
    orderBy: { seq: 'asc' },
    select: { codeUnreadable: true },
  });
  return rows.map((r) => r.codeUnreadable);
}

test.beforeEach(async () => {
  await resetDatabase();
  declareJobs();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('an unreadable code graph — no plan written, answers carry a notice, and it recovers', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8136');

  const email = `code-unreadable-${Date.now()}@example.com`;
  await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  let before: string[] = [];

  await chapter('Ask for a change while Motir cannot read the code', async () => {
    await page.goto('/dashboard');
    await openProjectThread(page);
    await expect(canvasNodes(page).first()).toBeVisible({ timeout: FIRST_PAINT_MS });
    before = await nodeIds(page);
    expect(before.length).toBeGreaterThan(0);

    await sendChange(page, 'Add a story for exporting invoices.');
    await expect(declinedNotice(page)).toContainText(outage.planBody);
    await expect(rail(page).getByText(outage.planMarker)).toBeVisible();
    // Information, not the failure treatment — and nothing to review.
    await expect(rail(page).getByRole('alert')).toHaveCount(0);
    await expect(rail(page).getByText(/didn.t go through/i)).toHaveCount(0);
    // The plan on the canvas is exactly what it was. The canvas reloads when the turn
    // settles, so the ids are polled until it has finished — the wait IS the assertion.
    await expect.poll(() => nodeIds(page)).toEqual(before);
    expect(await storedFaces()).toEqual(['declined']);
    await beat();
  });

  await chapter('Try again is on the turn, reachable by keyboard, and sends once', async () => {
    await expect(retry(page)).toBeVisible();
    await retry(page).focus();
    await expect(retry(page)).toBeFocused();
    const filed = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/ai/plan-change/session/planner-turn' &&
        r.request().method() === 'POST',
    );
    await page.keyboard.press('Enter');
    expect((await filed).status()).toBe(200);
    // The same outage still holds, so the retried run declines again — the earlier turn
    // keeps its notice and only the newest carries Try again.
    await expect(declinedNotice(page)).toHaveCount(2);
    await expect(retry(page)).toHaveCount(1);
    await expect.poll(() => nodeIds(page)).toEqual(before);
    await beat();
  });

  await chapter('A question is answered, with a notice above the answer', async () => {
    await sendQuestion(page, 'How is billing wired?');
    await expect(rail(page).getByText(SHORT_ANSWER)).toBeVisible();
    await expect(askNotice(page)).toHaveCount(1);
    await expect(askNotice(page)).toContainText(outage.askNotice);

    await sendQuestion(page, 'And how does an invoice get filed?');
    await expect(rail(page).getByText(LONG_ANSWER.slice(0, 60))).toBeVisible();
    await expect(askNotice(page)).toHaveCount(2);
    // Try again lives only on the LATEST assistant turn, so once two answers follow the
    // declined turns it is gone — and an answered turn never offers it.
    await expect(retry(page)).toHaveCount(0);
    await beat();
  });

  await chapter('Reload — every outage turn is still there', async () => {
    await page.reload();
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(declinedNotice(page)).toHaveCount(2);
    await expect(askNotice(page)).toHaveCount(2);
    await expect(rail(page).locator('a[href*="/code"]')).toHaveCount(0);
    expect(await storedFaces()).toEqual(['declined', 'declined', 'answered', 'answered']);
    await beat();
  });

  await chapter('The code can be read again — new turns are ordinary', async () => {
    await sendChange(page, 'Add a story for exporting invoices, please.');
    await expect(rail(page).getByText('Here is the plan I drafted.')).toBeVisible();
    await sendQuestion(page, 'Is it all back?');
    await expect(rail(page).getByText('Everything reads normally now.')).toBeVisible();

    // The two earlier outage turns of each kind keep their notice; the new ones have none.
    await expect(declinedNotice(page)).toHaveCount(2);
    await expect(askNotice(page)).toHaveCount(2);
    expect(await storedFaces()).toEqual([
      'declined',
      'declined',
      'answered',
      'answered',
      null,
      null,
    ]);
    // No page-level banner at any point: the only outage chrome is on the turns.
    await expect(page.getByRole('status').filter({ hasText: outage.askNotice })).toHaveCount(2);
    await beat();
  });
});
