// Acceptance E2E — a "To do" epic with no children shows as To plan and offers the
// Plan button on hover (Story MOTIR-10861 · Subtask MOTIR-11108; design MOTIR-11106).
//
// The story widened the shared status-slot rule (`isToPlanItem`,
// `lib/workItems/statusSlot.ts`) from stories to epics. That one rule decides the
// slot on every surface, so this spec walks each of them for ONE childless To Do
// epic:
//
//   THE RECORDED WALK (the receipt a person watches to accept the story):
//     1. The roadmap canvas — the epic's card wears the To plan pill and the yellow
//        To plan wash (`data-node-state="to-plan"`).
//     2. Hover the card — the `data-action="plan"` next action appears.
//     3. Click Plan — the plannability check answers, and the planning overlay opens
//        with the epic as its target (`planItem=<key>`, the "Start planning <key>"
//        prompt).
//
//   THE REST (still in the receipt, after the happy path):
//     4. /boards, the quick view opened from its board card, and the item page each
//        show the To plan pill — and none of them draws the canvas card's Plan
//        button, which belongs to the roadmap card only.
//     5. A child is added to the epic — its card leaves To plan: no pill, no wash,
//        no Plan button.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'), where
// motir-ai is configured and mocked under the routes, so the roadmap offers the
// member's Plan action (`nextActions: { plan: aiConfigured }`). Nothing here starts
// a planning run: the overlay opens on its start prompt, which asks before it
// sends anything, so no job is submitted and no seam is declared. The status slot
// is a pure function of data the page already holds — it has no loading, empty or
// error state of its own, so none is driven here; the reader-cannot-plan case is
// the unit tests' (`nextActions.plan`).
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal armed before the action that causes
// it: the roadmap level GET, the plannability GET, the peek GET, the URL the
// overlay writes — then the rendered `data-node-state` / pill. `beat()` and the
// chapter hold are the recording's pacing, taken only after the assertion that
// proved the state, never synchronisation.

import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import { grantPaidAiPlanIfBilled } from './_helpers/billing';
import { getFullBoard } from './_helpers/board';
import { workItemsService } from '@/lib/services/workItemsService';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

const EPIC_TITLE = 'Mobile app';
const CHILD_TITLE = 'Offline sync';

// ── Locators ────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });
/** The canvas NODE carrying a title — the wrapper that holds both the card frame and
 *  its next-action button, which hangs beside the frame rather than inside it. */
const canvasNode = (page: Page, title: string): Locator =>
  page.locator('[data-node-id]').filter({ hasText: title });
/** The node's card frame — its `data-node-state` is the card's authoritative state. */
const frameOf = (node: Locator): Locator => node.locator('[data-node-state]');
const planButton = (scope: Locator) => scope.locator('[data-action="plan"]');
const toPlanPill = (scope: Locator) => scope.getByTestId('to-plan-pill');
const boardCard = (page: Page, identifier: string) =>
  main(page).getByTestId(`board-card-${identifier}`);
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const startPrompt = (page: Page, key: string) =>
  page.getByRole('region', {
    name: en.planningWorkspace.startPrompt.label.replace('{key}', key),
  });

// ── Authoritative signals ───────────────────────────────────────────────────

const pathOf = (r: Response) => new URL(r.url()).pathname;
const rootLevelLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/projects/') &&
      r.url().includes('/roadmap') &&
      !r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
const plannabilityCheck = (page: Page, key: string) =>
  page.waitForResponse(
    (r) =>
      pathOf(r) === '/api/work-items/plannability' &&
      new URL(r.url()).searchParams.get('key') === key &&
      r.request().method() === 'GET',
  );
const peekRead = (page: Page) =>
  page.waitForResponse(
    (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
  );

/**
 * The epic's board card, scrolled into its column's window. A board column
 * VIRTUALIZES its stack (`useRowWindow`), so a card low in To Do mounts only once
 * the column scrolls, the way a person reaches it. Each column's scroller is
 * stepped down until the card mounts (the `acceptance-review-path` helper).
 */
async function revealBoardCard(page: Page, identifier: string): Promise<Locator> {
  const target = boardCard(page, identifier);
  await expect
    .poll(
      async () => {
        if ((await target.count()) > 0) return true;
        await main(page)
          .locator('[data-testid^="board-column-"] div.overflow-y-auto')
          .evaluateAll((els) => {
            for (const el of els) {
              el.scrollTop += el.clientHeight / 2;
              el.dispatchEvent(new Event('scroll'));
            }
          });
        return false;
      },
      { timeout: FIRST_PAINT_MS },
    )
    .toBe(true);
  await target.scrollIntoViewIfNeeded();
  return target;
}

/** Open /roadmap from the primary nav and wait for its root level to land. */
async function openRoadmap(page: Page): Promise<void> {
  const nav = roadmapNav(page);
  await expect(nav).toBeVisible({ timeout: FIRST_PAINT_MS });
  const loaded = rootLevelLoad(page);
  await nav.click();
  await page.waitForURL('**/roadmap');
  await loaded;
  await expect(main(page).getByTestId('planning-canvas')).toBeVisible();
}

// ── Fixture ─────────────────────────────────────────────────────────────────

let seed: AiAugmentReplanSeed;
let epicKey: string;
let epicId: string;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  seed = await seedAiAugmentReplan(`epic-to-plan-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  // THE STORY'S SUBJECT: a root epic in the default To Do status with no children —
  // created through the same service the product's own create path runs.
  const epic = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'epic', title: EPIC_TITLE },
    seed.ctx,
  );
  epicKey = epic.identifier;
  epicId = epic.id;
  const workspaceRow = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.ctx.workspaceId },
  });
  // On this cloud-on lane an org the billing fixture does not name reads as free;
  // the planning entrance is a paid-plan surface, so give it the paid plan.
  if (workspaceRow.organizationId) grantPaidAiPlanIfBilled(workspaceRow.organizationId);
  await signIn(page, seed.email, seed.password);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('a childless To do epic is To plan on every surface, and its roadmap card plans it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-10861');
  const card = canvasNode(page, EPIC_TITLE);

  // ── 1. The roadmap card wears To plan ─────────────────────────────────────
  await chapter('A childless To do epic shows To plan on the roadmap', async () => {
    await openRoadmap(page);
    await expect(frameOf(card)).toHaveAttribute('data-node-state', 'to-plan');
    await expect(toPlanPill(card)).toBeVisible();
    // The epic's status chip gives way to the pill: the slot holds one of them.
    await expect(card.getByTestId('ready-pill')).toHaveCount(0);
    await beat();
  });

  // ── 2. Hover → the Plan next action ───────────────────────────────────────
  await chapter('Hovering the epic offers Plan', async () => {
    await card.hover();
    await expect(planButton(card)).toBeVisible();
    await expect(planButton(card)).toHaveAccessibleName(
      en.aiPlanning.entrance.planAria.replace('{item}', epicKey),
    );
    await beat();
  });

  // ── 3. Plan → the plannability check → the overlay, on the epic ───────────
  await chapter('Plan opens planning with the epic as the target', async () => {
    const checked = plannabilityCheck(page, epicKey);
    await planButton(card).click();
    const answer = await checked;
    expect(answer.status(), await answer.text()).toBe(200);
    expect(await answer.json()).toMatchObject({ plannable: true, reasons: [] });

    await page.waitForURL(
      (url) => url.searchParams.has('plan') && url.searchParams.get('planItem') === epicKey,
    );
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    // The overlay ASKS before it sends anything, naming the epic it will plan.
    await expect(startPrompt(page, epicKey)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(startPrompt(page, epicKey).getByTestId('plan-start-confirm')).toBeVisible();
    await beat();

    await page.keyboard.press('Escape');
    await page.waitForURL((url) => !url.searchParams.has('plan'));
    await expect(workspace(page)).toHaveCount(0);
  });

  // ── 4. The same slot on /boards, the quick view and the item page ─────────
  await chapter('The board card, quick view and item page show To plan too', async () => {
    // The board's own read first: the epic is on it, in a lane, before the page is
    // asked to draw it.
    const board = await getFullBoard(page.request);
    expect(
      board.columns.flatMap((c) => c.cards.map((card) => card.identifier)),
      'the epic is on the default board',
    ).toContain(epicKey);
    await page.goto('/boards');
    await expect(main(page).locator('[data-testid^="board-column-"]').first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    const onBoard = await revealBoardCard(page, epicKey);
    await expect(onBoard).toBeVisible();
    await expect(toPlanPill(onBoard)).toBeVisible();
    await expect(planButton(onBoard)).toHaveCount(0);
    await beat();

    const peeked = peekRead(page);
    await onBoard.click();
    expect((await peeked).status()).toBe(200);
    const peek = page.getByRole('dialog').first();
    await expect(peek).toBeVisible();
    await expect(toPlanPill(peek)).toBeVisible();
    await expect(planButton(peek)).toHaveCount(0);
    await beat();
    await page.keyboard.press('Escape');

    await page.goto(`/items/${epicKey}`);
    await expect(main(page).getByText(EPIC_TITLE).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(toPlanPill(main(page))).toBeVisible();
    await expect(main(page).getByTestId('node-next-action')).toHaveCount(0);
    await beat();
  });

  // ── 5. A child arrives → the epic is no longer To plan ────────────────────
  await chapter('Once the epic has a child, To plan and Plan are gone', async () => {
    await workItemsService.createWorkItem(
      { projectId: seed.projectId, kind: 'story', title: CHILD_TITLE, parentId: epicId },
      seed.ctx,
    );
    await openRoadmap(page);
    await expect(card).toBeVisible();
    await expect(frameOf(card)).not.toHaveAttribute('data-node-state', 'to-plan');
    await expect(toPlanPill(card)).toHaveCount(0);
    await card.hover();
    await expect(planButton(card)).toHaveCount(0);
    await beat();
  });
});
