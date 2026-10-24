import { writeFileSync } from 'node:fs';
import type { Locator, Page, Route } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import {
  finishSessionPlanWithEdge,
  latestPlanningSession,
} from './_helpers/planChangeConversation';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// MOTIR-5252 — the approve-progress E2E + ACCEPTANCE VIDEO (story MOTIR-5246).
//
// The story's journey, in a real browser, on the PLANNING OVERLAY — the one place
// approve lives (design `design/ai-planning/design-notes.md` Part XXV, approved as
// MOTIR-5248): a person approves a multi-item plan and is told, while it runs, how
// many items are being added and that they arrive together; a slow approve says it
// is still working and that there is no need to press again; an approve that runs
// out of time says nothing was written and that approving again is safe — and it is.
//
// ── What is stubbed, and why ────────────────────────────────────────────────
// The approve endpoint is HELD by `page.route` so the in-flight state stays on
// screen until the spec has asserted it: an ordinary approve of three items lands
// in well under a second, which no watcher could read and no assertion could catch
// without racing. The FIRST press is answered with the route's own timeout refusal
// (503 `PLAN_APPROVE_TIMED_OUT`, the exact body `app/api/plans/[id]/approve/route.ts`
// sends), because exhausting a real transaction budget on demand is not something a
// browser test can do. The SECOND press goes through to the real route, and the
// committed read — the plan `approved`, the three cards under the story — is the
// authority that it worked.
//
// Every `beat()` comes AFTER the assertion that proved the state — pacing, never
// waiting (`CLAUDE.md` § E2E).

const surface = en.approvalGate.planApproval.surface;

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const views = (page: Page) => workspace(page).getByTestId('plan-proposal-views');
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const progressIn = (scope: Locator) => scope.getByTestId('plan-approve-progress');
const overlayOpen = (url: URL) => url.searchParams.has('plan');

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

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

async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

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

/** Hold every approve of `planId` until `release()`, then hand the request to
 *  `answer`. The hold is what keeps the in-flight state assertable. */
async function holdApprove(
  page: Page,
  planId: string,
  answer: (route: Route) => Promise<void>,
): Promise<{ release: () => void; unroute: () => Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const pattern = `**/api/plans/${planId}/approve`;
  const handler = async (route: Route) => {
    await held;
    await answer(route);
  };
  await page.route(pattern, handler);
  return { release, unroute: () => page.unroute(pattern, handler) };
}

const timedOutBody = (planId: string) =>
  JSON.stringify({
    code: 'PLAN_APPROVE_TIMED_OUT',
    planId,
    itemCount: 3,
    error: 'exceeded the transaction budget and was rolled back',
  });

function approveResponse(page: Page, planId: string) {
  return page.waitForResponse(
    (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
  );
}

const THREE = ['Draft the export format', 'Write the exporter', 'Walk it in a browser'] as const;

/** Seed a story, ask on it, and finish the planner's run with three proposals. */
async function proposedPlan(page: Page, prefix: string) {
  const email = `${prefix}-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);
  const story = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: seed.storyKey },
    select: { id: true },
  });
  return { email, seed, story };
}

test.describe.configure({ timeout: 240_000 });

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('approving a plan says what it is adding, survives a timeout, and lands on the retry', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-5246');
  const copy = en.planReview.approveProgress;
  const { email, seed, story } = await proposedPlan(page, 'approve-progress');
  let planId = '';

  await chapter('A three-item plan waits for approval on the planning overlay', async () => {
    await openFromCard(page, seed.storyKey);
    await askFromCard(page, 'Split the export work into a format, an exporter and a browser walk.');
    const session = await latestPlanningSession(email);
    ({ planId } = await finishSessionPlanWithEdge(session.id, story.id, [...THREE] as [
      string,
      string,
      string,
    ]));
    await page.reload();
    await expect(views(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(verb(bar(page), surface.approve)).toBeEnabled();
    await beat();
  });

  // The first press is held, then answered with the route's timeout refusal.
  const firstHold = await holdApprove(page, planId, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: timedOutBody(planId) }),
  );
  const firstAnswer = approveResponse(page, planId);
  const live = progressIn(bar(page));

  await chapter('Approve: the bar says how many items are being added', async () => {
    await verb(bar(page), surface.approve).click();

    // The bar's own element now carries the progress, and it is the live region.
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toContainText('Adding 3 items to your backlog…');
    await expect(live).toContainText(copy.together);
    // The rail mirrors it silently: one press is read once.
    await expect(progressIn(rail(page))).toHaveAttribute('aria-hidden', 'true');
    // No verb is left to press twice.
    await expect(verb(bar(page), surface.approve)).toHaveCount(0);
    await beat();
  });

  await chapter('Still going: it says so, and that there is no need to press again', async () => {
    // The component's own 8 s threshold — a real state, read off the element.
    await expect(live).toHaveAttribute('data-slow', 'true', { timeout: 15_000 });
    await expect(live).toContainText(copy.slow);
    await beat();

    firstHold.release();
    expect((await firstAnswer).status()).toBe(503);
    await firstHold.unroute();
  });

  await chapter('Timed out: nothing was written, and approving again is safe', async () => {
    const band = workspace(page).getByTestId('plan-approve-timed-out');
    await expect(band).toBeVisible();
    await expect(band).toHaveAttribute('role', 'alert');
    await expect(band).toContainText(copy.timedOutTitle);
    await expect(band).toContainText(copy.timedOutNext);
    // The authoritative read agrees: still awaiting a decision, nothing created.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).not.toBe(
      'approved',
    );
    const before = await adminDb.workItem.findMany({
      where: { parentId: story.id, archivedAt: null, title: { in: [...THREE] } },
      select: { id: true },
    });
    expect(before).toHaveLength(0);
    await expect(verb(bar(page), surface.approve)).toBeEnabled();
    await beat();
  });

  await chapter('Approve again — the three items land in the backlog', async () => {
    const hold = await holdApprove(page, planId, (route) => route.continue());
    const answered = approveResponse(page, planId);
    await verb(bar(page), surface.approve).click();
    await expect(progressIn(bar(page))).toContainText('Adding 3 items to your backlog…');
    // The band is gone the moment the retry is in flight.
    await expect(workspace(page).getByTestId('plan-approve-timed-out')).toHaveCount(0);
    await beat();

    hold.release();
    expect((await answered).status()).toBe(200);
    await hold.unroute();

    await expect
      .poll(async () => (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status, {
        timeout: 20_000,
      })
      .toBe('approved');
    const children = await adminDb.workItem.findMany({
      where: { parentId: story.id, archivedAt: null },
      select: { title: true },
    });
    for (const title of THREE) expect(children.map((c) => c.title)).toContain(title);
    await expect(progressIn(workspace(page))).toHaveCount(0);
    await beat();
  });
});

// ── UNRECORDED — the same surface in Chinese ─────────────────────────────────

test('the progress and the timeout read in Chinese', async ({ page }) => {
  const copy = zh.planReview.approveProgress;
  const zhSurface = zh.approvalGate.planApproval.surface;
  const { email, seed, story } = await proposedPlan(page, 'approve-progress-zh');

  await openFromCard(page, seed.storyKey);
  await askFromCard(page, 'Split this story.');
  const session = await latestPlanningSession(email);
  const { planId } = await finishSessionPlanWithEdge(session.id, story.id, [...THREE] as [
    string,
    string,
    string,
  ]);
  await page
    .context()
    .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
  await page.reload();
  // The workspace dialog's NAME is translated, so in Chinese it is found by role
  // alone — it is the one dialog on the page.
  const zhWorkspace = page.getByRole('dialog');
  const zhBar = zhWorkspace.getByTestId('plan-change-confirm-bar');
  await expect(zhWorkspace.getByTestId('plan-proposal-views')).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });

  const hold = await holdApprove(page, planId, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: timedOutBody(planId) }),
  );
  const answered = approveResponse(page, planId);
  await verb(zhBar, zhSurface.approve).click();
  const live = progressIn(zhBar);
  // zh's plural has one branch, so the rendered line is fixed text.
  await expect(live).toContainText('正在将 3 个工作项加入待办列表…');
  await expect(live).toContainText(copy.together);

  hold.release();
  expect((await answered).status()).toBe(503);
  await hold.unroute();

  const band = zhWorkspace.getByTestId('plan-approve-timed-out');
  await expect(band).toContainText(copy.timedOutTitle);
  await expect(band).toContainText(copy.timedOutNext);
});
