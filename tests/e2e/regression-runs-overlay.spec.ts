// Acceptance E2E — the run overlay behaves like the plan overlay, and the runs
// list names each run's target (Subtask MOTIR-9076, Story MOTIR-8982; built by
// MOTIR-9068 to MOTIR-9075).
//
// Runs under `playwright.acceptance.config.ts` (`video: 'on'`). `acceptanceStory()`
// pins the clip to the story; the lane publishes the receipt, this spec does not.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Seven chapters, one per promise of the story: the list names each run's target;
// a row opens its run; the agent output never clips; the divider drags, stops at
// its bounds and remembers; Esc and the top-left exit both close and give focus
// back; the set is a List | Canvas switch whose rows filter the output; and below
// the split's breakpoint the panes stack with no divider.
//
// ── WHERE EVERY NUMBER COMES FROM ───────────────────────────────────────────
//
// Nothing here types a width. The floor, the ceiling and the breakpoint come from
// `lib/planning/railWidth.ts` — the same module the overlay's split reads — and
// every copy string is read from `messages/en.json`. The runs are opened through
// the real `/api/v1/dispatch-runs` ingest ops, as the CLI's reporter does; no
// dispatch row is written directly.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a box
// measured from the elements, or an `expect.poll` of one. The one wait that is not
// a DOM change — "the pointer moved past the bound and NOTHING happened" — waits
// two animation frames in the page. No fixed sleep stands in for state; `beat()`
// and the chapter hold are PACING only, taken after the assertion that proved the
// state.
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { appendEvents, heartbeat, ingestContext, openRun } from './_helpers/agent-run-seed';
import { seedRunOverlay, type RunOverlaySeed } from './_helpers/run-overlay-seed';
import {
  railBounds,
  SPLIT_MIN_CONTAINER_PX,
  RAIL_WIDTH_STORAGE_KEY,
} from '@/lib/planning/railWidth';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

/** One CSS pixel: the frame paints a chosen width as a ROUNDED pixel value. */
const TOLERANCE_PX = 1;
const LOG_WIDTH_KEY = 'motir.runs.logWidth';
/** An unbroken token longer than any pane — the line that used to clip. */
const LONG_TOKEN = 'x'.repeat(120);
const BATCH_AGENT = 'rowan-agent';
const AUTO_AGENT = 'sable-agent';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Locators ─────────────────────────────────────────────────────────────────

const overlay = (page: Page) => page.getByRole('dialog', { name: en.runs.modalTitle });
const frame = (page: Page) => overlay(page).getByTestId('resizable-split');
const divider = (page: Page) =>
  overlay(page).getByRole('separator', { name: en.runs.logDividerAria });
const logRegion = (page: Page) => overlay(page).getByTestId('run-modal-log-region');
const setPane = (page: Page) => overlay(page).getByRole('region', { name: en.runs.paneSet });
const lines = (page: Page) => overlay(page).getByTestId('run-log-line');
const viewButton = (page: Page, label: string) =>
  overlay(page)
    .getByRole('group', { name: en.runs.viewSwitchAria })
    .getByRole('button', { name: label });
const runRow = (page: Page, agent: string) => page.getByRole('row').filter({ hasText: agent });
const openButton = (row: Locator) => row.getByRole('button', { name: en.runs.openRunAria });
const hasRunParam = (url: URL) => url.pathname === '/runs' && url.searchParams.has('run');
const noRunParam = (url: URL) => url.pathname === '/runs' && !url.searchParams.has('run');

// ── Measurement ──────────────────────────────────────────────────────────────

interface Split {
  frame: number;
  right: number;
  set: number;
  log: number;
}

async function measure(page: Page): Promise<Split> {
  return frame(page).evaluate((el) => {
    const f = el.getBoundingClientRect();
    const s = el.children[0]!.getBoundingClientRect();
    const l = el.children[1]!.getBoundingClientRect();
    return { frame: f.width, right: f.right, set: s.width, log: l.width };
  });
}

/** Wait until the log region is `logPx` wide (± tolerance), then prove the set took the rest. */
async function expectSplit(page: Page, logPx: number): Promise<Split> {
  await expect
    .poll(async () => Math.abs((await measure(page)).log - logPx), {
      message: `log region settles at ${logPx.toFixed(2)}px`,
    })
    .toBeLessThanOrEqual(TOLERANCE_PX);
  const split = await measure(page);
  expect(Math.abs(split.set + split.log - split.frame)).toBeLessThanOrEqual(TOLERANCE_PX);
  return split;
}

/** Two animation frames — after them, an unchanged box means the move was REFUSED. */
async function framesSettled(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

async function grabDivider(page: Page): Promise<number> {
  const box = (await divider(page).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  return y;
}

/** Move the HELD pointer to where the log region would be `logPx` wide, in steps. */
async function pointerTo(page: Page, from: Split, logPx: number, y: number): Promise<void> {
  await page.mouse.move(from.right - logPx, y, { steps: 12 });
}

/** Nothing in the log is wider than its box — the agent output WRAPS, it never clips. */
async function expectNoClipping(page: Page): Promise<void> {
  const clipped = await overlay(page).evaluate((root) => {
    const over = (sel: string) =>
      [...root.querySelectorAll<HTMLElement>(`[data-testid="${sel}"]`)].filter(
        (el) => el.scrollWidth > el.clientWidth + 1,
      ).length;
    return { body: over('run-log-body'), line: over('run-log-line-body') };
  });
  expect(clipped, 'no log scroller or line is wider than its box').toEqual({ body: 0, line: 0 });
}

// ── Seeding ──────────────────────────────────────────────────────────────────

async function seedRuns(
  api: APIRequestContext,
  seed: RunOverlaySeed,
): Promise<{ batchId: string; autoId: string }> {
  const [a, b, c] = seed.cards;
  const batchId = await openRun(api, {
    projectKey: seed.projectKey,
    command: 'batch',
    agent: BATCH_AGENT,
    cards: [{ key: a.identifier }, { key: b.identifier }, { key: c.identifier }],
  });
  await appendEvents(api, batchId, [
    {
      kind: 'log',
      workItemKey: a.identifier,
      data: { workItemKey: a.identifier },
      body: `A one: reading the export service ${LONG_TOKEN}`,
    },
    {
      kind: 'log',
      workItemKey: b.identifier,
      data: { workItemKey: b.identifier },
      body: 'B one: composing the receipt template',
    },
    {
      kind: 'log',
      workItemKey: a.identifier,
      data: { workItemKey: a.identifier },
      body: 'A two: wrote the CSV writer',
    },
    {
      kind: 'log',
      workItemKey: b.identifier,
      data: { workItemKey: b.identifier },
      body: `B two: ${LONG_TOKEN} sent`,
    },
    {
      kind: 'log',
      workItemKey: c.identifier,
      data: { workItemKey: c.identifier },
      body: 'C one: rounding half away from zero',
    },
  ]);
  await heartbeat(api, batchId);

  // A run that took nothing: a real outcome, with no target to name.
  const autoId = await openRun(api, {
    projectKey: seed.projectKey,
    command: 'auto',
    agent: AUTO_AGENT,
    cards: [],
  });
  await heartbeat(api, autoId);
  return { batchId, autoId };
}

// ─────────────────────────────────────────────────────────────────────────────

test('the run overlay splits, wraps, closes top left and switches its set like the plan overlay, and the list names each target', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8982');

  const seed = await seedRunOverlay(`${Date.now()}`);
  const api = await ingestContext(seed.token, baseURL!);
  await seedRuns(api, seed);
  const [cardA, cardB] = seed.cards;
  await signIn(page, seed.email, seed.password);
  const laneViewport = page.viewportSize()!;
  let framePx = 0;

  // ── 1 · the list names each target ───────────────────────────────────────
  await chapter('The runs list names what each run took', async () => {
    await page.goto('/runs');
    await expect(runRow(page, BATCH_AGENT)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const headers = await page.getByRole('columnheader').allTextContents();
    expect(headers.map((h) => h.trim())).toEqual([
      en.runs.colTarget,
      en.runs.colAgent,
      en.runs.colStarted,
      en.runs.colStatus,
      en.runs.colItems,
    ]);

    const batch = runRow(page, BATCH_AGENT);
    const keyLink = batch.getByRole('link', { name: cardA.identifier });
    await expect(keyLink).toBeVisible();
    await expect(keyLink).toHaveAttribute('href', new RegExp(`/items/${cardA.identifier}$`));
    await expect(keyLink.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /command|scope/i })).toHaveCount(0);
    await expect(batch).toContainText('+2');

    const auto = runRow(page, AUTO_AGENT);
    await expect(auto).toBeVisible();
    await expect(auto.getByRole('link')).toHaveCount(0);
    await expect(auto).not.toContainText(/\+\d/);
    await expect(auto).not.toContainText(/\b(auto|batch)\b/i);
    await expect(batch).not.toContainText(/\b(auto|batch)\b/i);
    await expect(openButton(auto)).toBeVisible();
    // Opening is its own button, named; the key beside it is a link to the card.
    await expect(openButton(batch)).toBeVisible();
    await beat();
  });

  // ── 2 · a row opens its run ──────────────────────────────────────────────
  await chapter('Open the batch run — the overlay fills the page', async () => {
    await openButton(runRow(page, BATCH_AGENT)).click();
    await page.waitForURL(hasRunParam);
    await expect(overlay(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(divider(page)).toBeVisible();
    await expect(lines(page)).toHaveCount(5);
    framePx = (await measure(page)).frame;
    await beat();
  });

  // ── 3 · nothing clips ────────────────────────────────────────────────────
  await chapter('Long agent output wraps instead of running off the pane', async () => {
    await expect(overlay(page).getByText(LONG_TOKEN, { exact: false }).first()).toBeVisible();
    await expectNoClipping(page);
    await beat();
  });

  const { min, max } = railBounds(framePx);

  // ── 4 · the divider ──────────────────────────────────────────────────────
  await chapter(
    'Drag the divider — the output widens, stops at its bounds, and is remembered',
    async () => {
      const before = await measure(page);
      const y = await grabDivider(page);
      const target = before.log + (max - before.log) / 2;
      let last = before;
      for (let i = 1; i <= 4; i++) {
        const px = before.log + ((target - before.log) * i) / 4;
        await pointerTo(page, before, px, y);
        last = await expectSplit(page, px);
      }
      await page.mouse.up();
      await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(last.log)));
      await expectNoClipping(page);

      const stored = await page.evaluate(
        ([runsKey, planKey]) => ({
          runs: localStorage.getItem(runsKey!),
          planning: localStorage.getItem(planKey!),
        }),
        [LOG_WIDTH_KEY, RAIL_WIDTH_STORAGE_KEY],
      );
      expect(Number(stored.runs)).toBe(Math.round(last.log));
      expect(stored.planning, 'the planning width is untouched').toBeNull();
      await beat();

      // Past the minimum: the pointer keeps travelling, the panes do not.
      const mid = await measure(page);
      await grabDivider(page);
      await pointerTo(page, mid, min, y);
      const atMin = await expectSplit(page, min);
      await pointerTo(page, mid, min - 120, y);
      await framesSettled(page);
      const pushed = await measure(page);
      expect(Math.abs(pushed.log - atMin.log)).toBeLessThanOrEqual(0.5);
      await page.mouse.up();
      await expect(divider(page)).toHaveAttribute('aria-valuemin', String(Math.round(min)));
      await expect(divider(page)).toHaveAttribute('aria-valuenow', String(Math.round(min)));
      await expectNoClipping(page);

      // Persisted: it reopens at the same width.
      await page.keyboard.press('Escape');
      await page.waitForURL(noRunParam);
      await openButton(runRow(page, BATCH_AGENT)).click();
      await page.waitForURL(hasRunParam);
      await expect(divider(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expectSplit(page, min);
      await expectNoClipping(page);
      await beat();
    },
  );

  // ── 5 · close, and where focus goes ──────────────────────────────────────
  await chapter(
    'Esc and the top-left exit both close the run and return focus to its row',
    async () => {
      const opener = openButton(runRow(page, BATCH_AGENT));
      await page.keyboard.press('Escape');
      await page.waitForURL(noRunParam);
      await expect(overlay(page)).toHaveCount(0);

      // Focus returns to whatever held it when the dialog opened. The previous
      // chapter reopened by address, so nothing held it then; open by the row's
      // own door from here on, which is how a reader does.
      await opener.click();
      await page.waitForURL(hasRunParam);
      await expect(overlay(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await page.keyboard.press('Escape');
      await page.waitForURL(noRunParam);
      await expect(overlay(page)).toHaveCount(0);
      await expect(opener).toBeFocused();

      await opener.click();
      await page.waitForURL(hasRunParam);
      await expect(overlay(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      const exit = overlay(page).getByTestId('overlay-exit');
      const exitBox = (await exit.boundingBox())!;
      const dialogBox = (await overlay(page).boundingBox())!;
      expect(exitBox.x - dialogBox.x, 'the exit sits at the top left').toBeLessThan(
        dialogBox.width / 4,
      );
      await exit.click();
      await page.waitForURL(noRunParam);
      await expect(overlay(page)).toHaveCount(0);
      await expect(opener).toBeFocused();
      await beat();
    },
  );

  // ── 6 · List | Canvas ────────────────────────────────────────────────────
  await chapter('The set is a List | Canvas switch, and a row filters the output', async () => {
    await openButton(runRow(page, BATCH_AGENT)).click();
    await page.waitForURL(hasRunParam);
    await expect(overlay(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(viewButton(page, en.runs.viewCanvas)).toHaveAttribute('aria-pressed', 'true');
    await viewButton(page, en.runs.viewList).click();
    await expect(viewButton(page, en.runs.viewList)).toHaveAttribute('aria-pressed', 'true');

    const rows = overlay(page).getByTestId('run-set-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(cardA.identifier);
    await expect(rows.nth(1)).toContainText(cardB.identifier);
    await expect(lines(page)).toHaveCount(5);

    await rows.nth(0).click();
    await expect(logRegion(page)).not.toHaveAttribute('data-selected-work-item', '');
    await expect(lines(page)).toHaveCount(2);
    await expect(overlay(page).getByTestId('run-log-body')).not.toContainText('B one');
    await beat();

    await rows.nth(1).click();
    await expect(lines(page)).toHaveCount(2);
    await expect(overlay(page).getByTestId('run-log-body')).toContainText('B one');
    await expect(overlay(page).getByTestId('run-log-body')).not.toContainText('A one');

    // Activating the selected row again restores the whole run.
    await rows.nth(1).click();
    await expect(logRegion(page)).toHaveAttribute('data-selected-work-item', '');
    await expect(lines(page)).toHaveCount(5);
    await beat();

    // A run that took nothing still shows the switch, and says so.
    await page.keyboard.press('Escape');
    await page.waitForURL(noRunParam);
    await openButton(runRow(page, AUTO_AGENT)).click();
    await page.waitForURL(hasRunParam);
    await expect(overlay(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(viewButton(page, en.runs.viewList)).toBeVisible();
    await expect(viewButton(page, en.runs.viewCanvas)).toBeVisible();
    await expect(overlay(page).getByTestId('run-modal-no-members')).toHaveText(
      en.runs.tookNoneBody,
    );
    await page.keyboard.press('Escape');
    await page.waitForURL(noRunParam);
    await beat();
  });

  // ── 7 · below the breakpoint ─────────────────────────────────────────────
  await chapter(
    'Narrower than the split allows, the panes stack and there is no divider',
    async () => {
      await page.setViewportSize({
        width: SPLIT_MIN_CONTAINER_PX - 1,
        height: laneViewport.height,
      });
      await openButton(runRow(page, BATCH_AGENT)).click();
      await page.waitForURL(hasRunParam);
      await expect(overlay(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(logRegion(page)).toBeVisible();
      await expect(divider(page)).toHaveCount(0);
      const set = (await setPane(page).boundingBox())!;
      const log = (await logRegion(page).boundingBox())!;
      expect(log.y, 'the log region sits below the pane set').toBeGreaterThanOrEqual(
        set.y + set.height - TOLERANCE_PX,
      );
      await expectNoClipping(page);
      await beat();
    },
  );
});
