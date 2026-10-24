import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn, startSignedOut } from './_helpers/shell-session';
import { gotoLoadedBoard } from './_helpers/board';
import {
  openAgentSession,
  publishDesignResult,
  seedDesignApproval,
  servePublishedMock,
  type DesignApprovalSeed,
} from './_helpers/design-approval-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// YOU CAN TELL A DECISION IS WAITING THE MOMENT YOU LAND — the story's walk AND
// its acceptance receipt (Story MOTIR-4908 · Subtask MOTIR-5880).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The person a design approval is routed to lands on the board, the `/items`
// list and tree, and the card itself — and every one of them says, before they
// open anything, that a decision is waiting ON THEM. On the card, the marker in
// the header takes them straight to the section that holds the decision. They
// decide, and the marker is gone everywhere. A teammate sees the same cards
// marked QUIETLY, naming who the decision waits on.
//
// ── WHAT ONLY AN E2E CAN PROVE ──────────────────────────────────────────────
//
// 1. The header marker arrives in the EARLY render — it is in the viewport
//    before anything is scrolled, while the section it points at streams later.
// 2. Pressing it MOVES THE VIEWPORT to that late section: the band's Review &
//    approve is asserted in view, not merely present in the DOM.
// 3. A LAZILY-EXPANDED tree level carries the marker too.
//
// ⚠️ WHAT IS PUBLISHED FOR REAL: the design result, through
// `publish_design_result` over `/api/mcp` — publishing is what raises the gate.
// No `awaiting` row is hand-written.
//
// ⚠️ EVERY LOCATOR IS SCOPED (the MOTIR-5037 ratchet) and every assertion is on a
// MOUNTED marker first, so nothing passes vacuously on an absent element.

test.describe.configure({ timeout: 300_000 });

type Catalog = typeof en;

const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), template);

/** A board card is ONE button whose name is the card's own label. */
function boardCard(page: Page, m: Catalog, key: string, title: string) {
  return page.getByRole('main').getByRole('button', {
    name: fill(m.boards.openIssueAria, { key, title }),
    exact: true,
  });
}

/** An `/items` row — List and Tree share the testid, scoped to the page's main. */
function itemsRow(page: Page, key: string) {
  return page.getByRole('main').getByTestId(`issue-row-${key}`);
}

/** The Design result section card — found by its one heading. */
function designSection(page: Page, m: Catalog) {
  return page
    .getByRole('main')
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: m.designResult.title }) });
}

/** The strings the design's copy table gives each state, for one locale. */
function copy(m: Catalog, routedName: string) {
  const decision = m.approvalGate.statusHeld.decisionNoun.design_result;
  const glyphYours = fill(m.approvalGate.waiting.glyphYours, { decision });
  const glyphOn = fill(m.approvalGate.waiting.glyphOn, { name: routedName, decision });
  const jump = fill(m.approvalGate.waiting.jump, { decision });
  return {
    loud: m.approvalGate.state.awaitingYou,
    quiet: fill(m.approvalGate.waiting.on, { name: routedName }),
    glyphYours,
    glyphOn,
    headerYours: `${glyphYours}. ${jump}`,
    headerOn: `${glyphOn}. ${jump}`,
  };
}

async function publish(seed: DesignApprovalSeed, baseURL: string): Promise<void> {
  const client = await openAgentSession(seed.token, baseURL);
  const result = await publishDesignResult(client, seed.designKey);
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  await client.close();
}

async function useLocale(page: Page, locale: 'zh'): Promise<void> {
  // Scoped to the SITE root, never the current path (a cookie added from
  // `/items/<key>` would be path `/items/` and never reach `/boards`).
  await page
    .context()
    .addCookies([{ name: 'NEXT_LOCALE', value: locale, url: new URL('/', page.url()).href }]);
}

const ROUTED = 'Robin Vale';

test.describe('the decision-waiting marker', () => {
  let seed: DesignApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedDesignApproval(`dw${Date.now().toString(36)}`);
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('the routed member sees it on the board, the list, the tree and the card, follows it, decides — and it is gone', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4908');
    await servePublishedMock(page);
    await publish(seed, baseURL!);
    const c = copy(en, ROUTED);

    const designCard = boardCard(page, en, seed.designKey, seed.designTitle);
    const plainCard = boardCard(page, en, seed.dependentKey, seed.dependentTitle);
    const headerMarker = page.getByRole('button', { name: c.headerYours, exact: true });

    await chapter('On the board: the card waiting on you says so, loudly', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await gotoLoadedBoard(page);
      await expect(designCard).toBeVisible();
      const marker = designCard.locator('[data-decision-marker]');
      await expect(marker).toHaveAttribute('data-decision-marker', 'yours');
      await expect(marker).toHaveText(c.loud);
      // The card's own label would hide it; the button is DESCRIBED by it.
      await expect(designCard).toHaveAccessibleDescription(new RegExp(c.loud));
      // A card nothing waits on shows nothing.
      await expect(plainCard).toBeVisible();
      await expect(plainCard.locator('[data-decision-marker]')).toHaveCount(0);
    });

    await chapter('In the list, and in a lazily-expanded tree level', async () => {
      await page.goto('/items?view=list');
      const listRow = itemsRow(page, seed.designKey);
      await expect(listRow).toBeVisible();
      const listGlyph = listRow.getByRole('img', { name: c.glyphYours });
      await expect(listGlyph).toBeVisible();
      // The row is wider than the pane beside an open sidebar, so the Status
      // column scrolls; bring the glyph into view for whoever watches.
      await listGlyph.scrollIntoViewIfNeeded();
      await expect(itemsRow(page, seed.dependentKey).locator('[data-decision-marker]')).toHaveCount(
        0,
      );

      await page.goto('/items');
      // The first WORK-ITEM row that expands — a project's folders (Bugs) are rows
      // too, and one of them sorts first.
      const storyRow = page
        .getByRole('main')
        .locator('[data-testid^="issue-row-"]')
        .filter({ has: page.getByRole('button', { name: 'Expand row' }) })
        .first();
      await storyRow.getByRole('button', { name: 'Expand row' }).click();
      const childRow = itemsRow(page, seed.designKey);
      await expect(childRow).toBeVisible();
      const childGlyph = childRow.getByRole('img', { name: c.glyphYours });
      await expect(childGlyph).toBeVisible();
      await childGlyph.scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter(
      'On the card: the header says so before you scroll, and takes you there',
      async () => {
        await page.goto(`/items/${seed.designKey}`);
        await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();
        // Early render: in the viewport as the page lands.
        await expect(headerMarker).toBeInViewport();
        await expect(headerMarker.locator('[data-decision-marker]')).toHaveAttribute(
          'data-decision-marker',
          'yours',
        );

        const door = designSection(page, en).getByRole('link', {
          name: en.approvalGate.statusHeld.reviewAndApprove,
        });
        await expect(door).toBeAttached();
        await headerMarker.click();
        // THE VIEWPORT MOVED to the late section: the band's one door is in view.
        await expect(door).toBeInViewport();
      },
    );
    await beat();

    await chapter('Decide it — the marker is gone on the card and on the board', async () => {
      const dialog = page.getByRole('dialog', {
        name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
      });
      await designSection(page, en)
        .getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove })
        .click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
      await expect(dialog.getByText(en.approvalGate.confirm.title)).toBeVisible();
      const decided = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await dialog.getByRole('button', { name: 'Yes, Approve' }).click();
      expect((await decided).status()).toBe(200);
      await expect(dialog.getByText(en.approvalGate.state.approved, { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      // The decided record proves the page has caught up — THEN the marker is gone.
      await expect(
        designSection(page, en).getByText(en.approvalGate.state.approved, { exact: true }),
      ).toBeVisible();
      await expect(headerMarker).toHaveCount(0);

      await gotoLoadedBoard(page);
      await expect(designCard).toBeVisible();
      await expect(designCard.locator('[data-decision-marker]')).toHaveCount(0);
    });
  });

  test('a teammate the gate is not routed to sees the QUIET marker, naming who it waits on', async ({
    page,
    baseURL,
  }) => {
    await servePublishedMock(page);
    await publish(seed, baseURL!);
    const c = copy(en, ROUTED);
    await signIn(page, seed.readerEmail, seed.password);

    await gotoLoadedBoard(page);
    const quiet = boardCard(page, en, seed.designKey, seed.designTitle).locator(
      '[data-decision-marker]',
    );
    await expect(quiet).toHaveAttribute('data-decision-marker', 'others');
    await expect(quiet).toHaveText(c.quiet);
    // A DISTINCT TREATMENT, asserted on the element: the neutral chip, never the
    // loud yellow tint.
    await expect(quiet).toHaveClass(/--el-chip-bg/);
    await expect(quiet).not.toHaveClass(/--el-tint-yellow/);

    await page.goto('/items?view=list');
    const glyph = itemsRow(page, seed.designKey).getByRole('img', { name: c.glyphOn });
    await expect(glyph).toHaveAttribute('data-decision-marker', 'others');

    await page.goto(`/items/${seed.designKey}`);
    const header = page.getByRole('button', { name: c.headerOn, exact: true });
    await expect(header).toBeInViewport();
    await expect(header.locator('[data-decision-marker]')).toHaveAttribute(
      'data-decision-marker',
      'others',
    );
  });

  test('a card whose gate was decided, and one that never had one, show no marker anywhere', async ({
    page,
    baseURL,
  }) => {
    await servePublishedMock(page);
    await publish(seed, baseURL!);
    await signIn(page, seed.reviewerEmail, seed.password);

    // Decide it through the one door.
    await page.goto(`/items/${seed.designKey}`);
    const dialog = page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
    });
    await designSection(page, en)
      .getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove })
      .click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
    const decided = page.waitForResponse(
      (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
    );
    await dialog.getByRole('button', { name: 'Yes, Approve' }).click();
    expect((await decided).status()).toBe(200);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await gotoLoadedBoard(page);
    for (const [key, title] of [
      [seed.designKey, seed.designTitle],
      [seed.dependentKey, seed.dependentTitle],
    ] as const) {
      const card = boardCard(page, en, key, title);
      await expect(card).toBeVisible();
      await expect(card.locator('[data-decision-marker]')).toHaveCount(0);
    }
    await page.goto('/items?view=list');
    for (const key of [seed.designKey, seed.dependentKey]) {
      await expect(itemsRow(page, key)).toBeVisible();
      await expect(itemsRow(page, key).locator('[data-decision-marker]')).toHaveCount(0);
    }
  });

  test('both states in Chinese', async ({ page, baseURL }) => {
    await servePublishedMock(page);
    await publish(seed, baseURL!);
    const c = copy(zh as unknown as Catalog, ROUTED);

    await signIn(page, seed.reviewerEmail, seed.password);
    await useLocale(page, 'zh');
    await gotoLoadedBoard(page);
    const loud = boardCard(
      page,
      zh as unknown as Catalog,
      seed.designKey,
      seed.designTitle,
    ).locator('[data-decision-marker]');
    await expect(loud).toHaveAttribute('data-decision-marker', 'yours');
    await expect(loud).toHaveText(c.loud);
    await page.goto(`/items/${seed.designKey}`);
    await expect(page.getByRole('button', { name: c.headerYours, exact: true })).toBeVisible();

    // Drop the zh cookie before signing in again: the sign-in helper reads the
    // English form labels.
    await startSignedOut(page);
    await page.context().clearCookies();
    await signIn(page, seed.readerEmail, seed.password);
    await useLocale(page, 'zh');
    await gotoLoadedBoard(page);
    const quiet = boardCard(
      page,
      zh as unknown as Catalog,
      seed.designKey,
      seed.designTitle,
    ).locator('[data-decision-marker]');
    await expect(quiet).toHaveAttribute('data-decision-marker', 'others');
    await expect(quiet).toHaveText(c.quiet);
    await page.goto('/items?view=list');
    await expect(
      itemsRow(page, seed.designKey).getByRole('img', { name: c.glyphOn }),
    ).toBeVisible();
  });
});
