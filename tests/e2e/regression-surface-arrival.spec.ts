// Acceptance E2E — the planning surface OPENS INSIDE the node being planned
// (Subtask MOTIR-6163, Story MOTIR-6154).
//
// Runs under `playwright.acceptance.config.ts` (MOTIR_CLOUD + `video: 'on'`) —
// the lane where the overlay mounts at all (`isMotirAiConfigured()`) and where
// the motir-ai JOBS boundary is mocked UNDER the routes, so the session a turn
// starts is a REAL row in Postgres. `acceptanceStory()` pins the clip to the
// story.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person asks Motir to plan a story and is looking at THAT STORY'S WORK while
// they talk about it — not at the story sitting among its siblings. They close
// the planner, come back to the same conversation from Plans, and they are in
// the same place. Then they open the planner with no target at all, name one,
// and the canvas moves to it and says so.
//
// The complaint that started this story was about exactly this experience, so
// the clip is PACED: each arrival holds long enough to read the breadcrumb.
//
// ── WHAT THIS SPEC PROVES, AND WHAT PROVES THE REST ─────────────────────────
//
// Here: the three entrances a person actually uses — a card's *Plan with AI*, a
// Plans row, and a target named in the composer (the story's recipe steps 1, 3
// and 4).
//
// Elsewhere, deliberately:
//   · the LEAF arrival and the unreadable-target degradation are
//     `planning-anchor-level.spec.ts`'s, which asserts the same new rule;
//   · the plan-LANDING trigger and the never-after-navigation decline are
//     `tests/integration/planning/surfaceArrivalGate.test.tsx`'s, one tier down,
//     against the real overlay → host → canvas chain.
//
// ⚠️ NOT YET PROVEN IN A BROWSER: the story's recipe steps 5 and 6 — a plan
// whose proposals show where it lands, and drilling away before it does. The
// seed for them is not the one the shipped helper gives: `finishSessionPlan`
// closes a plan whose single proposal is PARENTLESS, so `arrivalLevel` names no
// container and there is no move to record. A browser case needs a proposal
// seeded UNDER a committed epic. Stated rather than skipped: the behaviour is
// covered at the integration tier above, and this is the gap between that and a
// person watching it.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a
// `waitForURL`, or the response of a request the page issued — never a timeout.
// The canvas's arrival is waited on through the DRILLED level fetch, which is
// the request the arrival itself makes. `beat()` and the chapter hold are PACING
// only, each taken after the assertion that already proved the state.
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { latestPlanningSession } from './_helpers/planChangeConversation';

test.describe.configure({ timeout: 180_000 });

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const breadcrumb = (page: Page) => workspace(page).getByRole('navigation', { name: 'Breadcrumb' });
const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });

/** A CANVAS node by title. Scoped to the workspace's canvas twice over: the
 *  overlay leaves the host page MOUNTED underneath it, and the rail names items
 *  too, so an unscoped lookup is a strict-mode violation or a false positive. */
const canvasNode = (page: Page, title: string) =>
  workspace(page)
    .getByTestId('planning-canvas')
    .locator('[data-node-id]')
    .filter({ hasText: title });

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

/** The roadmap LEVEL fetch for a DRILLED level. The ARRIVAL itself issues this
 *  — a `parentId` in the very first roadmap request is what "opened inside"
 *  MEANS at the wire — so it is the authoritative signal that the canvas landed
 *  where this story says it should, and not merely that a canvas exists. */
const drilledLevelLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/projects/') &&
      r.url().includes('/roadmap') &&
      r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** The next ask settles as an ANSWER, so a question proposes nothing and the
 *  conversation stays a conversation. The fixture is shared and persistent, so
 *  every test writes it. */
function declareAskAnswers(answer: string): void {
  writeFileSync(
    JOBS_FIXTURE,
    JSON.stringify({ ask: [{ intent: 'ask', answer, citations: [] }], submitted: [] }, null, 2),
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

/** Send a turn from a CARD. ⚠️ The anchored door APPENDS AND SUBMITS in one
 *  call (MOTIR-909), so it posts to `/api/work-items/{key}/ai/plan` — NOT to
 *  `/api/ai/ask`, which is the project-wide question. Its 200 is the
 *  authoritative "the session holds this turn". */
async function sendFromCard(page: Page, text: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await sent).status()).toBe(200);
  await expect(rail(page).getByText(text)).toBeVisible();
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

test.beforeEach(async () => {
  await resetDatabase();
  declareAskAnswers('Nothing is blocked right now.');
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('the planner opens INSIDE the thing you are planning — from a card, from Plans, and when you name a target', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6154');

  const email = `surface-arrival-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Split this story so the canvas work can ship on its own.';
  let sessionId = '';

  // ── STEP 1 of the story's recipe ──────────────────────────────────────────
  await chapter(
    'Open a story with Plan with AI — the canvas shows the story’s own work',
    async () => {
      await page.goto(`/items/${seed.storyKey}`);
      await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

      // Armed BEFORE the click: the arrival's own drilled fetch is the signal, and
      // a response awaited after the fact can be missed.
      const arrived = drilledLevelLoad(page);
      await entrance(page).click();
      await page.waitForURL(overlayOpen);
      await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await arrived;

      // The story's CHILDREN are what you are looking at…
      await expect(canvasNode(page, seed.subtaskTitle)).toBeVisible();
      await expect(canvasNode(page, seed.siblingTitle)).toBeVisible();
      // …and the story's SIBLING is not, which is precisely what the old arrival
      // put on screen. This assertion is the one that fails on the base commit.
      await expect(canvasNode(page, seed.storyTitle)).toHaveCount(0);

      // The breadcrumb ENDS at the story — MOTIR-2070's objection answered: the
      // target is still named, as the level you are standing in.
      await expect(breadcrumb(page)).toBeVisible();
      await expect(breadcrumb(page)).toContainText(`${seed.epicKey} · ${seed.epicTitle}`);
      await expect(breadcrumb(page).locator('[aria-current="page"]')).toContainText(
        `${seed.storyKey} · ${seed.storyTitle}`,
      );
      await beat();
    },
  );

  await chapter('Ask the planner to change it — the canvas stays on the story’s work', async () => {
    // The phase the story cares about most: while you TALK, the canvas does not
    // wander back out to where it used to open.
    await sendFromCard(page, ASK);

    await expect(canvasNode(page, seed.subtaskTitle)).toBeVisible();
    await expect(canvasNode(page, seed.storyTitle)).toHaveCount(0);
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toContainText(seed.storyKey);
    await beat();

    sessionId = (await latestPlanningSession(email)).id;
    await closeOverlay(page);
  });

  // ── STEP 3 of the story's recipe ──────────────────────────────────────────
  await chapter('Come back to the same conversation from Plans — same place', async () => {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plans' })
      .click();
    await page.waitForURL('**/plans');
    await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

    const row = sessionsList(page).getByRole('listitem').filter({ hasText: ASK });
    await expect(row).toBeVisible();
    await beat();

    const arrived = drilledLevelLoad(page);
    await row.getByRole('link', { name: ASK }).click();
    await page.waitForURL((url) => url.searchParams.get('planSession') === sessionId);
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await arrived;

    // Reopened INSIDE the story, exactly as the card's own door left it — one
    // rule, two entrances.
    await expect(canvasNode(page, seed.subtaskTitle)).toBeVisible();
    await expect(canvasNode(page, seed.storyTitle)).toHaveCount(0);
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toContainText(
      `${seed.storyKey} · ${seed.storyTitle}`,
    );
    await beat();
  });

  // ── STEP 4 of the story's recipe ──────────────────────────────────────────
  await chapter('Open the planner with no target — it waits at the top', async () => {
    // Left by ADDRESS rather than Esc: the reopened conversation holds a plan,
    // and Esc rightly asks before discarding one.
    await page.goto('/plans');
    await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByRole('link', { name: 'Plan with AI', exact: true }).click();
    await page.waitForURL(overlayOpen);
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

    // The project root: both epics drawn, and no breadcrumb at all — the canvas
    // renders one only when it is standing somewhere.
    await expect(canvasNode(page, seed.epicTitle)).toBeVisible();
    await expect(canvasNode(page, 'Growth experiments')).toBeVisible();
    await expect(breadcrumb(page)).toHaveCount(0);
    await beat();
  });

  await chapter('Name the epic you mean — the canvas moves inside it, and says so', async () => {
    const arrived = drilledLevelLoad(page);
    await rail(page).getByTestId('planning-target-trigger').click();
    // The Search control opens the target search with focus in its OWN field
    // (MOTIR-6897) — the query is typed there, never into the message. The
    // listbox is the results, rendered in the same popover.
    await rail(page).getByTestId('planning-target-search-field').pressSequentially(seed.epicKey, {
      delay: 20,
    });
    await rail(page)
      .getByRole('listbox', { name: 'Work items to plan around' })
      .getByRole('option')
      .filter({ hasText: seed.epicKey })
      .first()
      .click();

    // The chip is the composer saying it heard; the drilled fetch is the canvas
    // acting on it.
    await expect(workspace(page).getByTestId('planning-target-chip')).toContainText(seed.epicKey);
    await arrived;

    // Inside the epic: its story is drawn, the OTHER root epic is not, and the
    // breadcrumb names where it went. On the base commit the canvas stays at the
    // root and this is the assertion that fails.
    await expect(canvasNode(page, seed.storyTitle)).toBeVisible();
    await expect(canvasNode(page, 'Growth experiments')).toHaveCount(0);
    await expect(breadcrumb(page)).toBeVisible();
    await expect(breadcrumb(page).locator('[aria-current="page"]')).toContainText(
      `${seed.epicKey} · ${seed.epicTitle}`,
    );

    // …and it is ANNOUNCED, for a reader who was not watching the canvas.
    await expect(workspace(page).getByTestId('canvas-follow-live')).toContainText(seed.epicKey);
    await beat();
  });
});
