// Acceptance E2E — A PLANS ROW GOES WHERE ITS PLAN IS (Subtask MOTIR-6046,
// Story MOTIR-6043; design `design/ai-planning/design-notes.md` Part XXI; ADR
// `approval-gates.md` §11.5b).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One row, before and after a decision, taking a person to the two different
// places they actually want. On **Plans** an undecided plan's row SAYS it opens
// the conversation, and it does — the planning surface, at that plan's session,
// with the plan there to read and decide. Approve it in place; come back to the
// same row and it now says it opens the plan, and it lands on `/plans/<id>` in
// the app shell, showing what was approved.
//
// The unrecorded tests cover the rest of the card: a DECLINED plan's row behaves
// the same way; a plan with no session at all says there is no conversation and
// opens its page; and one undecided plan opened from **To approve** and from
// **Plans** resolves to the SAME address.
//
// ── THE SEAMS ───────────────────────────────────────────────────────────────
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + the motir-ai JOBS
// mock under the routes), the lane where the planning surface mounts at all. A
// plan is finished by the shipped services a real run's handler calls
// (`addProposals` → `markPlanned`, via `finishSessionPlan`), and `markPlanned` is
// what RAISES its gate — so every row below is a real row and every destination
// is computed by the shipped `planRowDestination`.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a row, a
// `waitForURL` or the decide route's own response. Nothing waits on a timeout.
// `beat()` and the chapter hold are PACING only — each taken AFTER the assertion
// that already proved the state, so removing every one of them leaves the
// assertions unchanged.
import { writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { finishSessionPlan, latestPlanningSession } from './_helpers/planChangeConversation';
import { plansService } from '@/lib/services/plansService';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

const surface = en.approvalGate.planApproval.surface;
const destination = en.planDestination;
const state = en.aiPlanning.sessions.planState;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });
const plansRow = (page: Page, text: string) =>
  sessionsList(page).getByRole('listitem').filter({ hasText: text });
/** THE AFFORDANCE under test — what the row says it will do, before it is clicked. */
const tag = (row: Locator) => row.getByTestId('plan-destination');

const approvalRows = (page: Page) =>
  page.getByRole('table', { name: en.workbench.tabs.toApprove }).getByTestId(/^approval-row-/);
const approvalRow = (page: Page, text: string) => approvalRows(page).filter({ hasText: text });
const reviewButton = (row: Locator) =>
  row.getByRole('button', { name: en.workbench.approvals.review, exact: true });

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── The motir-ai boundary ────────────────────────────────────────────────────

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

// ── Steps ────────────────────────────────────────────────────────────────────

/** Open *Plan with AI* from the card, and prove the surface MOUNTED first — a spec
 *  that asserts into an unmounted overlay passes by finding nothing. */
async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Ask from a CARD — the anchored door appends AND submits in one call; its 200 is
 *  the authoritative "the session holds this turn". */
async function askFromCard(page: Page, text: string): Promise<void> {
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

async function closeSurface(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

async function openPlans(page: Page): Promise<void> {
  await page.goto('/plans');
  await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** The row landed on the PLANNING SURFACE, at this plan's own session — and the one
 *  dialog on the page is the planning workspace, never an approval overlay. */
async function landedOnSurface(page: Page, sessionId: string): Promise<void> {
  await page.waitForURL((url) => url.searchParams.get('planSession') === sessionId);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByRole('dialog')).toHaveCount(1);
}

/** …and it has RENDERED the plan: the canvas bar is up and names what it proposes. */
async function planRendered(page: Page, added: number): Promise<void> {
  await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(bar(page)).toContainText(`${added} added`);
}

/** The row landed on the PLAN PAGE — proved by its own heading, not by the URL alone,
 *  so a route that resolved and rendered nothing cannot pass here. */
async function landedOnPlanPage(page: Page, planId: string): Promise<void> {
  await page.waitForURL(`**/plans/${planId}`);
  await expect(page.getByTestId('plan-status-pill').first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(workspace(page)).toHaveCount(0);
}

const decideResponse = (page: Page, planId: string, action: 'approve' | 'decline') =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/plans/${planId}/${action}` &&
      r.request().method() === 'POST',
  );

interface Ctx {
  userId: string;
  workspaceId: string;
}

/** Ask from a card and let the run finish: a `planned` plan on a real conversation,
 *  its gate raised and routed to the member who asked. */
async function seedAskedPlan(
  page: Page,
  email: string,
  cardKey: string,
  ask: string,
  proposal: string,
): Promise<{ planId: string; sessionId: string; ctx: Ctx }> {
  await openFromCard(page, cardKey);
  await askFromCard(page, ask);
  const session = await latestPlanningSession(email);
  await closeSurface(page);
  const planId = await finishSessionPlan(session.id, proposal);
  return {
    planId,
    sessionId: session.id,
    ctx: { userId: session.createdById, workspaceId: session.workspaceId },
  };
}

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORDED PATH — cases 1–3 of the card, paced for a person to watch.
// ─────────────────────────────────────────────────────────────────────────────

test('the same row opens the conversation while a plan waits, and the plan once it is decided', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6043');

  const email = `row-destination-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Split this story so the canvas seam can ship on its own.';
  const PROPOSAL = 'Ship the canvas seam first';
  let planId = '';
  let sessionId = '';

  await chapter('A plan is waiting, and its row says it opens the conversation', async () => {
    const asked = await seedAskedPlan(page, email, seed.storyKey, ASK, PROPOSAL);
    planId = asked.planId;
    sessionId = asked.sessionId;

    await openPlans(page);
    const row = plansRow(page, ASK);
    await expect(row).toBeVisible();
    await expect(row).toContainText(state.planned);
    // THE AFFORDANCE, before anything is clicked.
    await expect(tag(row)).toContainText(destination.conversation);
    await expect(tag(row)).toHaveAttribute('data-destination', 'planning-surface');
    // …and the chip is a second door to the plan. Since Story MOTIR-7883 (MOTIR-7889)
    // it opens the plan in the same overlay rather than its page, which an undecided
    // plan no longer has for a member.
    await expect(row.getByRole('link', { name: `Open the plan — ${state.planned}` })).toBeVisible();
    await beat();
  });

  await chapter('Opening it lands in the conversation, with the plan to decide', async () => {
    await plansRow(page, ASK).getByRole('link', { name: ASK }).click();
    await landedOnSurface(page, sessionId);
    await planRendered(page, 1);
    await expect(bar(page)).toContainText(surface.consequence);
    await expect(verb(bar(page), surface.approve)).toBeEnabled();
    await beat();
  });

  await chapter('Approve it here — in the conversation that could have changed it', async () => {
    const approved = decideResponse(page, planId, 'approve');
    await verb(bar(page), surface.approve).click();
    expect((await approved).status()).toBe(200);
    await beat();
  });

  await chapter('The same row now says it opens the plan — and it does', async () => {
    await openPlans(page);
    const row = plansRow(page, ASK);
    await expect(row).toContainText(state.approved);
    // The affordance SWITCHED, and the chip stopped being a second door to the
    // place the row itself now goes (design § 21.5).
    await expect(tag(row)).toContainText(destination.plan);
    await expect(tag(row)).toHaveAttribute('data-destination', 'plan-page');
    await expect(row.getByRole('link', { name: `Open the plan — ${state.approved}` })).toHaveCount(
      0,
    );
    await beat();

    await row.getByRole('link', { name: ASK }).click();
    await landedOnPlanPage(page, planId);
    await expect(page.getByTestId('plan-status-pill').first()).toContainText(/approved/i);
    await beat();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REST OF THE CARD — cases 4–7, unrecorded.
// ─────────────────────────────────────────────────────────────────────────────

test('a DECLINED plan behaves the same way: the row says the plan, and opens it', async ({
  page,
}) => {
  const email = `row-destination-declined-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Should we split the billing epic before the seam lands?';
  const asked = await seedAskedPlan(page, email, seed.storyKey, ASK, 'Split billing first');

  await openPlans(page);
  await plansRow(page, ASK).getByRole('link', { name: ASK }).click();
  await landedOnSurface(page, asked.sessionId);
  await planRendered(page, 1);

  // Decline through the surface's own confirm band — the one decide door.
  await verb(bar(page), surface.decline).click();
  const band = workspace(page).getByTestId('plan-decline-confirm').first();
  await expect(band).toContainText(en.approvalGate.planApproval.declineConfirm.title);
  const declined = decideResponse(page, asked.planId, 'decline');
  await verb(band, en.approvalGate.planApproval.declineConfirm.proceed).click();
  expect((await declined).status()).toBe(200);

  await openPlans(page);
  const row = plansRow(page, ASK);
  await expect(row).toContainText(state.declined);
  await expect(tag(row)).toContainText(destination.plan);
  await expect(row.getByRole('link', { name: `Open the plan — ${state.declined}` })).toHaveCount(0);

  await row.getByRole('link', { name: ASK }).click();
  await landedOnPlanPage(page, asked.planId);
});

// ⚠️ AMENDED 2026-10-08 by Story MOTIR-7883 (MOTIR-7885): this case said WHY a
// no-session plan opened its page. Every plan has a session now, so the null is an
// invariant breach, and it degrades SILENTLY — the story retires the explanation.
test('a plan with NO SESSION degrades silently to the plan page', async ({ page }) => {
  const email = `row-destination-none-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const asked = await seedAskedPlan(
    page,
    email,
    seed.storyKey,
    'Plan the canvas seam.',
    'Ship the seam',
  );

  const project = await adminDb.project.findFirstOrThrow({
    where: { identifier: seed.projectKey },
  });
  const loose = await plansService.createPlan(
    project.id,
    { title: 'Telemetry baseline' },
    asked.ctx,
  );
  await plansService.addProposals(
    loose.id,
    [{ op: 'add', proposedFields: { title: 'Record the first baseline', kind: 'task' } }],
    asked.ctx,
  );
  await plansService.markPlanned(loose.id, asked.ctx);
  // ⚠️ WRITTEN BY HAND, and it has to be. `Plan.sessionId` is *"NULLABLE AT THE
  // DATABASE only so a build predating this column can still write a plan during a
  // rollout"* (`prisma/schema.prisma`), and every author path sets it — so this state
  // has no shipped producer to drive. Clearing the column IS that rollout, simulated.
  // Everything downstream of it, including the destination, is the shipped rule's.
  await adminDb.plan.update({ where: { id: loose.id }, data: { sessionId: null } });

  await page.goto('/workbench?tab=approvals');
  const row = approvalRow(page, 'Telemetry baseline');
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(tag(row)).toContainText(destination.plan);
  // The retired copy, inlined because its key is gone.
  await expect(tag(row)).not.toContainText('no conversation');
  await expect(tag(row)).toHaveAttribute('data-destination', 'plan-page');

  await reviewButton(row).click();
  await landedOnPlanPage(page, loose.id);
  // …and nothing on the page says why it opened here.
  await expect(page.getByTestId('plan-no-conversation')).toHaveCount(0);

  // …and the row this plan is NOT: the asked plan still opens its conversation.
  await page.goto('/workbench?tab=approvals');
  await expect(tag(approvalRow(page, seed.storyKey))).toContainText(destination.conversation);
});

test('ONE undecided plan, TWO entrances — To approve and Plans resolve to the same address', async ({
  page,
}) => {
  const email = `row-destination-both-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Where should the destination rule live?';
  const asked = await seedAskedPlan(page, email, seed.storyKey, ASK, 'Put it beside the launcher');

  // From TO APPROVE.
  await page.goto('/workbench?tab=approvals');
  const approval = approvalRow(page, seed.storyKey);
  await expect(approval).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(tag(approval)).toContainText(destination.conversation);
  await reviewButton(approval).click();
  await landedOnSurface(page, asked.sessionId);
  const fromApprovals = new URL(page.url());

  // From PLANS.
  await openPlans(page);
  const row = plansRow(page, ASK);
  await expect(tag(row)).toContainText(destination.conversation);
  await row.getByRole('link', { name: ASK }).click();
  await landedOnSurface(page, asked.sessionId);
  const fromPlans = new URL(page.url());

  // ⚠️ THE ASSERTION THIS CASE EXISTS FOR — not that both work, but that they
  // AGREE. The two hosts differ by construction (the overlay opens over the page
  // the row sat on), so what is compared is the overlay's own parameters, and
  // `planVia` is the one the To-approve row alone records.
  const overlayOf = (url: URL) => {
    const out: Record<string, string> = {};
    for (const [k, v] of url.searchParams) if (k.startsWith('plan')) out[k] = v;
    return out;
  };
  const approvals = overlayOf(fromApprovals);
  const plans = overlayOf(fromPlans);
  expect(approvals['planVia']).toBe('approvals');
  expect(plans['planVia']).toBeUndefined();
  delete approvals['planVia'];
  expect(approvals).toEqual(plans);
  expect(plans['planSession']).toBe(asked.sessionId);
});
