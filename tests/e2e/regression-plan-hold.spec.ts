// Acceptance E2E — while a plan is open, its work items CANNOT LEAVE PLANNING BY
// HAND (Story MOTIR-6017 · Subtask MOTIR-6270; `docs/decisions/agent-authored-plans.md`
// AMENDMENT 21). The story's acceptance RECEIPT.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A To Do card is re-planned, and the plan parks it in Planning. Before this story
// a person could simply drag it out and build the old shape while the new one
// waited. Now the drag SPRINGS BACK and the card itself says a plan is open, with
// a Review plan door. The card's page says the same on its status control, every
// option is locked, and the door opens the PLANNING SURFACE over the page — never
// the approval overlay. Approving the plan there rests the card at To Do, and from
// then on it moves like any other card.
//
// The unrecorded tests cover the rest of the card: Decline returns a card to the
// status it was parked from; a `generating` plan holds too and says it is still
// being written; a card parked only by a planning CONVERSATION (no plan yet) still
// moves by hand; the `/items` row refuses in place; and the same walk in `zh`.
//
// ── THE SEAMS ───────────────────────────────────────────────────────────────
//
// The plan and the park are seeded through the SHIPPED services —
// `plansService.createPlan` → `addProposals` (a `modify` of the card, which is what
// PARKS it: `planTargetLockService.acquireForPlanWithin`, AMENDMENT 16 D1) →
// `markPlanned` — the sanctioned cross-layer reach `agent-authored-plan-seed.ts`
// and `contextual-plan-seed.ts` use. Nothing stubs the park, the plan or a status
// call; no model is called. (The session-only case, "a card parked only by a
// planning conversation still moves by hand", was retired by MOTIR-7630: an open
// session now holds its card — AMENDMENT 23 §5; see docs/acceptance-lane-triage.md.)
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is the board move's
// response (status AND body), the decide route's response, a URL parameter, a
// role / text the write's own response rendered, or a committed read of the
// database. `beat()` and the chapter hold are PACING only, each taken after the
// assertion that proved the state.
import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { boardViewportWidth, columnByStatus, getBoard, pointerDragForMove } from './_helpers/board';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 240_000 });

const PASSWORD = 'plan-hold-e2e-pass-7';
const held = en.approvalGate.statusHeld;
const surface = en.approvalGate.planApproval.surface;

// ── Seed ─────────────────────────────────────────────────────────────────────

interface Tenant {
  email: string;
  ctx: ServiceContext;
  projectId: string;
  projectKey: string;
}

async function seedTenant(email: string): Promise<Tenant> {
  const owner = await usersService.createUser({ email, password: PASSWORD, name: 'Hana Plan' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Plan Hold E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Checkout',
    identifier: 'HOLD',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // `/boards` and `/items` are active-project scoped; the onboarding marker keeps
  // the planning surface from forwarding to `/onboarding`.
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });
  return {
    email,
    ctx: { userId: owner.id, workspaceId: workspace.id },
    projectId: project.id,
    projectKey: project.identifier,
  };
}

interface Card {
  id: string;
  key: string;
}

async function seedCard(t: Tenant, title: string, status?: string): Promise<Card> {
  const item = await workItemsService.createWorkItem(
    { projectId: t.projectId, kind: 'task', title },
    t.ctx,
  );
  if (status) await workItemsService.updateStatus(item.id, status, t.ctx);
  return { id: item.id, key: item.identifier };
}

/**
 * RE-PLAN a card: a plan anchored at it whose one proposal MODIFIES it. The append
 * is what parks the card at Planning (AMENDMENT 16 D1); `markPlanned` finishes the
 * plan and raises its gate. `finish: false` leaves it `generating` — still being
 * written, and holding all the same.
 */
async function replan(
  t: Tenant,
  card: Card,
  newTitle: string,
  opts: { finish?: boolean } = {},
): Promise<{ planId: string; sessionId: string }> {
  const plan = await plansService.createPlan(
    t.projectId,
    {
      title: `Re-plan ${card.key}`,
      summary: `Re-plan ${card.key}`,
      createdById: t.ctx.userId,
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      session: { origin: 'mcp', targetKeys: [card.key] },
    },
    t.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: card.id, patch: { title: newTitle } }],
    t.ctx,
  );
  if (opts.finish !== false) await plansService.markPlanned(plan.id, t.ctx);
  return { planId: plan.id, sessionId: plan.sessionId! };
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

const planStatus = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId }, select: { status: true } }))
    .status;

// ── Locators ─────────────────────────────────────────────────────────────────

const columns = (page: Page) => page.getByRole('group', { name: en.boards.boardLabel });
const boardCard = (page: Page, key: string) => columns(page).getByTestId(`board-card-${key}`);
/** The held item's SHELL — the card body plus its plan footer, one bordered item. */
const shell = (page: Page, key: string) => boardCard(page, key).locator('xpath=..');
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

/** The item page's Status field card — the rail card whose edit chevron is
 *  "Edit Status" and which holds the held notice (the gate-guard spec's locator). */
function statusCard(page: Page): Locator {
  return page
    .getByRole('main')
    .locator('div')
    .filter({
      has: page.getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true }),
    })
    .filter({ has: page.getByRole('status') })
    .last();
}

/** The planning overlay's address — and NEVER the approval overlay's (§11.5b). */
const onPlanningSurface = (sessionId: string) => (url: URL) =>
  url.searchParams.has('plan') &&
  url.searchParams.get('planSession') === sessionId &&
  !url.searchParams.has('approval');
const surfaceClosed = (url: URL) => !url.searchParams.has('plan');

const decideResponse = (page: Page, planId: string, action: 'approve' | 'decline') =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/plans/${planId}/${action}` &&
      r.request().method() === 'POST',
  );

// ── Steps ────────────────────────────────────────────────────────────────────

async function openBoard(page: Page): Promise<void> {
  await page.goto('/boards');
  await expect(columns(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** Drag a card to a status's column; returns the committed move response. */
async function dragTo(page: Page, key: string, statusKey: string) {
  const board = await getBoard(page.request);
  const target = columnByStatus(board, statusKey);
  return pointerDragForMove(
    page,
    boardCard(page, key),
    columns(page).getByTestId(`board-column-${target.id}`),
  );
}

async function inColumn(page: Page, key: string, statusKey: string): Promise<void> {
  const board = await getBoard(page.request);
  await expect(
    columns(page)
      .getByTestId(`board-column-${columnByStatus(board, statusKey).id}`)
      .getByTestId(`board-card-${key}`),
  ).toBeVisible();
}

/** The drag is REFUSED with the plan hold — asserted on the committed response. */
async function expectPlanHeldMove(move: Awaited<ReturnType<typeof dragTo>>): Promise<void> {
  expect(move.status()).toBe(409);
  expect(((await move.json()) as { code: string }).code).toBe('PLAN_TARGET_HELD');
}

/** Press the status control's Review plan door and land on the planning surface. */
async function openDoor(page: Page, sessionId: string, doorName: string): Promise<void> {
  // The status control's notice, found by its line: once the status editor has
  // been opened the field card shows the picker instead of its "Edit Status"
  // chevron, and the page's plan banner carries a Review plan of its own.
  await page
    .getByRole('main')
    .getByRole('status')
    .filter({ hasText: held.planHeld })
    .getByRole('link', { name: doorName })
    .click();
  await page.waitForURL(onPlanningSurface(sessionId));
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  // The one dialog is the planning workspace — the approval overlay never opened.
  await expect(page.getByRole('dialog')).toHaveCount(1);
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a re-planned card springs back from a drag, its status control opens the plan, and approving frees it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6017');

  const t = await seedTenant(`plan-hold-${Date.now()}@example.com`);
  const card = await seedCard(t, 'Card checkout for returning buyers');
  const REPLANNED = 'Card checkout for returning buyers, saved cards first';
  const plan = await replan(t, card, REPLANNED);
  expect(await statusOf(card.id)).toBe('planning');

  await page.setViewportSize(boardViewportWidth());
  await signIn(page, t.email, PASSWORD);

  await chapter('The re-planned To Do card is parked in Planning, under its plan', async () => {
    await openBoard(page);
    await inColumn(page, card.key, 'planning');
    await expect(shell(page, card.key)).toContainText(
      en.boards.planHold.marker.replace('{name}', card.key),
    );
    await expect(shell(page, card.key)).toContainText(held.reviewPlan);
  });

  await chapter('Dragging it to In Progress springs it back — the card says why', async () => {
    const move = await dragTo(page, card.key, 'in_progress');
    await expectPlanHeldMove(move);
    await inColumn(page, card.key, 'planning');
    // The refusal opens INSIDE the item's plan footer — a status line, not a toast.
    const refusal = shell(page, card.key).getByRole('status');
    await expect(refusal).toContainText(held.planHeld);
    await expect(refusal).toContainText(held.planState.planned);
    await expect(refusal.getByRole('link', { name: held.reviewPlan })).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: en.boards.moveRejectedTitle }),
    ).toHaveCount(0);
    expect(await statusOf(card.id)).toBe('planning');
    await beat();
  });

  await chapter('Its page says the same, and every status option is locked', async () => {
    await page.keyboard.press('Escape');
    await page.goto(`/items/${card.key}`);
    const notice = statusCard(page).getByRole('status');
    await expect(notice).toContainText(held.planHeld, { timeout: FIRST_PAINT_MS });
    await expect(notice.getByRole('link', { name: held.reviewPlan })).toBeVisible();

    await page
      .getByRole('main')
      .getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true })
      .click();
    await page
      .getByRole('main')
      .getByRole('combobox', { name: en.issueViews.status, exact: true })
      .click();
    for (const name of ['To Do', 'In Progress', 'Blocked', 'Cancelled']) {
      const option = page.getByRole('option', { name: new RegExp(`^${name}`) });
      await expect(option).toHaveAttribute('aria-disabled', 'true');
      await expect(option).toContainText(held.planHeldOption);
    }
    await beat();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  await chapter('Review plan opens the planning surface over the page; Close returns', async () => {
    await openDoor(page, plan.sessionId, held.reviewPlan);
    await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(bar(page)).toContainText('1 changed');
    await expect(verb(bar(page), surface.approve)).toBeEnabled();
    await beat();
    await page.keyboard.press('Escape');
    await page.waitForURL(surfaceClosed);
    await expect(workspace(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`/items/${card.key}`);
  });

  await chapter('Approve the plan — the card rests at To Do and moves freely', async () => {
    await openDoor(page, plan.sessionId, held.reviewPlan);
    await expect(verb(bar(page), surface.approve)).toBeEnabled({ timeout: FIRST_PAINT_MS });
    const approved = decideResponse(page, plan.planId, 'approve');
    await verb(bar(page), surface.approve).click();
    expect((await approved).status()).toBe(200);
    expect(await planStatus(plan.planId)).toBe('approved');
    await expect
      .poll(() => statusOf(card.id), { timeout: 30_000, message: 'approve rests the card' })
      .toBe('todo');
    await beat();

    await openBoard(page);
    await inColumn(page, card.key, 'todo');
    await expect(shell(page, card.key).getByText(held.reviewPlan)).toHaveCount(0);
    const move = await dragTo(page, card.key, 'in_progress');
    expect(move.status()).toBe(200);
    await expect
      .poll(() => statusOf(card.id), { timeout: 30_000, message: 'the drag commits' })
      .toBe('in_progress');
    await inColumn(page, card.key, 'in_progress');
  });
});

test('declining a plan returns the card to the status it was parked from', async ({ page }) => {
  const t = await seedTenant(`plan-hold-decline-${Date.now()}@example.com`);
  const card = await seedCard(t, 'Refund to the original card', 'in_progress');
  const plan = await replan(t, card, 'Refund to the original card, partial refunds too');
  expect(await statusOf(card.id)).toBe('planning');

  await signIn(page, t.email, PASSWORD);
  await page.goto(`/items/${card.key}`);
  await expect(statusCard(page).getByRole('status')).toContainText(held.planHeld, {
    timeout: FIRST_PAINT_MS,
  });
  await openDoor(page, plan.sessionId, held.reviewPlan);
  await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

  await verb(bar(page), surface.decline).click();
  const band = workspace(page).getByTestId('plan-decline-confirm').first();
  await expect(band).toContainText(en.approvalGate.planApproval.declineConfirm.title);
  const declined = decideResponse(page, plan.planId, 'decline');
  await verb(band, en.approvalGate.planApproval.declineConfirm.proceed).click();
  expect((await declined).status()).toBe(200);
  expect(await planStatus(plan.planId)).toBe('declined');
  await expect
    .poll(() => statusOf(card.id), { timeout: 30_000, message: 'decline restores the status' })
    .toBe('in_progress');
});

test('a plan still being written holds the card too, and says so', async ({ page }) => {
  const t = await seedTenant(`plan-hold-generating-${Date.now()}@example.com`);
  const card = await seedCard(t, 'Saved addresses at checkout');
  const plan = await replan(t, card, 'Saved addresses, with a default', { finish: false });
  expect(await planStatus(plan.planId)).toBe('generating');
  expect(await statusOf(card.id)).toBe('planning');

  await signIn(page, t.email, PASSWORD);
  await page.goto(`/items/${card.key}`);
  const notice = statusCard(page).getByRole('status');
  await expect(notice).toContainText(held.planHeld, { timeout: FIRST_PAINT_MS });
  await expect(notice).toContainText(held.planState.generating);
  await openDoor(page, plan.sessionId, held.reviewPlan);
});

test('an inline status edit on the /items row is refused in place, with the plan line', async ({
  page,
}) => {
  const t = await seedTenant(`plan-hold-list-${Date.now()}@example.com`);
  const card = await seedCard(t, 'Wallet payments at checkout');
  await replan(t, card, 'Wallet payments, Apple Pay first');

  await signIn(page, t.email, PASSWORD);
  await page.goto('/items?view=list');
  const row = page.getByRole('main').getByTestId(`issue-row-${card.key}`);
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await row.getByRole('button', { name: `Edit ${en.issueViews.status}` }).click();
  const moved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
  );
  await page.getByRole('listbox').getByRole('option', { name: 'In Progress' }).click();
  expect((await moved).status()).toBe(200);
  // The line is rendered from the action's own refusal, anchored on the row.
  const line = row.getByRole('status');
  await expect(line).toContainText(held.planHeld);
  await expect(line.getByRole('link', { name: held.reviewPlan })).toBeVisible();
  expect(await statusOf(card.id)).toBe('planning');
});

test('in Chinese: the drag springs back, the status control says so, and 审阅计划 opens the plan', async ({
  page,
}) => {
  const zhHeld = zh.approvalGate.statusHeld;
  const t = await seedTenant(`plan-hold-zh-${Date.now()}@example.com`);
  const card = await seedCard(t, 'Split payments at checkout');
  const plan = await replan(t, card, 'Split payments, two cards');

  await page.setViewportSize(boardViewportWidth());
  await signIn(page, t.email, PASSWORD);
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);

  await page.goto('/boards');
  const zhColumns = page.getByRole('group', { name: zh.boards.boardLabel });
  await expect(zhColumns).toBeVisible({ timeout: FIRST_PAINT_MS });
  const board = await getBoard(page.request);
  const move = await pointerDragForMove(
    page,
    zhColumns.getByTestId(`board-card-${card.key}`),
    zhColumns.getByTestId(`board-column-${columnByStatus(board, 'in_progress').id}`),
  );
  await expectPlanHeldMove(move);
  const refusal = zhColumns
    .getByTestId(`board-card-${card.key}`)
    .locator('xpath=..')
    .getByRole('status');
  await expect(refusal).toContainText(zhHeld.planHeld);
  await expect(refusal.getByRole('link', { name: zhHeld.reviewPlan })).toBeVisible();
  expect(await statusOf(card.id)).toBe('planning');

  await page.keyboard.press('Escape');
  await page.goto(`/items/${card.key}`);
  const notice = page.getByRole('main').getByRole('status').filter({ hasText: zhHeld.planHeld });
  await expect(notice).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(notice).toContainText(zhHeld.planState.planned);
  await expect(notice.getByRole('link', { name: 'Review plan' })).toHaveCount(0);
  await notice.getByRole('link', { name: zhHeld.reviewPlan }).click();
  await page.waitForURL(onPlanningSurface(plan.sessionId));
  // The one dialog is the planning workspace (its name is translated, so it is
  // found by role alone) — the approval overlay never opened.
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByRole('dialog')).toHaveCount(1);
});
