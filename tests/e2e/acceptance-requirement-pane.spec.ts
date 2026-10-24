// Acceptance E2E — A plan offer with no target shows the requirement it will plan, in
// the left pane, before Confirm; Confirm saves it as a page and plans from it (Story
// MOTIR-9430 · MOTIR-9441; design `design/ai-chat/plan-offer--requirement.mock.html`).
// The receipt a person watches to accept the story, walking its Verification recipe:
//
//   THE RECORDED WALK (one test, seven chapters). A request with no target is answered
//   with a plan offer, and the left pane shows the six-part requirement; a correction
//   typed in the conversation replaces it; Escape and a reopen show it again; Decline
//   leaves no folder, page or plan behind; asking again and typing yes starts planning
//   with ONE plan job that carries the requirement and the page, and no carried
//   answers, and the rail links the page; the link opens the page with its six
//   headings and its provenance line, in ONE root folder "Requirements Docs" created
//   by the Motir system account; and "plan this" on a card still starts at once.
//
//   THE REST (unrecorded). An offer with no requirement shows the notice; a save that
//   fails starts nothing and Confirm is still there; Confirm twice, and Confirm then a
//   typed yes, plan once; Grill me on shows no settled list over the pane; zh.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'). motir-ai is
// mocked UNDER the routes by `lib/test-ai-jobs-mock.ts`: the fixture writes each
// answer's `offer` and its `requirement`, so no assertion tests what motir-ai would
// compose — the motir-ai story gate owns that. The real ask door, offer doors, page
// writer, plan submit and Postgres all run; nothing is stubbed with `page.route` and
// nothing waits on a timer.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal: a response armed before the action that
// causes it, a Postgres row, or a seam journal. An absence is asserted only AFTER a
// presence that proves the page got there, so it cannot pass vacuously. `beat()` and
// the chapter hold are pacing, taken after the assertion that proved the step.
//
// This repository's acceptance lane publishes the receipt on a green run; no MCP
// publish is made.
import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import { declareSeam, queueAsk, submitsOf } from './_helpers/mid-run-seam';
import { grantPaidAiPlanIfBilled } from './_helpers/billing';
import { setReaderLanguage } from './_helpers/reader-language';
import { declareSharpen, grillSwitch, sharpenTurnSettled } from './_helpers/grill-me-journey';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import type { AskJobOutcome } from '@/lib/test-ai-jobs-mock';
import type { SubmittedRequirement } from '@/lib/ai/types';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 300_000 });

const offerCopy = en.planningWorkspace.planOffer;
const paneCopy = en.planningWorkspace.requirementPane;
const FOLDER_NAME = 'Requirements Docs';

// ── Locators ────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan|规划/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const sendButton = (page: Page) =>
  rail(page).getByRole('button', { name: en.planningWorkspace.conversation.send, exact: true });
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI', exact: true });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const byId = (page: Page, id: string) => rail(page).getByTestId(id);
const confirmButton = (page: Page) => byId(page, 'plan-offer-confirm');
const declineButton = (page: Page) => byId(page, 'plan-offer-decline');
const pane = (page: Page, label: string = paneCopy.label) =>
  page.getByRole('region', { name: label });
const paneSections = (page: Page) => pane(page).getByTestId('requirement-section');

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── Authoritative signals ───────────────────────────────────────────────────

const ASK = '/api/ai/ask';
const SETTLE = '/api/ai/ask/settle';
const CONFIRM = '/api/ai/plan-change/session/offer/confirm';
const DECLINE = '/api/ai/plan-change/session/offer/decline';
const pathOf = (r: Response) => new URL(r.url()).pathname;
const posted = (page: Page, pathname: string) =>
  page.waitForResponse((r) => pathOf(r) === pathname && r.request().method() === 'POST');

/** The `plan` jobs the server submitted — the planner's boundary, counted. */
const planEntries = () => submitsOf('plan');

// ── Persisted state (through the owner's client, so RLS cannot zero them) ───

const plansOf = (sessionId: string) => adminDb.plan.count({ where: { sessionId } });
// The project is seeded with its own folders (Bugs), so only this feature's is counted.
const foldersOf = (projectId: string) =>
  adminDb.folder.findMany({ where: { projectId, name: FOLDER_NAME } });
const pagesOf = (projectId: string) => adminDb.page.findMany({ where: { projectId } });

async function openConversation(userId: string) {
  return adminDb.planChangeSession.findFirstOrThrow({
    where: { createdById: userId, endedAt: null, origin: 'conversation' },
    orderBy: { createdAt: 'desc' },
  });
}

/** The latest answer turn on the conversation — the one carrying the live offer. */
async function latestAnswerRow(sessionId: string) {
  return adminDb.planChangeTurn.findFirstOrThrow({
    where: { sessionId, role: 'assistant' },
    orderBy: { seq: 'desc' },
  });
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function openProjectThread(page: Page, askLink: RegExp = /Ask about this project/) {
  await expect(orb(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await orb(page).click();
  await calloutPanel(page).getByRole('link', { name: askLink }).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

async function closeOverlay(page: Page) {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

/** Send a turn on the project thread: the ask door's 200, then the settle's body. */
async function ask(page: Page, text: string): Promise<{ outcome?: string }> {
  const asked = posted(page, ASK);
  const settled = posted(page, SETTLE);
  await composer(page).fill(text);
  await sendButton(page).click();
  const askRes = await asked;
  expect(askRes.status(), await askRes.text()).toBe(200);
  const res = await settled;
  expect(res.status(), await res.text()).toBe(200);
  await expect(rail(page).getByText(text).first()).toBeVisible();
  return (await res.json()) as { outcome?: string };
}

const REQUEST = 'Plan a CSV export of the board’s visible columns for project admins.';
const REQUIREMENT: SubmittedRequirement = {
  outcome: 'Project admins can download the board’s visible columns as a CSV file.',
  behaviour: 'Choosing Export on the board downloads one CSV with a column per visible column.',
  scopeEdge: 'No scheduled exports and no other formats.',
  constraints: 'Admins only; the file is built on request, not stored.',
  acceptance: 'An admin presses Export and receives a CSV whose header row matches the board.',
  assumptions: [
    { id: 'a1', text: 'Archived cards are left out of the file.' },
    { id: 'a2', text: 'The file name carries the project key.' },
  ],
};
const CORRECTED: SubmittedRequirement = {
  ...REQUIREMENT,
  outcome: 'Project admins can download the board as a CSV file, archived cards included.',
  assumptions: [{ id: 'a1', text: 'Archived cards are included, in their own column.' }],
};

const offering = (
  answer: string,
  requirement: SubmittedRequirement | undefined,
  requestText = REQUEST,
): AskJobOutcome => ({
  intent: 'ask',
  answer,
  offer: { kind: 'plan', requestText, immediate: false, ...(requirement ? { requirement } : {}) },
});

/** A typed yes against the pending offer, as motir-ai reads it. */
async function agreeTo(sessionId: string): Promise<AskJobOutcome> {
  const offerTurn = await latestAnswerRow(sessionId);
  return {
    intent: 'ask',
    answer: 'Starting the plan.',
    offerReply: { seq: offerTurn.seq, kind: 'plan', decision: 'agree' },
  };
}

let seed: AiAugmentReplanSeed;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  // The first planning run is HELD in progress; later ones settle at once.
  declareSeam({ ask: [], plan: [{ status: 'running' }, {}] });
  declareSharpen({ mode: 'determinate' });
  seed = await seedAiAugmentReplan(`req-pane-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const workspaceRow = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.ctx.workspaceId },
  });
  if (workspaceRow.organizationId) grantPaidAiPlanIfBilled(workspaceRow.organizationId);
  await signIn(page, seed.email, seed.password);
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Provision the Motir system account the requirement page is written by. */
const provisionSystemAccount = () =>
  seedSystemPrincipal({ workspaceId: seed.ctx.workspaceId, projectId: seed.projectId });

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('A no-target plan offer shows its requirement before Confirm, saves it as a page, and plans from it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9430');
  const userId = seed.ctx.userId;
  await provisionSystemAccount();
  let conversationId = '';
  let firstOfferSeq = 0;

  // ── 1 · THE PANE BEFORE CONFIRM ───────────────────────────────────────────
  await chapter(
    'A request with no target — the pane shows the requirement to be planned',
    async () => {
      await page.goto('/dashboard');
      await openProjectThread(page);
      queueAsk(offering('Exports are not built yet.', REQUIREMENT));
      await ask(page, 'plan a CSV export for the board');
      await expect(pane(page)).toBeVisible();
      await expect(paneSections(page)).toHaveCount(6);
      await expect(
        pane(page).getByRole('heading', { name: paneCopy.headings.outcome }),
      ).toBeVisible();
      await expect(pane(page)).toContainText(REQUIREMENT.outcome!);
      await expect(pane(page)).toContainText(REQUIREMENT.assumptions![0]!.text);
      await expect(pane(page).getByTestId('requirement-correction-hint')).toHaveText(
        paneCopy.correctionHint,
      );
      // Read-only, and the decision stays on the offer in the rail.
      await expect(pane(page).getByRole('button')).toHaveCount(0);
      await expect(confirmButton(page)).toBeVisible();
      await expect(declineButton(page)).toBeVisible();
      conversationId = (await openConversation(userId)).id;
      firstOfferSeq = (await latestAnswerRow(conversationId)).seq;
      // Nothing is written until Confirm.
      expect(await foldersOf(seed.projectId)).toHaveLength(0);
      expect(await pagesOf(seed.projectId)).toHaveLength(0);
      expect(planEntries()).toHaveLength(0);
      await beat();
    },
  );

  // ── 2 · A CORRECTION REPLACES IT ──────────────────────────────────────────
  await chapter('A correction typed in the conversation replaces the requirement', async () => {
    queueAsk(offering('Updated: archived cards are included.', CORRECTED));
    await ask(page, 'include the archived cards too');
    await expect(pane(page)).toContainText(CORRECTED.outcome!);
    await expect(pane(page)).not.toContainText(REQUIREMENT.outcome!);
    await expect(paneSections(page)).toHaveCount(6);
    await expect(confirmButton(page)).toHaveCount(1);
    expect((await latestAnswerRow(conversationId)).seq).toBeGreaterThan(firstOfferSeq);
    // The second turn carried the first one to the planner's read of the conversation.
    const asks = submitsOf('ask_project');
    expect(asks.at(-1)?.conversationTurns?.length ?? 0).toBeGreaterThanOrEqual(2);
    await beat();
  });

  // ── 3 · ESCAPE AND REOPEN ─────────────────────────────────────────────────
  await chapter('Escape closes the overlay, and reopening shows the same requirement', async () => {
    await closeOverlay(page);
    await openProjectThread(page);
    expect((await openConversation(userId)).id).toBe(conversationId);
    await expect(pane(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(pane(page)).toContainText(CORRECTED.outcome!);
    await expect(confirmButton(page)).toBeVisible();
    await beat();
  });

  // ── 4 · DECLINE LEAVES NOTHING ────────────────────────────────────────────
  await chapter('Decline — no folder, no page and no plan is made', async () => {
    const declined = posted(page, DECLINE);
    await declineButton(page).click();
    expect((await declined).status()).toBe(200);
    await expect(byId(page, 'plan-offer-declined')).toBeVisible();
    await expect(confirmButton(page)).toHaveCount(0);
    expect(await foldersOf(seed.projectId)).toHaveLength(0);
    expect(await pagesOf(seed.projectId)).toHaveLength(0);
    expect(await plansOf(conversationId)).toBe(0);
    expect(planEntries()).toHaveLength(0);
    await beat();
  });

  // ── 5 · A TYPED YES PLANS FROM THE REQUIREMENT ────────────────────────────
  await chapter(
    'Asked again, a typed yes plans from the requirement and links its page',
    async () => {
      queueAsk(offering('Exports are still not built.', CORRECTED));
      await ask(page, 'actually, plan it after all');
      await expect(pane(page)).toContainText(CORRECTED.outcome!);
      queueAsk(await agreeTo(conversationId));
      expect((await ask(page, 'yes, plan it')).outcome).toBe('redirected');
      await expect.poll(() => planEntries().length).toBe(1);
      const sent = planEntries()[0]!;
      expect(sent.requirement).toEqual(CORRECTED);
      expect(sent.hasCarriedAnswers).toBe(false);
      const pages = await pagesOf(seed.projectId);
      expect(pages).toHaveLength(1);
      expect(sent.requirementPage?.pageId).toBe(pages[0]!.id);
      expect(await plansOf(conversationId)).toBe(1);
      await expect(byId(page, 'plan-offer-confirmed')).toBeVisible();
      const link = byId(page, 'plan-offer-requirement-page').getByRole('link');
      await expect(link).toHaveAttribute('href', `/pages/${pages[0]!.id}`);
      await beat();
    },
  );

  // ── 6 · THE PAGE ──────────────────────────────────────────────────────────
  await chapter('The link opens the page, in one root Requirements Docs folder', async () => {
    const [saved] = await pagesOf(seed.projectId);
    await byId(page, 'plan-offer-requirement-page').getByRole('link').click();
    await page.waitForURL(`**/pages/${saved!.id}`);
    for (const heading of Object.values(paneCopy.headings)) {
      await expect(page.getByRole('main').getByRole('heading', { name: heading })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
    }
    await expect(page.getByRole('main')).toContainText(CORRECTED.outcome!);
    const folders = await foldersOf(seed.projectId);
    expect(folders.map((f) => [f.name, f.parentFolderId])).toEqual([[FOLDER_NAME, null]]);
    expect(saved!.folderId).toBe(folders[0]!.id);
    const system = await adminDb.user.findUniqueOrThrow({
      where: { email: MOTIR_SYSTEM_USER_EMAIL },
    });
    expect(saved!.createdById).toBe(system.id);
    expect(folders[0]!.createdById).toBe(system.id);
    await beat();
  });

  // ── 7 · A TARGETED "PLAN THIS" IS UNCHANGED ───────────────────────────────
  await chapter('"Plan this" on a card still starts at once, with no requirement', async () => {
    await page.goto(`/items/${seed.notifKey}`);
    await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await entrance(page).click();
    await page.waitForURL(overlayOpen);
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const started = page.waitForResponse(
      (r) =>
        /\/api\/work-items\/[^/]+\/ai\/plan$/.test(pathOf(r)) && r.request().method() === 'POST',
    );
    await composer(page).fill('plan this');
    await sendButton(page).click();
    expect((await started).status()).toBe(200);
    await expect.poll(() => planEntries().length).toBe(2);
    expect(planEntries()[1]!.requirement).toBeUndefined();
    await expect(pane(page)).toHaveCount(0);
    expect(await pagesOf(seed.projectId)).toHaveLength(1);
    await beat();
  });
});

// ═══ The rest (unrecorded) ═══════════════════════════════════════════════════

test('an offer composed with no requirement shows the notice, and Confirm still plans', async ({
  page,
}) => {
  await provisionSystemAccount();
  await page.goto('/dashboard');
  await openProjectThread(page);
  queueAsk(offering('Exports are not built yet.', undefined));
  await ask(page, 'plan a CSV export for the board');
  await expect(pane(page).getByTestId('requirement-notice')).toHaveText(paneCopy.notice);
  await expect(paneSections(page)).toHaveCount(0);
  const confirmed = posted(page, CONFIRM);
  await confirmButton(page).click();
  expect((await confirmed).status()).toBe(200);
  await expect.poll(() => planEntries().length).toBe(1);
  expect(planEntries()[0]!.requirement).toBeUndefined();
  // Nothing was composed, so nothing was saved.
  expect(await pagesOf(seed.projectId)).toHaveLength(0);
});

test('a save that fails starts nothing, keeps Confirm, and succeeds once the account is back', async ({
  page,
}) => {
  // The Motir system account is not provisioned, so the page cannot be written.
  await page.goto('/dashboard');
  await openProjectThread(page);
  queueAsk(offering('Exports are not built yet.', REQUIREMENT));
  await ask(page, 'plan a CSV export for the board');
  const refused = posted(page, CONFIRM);
  await confirmButton(page).click();
  const res = await refused;
  expect(res.status()).not.toBe(200);
  await expect(byId(page, 'plan-offer-requirement-not-saved')).toBeVisible();
  await expect(confirmButton(page)).toBeVisible();
  await expect(pane(page)).toContainText(REQUIREMENT.outcome!);
  expect(planEntries()).toHaveLength(0);
  expect(await pagesOf(seed.projectId)).toHaveLength(0);

  await provisionSystemAccount();
  const retried = posted(page, CONFIRM);
  await confirmButton(page).click();
  expect((await retried).status()).toBe(200);
  await expect.poll(() => planEntries().length).toBe(1);
  expect(await pagesOf(seed.projectId)).toHaveLength(1);
  await expect(byId(page, 'plan-offer-requirement-page')).toBeVisible();
});

test('Confirm pressed twice plans once, and one page is saved', async ({ page }) => {
  await provisionSystemAccount();
  await page.goto('/dashboard');
  await openProjectThread(page);
  queueAsk(offering('Exports are not built yet.', REQUIREMENT));
  await ask(page, 'plan a CSV export for the board');
  const confirmed = posted(page, CONFIRM);
  await confirmButton(page)
    .click({ clickCount: 2, delay: 0 })
    .catch(() => undefined);
  expect((await confirmed).status()).toBe(200);
  await expect.poll(() => planEntries().length).toBe(1);
  await expect(byId(page, 'plan-offer-confirmed')).toBeVisible();
  expect(planEntries()).toHaveLength(1);
  expect(await pagesOf(seed.projectId)).toHaveLength(1);
  expect(await foldersOf(seed.projectId)).toHaveLength(1);
});

test('a typed yes after Confirm does not plan or save a second time', async ({ page }) => {
  const userId = seed.ctx.userId;
  await provisionSystemAccount();
  await page.goto('/dashboard');
  await openProjectThread(page);
  queueAsk(offering('Exports are not built yet.', REQUIREMENT));
  await ask(page, 'plan a CSV export for the board');
  const sessionId = (await openConversation(userId)).id;
  const confirmed = posted(page, CONFIRM);
  await confirmButton(page).click();
  expect((await confirmed).status()).toBe(200);
  await expect.poll(() => planEntries().length).toBe(1);
  await expect(byId(page, 'plan-offer-confirmed')).toBeVisible();

  queueAsk({
    intent: 'ask',
    answer: 'Already planning.',
    offerReply: {
      seq: (await latestAnswerRow(sessionId)).seq,
      kind: 'plan',
      decision: 'agree',
    },
  });
  await ask(page, 'yes, go ahead');
  expect(planEntries()).toHaveLength(1);
  expect(await pagesOf(seed.projectId)).toHaveLength(1);
  expect(await plansOf(sessionId)).toBe(1);
});

test('with Grill me on, the pane shows the requirement and no settled list', async ({ page }) => {
  await provisionSystemAccount();
  await page.goto('/dashboard');
  await openProjectThread(page);
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await grillSwitch(page).click();
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
  const firstTurn = sharpenTurnSettled(page);
  queueAsk(offering('Exports are not built yet.', REQUIREMENT));
  await ask(page, 'plan a CSV export for the board');
  expect((await firstTurn).outcome).toBe('settled');
  await expect(pane(page)).toContainText(REQUIREMENT.outcome!);
  await expect(byId(page, 'plan-offer-settled')).toHaveCount(0);
  await expect(confirmButton(page)).toBeVisible();
});

test('in Chinese, the pane, its headings and the saved-page line render from the zh catalogue', async ({
  page,
}) => {
  const zPane = zh.planningWorkspace.requirementPane;
  await provisionSystemAccount();
  await setReaderLanguage(page, seed.email, 'zh');
  await page.goto('/dashboard');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh', { timeout: FIRST_PAINT_MS });
  await openProjectThread(page, new RegExp(zh.shell.aiCallout.actions.ask.title));
  queueAsk(offering('导出目前尚未构建。', REQUIREMENT, '为项目规划一个导出功能。'));
  await composer(page).fill('为看板规划一个 CSV 导出');
  const settled = posted(page, SETTLE);
  await rail(page)
    .getByRole('button', { name: zh.planningWorkspace.conversation.send, exact: true })
    .click();
  expect((await settled).status()).toBe(200);
  await expect(pane(page, zPane.label)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(
    pane(page, zPane.label).getByRole('heading', { name: zPane.headings.outcome }),
  ).toBeVisible();
  await expect(pane(page, zPane.label).getByTestId('requirement-correction-hint')).toHaveText(
    zPane.correctionHint,
  );
  await expect(confirmButton(page)).toHaveText(zh.planningWorkspace.planOffer.confirm);
  // The offer copy the English catalogue draws is not on the page.
  await expect(rail(page)).not.toContainText(offerCopy.confirm);
});
