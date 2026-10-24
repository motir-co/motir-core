import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { AGENT_PLAN_SEED_PASSWORD } from './_helpers/agent-authored-plan-seed';
import {
  PROPOSED_STORY,
  REMOVE_REASON,
  Z_BODY,
  Z_RENAMED,
  seedSurgicalPlan,
  type SurgicalPlanSeed,
} from './_helpers/surgical-plan-seed';

// THE SURGICAL PLAN, REVIEWED AND APPROVED — THE ACCEPTANCE RECEIPT (Story
// MOTIR-6013 · Subtask MOTIR-6058).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A planner wrote ONE plan through the real MCP tools that does three surgical
// things to cards outside the tree it was laying: it proposes a new story and
// MOVES a committed card under it, it UPDATES a card in another epic twice (one
// change, merged), and it REMOVES an obsolete card, saying why. The clip reads it
// the way the person approving it would:
//
//   1. the moved card is named under `New · <story title>` — never an internal
//      `planItem:` id, which is what rendered before this story;
//   2. the twice-updated card is ONE change carrying both edits;
//   3. the removed card says WHY, in the list, on the canvas and in its peek;
//   4. approve lands all three — the story exists with the card under it, the
//      update is applied, and the obsolete card is archived.
//
// The planner's own LLM run is not in this lane (motir-ai is not reachable from
// here); its half is the motir-ai integration gate, MOTIR-6063.

const PLAN_TITLE = 'Move delivery retries to webhooks';

/** The plan's state chip on the Plans list, found by its row's title link (an
 *  agent's conversation has no first turn, so its row is titled by its plan).
 *
 *  ⚠️ NOT an `a[href="/plans/<id>"]` (Story MOTIR-7883 · MOTIR-7889, 2026-10-08): an
 *  undecided plan's chip is an overlay door, whose href is the overlay address. */
const planChip = (page: Page) =>
  page
    .getByRole('list', { name: 'Planning conversations' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: PLAN_TITLE, exact: true }) })
    .getByRole('link', { name: /^Open the plan — / });
/** The live page body — every locator is scoped, never page-rooted (MOTIR-5037). */
const main = (page: Page) => page.getByRole('main');
/** The planning overlay an undecided plan is reviewed in (Story MOTIR-7883). */
const overlayOf = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const canvasOf = (root: Locator) => root.getByTestId('roadmap-canvas');
const statusPill = (page: Page) => main(page).getByTestId('plan-status-pill');
/** The proposal peek is a modal, portalled outside `main`. */
const peekOf = (page: Page) => page.getByRole('dialog').getByTestId('proposal-peek');
const nodeOf = (canvas: Locator, nodeId: string) => canvas.locator(`[data-node-id="${nodeId}"]`);

// Every review helper below reads under a ROOT: the planning overlay while the plan
// is undecided, the decided plan page's `main` once it is not.

/** A proposal's door in the list body — named `Open <KEY> · <title>`. */
const openButton = (root: Locator, card: { identifier: string }, title: string) =>
  root.getByRole('button', { name: `Open ${card.identifier} · ${title}`, exact: true });

/** The plan's list body — one row per proposal, found by its door. */
const listRow = (root: Locator, card: { identifier: string }, title: string) =>
  openButton(root, card, title).locator('xpath=ancestor::li[1]');

/** The shipped List / Canvas switch — a labelled group of pressed buttons. */
const viewButton = (root: Locator, name: 'List' | 'Canvas') =>
  root.getByRole('group', { name: 'Plan view' }).getByRole('button', { name, exact: true });

async function toList(root: Locator) {
  await viewButton(root, 'List').click();
  await expect(root.getByTestId('plan-proposal-list')).toBeVisible();
}

async function openSeed(page: Page, baseURL: string | undefined): Promise<SurgicalPlanSeed> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  await resetDatabase();
  const seed = await seedSurgicalPlan('surgical-plan@example.com', baseURL);
  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);
  return seed;
}

test('a plan that moves, updates and removes cards outside its tree reads plainly and approves', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6013');
  const seed = await openSeed(page, baseURL);
  const overlay = overlayOf(page);

  await chapter('The plan the agent wrote is waiting in Plans', async () => {
    const plansNav = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plans' });
    await plansNav.click();
    await page.waitForURL('**/plans');
    await expect(planChip(page)).toHaveAccessibleName('Open the plan — Waiting for approval');
    await beat();
    // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7889), 2026-10-08: the chip opens the
    // undecided plan in the planning overlay IN PLACE, over the Plans list. The
    // overlay has no review rail, so the undecided `Ready to review` pill is not read
    // (the decided page's pill is, after the approve).
    await planChip(page).click();
    await page.waitForURL(
      (url) => url.pathname === '/plans' && url.searchParams.has('planSession'),
    );
    await expect(overlay.getByTestId('plan-proposal-views')).toBeVisible();
    // No internal temp-ref reaches the page — anywhere.
    await expect(page.getByText(/planItem:/)).toHaveCount(0);
    await beat();
  });

  await chapter(
    'Show changes — the move names the proposed story, the update is ONE change',
    async () => {
      await toList(overlay);
      const moved = listRow(overlay, seed.x, seed.x.title);
      await expect(moved).toContainText('Parent');
      await expect(moved).toContainText(seed.fStory.identifier);
      await expect(moved).toContainText(`New · ${PROPOSED_STORY}`);
      await beat();

      // Z was updated twice; the plan holds ONE proposal carrying both edits.
      await expect(openButton(overlay, seed.z, Z_RENAMED)).toHaveCount(1);
      const updated = listRow(overlay, seed.z, Z_RENAMED);
      await expect(updated).toContainText('Title');
      await expect(updated).toContainText('Description');
      await beat();

      const removed = listRow(overlay, seed.y, seed.y.title);
      await expect(removed.getByTestId('remove-reason')).toContainText('Reason');
      await expect(removed.getByTestId('remove-reason')).toContainText(REMOVE_REASON);
      await expect(page.getByText(/planItem:/)).toHaveCount(0);
      await beat();
    },
  );

  await chapter('On the canvas, the removal carries its reason', async () => {
    await viewButton(overlay, 'Canvas').click();
    const canvas = canvasOf(overlay);
    // The plan fills the Invoices level most (the update and the removal).
    const removedNode = nodeOf(canvas, seed.y.id);
    await expect(removedNode).toBeVisible();
    await expect(removedNode.getByTestId('remove-reason')).toContainText(
      REMOVE_REASON.slice(0, 20),
    );
    await expect(removedNode.getByTestId('remove-reason').locator('[title]')).toHaveAttribute(
      'title',
      REMOVE_REASON,
    );
    await beat();
  });

  await chapter('The peeks: why the card goes, and both edits marked', async () => {
    await toList(overlay);
    await openButton(overlay, seed.y, seed.y.title).click();
    const peek = peekOf(page);
    await expect(peek).toBeVisible();
    await expect(peek.getByTestId('remove-reason')).toContainText(REMOVE_REASON);
    await beat();
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);

    await openButton(overlay, seed.z, Z_RENAMED).click();
    await expect(peekOf(page)).toBeVisible();
    await expect(peekOf(page)).toContainText(Z_RENAMED);
    await expect(peekOf(page)).toContainText('A retry waits twice as long');
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('Approve — the three edits land', async () => {
    const approved = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/plans/${seed.planId}/approve`) && r.request().method() === 'POST',
    );
    // Undecided, so it is approved in the overlay's footer (Story MOTIR-7883).
    await overlay
      .getByTestId('plan-change-confirm-bar')
      .getByRole('button', { name: 'Approve', exact: true })
      .click();
    expect((await approved).status()).toBe(200);
    await page.goto(`/plans/${seed.planId}`); // decided: the plan page renders
    await expect(statusPill(page)).toContainText('Approved');

    // The decided list names the CREATED story by its key now.
    const story = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: seed.projectId, title: PROPOSED_STORY },
    });
    await toList(main(page));
    await expect(listRow(main(page), seed.x, seed.x.title)).toContainText(story.identifier);
    await beat();
  });

  await chapter(
    'The moved card sits under the new story; the update and the removal applied',
    async () => {
      const story = await adminDb.workItem.findFirstOrThrow({
        where: { projectId: seed.projectId, title: PROPOSED_STORY },
      });
      await page.goto(`/items/${seed.x.identifier}`);
      const parents = page.getByRole('navigation', { name: 'Parent work items' });
      await expect(parents.getByRole('link', { name: `Story: ${PROPOSED_STORY}` })).toHaveAttribute(
        'href',
        `/items/${story.identifier}`,
      );
      await beat();

      await page.goto(`/items/${seed.z.identifier}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(Z_RENAMED);
      await expect(main(page).getByText(Z_BODY.split('- ')[1]!)).toBeVisible();
      await beat();

      await page.goto(`/items/${seed.y.identifier}`);
      await expect(page.getByText('Archived').first()).toBeVisible();
      await beat();
    },
  );
});

test('a remove with no reason draws no reason line', async ({ page, baseURL, acceptanceStory }) => {
  acceptanceStory('MOTIR-6013');
  const seed = await openSeed(page, baseURL);
  // Undecided, so it is read in the planning overlay (Story MOTIR-7883).
  let overlay = await openUndecidedPlan(page, seed.bareRemovePlanId, { view: 'list' });
  await expect(openButton(overlay, seed.w, seed.w.title)).toBeVisible();
  await expect(overlay.getByTestId('remove-reason')).toHaveCount(0);
  overlay = await openUndecidedPlan(page, seed.bareRemovePlanId, { view: 'canvas' });
  await expect(nodeOf(overlay.getByTestId('roadmap-canvas'), seed.w.id)).toBeVisible();
  await expect(overlay.getByTestId('remove-reason')).toHaveCount(0);
});

test('approve refuses a move whose proposed parent became illegal, and creates nothing', async ({
  page,
  baseURL,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6013');
  const seed = await openSeed(page, baseURL);
  // Undecided, so it is approved — and refused — in the planning overlay (MOTIR-7883).
  const overlay = await openUndecidedPlan(page, seed.illegalPlanId, { view: 'list' });
  const refused = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${seed.illegalPlanId}/approve`) &&
      r.request().method() === 'POST',
  );
  await overlay
    .getByTestId('plan-change-confirm-bar')
    .getByRole('button', { name: 'Approve', exact: true })
    .click();
  expect((await refused).status()).toBe(400);
  // The refusal line (the route announcer is also an `alert`, and empty).
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible();
  // Nothing was approved: the plan's committed status is the authority.
  expect(
    (await adminDb.plan.findUniqueOrThrow({ where: { id: seed.illegalPlanId } })).status,
  ).not.toBe('approved');
  expect(
    await adminDb.workItem.count({ where: { projectId: seed.projectId, title: 'Dunning' } }),
  ).toBe(0);
  const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: seed.illegalCard.id } });
  expect(card.parentId).toBe(seed.fStory.id);
});
