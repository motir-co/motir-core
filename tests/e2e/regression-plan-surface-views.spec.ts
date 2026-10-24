import { writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import {
  finishSessionPlanWithEdge,
  latestPlanningSession,
} from './_helpers/planChangeConversation';
import en from '@/messages/en.json';

// MOTIR-6188 — the surface-views E2E + ACCEPTANCE VIDEO.
//
// The story's journey, in a real browser: a person reads a proposed plan on the
// planning surface **as its own page shows it**, switches views without losing
// their draft or their place, and approves it from the List.
//
// ── Why this cannot be a lower tier ─────────────────────────────────────────
// Two of its claims are browser facts across two panes, and no happy-dom render
// can make them: *the composer draft survives a switch* (the draft lives in the
// rail, the switch is in the other pane) and *the canvas keeps its level* (the
// level lives inside a canvas that must never unmount). MOTIR-6187 proves the
// two hosts draw the same MODEL; this proves a person can actually use it.
//
// ── The recording ───────────────────────────────────────────────────────────
// The happy path is chaptered and paced for a human watcher, and published to
// MOTIR-6155 as its acceptance receipt. Every `beat()` comes AFTER the assertion
// that proved the state — pacing, never waiting (`CLAUDE.md` § E2E).

const planReview = en.planReview;
const surface = en.approvalGate.planApproval.surface;

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const views = (page: Page) => workspace(page).getByTestId('plan-proposal-views');
const viewSwitch = (page: Page) =>
  workspace(page).getByRole('group', { name: planReview.viewSwitchAria });
const viewButton = (page: Page, name: string) =>
  viewSwitch(page).getByRole('button', { name, exact: true });
const list = (page: Page) => workspace(page).getByTestId('plan-proposal-list');
// ⚠️ NOT `plan-review-canvas`: that testid exists only in the unit suites'
// `vi.mock` of this component. The REAL engine renders `planning-canvas`
// (`PlanningCanvas.tsx:405`), which is what a browser can see.
const canvas = (page: Page) => workspace(page).getByTestId('planning-canvas');
const keepalive = (page: Page) => workspace(page).getByTestId('plan-review-canvas-keepalive');
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const overlayOpen = (url: URL) => url.searchParams.has('plan');

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** The lane's motir-ai mock proposes nothing; the run is finished by the shipped
 *  services instead, which is what `finishSessionPlanWithEdge` does. */
function resetJobsFixture(): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], submitted: [] }, null, 2));
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

/** Open *Plan with AI* from the card, and prove the surface MOUNTED first. */
async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Ask from the CARD — the anchored door appends AND submits in one call, and
 *  its 200 is the authoritative "the session holds this turn". */
async function askFromCard(page: Page, text: string): Promise<void> {
  const answered = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await answered;
}

const THREE = [
  'Lift the shared views',
  'Mount them on the surface',
  'Walk it in a browser',
] as const;

test.describe.configure({ timeout: 240_000 });

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a proposed plan reads on the surface as its own page shows it, and approves from the List', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6155');

  const email = `surface-views-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const story = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: seed.storyKey },
    select: { id: true },
  });

  let planId = '';

  await chapter('Ask Motir AI for a change to this story', async () => {
    await openFromCard(page, seed.storyKey);
    await askFromCard(page, 'Split the surface work so the shared views can ship on their own.');
    await expect(rail(page)).toContainText('Split the surface work');
    await beat();
  });

  await chapter('The plan is proposed — the surface shows it as the plan page does', async () => {
    const session = await latestPlanningSession(email);
    ({ planId } = await finishSessionPlanWithEdge(session.id, story.id, [...THREE] as [
      string,
      string,
      string,
    ]));

    // Re-open on the proposed plan. The pane is the plan page's own component now.
    await page.reload();
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(viewSwitch(page)).toBeVisible();
    // …and the gate is under it, with both verbs.
    await expect(bar(page)).toContainText(surface.consequence);
    await expect(verb(bar(page), surface.approve)).toBeEnabled();
    await beat();
  });

  await chapter('Canvas: the three proposed cards, and the arrow between two of them', async () => {
    await viewButton(page, planReview.viewCanvas).click();
    await expect(canvas(page)).toBeVisible();
    for (const title of THREE) {
      await expect(workspace(page).getByText(title, { exact: false }).first()).toBeVisible();
    }
    // The PENDING edge — the dashed arrow a proposal draws between two cards
    // that do not exist yet. This is the thing a hand-built fixture gets wrong
    // and the thing both hosts must agree on. Located the way
    // `child-panel-graph.spec.ts` locates an edge: a `<path>` in the engine's
    // own `canvas-edges` layer, so the assertion survives a restyle.
    await expect
      .poll(async () => workspace(page).locator('[data-testid="canvas-edges"] path').count(), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    await beat();
  });

  await chapter('List: the same three cards, listed', async () => {
    await viewButton(page, planReview.viewList).click();
    await expect(list(page)).toBeVisible();
    for (const title of THREE) {
      await expect(list(page).getByText(title, { exact: false }).first()).toBeVisible();
    }
    // The bar did NOT move: it is the pane's gate, not either body's.
    await expect(bar(page)).toContainText(surface.consequence);
    await expect(verb(bar(page), surface.approve)).toBeEnabled();
    await beat();
  });

  await chapter('A question typed on List survives the trip back to Canvas', async () => {
    const DRAFT = 'Why is the second one blocked?';
    await composer(page).fill(DRAFT);
    await expect(composer(page)).toHaveValue(DRAFT);

    await viewButton(page, planReview.viewCanvas).click();
    await expect(canvas(page)).toBeVisible();

    // The draft lives in the RAIL — the other pane — so the switch cannot reach
    // it. Asserted rather than assumed.
    await expect(composer(page)).toHaveValue(DRAFT);
    // …and the canvas was never unmounted, which is what keeps its level.
    await expect(keepalive(page)).toBeVisible();
    await beat();
    await composer(page).fill('');
  });

  // ⚠️ RETIRED 2026-10-08 by Story MOTIR-7883 (MOTIR-7886): a chapter here opened the
  // plan's own page and showed it held the same list. A member's `/plans/<id>` for an
  // undecided plan now lands in this very overlay, so the comparison has nothing left
  // to compare; the pane IS the plan page's `PlanProposalViews` (MOTIR-6186).

  await chapter('Approve from the List — the cards land in the backlog', async () => {
    await viewButton(page, planReview.viewList).click();
    await expect(list(page)).toBeVisible();

    const decided = page.waitForResponse(
      (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
    );
    await verb(bar(page), surface.approve).click();
    await decided;

    // The committed read is the authority, not the screen.
    await expect
      .poll(async () => (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status, {
        timeout: 20_000,
      })
      .toBe('approved');
    const children = await adminDb.workItem.findMany({
      where: { parentId: story.id, archivedAt: null },
      select: { title: true },
    });
    for (const title of THREE) {
      expect(children.map((c) => c.title)).toContain(title);
    }
    // …and the pane kept the view the reader decided from.
    await expect(list(page)).toBeVisible();
    await beat();
  });
});

// ── UNRECORDED — the states a receipt does not need to show ──────────────────

test('with NO plan there is no switch, and no foot under the canvas', async ({ page }) => {
  const email = `surface-views-noplan-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  await openFromCard(page, seed.storyKey);

  // The roadmap canvas, exactly as shipped — and nothing else.
  await expect(views(page)).toHaveCount(0);
  await expect(viewSwitch(page)).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  // ⚠️ Part XXI 21.8 — the footer HIDES when there is nothing to show. The
  // resting footer this used to render is gone, and its absence is the assertion.
  await expect(workspace(page).getByTestId('plan-change-canvas-footer')).toHaveCount(0);
});

test('switching views writes NOTHING to the URL', async ({ page }) => {
  const email = `surface-views-url-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const story = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: seed.storyKey },
    select: { id: true },
  });

  await openFromCard(page, seed.storyKey);
  await askFromCard(page, 'Split this story.');
  const session = await latestPlanningSession(email);
  await finishSessionPlanWithEdge(session.id, story.id, [...THREE] as [string, string, string]);
  await page.reload();
  await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

  // The overlay is over whichever page the reader is on, so the address bar is
  // that page's. `?view=` is not even a free name — the plan page uses it.
  const before = page.url();
  await viewButton(page, planReview.viewList).click();
  await expect(list(page)).toBeVisible();
  await viewButton(page, planReview.viewCanvas).click();
  await expect(canvas(page)).toBeVisible();

  expect(page.url()).toBe(before);
});
