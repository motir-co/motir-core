// Acceptance E2E — talking to Motir AI takes a PARAGRAPH
// (Subtask MOTIR-6240, Story MOTIR-6156).
//
// The story's `verification_recipe`, driven the way a person drives it and
// recorded as the receipt Yue watches to accept it: three lines with Shift+Enter,
// Enter sending them as three, a ten-line paste stopping at the cap and
// scrolling, an Enter that confirms a Chinese word sending nothing.
//
// ⚠️ AMENDED 2026-10-08 by Story MOTIR-7883: the clip also walked the plan page's
// revise box. That box is unreachable for an undecided plan now (its `/plans/<id>`
// opens the planning overlay), so those chapters are retired; the six chapters on
// the planning surface's composer — one line, Shift+Enter, Enter sending three lines,
// the ten-line cap, the IME Enter, the blank message — still cover the behaviour.
//
// Runs under `playwright.acceptance.config.ts` (MOTIR_CLOUD + `video: 'on'`),
// the lane where the planning overlay mounts at all (`isMotirAiConfigured()`)
// and where the motir-ai JOBS boundary is mocked UNDER the routes — so the turn,
// the session it lands in and the transcript that reads it back are all real
// rows in Postgres. `acceptanceStory()` pins the clip to MOTIR-6156.
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing. The change
// is not "an input grew a second line". It is that a person can now write to a
// planner the way they explain things — a paragraph, or a list — and read it
// back before they send it. A recording that types one line and presses Enter
// has met several acceptance criteria and shown none of that. So each chapter
// holds on the GROWN field, with the text readable, before anything sends it.
//
// ⚠️ THE IME COMPOSITION IS A DISPATCHED `isComposing` KEYDOWN, not
// `Input.imeSetComposition` — the card's stated fall-back, and this header is
// where it says which. CDP's `Input.imeSetComposition` drives the *composition*
// events but the Enter that CONFIRMS a candidate is delivered by the platform
// IME, which a headless Chromium has none of; `Input.dispatchKeyEvent` carries
// no `isComposing` flag either. So the spec dispatches the keydown the browser
// WOULD deliver, with `isComposing: true`, on the real field, through the real
// React handler. What that proves is the guard the composer actually ships
// (`nativeEvent.isComposing`); the two signals a dispatched event cannot carry —
// `keyCode === 229` and WebKit's `compositionend`-before-keydown ordering — are
// component tests on the composer card, which is also where the card puts them.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a turn's
// text, a request the page issued, or a measured box read off the element.
// Heights are NUMBERS read from the DOM, never screenshots. `beat()` and the
// chapter hold are PACING only — each comes after the assertion that already
// proved the state.
import { writeFileSync } from 'node:fs';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import type { Page, Locator } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

/** The design's cap, in rows (`design/ai-chat/design-notes.md`, decision 1). */
const CAP_ROWS = 8;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const sendButton = (page: Page) => rail(page).getByRole('button', { name: 'Send' });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
/**
 * The CANVAS pane — the resizable frame's first track. It carries no test id of
 * its own, and the frame is the only thing that owns the two-track geometry.
 *
 * Rooted at the OVERLAY, not at the page: a page-rooted strict locator can match
 * a node nobody put there, because React keeps the previous subtree mounted
 * while the new one streams and its hidden SSR staging block is in the DOM too
 * (`tests/e2e-page-rooted-locators.test.ts`).
 */
const canvasPane = (page: Page) =>
  workspace(page).getByTestId('resizable-split').locator('> div').first();

const overlayOpen = (url: URL) => url.searchParams.has('plan');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** Every turn this spec sends is a QUESTION, so nothing proposes a plan and the
 *  clip stays about the composer rather than about a tree. */
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

// ── Measuring the field ──────────────────────────────────────────────────────

interface FieldBox {
  /** The rendered height, in CSS pixels. */
  height: number;
  /** The content height the browser would need — `> clientHeight` means it scrolls. */
  scrollHeight: number;
  clientHeight: number;
  /** The one-row height, so a growth assertion needs no hard-coded 44. */
  lineHeight: number;
}

/** Read the field's own geometry out of the DOM. Numbers, never a screenshot. */
async function measure(field: Locator): Promise<FieldBox> {
  return field.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    return {
      height: t.getBoundingClientRect().height,
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(t).lineHeight),
    };
  });
}

/** Type `lines` into the field with Shift+Enter between them, as a person does. */
async function typeLines(page: Page, field: Locator, lines: readonly string[]): Promise<void> {
  await field.click();
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(line);
  }
  // The authoritative signal that the field holds what was typed — not a sleep.
  await expect(field).toHaveValue(lines.join('\n'));
}

/**
 * Dispatch the keydown a platform IME delivers when Enter CONFIRMS a candidate:
 * `key: 'Enter'`, `isComposing: true`. See the header for why this rather than
 * `Input.imeSetComposition`.
 */
async function pressComposingEnter(field: Locator): Promise<void> {
  await field.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

/** The transcript's newest user turn, read as the LINES a person sees. */
async function newestUserTurnLines(page: Page): Promise<string[]> {
  const bubbles = rail(page).locator('[class*="el-chat-bubble-user"]');
  const text = await bubbles.last().evaluate((el) => (el as HTMLElement).innerText);
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

test.beforeEach(async () => {
  await resetDatabase();
  declareAskAnswers('Nothing is blocked right now.');
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a request to Motir AI can be a paragraph — on the planning surface', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6156');

  const email = `multiline-composer-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const THREE = [
    'Split this story so the canvas work can ship on its own.',
    'Keep the rail work where it is.',
    'And size the two halves separately.',
  ] as const;

  let oneRow = 0;

  await chapter('The composer opens as one line', async () => {
    await page.goto(`/items/${seed.storyKey}`);
    await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await entrance(page).click();
    await page.waitForURL(overlayOpen);
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(rail(page)).toBeVisible();

    const box = await measure(composer(page));
    // One row, with the placeholder still the whole ask. The height is the
    // baseline every growth assertion below is measured against.
    oneRow = box.height;
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight);
    await expect(composer(page)).toHaveAttribute('placeholder', /.+/);
    await beat();
  });

  await chapter('Three lines with Shift+Enter — it grows, and sends nothing', async () => {
    // The canvas's geometry BEFORE, so "growing moves nothing outside the pane"
    // is a measurement rather than an impression.
    const canvasBefore = await canvasPane(page).boundingBox();
    const turnsBefore = await rail(page).locator('[class*="el-chat-bubble-user"]').count();

    await typeLines(page, composer(page), THREE);

    const grown = await measure(composer(page));
    // Three rows is two line-heights taller than one, and still short of the cap.
    expect(grown.height).toBeGreaterThan(oneRow + grown.lineHeight);
    expect(grown.scrollHeight).toBeLessThanOrEqual(grown.clientHeight);
    // Nothing was sent: no new turn, and the draft is still in the field.
    expect(await rail(page).locator('[class*="el-chat-bubble-user"]').count()).toBe(turnsBefore);

    // …and the canvas did not move.
    expect(await canvasPane(page).boundingBox()).toEqual(canvasBefore);
    await beat();
  });

  await chapter('Enter sends them — and the transcript shows three lines', async () => {
    const sent = page.waitForResponse(
      (r) =>
        /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'POST',
    );
    await composer(page).press('Enter');
    expect((await sent).status()).toBe(200);

    // The bubble holds the three lines, in order, as lines.
    await expect.poll(async () => (await newestUserTurnLines(page)).slice(-3)).toEqual([...THREE]);
    // …and the composer is back to one row.
    await expect(composer(page)).toHaveValue('');
    expect((await measure(composer(page))).height).toBe(oneRow);
    // The plan run that send started settles before the next one may start: the
    // lane's jobs mock ends it with nothing proposed, which the rail says in its
    // own line. The recording lane's holds always outlasted it (MOTIR-9411).
    await expect(rail(page).getByText(en.planningWorkspace.conversation.error.empty)).toBeVisible();
    await beat();
  });

  await chapter('A ten-line paste stops at the cap and scrolls inside itself', async () => {
    const TEN = Array.from({ length: 10 }, (_, i) => `${i + 1}. the ${i + 1}th change`);
    await composer(page).click();
    // What a paste actually delivers to a textarea.
    await page.keyboard.insertText(TEN.join('\n'));
    await expect(composer(page)).toHaveValue(TEN.join('\n'));

    const capped = await measure(composer(page));
    // AT the cap, not past it — the height is the cap's arithmetic, and the
    // content overflows it, so the field scrolls rather than the page.
    const overOneRow = Math.round((capped.height - oneRow) / capped.lineHeight);
    expect(overOneRow).toBe(CAP_ROWS - 1);
    expect(capped.scrollHeight).toBeGreaterThan(capped.clientHeight);
    await beat();

    // The composer ignores Enter while the previous turn is still in flight
    // (`PlanChangeComposer`'s `disabled`), and Send is disabled for exactly that
    // time. In the recording lane the holds above always outlasted the first
    // turn; here the press can land inside it (MOTIR-9411).
    await expect(sendButton(page)).toBeEnabled();
    const sent = page.waitForResponse(
      (r) =>
        /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
        r.request().method() === 'POST',
    );
    await composer(page).press('Enter');
    expect((await sent).status()).toBe(200);
    await expect.poll(async () => (await newestUserTurnLines(page)).slice(-10)).toEqual(TEN);
    await beat();
  });

  await chapter('Typing Chinese: Enter confirms the word, and sends nothing', async () => {
    const turnsBefore = await rail(page).locator('[class*="el-chat-bubble-user"]').count();
    await composer(page).click();
    await page.keyboard.insertText('把这个故事拆开');
    await expect(composer(page)).toHaveValue('把这个故事拆开');

    await pressComposingEnter(composer(page));

    // The composed text is still in the field, and no turn left.
    await expect(composer(page)).toHaveValue('把这个故事拆开');
    expect(await rail(page).locator('[class*="el-chat-bubble-user"]').count()).toBe(turnsBefore);
    await beat();
  });

  await chapter('Spaces and newlines alone are not a message', async () => {
    await composer(page).fill('  \n \n  ');
    await expect(sendButton(page)).toBeDisabled();

    const turnsBefore = await rail(page).locator('[class*="el-chat-bubble-user"]').count();
    await composer(page).press('Enter');
    // Nothing was sent — asserted by the count holding, with the disabled Send
    // above it as the reason a reader can see.
    await expect
      .poll(() => rail(page).locator('[class*="el-chat-bubble-user"]').count())
      .toBe(turnsBefore);
    await composer(page).fill('');
    await beat();
  });

  // ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7886): three chapters walked the
  // SECOND host, the plan page's revise box in `PlanReviewRail`. Only the plan page
  // renders that rail, and a member's `/plans/<id>` for an undecided plan now lands in
  // the planning overlay, so an undecided plan's revise box is unreachable; a decided
  // plan has none. The multiline behaviour stays covered by the six overlay-composer
  // chapters above, which drive the same shared composer field.
});
