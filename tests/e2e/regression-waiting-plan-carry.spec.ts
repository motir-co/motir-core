// Acceptance E2E — a waiting plan whose session has ended KEEPS its conversation
// (Subtask MOTIR-7934, Story MOTIR-7928; `agent-authored-plans.md` AMENDMENT 23 §6
// as amended by MOTIR-7931).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Plan something new leaves a plan waiting under a Closed session. Waiting on you
// still lists it; opening it shows the Closed thread, the plan with Approve and
// Decline, and a chatbox. The first turn carries the plan and the conversation
// into a new session — the overlay switches to it in place — and the Plans list
// shows that session holding ONE plan, and no longer the first, which holds none.
// The planner's answer to that turn, and to the next one, REVISES the same plan
// rather than opening a second, and the plan approves. Then, on a fresh card, a
// plan whose work was finished elsewhere is said in words naming that work item,
// with Plan it again, and Plan it again starts exactly one fresh plan in the same
// conversation.
//
// The unrecorded tests cover the rest: another member reads the plan with no
// chatbox, a take-back lands the turn in the open session, zh renders, and a
// failed session with no waiting plan still offers Start a new session.
//
// ── THE SEAMS, PER BOUNDARY (read from `playwright.acceptance.config.ts`) ────
//
// • THE JOBS MOCK — `lib/test-ai-jobs-mock.ts`, an undici intercept the Next
//   SERVER installs in itself from `instrumentation.ts` because the lane's
//   `webServer.env` sets `E2E_TEST_AI_JOBS=1`. A `plan` job settles as a plain
//   success and WRITES NO PROPOSALS, so it cannot revise a plan by itself. Every
//   `plan` submit it accepts is recorded with its `jobId` and the envelope's
//   `readBackToken` (MOTIR-7809) — the carried turn's submit and each later one.
// • THE FIXTURE PATH — `MOTIR_AI_JOBS_FIXTURE_PATH`, set in the same env block and
//   re-read by the mock on every request; this spec writes it in `beforeEach`.
// • THE CALLBACK SECRET — `CORE_CALLBACK_SECRET`, set there to
//   `E2E_CORE_CALLBACK_SECRET` (`_helpers/log-bug-as-ai.ts`), the ai → core bearer.
// • THE JOB-TOKEN ROUTE — `POST /api/internal/ai/plan-proposals`, the door motir-ai
//   itself writes proposals through. The spec plays the planner there, with the
//   bearer above and the job's own `x-motir-job-token`. A REVISION's answer carries
//   `revision: true, final: true`: `revision` gates the append on the editable pair
//   and makes `final` RELEASE the revision lease (`appendProposals` →
//   `releaseRevisionLease`) instead of marking the plan `planned`, and the route
//   resolves the plan by the job's `sourceJobId`, which the revise re-pointed. A
//   NEW plan's answer (case 12's `R`) omits `revision`, so its `final` marks it
//   `planned`. No proposal is ever written into the database by hand.
// • THE DRIFT CONSUMER — `E2E_JOB_WORKER=1` in the same env block makes the lane's
//   `globalSetup` start the job worker bundle (`.worker/worker.mjs`), whose
//   registry runs `planDriftOnTransitioned` on `work-item/transitioned`. Case 12's
//   work item is moved to Done through the item page's own status control, and
//   the spec waits on the DATABASE until that consumer has marked the plan
//   `stale`; nothing writes `stale` by hand.
//
// ── SEEDING ─────────────────────────────────────────────────────────────────
//
// Every plan is finished by the shipped services a real run's handler calls
// (`addProposals` → `markPlanned`), so each gate is real. The unrecorded cases end
// their sessions through the shipped end operation (`planSessionEndService.endSession`,
// the one `restart` itself calls). ONE write has no service door and is made by
// hand, with a comment where it is made: case 9 routes an existing `plan_approval`
// gate to the second member.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a turn's
// text, a `waitForURL`, a database read or the response of a request armed before
// the click. Nothing waits on a timeout. `beat()` and the chapter hold are PACING
// only, each taken after the assertion that already proved the state.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { finishSessionPlan, latestPlanningSession } from './_helpers/planChangeConversation';
import { E2E_CORE_CALLBACK_SECRET } from './_helpers/log-bug-as-ai';
import { plansService } from '@/lib/services/plansService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 360_000 });

const session = en.planningWorkspace.session;
const surface = en.approvalGate.planApproval.surface;

// ── Locators ─────────────────────────────────────────────────────────────────

// `planningWorkspace.canvasAria` in either locale (case 11 reads it in zh).
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan|的计划/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
// Either locale's Send: the stale chapter sends a turn in zh.
const sendButton = (page: Page) =>
  rail(page).getByRole('button', {
    name: new RegExp(
      `^(${en.planningWorkspace.conversation.send}|${zh.planningWorkspace.conversation.send})$`,
    ),
  });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
const byTestId = (page: Page, id: string) => rail(page).getByTestId(id);

const restartControl = (page: Page) => byTestId(page, 'planning-restart-control');
const restartConfirm = (page: Page) => byTestId(page, 'planning-restart-confirm');
const endMarker = (page: Page) => byTestId(page, 'planning-session-end');
const carryGloss = (page: Page) => byTestId(page, 'planning-carry-gloss');
const startSlot = (page: Page) => byTestId(page, 'planning-session-ended');
const copiedDivider = (page: Page) => byTestId(page, 'planning-copied-divider');
const planMoved = (page: Page) => byTestId(page, 'planning-plan-moved');
const takenBack = (page: Page) => byTestId(page, 'planning-taken-back');
const takenBackWaiting = (page: Page) => byTestId(page, 'planning-taken-back-waiting');
const readOnly = (page: Page) => byTestId(page, 'planning-read-only');
const staleNotice = (page: Page) => byTestId(page, 'planning-stale-plan');
const planAgain = (page: Page) => byTestId(page, 'planning-plan-again');

const approvalRows = (page: Page) =>
  page.getByRole('table', { name: en.workbench.tabs.toApprove }).getByTestId(/^approval-row-/);
// Either locale's name: case 11 opens the Plans list in zh.
const sessionsList = (page: Page) =>
  page.getByRole('list', {
    name: new RegExp(`^(${en.aiPlanning.sessions.listAria}|${zh.aiPlanning.sessions.listAria})$`),
  });
const sessionRowOf = (page: Page, id: string) => page.locator(`[data-session-row="${id}"]`);

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');
const onSession = (id: string) => (url: URL) => url.searchParams.get('planSession') === id;

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

interface RecordedJob {
  kind: string;
  jobId?: string;
  readBackToken?: string;
}

function declareJobs(plan: Array<{ status: 'succeeded' | 'failed' }> = []): void {
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ ask: [], plan, submitted: [] }, null, 2));
}

/** The token the mock recorded for THIS job's submit — the one motir-ai would hold. */
function tokenFor(jobId: string): string {
  const fixture = JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as { submitted?: RecordedJob[] };
  const job = (fixture.submitted ?? []).find((s) => s.kind === 'plan' && s.jobId === jobId);
  if (!job?.readBackToken) {
    throw new Error(`the jobs mock recorded no plan submit with a token for ${jobId}`);
  }
  return job.readBackToken;
}

/**
 * PLAY THE PLANNER for one job: one `add`, appended through the job-token route
 * exactly as motir-ai would. `revision: true` answers a revise (and releases its
 * lease); without it, the final append marks a new plan `planned`.
 */
async function answerAsPlanner(
  page: Page,
  jobId: string,
  title: string,
  opts: { revision: boolean },
): Promise<void> {
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': tokenFor(jobId),
    },
    data: {
      jobId,
      proposals: [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      final: true,
      ...(opts.revision ? { revision: true } : {}),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
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

async function useLocale(page: Page, locale: 'zh' | 'en'): Promise<void> {
  // Scoped to the SITE root, so it reaches every route.
  await page
    .context()
    .addCookies([{ name: 'NEXT_LOCALE', value: locale, url: new URL('/', page.url()).href }]);
}

// ── Persisted state ──────────────────────────────────────────────────────────

const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const turnsOf = (sessionId: string) =>
  adminDb.planChangeTurn.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
const plansIn = (sessionId: string) => adminDb.plan.count({ where: { sessionId } });
const trail = (planId: string, changeKind: string) =>
  adminDb.planRevision.findMany({ where: { planId, changeKind }, orderBy: { changedAt: 'asc' } });
const diffJobId = (row: { diff: unknown }) => (row.diff as { jobId?: string } | null)?.jobId;

async function cardOf(key: string) {
  return adminDb.workItem.findFirstOrThrow({
    where: { identifier: key },
    select: { id: true, status: true, title: true },
  });
}

async function scopeSessions(scopeKey: string): Promise<number> {
  return adminDb.planChangeSession.count({ where: { scopeKey } });
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

/** A turn's submit, whichever door the rail is on: a card's anchored door or the
 *  session's own submit. Armed BEFORE the click by the caller. */
const isTurnSubmit = (r: Response) =>
  r.request().method() === 'POST' &&
  (/\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) ||
    new URL(r.url()).pathname === '/api/ai/plan-change/session/submit');

/** Type and send; resolves with the turn-submit response. */
async function sendTurn(page: Page, text: string): Promise<Response> {
  const sent = page.waitForResponse(isTurnSubmit);
  await composer(page).fill(text);
  await sendButton(page).click();
  const res = await sent;
  await expect(rail(page).getByText(text).first()).toBeVisible();
  return res;
}

/** Plan something new, confirmed — the control's confirm turn, then the restart. */
async function planSomethingNew(page: Page): Promise<{ fresh: string }> {
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
  const body = (await res.json()) as { session: { id: string } };
  return { fresh: body.session.id };
}

/** Waiting on you → the row naming this card → Review. */
async function openFromWaitingOnYou(page: Page, cardKey: string): Promise<void> {
  await page.goto('/workbench?tab=approvals');
  const row = approvalRows(page).filter({ hasText: cardKey });
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await row.getByRole('button', { name: en.workbench.approvals.review, exact: true }).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

async function openPlans(page: Page): Promise<void> {
  await page.goto('/plans');
  await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** A Plans row → its conversation in the overlay. */
async function openSessionFromPlans(page: Page, sessionId: string, firstTurn: string) {
  await openPlans(page);
  await sessionRowOf(page, sessionId).getByRole('link', { name: firstTurn }).click();
  await page.waitForURL(onSession(sessionId));
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** Move a work item through the item page's own status control. */
async function moveStatus(page: Page, key: string, label: string, to: string): Promise<void> {
  await page.goto(`/items/${key}`);
  const main = page.getByRole('main');
  await main
    .getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true })
    .click({ timeout: FIRST_PAINT_MS });
  await main.getByRole('combobox', { name: en.issueViews.status, exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
  await expect.poll(async () => (await cardOf(key)).status, { timeout: 30_000 }).toBe(to);
}

/** A conversation's plan finished with a MODIFY of `workItemId` — the shipped
 *  services the handler calls, as {@link finishSessionPlan} does for an add. */
async function finishWithModify(sessionId: string, workItemId: string): Promise<string> {
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
  });
  const s = await sessionRow(sessionId);
  const ctx = { userId: s.createdById!, workspaceId: s.workspaceId };
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId, patch: { title: 'Ship the import behind a flag' } }],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);
  return plan.id;
}

/** The shipped end operation, signed by the owner — what `restart` itself calls. */
async function endRestarted(sessionId: string): Promise<void> {
  const s = await sessionRow(sessionId);
  const out = await planSessionEndService.endSession(sessionId, 'restarted', {
    workspaceId: s.workspaceId,
    endedById: s.createdById,
    actorId: s.createdById!,
  });
  expect(out.ended).toBe(true);
}

/** A planned plan on `cardKey`, its session ended `restarted`: situation 1. */
async function seedWaitingPlan(
  page: Page,
  email: string,
  cardKey: string,
  ask: string,
  proposal: string,
): Promise<{ sessionId: string; planId: string }> {
  await openFromCard(page, cardKey);
  expect((await sendTurn(page, ask)).status()).toBe(200);
  const s = await latestPlanningSession(email);
  await closeOverlay(page);
  const planId = await finishSessionPlan(s.id, proposal);
  await endRestarted(s.id);
  return { sessionId: s.id, planId };
}

async function addSecondMember(seed: { projectKey: string }, ownerEmail: string) {
  const owner = await latestPlanningSession(ownerEmail);
  const project = await adminDb.project.findFirstOrThrow({
    where: { identifier: seed.projectKey },
  });
  const mateEmail = `waiting-plan-mate-${Date.now()}@example.com`;
  const mate = await usersService.createUser({
    email: mateEmail,
    password: PLANNING_ANCHOR_PASSWORD,
    name: 'Second Member',
  });
  await workspacesService.addMember({ userId: mate.id, workspaceId: owner.workspaceId });
  await addToProjectAs({
    key: seed.projectKey,
    actorUserId: owner.createdById,
    ctx: { userId: owner.createdById, workspaceId: owner.workspaceId },
    targetUserId: mate.id,
    role: 'member',
  });
  await projectsService.setActiveProject({
    userId: mate.id,
    workspaceId: owner.workspaceId,
    projectId: project.id,
  });
  return { id: mate.id, email: mateEmail };
}

test.beforeEach(async () => {
  await resetDatabase();
  declareJobs();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORDED PATH — cases 1–8, then case 12 as its own chapter.
// ─────────────────────────────────────────────────────────────────────────────

test('a waiting plan under a Closed session is carried by its first turn, revised in place, approved — and a stale plan is said, with Plan it again', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7928');

  const email = `waiting-plan-carry-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  const key = seed.storyKey;
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const FIRST = 'Split this story so the canvas work can ship on its own.';
  const FIRST_PROPOSAL = 'Ship the canvas seam first';
  const CARRIED = 'Keep the canvas seam, and add the empty state.';
  const CARRIED_PROPOSAL = 'Draw the canvas empty state';
  const SECOND = 'and the error state';
  const SECOND_PROPOSAL = 'Draw the canvas error state';

  let s1 = '';
  let s2 = '';
  let planId = '';
  let carriedJob = '';
  const s1Before = { endedAt: null as Date | null, endReason: null as string | null, turns: 0 };

  await chapter(
    'Plan something new leaves the first plan waiting under a Closed session',
    async () => {
      await openFromCard(page, key);
      expect((await sendTurn(page, FIRST)).status()).toBe(200);
      s1 = (await latestPlanningSession(email)).id;
      planId = await finishSessionPlan(s1, FIRST_PROPOSAL);
      await beat();

      const { fresh } = await planSomethingNew(page);
      expect(fresh).not.toBe(s1);
      await expect(composer(page)).toBeEnabled();
      await expect(rail(page).getByText(FIRST)).toHaveCount(0);

      // PERSISTED: the first session ended `restarted`; its plan still waits there.
      const ended = await sessionRow(s1);
      expect(ended.endReason).toBe('restarted');
      expect(ended.endedAt).not.toBeNull();
      const p = await planRow(planId);
      expect(p.status).toBe('planned');
      expect(p.sessionId).toBe(s1);
      s1Before.endedAt = ended.endedAt;
      s1Before.endReason = ended.endReason;
      s1Before.turns = (await turnsOf(s1)).length;
      await beat();
      await closeOverlay(page);
    },
  );

  await chapter('Waiting on you still lists it', async () => {
    await page.goto('/workbench?tab=approvals');
    const row = approvalRows(page).filter({ hasText: key });
    await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
    // PERSISTED: its `plan_approval` gate still awaits the owner.
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { kind: 'plan_approval', subjectId: planId },
    });
    expect(gate.state).toBe('awaiting');
    await beat();
  });

  await chapter('Opening it: the Closed thread, the plan to decide, and a chatbox', async () => {
    await openFromWaitingOnYou(page, key);
    await page.waitForURL(onSession(s1));
    await expect(endMarker(page)).toHaveAttribute('data-end-reason', 'restarted');
    await expect(endMarker(page)).toContainText(session.end.closed);
    await expect(rail(page).getByText(FIRST).first()).toBeVisible();
    await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(verb(bar(page), surface.approve)).toBeVisible();
    await expect(verb(bar(page), surface.decline)).toBeVisible();
    await expect(composer(page)).toBeEnabled();
    await expect(carryGloss(page)).toContainText(session.carry.gloss);
    await expect(rail(page).getByRole('button', { name: session.newSession.start })).toHaveCount(0);
    await beat();
  });

  await chapter(
    'The first turn carries the plan and the conversation into a new session',
    async () => {
      const carried = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/ai/plan-change/session' &&
          r.request().method() === 'POST' &&
          (r.request().postDataJSON() as { copyFrom?: string } | null)?.copyFrom === s1,
      );
      const submitted = page.waitForResponse(isTurnSubmit);
      await composer(page).fill(CARRIED);
      await sendButton(page).click();
      const carry = await carried;
      expect(carry.status()).toBe(200);
      const landed = (await carry.json()) as { id: string; takenBack?: boolean };
      expect(landed.takenBack ?? false).toBe(false);
      s2 = landed.id;
      expect(s2).not.toBe(s1);

      const submit = await submitted;
      expect(submit.status()).toBe(200);
      const run = (await submit.json()) as { jobId: string; planId?: string };
      carriedJob = run.jobId;
      expect(run.planId).toBe(planId);

      // The overlay switched to the new session in place.
      await page.waitForURL(onSession(s2));
      await expect(copiedDivider(page)).toBeVisible();
      await expect(planMoved(page)).toContainText(session.carry.moved);
      await expect(rail(page).getByText(CARRIED).first()).toBeVisible();
      await expect(bar(page)).toBeVisible();

      // PERSISTED: S2 copied S1's conversation and took the plan and the hold.
      const next = await sessionRow(s2);
      expect(next.copiedFromSessionId).toBe(s1);
      expect(next.origin).toBe('conversation');
      expect(next.endedAt).toBeNull();
      const sourceTurns = (await turnsOf(s1)).filter(
        (t) => t.role === 'user' || t.role === 'assistant',
      );
      // The revise binds a `system` marker turn after the carried one; the
      // conversation itself is the user and assistant turns.
      const copiedTurns = (await turnsOf(s2)).filter(
        (t) => t.role === 'user' || t.role === 'assistant',
      );
      expect(copiedTurns.map((t) => [t.role, t.body])).toEqual([
        ...sourceTurns.map((t) => [t.role, t.body]),
        ['user', CARRIED],
      ]);
      expect((await planRow(planId)).sessionId).toBe(s2);
      const s1After = await sessionRow(s1);
      expect(s1After.endedAt?.toISOString()).toBe(s1Before.endedAt?.toISOString());
      expect(s1After.endReason).toBe(s1Before.endReason);
      expect((await turnsOf(s1)).length).toBe(s1Before.turns);
      expect(await trail(planId, 'session_carried')).toHaveLength(1);
      const hold = await adminDb.planTargetLock.findFirstOrThrow({
        where: { workItem: { identifier: key } },
      });
      expect(hold.sessionId).toBe(s2);
      await beat();
    },
  );

  await chapter('Plans shows the new session holding the one plan', async () => {
    await openPlans(page);
    const carriedRow = sessionRowOf(page, s2);
    await expect(carriedRow).toBeVisible();
    await expect(carriedRow.getByTestId('plan-session-continued-from')).toBeVisible();
    await expect(carriedRow).not.toContainText(/earlier plan/);
    // The carry moved the plan to S2, so S1 holds none and the Plans list, which
    // serves only sessions holding a plan (MOTIR-9300), no longer lists it.
    await expect(sessionRowOf(page, s1)).toHaveCount(0);
    expect(await plansIn(s2)).toBe(1);
    expect(await plansIn(s1)).toBe(0);
    await beat();
  });

  await chapter('The planner answers the carried turn by revising THAT plan', async () => {
    // BEFORE the answer: the carried turn's job is a revision of P.
    const started = await trail(planId, 'revision_started');
    expect(started).toHaveLength(1);
    expect(diffJobId(started[0]!)).toBe(carriedJob);
    expect((await planRow(planId)).sourceJobId).toBe(carriedJob);
    expect((await sessionRow(s2)).lastJobId).toBe(carriedJob);
    expect(await plansIn(s2)).toBe(1);

    await answerAsPlanner(page, carriedJob, CARRIED_PROPOSAL, { revision: true });

    // AFTER: the lease ended, P still waits, and the proposal is P's.
    // (A settled revision's `revision_ended` row carries no job id; only a
    // failed one names its job.)
    expect(await trail(planId, 'revision_ended')).toHaveLength(1);
    expect((await planRow(planId)).status).toBe('planned');
    const added = await adminDb.planItem.findFirstOrThrow({
      where: { proposedFields: { path: ['title'], equals: CARRIED_PROPOSAL } },
    });
    expect(added.planId).toBe(planId);
    expect(await plansIn(s2)).toBe(1);

    await openSessionFromPlans(page, s2, FIRST);
    await expect(bar(page)).toContainText('2 added', { timeout: FIRST_PAINT_MS });
    await expect(workspace(page).getByText(CARRIED_PROPOSAL).first()).toBeVisible();
    await expect(workspace(page).getByTestId('plan-change-confirm-bar')).toHaveCount(1);
    await beat();
  });

  await chapter('A second turn revises the same plan again', async () => {
    const sessionsBefore = await adminDb.planChangeSession.count();
    const res = await sendTurn(page, SECOND);
    expect(res.status(), await res.text()).toBe(200);
    const run = (await res.json()) as { jobId: string; planId?: string };
    expect(run.planId).toBe(planId);

    const started = await trail(planId, 'revision_started');
    expect(started).toHaveLength(2);
    expect(diffJobId(started[1]!)).toBe(run.jobId);
    expect((await planRow(planId)).sourceJobId).toBe(run.jobId);
    expect((await sessionRow(s2)).lastJobId).toBe(run.jobId);

    await answerAsPlanner(page, run.jobId, SECOND_PROPOSAL, { revision: true });
    expect(await plansIn(s2)).toBe(1);
    expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore);
    expect(await adminDb.planItem.count({ where: { planId, op: 'add' } })).toBe(3);

    // Plans, re-opened, still lists one plan for S2 — and its conversation shows both.
    await openSessionFromPlans(page, s2, FIRST);
    await expect(bar(page)).toContainText('3 added', { timeout: FIRST_PAINT_MS });
    await expect(workspace(page).getByText(SECOND_PROPOSAL).first()).toBeVisible();
    await expect(workspace(page).getByText(CARRIED_PROPOSAL).first()).toBeVisible();
    await beat();
  });

  await chapter('Approve the plan that carried', async () => {
    const approved = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/plans/${planId}/approve` &&
        r.request().method() === 'POST',
    );
    await verb(bar(page), surface.approve).click();
    expect((await approved).status()).toBe(200);

    expect((await planRow(planId)).status).toBe('approved');
    const adds = await adminDb.planItem.findMany({ where: { planId, op: 'add' } });
    expect(adds).toHaveLength(3);
    for (const item of adds) expect(item.workItemId).not.toBeNull();
    await beat();
    await closeOverlay(page);
  });

  await chapter(
    'On another card, a plan gone stale is said in words, with Plan it again',
    async () => {
      const card = seed.childlessEpicKey;
      const finished = await cardOf(seed.subtaskKey);
      const ASK = 'Put the import behind a flag.';
      const AGAIN = 'Can we still change the import?';
      const LATER = 'Keep the flag off by default.';

      await openFromCard(page, card);
      expect((await sendTurn(page, ASK)).status()).toBe(200);
      const s3 = (await latestPlanningSession(email)).id;
      const q = await finishWithModify(s3, finished.id);
      await closeOverlay(page);

      // The work item Q changes is finished through the item page's own control;
      // the drift consumer of that transition is what makes Q stale.
      await moveStatus(page, seed.subtaskKey, 'In Progress', 'in_progress');
      await moveStatus(page, seed.subtaskKey, 'In Review', 'in_review');
      await moveStatus(page, seed.subtaskKey, 'Done', 'done');
      await expect.poll(async () => (await planRow(q)).status, { timeout: 60_000 }).toBe('stale');
      const qItems = await adminDb.planItem.count({ where: { planId: q } });
      const markersBefore = await adminDb.planChangeTurn.count({
        where: { sessionId: s3, jobId: { not: null } },
      });

      await openFromCard(page, card);
      const refused = await sendTurn(page, AGAIN);
      expect(refused.status()).toBe(409);
      const body = (await refused.json()) as {
        code: string;
        planId: string;
        finishedCards: Array<{ key: string }>;
      };
      expect(body.code).toBe('PLAN_SESSION_PLAN_STALE');
      expect(body.planId).toBe(q);
      expect(body.finishedCards.map((c) => c.key)).toEqual([seed.subtaskKey]);

      await expect(staleNotice(page)).toContainText(
        en.planningWorkspace.session.stalePlan.one.split('{workItem}')[0]!.trim(),
      );
      await expect(staleNotice(page)).toContainText(seed.subtaskKey);
      await expect(staleNotice(page)).toContainText(finished.title);
      await expect(planAgain(page)).toContainText(session.stalePlan.planAgain);
      await expect(workspace(page)).not.toContainText('409');
      await expect(workspace(page)).not.toContainText('PLAN_');
      // PERSISTED: nothing was spent and nothing about Q moved.
      expect(await trail(q, 'revision_started')).toHaveLength(0);
      expect((await planRow(q)).status).toBe('stale');
      expect(await adminDb.planItem.count({ where: { planId: q } })).toBe(qItems);
      expect(
        await adminDb.planChangeTurn.count({ where: { sessionId: s3, jobId: { not: null } } }),
      ).toBe(markersBefore);
      await beat();

      // zh: the same refusal, said in Chinese.
      await useLocale(page, 'zh');
      await page.reload();
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      expect((await sendTurn(page, AGAIN)).status()).toBe(409);
      await expect(staleNotice(page)).toContainText(
        zh.planningWorkspace.session.stalePlan.one.split('{workItem}')[0]!.trim(),
      );
      await expect(planAgain(page)).toContainText(zh.planningWorkspace.session.stalePlan.planAgain);
      await beat();
      await useLocale(page, 'en');
      await page.reload();
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      expect((await sendTurn(page, AGAIN)).status()).toBe(409);
      await expect(planAgain(page)).toBeVisible();

      // Plan it again, pressed twice quickly: ONE fresh plan in the same session.
      const plansBefore = await plansIn(s3);
      const accepted = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/ai/plan-change/session/submit' &&
          r.request().method() === 'POST' &&
          (r.request().postDataJSON() as { planAgainOf?: string } | null)?.planAgainOf === q,
      );
      await planAgain(page).dblclick();
      const again = await accepted;
      expect(again.status()).toBe(200);
      const fresh = (await again.json()) as { jobId: string; planId: string };
      expect(fresh.planId).not.toBe(q);
      const r = fresh.planId;

      await expect(byTestId(page, 'planning-stale-writing')).toBeVisible();
      await expect(planAgain(page)).toHaveCount(0);
      await expect(staleNotice(page)).toContainText(seed.subtaskKey);
      expect(await plansIn(s3)).toBe(plansBefore + 1);
      const rRow = await planRow(r);
      expect(rRow.sessionId).toBe(s3);
      expect(rRow.status).toBe('generating');
      const qAfter = await planRow(q);
      expect(qAfter.status).toBe('stale');
      expect(qAfter.sessionId).toBe(s3);
      expect(await trail(q, 'declined')).toHaveLength(0);
      expect(
        await adminDb.planChangeTurn.count({ where: { sessionId: s3, jobId: fresh.jobId } }),
      ).toBe(1);
      await beat();

      // The planner finishes R; the next turn revises R.
      await answerAsPlanner(page, fresh.jobId, 'Gate the import on a flag', { revision: false });
      await expect.poll(async () => (await planRow(r)).status).toBe('planned');
      await page.reload();
      await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
      const next = await sendTurn(page, LATER);
      expect(next.status(), await next.text()).toBe(200);
      expect(((await next.json()) as { planId?: string }).planId).toBe(r);
      expect(await trail(r, 'revision_started')).toHaveLength(1);
      await beat();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REST OF THE CARD — cases 9, 10, 11 and the unchanged case, unrecorded.
// ─────────────────────────────────────────────────────────────────────────────

test('another member reads the waiting plan with no chatbox, and its owner reads it in zh', async ({
  page,
}) => {
  const email = `waiting-plan-member-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Should the billing epic be split first?';
  const waiting = await seedWaitingPlan(page, email, seed.epicKey, ASK, 'Split billing first');
  const mate = await addSecondMember(seed, email);

  // ⚠️ WRITTEN BY HAND: no service re-routes a raised gate. `markPlanned` raised
  // this one to the plan's author; the case needs it routed to the second member.
  await adminDb.approvalGate.updateMany({
    where: { kind: 'plan_approval', subjectId: waiting.planId, state: 'awaiting' },
    data: { routedToId: mate.id },
  });

  await page.context().clearCookies();
  await signIn(page, mate.email, PLANNING_ANCHOR_PASSWORD);
  await openSessionFromPlans(page, waiting.sessionId, ASK);
  await expect(endMarker(page)).toContainText(session.end.closed);
  await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(verb(bar(page), surface.approve)).toBeVisible();
  await expect(verb(bar(page), surface.decline)).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  await expect(readOnly(page)).toBeVisible();
  await expect(carryGloss(page)).toHaveCount(0);
  expect(await adminDb.planChangeSession.count({ where: { createdById: mate.id } })).toBe(0);

  // CASE 11 — the owner, in zh.
  await page.context().clearCookies();
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);
  await useLocale(page, 'zh');
  await openSessionFromPlans(page, waiting.sessionId, ASK);
  const zs = zh.planningWorkspace.session;
  const zSurface = zh.approvalGate.planApproval.surface;
  await expect(carryGloss(page)).toContainText(zs.carry.gloss);
  await expect(endMarker(page)).toContainText(zs.end.closed);
  await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(verb(bar(page), zSurface.approve)).toBeVisible();
  await expect(verb(bar(page), zSurface.decline)).toBeVisible();
});

test('a take-back lands the turn in the open session, and the waiting plan stays where it was', async ({
  page,
}) => {
  const email = `waiting-plan-take-back-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  const key = seed.epicKey;
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const ASK = 'Order the epic’s stories by risk.';
  const waiting = await seedWaitingPlan(page, email, key, ASK, 'Risky story first');

  // An OPEN session on the same card.
  const OPEN = 'Start with the riskiest story.';
  await openFromCard(page, key);
  expect((await sendTurn(page, OPEN)).status()).toBe(200);
  const open = (await latestPlanningSession(email)).id;
  expect(open).not.toBe(waiting.sessionId);
  await closeOverlay(page);
  const scopeKey = (await sessionRow(open)).scopeKey;
  const before = await scopeSessions(scopeKey);

  await openFromWaitingOnYou(page, key);
  await page.waitForURL(onSession(waiting.sessionId));
  const TURN = 'Also flag anything blocked.';
  const carried = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session' &&
      r.request().method() === 'POST' &&
      (r.request().postDataJSON() as { copyFrom?: string } | null)?.copyFrom === waiting.sessionId,
  );
  await composer(page).fill(TURN);
  await sendButton(page).click();
  const res = await carried;
  expect(res.status()).toBe(200);
  const landed = (await res.json()) as { id: string; takenBack?: boolean };
  expect(landed.takenBack).toBe(true);
  expect(landed.id).toBe(open);

  await expect(takenBack(page)).toBeVisible();
  await expect(takenBackWaiting(page)).toBeVisible();
  expect((await turnsOf(open)).some((t) => t.role === 'user' && t.body === TURN)).toBe(true);
  expect(await scopeSessions(scopeKey)).toBe(before);
  expect((await planRow(waiting.planId)).sessionId).toBe(waiting.sessionId);

  await takenBackWaiting(page)
    .getByRole('link', { name: session.carry.takenBackWaitingOpen })
    .click();
  await page.waitForURL(onSession(waiting.sessionId));
  await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(verb(bar(page), surface.approve)).toBeVisible();
  await expect(verb(bar(page), surface.decline)).toBeVisible();
});

test('unchanged: a failed session with no waiting plan still offers Start a new session', async ({
  page,
}) => {
  declareJobs([{ status: 'failed' }, { status: 'succeeded' }]);
  const email = `waiting-plan-failed-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  await openFromCard(page, seed.storyKey);
  expect((await sendTurn(page, 'Split this story in two.')).status()).toBe(200);
  const failed = (await latestPlanningSession(email)).id;
  // MOTIR-7905: a failed hosted attempt now KEEPS its session (it waits in To resume), so the
  // Closed form this case pins belongs to a session that ended `failed` BEFORE the story. That
  // historic end is seeded through the end door, then the session's address is reopened.
  await expect.poll(async () => (await sessionRow(failed)).failedAt).not.toBeNull();
  await planSessionEndService.endSession(failed, 'failed', {
    workspaceId: (await sessionRow(failed)).workspaceId,
  });
  // An ENDED session is reopened by no door but its own address (`planSession=`), so a plain
  // reload would open an empty rail.
  const address = new URL(page.url());
  address.searchParams.set('planSession', failed);
  await page.goto(address.pathname + address.search);
  await expect(endMarker(page)).toHaveAttribute('data-end-reason', 'failed');
  expect((await sessionRow(failed)).endReason).toBe('failed');
  expect(
    await adminDb.plan.count({
      where: { sessionId: failed, status: { in: ['generating', 'planned', 'stale'] } },
    }),
  ).toBe(0);

  await expect(
    startSlot(page).getByRole('button', { name: session.newSession.start }),
  ).toBeVisible();
  await expect(carryGloss(page)).toHaveCount(0);
});
