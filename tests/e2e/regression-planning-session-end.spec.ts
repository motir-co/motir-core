// Acceptance E2E — a planning session ENDS, and is never resumed once ended
// (Subtask MOTIR-7645, Story MOTIR-7630; `agent-authored-plans.md` AMENDMENT 23).
//
// The walk that went wrong on 2026-10-05, ending cleanly: a failed attempt closes
// its session at once and gives the card back; Start a new session carries the
// conversation into a new one; that open session takes its owner back and holds
// the card; another member is refused with who holds it and when it frees; the
// card cannot be moved by hand while the session is open; and Plans reads Closed.
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'), where
// the motir-ai JOBS boundary is mocked UNDER the routes (`lib/test-ai-jobs-mock.ts`).
// The first planning run is DECLARED failed in the fixture (its `plan` queue), so
// the stream relay sees the same terminal `status: failed` frame a dead run sends
// and ends the session server-side — nothing in this spec ends it by hand.
//
// ⚠️ ONE DEVIATION FROM THE STORY'S RECIPE, read from the shipped contract. Step 3
// expects the take-back NOTICE on reopening. A conversation started from a card is
// that card's OWN thread, so reopening the card RESUMES it — the same session,
// every turn there, nothing fresh started — and the notice is reserved for the
// case where a DIFFERENT door finds the person's open session holding the card
// (a multi-target thread reopened from one of its cards). That case is pinned by
// `tests/ai/contextualPlanningService.test.ts` and
// `tests/components/plan-change-rail-session-end.test.tsx`; this walk shows the
// resume itself.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a turn's
// text, a `waitForURL` or the response of a request the page issued, and every
// step is checked against the database as well as the page. `beat()` / the
// chapter hold are PACING only, each after the assertion that proved the state.
import { writeFileSync } from 'node:fs';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { latestPlanningSession } from './_helpers/planChangeConversation';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

const ended = en.planningWorkspace.session;
const held = en.approvalGate.statusHeld;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const endMarker = (page: Page) => rail(page).getByTestId('planning-session-end');
const failedClosed = (page: Page) => rail(page).getByTestId('planning-failed-closed');
const startSlot = (page: Page) => rail(page).getByTestId('planning-session-ended');
const copiedDivider = (page: Page) => rail(page).getByTestId('planning-copied-divider');
const refusal = (page: Page) => rail(page).getByTestId('planning-target-refused');
const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });
const tabStrip = (page: Page) =>
  page.getByRole('group', { name: 'Filter conversations by plan state' });
const tab = (page: Page, name: string) => tabStrip(page).getByRole('button', { name });

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** The first planning run DIES; every later one closes as a plain success. */
function declareFirstRunFails(): void {
  writeFileSync(
    JOBS_FIXTURE,
    JSON.stringify(
      {
        ask: [{ intent: 'ask', answer: 'Nothing is blocked right now.', citations: [] }],
        plan: [{ status: 'failed' }, { status: 'succeeded' }],
        submitted: [],
      },
      null,
      2,
    ),
  );
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

// ── Persisted state ──────────────────────────────────────────────────────────

async function cardOf(key: string) {
  return adminDb.workItem.findFirstOrThrow({
    where: { identifier: key },
    select: { id: true, status: true },
  });
}

async function sessionRow(id: string) {
  return adminDb.planChangeSession.findUniqueOrThrow({
    where: { id },
    select: {
      endedAt: true,
      endReason: true,
      copiedFromSessionId: true,
      failedAt: true,
      workspaceId: true,
    },
  });
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** Open *Plan with AI* from the card, and prove the overlay MOUNTED first. */
async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

/** Send a turn from a CARD — its 200 is the authoritative "the session holds it". */
async function sendFromCard(page: Page, text: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await sent).status()).toBe(200);
  await expect(rail(page).getByText(text).first()).toBeVisible();
}

test.beforeEach(async () => {
  await resetDatabase();
  declareFirstRunFails();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a failed attempt closes its session, the conversation carries on, and the open session holds its card', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7630');

  const email = `planning-session-end-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  const key = seed.storyKey;
  const before = (await cardOf(key)).status;
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const FIRST = 'Split this story so the canvas work can ship on its own.';
  const SECOND = 'Keep the canvas seam as its own subtask.';
  let failedId = '';
  let copyId = '';

  await chapter('Plan with AI on the card — the attempt fails and the session closes', async () => {
    await openFromCard(page, key);
    await sendFromCard(page, FIRST);
    failedId = (await latestPlanningSession(email)).id;

    // MOTIR-7905 (decision MOTIR-7906): a failed HOSTED attempt no longer ends its session — it
    // keeps it and waits in To resume. The Closed form below is the one a session that ended
    // `failed` BEFORE that story still has, so the historic end is made through the end door
    // and the session is reopened by its own address.
    await expect.poll(async () => (await sessionRow(failedId)).failedAt).not.toBeNull();
    expect((await sessionRow(failedId)).endedAt).toBeNull();
    await planSessionEndService.endSession(failedId, 'failed', {
      workspaceId: (await sessionRow(failedId)).workspaceId,
    });
    const closedAddress = new URL(page.url());
    closedAddress.searchParams.set('planSession', failedId);
    await page.goto(closedAddress.pathname + closedAddress.search);

    // The failure line with no Try again, the Closed marker, and Start a new session.
    await expect(failedClosed(page)).toBeVisible();
    await expect(endMarker(page)).toHaveAttribute('data-end-reason', 'failed');
    await expect(endMarker(page)).toContainText(ended.end.closed);
    await expect(rail(page).getByRole('button', { name: /try again/i })).toHaveCount(0);
    await expect(
      startSlot(page).getByRole('button', { name: ended.newSession.start }),
    ).toBeVisible();

    // PERSISTED: the session ended `failed`, and the card is back where it was.
    expect(await sessionRow(failedId)).toMatchObject({ endReason: 'failed' });
    expect((await sessionRow(failedId)).endedAt).not.toBeNull();
    expect((await cardOf(key)).status).toBe(before);
    await beat();
  });

  // An ENDED session is resumed by no door (AMENDMENT 23 §3), so a plain reload of
  // the card's overlay opens an empty rail with the earlier-conversation notice.
  // The session's OWN address — what a Plans row writes — still opens it, and what
  // it draws there is read from the row: the end survives a fresh page.
  await chapter(
    'Opened by its address, the session draws the same end — it is the server’s, not the stream’s',
    async () => {
      const address = new URL(page.url());
      address.searchParams.set('planSession', failedId);
      await page.goto(address.pathname + address.search);
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(endMarker(page)).toHaveAttribute('data-end-reason', 'failed');
      await expect(composer(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter('Start a new session — the conversation comes with it', async () => {
    const started = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/ai/plan-change/session' &&
        r.request().method() === 'POST',
    );
    await startSlot(page).getByRole('button', { name: ended.newSession.start }).click();
    const copy = (await (await started).json()) as { id: string };
    copyId = copy.id;

    await expect(copiedDivider(page)).toBeVisible();
    await expect(rail(page).getByText(FIRST)).toBeVisible();
    await expect(endMarker(page)).toHaveCount(0);
    expect((await sessionRow(copyId)).copiedFromSessionId).toBe(failedId);
    // Copying sent nothing and holds nothing yet.
    expect((await cardOf(key)).status).toBe(before);
    await beat();

    await sendFromCard(page, SECOND);
    // The new session holds the card at Planning.
    await expect.poll(async () => (await cardOf(key)).status).toBe('planning');
    const lock = await adminDb.planTargetLock.findFirstOrThrow({
      where: { workItem: { identifier: key } },
    });
    expect(lock.sessionId).toBe(copyId);
    await beat();
  });

  await chapter('Close and reopen — the same open session, never a fresh one', async () => {
    await closeOverlay(page);
    await openFromCard(page, key);
    await expect(rail(page).getByText(SECOND).first()).toBeVisible();
    await expect(copiedDivider(page)).toBeVisible();
    expect((await latestPlanningSession(email)).id).toBe(copyId);
    expect(await adminDb.planChangeSession.count({ where: { endedAt: null } })).toBe(1);
    await beat();
    await closeOverlay(page);
  });

  await chapter('Its page says it is being planned, and its status cannot move', async () => {
    await page.goto(`/items/${key}`);
    const notice = page.getByRole('main').getByRole('status').filter({ hasText: held.sessionHeld });
    await expect(notice).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(notice).toContainText(held.sessionByYou);
    await beat();

    await page
      .getByRole('main')
      .getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true })
      .click();
    // The edit swaps in the picker CLOSED; opening it is a second click.
    await page
      .getByRole('main')
      .getByRole('combobox', { name: en.issueViews.status, exact: true })
      .click();
    const toDo = page.getByRole('option', { name: /^To Do/ });
    await expect(toDo).toHaveAttribute('aria-disabled', 'true');
    await expect(toDo).toContainText(held.sessionHeldOption);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect((await cardOf(key)).status).toBe('planning');
    await beat();

    // Open the session goes to the conversation that holds it.
    await notice.getByRole('link', { name: held.openSession }).click();
    await page.waitForURL((url) => url.searchParams.get('planSession') === copyId);
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(rail(page).getByText(SECOND).first()).toBeVisible();
    await beat();
  });

  await chapter('Plans: the closed attempt and the conversation that carried on', async () => {
    await page.goto('/plans');
    await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const rows = sessionsList(page).getByRole('listitem').filter({ hasText: FIRST });
    await expect(rows).toHaveCount(2);
    const closed = page.locator(`[data-session-row="${failedId}"]`);
    await expect(closed).toContainText(en.aiPlanning.sessions.planState.closed);
    await expect(closed.getByTestId('plan-session-end')).toBeVisible();
    await expect(
      page.locator(`[data-session-row="${copyId}"]`).getByTestId('plan-session-continued-from'),
    ).toBeVisible();
    await expect(tab(page, en.aiPlanning.sessions.planState.closed)).toContainText('1');
    await expect(tab(page, en.aiPlanning.sessions.planState.declined)).toContainText('0');
    await beat();
  });

  await chapter('Another member opening the card is refused, with who and when', async () => {
    const session = await latestPlanningSession(email);
    const project = await adminDb.project.findFirstOrThrow({
      where: { identifier: seed.projectKey },
    });
    const mateEmail = `planning-session-end-mate-${Date.now()}@example.com`;
    const mate = await usersService.createUser({
      email: mateEmail,
      password: PLANNING_ANCHOR_PASSWORD,
      name: 'Second Member',
    });
    // Through the service, so the cloud org membership comes with the workspace
    // one: a member with no org cannot read the AI access the item page asks for.
    await workspacesService.addMember({ userId: mate.id, workspaceId: session.workspaceId });
    await addToProjectAs({
      key: seed.projectKey,
      actorUserId: session.createdById,
      ctx: { userId: session.createdById, workspaceId: session.workspaceId },
      targetUserId: mate.id,
      role: 'member',
    });
    await projectsService.setActiveProject({
      userId: mate.id,
      workspaceId: session.workspaceId,
      projectId: project.id,
    });

    await page.context().clearCookies();
    await signIn(page, mateEmail, PLANNING_ANCHOR_PASSWORD);
    await openFromCard(page, key);
    await expect(refusal(page)).toBeVisible();
    await expect(refusal(page)).toContainText('Planning Anchor Owner');
    await expect(refusal(page)).toContainText(key);
    await expect(composer(page)).toBeDisabled();

    // PERSISTED: looking started nothing for them, and the card stays held.
    expect(await adminDb.planChangeSession.count({ where: { createdById: mate.id } })).toBe(0);
    expect((await cardOf(key)).status).toBe('planning');
    await beat();
  });
});
