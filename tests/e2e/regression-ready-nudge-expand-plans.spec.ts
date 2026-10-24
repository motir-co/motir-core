// Acceptance E2E — EXPAND ON THE `/ready` NUDGE STARTS A PLANNING CONVERSATION
// (Story MOTIR-5266 · Subtask MOTIR-7878; design MOTIR-7875,
// `design/ready/design-notes.md` § *Expand starts a planning conversation*).
//
// Runs under `playwright.acceptance.config.ts` (MOTIR_CLOUD + the motir-ai JOBS mock
// under the routes) — the lane where the planning overlay mounts. `acceptanceStory()`
// pins the clip to the story.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The ready set is nearly drained and `/ready` offers to expand a stub. Pressing
// **Expand** opens the planning overlay over `/ready` AT ONCE, on the stub, with
// "Plan <KEY>" already sent as the person's first message — nobody types, nobody
// presses Send, and the banner shows no spinner and no review of its own. A thin
// stub is ASKED what to plan, and the answer continues the same conversation. A
// clear stub's plan waits in To approve until it is approved, on the overlay, with
// its progress. Close puts the person back on `/ready` exactly as they left it; a
// reload never sends the first turn twice; ✕ only hides the nudge.
//
// ── THE SEAMS ───────────────────────────────────────────────────────────────
//
//   * `/api/ready/nudge` is stubbed at the browser: the NOMINATION rule is not this
//     story's, so the spec says which stub the banner offers.
//   * The planner's runs settle through the lane's jobs mock (`lib/test-ai-jobs-mock.ts`)
//     — the routes, the session, the turns, the plan, the approve and `materialize`
//     are real. A run that PROPOSES is finished by the shipped services its handler
//     calls (`finishSessionPlanWithCards` → `addProposals` → `markPlanned`), because
//     the mock settles a plan run with nothing proposed.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every send is proven by its own
// response (armed before the press) and every count by `expect.poll` over the
// database. `chapter()` / `beat()` only HOLD a state already proven.
import { writeFileSync } from 'node:fs';
import type { Page, Request, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedReadyExpand,
  type ReadyExpandSeed,
  type ReadyStub,
} from './_helpers/ready-nudge-expand-seed';
import { finishSessionPlanWithCards } from './_helpers/planChangeConversation';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// The paced run takes about a minute and a half; a hang must fail inside the
// shard's budget so its report and trace upload.
test.describe.configure({ timeout: 300_000 });

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const QUESTION = 'What should notifications cover first — in-app, email or push?';
const ANSWER = 'In-app notifications first, for mentions and assignments.';
const CHILDREN = ['Add the Export button', 'Render the CSV and PDF', 'Expire the download link'];

// ── Locators ─────────────────────────────────────────────────────────────────

/** The nudge's sentence — `Only 1 work item ready — expand <KEY> (<title>)?`. */
const nudgeBody = (page: Page, stub: ReadyStub) =>
  page
    .getByRole('main')
    .getByText(fill(en.ready.nudge.body, { count: 1, key: stub.key, title: stub.title }));
const expandButton = (page: Page, name = en.ready.nudge.expandLabel) =>
  page.getByRole('main').getByRole('button', { name, exact: true });
const dismissButton = (page: Page) =>
  page.getByRole('main').getByRole('button', { name: en.ready.nudge.dismissAria, exact: true });
/** THE OVERLAY — the planning workspace dialog (`{project} plan` · `{project} 的计划`). */
const workspace = (page: Page) => page.getByRole('dialog', { name: /plan|计划/i });
const rail = (page: Page) => workspace(page).getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const transcript = (page: Page) => rail(page).getByRole('log');
const userTurns = (page: Page) => transcript(page).getByTestId('conversation-user-turn');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const approveVerb = (page: Page) =>
  bar(page).getByRole('button', {
    name: en.approvalGate.planApproval.surface.approve,
    exact: true,
  });
const approvalRows = (page: Page) =>
  page.getByRole('table', { name: en.workbench.tabs.toApprove }).getByTestId(/^approval-row-/);

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── Signals ──────────────────────────────────────────────────────────────────

/** A turn sent on the stub's anchored door — the first turn or an answer. */
const anchoredSend = (page: Page, stub: ReadyStub): Promise<Response> =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/work-items/${stub.id}/ai/plan` &&
      r.request().method() === 'POST',
    { timeout: FIRST_PAINT_MS },
  );

/** The overlay recorded the planner's turn for the run it watched — the run is over. */
const runSettled = (page: Page): Promise<Response> =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session/planner-turn' &&
      r.request().method() === 'POST',
    { timeout: FIRST_PAINT_MS },
  );

// ── The database, as the proof ───────────────────────────────────────────────

/** The conversations anchored on `stub`, and how many PERSON turns they hold. */
async function onStub(stub: ReadyStub): Promise<{ sessions: number; userTurns: number }> {
  const sessions = await adminDb.planChangeSession.findMany({
    where: { targetKeys: { has: stub.key } },
    select: { id: true },
  });
  const turns = await adminDb.planChangeTurn.count({
    where: { sessionId: { in: sessions.map((s) => s.id) }, role: 'user' },
  });
  return { sessions: sessions.length, userTurns: turns };
}

async function sessionOn(stub: ReadyStub): Promise<string> {
  const session = await adminDb.planChangeSession.findFirstOrThrow({
    where: { targetKeys: { has: stub.key } },
    orderBy: { createdAt: 'desc' },
  });
  return session.id;
}

async function userTurnBodies(stub: ReadyStub): Promise<string[]> {
  const turns = await adminDb.planChangeTurn.findMany({
    where: { sessionId: await sessionOn(stub), role: 'user' },
    orderBy: { seq: 'asc' },
    select: { body: true },
  });
  return turns.map((t) => t.body);
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** Which stub the nudge offers — the stub at `/api/ready/nudge` reads this. */
let nominated: ReadyStub | null = null;

async function stubBoundaries(page: Page): Promise<void> {
  await page.route('**/api/ready/nudge', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        nominated
          ? {
              readyCount: 1,
              nominatedKey: nominated.key,
              nominatedTitle: nominated.title,
              threshold: 3,
            }
          : null,
      ),
    }),
  );
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

/** `/ready` with the nudge offering `stub`, on the BUGS lane (a host query to keep). */
async function openReady(page: Page, stub: ReadyStub, nudgeCopy = en.ready.nudge): Promise<void> {
  nominated = stub;
  await page.goto('/ready?lane=bugs');
  await expect(expandButton(page, nudgeCopy.expandLabel)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(
    page.getByRole('main').getByText(fill(nudgeCopy.expandHint, { key: stub.key })),
  ).toBeVisible();
}

/** Press Expand and prove the first turn went out on the stub's door. */
async function expandAndSend(
  page: Page,
  stub: ReadyStub,
  nudgeCopy = en.ready.nudge,
): Promise<Response> {
  const sent = anchoredSend(page, stub);
  await expandButton(page, nudgeCopy.expandLabel).click();
  await page.waitForURL(overlayOpen, { timeout: FIRST_PAINT_MS });
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  const res = await sent;
  expect(res.status()).toBe(200);
  return res;
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed, { timeout: FIRST_PAINT_MS });
  await expect(workspace(page)).toHaveCount(0);
}

test.beforeEach(async () => {
  await resetDatabase();
  nominated = null;
  // Each planning submit, in order: the thin stub's first turn is ASKED back; every
  // later run settles plainly (the last entry repeats).
  writeFileSync(
    JOBS_FIXTURE,
    JSON.stringify(
      {
        ask: [{ intent: 'plan_change', answer: null, citations: [] }],
        plan: [
          { status: 'succeeded', turn: { message: QUESTION, question: QUESTION } },
          { status: 'succeeded' },
        ],
        submitted: [],
      },
      null,
      2,
    ),
  );
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('Expand on the /ready nudge starts a planning conversation on the stub', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-5266');
  const seed: ReadyExpandSeed = await seedReadyExpand(`ready-expand-${Date.now()}@example.com`);
  await stubBoundaries(page);
  await signIn(page, seed.email, seed.password);

  let before = '';
  let scrollBefore = 0;

  await chapter(
    'Expand opens the planning overlay at once — “Plan <KEY>” is sent for you',
    async () => {
      await openReady(page, seed.thin);
      before = page.url();
      scrollBefore = await page.evaluate(() => window.scrollY);
      await beat();

      await expandAndSend(page, seed.thin);
      // Over /ready, with the host query kept.
      const url = new URL(page.url());
      expect(url.pathname).toBe('/ready');
      expect(url.searchParams.get('lane')).toBe('bugs');
      expect(url.searchParams.get('planItem')).toBe(seed.thin.key);

      const firstTurn = fill(en.planningWorkspace.startTurn.plan, { key: seed.thin.key });
      await expect(userTurns(page).first()).toContainText(firstTurn, { timeout: FIRST_PAINT_MS });
      await expect(composer(page)).toHaveValue('');
      await expect.poll(() => onStub(seed.thin)).toEqual({ sessions: 1, userTurns: 1 });
      expect(await userTurnBodies(seed.thin)).toEqual([firstTurn]);
      // The banner underneath has no post-Expand state of its own.
      await expect(page.getByText('Expanding…')).toHaveCount(0);
    },
  );

  await chapter(
    'A thin stub is asked what to plan — the answer continues the conversation',
    async () => {
      await expect(rail(page).getByText(QUESTION).first()).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(
        rail(page).getByText(en.planningWorkspace.conversation.awaitingAnswer),
      ).toBeVisible();
      await beat();

      const answered = anchoredSend(page, seed.thin);
      await composer(page).fill(ANSWER);
      await rail(page)
        .getByRole('button', { name: en.planningWorkspace.conversation.answer, exact: true })
        .click();
      expect((await answered).status()).toBe(200);
      await expect(transcript(page).getByText(ANSWER).first()).toBeVisible();
      // ONE session, now holding both of the person's turns.
      await expect.poll(() => onStub(seed.thin)).toEqual({ sessions: 1, userTurns: 2 });
    },
  );

  await chapter('Close returns to /ready exactly as it was left', async () => {
    await closeOverlay(page);
    expect(page.url()).toBe(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect(expandButton(page)).toBeVisible();
  });

  let clearSession = '';
  let planId = '';

  await chapter('A clear stub: the plan is proposed, and waits in To approve', async () => {
    await openReady(page, seed.clear);
    // The overlay SETTLES the run it started once its stream ends (the planner's
    // turn is recorded). Let that finish before closing: a run cut off mid-stream
    // leaves its plan read hanging on the next open.
    const settled = runSettled(page);
    await expandAndSend(page, seed.clear);
    expect((await settled).status()).toBe(200);
    await expect.poll(() => onStub(seed.clear)).toEqual({ sessions: 1, userTurns: 1 });
    clearSession = await sessionOn(seed.clear);
    await closeOverlay(page);
    // The planner's run proposes three children under the stub.
    planId = await finishSessionPlanWithCards(clearSession, seed.clear.id, CHILDREN);

    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'planned',
    );
    await page.goto('/workbench?tab=approvals');
    await expect(approvalRows(page).filter({ hasText: seed.clear.key })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await beat();
  });

  await chapter('Expand again resumes the same conversation — nothing is sent twice', async () => {
    // The session still holds exactly ONE plan, the proposal it is resumed onto.
    expect(
      (
        await adminDb.plan.findMany({ where: { sessionId: clearSession }, select: { id: true } })
      ).map((p) => p.id),
    ).toEqual([planId]);
    await openReady(page, seed.clear);
    await expandButton(page).click();
    await page.waitForURL(overlayOpen, { timeout: FIRST_PAINT_MS });
    await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(userTurns(page)).toHaveCount(1);
    expect(await sessionOn(seed.clear)).toBe(clearSession);
    await expect.poll(() => onStub(seed.clear)).toEqual({ sessions: 1, userTurns: 1 });
  });

  await chapter('Approve on the overlay — its progress, then the three children', async () => {
    // HOLD the approve's response until its progress surface is proven on screen,
    // so the assertion is about the surface and never a race with a fast server.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/plans/${planId}/approve`, async (route) => {
      await held;
      await route.continue();
    });
    const approved = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/plans/${planId}/approve`,
      { timeout: FIRST_PAINT_MS },
    );
    await approveVerb(page).click();
    // The bar's progress is the announced one; the rail draws an aria-hidden twin.
    await expect(bar(page).getByTestId('plan-approve-progress')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await beat();
    release();
    expect((await approved).status()).toBe(200);

    await expect
      .poll(async () =>
        (
          await adminDb.workItem.findMany({
            where: { parentId: seed.clear.id },
            select: { title: true },
          })
        )
          .map((w) => w.title)
          .sort(),
      )
      .toEqual([...CHILDREN].sort());
    await expect
      .poll(async () => (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status)
      .toBe('approved');
    await closeOverlay(page);
  });

  await chapter('A reload while the overlay is open sends nothing twice', async () => {
    await openReady(page, seed.reload);
    await expandAndSend(page, seed.reload);
    await expect.poll(() => onStub(seed.reload)).toEqual({ sessions: 1, userTurns: 1 });
    const firstTurn = fill(en.planningWorkspace.startTurn.plan, { key: seed.reload.key });
    // The address now NAMES the conversation instead of asking to start one.
    await page.waitForURL((url) => url.searchParams.has('planSession'), {
      timeout: FIRST_PAINT_MS,
    });

    await page.reload();
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(userTurns(page).filter({ hasText: firstTurn })).toHaveCount(1, {
      timeout: FIRST_PAINT_MS,
    });
    await expect.poll(() => onStub(seed.reload)).toEqual({ sessions: 1, userTurns: 1 });
    await closeOverlay(page);

    await page.goto('/plans');
    await expect(
      page
        .getByRole('list', { name: 'Planning conversations' })
        .getByRole('listitem')
        .filter({ hasText: firstTurn }),
    ).toBeVisible({ timeout: FIRST_PAINT_MS });
  });

  await chapter('✕ only hides the nudge — no planning request goes out', async () => {
    await openReady(page, seed.reload);
    const planning: string[] = [];
    const collect = (req: Request) => {
      const path = new URL(req.url()).pathname;
      if (/^\/api\/plans\/|\/ai\/plan|\/api\/ai\/plan-change\/|\/api\/ai\/ask/.test(path)) {
        planning.push(`${req.method()} ${path}`);
      }
    };
    page.on('request', collect);
    await dismissButton(page).click();
    await expect(expandButton(page)).toHaveCount(0);
    await expect(nudgeBody(page, seed.reload)).toHaveCount(0);
    page.off('request', collect);
    expect(planning).toEqual([]);
  });

  await chapter('In Chinese — the banner and the first turn read from zh', async () => {
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
    await openReady(page, seed.zh, zh.ready.nudge);
    const zhBefore = page.url();
    await expandAndSend(page, seed.zh, zh.ready.nudge);
    const firstTurn = fill(zh.planningWorkspace.startTurn.plan, { key: seed.zh.key });
    await expect(userTurns(page).first()).toContainText(firstTurn, { timeout: FIRST_PAINT_MS });
    expect(await userTurnBodies(seed.zh)).toEqual([firstTurn]);
    await beat();
    await closeOverlay(page);
    expect(page.url()).toBe(zhBefore);
  });
});
