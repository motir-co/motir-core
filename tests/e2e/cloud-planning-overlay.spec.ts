// The planning workspace is an OVERLAY (Subtask MOTIR-4734, Story MOTIR-4725) —
// PROMOTED out of the acceptance lane into the cloud-on regression lane
// (MOTIR-6012; `docs/acceptance-lane-triage.md` § MOTIR-6012).
//
// ⚠️ THIS WAS A RECEIPT. It recorded MOTIR-4725's clip in the acceptance lane;
// that story is `done`, so the spec left the lane by the lifecycle rule
// (`docs/decisions/acceptance-receipt-lifecycle.md` §3) rather than being edited
// in place. It went RED on Story MOTIR-6012's branch because MOTIR-6037 made the
// close-with-pending guard stay SHUT for an asked (gated) or generating plan
// (ADR `approval-gates.md` §11; `design/ai-planning/design-notes.md` Part XXII
// §22.11): once every `planned` plan waits in To approve, closing discards
// nothing, so the guard's *"Closing now discards them"* was false. The one
// chapter that read the guard is restated below as that rule — Esc closes
// straight through and the plan still waits in To approve. Every other
// assertion is unchanged. The guard's own arms (asked · written · unasked) are
// pinned in `tests/components/plan-approval-surface.test.tsx`; closing during
// generation in `tests/e2e/cloud-plan-approval-gate.spec.ts` (promoted from the
// acceptance lane by Story MOTIR-7460).
//
// Runs under playwright.cloud.config.ts (MOTIR_CLOUD + MOTIR_AI_URL), NOT the
// main lane: the overlay mounts only where `isMotirAiConfigured()` is true — in
// the main lane every assertion below would pass vacuously by finding nothing,
// the MOTIR-2601 trap. `chapter()` / `beat()` / `acceptanceStory()` come from the
// promoted shim, where they are a `test.step` and two no-ops.
//
// What only a browser walking real pages can prove — *open the planner, close
// it, and be looking at exactly what you were looking at* — is that the backlog
// UNDERNEATH kept its filter, its scroll position and the text somebody left in
// a box.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E waits on the authoritative signal):
// every wait is a role / text landmark, a `waitForURL`, or a response to a
// request the page actually issued. No `waitForTimeout`. Only the two motir-ai
// hops are stubbed — the SUBMIT and the job's SSE, the same open-core seam
// `cloud-plan-change-conversation.spec.ts` uses, and the only interceptable one
// (a server-side fetch out of a route handler is NOT reachable from
// `page.route`). Sessions, the conversation thread, the plan rows, the approve
// and the anchor read all run REAL against Postgres.
//
// Chapter 1 still asserts the pill is MOUNTED before it asserts anything the
// pill opens — the lane check, kept.

import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { persistAskTurn } from './_helpers/plan-session-turn';
import {
  seedAiAugmentReplan,
  seedPlanChangeProposal,
  markProjectOnboarded,
  PLAN_CHANGE_JOB_ID,
} from './_helpers/ai-augment-replan-seed';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { jobStreamBody } from './_helpers/job-stream-frames';

test.describe.configure({ timeout: 180_000 });

// ── Locators ─────────────────────────────────────────────────────────────────

/** The workspace's own dialog — the shipped `Modal`, so a real `role=dialog`. */
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
// ⚠️ SCOPED TO THE DIALOG. An overlay leaves the host page MOUNTED underneath,
// so over a page that draws its own canvas (`/roadmap`) an unscoped testid
// resolves twice and Playwright's strict mode refuses it — the locator hazard
// `motir-core/CLAUDE.md` records for a route-group boundary, in the shape an
// overlay gives it. `/backlog` has no canvas, so this file would pass either
// way; it is scoped so that pointing a chapter at another host page later is not
// a trap. (`planning-anchor-level.spec.ts` is where it actually bit.)
const canvas = (page: Page) => workspace(page).getByTestId('roadmap-canvas');
const composer = (page: Page) => page.getByRole('textbox', { name: /Reply, or refine/ });
/** The exit chrome. A BUTTON labelled `Close` since MOTIR-4729 — an overlay has
 *  no destination to name, which is what `Back to …` was doing. */
const closeControl = (page: Page) => workspace(page).getByRole('button', { name: /^Close/ });
const guard = (page: Page) => page.getByRole('alertdialog');
/** The header hero pill. Its accessible name is EXACTLY "Plan with AI" — the
 *  callout ROW's is the superstring, which is the selector hazard
 *  `cloud-ai-callout.spec.ts` documents. */
const heroPill = (page: Page) => page.getByRole('link', { name: 'Plan with AI', exact: true });
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI' });
/** The backlog's own create-issue box — a CLIENT ISLAND holding unsaved text. */
const composerRow = (page: Page) => page.getByTestId('create-issue-input');

/** Is the overlay in the address? The presence of `plan` is the mount predicate. */
const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── The two motir-ai hops, stubbed at the browser boundary ───────────────────

const AI_ACCESS_NA = {
  applicable: false,
  organizationId: null,
  organizationName: null,
  canManageBilling: false,
  hasPaidAiPlan: false,
  balance: 0,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
};

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_ACCESS_NA),
    });
  });
}

/**
 * Stub the ASK door — the one hop a turn takes to motir-ai. The `session` it
 * hands back is the REAL one, re-read through the idempotent open/resume
 * endpoint, so the thread the rail renders is genuinely persisted rows rather
 * than a stub echo (the seam `cloud-plan-change-conversation.spec.ts` documents).
 */
async function stubAskSubmit(page: Page, jobId: string, planId: string): Promise<void> {
  await page.route('**/api/ai/ask', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    // Through the real session doors — the held session, or a first turn that
    // starts one (MOTIR-6023).
    const appended = await persistAskTurn(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: 'redirected',
        jobId,
        planId,
        session: await appended.json(),
      }),
    });
  });
}

async function stubStream(page: Page, jobId: string): Promise<void> {
  await page.route(`**/api/ai/augment/${jobId}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      // motir-ai's wire: each progress frame in its `{ jobId, seq, data }` envelope.
      body: jobStreamBody(jobId, [
        ['search', {}],
        ['planned', { proposed: 1 }],
        ['done', {}],
      ]),
    });
  });
}

/** Send a turn and wait on the DOOR's 200 — the authoritative "the thread
 *  advanced" signal, since the turn is a row that call writes. */
async function sendTurn(page: Page, text: string): Promise<void> {
  const appended = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await appended).status()).toBe(200);
}

/** The backlog's OWN scroll container. ⚠️ IT IS NOT THE WINDOW: the shell is a
 *  fixed-height column and `BacklogRows` renders `overflow-y-auto max-h-[60vh]`
 *  on a `role="list"`, so `window.scrollTo(0, 400)` moves nothing and
 *  `window.scrollY` is 0 however far down the list the reader is. Measured — the
 *  first draft of this spec asserted on the window and failed at 0. */
const backlogViewport = (page: Page) => page.getByRole('list', { name: 'Backlog work items' });
/** The scroll position — the thing a route change destroys and an overlay must
 *  not. */
const scrollTop = (page: Page) =>
  backlogViewport(page).evaluate((el: HTMLElement) => Math.round(el.scrollTop));

/**
 * Fill the backlog past its own fold.
 *
 * ⚠️ WITHOUT THIS THE SCROLL ASSERTION PASSES FOR THE WRONG REASON — or rather
 * fails for the right one. `seedAiAugmentReplan` makes nine work items, three of
 * them stories, and chapter 1 then filters to stories: a three-row list inside a
 * `max-h-[60vh]` box has nothing to scroll, so "the scroll survived" would be a
 * statement about a number that was never anything but zero. The rows go in
 * through the `_test` transport, which is the service layer over HTTP and shares
 * the signed-in page's cookies.
 */
async function fillBacklog(page: Page, projectId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const res = await page.request.post('/api/_test/work-items', {
      data: { projectId, kind: 'story', title: `Backlog row ${String(i).padStart(2, '0')}` },
    });
    expect(res.status(), 'the _test transport must be reachable in this lane').toBe(201);
  }
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('the planner opens over your work, and closing puts you back exactly there', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4725');

  const seed = await seedAiAugmentReplan(`planning-overlay-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const planId = await seedPlanChangeProposal(seed.ctx, seed.projectId, {
    jobId: PLAN_CHANGE_JOB_ID,
    title: 'Add billing',
    adds: ['Billing'],
  });

  await stubAiAccess(page);
  await stubAskSubmit(page, PLAN_CHANGE_JOB_ID, planId);
  await stubStream(page, PLAN_CHANGE_JOB_ID);

  await signIn(page, seed.email, seed.password);
  await fillBacklog(page, seed.projectId, 40);

  let workAddress = '';
  let openAddress = '';
  // Hoisted out of chapter 1 because chapter 2 is what it is FOR: the number the
  // overlay must leave untouched.
  let scrolledTo = 0;

  await chapter('Open the planner over the work you were doing', async () => {
    await page.goto('/backlog');
    await expect(page.getByTestId('backlog-count')).toBeVisible({ timeout: FIRST_PAINT_MS });

    // ⚠️ THE LANE CHECK, FIRST. The pill mounts only where AI planning is
    // configured; in a lane that does not set it, every assertion below would
    // pass by finding nothing.
    await expect(heroPill(page)).toBeVisible();

    // A filter, carried in the URL — the state a route change throws away.
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Filter work items' });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('listbox', { name: 'Kind' })
      .getByRole('option', { name: 'Story' })
      .click();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/kind=story/);

    // …and TEXT SOMEBODY TYPED. `CreateIssueRow` is a client island: `editing`
    // and the title both live in `useState`, in a component the server never
    // re-seeds. Nothing persists them anywhere — so if the page is remounted
    // they are gone, and that is exactly what a route change used to do.
    await page.getByTestId('create-issue-backlog').click();
    await composerRow(page).fill('A row I was in the middle of typing');
    await expect(composerRow(page)).toHaveValue('A row I was in the middle of typing');

    // …and a scroll position well below the fold. Set AFTER the typing, because
    // `click()` and `fill()` scroll their target into view.
    await expect(backlogViewport(page)).toBeVisible();
    await backlogViewport(page).evaluate((el: HTMLElement) => {
      el.scrollTop = 400;
    });
    scrolledTo = await scrollTop(page);
    expect(scrolledTo, 'the list must actually be scrolled').toBeGreaterThan(0);
    workAddress = page.url();

    await heroPill(page).click();
    await page.waitForURL(overlayOpen);
    openAddress = page.url();

    // The workspace COVERS the viewport — and it is the shipped dialog, so focus
    // is trapped and Escape is Radix's.
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(canvas(page)).toBeVisible();
    await expect(rail(page)).toBeVisible();

    // The address gained the overlay's parameters and kept the backlog's own.
    const url = new URL(page.url());
    expect(url.pathname).toBe('/backlog');
    expect(url.searchParams.get('plan')).toBeTruthy();
    expect(url.searchParams.get('planFrom')).toBe('project');
    expect(url.toString()).toContain('kind=story');
    await beat();
  });

  await chapter('Press Esc — and be exactly where you were', async () => {
    // The Close control is there, labelled without a destination — an overlay
    // returns you to where you already are, so naming a page would be a lie.
    await expect(closeControl(page)).toBeVisible();
    await expect(closeControl(page)).not.toContainText('Back to');

    await page.keyboard.press('Escape');
    await page.waitForURL(overlayClosed);

    await expect(workspace(page)).toHaveCount(0);
    // The address is the one we left, character for character.
    expect(page.url()).toBe(workAddress);
    // The FILTER is still applied — not merely in the URL, but on the page.
    await expect(page.getByTestId('backlog-count')).toBeVisible();
    // …and the SCROLL survived, which no unit can see: the list was never
    // unmounted, so the browser had nothing to restore.
    expect(await scrollTop(page), 'the list must not have jumped').toBe(scrolledTo);
    // …and so did the half-typed row. THE STRONGEST OF THE THREE: a filter can
    // be recovered from the URL and a scroll position can be restored by the
    // browser, but nothing anywhere is keeping this string except the component
    // that has never stopped being mounted.
    await expect(composerRow(page)).toHaveValue('A row I was in the middle of typing');
    await beat();
  });

  await chapter('Open from the orb; close with the browser Back button', async () => {
    await orb(page).click();
    const planRow = page.getByRole('dialog', { name: 'Motir AI' }).getByRole('link', {
      name: /Plan with AI/,
    });
    await expect(planRow).toBeVisible();
    await planRow.click();
    await page.waitForURL(overlayOpen);
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

    await page.goBack();
    await page.waitForURL(overlayClosed);
    await expect(workspace(page)).toHaveCount(0);
    await expect(page.getByTestId('backlog-count')).toBeVisible();

    // Forward opens it again — the address IS the open state, so history works
    // on it the way history works on anything.
    await page.goForward();
    await page.waitForURL(overlayOpen);
    await expect(workspace(page)).toBeVisible();
    await beat();
  });

  await chapter('Closing with an asked plan loses nothing, so nothing asks', async () => {
    await sendTurn(page, 'Add a billing epic.');
    // The proposal is on the canvas, and it is already a QUESTION: MOTIR-6036
    // raised its `plan_approval` gate when the plan reached `planned`.
    await expect(page.getByTestId('plan-change-confirm-bar')).toBeVisible();

    // ⚠️ RESTATED BY MOTIR-6037 (ADR `approval-gates.md` §11; design Part XXII
    // §22.11). The receipt asserted the close-with-pending guard here —
    // *"Nothing is saved until you confirm. Closing now discards them."* — and
    // walked its Keep planning / Discard. An asked plan waits in To approve, so
    // closing discards nothing and the guard stays shut: Esc closes straight
    // through.
    await page.keyboard.press('Escape');
    await page.waitForURL(overlayClosed);
    await expect(workspace(page)).toHaveCount(0);
    await expect(guard(page)).toHaveCount(0);
    // …the backlog underneath gained nothing — nobody approved anything…
    await expect(page.getByText('Billing', { exact: true })).toHaveCount(0);
    // …and the plan was NOT discarded: it is still `planned`, its question still
    // awaiting in To approve.
    const plan = await adminDb.plan.findUnique({ where: { id: planId }, select: { status: true } });
    expect(plan?.status).toBe('planned');
    expect(
      await adminDb.approvalGate.count({
        where: { kind: 'plan_approval', subjectId: planId, state: 'awaiting' },
      }),
    ).toBe(1);
    await beat();
  });

  await chapter('A pasted link opens the workspace over the page it belongs to', async () => {
    // COLD: a fresh load of the address a reader would copy.
    await page.goto(openAddress);
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    // The HOST page rendered behind it — the overlay is a layer, not a
    // destination, even on a cold load.
    await expect(page.getByTestId('backlog-count')).toBeAttached();
    expect(new URL(page.url()).pathname).toBe('/backlog');
    await beat();
  });

  await chapter('An OLD /planning link still lands in the workspace', async () => {
    // The forward. A bookmark from before the migration must not 404.
    await page.goto('/planning?mode=project&from=project');
    await page.waitForURL(overlayOpen);
    expect(new URL(page.url()).pathname).not.toBe('/planning');
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await beat();
  });
});

test('a signed-out visitor keeps the WHOLE address across sign-in', async ({ page }) => {
  const seed = await seedAiAugmentReplan(`planning-overlay-out-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  const deepLink = '/backlog?kind=story&plan=project&planFrom=project';
  await page.goto(deepLink);

  // `next=` carries the host path AND the overlay query — preserving only the
  // pathname would land the reader on a backlog with the workspace lost.
  await page.waitForURL((url) => url.pathname === '/sign-in');
  const next = new URL(page.url()).searchParams.get('next') ?? '';
  expect(next).toContain('/backlog');
  expect(next).toContain('plan=project');
  expect(next).toContain('kind=story');

  // ⚠️ `signIn` settles on home rather than following `next=` — it is the shared
  // helper and every other spec depends on that. So what is asserted here is the
  // half this story owns: the WHOLE address survives the bounce, host query and
  // overlay query together. Following it is then an ordinary load, and the cold
  // deep link is covered by the recorded walk's own chapter.
  await stubAiAccess(page);
  await signIn(page, seed.email, seed.password);
  await page.goto(next);
  await page.waitForURL((url) => url.pathname === '/backlog' && url.searchParams.has('plan'));
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  // …and the host page's own filter came through the whole round trip.
  expect(new URL(page.url()).searchParams.get('kind')).toBe('story');
});

test('a work-item launch opens scoped to that item, over its own page', async ({ page }) => {
  const seed = await seedPlanningAnchorTree(`planning-overlay-anchor-${Date.now()}@example.com`);
  await stubAiAccess(page);
  await signIn(page, seed.email, PLANNING_ANCHOR_PASSWORD);

  // From the ITEM PAGE.
  await page.goto(`/items/${seed.subtaskKey}`);
  const entrance = page.getByTestId('work-item-plan-entrance');
  await expect(entrance).toBeVisible({ timeout: FIRST_PAINT_MS });

  // A real link, so it carries the full address — ⌘-click and *Open in new tab*
  // still work, and both now produce the cold deep link.
  const href = await entrance.getAttribute('href');
  expect(href).toContain(`/items/${seed.subtaskKey}`);
  expect(href).toContain(`planItem=${seed.subtaskKey}`);

  await entrance.click();
  await page.waitForURL((url) => url.searchParams.get('planItem') === seed.subtaskKey);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  // …and it is still the ITEM's page underneath.
  expect(new URL(page.url()).pathname).toBe(`/items/${seed.subtaskKey}`);

  // The TARGET CHIP is pre-filled with the item the launch named — the composer
  // is already scoped, so the first thing typed is about this card and not about
  // the project.
  await expect(
    page.getByTestId('planning-target-chip').filter({ hasText: seed.subtaskKey }),
  ).toBeVisible();

  // The canvas opened on the anchor's OWN level: the anchor is ringed and its
  // SIBLING is on screen, which is only true of the level that contains it.
  // ⚠️ That is the LEAF arrival, and it is what this anchor is — a `subtask` has
  // no inside. A CONTAINER anchor opens INSIDE itself instead (MOTIR-6160); the
  // two arrivals are ruled on side by side in `planning-anchor-level.spec.ts`.
  const target = page.getByTestId('planning-target-node');
  await expect(target).toBeVisible();
  await expect(target).toContainText(seed.subtaskTitle);
  await expect(
    workspace(page).getByTestId('planning-canvas').locator('[data-node-id]').filter({
      hasText: seed.siblingTitle,
    }),
  ).toBeVisible();

  // Close → the item page, unchanged.
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(`/items/${seed.subtaskKey}`);

  // From the QUICK VIEW — the dialog-over-dialog case. The design decided it:
  // the workspace opens ABOVE the peek and `?peek=` STAYS, so closing the
  // workspace returns the reader to the peek they launched from.
  await page.goto(`/items?peek=${seed.subtaskKey}`);
  const peekEntrance = page.getByTestId('work-item-plan-entrance');
  await expect(peekEntrance).toBeVisible({ timeout: FIRST_PAINT_MS });
  await peekEntrance.click();
  await page.waitForURL((url) => url.searchParams.has('plan'));

  const withBoth = new URL(page.url());
  expect(withBoth.searchParams.get('peek')).toBe(seed.subtaskKey);
  expect(withBoth.searchParams.get('planItem')).toBe(seed.subtaskKey);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  // The peek is still open — that is the whole decision.
  expect(new URL(page.url()).searchParams.get('peek')).toBe(seed.subtaskKey);
});

/**
 * MOTIR-2491's measurement, for the site this story adds.
 *
 * `tests/theme/modalScrollContainer.test.ts` refuses a bare `<Modal>` whose
 * height is decided in another file — and the overlay's is, three times over
 * (`NoAccessState`, `PlanningWorkspaceSkeleton`, `PlanningWorkspaceHost`). The
 * exemption it accepts records a MEASUREMENT, explicitly not an opinion: "I read
 * the JSX and it looks short" is the reasoning that shipped all three prior
 * instances. So this is the measurement, taken in the ONLY lane where the
 * overlay mounts at all — `tests/e2e/modal-scroll-container.spec.ts` runs under
 * the main config, which is not cloud-on, and would find nothing here.
 *
 * Not a chapter and not part of the receipt: it changes the viewport, which is
 * the one thing a recorded walk must not do mid-clip.
 */
test('the full-size panel IS the viewport, and nothing is clipped outside it (MOTIR-2491)', async ({
  page,
}) => {
  const seed = await seedAiAugmentReplan(`planning-overlay-short-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  await stubAiAccess(page);
  await signIn(page, seed.email, seed.password);

  // Shorter than the 720 default and than any laptop the suite has run on — the
  // sweep's own recipe (MOTIR-2488).
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/backlog?plan=project&planFrom=project');
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(canvas(page)).toBeVisible();
  await expect(rail(page)).toBeVisible();

  // The panel is the viewport, not 90% of it — `size="full"` is `h-dvh`.
  const panel = await workspace(page).boundingBox();
  expect(panel).not.toBeNull();
  expect(Math.round(panel!.height)).toBe(700);
  expect(Math.round(panel!.y)).toBe(0);

  // Nothing grew past it. A clipped child still answers every role query, which
  // is why this asserts the BOX rather than visibility: the dialog's own content
  // fits inside its own scroll height, and the document behind it never gained a
  // scrollbar of its own.
  const overflow = await workspace(page).evaluate((el: HTMLElement) => ({
    dialog: el.scrollHeight - el.clientHeight,
    document: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow.dialog).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);

  // …and the control that closes it is WHOLLY on screen. `ratio: 1`, because a
  // button cut three-quarters of the way through still intersects the viewport.
  await expect(closeControl(page)).toBeInViewport({ ratio: 1 });
});
