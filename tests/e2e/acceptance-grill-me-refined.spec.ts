// Acceptance E2E — Refine Grill me (Story MOTIR-11799 · Subtask MOTIR-11806; design
// `design/ai-chat/grill-me--switch-confirm-and-reopen.mock.html`). The receipt a person
// watches to accept the story:
//
//   THE RECORDED WALK. Grill me on: a request with open decisions is questioned and NO
//   requirement is written before the questions, and the switch is still on after a
//   reload (it is stored on the conversation). Switching Grill me off while a question
//   is open asks first — Keep grilling changes nothing; "Stop and write it" writes the
//   requirement from the answer given. Switching Grill me on with that requirement shown
//   grills it again, asking only what it leaves open, and the left pane shows it updated.
//   Switching on once more, with nothing left to ask, leaves it exactly as it was.
//
//   THE REST (unrecorded). Grill me off for the whole conversation: one read, then the
//   offer with its requirement, as before.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts. motir-ai is mocked UNDER the routes: the
// read by `lib/test-ai-jobs-mock.ts` (the fixture writes each answer's offer — with Grill
// me on, the read's hand-off), and the grilling turns by `lib/test-sharpen-mock.ts` from
// a SCRIPT, mirroring motir-ai's MOTIR-11803 (a hand-off's grilling always ends with a
// requirement; one over the hand-off with the switch off ends as a Stop) and MOTIR-11804
// (over a written requirement, a question it settled is never asked). Which question the
// real planner asks is motir-ai's to prove. The real ask door, Sharpen door and settle,
// the stored switch, the offer landing and Postgres all run; nothing is stubbed with
// `page.route`.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal armed before the action that causes it —
// the ask door and its settle, the settle that stored a grilling turn, the switch's own
// PATCH — or a Postgres row. An absence (no requirement, no Confirm, no banner) is
// asserted only after the thing that would have drawn it is visible. `beat()` and the
// chapter hold are pacing, taken after the assertion that proved the step.
import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import { declareSeam, queueAsk } from './_helpers/mid-run-seam';
import { grantPaidAiPlanIfBilled } from './_helpers/billing';
import {
  Q1,
  Q2,
  declareSharpen,
  grillSwitch,
  question,
  readSharpen,
  readingButton,
  sharpenTurnSettled,
  thread,
} from './_helpers/grill-me-journey';
import type { AskJobOutcome } from '@/lib/test-ai-jobs-mock';
import type { SharpenTargetFixture } from '@/lib/test-sharpen-mock';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 300_000 });

const grillCopy = en.planningWorkspace.grill;
const sharpenCopy = en.sharpen;

// ── Locators ────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const sendButton = (page: Page) =>
  rail(page).getByRole('button', { name: en.planningWorkspace.conversation.send, exact: true });
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI', exact: true });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const byId = (page: Page, id: string) => rail(page).getByTestId(id);
const confirmButton = (page: Page) => byId(page, 'plan-offer-confirm');
const heldNotice = (page: Page) => byId(page, 'plan-offer-held');
/** The requirement the person reads before Confirm — the left pane. */
const requirementDoc = (page: Page) => workspace(page).getByTestId('requirement-document');
const paneBanner = (page: Page, state: 'updating' | 'updated') =>
  workspace(page).getByTestId(`requirement-pane-${state}`);
/** The switch-off confirmation (MOTIR-11802), portalled over the overlay. */
const offDialog = (page: Page) =>
  page.getByRole('alertdialog', { name: grillCopy.offConfirm.title });
const answerLine = (q: { text: string }, label: string) => `${q.text} — ${label}`;

const overlayOpen = (url: URL) => url.searchParams.has('plan');

// ── Authoritative signals ───────────────────────────────────────────────────

const ASK = '/api/ai/ask';
const SETTLE = '/api/ai/ask/settle';
const pathOf = (r: Response) => new URL(r.url()).pathname;
const posted = (page: Page, pathname: string) =>
  page.waitForResponse((r) => pathOf(r) === pathname && r.request().method() === 'POST');
/** The switch's own write — it is stored on the conversation (MOTIR-11801). */
const switchStored = (page: Page) =>
  page.waitForResponse(
    (r) => /\/grill-me$/.test(pathOf(r)) && r.request().method() !== 'GET' && r.ok(),
  );

/** The grilling turns the Sharpen seam played over a CONVERSATION. */
const conversationSubmits = () =>
  (readSharpen().submitted ?? []).filter((s) => s.context?.scope.kind === 'conversation');

async function openConversation(userId: string) {
  return adminDb.planChangeSession.findFirstOrThrow({
    where: { createdById: userId, endedAt: null, origin: 'conversation' },
    orderBy: { createdAt: 'desc' },
  });
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function openProjectThread(page: Page) {
  await expect(orb(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await orb(page).click();
  await calloutPanel(page)
    .getByRole('link', { name: /Ask about this project/ })
    .click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

/** Send a turn on the project thread: the ask door's 200, then the settle's 200. */
async function ask(page: Page, text: string) {
  const asked = posted(page, ASK);
  const settled = posted(page, SETTLE);
  await composer(page).fill(text);
  await sendButton(page).click();
  const askRes = await asked;
  expect(askRes.status(), await askRes.text()).toBe(200);
  const res = await settled;
  expect(res.status(), await res.text()).toBe(200);
  await expect(rail(page).getByText(text).first()).toBeVisible();
}

/** One grilling act — a click — and the stored turn it produced. */
async function act(page: Page, press: ReturnType<Page['getByTestId']>) {
  const settled = sharpenTurnSettled(page);
  await press.click();
  return settled;
}

const REQUEST = 'plan an export for the board';
const READ_ANSWER = 'The board has no export today; who starts it and what it carries are open.';
const REQUEST_TEXT = 'Plan a CSV export of the board.';

/** With Grill me on, the read writes no requirement: it hands the offer to the grilling. */
const handingOff = (answer: string, requestText: string): AskJobOutcome => ({
  intent: 'ask',
  answer,
  offer: { kind: 'plan', requestText, deferred: true, handoff: { items: [], code: [] } },
});

/** Two open decisions: who starts the export, and which columns it carries. */
const SCRIPT: SharpenTargetFixture = { mode: 'scripted', questions: [Q1, Q2] };

let seed: AiAugmentReplanSeed;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  declareSeam({ ask: [], plan: [{ status: 'running' }, {}] });
  declareSharpen(SCRIPT);
  seed = await seedAiAugmentReplan(`grill-refined-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const workspaceRow = await adminDb.workspace.findUniqueOrThrow({
    where: { id: seed.ctx.workspaceId },
  });
  // Grilling SPENDS credits: on this cloud-on lane an org the billing fixture does not
  // name reads as free and out of credits.
  if (workspaceRow.organizationId) grantPaidAiPlanIfBilled(workspaceRow.organizationId);
  await signIn(page, seed.email, seed.password);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('Refine Grill me — questions before any requirement, switching off asks first and writes it, switching on again asks only what it leaves open', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11799');
  const userId = seed.ctx.userId;
  const picked1 = Q1.readings[0]!;
  const picked2 = Q2.readings[1]!;
  let conversationId = '';

  // ── 1 · ASKED BEFORE ANY REQUIREMENT ──────────────────────────────────────
  await chapter(
    'Grill me on — the request is questioned, and no requirement is written yet',
    async () => {
      await page.goto('/dashboard');
      await openProjectThread(page);
      await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
      // No conversation exists yet: the choice rides the first message, and is stored then.
      await grillSwitch(page).click();
      await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
      await beat();

      const firstTurn = sharpenTurnSettled(page);
      queueAsk(handingOff(READ_ANSWER, REQUEST_TEXT));
      await ask(page, REQUEST);
      expect((await firstTurn).outcome).toBe('settled');
      await expect(question(page)).toContainText(Q1.text);
      await expect(heldNotice(page)).toBeVisible();
      // The question is up, so the absence is not vacuous: no requirement, no Confirm.
      await expect(requirementDoc(page)).toHaveCount(0);
      await expect(confirmButton(page)).toHaveCount(0);
      conversationId = (await openConversation(userId)).id;
      expect((await openConversation(userId)).grillMe).toBe(true);
      await beat();

      // A reload keeps both: the switch is stored, the grilling resumes where it was.
      await page.reload();
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(question(page)).toContainText(Q1.text, { timeout: FIRST_PAINT_MS });
      await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
      await expect(requirementDoc(page)).toHaveCount(0);
      await beat();
    },
  );

  // ── 2 · SWITCHING OFF ASKS FIRST ──────────────────────────────────────────
  await chapter(
    'One answer, then switching off asks first — Keep grilling changes nothing',
    async () => {
      await act(page, readingButton(page, picked1.id));
      await expect(question(page)).toContainText(Q2.text);
      const turnsBefore = conversationSubmits().length;
      await beat();

      await grillSwitch(page).click();
      await expect(offDialog(page)).toBeVisible();
      await expect(offDialog(page)).toContainText(
        'writes the requirement from the 1 answer you settled',
      );
      // The switch reads on until Confirm. The modal hides the rail from assistive tech
      // while it is open, so the switch is read with the hidden tree included.
      await expect(
        page
          .getByRole('complementary', { name: 'Motir AI', includeHidden: true })
          .getByTestId('grill-me-toggle')
          .getByRole('switch', { includeHidden: true }),
      ).toHaveAttribute('aria-checked', 'true');
      await beat();

      await offDialog(page).getByTestId('grill-off-keep').click();
      await expect(offDialog(page)).toHaveCount(0);
      await expect(question(page)).toContainText(Q2.text);
      await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'true');
      expect(conversationSubmits()).toHaveLength(turnsBefore);
      expect((await openConversation(userId)).grillMe).toBe(true);
      await beat();
    },
  );

  // ── 3 · CONFIRM WRITES THE REQUIREMENT ────────────────────────────────────
  await chapter('Stop and write it — the requirement appears with the answer given', async () => {
    await grillSwitch(page).click();
    await expect(offDialog(page)).toBeVisible();
    const stopped = sharpenTurnSettled(page);
    await offDialog(page).getByTestId('grill-off-confirm').click();
    expect((await stopped).outcome).toBe('settled');
    await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(thread(page)).toContainText(sharpenCopy.conversation.switchedOff);
    await expect(requirementDoc(page)).toContainText(answerLine(Q1, picked1.label));
    await expect(confirmButton(page)).toBeVisible();
    await expect(heldNotice(page)).toHaveCount(0);
    expect((await openConversation(userId)).grillMe).toBe(false);
    await beat();
  });

  // ── 4 · ON AGAIN OVER THE REQUIREMENT ─────────────────────────────────────
  await chapter(
    'Grill me on again — it asks only what the requirement leaves open, then updates it',
    async () => {
      const firstTurn = sharpenTurnSettled(page);
      await grillSwitch(page).click();
      expect((await firstTurn).outcome).toBe('settled');
      // Q1 is in the requirement, so the grilling opens on what it leaves open.
      await expect(question(page)).toContainText(Q2.text);
      await expect(thread(page).getByTestId('sharpen-opening')).toHaveText(
        grillCopy.overRequirement.opening,
      );
      await expect(paneBanner(page, 'updating')).toHaveText(grillCopy.overRequirement.paneUpdating);
      // The requirement stays readable under the banner while it is grilled.
      await expect(requirementDoc(page)).toContainText(answerLine(Q1, picked1.label));
      await expect(confirmButton(page)).toHaveCount(0);
      const asked = conversationSubmits().at(-1)!.context;
      expect(asked.action).toBe('start');
      expect(asked.conversation?.offer?.requirement).toBeTruthy();
      await beat();

      await act(page, readingButton(page, picked2.id));
      await expect(rail(page).getByTestId('grill-requirement-updated')).toHaveText(
        grillCopy.overRequirement.updated,
      );
      await expect(paneBanner(page, 'updated')).toHaveText(grillCopy.overRequirement.paneUpdated);
      await expect(requirementDoc(page)).toContainText(answerLine(Q2, picked2.label));
      await expect(requirementDoc(page)).toContainText(answerLine(Q1, picked1.label));
      await expect(confirmButton(page)).toBeVisible();
      await beat();
    },
  );

  // ── 5 · NOTHING LEFT TO ASK ───────────────────────────────────────────────
  await chapter(
    'On once more, with nothing left to ask — the requirement stays as it is',
    async () => {
      // Nothing is open, so switching off asks nothing.
      const off = switchStored(page);
      await grillSwitch(page).click();
      await off;
      await expect(offDialog(page)).toHaveCount(0);
      await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
      const before = await requirementDoc(page).textContent();

      const ended = sharpenTurnSettled(page);
      await grillSwitch(page).click();
      const end = await ended;
      expect(end.session.endReason).toBe('nothing_to_ask');
      await expect(rail(page).getByTestId('sharpen-nothing-to-ask')).toHaveText(
        grillCopy.overRequirement.nothingLeft,
      );
      await expect(confirmButton(page)).toBeVisible();
      await expect(paneBanner(page, 'updated')).toHaveCount(0);
      await expect(paneBanner(page, 'updating')).toHaveCount(0);
      expect(await requirementDoc(page).textContent()).toBe(before);
      expect(await adminDb.plan.count({ where: { sessionId: conversationId } })).toBe(0);
      await beat();
    },
  );
});

// ═══ The rest (unrecorded) ═══════════════════════════════════════════════════

test('with Grill me off for the whole conversation: one read, then the offer with its requirement', async ({
  page,
}) => {
  const REQUIREMENT = {
    outcome: 'Members take the board elsewhere as a CSV file.',
    behaviour: 'Export from the board menu.',
    scopeEdge: '',
    constraints: '',
    acceptance: 'A CSV downloads with the visible columns.',
  };
  await page.goto('/dashboard');
  await openProjectThread(page);
  await expect(grillSwitch(page)).toHaveAttribute('aria-checked', 'false');
  queueAsk({
    intent: 'ask',
    answer: READ_ANSWER,
    offer: { kind: 'plan', requestText: REQUEST_TEXT, immediate: false, requirement: REQUIREMENT },
  });
  await ask(page, REQUEST);
  await expect(confirmButton(page)).toBeVisible();
  await expect(requirementDoc(page)).toContainText(REQUIREMENT.outcome);
  await expect(heldNotice(page)).toHaveCount(0);
  await expect(question(page)).toHaveCount(0);
  expect(conversationSubmits()).toHaveLength(0);
});
