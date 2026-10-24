// Acceptance E2E — AN UNDECIDED PLAN IS DECIDED IN THE PLANNING OVERLAY, AND ONLY
// THERE (Subtask MOTIR-7893, Story MOTIR-7883; ADR `approval-gates.md` and
// `agent-authored-plans.md` AMENDMENT 23 for the session end).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Every way a member reaches a plan that is still waiting lands in the planning
// overlay, painted over the page they were on, and Close puts them back there:
//
//   1. the work item's pending-plan notice — **Review**, in place, no reload;
//   2. the Plans row's state chip — in place, and a ⌘/ctrl-click opens the same
//      overlay address in a new page;
//   3. a bare `/plans/<id>` — Plans, with the overlay open on that plan, and Back
//      does not bounce through the plan address;
//   4. a plan whose session was ENDED with **Plan something new** while it still
//      waited — its Closed row, its chip and its bare address all open it in the
//      overlay, and it is approved there;
//   5. and once it is decided, `/plans/<id>` is the plan's own page again.
//
// The unrecorded tests below cover the rest of the card: several plans on one
// notice (6), a run finding's **Review** (7), the AI-planning paused notice (8), a
// DECLINED plan and a Closed session whose plan was declined (10), and a Visitor (11).
// Case 12 — the retired *no conversation* note appears nowhere — is asserted in
// every chapter and every test (`noConversationNote`).
//
// Case 9, the ONBOARDING HAND-OFF, is not re-walked here: `ai-plan-generation.spec.ts`
// (re-pointed by MOTIR-7890) drives the hand-off and asserts the overlay address on
// `/plans`, which is that door's whole claim.
//
// ── THE SEAMS ───────────────────────────────────────────────────────────────
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + the motir-ai JOBS mock
// under the routes), the lane where the planning overlay mounts. Every plan is a
// real plan on a real conversation: a person asks from a card, and the run is
// finished by the shipped services its handler calls (`finishSessionPlan*` →
// `addProposals` → `markPlanned`, which raises the gate). The session in case 4 is
// ended the way a person ends it — the overlay's **Plan something new** — so the
// plan it leaves `planned` is the one `planSessionEndService.endSessionWithin`
// leaves, not a row edited by hand.
//
// ⚠️ NO OVERLAY ADDRESS IS WRITTEN HERE. Every overlay address this spec reaches
// is composed by the product (a door, a row, the redirect); the spec only READS
// the session parameter back off the URL to prove which plan opened.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a
// `waitForURL`, the overlay's plan pane, or a response armed before the click.
// Nothing waits on a timer. `beat()` and the chapter hold are PACING only — each
// taken AFTER the assertion that proved the state.
import { writeFileSync } from 'node:fs';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import {
  finishSessionPlan,
  finishSessionPlanWithCards,
  latestPlanningSession,
} from './_helpers/planChangeConversation';
import { seedVisitorProject, VISITOR_PASSWORD } from './_helpers/visitor-seed';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { aiPlanningPanel, openAiPlanningSettings } from './_helpers/ai-planning-settings';
import { appendEvents, ingestContext, openRun } from './_helpers/agent-run-seed';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { workItemsService } from '@/lib/services/workItemsService';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 240_000 });

const surface = en.approvalGate.planApproval.surface;
const declineConfirm = en.approvalGate.planApproval.declineConfirm;
const state = en.aiPlanning.sessions.planState;

/** The retired copy, INLINED because its keys are gone (MOTIR-7885). */
const RETIRED_NO_CONVERSATION_TAG = 'no conversation';
const RETIRED_NO_CONVERSATION_WHY = 'There is no conversation on record for this plan.';

// ── Locators ─────────────────────────────────────────────────────────────────

/** THE OVERLAY — the planning workspace dialog (`{project} plan`). */
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const planPane = (overlay: Locator) => overlay.getByTestId('plan-proposal-views');
const bar = (overlay: Locator) => overlay.getByTestId('plan-change-confirm-bar');
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const restartControl = (page: Page) => rail(page).getByTestId('planning-restart-control');
const restartConfirm = (page: Page) => rail(page).getByTestId('planning-restart-confirm');
const endMarker = (page: Page) => rail(page).getByTestId('planning-session-end');

const notice = (page: Page) => page.getByRole('main').getByTestId('pending-plan-notice');
const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });
/** One Plans row, by the SESSION it is — never by a position. */
const sessionRow = (page: Page, sessionId: string) =>
  page.locator(`[data-session-row="${sessionId}"]`);
const chipDoor = (row: Locator, label: string) =>
  row.getByRole('link', { name: `Open the plan — ${label}` });
/** The plan page's own status pill — rendered by the plan page, never by the overlay. */
const planPagePill = (page: Page) => page.getByRole('main').getByTestId('plan-status-pill').first();

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

function resetJobsFixture(): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], submitted: [] }, null, 2));
}

/** On the CONTEXT, not the page: case 2's modified click opens a second page,
 *  and it must read the same AI access as the first. */
async function stubAiAccess(context: BrowserContext): Promise<void> {
  await context.route('**/api/ai/access', (route) =>
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

// ── Window- and history-level proofs ─────────────────────────────────────────

const MARK = '__planOverlayOnlyMark';

/** Set a value on `window` that only survives if the page is NOT reloaded. */
async function markWindow(page: Page, value: string): Promise<void> {
  await page.evaluate(
    ([key, v]) => {
      (window as unknown as Record<string, unknown>)[key] = v;
    },
    [MARK, value] as const,
  );
}

async function windowMark(page: Page): Promise<unknown> {
  return page.evaluate((key) => (window as unknown as Record<string, unknown>)[key] ?? null, MARK);
}

/** An address as a comparable string — path plus its parameters in a stable order. */
function addressOf(href: string): string {
  const url = new URL(href);
  const params = [...url.searchParams].sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname}?${new URLSearchParams(params).toString()}`;
}

/** CASE 12, asserted wherever the walk goes: the retired note is not on the page. */
async function noConversationNote(page: Page): Promise<void> {
  await expect(page.getByTestId('plan-no-conversation')).toHaveCount(0);
  await expect(page.getByText(RETIRED_NO_CONVERSATION_TAG, { exact: true })).toHaveCount(0);
  await expect(page.getByText(RETIRED_NO_CONVERSATION_WHY)).toHaveCount(0);
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

/** Ask from a CARD — the anchored door's 200 is "the session holds this turn". */
async function askFromCard(page: Page, text: string): Promise<void> {
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

async function closeViaEscape(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

interface Asked {
  sessionId: string;
  ctx: { userId: string; workspaceId: string };
}

/** A person asks from a card; the conversation is real, its plan still `generating`. */
async function askOnCard(page: Page, email: string, cardKey: string, ask: string): Promise<Asked> {
  await openFromCard(page, cardKey);
  await askFromCard(page, ask);
  const session = await latestPlanningSession(email);
  await closeViaEscape(page);
  return {
    sessionId: session.id,
    ctx: { userId: session.createdById, workspaceId: session.workspaceId },
  };
}

async function workItemId(key: string): Promise<string> {
  return (await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } })).id;
}

const planStatus = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status;
const sessionEnd = async (sessionId: string) =>
  adminDb.planChangeSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: { endedAt: true, endReason: true },
  });

/**
 * THE PROOF A DOOR LANDED IN THE OVERLAY: the address stayed on `host`, gained the
 * overlay's session parameter naming THIS plan's session, and the overlay's plan
 * pane rendered — never its skeleton, never the plan page.
 */
async function overlayOn(page: Page, host: string, sessionId: string): Promise<Locator> {
  await page.waitForURL(
    (url) => url.pathname === host && url.searchParams.get('planSession') === sessionId,
  );
  const overlay = workspace(page);
  await expect(planPane(overlay)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(workspace(page)).toHaveCount(1);
  await expect(planPagePill(page)).toHaveCount(0);
  return overlay;
}

/** The plan in the overlay is still waiting: both verbs are there to press. */
async function decidable(overlay: Locator): Promise<void> {
  await expect(bar(overlay)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(verb(bar(overlay), surface.approve)).toBeEnabled();
  await expect(verb(bar(overlay), surface.decline)).toBeVisible();
}

/** The PLAN PAGE rendered at its own address — proved by its own pill, with no overlay. */
async function onPlanPage(page: Page, planPath: string, status: RegExp): Promise<void> {
  await expect(planPagePill(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(planPagePill(page)).toContainText(status);
  expect(new URL(page.url()).pathname).toBe(planPath);
  await expect(workspace(page)).toHaveCount(0);
}

async function openPlans(page: Page): Promise<void> {
  await page.goto('/plans');
  await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** *Plan something new* → Confirm: the person ends the open session (`restarted`). */
async function planSomethingNew(page: Page, sessionId: string): Promise<void> {
  await expect(restartControl(page)).toBeEnabled({ timeout: 60_000 });
  const raised = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session/restart/confirm' &&
      r.request().method() === 'POST',
  );
  await restartControl(page).click();
  expect((await raised).status()).toBe(200);
  await expect(restartConfirm(page)).toBeVisible();

  const answered = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session/restart' &&
      r.request().method() === 'POST',
  );
  await restartConfirm(page).click();
  const res = await answered;
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ outcome: 'restarted', endedSessionId: sessionId });
}

const decideResponse = (page: Page, planId: string, action: 'approve' | 'decline') =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/plans/${planId}/${action}` &&
      r.request().method() === 'POST',
  );

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORDED PATH — cases 1–5 of the card, paced for a person to watch.
// ─────────────────────────────────────────────────────────────────────────────

test('every door to a waiting plan opens the planning overlay, even after its session ended', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7883');

  const email = `overlay-only-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page.context());
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Split this story so the canvas seam can ship on its own.';
  const SECOND_ASK = 'Plan the host seam on its own.';
  const storyPath = `/items/${seed.storyKey}`;
  let planId = '';
  let sessionId = '';
  let waitingPlanId = '';
  let endedSessionId = '';

  await chapter('A plan names the story — Review opens it over the story', async () => {
    const asked = await askOnCard(page, email, seed.storyKey, ASK);
    sessionId = asked.sessionId;
    planId = await finishSessionPlanWithCards(sessionId, await workItemId(seed.storyKey), [
      'Ship the canvas seam first',
    ]);

    await page.goto(storyPath);
    await expect(notice(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await noConversationNote(page);
    const before = page.url();
    await markWindow(page, 'story');

    await notice(page)
      .getByRole('link', {
        name: en.issueViews.pendingPlanReviewAria.replace('{key}', seed.storyKey),
      })
      .click();
    const overlay = await overlayOn(page, storyPath, sessionId);
    await decidable(overlay);
    await expect(bar(overlay)).toContainText('1 added');
    // IN PLACE: the page under the overlay was never reloaded.
    expect(await windowMark(page)).toBe('story');
    await noConversationNote(page);
    await beat();

    await closeViaEscape(page);
    expect(addressOf(page.url())).toBe(addressOf(before));
    await expect(notice(page)).toBeVisible();
    expect(await windowMark(page)).toBe('story');
    await beat();
  });

  await chapter('On Plans, the row’s chip opens the same plan in place', async () => {
    await openPlans(page);
    const row = sessionRow(page, sessionId);
    await expect(row).toContainText(state.planned);
    await noConversationNote(page);
    const before = page.url();
    await markWindow(page, 'plans');

    await chipDoor(row, state.planned).click();
    const overlay = await overlayOn(page, '/plans', sessionId);
    await decidable(overlay);
    expect(await windowMark(page)).toBe('plans');
    await beat();

    await closeViaEscape(page);
    expect(addressOf(page.url())).toBe(addressOf(before));
    await expect(sessionRow(page, sessionId)).toBeVisible();
    expect(await windowMark(page)).toBe('plans');

    // ⌘/ctrl-click is the browser's: a NEW page, on the full overlay address,
    // with the overlay over the Plans list.
    const opened = page.context().waitForEvent('page');
    await chipDoor(sessionRow(page, sessionId), state.planned).click({
      modifiers: ['ControlOrMeta'],
    });
    const tab = await opened;
    await overlayOn(tab, '/plans', sessionId);
    // The list is underneath it (aria-hidden behind the modal, so read as markup).
    await expect(sessionRow(tab, sessionId)).toHaveCount(1);
    await noConversationNote(tab);
    await tab.close();
    await beat();
  });

  await chapter('A bare /plans/<id> lands on Plans with the overlay open', async () => {
    // A known page BEFORE the bare address, so Back has somewhere to land.
    await page.goto(storyPath);
    await expect(notice(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

    await page.goto(`/plans/${planId}`);
    const overlay = await overlayOn(page, '/plans', sessionId);
    await decidable(overlay);
    await noConversationNote(page);
    await beat();

    // Back does NOT bounce through `/plans/<id>`: the redirect replaced it, so the
    // entry behind the overlay is the story we came from.
    await page.goBack();
    await page.waitForURL((url) => url.pathname === storyPath);
    expect(new URL(page.url()).pathname).not.toBe(`/plans/${planId}`);
    await expect(notice(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await beat();
  });

  await chapter(
    'Plan something new while a plan waits — its session reads Waiting for approval',
    async () => {
      const asked = await askOnCard(page, email, seed.subtaskKey, SECOND_ASK);
      endedSessionId = asked.sessionId;
      waitingPlanId = await finishSessionPlan(endedSessionId, 'Move the host seam behind a flag');

      // Back into that conversation, and end it the way a person does.
      await openFromCard(page, seed.subtaskKey);
      await planSomethingNew(page, endedSessionId);
      // PERSISTED: the session ended `restarted`, and its plan still WAITS.
      expect(await sessionEnd(endedSessionId)).toMatchObject({ endReason: 'restarted' });
      expect(await planStatus(waitingPlanId)).toBe('planned');
      await beat();
      await closeViaEscape(page);

      await openPlans(page);
      const row = sessionRow(page, endedSessionId);
      // MOTIR-7944: an ended session that still holds a plan awaiting a decision reads that
      // plan's state, not Closed (only an idle end stays Closed).
      await expect(row).toContainText(state.planned);
      await noConversationNote(page);
      await beat();
    },
  );

  await chapter('The row, its chip and its address all open the waiting plan', async () => {
    // The row's title.
    await sessionRow(page, endedSessionId).getByRole('link', { name: SECOND_ASK }).click();
    let overlay = await overlayOn(page, '/plans', endedSessionId);
    await decidable(overlay);
    await beat();
    await closeViaEscape(page);

    // Its chip.
    await chipDoor(sessionRow(page, endedSessionId), state.planned).click();
    overlay = await overlayOn(page, '/plans', endedSessionId);
    await decidable(overlay);
    await beat();
    await closeViaEscape(page);

    // Its bare address — and Approve it there.
    await page.goto(`/plans/${waitingPlanId}`);
    overlay = await overlayOn(page, '/plans', endedSessionId);
    await decidable(overlay);
    await noConversationNote(page);
    const approved = decideResponse(page, waitingPlanId, 'approve');
    await verb(bar(overlay), surface.approve).click();
    expect((await approved).status()).toBe(200);
    expect(await planStatus(waitingPlanId)).toBe('approved');
    await beat();
  });

  await chapter('Decided, the plan’s address is its own page again', async () => {
    await page.goto(`/plans/${waitingPlanId}`);
    await onPlanPage(page, `/plans/${waitingPlanId}`, /approved/i);
    await noConversationNote(page);
    await beat();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REST OF THE CARD — cases 6–8 and 10–12, unrecorded.
// ─────────────────────────────────────────────────────────────────────────────

test('case 6 — a notice listing two plans opens each one on its OWN session', async ({ page }) => {
  const email = `overlay-only-several-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page.context());
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);
  const storyId = await workItemId(seed.storyKey);

  const first = await askOnCard(page, email, seed.storyKey, 'Split the story.');
  await finishSessionPlanWithCards(first.sessionId, storyId, ['Ship the canvas seam first']);
  // A second conversation, on another card, whose plan also adds under the story.
  const second = await askOnCard(page, email, seed.subtaskKey, 'Plan the host seam.');
  await finishSessionPlanWithCards(second.sessionId, storyId, ['Thread the host seam']);
  expect(second.sessionId).not.toBe(first.sessionId);

  const storyPath = `/items/${seed.storyKey}`;
  await page.goto(storyPath);
  await expect(notice(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  const rows = notice(page).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await noConversationNote(page);
  const before = page.url();
  await markWindow(page, 'story');

  const opened: string[] = [];
  for (const index of [0, 1]) {
    await rows.nth(index).getByRole('link').click();
    await page.waitForURL(
      (url) => url.pathname === storyPath && url.searchParams.get('planSession') !== null,
    );
    const landed = new URL(page.url()).searchParams.get('planSession')!;
    await overlayOn(page, storyPath, landed);
    await decidable(workspace(page));
    expect(await windowMark(page)).toBe('story');
    opened.push(landed);
    await closeViaEscape(page);
    expect(addressOf(page.url())).toBe(addressOf(before));
  }
  // Each row opened THAT plan's session — the two differ, and they are the two.
  expect(new Set(opened)).toEqual(new Set([first.sessionId, second.sessionId]));
});

test('case 7 — a run finding’s Review opens the plan over the run, and Close returns', async ({
  page,
  baseURL,
}) => {
  const email = `overlay-only-run-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page.context());
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const asked = await askOnCard(page, email, seed.storyKey, 'Split the story for the run.');
  const planId = await finishSessionPlan(asked.sessionId, 'Ship the canvas seam first');

  // THE RUN, through the CLI's own ingest: opened with one card and that card's
  // leg claimed, so the run is `running` and the leg is open.
  const project = await adminDb.project.findFirstOrThrow({
    where: { identifier: seed.projectKey },
  });
  const runCard = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Wire the run’s seam' },
    asked.ctx,
  );
  const minted = await apiTokensService.create(asked.ctx.userId, asked.ctx.workspaceId, {
    label: 'overlay-only-run-e2e',
    projectId: project.id,
    permissions: ['project:browse', 'work_item:edit'],
  });
  if (!baseURL) throw new Error('no Playwright baseURL — the ingest calls have nowhere to go');
  const api = await ingestContext(minted.token, baseURL);
  const runId = await openRun(api, {
    projectKey: seed.projectKey,
    command: 'run',
    agent: 'claude',
    cards: [{ key: runCard.identifier, disposition: 'queued' }],
  });
  await appendEvents(api, runId, [
    { kind: 'card_claimed', workItemKey: runCard.identifier, disposition: 'running' },
  ]);
  // ⚠️ THE FINDING IS WRITTEN BY ITS SHIPPED WRITER, CALLED DIRECTLY. `plan_submitted`
  // is refused at the ingest by design (a client may not forge a finding), and the
  // plan-side producer (`recordSubmittedPlanFinding`) only fires for a plan created
  // on a leg's own anchor while that leg is open. This spec's subject is the DOOR on
  // the finding, so the event is appended by `dispatchRunService.recordFinding` — the
  // one function that writes it — against the open leg above.
  const recorded = await dispatchRunService.recordFinding(
    {
      anchorWorkItemId: runCard.id,
      kind: 'plan_submitted',
      findingId: planId,
      data: { planId, proposalCount: 1 },
    },
    asked.ctx,
  );
  expect(recorded.recorded).toBe(true);
  await api.dispose();

  await page.goto(`/runs?run=${runId}`);
  const findings = page.getByRole('region', { name: en.runs.findings.label });
  const review = findings.getByRole('link', { name: en.runs.findings.review });
  await expect(review).toBeVisible({ timeout: FIRST_PAINT_MS });
  await noConversationNote(page);
  const before = page.url();
  await markWindow(page, 'run');

  await review.click();
  const overlay = await overlayOn(page, '/runs', asked.sessionId);
  // …over the RUN: its own parameter is still in the address.
  expect(new URL(page.url()).searchParams.get('run')).toBe(runId);
  await decidable(overlay);
  expect(await windowMark(page)).toBe('run');
  await noConversationNote(page);

  await closeViaEscape(page);
  expect(addressOf(page.url())).toBe(addressOf(before));
  await expect(review).toBeVisible();
  expect(await windowMark(page)).toBe('run');
});

test('case 8 — the AI planning paused notice opens the plan over settings, and Close returns', async ({
  page,
}) => {
  const email = `overlay-only-paused-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page.context());
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const asked = await askOnCard(page, email, seed.storyKey, 'Split the story while paused.');
  await finishSessionPlan(asked.sessionId, 'Ship the canvas seam first');
  // Auto-plan ON, through the shipped settings write: an undecided plan now PAUSES
  // it, and the panel says so with a link to that plan.
  await projectAiSettingsService.updateAiSettings(
    seed.projectKey,
    { aiAutoPlanEnabled: true },
    asked.ctx,
  );

  await openAiPlanningSettings(page);
  const link = aiPlanningPanel(page).getByTestId('ai-planning-paused-link');
  await expect(link).toBeVisible({ timeout: FIRST_PAINT_MS });
  await noConversationNote(page);
  const before = page.url();
  const settingsPath = new URL(before).pathname;
  await markWindow(page, 'settings');

  await link.click();
  const overlay = await overlayOn(page, settingsPath, asked.sessionId);
  await decidable(overlay);
  expect(await windowMark(page)).toBe('settings');
  await noConversationNote(page);

  await closeViaEscape(page);
  expect(addressOf(page.url())).toBe(addressOf(before));
  await expect(link).toBeVisible();
  expect(await windowMark(page)).toBe('settings');
});

test('case 10 — a DECLINED plan keeps its page: no redirect, no overlay', async ({ page }) => {
  const email = `overlay-only-declined-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page.context());
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const asked = await askOnCard(page, email, seed.storyKey, 'Should the seam split first?');
  const planId = await finishSessionPlan(asked.sessionId, 'Split billing first');

  // Decline it where it is decided — the overlay's own confirm band.
  const overlay = await openUndecidedPlan(page, planId);
  await verb(bar(overlay), surface.decline).click();
  const band = overlay.getByTestId('plan-decline-confirm').first();
  await expect(band).toContainText(declineConfirm.title);
  const declined = decideResponse(page, planId, 'decline');
  await verb(band, declineConfirm.proceed).click();
  expect((await declined).status()).toBe(200);
  expect(await planStatus(planId)).toBe('declined');

  await page.goto(`/plans/${planId}`);
  await onPlanPage(page, `/plans/${planId}`, /declined/i);
  await noConversationNote(page);
});

test('case 10 — a Closed session whose plan was declined still opens as a read, with no chip door', async ({
  page,
}) => {
  const email = `overlay-only-closed-declined-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page.context());
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Plan the host seam, then think again.';
  // The ask leaves the session's plan `generating`; Plan something new discards a
  // generating plan as the person's decision — a Closed session, its plan declined.
  const asked = await askOnCard(page, email, seed.subtaskKey, ASK);
  const plan = await adminDb.plan.findFirstOrThrow({ where: { sessionId: asked.sessionId } });
  await openFromCard(page, seed.subtaskKey);
  await planSomethingNew(page, asked.sessionId);
  expect(await sessionEnd(asked.sessionId)).toMatchObject({ endReason: 'restarted' });
  expect(await planStatus(plan.id)).toBe('declined');
  await closeViaEscape(page);

  await openPlans(page);
  const row = sessionRow(page, asked.sessionId);
  await expect(row).toContainText(state.closed);
  // No chip door on a Closed row whose plan is decided.
  await expect(row.getByRole('link', { name: /^Open the plan/ })).toHaveCount(0);
  await noConversationNote(page);

  // The row opens the CONVERSATION, as a read: its end is drawn, nothing to decide.
  await row.getByRole('link', { name: ASK }).click();
  await page.waitForURL(
    (url) => url.pathname === '/plans' && url.searchParams.get('planSession') === asked.sessionId,
  );
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(endMarker(page)).toHaveAttribute('data-end-reason', 'restarted');
  await expect(verb(workspace(page), surface.approve)).toHaveCount(0);
  await noConversationNote(page);
});

test('case 11 — a Visitor keeps the plan page for an undecided plan, with no overlay', async ({
  page,
}) => {
  const s = await seedVisitorProject(`overlay-only-${Date.now()}`);
  // The seeded VISIBLE plan is `planned` on a session — the plan a member would be
  // redirected away from.
  const plan = await adminDb.plan.findFirstOrThrow({ where: { title: s.plans.visible } });
  expect(plan.status).toBe('planned');
  expect(plan.sessionId).not.toBeNull();
  const planPath = `/p/${s.project.key}/plans/${plan.id}`;

  await signIn(page, s.outsider.email, VISITOR_PASSWORD);
  // First visit: the consent screen, answered as a person answers it.
  await page.goto(planPath);
  await page.waitForURL((url) => url.pathname === `/p/${s.project.key}/consent`);
  const consent = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes(`/p/${s.project.key}/consent`),
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await consent).status()).toBe(200);
  await page.waitForURL((url) => !url.pathname.endsWith('/consent'));

  await page.goto(planPath);
  await expect(planPagePill(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  expect(new URL(page.url()).pathname).toBe(planPath);
  expect(new URL(page.url()).searchParams.has('plan')).toBe(false);
  await expect(page.getByRole('dialog', { name: /plan/i })).toHaveCount(0);
  await noConversationNote(page);
});
