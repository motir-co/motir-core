// Acceptance E2E — on a waiting plan a small change is revised in place, a request too far
// from the plan is answered and kept, and once the plan is decided each kept request is
// offered as a new plan, one at a time (Story MOTIR-11515 · MOTIR-11524; design
// `design/ai-chat/plan-offer--after-decision.mock.html`).
//
// The receipt a person watches to accept the story, walking its Verification recipe:
//
//   THE RECORDED WALK (one test, seven chapters). A plan waits for a decision; a small
//   change gets one reply and the plan is held while it is revised, then comes back
//   `planned` with the added card and the new briefing; a far request gets one reply,
//   starts nothing and leaves Approve and Decline live; a second one is kept too;
//   Approve ends the conversation and offers the earlier request; accepting it starts a
//   new planning run from its requirement and offers the later one; declining that one
//   drops it.
//
//   THE REST (unrecorded). After Decline the kept request is still offered and accepting
//   it starts a run; a revise that changes nothing leaves the plan as it was; Approve
//   still succeeds when the offer cannot be made.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'). motir-ai is
// mocked UNDER the routes by `lib/test-ai-jobs-mock.ts`: the fixture declares each
// answer's verdict (`revision`, `farRequest`), and the spec plays motir-ai's side of a
// planning run and of a revision through the job-token doors (`_helpers/mid-run-seam.ts`).
// So this spec proves motir-core's side: what the conversation sends and stores, which
// jobs it submits, how the plan's status and decide panel move, and what the offers do.
// It asserts nothing about how many sessions motir-ai opened or which cards its final
// check walked — the motir-ai story gate owns that against the real revision handler.
// The real ask door, settle, decision doors, offer doors and Postgres all run; nothing is
// stubbed with `page.route` and nothing waits on a timer.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on an AUTHORITATIVE signal: a response armed before the action that
// causes it, a Postgres row, or the seam journal. An absence is asserted only AFTER a
// presence that proves the page got there. `beat()` and the chapter hold are pacing,
// taken after the assertion that proved the step.
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
import {
  appendAsAi,
  declareSeam,
  endRun,
  planOfRun,
  planRun,
  proposalTitles,
  queueAsk,
  submitsOf,
  type RunHandle,
} from './_helpers/mid-run-seam';
import { grantPaidAiPlanIfBilled } from './_helpers/billing';
import type { PlanJobOutcome } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 300_000 });

const afterCopy = en.planningWorkspace.planOffer.afterDecision;

// ── Locators ────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const composer = (page: Page) => rail(page).getByRole('textbox');
const sendButton = (page: Page) =>
  rail(page).getByRole('button', { name: en.planningWorkspace.conversation.send, exact: true });
const byId = (page: Page, id: string) => rail(page).getByTestId(id);
const confirmBar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
/** A decide verb that can be PRESSED — a held or absent one matches nothing. */
const liveVerb = (page: Page, name: 'Approve' | 'Decline') =>
  confirmBar(page).getByRole('button', { name, exact: true, disabled: false });
/** The plan offer panel carrying `requirement` as its request. */
const offerFor = (page: Page, requirement: string) =>
  byId(page, 'plan-offer').filter({
    has: page.getByTestId('plan-offer-request').filter({ hasText: requirement }),
  });

// ── Authoritative signals ───────────────────────────────────────────────────

const ASK = '/api/ai/ask';
const SETTLE = '/api/ai/ask/settle';
const CONFIRM = '/api/ai/plan-change/session/offer/confirm';
const DECLINE = '/api/ai/plan-change/session/offer/decline';
const pathOf = (r: Response) => new URL(r.url()).pathname;
const posted = (page: Page, pathname: string) =>
  page.waitForResponse((r) => pathOf(r) === pathname && r.request().method() === 'POST');

/** The `plan` jobs the server submitted — the planner's boundary, counted. */
const planSubmits = () => submitsOf('plan');
const askSubmits = () => submitsOf('ask_project');

// ── Persisted state (through the owner's client, so RLS cannot zero them) ───

const planRow = (planId: string) => adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
const planStatus = async (planId: string) => (await planRow(planId)).status;
/** The requests kept on the conversation while its plan waited, in the order asked. */
const keptRows = (sessionId: string) =>
  adminDb.planChangeTurn.findMany({
    where: { sessionId, role: 'user', farRequestRequirement: { not: null } },
    orderBy: { seq: 'asc' },
  });
const assistantTurnsWith = (sessionId: string, body: string) =>
  adminDb.planChangeTurn.count({ where: { sessionId, role: 'assistant', body } });
const sessionRow = (sessionId: string) =>
  adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });

// Every planning run is HELD in progress until the spec ends it — the first run, the
// revision, and the runs an accepted offer starts. Enough entries for one test.
const HELD: PlanJobOutcome[] = Array.from({ length: 8 }, () => ({ status: 'running' }));

// ── Steps ───────────────────────────────────────────────────────────────────

interface Waiting {
  run: RunHandle;
  planId: string;
  sessionId: string;
}

/**
 * Open the planning workspace from a card, start a run, and play motir-ai closing it
 * with two proposals and a briefing: the plan WAITS for a decision.
 */
async function planWaiting(page: Page, key: string, brief: string): Promise<Waiting> {
  const index = planSubmits().length;
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL((url) => url.searchParams.has('plan'));
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

  const submitted = page.waitForResponse(
    (r) => /\/api\/work-items\/[^/]+\/ai\/plan$/.test(pathOf(r)) && r.request().method() === 'POST',
  );
  await composer(page).fill('Plan the notifications digest.');
  await sendButton(page).click();
  expect((await submitted).status()).toBe(200);

  const run = planRun(index);
  const plan = await planOfRun(run.jobId);
  await appendAsAi(
    page,
    run,
    [
      { op: 'add', title: 'Notifications digest', kind: 'story' },
      { op: 'add', title: 'Digest schedule', kind: 'task' },
    ],
    { final: true, summary: brief },
  );
  endRun(index);
  await expect.poll(() => planStatus(plan.id)).toBe('planned');
  await expect(liveVerb(page, 'Approve')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(liveVerb(page, 'Decline')).toBeVisible();
  return { run, planId: plan.id, sessionId: plan.sessionId! };
}

/** Send a follow-up on the waiting plan: the ask door's 200, then the settle's body. */
async function send(page: Page, text: string): Promise<{ outcome?: string }> {
  const asked = posted(page, ASK);
  const settled = posted(page, SETTLE);
  await composer(page).fill(text);
  await sendButton(page).click();
  const askRes = await asked;
  expect(askRes.status(), await askRes.text()).toBe(200);
  const res = await settled;
  expect(res.status(), await res.text()).toBe(200);
  await expect(byId(page, 'conversation-user-turn').filter({ hasText: text })).toHaveCount(1);
  return (await res.json()) as { outcome?: string };
}

/** Keep one far request: one reply, no `plan` submit, the panel still live. */
async function keepFarRequest(
  page: Page,
  w: Waiting,
  typed: string,
  requirement: string,
  reply: string,
) {
  const plansBefore = planSubmits().length;
  queueAsk({ intent: 'ask', answer: reply, farRequest: { requirement } });
  expect((await send(page, typed)).outcome).toBe('answered');
  await expect(rail(page).getByText(reply)).toBeVisible();
  expect(await assistantTurnsWith(w.sessionId, reply)).toBe(1);
  expect(askSubmits().at(-1)?.waitingPlanId).toBe(w.planId);
  expect(planSubmits()).toHaveLength(plansBefore);
  expect(await planStatus(w.planId)).toBe('planned');
  await expect(liveVerb(page, 'Approve')).toBeVisible();
  await expect(liveVerb(page, 'Decline')).toBeVisible();
}

async function approve(page: Page, planId: string) {
  const approved = page.waitForResponse(
    (r) => pathOf(r) === `/api/plans/${planId}/approve` && r.request().method() === 'POST',
  );
  await liveVerb(page, 'Approve').click();
  expect((await approved).status()).toBe(200);
}

async function decline(page: Page, planId: string) {
  const declined = page.waitForResponse(
    (r) => pathOf(r) === `/api/plans/${planId}/decline` && r.request().method() === 'POST',
  );
  await liveVerb(page, 'Decline').click();
  await page
    .getByTestId('plan-decline-confirm')
    .getByRole('button', { name: en.approvalGate.planApproval.declineConfirm.proceed })
    .click();
  expect((await declined).status()).toBe(200);
}

/** Accept the live offer for `requirement`; returns the new conversation's id. */
async function acceptOffer(page: Page, decidedId: string, requirement: string) {
  const plansBefore = planSubmits().length;
  const confirmed = posted(page, CONFIRM);
  await offerFor(page, requirement).getByTestId('plan-offer-confirm').click();
  const res = await confirmed;
  expect(res.status(), await res.text()).toBe(200);
  const started = (await res.json()) as { sessionId: string; jobId: string };
  // ONE new ordinary planning run, for a plan of its own (no `planId`).
  await expect.poll(() => planSubmits().length).toBe(plansBefore + 1);
  expect(planSubmits().at(-1)?.planId).toBeUndefined();
  expect(started.sessionId).not.toBe(decidedId);
  const firstTurn = await adminDb.planChangeTurn.findFirstOrThrow({
    where: { sessionId: started.sessionId, role: 'user' },
    orderBy: { seq: 'asc' },
  });
  expect(firstTurn.body).toBe(requirement);
  // The decided conversation stays ended, and the offer reads confirmed with its link.
  expect((await sessionRow(decidedId)).endedAt).not.toBeNull();
  await expect(offerFor(page, requirement).getByTestId('plan-offer-confirmed')).toBeVisible();
  await expect(
    offerFor(page, requirement).getByTestId('plan-offer-started-elsewhere').getByRole('link'),
  ).toBeVisible();
  return started.sessionId;
}

let seed: AiAugmentReplanSeed;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  declareSeam({ ask: [], plan: HELD });
  seed = await seedAiAugmentReplan(`far-request-${Date.now()}@example.com`);
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

// ═══ The recorded walk ═══════════════════════════════════════════════════════

const BRIEF = 'A daily digest of notifications, sent on a schedule.';
const BRIEF_REVISED = 'A daily digest of notifications, sent on a schedule, with an opt-out.';
const CHANGE = 'also let people opt out of the digest';
const CHANGE_REPLY = 'I’m revising the plan to add an opt-out for the digest.';
const RESTATED = 'Add a card that lets a person opt out of the notifications digest.';
const FAR_A = 'Plan a new billing epic with invoices and refunds.';
const FAR_B = 'Plan a Slack integration for project alerts.';

test('On a waiting plan a change is revised in place, far requests are kept, and offered once the plan is approved', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11515');
  let w!: Waiting;
  let newSession = '';

  // ── 1 · A PLAN WAITS ──────────────────────────────────────────────────────
  await chapter('A plan waits for a decision, with Approve and Decline live', async () => {
    w = await planWaiting(page, seed.loginKey, BRIEF);
    expect(await proposalTitles(w.planId)).toEqual(['Notifications digest', 'Digest schedule']);
    await expect(byId(page, 'plan-change-briefing')).toContainText(BRIEF);
    await beat();
  });

  // ── 2 · A SMALL CHANGE IS REVISED IN PLACE ────────────────────────────────
  await chapter(
    'A small change gets one reply, and the plan is held while it is revised',
    async () => {
      queueAsk({
        intent: 'plan_change',
        answer: CHANGE_REPLY,
        revision: { requirement: RESTATED },
      });
      expect((await send(page, CHANGE)).outcome).toBe('redirected');
      await expect(rail(page).getByText(CHANGE_REPLY)).toBeVisible();
      expect(await assistantTurnsWith(w.sessionId, CHANGE_REPLY)).toBe(1);
      // The turn was asked against the waiting plan, and ONE revision of THAT plan followed.
      expect(askSubmits().at(-1)?.waitingPlanId).toBe(w.planId);
      await expect.poll(() => planSubmits().length).toBe(2);
      expect(planSubmits()[1]?.planId).toBe(w.planId);
      // The revision carries the planner's restatement, never the rewrite of every turn.
      const system = await adminDb.planChangeTurn.findMany({
        where: { sessionId: w.sessionId, role: 'system' },
      });
      expect(system.some((t) => t.body === RESTATED)).toBe(true);
      expect(system.some((t) => t.body.includes('Plan change requested'))).toBe(false);
      // Held: the plan is being written again, and nothing can be decided.
      await expect.poll(() => planStatus(w.planId)).toBe('generating');
      await expect(liveVerb(page, 'Approve')).toHaveCount(0);
      await expect(liveVerb(page, 'Decline')).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'The revision closes: the plan is back, with the added card and the new briefing',
    async () => {
      const revision = planRun(1);
      await appendAsAi(page, revision, [{ op: 'add', title: 'Digest opt-out', kind: 'task' }], {
        final: true,
        revision: true,
        summary: BRIEF_REVISED,
      });
      endRun(1);
      await expect.poll(() => planStatus(w.planId)).toBe('planned');
      await expect(liveVerb(page, 'Approve')).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(liveVerb(page, 'Decline')).toBeVisible();
      expect(await proposalTitles(w.planId)).toEqual(
        expect.arrayContaining(['Notifications digest', 'Digest schedule', 'Digest opt-out']),
      );
      expect((await planRow(w.planId)).summary).toBe(BRIEF_REVISED);
      await expect(byId(page, 'plan-change-briefing')).toContainText(BRIEF_REVISED);
      await expect(workspace(page).getByText('Digest opt-out').first()).toBeVisible();
      await beat();
    },
  );

  // ── 3 · FAR REQUESTS ARE ANSWERED AND KEPT ────────────────────────────────
  await chapter(
    'A request too far from the plan is answered and kept; nothing starts',
    async () => {
      await keepFarRequest(
        page,
        w,
        'also plan a new billing epic',
        FAR_A,
        'That is better planned on its own. I’ll offer it once you decide this plan.',
      );
      const kept = await keptRows(w.sessionId);
      expect(kept.map((r) => [r.body, r.farRequestRequirement])).toEqual([
        ['also plan a new billing epic', FAR_A],
      ]);
      // No offer exists while the plan waits.
      await expect(byId(page, 'plan-offer')).toHaveCount(0);
      await beat();
    },
  );

  await chapter('A second far request is kept too, in the order asked', async () => {
    await keepFarRequest(
      page,
      w,
      'and a Slack integration',
      FAR_B,
      'A Slack integration is its own plan too. I’ve kept it for after your decision.',
    );
    const kept = await keptRows(w.sessionId);
    expect(kept.map((r) => r.farRequestRequirement)).toEqual([FAR_A, FAR_B]);
    expect(kept[0]!.seq).toBeLessThan(kept[1]!.seq);
    await beat();
  });

  // ── 4 · APPROVE OFFERS THE EARLIER REQUEST ────────────────────────────────
  await chapter('Approve ends the conversation and offers the earlier request', async () => {
    await approve(page, w.planId);
    expect(await planStatus(w.planId)).toBe('approved');
    await expect(byId(page, 'planning-session-end')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(offerFor(page, FAR_A)).toBeVisible();
    await expect(byId(page, 'plan-offer-after-decision-lead').first()).toHaveText(afterCopy.lead);
    await expect(byId(page, 'plan-offer-after-decision-cue')).toContainText('1 of 2');
    // ONE offer at a time: the later request is not offered yet.
    await expect(byId(page, 'plan-offer')).toHaveCount(1);
    await expect(offerFor(page, FAR_B)).toHaveCount(0);
    await beat();
  });

  // ── 5 · ACCEPTING STARTS A NEW PLANNING RUN ───────────────────────────────
  await chapter(
    'Accepting it starts a new planning run, and the next request is offered',
    async () => {
      newSession = await acceptOffer(page, w.sessionId, FAR_A);
      await expect(offerFor(page, FAR_B)).toBeVisible();
      await expect(offerFor(page, FAR_B).getByTestId('plan-offer-confirm')).toBeEnabled();
      expect(newSession).toBeTruthy();
      await beat();
    },
  );

  // ── 6 · DECLINING DROPS IT ────────────────────────────────────────────────
  await chapter('Declining the other one drops it, and nothing is planned for it', async () => {
    const plansBefore = planSubmits().length;
    const declined = posted(page, DECLINE);
    await offerFor(page, FAR_B).getByTestId('plan-offer-decline').click();
    expect((await declined).status()).toBe(200);
    await expect(offerFor(page, FAR_B).getByTestId('plan-offer-declined')).toBeVisible();
    await expect(offerFor(page, FAR_B).getByTestId('plan-offer-confirm')).toHaveCount(0);
    expect(planSubmits()).toHaveLength(plansBefore);
    const kept = await keptRows(w.sessionId);
    expect(kept.every((r) => r.farRequestConsumedAt !== null)).toBe(true);
    // Nothing more is offered.
    await expect(byId(page, 'plan-offer')).toHaveCount(2);
    await beat();
  });
});

// ═══ The rest (unrecorded) ═══════════════════════════════════════════════════

test('after Decline the kept request is still offered, and accepting it starts a run', async ({
  page,
}) => {
  const w = await planWaiting(page, seed.loginKey, BRIEF);
  await keepFarRequest(page, w, 'also plan a new billing epic', FAR_A, 'Kept for later.');

  await decline(page, w.planId);

  expect(await planStatus(w.planId)).toBe('declined');
  await expect(byId(page, 'planning-session-end')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(offerFor(page, FAR_A)).toBeVisible();
  await expect(byId(page, 'plan-offer')).toHaveCount(1);
  await acceptOffer(page, w.sessionId, FAR_A);
});

test('a revise that changes nothing leaves the plan exactly as it was', async ({ page }) => {
  const w = await planWaiting(page, seed.loginKey, BRIEF);
  const titles = await proposalTitles(w.planId);

  queueAsk({
    intent: 'plan_change',
    answer: 'Checking the plan against that.',
    revision: { requirement: 'Keep the plan as it is.' },
  });
  expect((await send(page, 'keep it as is')).outcome).toBe('redirected');
  await expect.poll(() => planSubmits().length).toBe(2);
  await expect.poll(() => planStatus(w.planId)).toBe('generating');
  await appendAsAi(page, planRun(1), [], { final: true, revision: true });
  endRun(1);

  await expect.poll(() => planStatus(w.planId)).toBe('planned');
  await expect(liveVerb(page, 'Approve')).toBeVisible({ timeout: FIRST_PAINT_MS });
  expect(await proposalTitles(w.planId)).toEqual(titles);
  expect((await planRow(w.planId)).summary).toBe(BRIEF);
});

test('Approve succeeds, and the plan reads approved, when the offer cannot be made', async ({
  page,
}) => {
  const w = await planWaiting(page, seed.loginKey, BRIEF);
  await keepFarRequest(page, w, 'also plan a new billing epic', FAR_A, 'Kept for later.');
  // A MALFORMED kept request: the step that makes the offer has nothing it can offer.
  const [kept] = await keptRows(w.sessionId);
  await adminDb.planChangeTurn.update({
    where: { id: kept!.id },
    data: { farRequestRequirement: '' },
  });

  await approve(page, w.planId);

  expect(await planStatus(w.planId)).toBe('approved');
  await expect(byId(page, 'planning-session-end')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(confirmBar(page)).toHaveCount(0);
  await expect(workspace(page).getByRole('alert')).toHaveCount(0);
  await expect(byId(page, 'plan-offer')).toHaveCount(0);
});
