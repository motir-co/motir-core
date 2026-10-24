import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { gotoLoadedBoard } from './_helpers/board';
import { appendEvents, closeRun, ingestContext, openRun } from './_helpers/agent-run-seed';
import { resetHostedRunJournal, writeHostedRunFixture } from './_helpers/hosted-run-boundary';
import {
  seedContinueHosted,
  seedInProgressCard,
  type ContinueHostedSeed,
} from './_helpers/continue-hosted-seed';
import type { SeededHostedCard } from './_helpers/hosted-run-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A CARD WHOSE RUN DIED IS TO FIX TOO — THE ACCEPTANCE RECEIPT
// (Story MOTIR-6590 · Subtask MOTIR-6884; `design/workbench/workbench--to-fix--run-died.mock.html`,
// design § 31, and `design/work-items/to-fix--tag-and-banner--run-died.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story's recipe, in its four steps:
//   1. a run dies on a small card;
//   2. the Workbench opens on To fix, and the card is there as *Run died* — when it was
//      last heard from, who ran it, its branch, `motir continue <KEY>` to copy and
//      Continue hosted beside it — and it is NOT under In progress;
//   3. `/items` (List and Tree), the board and the quick view wear the *To fix · run
//      died* tag, and the item page's banner points down at the run-died marker, which
//      is the one place on that page that carries the command;
//   4. Continue hosted takes it off To fix in place, and a terminal continue does the
//      same to another card on the next live poll — neither with a reload.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The DEAD RUNS go through the real v1 routes with the owner's CLI-scoped token:
//     open a `run`, a `checkout_ready` naming a branch, and a close `interrupted`. Nothing
//     writes `fixReason` or a run's status. (The five-minute lapse is not waited for; the
//     Story Vitest gate's case 1 proves that path.)
//   * CONTINUE HOSTED really starts: this lane's hosted-run mock answers the model list,
//     the credit check and the run-key mint (`lib/test-hosted-run-mock.ts`), and the fake
//     orchestrator boots the container — the same seam `regression-continue-hosted.spec.ts`
//     uses, through `seedContinueHosted`'s `created` repositories. The press is asserted by
//     the start route's own 201.
//   * The TERMINAL continue is `POST /api/v1/work-items/{key}/continue` with the same token.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a route's response, a row's `data-held` / text, a badge's
// count, the stored column. There is no `waitForTimeout`; the holds are `chapter()` /
// `beat()`'s.

test.describe.configure({ timeout: 600_000 });

const MODEL = 'e2e-hosted-default';

/** A message template's markup tags removed, until none is left (a single pass
 *  can leave a tag behind when two overlap, e.g. `<b<b>>`). */
function stripTags(template: string): string {
  let prev: string;
  let out = template;
  do {
    prev = out;
    out = out.replace(/<\/?[a-z]+>/g, '');
  } while (out !== prev);
  return out;
}

/** A rich message as the page renders it: tags keep their children, `{var}` its value,
 *  and `<when></when>` ANY relative time. */
function rich(template: string, vars: Record<string, string> = {}): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = (s: string) =>
    escape(stripTags(s).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? ''));
  return new RegExp(
    template
      .split(/<when><\/when>/)
      .map(literal)
      .join('.+'),
  );
}

const plain = (template: string, vars: Record<string, string> = {}) =>
  stripTags(template).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

// ── The page ────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const table = (page: Page, name: string): Locator => page.getByRole('table', { name });
/** A Workbench row, by the test id the list gives each row. */
const wbRow = (page: Page, card: SeededHostedCard): Locator =>
  main(page).getByTestId(`workbench-row-${card.identifier}`);
const itemRow = (page: Page, card: SeededHostedCard) =>
  page.getByRole('row').filter({ hasText: card.identifier });
const rowTag = (page: Page, card: SeededHostedCard) => itemRow(page, card).locator('[data-to-fix]');
const boardCard = (page: Page, card: SeededHostedCard) =>
  page.getByRole('button', { name: new RegExp(card.identifier) });
const banner = (page: Page) => main(page).getByTestId('to-fix-banner');

/** The strip's badge for a tab, as a number — a suppressed zero is zero. */
async function badgeCount(page: Page, tab: string): Promise<number> {
  const text =
    (await page
      .getByRole('link', { name: new RegExp(`^${tab}`) })
      .first()
      .textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

async function fixReasonOf(card: SeededHostedCard): Promise<string | null> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).fixReason;
}

const modelsResponse = (page: Page) =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/hosted-runs/models' && res.request().method() === 'GET',
    { timeout: 60_000 },
  );

async function openList(page: Page, query = ''): Promise<void> {
  await page.goto(`/items?view=list${query}`);
  await expect(page.getByRole('table', { name: 'Work Items' })).toBeVisible({ timeout: 60_000 });
}

/** A run on `card` that checked out `branch` (unless null) and was stopped from its terminal. */
async function runDies(
  api: APIRequestContext,
  projectKey: string,
  card: SeededHostedCard,
  branch: string | null,
): Promise<void> {
  const runId = await openRun(api, {
    projectKey,
    command: 'run',
    agent: 'claude',
    cards: [{ key: card.identifier }],
  });
  if (branch) {
    await appendEvents(api, runId, [
      { kind: 'checkout_ready', workItemKey: card.identifier, data: { branch } },
    ]);
  }
  await closeRun(api, runId, 'interrupted');
  expect(await fixReasonOf(card), `${card.identifier} is stored run_died`).toBe('run_died');
}

// ── The walk ────────────────────────────────────────────────────────────────

test.describe('A card whose run died is To fix', () => {
  let s: ContinueHostedSeed;
  let api: APIRequestContext;

  test.beforeEach(async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('no Playwright baseURL — the ingest calls have nowhere to go');
    await resetDatabase();
    writeHostedRunFixture({ models: { ids: [MODEL], default: MODEL }, mayRun: true });
    resetHostedRunJournal();
    const slug = Date.now().toString(36);
    s = await seedContinueHosted(`run-died-${slug}@example.com`, `RD${slug}`);
    api = await ingestContext(s.owner.token, baseURL);
    await signIn(page, s.owner.email, s.hosted.password);
  });

  test.afterEach(async () => {
    await api.dispose();
  });

  test('lands on To fix with both repairs, wears the tag everywhere, and a continue clears it in place', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6590');
    const projectKey = s.hosted.projectKey;
    const toFix = en.workbench.tabs.toFix;
    const inProgress = en.workbench.tabs.inProgress;

    const HOSTED_TITLE = 'Throttle the invoice export';
    const hostedCard = await seedInProgressCard(s, HOSTED_TITLE);
    const nothingCard = await seedInProgressCard(s, 'Rename the billing page');
    const terminalCard = await seedInProgressCard(s, 'Retry failed webhooks');
    const branch = `subtask/${hostedCard.identifier.toLowerCase()}-throttle`;

    await chapter('A run dies on a small card', async () => {
      await runDies(api, projectKey, hostedCard, branch);
      await runDies(api, projectKey, nothingCard, null);
      await runDies(
        api,
        projectKey,
        terminalCard,
        `subtask/${terminalCard.identifier.toLowerCase()}-retry`,
      );
    });

    await chapter('The Workbench opens on To fix — Run died, with both repairs', async () => {
      const models = modelsResponse(page);
      await page.goto('/workbench');
      await page.waitForURL(/[?&]tab=to-fix/);
      await models;
      // MOUNTED first, so nothing below can pass on an empty tab.
      await expect(wbRow(page, hostedCard)).toBeVisible({ timeout: 60_000 });
      expect(await badgeCount(page, toFix)).toBe(3);

      const line = main(page).getByTestId(`workbench-fix-${hostedCard.identifier}`);
      await expect(line).toHaveAttribute('data-fix-reason', 'run_died');
      await expect(line).toContainText(
        rich(en.workbench.toFix.reason.runDied, { name: s.owner.name, branch }),
      );
      await expect(line).toContainText(`motir continue ${hostedCard.identifier}`);
      await expect(
        line.getByRole('button', { name: en.github.development.continue.hosted.button }),
      ).toBeEnabled({
        timeout: 60_000,
      });
      await beat();

      // Copying the command yields exactly `motir continue <KEY>`.
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await main(page).getByTestId(`workbench-fix-copy-${hostedCard.identifier}`).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `motir continue ${hostedCard.identifier}`,
      );

      // Nothing pushed: the start-over line, and neither repair.
      const nothing = main(page).getByTestId(`workbench-fix-${nothingCard.identifier}`);
      await expect(nothing).toContainText(
        plain(en.github.development.continue.startOver, { target: nothingCard.identifier }),
      );
      await expect(nothing).not.toContainText('motir continue');
      await expect(nothing.getByTestId('continue-hosted-door')).toHaveCount(0);
      await beat();
    });

    await chapter('In progress does not list it', async () => {
      await page.getByRole('link', { name: new RegExp(`^${inProgress}`) }).click();
      await page.waitForURL(/[?&]tab=in-progress/);
      await expect(
        main(page).getByText(en.workbench.empty.inProgress.title).or(table(page, inProgress)),
      ).toBeVisible({ timeout: 60_000 });
      for (const card of [hostedCard, nothingCard, terminalCard]) {
        await expect(page.getByRole('row').filter({ hasText: card.identifier })).toHaveCount(0);
      }
      await beat();
    });

    const tagName = en.toFix.tagName.run_died;

    await chapter('/items, the board and the quick view wear the tag', async () => {
      await openList(page);
      await expect(rowTag(page, hostedCard)).toHaveAttribute('aria-label', tagName);
      await rowTag(page, hostedCard).hover();
      await beat();

      await page.goto('/items?view=tree');
      await expect(rowTag(page, hostedCard)).toHaveAttribute('aria-label', tagName, {
        timeout: 60_000,
      });
      await rowTag(page, hostedCard).scrollIntoViewIfNeeded();
      await beat();

      await gotoLoadedBoard(page, 60_000);
      await expect(boardCard(page, hostedCard).locator('[data-to-fix]')).toHaveText(tagName);
      await boardCard(page, hostedCard).locator('[data-to-fix]').scrollIntoViewIfNeeded();
      await beat();

      await openList(page);
      await page
        .getByRole('link', { name: `${hostedCard.identifier} ${HOSTED_TITLE}`, exact: true })
        .click({ position: { x: 6, y: 22 } });
      await expect(page).toHaveURL(new RegExp(`[?&]peek=${hostedCard.identifier}`));
      await expect(page.getByRole('dialog').locator('[data-to-fix]')).toHaveText(tagName, {
        timeout: 60_000,
      });
      await beat();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    await chapter('The item page’s banner points at the run-died marker', async () => {
      await page.goto(`/items/${hostedCard.identifier}`);
      await expect(banner(page)).toContainText(rich(en.toFix.banner.runDied), {
        timeout: 60_000,
      });
      // The banner carries NO command — the marker below it is the one that does.
      await expect(banner(page).locator('pre')).toHaveCount(0);
      const part = main(page).getByRole('group', {
        name: en.github.development.continue.aria.part,
        exact: true,
      });
      await expect(part).toContainText(`motir continue ${hostedCard.identifier}`);
      await beat();
      await banner(page).getByRole('link', { name: en.toFix.banner.toContinue }).click();
      await expect(main(page).locator('#development')).toBeFocused({ timeout: 60_000 });
      await beat();
    });

    await chapter('To fix is Run died finds exactly the dead-run cards', async () => {
      await openList(page);
      await page.getByRole('button', { name: /^Advanced/ }).click();
      await page.getByRole('button', { name: 'Add condition' }).click();
      const row = page.getByRole('group', { name: 'Condition 1' });
      await row.getByRole('combobox', { name: 'Field' }).click();
      await page
        .getByRole('option', { name: en.issueViews.advancedFieldToFix, exact: true })
        .click();
      await row.getByRole('combobox', { name: 'Operator' }).click();
      await page
        .getByRole('option', { name: en.issueViews.advancedOpIsAnyOf, exact: true })
        .click();
      const before = page.url();
      await row
        .getByRole('combobox', { name: `${en.issueViews.advancedFieldToFix} values` })
        .click();
      await page
        .getByRole('option', { name: en.workbench.toFix.reason.runDiedBare, exact: true })
        .click();
      await page.waitForURL(
        (url) => url.toString() !== before && /[?&]filter=/.test(url.toString()),
      );
      for (const card of [hostedCard, nothingCard, terminalCard]) {
        await expect(itemRow(page, card)).toBeVisible({ timeout: 60_000 });
      }
      await expect(page.getByRole('table', { name: 'Work Items' }).getByRole('row')).toHaveCount(4); // 3 + header
      await beat();
    });

    await chapter('Continue hosted from the row — Cleared in place, the count drops', async () => {
      const models = modelsResponse(page);
      await page.goto('/workbench?tab=to-fix');
      await models;
      await expect(wbRow(page, hostedCard)).toBeVisible({ timeout: 60_000 });
      const url = page.url();
      const press = main(page)
        .getByTestId(`workbench-fix-${hostedCard.identifier}`)
        .getByRole('button', { name: en.github.development.continue.hosted.button });
      await expect(press).toBeEnabled({ timeout: 60_000 });
      await beat();

      const started = page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/work-items/${hostedCard.identifier}/hosted-runs`) &&
          res.request().method() === 'POST',
        { timeout: 60_000 },
      );
      await press.click();
      const response = await started;
      expect(response.status()).toBe(201);
      expect(response.request().postDataJSON()).toMatchObject({ model: MODEL, mode: 'continue' });
      expect(await fixReasonOf(hostedCard)).toBeNull();

      await expect(wbRow(page, hostedCard)).toHaveAttribute('data-held', 'true', {
        timeout: 60_000,
      });
      await expect(wbRow(page, hostedCard)).toContainText(en.workbench.live.cleared);
      await expect(wbRow(page, hostedCard)).not.toContainText('motir continue');
      await expect.poll(() => badgeCount(page, toFix), { timeout: 60_000 }).toBe(2);
      expect(page.url(), 'nobody navigated').toBe(url);
      await beat();

      // The next load omits it.
      await page.getByRole('link', { name: new RegExp(`^${inProgress}`) }).click();
      await page.waitForURL(/[?&]tab=in-progress/);
      await page.getByRole('link', { name: new RegExp(`^${toFix}`) }).click();
      await page.waitForURL(/[?&]tab=to-fix/);
      await expect(wbRow(page, terminalCard)).toBeVisible({ timeout: 60_000 });
      await expect(wbRow(page, hostedCard)).toHaveCount(0);

      await openList(page);
      await expect(itemRow(page, hostedCard)).toBeVisible();
      await expect(rowTag(page, hostedCard)).toHaveCount(0);
      await beat();
    });

    await chapter('The hosted continue stalls — its card comes back to To fix', async () => {
      // The lane's fake container never speaks, and the lane's stall window is 25s
      // (E2E_HOSTED_RUN_STALL_WINDOW_MS), so the continue started above dies the way a
      // silent agent does. A continue that dies is a dead run like any other: the card
      // is To fix again, and the command still names it.
      await expect
        .poll(() => fixReasonOf(hostedCard), { timeout: 120_000, intervals: [1_000] })
        .toBe('run_died');
      await page.goto('/workbench?tab=to-fix');
      await expect(wbRow(page, hostedCard)).toBeVisible({ timeout: 60_000 });
      await expect(wbRow(page, hostedCard)).toContainText(
        `motir continue ${hostedCard.identifier}`,
      );
      expect(await badgeCount(page, toFix)).toBe(3);
      await beat();
    });

    await chapter('A terminal continue clears another row on the next live poll', async () => {
      await page.goto('/workbench?tab=to-fix');
      await expect(wbRow(page, terminalCard)).toBeVisible({ timeout: 60_000 });
      await expect(wbRow(page, terminalCard)).toContainText(
        `motir continue ${terminalCard.identifier}`,
      );
      const url = page.url();
      await beat();

      const res = await api.post(`/api/v1/work-items/${terminalCard.identifier}/continue`);
      expect(res.status(), `continue → ${(await res.text()).slice(0, 300)}`).toBe(200);
      expect(await fixReasonOf(terminalCard)).toBeNull();

      await expect(wbRow(page, terminalCard)).toHaveAttribute('data-held', 'true', {
        timeout: 60_000,
      });
      await expect(wbRow(page, terminalCard)).toContainText(en.workbench.live.cleared);
      await expect.poll(() => badgeCount(page, toFix), { timeout: 60_000 }).toBe(2);
      expect(page.url(), 'nobody navigated').toBe(url);
      await beat();
    });

    await chapter('In 简体中文 — the row, the tag, the banner and the filter value', async () => {
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto('/workbench?tab=to-fix');
      await expect(wbRow(page, nothingCard)).toBeVisible({ timeout: 60_000 });
      await expect(main(page).getByTestId(`workbench-fix-${nothingCard.identifier}`)).toContainText(
        zh.workbench.toFix.reason.runDiedBare,
      );
      await expect(main(page).getByTestId(`workbench-fix-${nothingCard.identifier}`)).toContainText(
        plain(zh.github.development.continue.startOver, { target: nothingCard.identifier }),
      );
      await beat();

      await page.goto('/items?view=list');
      await expect(rowTag(page, nothingCard)).toHaveAttribute(
        'aria-label',
        zh.toFix.tagName.run_died,
        { timeout: 60_000 },
      );
      await page.goto(`/items/${nothingCard.identifier}`);
      await expect(banner(page)).toContainText(rich(zh.toFix.banner.runDiedNothingPushed), {
        timeout: 60_000,
      });
      await beat();
    });

    await chapter('Every row cleared — the empty state names five causes', async () => {
      // The two cards still listed are started over, as the nothing-pushed row said:
      // back to To Do.
      for (const card of [nothingCard, hostedCard]) {
        const res = await api.post(`/api/v1/work-items/${card.identifier}/transitions`, {
          data: { status: 'todo' },
        });
        expect(res.status(), `to do → ${(await res.text()).slice(0, 300)}`).toBe(200);
        expect(await fixReasonOf(card)).toBeNull();
      }

      await page.goto('/workbench?tab=to-fix');
      await expect(
        main(page).getByText(zh.workbench.empty.toFix.title, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(main(page).getByText(zh.workbench.empty.toFix.body)).toBeVisible();
      await beat();
    });
  });
});
